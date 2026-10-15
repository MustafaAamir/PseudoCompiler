/**
 * Compiler state and the helpers shared by the expression, statement and
 * declaration modules.
 *
 * The compiler is single-pass: tokens are pulled lazily from the lexer,
 * parsed by recursive descent and turned straight into bytecode while being
 * type checked. There is no token array and no AST. Expressions compile to
 * descriptors whose final load is deferred (Lua's `expdesc` technique), so the
 * same parse of `A[I].Name` can become a load, a store target or a BYREF
 * reference. Calls to routines defined later are compiled against a
 * placeholder and checked (and patched) once the whole file has been seen.
 */

import { BUILTINS } from "../core/builtins.ts";
import {
  Conv,
  type EnumInfo,
  type FieldMeta,
  global,
  globalIndex,
  type GlobalInfo,
  type Init,
  type Instr,
  instr,
  isGlobal,
  type LocalInfo,
  type MethodMeta,
  Op,
  Program,
  Proto,
  type Shape,
  type VarLoc,
} from "../core/bytecode.ts";
import { bestMatch, Diagnostic, Diagnostics, plural } from "../core/diag.ts";
import { type Source, Span } from "../core/source.ts";
import type { Value } from "../core/value.ts";
import {
  describe,
  isBlockEnd,
  isKeyword,
  type Kind,
  type Kw,
  Lexer,
  lookupKeyword,
  startsStatement,
  type Token,
} from "./lexer.ts";
import { convOf, isNumeric, isText, T, type Ty, tyEquals } from "./types.ts";
import type { Expr } from "./expr.ts";

export interface Param {
  readonly name: string;
  readonly ty: Ty;
  readonly byref: boolean;
  readonly span: Span;
}

export type FnKind = "function" | "procedure";

export interface FnEntry {
  kind: FnKind;
  params: Param[];
  ret: Ty;
  proto: Proto;
  defined: boolean;
  span: Span;
}

/** A global or local variable. A local's slot is its index in `FnState.locals`. */
export interface Var {
  readonly name: string;
  readonly ty: Ty;
  readonly span: Span;
  used: boolean;
  assigned: boolean;
  readonly byref: boolean;
  readonly param: boolean;
  /** Compiler-generated (loop bounds, CASE subjects, ...). */
  readonly hidden: boolean;
}

export type TypeName =
  | { readonly k: "record" | "class" | "enum"; readonly id: number }
  | { readonly k: "alias"; readonly ty: Ty };

/** Top-level namespace entries. */
export type Name =
  | { readonly k: "var"; readonly g: number }
  | { readonly k: "const"; readonly value: Value; readonly ty: Ty; readonly span: Span }
  | { readonly k: "func"; readonly f: number }
  | { readonly k: "type"; readonly def: TypeName; readonly span: Span }
  | { readonly k: "variant"; readonly ty: number; readonly ord: number; readonly span: Span };

export interface FieldDef {
  readonly name: string;
  readonly ty: Ty;
  readonly private: boolean;
  readonly owner: number;
  readonly span: Span;
}

export interface ShapeDef {
  readonly name: string;
  readonly span: Span;
  readonly isClass: boolean;
  readonly parent: number | undefined;
  readonly fields: FieldDef[];
  readonly methods: Map<string, MethodMeta>;
  complete: boolean;
}

export interface LoopCtx {
  readonly breaks: number[];
  readonly continues: number[];
}

/** Which prototype code is being emitted into: -1 for main, otherwise a function index. */
export type ProtoRef = number;
const MAIN: ProtoRef = -1;

export interface FnState {
  readonly proto: ProtoRef;
  readonly locals: Var[];
  readonly consts: Map<string, { value: Value; ty: Ty; span: Span }>;
  readonly loops: LoopCtx[];
  /** Inside a FUNCTION: the declared return type and its span. */
  readonly ret: { ty: Ty; span: Span } | undefined;
  readonly cls: number | undefined;
  sawReturn: boolean;
}

