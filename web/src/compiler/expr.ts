/** Expression compilation with deferred loads. */

import { type Builtin, BUILTINS, lookupBuiltin, type Pat, patName } from "../core/builtins.ts";
import { Conv, global, type Instr, instr, Op, type VarLoc } from "../core/bytecode.ts";
import { bestMatch, Diagnostic } from "../core/diag.ts";
import { Span } from "../core/source.ts";
import { Char, DateVal, EnumVal, Real, type Value } from "../core/value.ts";
import { type Kind, lookupKeyword } from "./lexer.ts";
import type { Compiler, Param, PendingArg } from "./state.ts";
import { isDynamic, isNumeric, isText, T, type Ty, tyEquals } from "./types.ts";

/**
 * A storage location whose address computation (if any) is already on the
 * stack but whose final load/store/reference instruction is not yet emitted.
 */
export type Place =
  | { readonly k: "local"; readonly slot: number; readonly byref: boolean }
  | { readonly k: "global"; readonly g: number }
  | { readonly k: "selfField"; readonly slot: number }
  /** Object on the stack, slot known statically. */
  | { readonly k: "field"; readonly slot: number }
  /** Object on the stack, receiver type unknown: resolved by name at run time. */
  | { readonly k: "fieldNamed"; readonly sym: number; readonly site: number }
  /** Array and indices on the stack. */
  | { readonly k: "index"; readonly n: number }
  /** Reference on the stack. */
  | { readonly k: "deref" };

/** What produced an expression's value, if it was a call; a number is a pending (forward) call index. */
export type CallKind = "procedure" | "function" | "method" | "builtin" | number;

export interface Expr {
  /** Undefined once the value has been pushed. */
  place?: Place;
  ty: Ty;
  span: Span;
  call?: CallKind;
  /** The variable this place names directly, for use/assignment tracking. */
  var?: VarLoc;
  /** Compile-time value of a literal (for folding and constant checks). */
  constant?: Value;
}

export const valueExpr = (ty: Ty, span: Span): Expr => ({ ty, span });
const placeExpr = (place: Place, ty: Ty, span: Span): Expr => ({ place, ty, span });
const errorExpr = (span: Span): Expr => ({ ty: T.Error, span });

export type BinOp = "+" | "-" | "*" | "/" | "DIV" | "MOD" | "&" | "=" | "<>" | "<" | "<=" | ">" | ">=";

const RELATIONAL = new Set<BinOp>(["<", "<=", ">", ">="]);
const COMPARISON = new Set<BinOp>(["=", "<>", "<", "<=", ">", ">="]);

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

/** Emit the pending load of `e`, if any. */
export function discharge(c: Compiler, e: Expr): Expr {
  return dischargeTracked(c, e)[0];
}

/** Like {@link discharge}, also returning the load and the reference instruction that could replace it. */
function dischargeTracked(c: Compiler, e: Expr): [Expr, [number, Instr] | undefined] {
  const place = e.place;
  if (!place) return [e, undefined];
  const out: Expr = { ...e, place: undefined };
  if (e.var !== undefined) c.markVar(e.var, true, false);
  const span = e.span;
  let patch: [number, Instr];
  switch (place.k) {
    case "local":
      if (place.byref) {
        c.emit(instr(Op.LoadLocal, place.slot), span);
        patch = [c.emit(instr(Op.Deref), span), instr(Op.Nop)];
      } else patch = [c.emit(instr(Op.LoadLocal, place.slot), span), instr(Op.RefLocal, place.slot)];
      break;
    case "global":
      patch = [c.emit(instr(Op.LoadGlobal, place.g), span), instr(Op.RefGlobal, place.g)];
      break;
    case "selfField":
      patch = [c.emit(instr(Op.LoadSelfField, place.slot), span), instr(Op.RefSelfField, place.slot)];
      break;
    case "field":
      patch = [c.emit(instr(Op.GetField, place.slot), span), instr(Op.FieldRef, place.slot)];
      break;
    case "fieldNamed":
      patch = [
        c.emit(instr(Op.GetFieldNamed, place.sym, place.site), span),
        instr(Op.FieldRefNamed, place.sym, place.site),
      ];
      break;
    case "index":
      patch = [c.emit(instr(Op.Index, place.n), span), instr(Op.IndexRef, place.n)];
      break;
    case "deref":
      patch = [c.emit(instr(Op.Deref), span), instr(Op.Nop)];
      break;
  }
  return [out, patch];
}

/** Push a reference to the place (for BYREF arguments and `^X`). */
export function emitRef(c: Compiler, place: Place, span: Span): void {
  const ins = ((): Instr | undefined => {
    switch (place.k) {
      case "local":
        return instr(place.byref ? Op.LoadLocal : Op.RefLocal, place.slot);
      case "global":
        return instr(Op.RefGlobal, place.g);
      case "selfField":
        return instr(Op.RefSelfField, place.slot);
      case "field":
        return instr(Op.FieldRef, place.slot);
      case "fieldNamed":
        return instr(Op.FieldRefNamed, place.sym, place.site);
      case "index":
        return instr(Op.IndexRef, place.n);
      case "deref":
        return undefined;
    }
  })();
  if (ins) c.emit(ins, span);
}

