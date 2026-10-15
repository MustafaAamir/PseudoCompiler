/**
 * Bytecode, function prototypes, runtime metadata and the disassembler.
 *
 * Every instruction carries a source span, and every prototype keeps a table
 * of its locals, so the VM can map any failure back to source.
 */

import { BUILTINS } from "./builtins.ts";
import { type Source, Span } from "./source.ts";
import { Char, DateVal, EnumVal, formatDate, formatReal, Real, typeName, type Value } from "./value.ts";

/** Conversion target (`INTEGER(x)`, `INPUT`, parameter coercion, run-time checks). */
export enum Conv {
  Int,
  Real,
  Bool,
  Char,
  Str,
  Date,
  Any,
}

export enum FileMode {
  Read,
  Write,
  Append,
  Random,
}

export enum Op {
  Nop,
  /** a: constant index */
  Const,
  /** a: integer value */
  PushInt,
  True,
  False,
  Pop,
  /** Push a fresh default value built from `Program.inits[a]`. */
  Init,
  /** Deep-copy the aggregate on top (records/arrays have value semantics). */
  Copy,

  LoadLocal,
  StoreLocal,
  LoadGlobal,
  StoreGlobal,
  /** Store through the reference held in local `a` (a BYREF parameter). */
  StoreLocalDeref,
  RefLocal,
  RefGlobal,
  Deref,
  /** `[ref, value] -> []` */
  StoreDeref,

  LoadSelf,
  LoadSelfField,
  StoreSelfField,
  RefSelfField,
  /** `[obj] -> [value]` with statically known slot `a`. */
  GetField,
  /** `[obj, value] -> []` */
  SetField,
  FieldRef,
  /** Field access on a receiver of unknown type, resolved by name (a: symbol, b: cache site). */
  GetFieldNamed,
  SetFieldNamed,
  FieldRefNamed,
  /** `[array, i1..ia] -> [value]` */
  Index,
  /** `[array, i1..ia, value] -> []` */
  StoreIndex,
  IndexRef,

  Add,
  Sub,
  Mul,
  Div,
  IntDiv,
  Mod,
  Neg,
  Concat,
  Eq,
  Ne,
  Lt,
  Le,
  Gt,
  Ge,
  Not,
  IntToReal,
  /** a: Conv */
  Convert,
  /** Run-time type check where a statically unknown value meets a typed slot (a: Conv). */
  Check,
  /** Prologue coercion of parameter slot `a` to Conv `b`. */
  Coerce,

  /** a: target */
  Jump,
  JumpIfFalse,
  /** Short-circuit AND: jump keeping the value if false, otherwise pop. */
  JumpIfFalseOrPop,
  /** Short-circuit OR: jump keeping the value if true, otherwise pop. */
  JumpIfTrueOrPop,
  /** Fused FOR test (a: var, b: end, c: step, d: exit target). */
  ForCheck,
  /** Fused FOR increment and back edge (a: var, b: step, c: back target). */
  ForStep,

  /** Call `functions[a]` with `b` stack slots (including SELF for methods). */
  Call,
  /** a: builtin index, b: argc */
  CallBuiltin,
  /** Message send through an inline cache (a: selector, b: argc, c: site): `[recv, args..] -> [result]`. */
  Send,
  /** Send to SELF, which is not on the stack. */
  SendSelf,
  /** Allocate class `a`, run constructor `b` (-1 = none) with `c` arguments. */
  Construct,
  Return,
  ReturnVoid,
  /** Reached the end of a FUNCTION without RETURN. */
  MissingReturn,

  /** a: value count */
  Output,
  /** a: Conv */
  Input,
  /** a: FileMode */
  OpenFile,
  ReadFile,
  WriteFile,
  CloseFile,
  Seek,
  GetRecord,
  PutRecord,
  /** REPL only: report the top of stack (a: name constant, b: type-name constant). */
  Echo,
  Halt,
}

export interface Instr {
  op: Op;
  a: number;
  b: number;
  c: number;
  d: number;
}

export function instr(op: Op, a = 0, b = 0, c = 0, d = 0): Instr {
  return { op, a, b, c, d };
}

/** A variable location packed in one number: locals are slots `>= 0`, globals are `-(index + 1)`. */
export type VarLoc = number;
export const local = (slot: number): VarLoc => slot;
export const global = (index: number): VarLoc => -(index + 1);
export const isGlobal = (v: VarLoc): boolean => v < 0;
export const globalIndex = (v: VarLoc): number => -v - 1;