/** A use of a function that was not yet defined at the point of the call. */
export interface PendingCall {
  readonly func: number;
  readonly name: string;
  readonly nameSpan: Span;
  readonly argsSpan: Span;
  readonly proto: ProtoRef;
  readonly callPc: number;
  readonly args: PendingArg[];
  asStatement: boolean;
  /** Inside a class body: the call may turn out to be a send to SELF. */
  readonly selfClass: number | undefined;
  resolved: boolean;
}

export interface PendingArg {
  readonly ty: Ty;
  readonly span: Span;
  /** The instruction that loaded this argument and the reference-producing instruction to swap in if it is BYREF. */
  readonly patch: [number, Instr] | undefined;
}

/** A method looked up on a class that was still being defined. */
export interface PendingMethodCheck {
  readonly cls: number;
  readonly name: string;
  readonly span: Span;
}

export type Compat = { readonly k: "same" } | { readonly k: "convert"; readonly ins: Instr } | {
  readonly k: "incompatible";
};

const SAME: Compat = { k: "same" };
const INCOMPATIBLE: Compat = { k: "incompatible" };

export class Compiler {
  readonly lx: Lexer;
  tok: Token;
  ahead: Token | undefined;
  prev: Span = Span.DUMMY;
  panic = false;
  readonly diags = new Diagnostics();

  readonly main = new Proto("<main>", { tag: "main" }, Span.DUMMY);
  readonly funcs: FnEntry[] = [];
  readonly globals: Var[] = [];
  readonly names = new Map<string, Name>();
  readonly shapes: ShapeDef[] = [];
  readonly enums: EnumInfo[] = [];
  readonly inits: Init[] = [{ tag: "uninit" }];
  readonly symbols: string[] = [];
  readonly symbolIds = new Map<string, number>();
  sites = 0;

  readonly fs: FnState[] = [newFnState(MAIN, undefined, undefined)];
  pending: PendingCall[] = [];
  pendingMethods: PendingMethodCheck[] = [];
  /** Terminators of the blocks currently open, innermost last. */
  readonly openBlocks: Kw[] = [];
  /** Interactive mode: bare expressions and assignments report their values through ECHO. */
  repl = false;
  /** An already-parsed leftmost operand for the expression being parsed (see `continueExpr`). */
  seed: Expr | undefined;

  constructor(readonly src: Source) {
    this.lx = new Lexer(src.text);
    this.main.signature = "main program";
    this.tok = { kind: "eof", span: Span.DUMMY, lineStart: true };
    this.advance();
  }

  // -- Tokens ---------------------------------------------------------------

  private lex(): Token {
    const t = this.lx.nextToken();
    const e = this.lx.takeError();
    if (e) this.diags.push(e);
    return t;
  }

  advance(): void {
    this.prev = this.tok.span;
    this.tok = this.ahead ?? this.lex();
    this.ahead = undefined;
  }

  peek(): Token {
    return (this.ahead ??= this.lex());
  }

  at(k: Kind): boolean {
    return this.tok.kind === k;
  }

  eat(k: Kind): boolean {
    if (!this.at(k)) return false;
    this.advance();
    return true;
  }

  text(span: Span): string {
    return this.src.slice(span);
  }

  found(): string {
    return this.tok.kind === "ident" ? `identifier \`${this.text(this.tok.span)}\`` : describe(this.tok.kind);
  }

  /** The keyword the current identifier spells in the wrong case, if any. */
  miscasedKeyword(): Kw | undefined {
    return this.tok.kind === "ident" ? lookupKeyword(this.text(this.tok.span).toUpperCase()) : undefined;
  }

  miscasedKeywordError(kw: Kw): void {
    const span = this.tok.span;
    this.diags.push(
      Diagnostic.error("E0103", "keywords must be written in upper case")
        .primary(span, `this looks like the keyword \`${kw}\``)
        .suggest(span, kw, "write the keyword in capitals"),
    );
  }