/** Store the value on top of the stack into the place. */
export function emitStore(c: Compiler, place: Place, span: Span): void {
  const ins = ((): Instr => {
    switch (place.k) {
      case "local":
        return instr(place.byref ? Op.StoreLocalDeref : Op.StoreLocal, place.slot);
      case "global":
        return instr(Op.StoreGlobal, place.g);
      case "selfField":
        return instr(Op.StoreSelfField, place.slot);
      case "field":
        return instr(Op.SetField, place.slot);
      case "fieldNamed":
        return instr(Op.SetFieldNamed, place.sym, place.site);
      case "index":
        return instr(Op.StoreIndex, place.n);
      case "deref":
        return instr(Op.StoreDeref);
    }
  })();
  c.emit(ins, span);
}

// ---------------------------------------------------------------------------
// Precedence levels
// ---------------------------------------------------------------------------

/** A complete expression, value pushed. */
export function expr(c: Compiler): Expr {
  return discharge(c, exprDesc(c));
}

/** A complete expression, possibly still a place. */
export function exprDesc(c: Compiler): Expr {
  return logical(c, "OR", andExpr, Op.JumpIfTrueOrPop);
}

/** Parse the rest of an expression whose leftmost operand is `lhs` (e.g. `+ 1` after `X`). */
export function continueExpr(c: Compiler, lhs: Expr): Expr {
  c.seed = lhs;
  return exprDesc(c);
}

/** An expression that must be BOOLEAN (conditions). */
export function condition(c: Compiler, owner: string, ownerSpan: Span): void {
  const e = expr(c);
  if (c.at("←")) {
    const span = c.tok.span;
    c.parseError(
      Diagnostic.error("E0100", "assignment is not allowed in a condition")
        .primary(span, "this assigns a value")
        .suggest(span, "=", "use `=` to compare for equality"),
    );
    return;
  }
  if (!c.convertTop(T.Bool, e.ty, e.span)) {
    const d = c.mismatch(T.Bool, e.ty, e.span).secondary(ownerSpan, `\`${owner}\` conditions must be BOOLEAN`);
    if (isNumeric(e.ty)) d.suggest(e.span.after(), " <> 0", "compare the number explicitly");
    c.error(d);
  }
}

function andExpr(c: Compiler): Expr {
  return logical(c, "AND", notExpr, Op.JumpIfFalseOrPop);
}

/** Left-associative short-circuit operator. */
function logical(c: Compiler, kw: "AND" | "OR", operand: (c: Compiler) => Expr, jump: Op): Expr {
  let l = operand(c);
  while (c.at(kw)) {
    const opSpan = c.tok.span;
    c.advance();
    l = discharge(c, l);
    expectBoolOperand(c, l, kw, opSpan);
    const j = c.emit(instr(jump), opSpan);
    const r = discharge(c, operand(c));
    expectBoolOperand(c, r, kw, opSpan);
    c.patchJump(j);
    l = valueExpr(T.Bool, l.span.to(r.span));
  }
  return l;
}

function expectBoolOperand(c: Compiler, e: Expr, op: string, opSpan: Span): void {
  if (!c.convertTop(T.Bool, e.ty, e.span)) {
    c.error(c.mismatch(T.Bool, e.ty, e.span).secondary(opSpan, `\`${op}\` needs BOOLEAN operands`));
  }
}

function notExpr(c: Compiler): Expr {
  if (c.at("NOT") && !c.seed) {
    const span = c.tok.span;
    c.advance();
    const e = discharge(c, notExpr(c));
    expectBoolOperand(c, e, "NOT", span);
    c.emit(instr(Op.Not), span);
    return valueExpr(T.Bool, span.to(e.span));
  }
  return comparison(c);
}

/** Binary operators at one precedence level. */
function level(c: Compiler, ops: ReadonlyMap<Kind, BinOp>, next: (c: Compiler) => Expr): Expr {
  let l = next(c);
  for (let op = ops.get(c.tok.kind); op; op = ops.get(c.tok.kind)) l = binary(c, op, l, next);
  return l;
}

const CMP_OPS = new Map<Kind, BinOp>([["=", "="], ["<>", "<>"], ["<", "<"], ["<=", "<="], [">", ">"], [">=", ">="]]);
const CONCAT_OPS = new Map<Kind, BinOp>([["&", "&"]]);
const ADD_OPS = new Map<Kind, BinOp>([["+", "+"], ["-", "-"]]);
const MUL_OPS = new Map<Kind, BinOp>([["*", "*"], ["/", "/"], ["DIV", "DIV"], ["MOD", "MOD"]]);

const comparison = (c: Compiler) => level(c, CMP_OPS, concat);
const concat = (c: Compiler) => level(c, CONCAT_OPS, additive);
const additive = (c: Compiler) => level(c, ADD_OPS, term);
const term = (c: Compiler) => level(c, MUL_OPS, unary);

function binary(c: Compiler, op: BinOp, lhs: Expr, rhs: (c: Compiler) => Expr): Expr {
  const opSpan = c.tok.span;
  c.advance();
  const l = discharge(c, lhs);
  const r = discharge(c, rhs(c));
  return valueExpr(emitBinary(c, op, l, r, opSpan), l.span.to(r.span));
}

