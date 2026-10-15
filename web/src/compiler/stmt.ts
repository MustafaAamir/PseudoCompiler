/** Statements and structured control flow, emitted directly as jumps. */

import { Conv, FileMode, instr, Op, type VarLoc } from "../core/bytecode.ts";
import { Diagnostic } from "../core/diag.ts";
import type { Span } from "../core/source.ts";
import { classDef, constantStmt, declareStmt, routineDef, typeStmt } from "./decl.ts";
import {
  callNamed,
  condition,
  continueExpr,
  discharge,
  emitBinary,
  emitStore,
  type Expr,
  expr,
  exprDesc,
  type Place,
  postfix,
  valueExpr,
} from "./expr.ts";
import { isBlockEnd, type Kind, type Kw, startsStatement } from "./lexer.ts";
import type { Compiler, LoopCtx } from "./state.ts";
import { convOf, isDynamic, isValueAggregate, T } from "./types.ts";

export function program(c: Compiler): void {
  while (!c.at("eof")) {
    const before = c.tok.span;
    if (isBlockEnd(c.tok.kind)) {
      strayTerminator(c, c.tok.kind as Kw);
      c.advance();
      continue;
    }
    statement(c);
    endOfStatement(c);
    if (c.tok.span.equals(before) && !c.at("eof")) c.advance();
  }
  c.emit(instr(Op.Halt), c.tok.span);
  c.main.locals = c.localInfos(c.cur);
  c.main.numSlots = c.cur.locals.length;
}

function strayTerminator(c: Compiler, k: Kw): void {
  const opener: Partial<Record<Kw, string>> = {
    ENDIF: "IF",
    ELSE: "IF",
    ENDCASE: "CASE OF",
    OTHERWISE: "CASE OF",
    ENDWHILE: "WHILE",
    UNTIL: "REPEAT",
    NEXT: "FOR",
    ENDPROCEDURE: "PROCEDURE",
    ENDFUNCTION: "FUNCTION",
    ENDCLASS: "CLASS",
  };
  const o = opener[k] ?? "TYPE";
  c.error(
    Diagnostic.error("E0102", `\`${k}\` without a matching \`${o}\``)
      .primary(c.tok.span, "nothing to close here")
      .help(`remove it, or check for an earlier \`${o}\` that was closed too soon`),
  );
}

/** After a statement: recover from errors and reject trailing tokens. */
function endOfStatement(c: Compiler): void {
  if (c.panic) return c.synchronize();
  if (!c.tok.lineStart && !c.at("eof") && !isBlockEnd(c.tok.kind)) {
    const d = Diagnostic.error("E0100", `expected end of line, found ${c.found()}`)
      .primary(c.tok.span, "unexpected after the end of the statement")
      .help("each statement goes on its own line");
    if (c.at("=")) d.suggest(c.tok.span, "←", "to assign, use `←`");
    c.parseError(d);
    c.synchronize();
  }
}

/** Compile statements up to (not including) a block terminator; returns whether control never falls out. */
export function block(c: Compiler, caseArms: boolean): boolean {
  let diverged: Span | undefined;
  let warned = false;
  while (!c.at("eof")) {
    const kw = c.miscasedKeyword();
    if (kw && isBlockEnd(kw) && c.tok.lineStart && !isDeclared(c, c.text(c.tok.span))) {
      c.miscasedKeywordError(kw);
      c.tok = { ...c.tok, kind: kw };
    }
    if (isBlockEnd(c.tok.kind) || (caseArms && atCaseLabel(c))) break;
    const start = c.tok.span;
    if (diverged && !warned) {
      warned = true;
      c.error(
        Diagnostic.warning("W0002", "unreachable statement")
          .primary(start, "this will never run")
          .secondary(diverged, "any code after this is unreachable"),
      );
    }
    if (statement(c) && !diverged) diverged = start;
    endOfStatement(c);
    if (c.tok.span.equals(start) && !c.at("eof")) c.advance();
  }
  return diverged !== undefined;
}

function isDeclared(c: Compiler, name: string): boolean {
  return c.lookupVar(name) !== undefined || c.names.has(name);
}

