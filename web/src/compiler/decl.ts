/** Declarations: variables, constants, types, routines and classes. */

import { BUILTINS, lookupBuiltin } from "../core/builtins.ts";
import { Conv, instr, Op, Proto, type ProtoKind } from "../core/bytecode.ts";
import { bestMatch, Diagnostic } from "../core/diag.ts";
import { Span } from "../core/source.ts";
import { Char, DateVal, Real, type Value } from "../core/value.ts";
import { noMemberError } from "./expr.ts";
import { isBlockEnd, type Kind, lookupKeyword } from "./lexer.ts";
import { type Compiler, type FnKind, newFnState, type Param } from "./state.ts";
import { block, closeBlock } from "./stmt.ts";
import { convOf, T, type Ty, tyEquals } from "./types.ts";

/** `A, B, C`: stops at the first missing identifier. */
function identList(c: Compiler, context: string): [string, Span][] {
  const names: [string, Span][] = [];
  for (let n = c.expectIdent(context); n; n = c.eat(",") ? c.expectIdent(context) : undefined) names.push(n);
  return names;
}

/** `A, B : Type`, as used for record and class fields. */
function typedNames(c: Compiler, context: string): [[string, Span][], Ty] {
  const names = identList(c, context);
  if (!names.length) return [names, T.Error];
  c.expect(":", "after the field name");
  return [names, typeSpec(c)];
}

const TYPE_STARTS = new Set<Kind>(["INTEGER", "REAL", "BOOLEAN", "CHAR", "STRING", "DATE", "ARRAY"]);

export function declareStmt(c: Compiler): void {
  const span = c.tok.span;
  c.advance();
  const names = identList(c, "in DECLARE");
  if (!names.length) return;
  if (!c.at(":") && TYPE_STARTS.has(c.tok.kind)) {
    const at = c.prev.after();
    c.error(
      Diagnostic.error("E0100", "expected `:` between the variable name and its type")
        .primary(at, "missing `:`")
        .suggest(at, " :", "add a colon"),
    );
  } else if (!c.expect(":", "after the variable name")) return;
  const ty = typeSpec(c);
  for (const [name, nspan] of names) {
    const v = c.declareVar(name, ty, nspan);
    const init = c.initFor(ty);
    if (init !== undefined) {
      c.emit(instr(Op.Init, init), span);
      c.storeVar(v, span);
    }
  }
}

const PRIMITIVES: Partial<Record<Kind, Ty>> = {
  INTEGER: T.Int,
  REAL: T.Real,
  BOOLEAN: T.Bool,
  CHAR: T.Char,
  STRING: T.Str,
  DATE: T.Date,
};

/** `INTEGER`, `ARRAY[1:10, 1:3] OF REAL`, `^Node`, or a declared type name. */
export function typeSpec(c: Compiler): Ty {
  const span = c.tok.span;
  const prim = PRIMITIVES[c.tok.kind];
  if (prim) {
    c.advance();
    return prim;
  }
  if (c.eat("ARRAY")) return arraySpec(c);
  if (c.eat("^")) return { k: "pointer", to: typeSpec(c) };
  if (c.at("ident")) {
    const name = c.text(span);
    c.advance();
    const n = c.names.get(name);
    if (n?.k === "type") return n.def.k === "alias" ? n.def.ty : { k: n.def.k, id: n.def.id };
    unknownType(c, name, span);
    return T.Error;
  }
  c.parseError(
    c.expectedError("a type", "").help(
      "types are INTEGER, REAL, BOOLEAN, CHAR, STRING, DATE, ARRAY[..] OF <type>, or a declared TYPE/CLASS",
    ),
  );
  return T.Error;
}