/** Type-check and emit a binary operator; both operands are on the stack. */
export function emitBinary(c: Compiler, op: BinOp, l: Expr, r: Expr, opSpan: Span): Ty {
  const lt = l.ty, rt = r.ty;
  if (lt.k === "error" || rt.k === "error") return T.Error;
  const dynamic = isDynamic(lt) || isDynamic(rt);
  const numeric = (t: Ty) => isNumeric(t) || isDynamic(t);
  const intish = (t: Ty) => t.k === "int" || t.k === "unknown";
  const emit = (o: Op) => c.emit(instr(o), opSpan);
  switch (op) {
    case "+":
    case "-":
    case "*":
      if (numeric(lt) && numeric(rt)) {
        emit(op === "+" ? Op.Add : op === "-" ? Op.Sub : Op.Mul);
        return lt.k === "real" || rt.k === "real" ? T.Real : dynamic ? T.Unknown : T.Int;
      }
      break;
    case "/":
      if (numeric(lt) && numeric(rt)) {
        emit(Op.Div);
        return T.Real;
      }
      break;
    case "DIV":
    case "MOD":
      if (intish(lt) && intish(rt)) {
        emit(op === "DIV" ? Op.IntDiv : Op.Mod);
        return T.Int;
      }
      break;
    case "&":
      if ((isText(lt) || dynamic) && (isText(rt) || isDynamic(rt))) {
        emit(Op.Concat);
        return T.Str;
      }
      break;
    default:
      if (comparable(c, op, lt, rt)) {
        const ops: Record<string, Op> = { "=": Op.Eq, "<>": Op.Ne, "<": Op.Lt, "<=": Op.Le, ">": Op.Gt, ">=": Op.Ge };
        emit(ops[op]);
        return T.Bool;
      }
  }
  operatorError(c, op, l, r, opSpan);
  return op === "&" ? T.Str : COMPARISON.has(op) ? T.Bool : T.Error;
}

function comparable(c: Compiler, op: BinOp, l: Ty, r: Ty): boolean {
  if (isDynamic(l) || isDynamic(r)) return true;
  const ordered = (isNumeric(l) && isNumeric(r)) || (isText(l) && isText(r)) ||
    (tyEquals(l, r) && (l.k === "date" || l.k === "enum"));
  if (ordered) return true;
  if (op !== "=" && op !== "<>") return false;
  return tyEquals(l, r) ||
    (l.k === "class" && r.k === "class" && (c.isSubclass(l.id, r.id) || c.isSubclass(r.id, l.id)));
}

function operatorError(c: Compiler, op: BinOp, l: Expr, r: Expr, opSpan: Span): void {
  const ln = c.tyName(l.ty), rn = c.tyName(r.ty);
  const d = Diagnostic.error("E0303", `cannot apply \`${op}\` to \`${ln}\` and \`${rn}\``)
    .primary(opSpan, "no implementation for these operand types")
    .secondary(l.span, `\`${ln}\``)
    .secondary(r.span, `\`${rn}\``);
  if (op === "+" && (isText(l.ty) || isText(r.ty))) d.suggest(opSpan, "&", "use `&` to join strings together");
  else if (op === "&") {
    const bad = isText(l.ty) ? r : l;
    if (isNumeric(bad.ty)) {
      d.suggest(bad.span, `NUM_TO_STR(${c.text(bad.span)})`, "convert the number to a STRING first");
    } else d.note("`&` concatenates STRING and CHAR values");
  } else if ((op === "DIV" || op === "MOD") && (l.ty.k === "real" || r.ty.k === "real")) {
    d.note(`\`${op}\` is only defined for INTEGER operands`).help(
      "use `/` for REAL division, or INT(...) to truncate first",
    );
  } else if (RELATIONAL.has(op) && l.ty.k === "bool" && isNumeric(r.ty)) {
    d.note("comparison operators cannot be chained").help("split the comparison, e.g. `A < B AND B < C`");
  }
  c.error(d);
}

function unary(c: Compiler): Expr {
  if (c.seed) {
    const e = c.seed;
    c.seed = undefined;
    return e;
  }
  if (!c.at("-")) return postfix(c);
  const span = c.tok.span;
  c.advance();
  const e = discharge(c, unary(c));
  const full = span.to(e.span);
  // Fold negative literals so constants such as `-1` stay constants.
  if (typeof e.constant === "number") {
    c.proto.code[c.pc - 1] = instr(Op.PushInt, -e.constant);
    return { ty: T.Int, span: full, constant: -e.constant };
  }
  if (e.constant instanceof Real) {
    const neg = new Real(-e.constant.v);
    const last = c.proto.code[c.pc - 1];
    if (last.op === Op.Const) c.proto.consts[last.a] = neg;
    return { ty: T.Real, span: full, constant: neg };
  }
  if (!(isNumeric(e.ty) || isDynamic(e.ty))) {
    const n = c.tyName(e.ty);
    c.error(
      Diagnostic.error("E0303", `cannot negate a value of type \`${n}\``)
        .primary(span, "unary `-` needs a number")
        .secondary(e.span, `\`${n}\``),
    );
    return errorExpr(full);
  }
  c.emit(instr(Op.Neg), span);
  return valueExpr(e.ty, full);
}

// ---------------------------------------------------------------------------
// Postfix: field access, method sends, indexing, dereference
// ---------------------------------------------------------------------------

export function postfix(c: Compiler): Expr {
  let e = primary(c);
  for (;;) {
    if (c.at(".")) {
      c.advance();
      const member = memberName(c);
      if (!member) return errorExpr(e.span);
      e = discharge(c, e);
      e = c.at("(") ? methodCall(c, e, ...member) : fieldAccess(c, e, ...member);
    } else if (c.at("[")) {
      e = index(c, discharge(c, e));
    } else if (c.at("^")) {
      const span = c.tok.span;
      c.advance();
      e = discharge(c, e);
      const full = e.span.to(span);
      if (e.ty.k === "pointer") e = placeExpr({ k: "deref" }, e.ty.to, full);
      else if (isDynamic(e.ty)) e = placeExpr({ k: "deref" }, e.ty, full);
      else {
        const n = c.tyName(e.ty);
        c.error(
          Diagnostic.error("E0304", `cannot dereference a value of type \`${n}\``)
            .primary(span, "`^` after a value follows a pointer")
            .secondary(e.span, `this is \`${n}\`, not a pointer`),
        );
        e = errorExpr(full);
      }
    } else return e;
  }
}