  expect(k: Kind, context: string): boolean {
    if (this.eat(k)) return true;
    if (isKeyword(k) && this.miscasedKeyword() === k) {
      this.miscasedKeywordError(k);
      this.advance();
      return true;
    }
    const d = this.expectedError(`\`${k}\``, context);
    if (k === "←" && this.at("=")) {
      d.suggest(this.tok.span, "←", "use `←` (or `<-`) for assignment; `=` compares values");
    } else if ((k === ")" || k === "]") && this.tok.lineStart) {
      d.suggest(this.prev.after(), k, `insert the missing \`${k}\``);
    } else if (k === "THEN" || k === "DO" || k === "OF" || k === "TO") {
      d.suggest(this.prev.after(), ` ${k}`, `add \`${k}\``);
    }
    this.parseError(d);
    return false;
  }

  expectedError(what: string, context: string): Diagnostic {
    const label = this.at("eof") ? `expected ${what}${context ? ` ${context}` : ""}` : `expected ${what}`;
    const d = Diagnostic.error("E0100", `expected ${what}${context ? ` ${context}` : ""}, found ${this.found()}`);
    // Point just past the previous token when a token is missing at the end of a line: that is where to type.
    if (this.tok.lineStart && !this.prev.equals(Span.DUMMY)) {
      d.primary(this.prev.after(), label).secondary(this.tok.span, "unexpected token");
    } else d.primary(this.tok.span, label);
    return d;
  }

  expectIdent(context: string): [string, Span] | undefined {
    if (this.at("ident")) {
      const span = this.tok.span;
      this.advance();
      return [this.text(span), span];
    }
    const d = this.expectedError("an identifier", context);
    if (isKeyword(this.tok.kind)) d.note(`\`${this.tok.kind}\` is a reserved keyword and cannot be used as a name`);
    this.parseError(d);
    return undefined;
  }

  // -- Diagnostics ----------------------------------------------------------

  /** Report a syntax error; further ones are suppressed until the parser re-synchronises. */
  parseError(d: Diagnostic): void {
    // An invalid token was already reported by the lexer.
    if (!this.panic && this.tok.kind !== "error") this.diags.push(d);
    this.panic = true;
  }

  error(d: Diagnostic): void {
    this.diags.push(d);
  }

  /** Skip to something that can start a statement at the start of a line, or a block terminator. */
  synchronize(): void {
    while (!this.at("eof")) {
      const k = this.tok.kind;
      if (isBlockEnd(k) || (startsStatement(k) && this.tok.lineStart)) break;
      if (this.tok.lineStart && k === "ident") break;
      this.advance();
    }
    this.panic = false;
  }

  // -- Emission -------------------------------------------------------------

  get cur(): FnState {
    return this.fs[this.fs.length - 1];
  }

  isMain(f: FnState = this.cur): boolean {
    return f.proto === MAIN;
  }

  protoOf(r: ProtoRef): Proto {
    return r === MAIN ? this.main : this.funcs[r].proto;
  }

  get proto(): Proto {
    return this.protoOf(this.cur.proto);
  }

  emit(ins: Instr, span: Span): number {
    const p = this.proto;
    p.code.push(ins);
    p.spans.push(span);
    return p.code.length - 1;
  }

  get pc(): number {
    return this.proto.code.length;
  }

  /** Point the jump at `at` to the current end of code (or to `target`). */
  patchJump(at: number, target = this.pc): void {
    const ins = this.proto.code[at];
    if (ins.op === Op.ForCheck) ins.d = target;
    else ins.a = target;
  }

  constant(v: Value, span: Span): void {
    if (typeof v === "number") this.emit(instr(Op.PushInt, v), span);
    else if (typeof v === "boolean") this.emit(instr(v ? Op.True : Op.False), span);
    else this.emit(instr(Op.Const, this.addConst(v)), span);
  }

  addConst(v: Value): number {
    return this.proto.consts.push(v) - 1;
  }

  /** REPL: report the value on top of the stack as `name : TYPE = value`. */
  echo(name: string, ty: Ty, span: Span): void {
    this.emit(instr(Op.Echo, this.addConst(name), this.addConst(this.tyName(ty))), span);
  }