/** `[1:10, 1:3] OF REAL`, after ARRAY. */
function arraySpec(c: Compiler): Ty {
  c.expect("[", "after ARRAY");
  const dims: [number, number][] = [];
  do {
    const loSpan = c.tok.span;
    const lo = constInt(c);
    c.expect(":", "between the lower and upper bound");
    const hi = constInt(c);
    if (hi < lo) {
      c.error(
        Diagnostic.error("E0304", "array upper bound is below its lower bound")
          .primary(loSpan.to(c.prev), `${lo}:${hi} contains no elements`)
          .help(`did you mean ${hi}:${lo}?`),
      );
    }
    dims.push([lo, Math.max(hi, lo)]);
  } while (c.eat(","));
  c.expect("]", "to close the array bounds");
  c.expect("OF", "after the array bounds");
  return { k: "array", dims, elem: typeSpec(c) };
}

function unknownType(c: Compiler, name: string, span: Span): void {
  const kw = lookupKeyword(name.toUpperCase());
  if (kw) {
    c.error(
      Diagnostic.error("E0103", `unknown type \`${name}\`; type names are upper case`)
        .primary(span, "not a type")
        .suggest(span, kw, "write the type in capitals"),
    );
    return;
  }
  const types = [...c.names].filter(([, n]) => n.k === "type").map(([k]) => k);
  types.push("INTEGER", "REAL", "BOOLEAN", "CHAR", "STRING", "DATE");
  const d = Diagnostic.error("E0203", `cannot find type \`${name}\``).primary(span, "unknown type");
  const m = bestMatch(name, types);
  if (m) d.suggest(span, m, `a type with a similar name exists: \`${m}\``);
  else d.note("user-defined types must be declared with TYPE or CLASS before they are used");
  const aliases: Record<string, string> = {
    INT: "INTEGER",
    BOOL: "BOOLEAN",
    STR: "STRING",
    FLOAT: "REAL",
    DOUBLE: "REAL",
  };
  if (aliases[name]) d.suggest(span, aliases[name], `pseudocode spells this type \`${aliases[name]}\``);
  c.error(d);
}

/** A compile-time INTEGER: a literal, a negated literal, or a CONSTANT. */
function constInt(c: Compiler): number {
  const neg = c.eat("-");
  const span = c.tok.span;
  let value: number | undefined;
  if (c.at("int")) value = c.tok.value as number;
  else if (c.at("ident")) {
    const name = c.text(span);
    const n = c.names.get(name);
    const v = c.cur.consts.get(name)?.value ?? (n?.k === "const" ? n.value : undefined);
    if (typeof v === "number") value = v;
  }
  if (value === undefined) {
    c.error(
      Diagnostic.error("E0304", "array bounds must be constant INTEGERs")
        .primary(span, "not a constant integer")
        .help("use an integer literal or a name declared with CONSTANT"),
    );
    return 0;
  }
  c.advance();
  return neg ? -value : value;
}

export function constantStmt(c: Compiler): void {
  c.advance();
  const id = c.expectIdent("after CONSTANT");
  if (!id) return;
  const [name, span] = id;
  if (!c.eat("=") && !c.eat("←")) {
    c.parseError(c.expectedError("`=` or `←`", "after the constant name"));
    return;
  }
  const neg = c.eat("-");
  const tok = c.tok;
  let value: Value, ty: Ty;
  if (tok.kind === "int") [value, ty] = [neg ? -(tok.value as number) : (tok.value as number), T.Int];
  else if (tok.kind === "real") [value, ty] = [new Real(neg ? -(tok.value as number) : (tok.value as number)), T.Real];
  else if (!neg && tok.kind === "char") [value, ty] = [new Char(tok.value as string), T.Char];
  else if (!neg && tok.kind === "date") [value, ty] = [new DateVal(tok.value as number), T.Date];
  else if (!neg && (tok.kind === "TRUE" || tok.kind === "FALSE")) [value, ty] = [tok.kind === "TRUE", T.Bool];
  else if (!neg && tok.kind === "str") [value, ty] = [tok.value as string, T.Str];
  else {
    c.parseError(
      c.expectedError("a literal value", "for the constant")
        .note("a CONSTANT must be given a literal such as 10, 3.5, \"text\", 'c' or TRUE"),
    );
    return;
  }
  c.advance();
  const first = c.existingDecl(name);
  if (first) c.duplicateError(name, span, first);
  if (c.isMain()) c.names.set(name, { k: "const", value, ty, span });
  else c.cur.consts.set(name, { value, ty, span });
}