/** Member names may be identifiers or the keyword NEW (constructors). */
function memberName(c: Compiler): [string, Span] | undefined {
  if (c.at("NEW")) {
    const span = c.tok.span;
    c.advance();
    return ["NEW", span];
  }
  return c.expectIdent("after `.`");
}

function fieldAccess(c: Compiler, obj: Expr, name: string, nameSpan: Span): Expr {
  const full = obj.span.to(nameSpan);
  const t = obj.ty;
  if (t.k === "unknown") return placeExpr({ k: "fieldNamed", sym: c.intern(name), site: c.newSite() }, T.Unknown, full);
  if (t.k === "error") return errorExpr(full);
  if (t.k !== "record" && t.k !== "class") {
    const n = c.tyName(t);
    const d = Diagnostic.error("E0305", `\`${n}\` values have no fields`)
      .primary(nameSpan, `no field \`${name}\``)
      .secondary(obj.span, `this has type \`${n}\``);
    if (lookupBuiltin(name.toUpperCase()) !== undefined && isText(t)) {
      d.help(`string operations are functions: \`${name.toUpperCase()}(...)\``);
    }
    c.error(d);
    return errorExpr(full);
  }
  const shape = c.shapes[t.id];
  const idx = shape.fields.findIndex((f) => f.name === name);
  if (idx >= 0) {
    checkFieldVisibility(c, t.id, idx, nameSpan);
    return placeExpr({ k: "field", slot: idx }, shape.fields[idx].ty, full);
  }
  // `obj.Method` without parentheses: a zero-argument send.
  if (shape.isClass && c.findMethod(t.id, name)) return methodCall(c, obj, name, nameSpan);
  noMemberError(c, t.id, name, nameSpan, obj.span, "field");
  return errorExpr(full);
}

function checkFieldVisibility(c: Compiler, shape: number, idx: number, span: Span): void {
  const f = c.shapes[shape].fields[idx];
  if (!f.private || c.cur.cls === f.owner) return;
  const owner = c.shapes[f.owner].name;
  const d = Diagnostic.error("E0307", `field \`${f.name}\` of class \`${owner}\` is private`)
    .primary(span, "private field")
    .secondary(f.span, "declared PRIVATE here");
  if (c.cur.cls !== undefined && c.isSubclass(c.cur.cls, f.owner)) {
    d.note("PRIVATE members are not visible to subclasses")
      .help(`call a PUBLIC method of \`${owner}\` (for example via \`SUPER\`) instead`);
  } else d.help(`add a PUBLIC method to \`${owner}\` that reads or updates \`${f.name}\``);
  c.error(d);
}

export function noMemberError(
  c: Compiler,
  shape: number,
  name: string,
  span: Span,
  objSpan: Span,
  what: "field" | "method",
): void {
  const s = c.shapes[shape];
  const names = s.fields.map((f) => f.name);
  if (s.isClass) names.push(...c.allMethodNames(shape));
  const d = Diagnostic.error(
    what === "field" ? "E0305" : "E0306",
    `no ${what} \`${name}\` on ${s.isClass ? "class" : "record type"} \`${s.name}\``,
  )
    .primary(span, `unknown ${what}`)
    .secondary(objSpan, `this is a \`${s.name}\``);
  const m = bestMatch(name, names);
  if (m) d.suggest(span, m, `there is a member with a similar name: \`${m}\``);
  else if (names.length) d.note(`\`${s.name}\` has: ${names.join(", ")}`);
  c.error(d);
}

function index(c: Compiler, arr: Expr): Expr {
  const open = c.tok.span;
  c.advance();
  const idx: Expr[] = [];
  do {
    const i = expr(c);
    if (!c.convertTop(T.Int, i.ty, i.span)) {
      c.error(c.mismatch(T.Int, i.ty, i.span).note("array indices must be INTEGER"));
    }
    idx.push(i);
  } while (c.eat(","));
  c.expect("]", "to close the array index");
  const full = arr.span.to(c.prev);
  const n = idx.length;
  const t = arr.ty;
  let ty: Ty;
  if (t.k === "array") {
    if (t.dims.length !== n) {
      c.error(
        Diagnostic.error("E0304", `wrong number of indices: expected ${t.dims.length}, found ${n}`)
          .primary(open.to(c.prev), `${n} ind${n === 1 ? "ex" : "ices"}`)
          .secondary(arr.span, `this is \`${c.tyName(t)}\``),
      );
      return errorExpr(full);
    }
    idx.forEach((i, d) => {
      const [lo, hi] = t.dims[d];
      if (typeof i.constant === "number" && (i.constant < lo || i.constant > hi)) {
        c.error(
          Diagnostic.error("E0304", "array index out of bounds")
            .primary(i.span, `index ${i.constant} is outside ${lo}:${hi}`)
            .secondary(arr.span, `valid indices are ${lo} to ${hi}`),
        );
      }
    });
    ty = t.elem;
  } else if (isDynamic(t)) ty = t;
  else {
    const tn = c.tyName(t);
    const d = Diagnostic.error("E0304", `cannot index into a value of type \`${tn}\``)
      .primary(open, "indexing needs an ARRAY")
      .secondary(arr.span, `this is \`${tn}\``);
    if (isText(t)) d.help("use MID(s, start, 1) to read one character of a STRING");
    c.error(d);
    ty = T.Error;
  }
  return placeExpr({ k: "index", n }, ty, full);
}