function atCaseLabel(c: Compiler): boolean {
  if (!c.tok.lineStart) return false;
  switch (c.tok.kind) {
    case "int":
    case "real":
    case "str":
    case "char":
    case "date":
    case "-":
    case "TRUE":
    case "FALSE":
      return true;
    case "ident": {
      const next = c.peek().kind;
      return next === ":" || next === "TO";
    }
    default:
      return false;
  }
}

export function openBlock(c: Compiler, end: Kw): void {
  c.openBlocks.push(end);
}

/** Whether an enclosing (not the innermost) open block accepts `k`. */
function enclosingAccepts(c: Compiler, k: Kind): boolean {
  return c.openBlocks.slice(0, -1).some((e) =>
    e === k || (k === "ELSE" && e === "ENDIF") || (k === "OTHERWISE" && e === "ENDCASE")
  );
}

/** Expect the terminator `end` of a block opened at `openerSpan`. */
export function closeBlock(c: Compiler, end: Kw, opener: string, openerSpan: Span): void {
  closeBlockInner(c, end, opener, openerSpan);
  c.openBlocks.pop();
}

function closeBlockInner(c: Compiler, end: Kw, opener: string, openerSpan: Span): void {
  if (c.eat(end)) return;
  if (c.miscasedKeyword() === end) {
    c.miscasedKeywordError(end);
    c.advance();
    return;
  }
  const k = c.tok.kind;
  let d: Diagnostic;
  if (k === "eof") {
    d = Diagnostic.error("E0101", `unclosed \`${opener}\` block`)
      .primary(openerSpan, `this \`${opener}\` is never closed`)
      .secondary(c.tok.span, `file ends here; expected \`${end}\``)
      .help(`add \`${end}\` after the last statement of the block`);
  } else if (isBlockEnd(k)) {
    d = Diagnostic.error("E0102", `mismatched block terminator: expected \`${end}\`, found \`${k}\``)
      .primary(c.tok.span, `expected \`${end}\``)
      .secondary(openerSpan, `this \`${opener}\` must be closed first`)
      .help(`insert \`${end}\` before this line, or check the nesting of your blocks`);
  } else {
    d = c.expectedError(`\`${end}\``, `to close \`${opener}\``).secondary(openerSpan, `\`${opener}\` opened here`);
  }
  c.error(d);
  // A wrong terminator that no enclosing block wants is consumed, so it is not reported again as stray.
  if (isBlockEnd(c.tok.kind) && !enclosingAccepts(c, c.tok.kind)) c.advance();
}