  intern(s: string): number {
    let id = this.symbolIds.get(s);
    if (id === undefined) {
      id = this.symbols.push(s) - 1;
      this.symbolIds.set(s, id);
    }
    return id;
  }

  newSite(): number {
    return this.sites++;
  }

  // -- Variables ------------------------------------------------------------

  /** Where a name is already declared in the current scope, if anywhere. */
  existingDecl(name: string): Span | undefined {
    const f = this.cur;
    if (this.isMain(f)) return this.existingDeclGlobal(name);
    return f.locals.find((l) => l.name === name && !l.hidden)?.span ?? f.consts.get(name)?.span;
  }

  existingDeclGlobal(name: string): Span | undefined {
    const n = this.names.get(name);
    if (!n) return undefined;
    switch (n.k) {
      case "var":
        return this.globals[n.g].span;
      case "func":
        return this.funcs[n.f].defined ? this.funcs[n.f].span : undefined;
      default:
        return n.span;
    }
  }

  duplicateError(name: string, span: Span, first: Span): void {
    this.error(
      Diagnostic.error("E0201", `\`${name}\` is declared more than once`)
        .primary(span, `\`${name}\` redeclared here`)
        .secondary(first, `first declaration of \`${name}\``)
        .help("rename one of the declarations, or remove the duplicate"),
    );
  }

  declareVar(name: string, ty: Ty, span: Span): VarLoc {
    const first = this.existingDecl(name);
    if (first) this.duplicateError(name, span, first);
    if (this.isMain()) {
      const v = this.pushGlobal(name, ty, span, false);
      this.names.set(name, { k: "var", g: globalIndex(v) });
      return v;
    }
    const shadowed = this.names.get(name);
    if (shadowed?.k === "var") {
      this.error(
        Diagnostic.warning("W0004", `local \`${name}\` shadows a global variable`)
          .primary(span, "this local declaration...")
          .secondary(this.globals[shadowed.g].span, "...hides this global")
          .help("inside this routine the global cannot be reached; consider renaming"),
      );
    }
    return this.pushLocal(name, ty, span, false, false, false);
  }

  pushGlobal(name: string, ty: Ty, span: Span, hidden: boolean): VarLoc {
    this.globals.push({ name, ty, span, used: hidden, assigned: hidden, byref: false, param: false, hidden });
    return global(this.globals.length - 1);
  }

  pushLocal(name: string, ty: Ty, span: Span, param: boolean, byref: boolean, hidden: boolean): VarLoc {
    const locals = this.cur.locals;
    locals.push({ name, ty, span, used: false, assigned: param, byref, param, hidden });
    return locals.length - 1;
  }

  /** A compiler-generated variable (loop bounds, CASE subjects, ...). */
  hiddenVar(what: string, ty: Ty, span: Span): VarLoc {
    return this.isMain()
      ? this.pushGlobal(`<${what}>`, ty, span, true)
      : this.pushLocal(`<${what}>`, ty, span, false, false, true);
  }

  /** An undefined function slot, filled in when the definition is compiled. */
  newFnSlot(name: string, span: Span): number {
    this.funcs.push({
      kind: "function",
      params: [],
      ret: T.Unknown,
      proto: new Proto(name, { tag: "function" }, span),
      defined: false,
      span,
    });
    return this.funcs.length - 1;
  }

  loadVar(v: VarLoc, span: Span): void {
    this.emit(isGlobal(v) ? instr(Op.LoadGlobal, globalIndex(v)) : instr(Op.LoadLocal, v), span);
  }

  storeVar(v: VarLoc, span: Span): void {
    this.emit(isGlobal(v) ? instr(Op.StoreGlobal, globalIndex(v)) : instr(Op.StoreLocal, v), span);
  }

  findLocal(name: string): VarLoc | undefined {
    const locals = this.cur.locals;
    for (let i = locals.length - 1; i >= 0; i--) if (locals[i].name === name && !locals[i].hidden) return i;
    return undefined;
  }