// ---------------------------------------------------------------------------
// Primary expressions
// ---------------------------------------------------------------------------

function literal(c: Compiler, v: Value, ty: Ty): Expr {
  const span = c.tok.span;
  c.advance();
  c.constant(v, span);
  return { ty, span, constant: v };
}

const CASTS: Partial<Record<Kind, [Conv, Ty]>> = {
  INTEGER: [Conv.Int, T.Int],
  REAL: [Conv.Real, T.Real],
  BOOLEAN: [Conv.Bool, T.Bool],
  CHAR: [Conv.Char, T.Char],
  STRING: [Conv.Str, T.Str],
  DATE: [Conv.Date, T.Date],
};

function primary(c: Compiler): Expr {
  const span = c.tok.span;
  const tok = c.tok;
  switch (tok.kind) {
    case "int":
      return literal(c, tok.value as number, T.Int);
    case "real":
      return literal(c, new Real(tok.value as number), T.Real);
    case "char":
      return literal(c, new Char(tok.value as string), T.Char);
    case "date":
      return literal(c, new DateVal(tok.value as number), T.Date);
    case "TRUE":
      return literal(c, true, T.Bool);
    case "FALSE":
      return literal(c, false, T.Bool);
    case "str": {
      const chars = [...c.text(span)];
      return literal(c, chars.slice(1, -1).join(""), T.Str);
    }
    case "(": {
      c.advance();
      const e = expr(c);
      c.expect(")", "to close the parenthesis");
      return { ...e, span: span.to(c.prev) };
    }
    case "INTEGER":
    case "REAL":
    case "BOOLEAN":
    case "CHAR":
    case "STRING":
    case "DATE":
      return cast(c, tok.kind);
    case "DIV":
    case "MOD": {
      const k = tok.kind;
      c.advance();
      c.expect("(", `after function-style \`${k}\``);
      const a = expr(c);
      c.expect(",", "between the two operands");
      const b = expr(c);
      c.expect(")", "to close the argument list");
      return valueExpr(emitBinary(c, k, a, b, span), span.to(c.prev));
    }
    case "ident":
      return identExpr(c);
    case "error":
      c.advance();
      return errorExpr(span);
    case "^": {
      c.advance();
      const target = postfix(c);
      const full = span.to(target.span);
      if (!target.place) {
        c.error(
          Diagnostic.error("E0309", "cannot take the address of a temporary value")
            .primary(target.span, "this is not a variable")
            .note("`^X` creates a pointer to the variable X"),
        );
        return errorExpr(full);
      }
      if (target.var !== undefined) c.markVar(target.var, true, true);
      emitRef(c, target.place, full);
      return valueExpr({ k: "pointer", to: target.ty }, full);
    }
    case "NEW":
      return construct(c);
    case "SUPER":
      return superCall(c);
    default: {
      const d = c.expectedError("an expression", "");
      const kw = c.miscasedKeyword();
      if (kw) d.note(`\`${c.text(span)}\` looks like the keyword \`${kw}\``);
      c.parseError(d);
      return errorExpr(span);
    }
  }
}

function cast(c: Compiler, k: Kind): Expr {
  const span = c.tok.span;
  c.advance();
  if (!c.at("(")) {
    c.parseError(
      Diagnostic.error("E0100", `type name \`${k}\` used as a value`)
        .primary(span, "expected an expression")
        .help(`to convert a value, write \`${k}(value)\``),
    );
    return errorExpr(span);
  }
  c.advance();
  const e = expr(c);
  c.expect(")", "to close the conversion");
  const full = span.to(c.prev);
  const [to, ty] = CASTS[k]!;
  const ok = isDynamic(e.ty) || ["int", "real", "bool", "char", "str", "date", "enum"].includes(e.ty.k);
  if (!ok) {
    const n = c.tyName(e.ty);
    c.error(
      Diagnostic.error("E0300", `cannot convert \`${n}\` to \`${k}\``).primary(e.span, `\`${n}\` has no ${k} form`),
    );
  }
  c.emit(instr(Op.Convert, to), full);
  return valueExpr(ty, full);
}