/** `TYPE T = (A, B)`, `TYPE P = ^INTEGER`, or a record `TYPE T ... ENDTYPE`. */
export function typeStmt(c: Compiler): void {
  const typeSpan = c.tok.span;
  c.advance();
  const id = c.expectIdent("after TYPE");
  if (!id) return;
  const [name, span] = id;
  const first = c.existingDeclGlobal(name);
  if (first) c.duplicateError(name, span, first);
  if (c.eat("=")) {
    if (c.eat("(")) {
      const enumId = c.enums.length;
      const variants: string[] = [];
      do {
        const v = c.expectIdent("in the enumeration");
        if (!v) return;
        const prior = c.existingDeclGlobal(v[0]);
        if (prior) c.duplicateError(v[0], v[1], prior);
        c.names.set(v[0], { k: "variant", ty: enumId, ord: variants.length, span: v[1] });
        variants.push(v[0]);
      } while (c.eat(","));
      c.expect(")", "to close the enumeration");
      c.enums.push({ name, variants });
      c.names.set(name, { k: "type", def: { k: "enum", id: enumId }, span });
    } else c.names.set(name, { k: "type", def: { k: "alias", ty: typeSpec(c) }, span });
    return;
  }

  // Record type. Registered first so fields may point to it (`^Node`).
  c.openBlocks.push("ENDTYPE");
  const shape = newShape(c, name, span, false, undefined);
  while (!c.at("eof") && !isBlockEnd(c.tok.kind)) {
    if (!c.eat("DECLARE")) {
      c.parseError(
        c.expectedError("`DECLARE`", "inside a record TYPE").help("record fields are written `DECLARE Name : Type`"),
      );
      c.synchronize();
      if (!c.at("DECLARE")) break;
      continue;
    }
    const [names, ty] = typedNames(c, "in DECLARE");
    for (const [fname, fspan] of names) addField(c, shape, fname, ty, false, fspan);
    if (c.panic) c.synchronize();
  }
  closeBlock(c, "ENDTYPE", "TYPE", typeSpan);
  c.shapes[shape].complete = true;
}

/** Register a record type or class; a class inherits its parent's field layout. */
function newShape(c: Compiler, name: string, span: Span, isClass: boolean, parent: number | undefined): number {
  const id = c.shapes.length;
  c.names.set(name, { k: "type", def: { k: isClass ? "class" : "record", id }, span });
  const fields = parent === undefined ? [] : [...c.shapes[parent].fields];
  c.shapes.push({ name, span, isClass, parent, fields, methods: new Map(), complete: false });
  return id;
}

function addField(c: Compiler, shape: number, name: string, ty: Ty, priv: boolean, span: Span): void {
  const prev = c.shapes[shape].fields.find((f) => f.name === name);
  if (prev) {
    const d = Diagnostic.error("E0201", `field \`${name}\` is declared more than once`)
      .primary(span, "redeclared here")
      .secondary(prev.span, "first declared here");
    if (prev.owner !== shape) d.note(`\`${name}\` is inherited from \`${c.shapes[prev.owner].name}\``);
    c.error(d);
    return;
  }
  c.intern(name);
  c.shapes[shape].fields.push({ name, ty, private: priv, owner: shape, span });
}

// ---------------------------------------------------------------------------
// Procedures, functions and methods
// ---------------------------------------------------------------------------