  /** A local or global variable visible here. */
  lookupVar(name: string): VarLoc | undefined {
    const l = this.findLocal(name);
    if (l !== undefined) return l;
    const n = this.names.get(name);
    return n?.k === "var" ? global(n.g) : undefined;
  }

  var(v: VarLoc): Var {
    return isGlobal(v) ? this.globals[globalIndex(v)] : this.cur.locals[v];
  }

  markVar(v: VarLoc, used: boolean, assigned: boolean): void {
    const x = this.var(v);
    x.used ||= used;
    x.assigned ||= assigned;
  }

  /** Every name visible here, for "did you mean" suggestions. */
  visibleNames(): string[] {
    const f = this.cur;
    const v = f.locals.filter((l) => !l.hidden).map((l) => l.name);
    v.push(...f.consts.keys());
    if (f.cls !== undefined) {
      v.push(...this.shapes[f.cls].fields.map((x) => x.name), ...this.allMethodNames(f.cls));
    }
    v.push(...this.names.keys(), ...BUILTINS.map((b) => b.name));
    return v;
  }

  // -- Types ----------------------------------------------------------------

  tyName(ty: Ty): string {
    switch (ty.k) {
      case "int":
        return "INTEGER";
      case "real":
        return "REAL";
      case "bool":
        return "BOOLEAN";
      case "char":
        return "CHAR";
      case "str":
        return "STRING";
      case "date":
        return "DATE";
      case "array":
        return `ARRAY[${ty.dims.map(([l, h]) => `${l}:${h}`).join(", ")}] OF ${this.tyName(ty.elem)}`;
      case "record":
      case "class":
        return this.shapes[ty.id].name;
      case "enum":
        return this.enums[ty.id].name;
      case "pointer":
        return `^${this.tyName(ty.to)}`;
      case "void":
        return "no value";
      case "unknown":
        return "{unknown}";
      case "error":
        return "{error}";
    }
  }

  isSubclass(c: number, ancestor: number): boolean {
    for (let x: number | undefined = c; x !== undefined; x = this.shapes[x].parent) if (x === ancestor) return true;
    return false;
  }

  compat(target: Ty, src: Ty): Compat {
    if (tyEquals(target, src)) return SAME;
    if (target.k === "error" || src.k === "error" || target.k === "unknown") return SAME;
    if (src.k === "unknown") {
      const c = convOf(target);
      return c === Conv.Any ? SAME : { k: "convert", ins: instr(Op.Check, c) };
    }
    if (target.k === "real" && src.k === "int") return { k: "convert", ins: instr(Op.IntToReal) };
    if (target.k === "str" && src.k === "char") return { k: "convert", ins: instr(Op.Convert, Conv.Str) };
    if (target.k === "class" && src.k === "class" && this.isSubclass(src.id, target.id)) return SAME;
    return INCOMPATIBLE;
  }

  /** Emit the conversion that lets `found` (on top of the stack) flow into an `expected` slot; false on mismatch. */
  convertTop(expected: Ty, found: Ty, span: Span): boolean {
    const c = this.compat(expected, found);
    if (c.k === "convert") this.emit({ ...c.ins }, span);
    return c.k !== "incompatible";
  }

  /** The default-value initializer for a type, if it needs one. */
  initFor(ty: Ty): number | undefined {
    let init: Init;
    if (ty.k === "array") init = { tag: "array", dims: ty.dims, elem: this.initFor(ty.elem) ?? 0 };
    else if (ty.k === "record") init = { tag: "record", shape: ty.id };
    else return undefined;
    return this.inits.push(init) - 1;
  }

  // -- Classes --------------------------------------------------------------

  findMethod(cls: number, name: string): MethodMeta | undefined {
    for (let x: number | undefined = cls; x !== undefined; x = this.shapes[x].parent) {
      const m = this.shapes[x].methods.get(name);
      if (m) return m;
    }
    return undefined;
  }