function identExpr(c: Compiler): Expr {
  const span = c.tok.span;
  const name = c.text(span);
  c.advance();
  if (c.at("(")) return callNamed(c, name, span);

  // Locals, local constants, then fields of SELF, then globals.
  const lv = c.findLocal(name);
  if (lv !== undefined) {
    const l = c.var(lv);
    return { place: { k: "local", slot: lv, byref: l.byref }, ty: l.ty, span, var: lv };
  }
  const f = c.cur;
  const lc = f.consts.get(name);
  if (lc) return constExpr(c, name, lc.value, lc.ty, lc.span, span);
  if (f.cls !== undefined) {
    const idx = c.shapes[f.cls].fields.findIndex((x) => x.name === name);
    if (idx >= 0) {
      checkFieldVisibility(c, f.cls, idx, span);
      return placeExpr({ k: "selfField", slot: idx }, c.shapes[f.cls].fields[idx].ty, span);
    }
    if (c.findMethod(f.cls, name)) return callNamed(c, name, span);
  }
  const n = c.names.get(name);
  switch (n?.k) {
    case "var":
      return { place: { k: "global", g: n.g }, ty: c.globals[n.g].ty, span, var: global(n.g) };
    case "const":
      return constExpr(c, name, n.value, n.ty, n.span, span);
    case "variant": {
      const v = new EnumVal(n.ty, n.ord);
      c.constant(v, span);
      return { ty: { k: "enum", id: n.ty }, span, constant: v };
    }
    case "func": {
      const fe = c.funcs[n.f];
      const what = fe.kind;
      const d = Diagnostic.error("E0302", `${what} \`${name}\` used without an argument list`)
        .primary(span, `this names a ${what}`)
        .suggest(span.after(), "()", "add parentheses to call it");
      if (fe.defined) d.secondary(fe.span, `${what} defined here`);
      c.error(d);
      return errorExpr(span);
    }
    case "type": {
      const d = Diagnostic.error("E0302", `type \`${name}\` used as a value`).primary(
        span,
        "this is a type, not a value",
      );
      if (n.def.k === "class") d.suggest(span, `NEW ${name}()`, "create an instance of the class with NEW");
      c.error(d);
      return errorExpr(span);
    }
  }
  if (lookupBuiltin(name) !== undefined) {
    c.error(
      Diagnostic.error("E0302", `built-in function \`${name}\` used without arguments`)
        .primary(span, "missing argument list")
        .suggest(span.after(), "()", "call it with parentheses"),
    );
    return errorExpr(span);
  }
  unresolvedName(c, name, span);
  return errorExpr(span);
}

function constExpr(c: Compiler, name: string, v: Value, ty: Ty, decl: Span, span: Span): Expr {
  if (c.at("←")) {
    c.error(
      Diagnostic.error("E0202", `cannot assign to constant \`${name}\``)
        .primary(span, "constants cannot be changed")
        .secondary(decl, "declared as a CONSTANT here")
        .help(`declare \`${name}\` with DECLARE if it needs to change`),
    );
    return valueExpr(T.Error, span);
  }
  c.constant(v, span);
  return { ty, span, constant: v };
}