/** PROCEDURE/FUNCTION definition; `cls` is `[class, private]` for methods. */
export function routineDef(c: Compiler, cls: [number, boolean] | undefined): void {
  const kwSpan = c.tok.span;
  const isFn = c.at("FUNCTION");
  const kw = isFn ? "FUNCTION" : "PROCEDURE";
  const endKw = isFn ? "ENDFUNCTION" : "ENDPROCEDURE";
  c.advance();
  if (c.fs.length > 1) {
    c.error(
      Diagnostic.error("E0100", `a ${kw} cannot be defined inside another routine`)
        .primary(kwSpan, "nested definition")
        .secondary(c.funcs[c.cur.proto].span, "inside this routine")
        .help("move the definition to the top level of the file"),
    );
  }
  let id: [string, Span] | undefined;
  if (cls && c.at("NEW")) {
    id = ["NEW", c.tok.span];
    c.advance();
  } else id = c.expectIdent(`after ${kw}`);
  if (!id) return;
  const [name, nameSpan] = id;

  const params: Param[] = [];
  if (c.eat("(") && !c.eat(")")) {
    let byref = false;
    do {
      if (c.eat("BYREF")) byref = true;
      else if (c.eat("BYVAL")) byref = false;
      const p = c.expectIdent("for the parameter name");
      if (!p) break;
      const prev = params.find((x) => x.name === p[0]);
      if (prev) c.duplicateError(p[0], p[1], prev.span);
      c.expect(":", "after the parameter name");
      params.push({ name: p[0], ty: typeSpec(c), byref, span: p[1] });
    } while (c.eat(","));
    c.expect(")", "to close the parameter list");
  }

  let ret: Ty = T.Void, retSpan = nameSpan;
  if (isFn) {
    if (c.expect("RETURNS", "after the FUNCTION parameters")) {
      const s = c.tok.span;
      ret = typeSpec(c);
      retSpan = s.to(c.prev);
    } else ret = T.Error;
  } else if (c.at("RETURNS")) {
    c.error(
      Diagnostic.error("E0206", "a PROCEDURE cannot have a return type")
        .primary(c.tok.span, "RETURNS is only for FUNCTIONs")
        .suggest(kwSpan, "FUNCTION", "declare it as a FUNCTION"),
    );
    c.advance();
    typeSpec(c);
  }

  c.openBlocks.push(endKw);
  const kind: FnKind = isFn ? "function" : "procedure";
  const func = registerRoutine(c, name, nameSpan, cls, kind, params, ret);
  const [pkind, display]: [ProtoKind, string] = cls
    ? [{ tag: "method", cls: cls[0] }, `${c.shapes[cls[0]].name}.${name}`]
    : [{ tag: kind }, name];
  const proto = new Proto(display, pkind, nameSpan);
  proto.arity = params.length + (cls ? 1 : 0);
  proto.signature = signature(c, kw, cls?.[0], name, params, ret);
  c.funcs[func] = { kind, params, ret, proto, defined: true, span: nameSpan };

  c.fs.push(newFnState(func, isFn ? { ty: ret, span: retSpan } : undefined, cls?.[0]));
  if (cls) c.pushLocal("SELF", { k: "class", id: cls[0] }, kwSpan, true, false, true);
  for (const p of params) {
    const slot = c.pushLocal(p.name, p.ty, p.span, true, p.byref, false);
    const conv = convOf(p.ty);
    if (!p.byref && (conv === Conv.Real || conv === Conv.Str)) c.emit(instr(Op.Coerce, slot, conv), p.span);
  }

  const diverges = block(c, false);
  const endSpan = c.tok.span;
  if ((c.at("ENDFUNCTION") || c.at("ENDPROCEDURE")) && !c.at(endKw)) {
    c.error(
      Diagnostic.error("E0102", `a ${kw} must end with \`${endKw}\``)
        .primary(endSpan, `expected \`${endKw}\``)
        .secondary(kwSpan, `${kw} starts here`)
        .suggest(endSpan, endKw, "use the matching terminator"),
    );
    c.advance();
    c.openBlocks.pop();
  } else closeBlock(c, endKw, kw, kwSpan);

  if (isFn && !diverges) {
    if (!c.cur.sawReturn) {
      const tn = c.tyName(ret);
      c.error(
        Diagnostic.error("E0207", `FUNCTION \`${name}\` never returns a value`)
          .primary(nameSpan, `declared to return \`${tn}\``)
          .secondary(endSpan, "reaches the end without a RETURN")
          .help(`add \`RETURN <${tn} value>\` before ${endKw}`),
      );
    } else {
      c.error(
        Diagnostic.warning("W0007", `FUNCTION \`${name}\` may reach \`ENDFUNCTION\` without returning`)
          .primary(endSpan, "control can fall through to here")
          .secondary(nameSpan, "in this function")
          .note("if that happens the program stops with a run-time error"),
      );
    }
    c.emit(instr(Op.MissingReturn), endSpan);
  } else if (!isFn) c.emit(instr(Op.ReturnVoid), endSpan);

  const f = c.fs.pop()!;
  proto.numSlots = f.locals.length;
  proto.locals = c.localInfos(f);
  c.warnUnused(f.locals);
}