  allMethodNames(cls: number): string[] {
    const out: string[] = [];
    for (let x: number | undefined = cls; x !== undefined; x = this.shapes[x].parent) {
      out.push(...this.shapes[x].methods.keys());
    }
    return out;
  }

  // -- Finishing ------------------------------------------------------------

  finish(): [Program | undefined, Diagnostics] {
    this.resolvePendingCalls();
    this.warnUnused(this.globals);
    if (this.diags.hasErrors) return [undefined, this.diags];

    const shapes: Shape[] = this.shapes.map((s) => {
      const fieldInits = s.fields.map((f) => this.initFor(f.ty) ?? 0);
      const fields: FieldMeta[] = s.fields.map((f) => ({
        name: f.name,
        sym: this.symbolIds.get(f.name)!,
        private: f.private,
        owner: f.owner,
        ty: this.tyName(f.ty),
      }));
      const methods = new Map<number, MethodMeta>(
        [...s.methods].map(([n, m]) => [this.symbolIds.get(n)!, m]),
      );
      return { name: s.name, isClass: s.isClass, parent: s.parent, fields, fieldInits, methods };
    });
    const globals: GlobalInfo[] = this.globals.map((g) => ({ name: g.name, ty: this.tyName(g.ty), decl: g.span }));
    const program = new Program(
      this.main,
      this.funcs.map((f) => f.proto),
      globals,
      shapes,
      this.enums,
      this.inits,
      this.symbols,
      this.sites,
    );
    return [program, this.diags];
  }

  private resolvePendingCalls(): void {
    for (const call of this.pending.filter((c) => !c.resolved)) {
      const f = this.funcs[call.func];
      if (!f.defined) {
        const d = Diagnostic.error("E0200", `cannot find procedure or function \`${call.name}\``)
          .primary(call.nameSpan, "not defined anywhere in this file");
        const m = bestMatch(call.name, this.visibleNames());
        if (m) d.suggest(call.nameSpan, m, `a routine with a similar name exists: \`${m}\``);
        else {
          d.help(
            `define it with \`PROCEDURE ${call.name}(...)\` ... \`ENDPROCEDURE\` or \`FUNCTION ${call.name}(...) RETURNS ...\``,
          );
        }
        this.error(d);
        continue;
      }
      this.checkDeferredArgs(call, f.params, f.span, f.proto.signature);
      if (f.kind === "procedure" && !call.asStatement) {
        this.error(
          Diagnostic.error("E0302", `procedure \`${call.name}\` does not return a value`)
            .primary(call.nameSpan.to(call.argsSpan), "used as a value here")
            .secondary(f.span, "declared as a PROCEDURE here")
            .help("declare it as a FUNCTION with `RETURNS <type>` to produce a value"),
        );
      }
    }
  }

  /** Check (and patch) the arguments of a call compiled before its callee. */
  checkDeferredArgs(call: PendingCall, params: readonly Param[], decl: Span, sig: string): void {
    if (call.args.length !== params.length) {
      this.arityError(call.name, call.nameSpan.to(call.argsSpan), params.length, call.args.length, decl, sig);
      return;
    }
    call.args.forEach((arg, i) => {
      const p = params[i];
      if (p.byref) {
        if (!arg.patch) return this.byrefValueError(arg.span, p);
        const [pc, ins] = arg.patch;
        this.protoOf(call.proto).code[pc] = ins;
        if (this.compat(p.ty, arg.ty).k !== "same" || this.compat(arg.ty, p.ty).k !== "same") {
          this.byrefTypeError(arg.span, arg.ty, p);
        }
      } else if (this.compat(p.ty, arg.ty).k === "incompatible") {
        this.error(this.mismatch(p.ty, arg.ty, arg.span).secondary(p.span, `parameter \`${p.name}\` declared here`));
      }
    });
  }