export function unresolvedName(c: Compiler, name: string, span: Span): void {
  const kw = lookupKeyword(name.toUpperCase());
  if (kw) {
    c.error(
      Diagnostic.error("E0103", `\`${name}\` is not defined; keywords must be upper case`)
        .primary(span, `did you mean the keyword \`${kw}\`?`)
        .suggest(span, kw, "write the keyword in capitals"),
    );
    return;
  }
  const d = Diagnostic.error("E0200", `cannot find \`${name}\` in this scope`).primary(span, "not declared");
  const m = bestMatch(name, c.visibleNames());
  if (m) d.suggest(span, m, `a name with a similar spelling exists: \`${m}\``);
  else d.help(`declare it first, e.g. \`DECLARE ${name} : INTEGER\``);
  if (c.isMain()) d.note("variables must be declared before they are used");
  c.error(d);
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

/** `Name(args)`: a builtin, user routine, send to SELF or forward reference. */
export function callNamed(c: Compiler, name: string, span: Span): Expr {
  // A variable followed by `(`.
  const v = c.lookupVar(name);
  if (v !== undefined) {
    const ty = c.var(v).ty;
    const d = Diagnostic.error("E0302", `\`${name}\` is a variable, not a routine`)
      .primary(span, `\`${name}\` has type \`${c.tyName(ty)}\``);
    if (ty.k === "array") d.help(`use square brackets to index an array: \`${name}[...]\``);
    c.error(d);
    skipArgs(c);
    return errorExpr(span);
  }

  // Methods shadow global routines inside a class.
  const cls = c.cur.cls;
  const m = cls !== undefined ? c.findMethod(cls, name) : undefined;
  if (m) {
    const [ret, kind] = retOf(c, m.func);
    const args = callArgs(c, name, c.funcs[m.func].params, m.func);
    c.emit(instr(Op.SendSelf, c.intern(name), args.count, c.newSite()), span);
    return { ty: ret, span: span.to(args.span), call: kind === "procedure" ? "procedure" : "method" };
  }

  const n = c.names.get(name);
  if (n?.k === "func") {
    if (!c.funcs[n.f].defined) return forwardCall(c, n.f, name, span);
    const [ret, kind] = retOf(c, n.f);
    const args = callArgs(c, name, c.funcs[n.f].params, n.f);
    c.emit(instr(Op.Call, n.f, args.count), span);
    return { ty: ret, span: span.to(args.span), call: kind };
  }
  if (n) {
    skipArgs(c);
    if (n.k === "type" && n.def.k === "class") {
      c.error(
        Diagnostic.error("E0302", `\`${name}\` is a class, not a routine`)
          .primary(span, "classes are instantiated with NEW")
          .suggest(new Span(span.start, span.start), "NEW ", "create an instance"),
      );
    } else {
      c.error(
        Diagnostic.error("E0302", `\`${name}\` is not a procedure or function`).primary(span, "cannot be called"),
      );
    }
    return errorExpr(span);
  }

  const b = lookupBuiltin(name);
  if (b !== undefined) return builtinCall(c, b, span);
  const upper = lookupBuiltin(name.toUpperCase());
  if (upper !== undefined) {
    skipArgs(c);
    const bn = BUILTINS[upper].name;
    c.error(
      Diagnostic.error("E0200", `cannot find function \`${name}\``)
        .primary(span, "not defined")
        .suggest(span, bn, `built-in functions are upper case: \`${bn}\``),
    );
    return errorExpr(span);
  }

  // Not seen yet: compile against a placeholder and check later.
  const i = c.newFnSlot(name, Span.DUMMY);
  c.names.set(name, { k: "func", f: i });
  return forwardCall(c, i, name, span);
}

function retOf(c: Compiler, func: number): [Ty, "procedure" | "function"] {
  const f = c.funcs[func];
  return [f.kind === "procedure" ? T.Void : f.ret, f.kind];
}

function forwardCall(c: Compiler, func: number, name: string, span: Span): Expr {
  const args = callArgs(c, name, undefined, func);
  const callPc = c.emit(instr(Op.Call, func, args.count), span);
  const idx = c.pending.length;
  c.pending.push({
    func,
    name,
    nameSpan: span,
    argsSpan: args.span,
    proto: c.cur.proto,
    callPc,
    args: args.deferred,
    asStatement: false,
    selfClass: c.cur.cls,
    resolved: false,
  });
  return { ty: T.Unknown, span: span.to(args.span), call: idx };
}

/** Skip an argument list after an error, stopping at the end of the line if parentheses are unbalanced. */
export function skipArgs(c: Compiler): void {
  if (!c.eat("(")) return;
  let depth = 1;
  while (depth > 0 && !c.at("eof") && !c.tok.lineStart) {
    if (c.at("(")) depth++;
    else if (c.at(")")) depth--;
    c.advance();
  }
}

interface Args {
  count: number;
  span: Span;
  deferred: PendingArg[];
}

/** Compile an argument list: checked now with a known signature, otherwise recorded for later. */
export function callArgs(c: Compiler, name: string, params: readonly Param[] | undefined, func: number): Args {
  const start = c.tok.span;
  let count = 0;
  const deferred: PendingArg[] = [];
  if (c.eat("(") && !c.eat(")")) {
    do {
      const e = exprDesc(c);
      const p = params?.[count];
      if (p?.byref) {
        if (e.place) {
          if (e.var !== undefined) c.markVar(e.var, true, true);
          emitRef(c, e.place, e.span);
          if (c.compat(p.ty, e.ty).k !== "same" || c.compat(e.ty, p.ty).k !== "same") c.byrefTypeError(e.span, e.ty, p);
        } else c.byrefValueError(e.span, p);
      } else if (p) {
        const d = discharge(c, e);
        const compat = c.compat(p.ty, d.ty);
        if (compat.k === "incompatible") {
          c.error(
            c.mismatch(p.ty, d.ty, d.span).secondary(p.span, `parameter \`${p.name}\` of \`${name}\` declared here`),
          );
        } else if (compat.k === "convert" && compat.ins.op === Op.Check) {
          // Widening happens in the callee's prologue; only run-time checks are needed here.
          c.emit({ ...compat.ins }, d.span);
        }
      } else if (params) discharge(c, e);
      else {
        const [d, patch] = dischargeTracked(c, e);
        deferred.push({ ty: d.ty, span: d.span, patch });
      }
      count++;
    } while (c.eat(","));
    c.expect(")", "to close the argument list");
  }
  // With no parentheses nothing was consumed: point just after the name.
  const span = c.prev.start < start.start ? start.after() : start.to(c.prev);
  if (params && params.length !== count) {
    const f = c.funcs[func];
    c.arityError(name, span, params.length, count, f.span, f.proto.signature);
  }
  return { count, span, deferred };
}

function patAccepts(p: Pat, ty: Ty): boolean {
  if (isDynamic(ty)) return true;
  switch (p) {
    case "Int":
      return ty.k === "int";
    case "Real":
    case "Num":
      return isNumeric(ty);
    case "Bool":
      return ty.k === "bool";
    case "Char":
      return ty.k === "char";
    case "Str":
    case "Text":
      return isText(ty);
    case "Date":
      return ty.k === "date";
    default:
      return true;
  }
}

function builtinCall(c: Compiler, bi: number, span: Span): Expr {
  const b: Builtin = BUILTINS[bi];
  const open = c.tok.span;
  const args: Expr[] = [];
  c.advance(); // `(`
  if (!c.eat(")")) {
    do args.push(expr(c)); while (c.eat(","));
    c.expect(")", "to close the argument list");
  }
  const full = span.to(c.prev);
  const sig = `${b.name}(${b.params.map(patName).join(", ")}) RETURNS ${patName(b.ret)}`;
  if (args.length !== b.params.length) {
    c.arityError(b.name, open.to(c.prev), b.params.length, args.length, Span.DUMMY, sig);
  } else {
    args.forEach((a, i) => {
      const p = b.params[i];
      if (patAccepts(p, a.ty)) return;
      const d = Diagnostic.error("E0300", `argument ${i + 1} of \`${b.name}\` has the wrong type`)
        .primary(a.span, `expected ${patName(p)}, found \`${c.tyName(a.ty)}\``)
        .note(`${sig}: ${b.doc}`);
      if (p === "Str" && isNumeric(a.ty)) {
        d.suggest(a.span, `NUM_TO_STR(${c.text(a.span)})`, "convert the number to a STRING");
      }
      c.error(d);
    });
  }
  c.emit(instr(Op.CallBuiltin, bi, args.length), full);
  const RET: Partial<Record<Pat, Ty>> = {
    Int: T.Int,
    Real: T.Real,
    Bool: T.Bool,
    Char: T.Char,
    Str: T.Str,
    Date: T.Date,
  };
  const ret = b.ret === "SameAsArg0" ? (args[0]?.ty ?? T.Error) : (RET[b.ret] ?? T.Unknown);
  return { ty: ret, span: full, call: "builtin" };
}

/** `receiver.Name(args)`: a message send through an inline cache. */
function methodCall(c: Compiler, recv: Expr, name: string, nameSpan: Span): Expr {
  const site = c.newSite();
  const sym = c.intern(name);
  let ret: Ty = T.Unknown;
  let kind: CallKind = "method";
  let params: readonly Param[] | undefined;
  let func = 0;
  const t = recv.ty;
  if (t.k === "class") {
    const m = c.findMethod(t.id, name);
    if (m) {
      func = m.func;
      if (m.private && c.cur.cls !== m.owner) {
        c.error(
          Diagnostic.error("E0307", `method \`${name}\` of class \`${c.shapes[m.owner].name}\` is private`)
            .primary(nameSpan, "private method")
            .secondary(c.funcs[func].span, "declared PRIVATE here")
            .help("only methods of the same class can call it"),
        );
      }
      params = c.funcs[func].params;
      const [r, k] = retOf(c, func);
      ret = r;
      if (k === "procedure") kind = "procedure";
    } else if (!c.shapes[t.id].complete) {
      c.pendingMethods.push({ cls: t.id, name, span: nameSpan });
    } else {
      if (c.shapes[t.id].fields.some((f) => f.name === name)) {
        c.error(
          Diagnostic.error("E0306", `\`${name}\` is a field, not a method`)
            .primary(nameSpan, "cannot be called")
            .help("remove the parentheses to read the field"),
        );
      } else noMemberError(c, t.id, name, nameSpan, recv.span, "method");
      ret = T.Error;
    }
  } else if (!isDynamic(t)) {
    const tn = c.tyName(t);
    const d = Diagnostic.error("E0306", `\`${tn}\` values have no methods`)
      .primary(nameSpan, `no method \`${name}\``)
      .secondary(recv.span, `this is \`${tn}\``);
    const b = lookupBuiltin(name.toUpperCase());
    if (b !== undefined) {
      d.suggest(
        recv.span.to(nameSpan),
        `${BUILTINS[b].name}(${c.text(recv.span)}`,
        "use the built-in function instead",
      );
    }
    c.error(d);
    ret = T.Error;
  }
  const args = callArgs(c, name, params, func);
  c.emit(instr(Op.Send, sym, args.count, site), nameSpan);
  return { ty: ret, span: recv.span.to(args.span), call: kind };
}

/** `NEW ClassName(args)` */
function construct(c: Compiler): Expr {
  const newSpan = c.tok.span;
  c.advance();
  const id = c.expectIdent("after `NEW`");
  if (!id) return errorExpr(newSpan);
  const [name, span] = id;
  const n = c.names.get(name);
  if (n?.k !== "type" || n.def.k !== "class") {
    skipArgs(c);
    if (n?.k === "type") {
      c.error(
        Diagnostic.error("E0400", `\`${name}\` is not a class`)
          .primary(span, "NEW can only create class instances")
          .help("records are created by DECLARE-ing a variable of the record type"),
      );
    } else {
      const d = Diagnostic.error("E0200", `cannot find class \`${name}\``).primary(span, "no such class");
      const m = bestMatch(name, c.shapes.filter((s) => s.isClass).map((s) => s.name));
      if (m) d.suggest(span, m, "a class with a similar name exists");
      else d.note("classes must be defined before they are instantiated");
      c.error(d);
    }
    return errorExpr(newSpan.to(span));
  }
  const cls = n.def.id;
  const ctor = c.findMethod(cls, "NEW");
  let args: Args;
  if (!ctor && c.at("(")) {
    // No constructor: only `NEW C()` is valid.
    args = callArgs(c, name, undefined, 0);
    if (args.count > 0) {
      const cname = c.shapes[cls].name;
      c.error(
        Diagnostic.error("E0301", `class \`${cname}\` has no constructor taking arguments`)
          .primary(args.span, `${args.count} argument(s) supplied`)
          .help(`define \`PUBLIC PROCEDURE NEW(...)\` in \`${cname}\``),
      );
    }
  } else args = callArgs(c, name, ctor ? c.funcs[ctor.func].params : [], ctor?.func ?? 0);
  c.emit(instr(Op.Construct, cls, ctor ? ctor.func : -1, args.count), newSpan.to(span));
  return valueExpr({ k: "class", id: cls }, newSpan.to(args.span));
}

/** `SUPER.Name(args)`: a statically bound send to the superclass. */
function superCall(c: Compiler): Expr {
  const span = c.tok.span;
  c.advance();
  const cls = c.cur.cls;
  const parent = cls !== undefined ? c.shapes[cls].parent : undefined;
  c.expect(".", "after `SUPER`");
  const member = memberName(c);
  if (!member) return errorExpr(span);
  const [name, nameSpan] = member;
  if (parent === undefined) {
    skipArgs(c);
    c.error(
      Diagnostic.error(
        "E0400",
        cls !== undefined ? "`SUPER` used in a class without a superclass" : "`SUPER` used outside of a class",
      )
        .primary(span, "no superclass here")
        .help("declare a superclass with `CLASS Child INHERITS Parent`"),
    );
    return errorExpr(span);
  }
  const m = c.findMethod(parent, name);
  if (!m) {
    skipArgs(c);
    noMemberError(c, parent, name, nameSpan, span, "method");
    return errorExpr(span.to(nameSpan));
  }
  const [ret, kind] = retOf(c, m.func);
  c.emit(instr(Op.LoadSelf), span);
  const args = callArgs(c, name, c.funcs[m.func].params, m.func);
  c.emit(instr(Op.Call, m.func, args.count + 1), span.to(nameSpan));
  return { ty: ret, span: span.to(args.span), call: kind === "procedure" ? "procedure" : "method" };
}