function signature(c: Compiler, kw: string, cls: number | undefined, name: string, params: Param[], ret: Ty): string {
  const ps = params.map((p) => `${p.byref ? "BYREF " : ""}${p.name} : ${c.tyName(p.ty)}`).join(", ");
  const owner = cls === undefined ? "" : `${c.shapes[cls].name}.`;
  return `${kw} ${owner}${name}(${ps})${ret.k === "void" ? "" : ` RETURNS ${c.tyName(ret)}`}`;
}

/** Allocate (or reuse a forward-declared) function slot for a definition. */
function registerRoutine(
  c: Compiler,
  name: string,
  span: Span,
  cls: [number, boolean] | undefined,
  kind: FnKind,
  params: Param[],
  ret: Ty,
): number {
  if (!cls) {
    const n = c.names.get(name);
    if (n?.k === "func" && !c.funcs[n.f].defined) return n.f;
    const first = c.existingDeclGlobal(name);
    const b = lookupBuiltin(name);
    if (first) c.duplicateError(name, span, first);
    else if (b !== undefined) {
      c.error(
        Diagnostic.warning("W0004", `\`${name}\` shadows the built-in function \`${BUILTINS[b].name}\``)
          .primary(span, "this definition replaces the built-in")
          .note(`built-in: ${BUILTINS[b].doc}`),
      );
    }
    const f = c.newFnSlot(name, span);
    c.names.set(name, { k: "func", f });
    return f;
  }
  const [id, priv] = cls;
  const prev = c.shapes[id].methods.get(name);
  if (prev) c.duplicateError(name, span, c.funcs[prev.func].span);
  const parent = c.shapes[id].parent;
  const inherited = parent === undefined ? undefined : c.findMethod(parent, name);
  if (inherited && name !== "NEW") {
    const pf = c.funcs[inherited.func];
    const same = pf.kind === kind && tyEquals(pf.ret, ret) && pf.params.length === params.length &&
      pf.params.every((a, i) => tyEquals(a.ty, params[i].ty) && a.byref === params[i].byref);
    if (!same) {
      c.error(
        Diagnostic.error("E0400", `method \`${name}\` overrides an inherited method with a different signature`)
          .primary(span, "incompatible override")
          .secondary(pf.span, "overridden method declared here")
          .note(`expected: ${pf.proto.signature}`)
          .help("an override must take the same parameters and return the same type"),
      );
    }
  }
  const f = c.newFnSlot(name, span);
  c.shapes[id].methods.set(name, { func: f, private: priv, owner: id });
  c.intern(name);
  return f;
}

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