/** Compile one statement; returns whether it always leaves the block (RETURN, BREAK, ...). */
export function statement(c: Compiler): boolean {
  // `output X` etc: a lower-case keyword at the start of a statement.
  const kw = c.miscasedKeyword();
  if (kw && startsStatement(kw) && !isDeclared(c, c.text(c.tok.span))) {
    c.miscasedKeywordError(kw);
    c.tok = { ...c.tok, kind: kw };
  }
  if (echoing(c) && atBareExpr(c)) {
    echoResult(c, exprDesc(c));
    return false;
  }
  const k = c.tok.kind;
  switch (k) {
    case "ident":
    case "^":
    case "SUPER":
      exprStmt(c);
      return false;
    case "DECLARE":
      declareStmt(c);
      return false;
    case "CONSTANT":
      constantStmt(c);
      return false;
    case "TYPE":
      typeStmt(c);
      return false;
    case "IF":
      return ifStmt(c);
    case "CASE":
      return caseStmt(c);
    case "WHILE":
      whileStmt(c);
      return false;
    case "REPEAT":
      repeatStmt(c);
      return false;
    case "FOR":
      forStmt(c);
      return false;
    case "CALL":
      callStmt(c);
      return false;
    case "RETURN":
      returnStmt(c);
      return true;
    case "BREAK":
    case "CONTINUE":
      jumpStmt(c, k);
      return true;
    case "OUTPUT":
    case "PRINT":
      outputStmt(c);
      return false;
    case "INPUT":
    case "READ":
      inputStmt(c);
      return false;
    case "OPENFILE":
      openFileStmt(c);
      return false;
    case "READFILE":
    case "GETRECORD":
      readRecordStmt(c, k);
      return false;
    case "WRITEFILE":
    case "PUTRECORD":
    case "SEEK":
      writeRecordStmt(c, k);
      return false;
    case "CLOSEFILE": {
      const span = c.tok.span;
      c.advance();
      fileName(c, "CLOSEFILE");
      c.emit(instr(Op.CloseFile), span);
      return false;
    }
    case "PROCEDURE":
    case "FUNCTION":
      routineDef(c, undefined);
      return false;
    case "CLASS":
      classDef(c);
      return false;
    case "PUBLIC":
    case "PRIVATE":
      c.parseError(
        Diagnostic.error("E0100", `\`${k}\` is only allowed inside a CLASS`).primary(
          c.tok.span,
          "not inside a class definition",
        ),
      );
      return false;
    default: {
      const d = c.expectedError("a statement", "");
      if (k === "eof" || k === "int" || k === "str" || k === "(") {
        d.help("statements start with a keyword such as DECLARE, IF, OUTPUT, or with a variable to assign");
      }
      c.parseError(d);
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Assignment and expression statements
// ---------------------------------------------------------------------------

function exprStmt(c: Compiler): void {
  const e = postfix(c);
  if (c.at("←")) return assign(c, e);
  if (c.at("=") && e.place) {
    const span = c.tok.span;
    c.error(
      Diagnostic.error("E0100", "`=` compares values; it does not assign")
        .primary(span, "this is a comparison")
        .suggest(span, "←", "use `←` (or `<-`) to assign"),
    );
    return assign(c, e);
  }
  if (echoing(c)) {
    echoResult(c, c.tok.lineStart || c.at("eof") ? e : continueExpr(c, e));
    return;
  }
  if (e.call !== undefined) {
    if (typeof e.call === "number") c.pending[e.call].asStatement = true;
    c.emit(instr(Op.Pop), e.span);
  } else if (e.ty.k !== "error") {
    const d = Diagnostic.error("E0100", "expected a statement, found an expression")
      .primary(e.span, "this value is computed and then thrown away")
      .help(
        e.place ? "to assign, write `variable ← value`; to display it, use OUTPUT" : "use OUTPUT to display a value",
      );
    c.parseError(d);
  }
}

/** REPL top level: expressions and assignments report their values. */
function echoing(c: Compiler): boolean {
  return c.repl && c.isMain();
}

const BARE_EXPR_STARTS = new Set<Kind>([
  "int",
  "real",
  "str",
  "char",
  "date",
  "(",
  "-",
  "TRUE",
  "FALSE",
  "NOT",
  "NEW",
  "DIV",
  "MOD",
  "INTEGER",
  "REAL",
  "BOOLEAN",
  "CHAR",
  "STRING",
  "DATE",
]);

/** Tokens that can only start an expression, never a statement. */
function atBareExpr(c: Compiler): boolean {
  return BARE_EXPR_STARTS.has(c.tok.kind);
}

function echoResult(c: Compiler, e: Expr): void {
  if (typeof e.call === "number") c.pending[e.call].asStatement = true;
  const d = discharge(c, e);
  if (d.ty.k === "void") c.emit(instr(Op.Pop), d.span);
  else if (d.ty.k !== "error") c.echo("-", d.ty, d.span);
}

function assign(c: Compiler, target: Expr): void {
  const arrow = c.tok.span;
  c.advance();
  if (!target.place) {
    if (target.ty.k !== "error") {
      c.error(
        Diagnostic.error("E0309", "cannot assign to this expression")
          .primary(target.span, "not a variable, field or array element")
          .secondary(arrow, "assignment here"),
      );
    }
    expr(c);
    return;
  }
  const v = expr(c);
  checkStore(c, target, v);
  if (isValueAggregate(target.ty)) c.emit(instr(Op.Copy), v.span);
  if (target.var !== undefined) c.markVar(target.var, false, true);
  emitStore(c, target.place, target.span);
  if (echoing(c) && target.var !== undefined) {
    const x = c.var(target.var);
    c.loadVar(target.var, target.span);
    c.echo(x.name, x.ty, target.span);
  }
}

/** Type-check `value` flowing into `target`, emitting conversions. */
function checkStore(c: Compiler, target: Expr, value: Expr): void {
  if (c.convertTop(target.ty, value.ty, value.span)) return;
  const tn = c.tyName(target.ty);
  const d = c.mismatch(target.ty, value.ty, value.span).secondary(target.span, `this has type \`${tn}\``);
  if (target.var !== undefined) {
    const decl = c.var(target.var).span;
    if (c.src.lineIndex(decl.start) !== c.src.lineIndex(target.span.start)) {
      d.noteAt(decl, `\`${c.text(target.span)}\` was declared as \`${tn}\` here`);
    }
  }
  if (value.ty.k === "void") d.note("procedures do not produce a value; only FUNCTIONs do");
  c.error(d);
}

function callStmt(c: Compiler): void {
  const callSpan = c.tok.span;
  c.advance();
  let e: Expr;
  if (c.at("ident") && ![".", "[", "^"].includes(c.peek().kind)) {
    const span = c.tok.span;
    c.advance();
    e = callNamed(c, c.text(span), span);
  } else e = postfix(c);
  if (typeof e.call === "number") c.pending[e.call].asStatement = true;
  else if (e.call === "function" || e.call === "builtin") {
    c.error(
      Diagnostic.warning("W0003", "the result of this FUNCTION call is discarded")
        .primary(e.span, "returns a value that is never used")
        .secondary(callSpan, "CALL is for PROCEDUREs")
        .help("assign the result to a variable, e.g. `Result ← F(...)`"),
    );
  } else if (e.call === undefined) {
    if (e.ty.k !== "error") {
      c.error(
        Diagnostic.error("E0302", "CALL must be followed by a procedure call")
          .primary(e.span, "this is not a call")
          .secondary(callSpan, "CALL here"),
      );
    }
    return;
  }
  c.emit(instr(Op.Pop), e.span);
}

// ---------------------------------------------------------------------------
// Control flow
// ---------------------------------------------------------------------------

function ifStmt(c: Compiler): boolean {
  const ifSpan = c.tok.span;
  c.advance();
  openBlock(c, "ENDIF");
  condition(c, "IF", ifSpan);
  c.expect("THEN", "after the IF condition");
  let falseJump: number | undefined = c.emit(instr(Op.JumpIfFalse), ifSpan);
  let branchDiverges = block(c, false);
  let allDiverge = branchDiverges;
  const endJumps: number[] = [];
  let hasElse = false;
  while (c.at("ELSE")) {
    const elseSpan = c.tok.span;
    const next = c.peek();
    // A branch that always leaves (RETURN, ...) needs no jump to ENDIF.
    if (!branchDiverges) endJumps.push(c.emit(instr(Op.Jump), elseSpan));
    if (falseJump !== undefined) c.patchJump(falseJump);
    falseJump = undefined;
    c.advance();
    if (next.kind === "IF" && !next.lineStart) {
      // ELSE IF chain sharing one ENDIF.
      const elif = c.tok.span;
      c.advance();
      condition(c, "ELSE IF", elif);
      c.expect("THEN", "after the ELSE IF condition");
      falseJump = c.emit(instr(Op.JumpIfFalse), elif);
      branchDiverges = block(c, false);
      allDiverge &&= branchDiverges;
    } else {
      allDiverge = block(c, false) && allDiverge;
      hasElse = true;
      break;
    }
  }
  if (falseJump !== undefined) c.patchJump(falseJump);
  closeBlock(c, "ENDIF", "IF", ifSpan);
  for (const j of endJumps) c.patchJump(j);
  return hasElse && allDiverge;
}

function caseStmt(c: Compiler): boolean {
  const caseSpan = c.tok.span;
  c.advance();
  openBlock(c, "ENDCASE");
  c.expect("OF", "after CASE");
  const subject = expr(c);
  const tmp = c.hiddenVar("case subject", subject.ty, caseSpan);
  c.storeVar(tmp, subject.span);

  const endJumps: number[] = [];
  let allDiverge = true, otherwise = false, arms = 0;
  for (;;) {
    if (c.at("OTHERWISE")) {
      c.advance();
      c.eat(":");
      allDiverge = block(c, true) && allDiverge;
      otherwise = true;
      if (!c.at("ENDCASE") && atCaseLabel(c)) {
        c.error(
          Diagnostic.error("E0100", "CASE arm after OTHERWISE")
            .primary(c.tok.span, "this arm can never be reached")
            .help("OTHERWISE must be the last branch of a CASE"),
        );
        continue;
      }
      break;
    }
    if (!atCaseLabel(c)) break;
    const fails: number[] = [];
    const subj = valueExpr(subject.ty, subject.span);
    c.loadVar(tmp, subject.span);
    const lo = expr(c);
    if (c.eat("TO")) {
      emitBinary(c, ">=", subj, lo, lo.span);
      fails.push(c.emit(instr(Op.JumpIfFalse), lo.span));
      c.loadVar(tmp, subject.span);
      const hi = expr(c);
      emitBinary(c, "<=", subj, hi, hi.span);
      fails.push(c.emit(instr(Op.JumpIfFalse), hi.span));
    } else {
      emitBinary(c, "=", subj, lo, lo.span);
      fails.push(c.emit(instr(Op.JumpIfFalse), lo.span));
    }
    c.expect(":", "after the CASE label");
    allDiverge = block(c, true) && allDiverge;
    endJumps.push(c.emit(instr(Op.Jump), caseSpan));
    for (const f of fails) c.patchJump(f);
    arms++;
    if (c.panic) c.synchronize();
  }
  if (arms === 0 && !otherwise) {
    c.error(Diagnostic.warning("W0005", "CASE statement has no branches").primary(caseSpan, "this CASE does nothing"));
  }
  closeBlock(c, "ENDCASE", "CASE", caseSpan);
  for (const j of endJumps) c.patchJump(j);
  return otherwise && allDiverge;
}

function pushLoop(c: Compiler): void {
  c.cur.loops.push({ breaks: [], continues: [] });
}

function finishLoop(c: Compiler, ctx: LoopCtx, continueTarget: number): void {
  for (const j of ctx.continues) c.patchJump(j, continueTarget);
  for (const j of ctx.breaks) c.patchJump(j);
}

function whileStmt(c: Compiler): void {
  const span = c.tok.span;
  c.advance();
  openBlock(c, "ENDWHILE");
  const start = c.pc;
  condition(c, "WHILE", span);
  c.eat("DO");
  const exit = c.emit(instr(Op.JumpIfFalse), span);
  pushLoop(c);
  block(c, false);
  const ctx = c.cur.loops.pop()!;
  c.emit(instr(Op.Jump, start), span);
  c.patchJump(exit);
  finishLoop(c, ctx, start);
  closeBlock(c, "ENDWHILE", "WHILE", span);
}

function repeatStmt(c: Compiler): void {
  const span = c.tok.span;
  c.advance();
  openBlock(c, "UNTIL");
  const start = c.pc;
  pushLoop(c);
  block(c, false);
  const ctx = c.cur.loops.pop()!;
  const condPc = c.pc;
  closeBlock(c, "UNTIL", "REPEAT", span);
  const until = c.prev;
  condition(c, "UNTIL", until);
  c.emit(instr(Op.JumpIfFalse, start), until);
  finishLoop(c, ctx, condPc);
}

function forStmt(c: Compiler): void {
  const forSpan = c.tok.span;
  c.advance();
  openBlock(c, "NEXT");
  const id = c.expectIdent("after FOR");
  if (!id) {
    c.openBlocks.pop();
    return;
  }
  const [name, nameSpan] = id;

  // The loop variable: an existing INTEGER variable, or declared implicitly.
  const existing = c.lookupVar(name);
  let v: VarLoc;
  if (existing !== undefined && c.var(existing).byref) {
    c.error(
      Diagnostic.error("E0309", "a BYREF parameter cannot be a FOR loop counter")
        .primary(nameSpan, "BYREF parameter")
        .help("copy it to a local INTEGER variable and loop over that"),
    );
    v = c.hiddenVar("for", T.Int, nameSpan);
  } else if (existing !== undefined) {
    const x = c.var(existing);
    if (x.ty.k !== "int" && x.ty.k !== "error") {
      c.error(
        Diagnostic.error("E0300", `FOR loop counter \`${name}\` must be INTEGER`)
          .primary(nameSpan, `\`${name}\` has type \`${c.tyName(x.ty)}\``)
          .secondary(x.span, "declared here"),
      );
    }
    v = existing;
  } else v = c.declareVar(name, T.Int, nameSpan);
  c.markVar(v, true, true);
  if (!c.at("←") && c.at("=")) {
    c.error(
      Diagnostic.error("E0100", "expected `←` after the FOR loop counter")
        .primary(c.tok.span, "found `=`")
        .suggest(c.tok.span, "←", "FOR loops assign the start value with `←`"),
    );
    c.advance();
  } else c.expect("←", "after the FOR loop counter");
  const start = expr(c);
  intOperand(c, start, "the FOR start value");
  c.storeVar(v, start.span);
  c.expect("TO", "after the FOR start value");
  const end = expr(c);
  intOperand(c, end, "the FOR end value");
  const endVar = c.hiddenVar("for end", T.Int, end.span);
  c.storeVar(endVar, end.span);
  if (c.eat("STEP")) {
    const step = expr(c);
    intOperand(c, step, "the FOR STEP");
    if (step.constant === 0) {
      c.error(
        Diagnostic.error("E0300", "FOR loop STEP cannot be zero").primary(step.span, "this loop would never end"),
      );
    }
  } else c.emit(instr(Op.PushInt, 1), forSpan);
  const stepVar = c.hiddenVar("for step", T.Int, forSpan);
  c.storeVar(stepVar, forSpan);

  const check = c.emit(instr(Op.ForCheck, v, endVar, stepVar, 0), forSpan);
  pushLoop(c);
  block(c, false);
  const ctx = c.cur.loops.pop()!;
  const stepPc = c.pc;
  c.emit(instr(Op.ForStep, v, stepVar, check), forSpan);
  c.patchJump(check);
  finishLoop(c, ctx, stepPc);

  closeBlock(c, "NEXT", "FOR", forSpan);
  if (c.at("ident") && !c.tok.lineStart) {
    const span = c.tok.span;
    const nextName = c.text(span);
    c.advance();
    if (nextName !== name) {
      c.error(
        Diagnostic.error("E0204", `\`NEXT ${nextName}\` does not match \`FOR ${name}\``)
          .primary(span, `expected \`${name}\``)
          .secondary(nameSpan, "the innermost FOR loop counts with this variable")
          .suggest(span, name, "use the loop's own counter"),
      );
    }
  }
}

function intOperand(c: Compiler, e: Expr, what: string): void {
  if (!c.convertTop(T.Int, e.ty, e.span)) c.error(c.mismatch(T.Int, e.ty, e.span).note(`${what} must be an INTEGER`));
}

function returnStmt(c: Compiler): void {
  const span = c.tok.span;
  c.advance();
  c.cur.sawReturn = true;
  const hasValue = !c.tok.lineStart && !c.at("eof") && !isBlockEnd(c.tok.kind);
  if (c.isMain()) {
    c.error(
      Diagnostic.error("E0206", "RETURN outside of a PROCEDURE or FUNCTION").primary(
        span,
        "the main program cannot RETURN",
      ),
    );
    if (hasValue) expr(c);
    return;
  }
  const ret = c.cur.ret;
  if (ret) {
    if (!hasValue) {
      c.error(
        Diagnostic.error("E0206", "RETURN in a FUNCTION needs a value")
          .primary(span, `expected a \`${c.tyName(ret.ty)}\` value after RETURN`)
          .secondary(ret.span, "the function's return type"),
      );
      return;
    }
    const e = expr(c);
    if (!c.convertTop(ret.ty, e.ty, e.span)) {
      c.error(
        c.mismatch(ret.ty, e.ty, e.span).secondary(
          ret.span,
          `expected \`${c.tyName(ret.ty)}\` because of this return type`,
        ),
      );
    }
    c.emit(instr(Op.Return), span);
  } else {
    if (hasValue) {
      const e = expr(c);
      c.error(
        Diagnostic.error("E0206", "a PROCEDURE cannot return a value")
          .primary(e.span, "unexpected value")
          .help("make it a FUNCTION with `RETURNS <type>`, or remove the value"),
      );
    }
    c.emit(instr(Op.ReturnVoid), span);
  }
}

function jumpStmt(c: Compiler, k: "BREAK" | "CONTINUE"): void {
  const span = c.tok.span;
  c.advance();
  const ctx = c.cur.loops[c.cur.loops.length - 1];
  if (!ctx) {
    c.error(Diagnostic.error("E0205", `\`${k}\` outside of a loop`).primary(span, "not inside WHILE, REPEAT or FOR"));
    return;
  }
  const j = c.emit(instr(Op.Jump), span);
  (k === "BREAK" ? ctx.breaks : ctx.continues).push(j);
}

// ---------------------------------------------------------------------------
// Input / output
// ---------------------------------------------------------------------------

function outputStmt(c: Compiler): void {
  const span = c.tok.span;
  c.advance();
  let n = 0;
  do {
    const e = expr(c);
    if (e.ty.k === "void") {
      c.error(
        Diagnostic.error("E0302", "cannot OUTPUT the result of a procedure").primary(
          e.span,
          "procedures do not produce a value",
        ),
      );
    }
    n++;
  } while (c.eat(","));
  c.emit(instr(Op.Output, n), span);
}

/** Parse an assignable target for INPUT / READFILE / GETRECORD. */
function inputTarget(c: Compiler, what: string): [Place, Expr] | undefined {
  const e = postfix(c);
  if (e.place) {
    if (e.var !== undefined) c.markVar(e.var, false, true);
    return [e.place, e];
  }
  if (e.ty.k !== "error") {
    c.error(Diagnostic.error("E0309", `${what} needs a variable to store into`).primary(e.span, "not a variable"));
  }
  return undefined;
}

function inputConv(c: Compiler, e: Expr, what: string): Conv {
  const conv = convOf(e.ty);
  if (conv === Conv.Any && !isDynamic(e.ty)) {
    const tn = c.tyName(e.ty);
    c.error(
      Diagnostic.error("E0300", `cannot ${what} a value of type \`${tn}\``)
        .primary(e.span, `\`${tn}\` cannot be read from text`)
        .help("read into a STRING, INTEGER, REAL, CHAR, BOOLEAN or DATE variable"),
    );
  }
  return conv;
}

function inputStmt(c: Compiler): void {
  const span = c.tok.span;
  c.advance();
  const t = inputTarget(c, "INPUT");
  if (!t) return;
  c.emit(instr(Op.Input, inputConv(c, t[1], "INPUT")), span);
  emitStore(c, t[0], t[1].span);
}

function fileName(c: Compiler, what: string): Expr {
  const e = expr(c);
  if (!["str", "unknown", "error"].includes(e.ty.k)) {
    c.error(c.mismatch(T.Str, e.ty, e.span).note(`${what} takes the file name as a STRING`));
  }
  return e;
}

function openFileStmt(c: Compiler): void {
  const span = c.tok.span;
  c.advance();
  fileName(c, "OPENFILE");
  c.expect("FOR", "after the file name");
  const modes: Partial<Record<Kind, FileMode>> = {
    READ: FileMode.Read,
    WRITE: FileMode.Write,
    APPEND: FileMode.Append,
    RANDOM: FileMode.Random,
  };
  const mode = modes[c.tok.kind];
  if (mode === undefined) {
    c.parseError(c.expectedError("a file mode", "after FOR").help("valid modes: READ, WRITE, APPEND, RANDOM"));
    return;
  }
  c.advance();
  c.emit(instr(Op.OpenFile, mode), span);
}

/** `READFILE f, Var` / `GETRECORD f, Var` */
function readRecordStmt(c: Compiler, k: "READFILE" | "GETRECORD"): void {
  const span = c.tok.span;
  c.advance();
  const f = fileName(c, k);
  const tmp = c.hiddenVar("file", T.Str, f.span);
  c.storeVar(tmp, f.span);
  c.expect(",", "after the file name");
  const t = inputTarget(c, k);
  if (!t) return;
  c.loadVar(tmp, f.span);
  if (k === "READFILE") c.emit(instr(Op.ReadFile, inputConv(c, t[1], "READFILE")), span);
  else c.emit(instr(Op.GetRecord), span);
  emitStore(c, t[0], t[1].span);
}

/** `WRITEFILE f, Expr` / `PUTRECORD f, Expr` / `SEEK f, Address` */
function writeRecordStmt(c: Compiler, k: "WRITEFILE" | "PUTRECORD" | "SEEK"): void {
  const span = c.tok.span;
  c.advance();
  fileName(c, k);
  c.expect(",", "after the file name");
  const e = expr(c);
  if (k === "SEEK") intOperand(c, e, "the SEEK address");
  c.emit(instr(k === "WRITEFILE" ? Op.WriteFile : k === "PUTRECORD" ? Op.PutRecord : Op.Seek), span);
}