export type ProtoKind =
  | { readonly tag: "main" }
  | { readonly tag: "function" }
  | { readonly tag: "procedure" }
  | { readonly tag: "method"; readonly cls: number };

export interface LocalInfo {
  readonly name: string;
  readonly slot: number;
  readonly ty: string;
  readonly decl: Span;
  readonly byref: boolean;
}

/** A compiled function, procedure, method or the main program. */
export class Proto {
  /** Number of argument slots, including SELF for methods. */
  arity = 0;
  numSlots = 0;
  readonly code: Instr[] = [];
  readonly spans: Span[] = [];
  readonly consts: Value[] = [];
  locals: LocalInfo[] = [];
  signature = "";

  constructor(public name: string, public kind: ProtoKind, public decl: Span) {}

  localName(slot: number): LocalInfo | undefined {
    return this.locals.find((l) => l.slot === slot);
  }
}

export interface GlobalInfo {
  readonly name: string;
  readonly ty: string;
  readonly decl: Span;
}

export interface FieldMeta {
  readonly name: string;
  readonly sym: number;
  readonly private: boolean;
  /** Shape that declared the field (differs from the holder for inherited fields). */
  readonly owner: number;
  readonly ty: string;
}

export interface MethodMeta {
  readonly func: number;
  readonly private: boolean;
  readonly owner: number;
}

/**
 * Fixed slot layout of a record type or class ("hidden class"/"map"). A
 * subclass layout extends its parent's, so inherited slots are stable.
 */
export interface Shape {
  readonly name: string;
  readonly isClass: boolean;
  readonly parent: number | undefined;
  readonly fields: readonly FieldMeta[];
  readonly fieldInits: readonly number[];
  /** Method dictionary (selector -> method) for methods defined directly in this class. */
  readonly methods: ReadonlyMap<number, MethodMeta>;
}

export type Init =
  | { readonly tag: "uninit" }
  | { readonly tag: "array"; readonly dims: readonly (readonly [number, number])[]; readonly elem: number }
  | { readonly tag: "record"; readonly shape: number };

export interface EnumInfo {
  readonly name: string;
  readonly variants: readonly string[];
}

export class Program {
  constructor(
    readonly main: Proto,
    readonly functions: readonly Proto[],
    readonly globals: readonly GlobalInfo[],
    readonly shapes: readonly Shape[],
    readonly enums: readonly EnumInfo[],
    readonly inits: readonly Init[],
    readonly symbols: readonly string[],
    readonly numSites: number,
  ) {}

  describeConst(v: Value): string {
    if (typeof v === "string") return JSON.stringify(v);
    if (typeof v === "number") return String(v);
    if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
    if (v instanceof Char) return `'${v.c}'`;
    if (v instanceof Real) return formatReal(v.v);
    if (v instanceof DateVal) return formatDate(v.days);
    if (v instanceof EnumVal) return this.enums[v.ty].variants[v.ord];
    return typeName(v);
  }

  disassemble(src: Source): string {
    const out: string[] = [`; program \`${src.name}\``];
    out.push(
      `; ${this.functions.length} functions, ${this.globals.length} globals, ${this.shapes.length} shapes, ` +
        `${this.symbols.length} selectors, ${this.numSites} inline-cache sites`,
      "",
    );
    if (this.globals.length) {
      out.push("globals:");
      this.globals.forEach((g, i) => {
        const [l, c] = src.lineCol(g.decl.start);
        out.push(`  ${`g${i}`.padEnd(5)} ${g.name.padEnd(20)} : ${g.ty.padEnd(24)} ; declared ${l}:${c}`);
      });
      out.push("");
    }
    this.shapes.forEach((s, i) => {
      const parent = s.parent === undefined ? "" : ` inherits ${this.shapes[s.parent].name}`;
      out.push(`shape #${i} ${s.isClass ? "class" : "record"} ${s.name}${parent}`);
      s.fields.forEach((f, slot) => out.push(`  [${slot}] ${f.private ? "PRIVATE" : "PUBLIC "} ${f.name} : ${f.ty}`));
      const methods = [...s.methods].sort(([a], [b]) => this.symbols[a].localeCompare(this.symbols[b]));
      for (const [sym, m] of methods) {
        out.push(`  #${this.symbols[sym]} ${m.private ? "PRIVATE" : "PUBLIC "} -> fn${m.func}`);
      }
      out.push("");
    });
    this.disassembleProto(out, src, this.main, undefined);
    this.functions.forEach((f, i) => this.disassembleProto(out, src, f, i));
    return out.join("\n");
  }