  arityError(name: string, span: Span, expected: number, got: number, decl: Span, sig: string): void {
    const d = Diagnostic.error(
      "E0301",
      `\`${name}\` takes ${expected} argument${plural(expected)} but ${got} ${got === 1 ? "was" : "were"} supplied`,
    ).primary(span, `expected ${expected} argument${plural(expected)}`);
    if (!decl.equals(Span.DUMMY)) d.secondary(decl, "defined here");
    this.error(d.note(`signature: ${sig}`));
  }

  byrefValueError(span: Span, p: Param): void {
    this.error(
      Diagnostic.error("E0308", `\`BYREF\` parameter \`${p.name}\` needs a variable`)
        .primary(span, "this is a value, not a variable")
        .secondary(p.span, "parameter declared BYREF here")
        .help("store the value in a variable first and pass that variable")
        .note("a BYREF parameter lets the routine modify the caller's variable"),
    );
  }

  byrefTypeError(span: Span, found: Ty, p: Param): void {
    const e = this.tyName(p.ty), f = this.tyName(found);
    this.error(
      Diagnostic.error("E0300", "mismatched types for `BYREF` argument")
        .primary(span, `expected a variable of type \`${e}\`, found \`${f}\``)
        .secondary(p.span, `\`${p.name}\` is BYREF \`${e}\``)
        .note("BYREF arguments must match the parameter type exactly; no conversion is applied"),
    );
  }

  /** A type-mismatch diagnostic with conversion suggestions. */
  mismatch(expected: Ty, found: Ty, span: Span): Diagnostic {
    const e = this.tyName(expected), f = this.tyName(found);
    const text = this.text(span);
    const d = Diagnostic.error("E0300", "mismatched types").primary(span, `expected \`${e}\`, found \`${f}\``);
    if (expected.k === "str" && isNumeric(found)) {
      d.suggest(span, `NUM_TO_STR(${text})`, "convert the number to a STRING");
    } else if (isNumeric(expected) && isText(found)) {
      d.suggest(span, `STR_TO_NUM(${text})`, "parse the text as a number");
    } else if (expected.k === "int" && found.k === "real") {
      d.suggest(span, `INT(${text})`, "truncate the REAL to an INTEGER")
        .note("REAL values are never converted to INTEGER implicitly, because that loses information");
    } else if (expected.k === "char" && found.k === "str" && [...text].length === 3 && text.startsWith('"')) {
      d.suggest(span, `'${text.slice(1, -1)}'`, "use single quotes for a CHAR literal");
    } else if (expected.k === "bool" && found.k === "int") {
      d.note("INTEGER values are not truth values; compare explicitly, e.g. `X <> 0`");
    } else if (expected.k === "class" && found.k === "class") {
      d.note(`\`${this.shapes[found.id].name}\` does not inherit from \`${this.shapes[expected.id].name}\``);
    }
    return d;
  }

  localInfos(f: FnState): LocalInfo[] {
    return f.locals.map((l, slot) => ({ name: l.name, slot, ty: this.tyName(l.ty), decl: l.span, byref: l.byref }));
  }

  warnUnused(vars: readonly Var[]): void {
    // The interactive mode keeps variables for later inputs, so "unused" is meaningless there.
    if (this.repl) return;
    for (const l of vars) {
      if (l.hidden || l.name.startsWith("_") || l.name === "SELF") continue;
      const what = l.param ? "parameter" : "variable";
      if (!l.used && !(l.assigned && !l.param)) {
        this.error(
          Diagnostic.warning("W0001", `unused ${what} \`${l.name}\``)
            .primary(l.span, `${what} is never used`)
            .help(`if this is intentional, prefix it with an underscore: \`_${l.name}\``),
        );
      } else if (!l.used && !l.byref) {
        this.error(
          Diagnostic.warning("W0001", `${what} \`${l.name}\` is assigned but never read`).primary(
            l.span,
            "declared here",
          ),
        );
      }
    }
  }
}

export function newFnState(proto: ProtoRef, ret: FnState["ret"], cls: number | undefined): FnState {
  return { proto, locals: [], consts: new Map(), loops: [], ret, cls, sawReturn: false };
}