export function classDef(c: Compiler): void {
  const classSpan = c.tok.span;
  c.advance();
  const id = c.expectIdent("after CLASS");
  if (!id) return;
  const [name, nameSpan] = id;
  if (c.fs.length > 1) {
    c.error(
      Diagnostic.error("E0100", "a CLASS cannot be defined inside a routine").primary(
        classSpan,
        "nested class definition",
      ),
    );
  }
  let parent: number | undefined;
  if (c.eat("INHERITS")) {
    const p = c.expectIdent("after INHERITS");
    if (p) parent = lookupParent(c, ...p);
  }
  const first = c.existingDeclGlobal(name);
  if (first) c.duplicateError(name, nameSpan, first);

  const cls = newShape(c, name, nameSpan, true, parent);
  c.openBlocks.push("ENDCLASS");
  for (;;) {
    const start = c.tok.span;
    const k = c.tok.kind;
    if (k === "eof" || isBlockEnd(k)) break;
    if (k === "PUBLIC" || k === "PRIVATE") {
      c.advance();
      if (c.at("PROCEDURE") || c.at("FUNCTION")) routineDef(c, [cls, k === "PRIVATE"]);
      else fieldDecl(c, cls, k === "PRIVATE");
    } else if (k === "PROCEDURE" || k === "FUNCTION") routineDef(c, [cls, false]);
    else if (k === "DECLARE") {
      c.error(
        Diagnostic.error("E0100", "class fields are declared with PUBLIC or PRIVATE")
          .primary(start, "DECLARE is not used inside a CLASS")
          .suggest(start, "PRIVATE", "declare a private field"),
      );
      c.advance();
      fieldDecl(c, cls, true);
    } else if (k === "ident" && c.peek().kind === ":") {
      c.error(
        Diagnostic.error("E0100", "class field without an access modifier")
          .primary(start, "missing PUBLIC or PRIVATE")
          .suggest(new Span(start.start, start.start), "PRIVATE ", "make the field private")
          .note("every class member must be marked PUBLIC or PRIVATE"),
      );
      fieldDecl(c, cls, true);
    } else {
      c.parseError(
        c.expectedError("a class member", "").help(
          "class bodies contain `PUBLIC`/`PRIVATE` fields, PROCEDUREs and FUNCTIONs",
        ),
      );
    }
    if (c.panic) {
      c.synchronize();
      while (isBlockEnd(c.tok.kind) && !c.at("ENDCLASS")) {
        c.advance();
      }
    }
    if (c.tok.span.equals(start) && !c.at("eof")) c.advance();
  }
  closeBlock(c, "ENDCLASS", "CLASS", classSpan);
  c.shapes[cls].complete = true;
  resolveClassPending(c, cls);
}

function lookupParent(c: Compiler, pname: string, pspan: Span): number | undefined {
  const n = c.names.get(pname);
  if (n?.k === "type" && n.def.k === "class") return n.def.id;
  if (n?.k === "type") {
    c.error(
      Diagnostic.error("E0400", `\`${pname}\` is not a class`).primary(pspan, "only classes can be inherited from"),
    );
    return undefined;
  }
  const d = Diagnostic.error("E0400", `cannot find superclass \`${pname}\``).primary(pspan, "not a known class");
  const m = bestMatch(pname, c.shapes.filter((s) => s.isClass).map((s) => s.name));
  if (m) d.suggest(pspan, m, "a class with a similar name exists");
  else d.note("a superclass must be defined before the classes that inherit from it");
  c.error(d);
  return undefined;
}

function fieldDecl(c: Compiler, cls: number, priv: boolean): void {
  const [names, ty] = typedNames(c, "for the field name");
  for (const [n, s] of names) addField(c, cls, n, ty, priv, s);
}

/** At ENDCLASS: calls in the class body to names not yet known may be sends to SELF; patch them now. */
function resolveClassPending(c: Compiler, cls: number): void {
  for (const call of c.pending.filter((p) => !p.resolved && p.selfClass === cls)) {
    const m = c.findMethod(cls, call.name);
    if (!m) continue;
    const f = c.funcs[m.func];
    c.protoOf(call.proto).code[call.callPc] = instr(Op.SendSelf, c.intern(call.name), call.args.length, c.newSite());
    c.checkDeferredArgs(call, f.params, f.span, f.proto.signature);
    if (f.kind === "procedure" && !call.asStatement) {
      c.error(
        Diagnostic.error("E0302", `procedure \`${call.name}\` does not return a value`)
          .primary(call.nameSpan, "used as a value here")
          .secondary(f.span, "declared as a PROCEDURE here"),
      );
    }
    call.resolved = true;
  }
  const now = c.pendingMethods.filter((p) => p.cls === cls);
  c.pendingMethods = c.pendingMethods.filter((p) => p.cls !== cls);
  for (const p of now) {
    if (!c.findMethod(cls, p.name)) noMemberError(c, cls, p.name, p.span, c.shapes[cls].span, "method");
  }
}