  private disassembleProto(out: string[], src: Source, p: Proto, index: number | undefined): void {
    out.push(`${index === undefined ? "main" : `fn${index}`}: ${p.signature}  ; ${p.numSlots} slots, arity ${p.arity}`);
    for (const l of p.locals) {
      const [line, col] = src.lineCol(l.decl.start);
      out.push(`  ; local %${l.slot} ${l.name}${l.byref ? " BYREF" : ""} : ${l.ty}  (declared ${line}:${col})`);
    }
    let lastLine = -1;
    p.code.forEach((ins, pc) => {
      const span = p.spans[pc];
      const [line, col] = src.lineCol(span.start);
      if (line !== lastLine && !span.equals(Span.DUMMY)) {
        out.push(`  ;; ${String(line).padStart(4)} | ${src.lineText(line - 1).trim()}`);
        lastLine = line;
      }
      out.push(`  ${String(pc).padStart(5, "0")}  ${this.describeOp(p, ins).padEnd(44)} ; ${line}:${col}`);
    });
    out.push("");
  }

  varName(p: Proto, v: VarLoc): string {
    if (isGlobal(v)) return `g${globalIndex(v)}(${this.globals[globalIndex(v)].name})`;
    const l = p.localName(v);
    return l ? `%${v}(${l.name})` : `%${v}`;
  }

  describeOp(p: Proto, ins: Instr): string {
    const { a, b, c, d } = ins;
    const sym = (s: number) => this.symbols[s];
    let operands: string;
    switch (ins.op) {
      case Op.Const:
        operands = this.describeConst(p.consts[a]);
        break;
      case Op.PushInt:
      case Op.Index:
      case Op.StoreIndex:
      case Op.IndexRef:
      case Op.Output:
        operands = String(a);
        break;
      case Op.Init:
        operands = this.describeInit(a);
        break;
      case Op.LoadLocal:
      case Op.StoreLocal:
      case Op.StoreLocalDeref:
      case Op.RefLocal:
        operands = this.varName(p, a);
        break;
      case Op.LoadGlobal:
      case Op.StoreGlobal:
      case Op.RefGlobal:
        operands = this.varName(p, global(a));
        break;
      case Op.GetFieldNamed:
      case Op.SetFieldNamed:
      case Op.FieldRefNamed:
        operands = `.${sym(a)} @ic${b}`;
        break;
      case Op.GetField:
      case Op.SetField:
      case Op.FieldRef:
      case Op.LoadSelfField:
      case Op.StoreSelfField:
      case Op.RefSelfField:
        operands = `[${a}]`;
        break;
      case Op.Convert:
      case Op.Check:
      case Op.Input:
      case Op.ReadFile:
        operands = Conv[a];
        break;
      case Op.Coerce:
        operands = `${this.varName(p, a)} -> ${Conv[b]}`;
        break;
      case Op.OpenFile:
        operands = FileMode[a];
        break;
      case Op.ForCheck:
        operands = `${this.varName(p, a)} to ${this.varName(p, b)} step ${this.varName(p, c)} else ->${d}`;
        break;
      case Op.ForStep:
        operands = `${this.varName(p, a)} += ${this.varName(p, b)} ->${c}`;
        break;
      case Op.Jump:
      case Op.JumpIfFalse:
      case Op.JumpIfFalseOrPop:
      case Op.JumpIfTrueOrPop:
        operands = `->${a}`;
        break;
      case Op.Call:
        operands = `fn${a}(${this.functions[a]?.name ?? "?"}) argc=${b}`;
        break;
      case Op.CallBuiltin:
        operands = `${BUILTINS[a].name} argc=${b}`;
        break;
      case Op.Send:
      case Op.SendSelf:
        operands = `#${sym(a)} argc=${b} @ic${c}`;
        break;
      case Op.Construct:
        operands = `${this.shapes[a].name} ctor=${b < 0 ? "none" : `fn${b}`} argc=${c}`;
        break;
      case Op.Echo:
        operands = `${this.describeConst(p.consts[a])} : ${this.describeConst(p.consts[b])}`;
        break;
      default:
        operands = "";
    }
    const mnemonic = Op[ins.op].replace(/(?<=.)([A-Z])/g, "_$1").toUpperCase();
    return operands ? `${mnemonic} ${operands}` : mnemonic;
  }

  private describeInit(i: number): string {
    const init = this.inits[i];
    switch (init.tag) {
      case "uninit":
        return "uninit";
      case "record":
        return `record ${this.shapes[init.shape].name}`;
      case "array":
        return `array[${init.dims.map(([l, h]) => `${l}:${h}`).join(",")}] of ${this.describeInit(init.elem)}`;
    }
  }
}
