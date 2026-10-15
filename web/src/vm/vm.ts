/**
 * A stack-based bytecode VM with Smalltalk-style message dispatch:
 *
 * - objects have fixed slot layouts (shapes), so field access compiled
 *   against a known class is a single indexed load;
 * - every send site owns an inline cache that goes from empty to
 *   monomorphic to polymorphic (up to 4 receiver classes) to megamorphic;
 * - megamorphic sites and cache misses go through a global
 *   `(class, selector) -> method` cache before walking the method
 *   dictionaries up the superclass chain.
 *
 * The VM is resumable: {@link Vm.run} executes up to a budget of
 * instructions and reports whether it halted, needs a line of input, or is
 * yielding so the host (a browser tab) stays responsive.
 */

import { Conv, type FileMode, type Instr, type MethodMeta, Op, type Program, type Proto } from "../core/bytecode.ts";
import { bestMatch } from "../core/diag.ts";
import { Span } from "../core/source.ts";
import {
  ArrayObj,
  Char,
  DateVal,
  daysFromCivil,
  deepCopy,
  EnumVal,
  formatDate,
  formatReal,
  Obj,
  Real,
  type Ref,
  RefVal,
  typeName,
  UNINIT,
  type Value,
  VOID,
} from "../core/value.ts";
import { Fault, RuntimeError, type TraceFrame } from "./fault.ts";
import { FileTable, VirtualFs } from "./files.ts";
import { callBuiltin } from "./natives.ts";

const POLY_MAX = 4;
const GLOBAL_CACHE_SIZE = 512;
const MAX_FRAMES = 10_000;

type InlineCache =
  | undefined
  | { readonly k: "mono"; readonly cls: number; readonly target: MethodMeta }
  | { readonly k: "poly"; readonly entries: [number, MethodMeta][] }
  | { readonly k: "mega" };

interface Frame {
  proto: Proto;
  ip: number;
  base: number;
  ctor: boolean;
}

/** A value reported by the REPL's ECHO instruction. */
export interface Echo {
  readonly name: string;
  readonly ty: string;
  readonly value: string;
}

export type Step = { readonly tag: "halt" } | { readonly tag: "input" } | { readonly tag: "yield" };

export interface Stats {
  instructions: number;
  calls: number;
  sends: number;
  monoHits: number;
  polyHits: number;
  megaLookups: number;
  globalCacheHits: number;
  fullLookups: number;
  maxDepth: number;
}

export interface SendSite {
  readonly site: number;
  readonly state: "monomorphic" | "polymorphic" | "megamorphic";
  readonly classes: readonly string[];
}

export interface VmHost {
  readonly fs?: VirtualFs;
  /** Uniform random number in [0, 1); defaults to a xorshift generator seeded from `seed`. */
  readonly random?: () => number;
  readonly seed?: number;
  /** Today's date as days since 1970-01-01. */
  readonly today?: () => number;
  /** Called for every instruction executed (debug tracing). */
  readonly trace?: (line: string) => void;
}

function xorshift(seed: number): () => number {
  let s = (seed | 0) || 0x2545f491;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x1_0000_0000;
  };
}

export class Vm {
  private stack: Value[] = [];
  private frames: Frame[] = [];
  private globals: Value[] = [];
  private caches: InlineCache[] = [];
  private fieldCaches: ({ shape: number; slot: number } | undefined)[] = [];
  private readonly globalCache: ([number, number, MethodMeta] | undefined)[] = new Array(GLOBAL_CACHE_SIZE);
  private pendingInput: Conv | undefined;
  private output: string[] = [];
  private echoes: Echo[] = [];
  readonly files: FileTable;
  readonly fs: VirtualFs;
  readonly random: () => number;
  readonly today: () => number;
  readonly stats: Stats = {
    instructions: 0,
    calls: 0,
    sends: 0,
    monoHits: 0,
    polyHits: 0,
    megaLookups: 0,
    globalCacheHits: 0,
    fullLookups: 0,
    maxDepth: 0,
  };

  constructor(public program: Program, private readonly host: VmHost = {}) {
    this.fs = host.fs ?? new VirtualFs();
    this.files = new FileTable(this.fs);
    this.random = host.random ?? xorshift(host.seed ?? Date.now());
    this.today = host.today ?? (() => Math.floor(Date.now() / 86_400_000));
    this.start(program, 0);
  }

  /**
   * Begin executing `program`'s main code at instruction `from`, keeping
   * globals and inline caches. `program` must extend the previous one: the
   * REPL recompiles the whole session, and the compiler is deterministic, so
   * earlier code, globals, functions and send sites keep their indices.
   */
  start(program: Program, from: number): void {
    this.program = program;
    while (this.globals.length < program.globals.length) this.globals.push(UNINIT);
    this.caches.length = program.numSites;
    this.fieldCaches.length = program.numSites;
    this.stack = [];
    for (let i = 0; i < program.main.numSlots; i++) this.stack.push(UNINIT);
    this.frames = [{ proto: program.main, ip: from, base: 0, ctor: false }];
    this.pendingInput = undefined;
  }

  /** Lines written by OUTPUT since the last call. */
  takeOutput(): string[] {
    const out = this.output;
    this.output = [];
    return out;
  }

  /** Results of ECHO instructions since the last call. */
  takeEchoes(): Echo[] {
    const e = this.echoes;
    this.echoes = [];
    return e;
  }

  /** The type INPUT is waiting for, if the program is suspended on INPUT. */
  get awaitingInput(): Conv | undefined {
    return this.pendingInput;
  }

  /** Name, type and current value of every user-visible global. */
  globalsView(): { name: string; ty: string; value: string }[] {
    return this.program.globals.flatMap((g, i) =>
      g.name.startsWith("<") ? [] : [{ name: g.name, ty: g.ty, value: this.repr(this.globals[i] ?? UNINIT) }]
    );
  }

  /** Execution statistics and the state of every send site's inline cache. */
  report(): string {
    const st = this.stats;
    const lines = [
      "── execution statistics ──",
      `instructions executed : ${st.instructions}`,
      `calls / sends         : ${st.calls} / ${st.sends}`,
      `max call depth        : ${st.maxDepth}`,
      `inline cache hits     : ${st.monoHits} monomorphic, ${st.polyHits} polymorphic`,
      `megamorphic lookups   : ${st.megaLookups}`,
      `global cache hits     : ${st.globalCacheHits}`,
      `full method lookups   : ${st.fullLookups}`,
      `send sites (${this.program.numSites} total):`,
    ];
    for (const s of this.sendSites()) {
      lines.push(`  @ic${s.site}: ${s.state}${s.state === "megamorphic" ? "" : ` [${s.classes.join(", ")}]`}`);
    }
    return lines.join("\n");
  }

  /** The inline cache of every send site that has executed. */
  sendSites(): SendSite[] {
    const name = (c: number) => this.program.shapes[c].name;
    return this.caches.flatMap((c, site): SendSite[] => {
      if (c?.k === "mono") return [{ site, state: "monomorphic", classes: [name(c.cls)] }];
      if (c?.k === "poly") return [{ site, state: "polymorphic", classes: c.entries.map(([k]) => name(k)) }];
      if (c?.k === "mega") return [{ site, state: "megamorphic", classes: [] }];
      return [];
    });
  }

  // ---------------------------------------------------------------------------
  // Error location
  // ---------------------------------------------------------------------------

  private locate(fault: Fault): RuntimeError {
    const backtrace: TraceFrame[] = [...this.frames].reverse().map((f) => {
      const pc = Math.max(0, Math.min(f.ip - 1, f.proto.spans.length - 1));
      const k = f.proto.kind;
      const name = k.tag === "main" ? "the main program" : `${k.tag} \`${f.proto.name}\``;
      return { name, span: f.proto.spans[pc] ?? Span.DUMMY };
    });
    const top = this.frames[this.frames.length - 1];
    return new RuntimeError(fault, backtrace[0]?.span ?? Span.DUMMY, backtrace, top ? this.frameLocals(top) : []);
  }

  private frameLocals(f: Frame): [string, string][] {
    const short = (s: string) => ([...s].length > 60 ? `${[...s].slice(0, 60).join("")}…` : s);
    if (f.proto.kind.tag === "main") return this.globalsView().map((g) => [g.name, short(g.value)]);
    return f.proto.locals.filter((l) => !l.name.startsWith("<")).flatMap((l): [string, string][] => {
      const v = this.stack[f.base + l.slot];
      if (v === undefined) return [];
      const shown = l.byref && v instanceof RefVal ? `${this.repr(this.tryRead(v.ref))} (BYREF)` : this.repr(v);
      return [[l.name, short(shown)]];
    });
  }

  private tryRead(r: Ref): Value {
    try {
      return this.readRef(r);
    } catch {
      return UNINIT;
    }
  }

  // ---------------------------------------------------------------------------
  // Value presentation
  // ---------------------------------------------------------------------------

  /** How OUTPUT prints a value. */
  show(v: Value): string {
    switch (typeof v) {
      case "number":
        return String(v);
      case "boolean":
        return v ? "TRUE" : "FALSE";
      case "string":
        return v;
      case "symbol":
        return v === UNINIT ? "<uninitialized>" : "";
    }
    if (v instanceof Real) return formatReal(v.v);
    if (v instanceof Char) return v.c;
    if (v instanceof DateVal) return formatDate(v.days);
    if (v instanceof EnumVal) return this.program.enums[v.ty].variants[v.ord];
    if (v instanceof ArrayObj) return `[${v.data.map((x) => this.repr(x)).join(", ")}]`;
    if (v instanceof Obj) return v.record ? this.fieldsRepr(v) : `<${this.program.shapes[v.shape].name} object>`;
    return "<pointer>";
  }

  /** Debug representation (strings quoted) used in error reports, arrays and the REPL. */
  repr(v: Value): string {
    if (typeof v === "string") return JSON.stringify(v);
    if (v instanceof Char) return `'${v.c}'`;
    if (v instanceof Obj && !v.record) return this.fieldsRepr(v);
    return this.show(v);
  }

  /** `Name { field: value, .. }`. Nested objects are not expanded, so cyclic structures print finitely. */
  private fieldsRepr(o: Obj): string {
    const shape = this.program.shapes[o.shape];
    const fields = shape.fields.map((f, i) => {
      const v = o.fields[i];
      return `${f.name}: ${v instanceof Obj && !v.record ? `<${this.program.shapes[v.shape].name}>` : this.repr(v)}`;
    });
    return `${shape.name} { ${fields.join(", ")} }`;
  }

  typeName(v: Value): string {
    if (v instanceof Obj) return this.program.shapes[v.shape].name;
    if (v instanceof EnumVal) return this.program.enums[v.ty].name;
    return typeName(v);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private popInt(): number {
    const v = this.stack.pop()!;
    if (typeof v !== "number") throw Fault.typeError("INTEGER", this.typeName(v));
    return v;
  }

  popStr(): string {
    const v = this.stack.pop()!;
    if (typeof v === "string") return v;
    if (v instanceof Char) return v.c;
    throw Fault.typeError("STRING", this.typeName(v));
  }

  private makeInit(idx: number): Value {
    const init = this.program.inits[idx];
    switch (init.tag) {
      case "uninit":
        return UNINIT;
      case "record":
        return this.newObj(init.shape, true);
      case "array": {
        const len = init.dims.reduce((n, [l, h]) => n * (h - l + 1), 1);
        const data: Value[] = new Array(len);
        for (let i = 0; i < len; i++) data[i] = this.makeInit(init.elem);
        return new ArrayObj(init.dims, data);
      }
    }
  }

  private newObj(shape: number, record: boolean): Obj {
    return new Obj(shape, this.program.shapes[shape].fieldInits.map((i) => this.makeInit(i)), record);
  }

  private readRef(r: Ref): Value {
    switch (r.kind) {
      case "stack":
        if (r.index >= this.stack.length) {
          throw new Fault("R0009", "dangling pointer", "the variable this points to no longer exists");
        }
        return this.stack[r.index];
      case "global":
        return this.globals[r.index];
      case "elem":
        return r.array.data[r.index];
      case "field":
        return r.obj.fields[r.index];
    }
  }

  private writeRef(r: Ref, v: Value): void {
    switch (r.kind) {
      case "stack":
        if (r.index >= this.stack.length) {
          throw new Fault("R0009", "dangling pointer", "the variable this points to no longer exists");
        }
        this.stack[r.index] = v;
        return;
      case "global":
        this.globals[r.index] = v;
        return;
      case "elem":
        r.array.data[r.index] = v;
        return;
      case "field":
        r.obj.fields[r.index] = v;
    }
  }

  private uninitLocal(proto: Proto, slot: number): Fault {
    const l = proto.localName(slot);
    if (!l) return new Fault("R0002", "use of uninitialized variable", "read before assignment");
    return new Fault(
      "R0002",
      `use of uninitialized variable \`${l.name}\``,
      `\`${l.name}\` has not been given a value yet`,
    )
      .withSecondary(l.decl, "declared here")
      .help(`assign \`${l.name}\` a value before reading it`);
  }

  private uninitGlobal(g: number): Fault {
    const info = this.program.globals[g];
    return new Fault(
      "R0002",
      `use of uninitialized variable \`${info.name}\``,
      `\`${info.name}\` has not been given a value yet`,
    )
      .withSecondary(info.decl, "declared here")
      .help(`assign \`${info.name}\` a value (or INPUT it) before reading it`);
  }

  private object(v: Value, what: string): Obj {
    if (v instanceof Obj) return v;
    if (v === UNINIT) {
      throw new Fault(
        "R0009",
        `${what} on an object variable that was never assigned`,
        "this object does not exist yet",
      )
        .help("create the object first, e.g. `MyPet ← NEW Pet(...)`");
    }
    throw Fault.typeError("an object", this.typeName(v));
  }

  private fieldValue(o: Obj, slot: number): Value {
    const v = o.fields[slot];
    if (v !== UNINIT) return v;
    const shape = this.program.shapes[o.shape];
    const fname = shape.fields[slot].name;
    const f = new Fault(
      "R0002",
      `field \`${fname}\` of \`${shape.name}\` read before it was assigned`,
      `\`${fname}\` has no value yet`,
    );
    throw shape.isClass
      ? f.help(`give \`${fname}\` an initial value in the constructor \`PUBLIC PROCEDURE NEW(...)\``)
      : f.help(`assign \`.${fname}\` before reading it`);
  }

  private arrayIndex(n: number): [ArrayObj, number] {
    const idx: number[] = new Array(n);
    for (let i = n - 1; i >= 0; i--) idx[i] = this.popInt();
    const arr = this.stack.pop()!;
    if (arr === UNINIT) throw new Fault("R0002", "indexing an uninitialized array", "this array has no value");
    if (!(arr instanceof ArrayObj)) throw Fault.typeError("ARRAY", this.typeName(arr));
    if (arr.dims.length !== n) {
      throw new Fault("R0001", `expected ${arr.dims.length} indices, found ${n}`, "wrong number of indices");
    }
    const flat = arr.flatIndex(idx);
    if (flat >= 0) return [arr, flat];
    const d = -1 - flat;
    const [lo, hi] = arr.dims[d];
    const bounds = arr.dims.map(([l, h]) => `${l}:${h}`).join(", ");
    throw new Fault("R0001", "array index out of bounds", `index ${idx[d]} is outside ${lo}:${hi}`)
      .note(`accessed [${idx.join(", ")}] of an ARRAY[${bounds}]`)
      .help(
        idx[d] === hi + 1
          ? "this is one past the end: check the loop's upper bound (off-by-one?)"
          : idx[d] === lo - 1
          ? `this is one before the start: the array starts at ${lo}`
          : `valid indices for this dimension are ${lo} to ${hi}`,
      );
  }

  // ---------------------------------------------------------------------------
  // Message dispatch
  // ---------------------------------------------------------------------------

  private lookupMethod(cls: number, sym: number): MethodMeta | undefined {
    const slot = ((cls * 31) ^ sym) % GLOBAL_CACHE_SIZE;
    const hit = this.globalCache[slot];
    if (hit && hit[0] === cls && hit[1] === sym) {
      this.stats.globalCacheHits++;
      return hit[2];
    }
    this.stats.fullLookups++;
    for (let c: number | undefined = cls; c !== undefined; c = this.program.shapes[c].parent) {
      const m = this.program.shapes[c].methods.get(sym);
      if (m) {
        this.globalCache[slot] = [cls, sym, m];
        return m;
      }
    }
    return undefined;
  }

  private sendTarget(site: number, cls: number, sym: number): MethodMeta {
    const cache = this.caches[site];
    if (cache?.k === "mono" && cache.cls === cls) {
      this.stats.monoHits++;
      return cache.target;
    }
    if (cache?.k === "poly") {
      for (const [c, t] of cache.entries) {
        if (c === cls) {
          this.stats.polyHits++;
          return t;
        }
      }
    }
    if (cache?.k === "mega") this.stats.megaLookups++;
    const target = this.lookupMethod(cls, sym);
    if (!target) throw this.notUnderstood(cls, sym);
    if (!cache) this.caches[site] = { k: "mono", cls, target };
    else if (cache.k === "mono") this.caches[site] = { k: "poly", entries: [[cache.cls, cache.target], [cls, target]] };
    else if (cache.k === "poly" && cache.entries.length < POLY_MAX) cache.entries.push([cls, target]);
    else this.caches[site] = { k: "mega" };
    return target;
  }

  private notUnderstood(cls: number, sym: number): Fault {
    const shape = this.program.shapes[cls];
    const sel = this.program.symbols[sym];
    const methods: string[] = [];
    for (let c: number | undefined = cls; c !== undefined; c = this.program.shapes[c].parent) {
      for (const k of this.program.shapes[c].methods.keys()) methods.push(this.program.symbols[k]);
    }
    methods.sort();
    const f = new Fault(
      "R0010",
      `\`${shape.name}\` does not understand the message \`${sel}\``,
      `no method \`${sel}\` in \`${shape.name}\` or its superclasses`,
    );
    const m = bestMatch(sel, methods);
    if (m) f.help(`did you mean \`${m}\`?`);
    else if (methods.length) f.note(`\`${shape.name}\` understands: ${methods.join(", ")}`);
    return f;
  }

  private checkPrivateMethod(target: MethodMeta, sym: number, caller: Proto): void {
    if (target.private && !(caller.kind.tag === "method" && caller.kind.cls === target.owner)) {
      const owner = this.program.shapes[target.owner].name;
      throw new Fault(
        "R0011",
        `method \`${this.program.symbols[sym]}\` of \`${owner}\` is private`,
        "private methods can only be called from inside their class",
      );
    }
  }

  private namedField(site: number, obj: Obj, sym: number, caller: Proto): number {
    const fc = this.fieldCaches[site];
    if (fc && fc.shape === obj.shape) return fc.slot;
    const shape = this.program.shapes[obj.shape];
    const slot = shape.fields.findIndex((f) => f.sym === sym);
    if (slot < 0) {
      const name = this.program.symbols[sym];
      const f = new Fault("R0010", `\`${shape.name}\` has no field \`${name}\``, "unknown field");
      const m = bestMatch(name, shape.fields.map((x) => x.name));
      if (m) f.help(`did you mean \`${m}\`?`);
      throw f;
    }
    const meta = shape.fields[slot];
    if (meta.private && !(caller.kind.tag === "method" && caller.kind.cls === meta.owner)) {
      throw new Fault(
        "R0011",
        `field \`${meta.name}\` of \`${this.program.shapes[meta.owner].name}\` is private`,
        "private fields can only be used inside their class",
      );
    }
    this.fieldCaches[site] = { shape: obj.shape, slot };
    return slot;
  }

  // ---------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------

  /** Supply the line an INPUT instruction is waiting for. Throws {@link RuntimeError} if it does not parse. */
  provideInput(text: string): void {
    const conv = this.pendingInput;
    if (conv === undefined) throw new Error("the VM is not waiting for input");
    this.pendingInput = undefined;
    try {
      this.stack.push(parseAs(text, conv));
    } catch (e) {
      throw e instanceof Fault ? this.locate(e) : e;
    }
  }

  /** The input stream ended while INPUT was waiting. */
  inputEnded(): never {
    this.pendingInput = undefined;
    throw this.locate(new Fault("R0006", "no more input", "INPUT reached the end of the input stream"));
  }

  // ---------------------------------------------------------------------------
  // The interpreter loop
  // ---------------------------------------------------------------------------

  /** Execute up to `budget` instructions. Throws {@link RuntimeError} on failure. */
  run(budget = Infinity): Step {
    const stack = this.stack;
    let frame = this.frames[this.frames.length - 1];
    let proto = frame.proto, code = proto.code, ip = frame.ip, base = frame.base;
    let executed = 0;
    const trace = this.host.trace;

    try {
      for (;;) {
        if (executed >= budget) {
          frame.ip = ip;
          return { tag: "yield" };
        }
        const ins: Instr = code[ip];
        if (trace) this.traceOp(trace, proto, ip, ins);
        ip++;
        executed++;
        switch (ins.op) {
          case Op.Nop:
            break;
          case Op.Const:
            stack.push(proto.consts[ins.a]);
            break;
          case Op.PushInt:
            stack.push(ins.a);
            break;
          case Op.True:
            stack.push(true);
            break;
          case Op.False:
            stack.push(false);
            break;
          case Op.Pop:
            stack.pop();
            break;
          case Op.Init:
            stack.push(this.makeInit(ins.a));
            break;
          case Op.Copy:
            stack.push(deepCopy(stack.pop()!));
            break;

          case Op.LoadLocal: {
            const v = stack[base + ins.a];
            if (v === UNINIT) throw this.uninitLocal(proto, ins.a);
            stack.push(v);
            break;
          }
          case Op.StoreLocal:
            stack[base + ins.a] = stack.pop()!;
            break;
          case Op.LoadGlobal: {
            const v = this.globals[ins.a];
            if (v === UNINIT) throw this.uninitGlobal(ins.a);
            stack.push(v);
            break;
          }
          case Op.StoreGlobal:
            this.globals[ins.a] = stack.pop()!;
            break;
          case Op.StoreLocalDeref: {
            const v = stack.pop()!;
            const r = stack[base + ins.a];
            if (!(r instanceof RefVal)) {
              throw new Fault("R0004", "BYREF parameter does not hold a reference", "internal error");
            }
            this.writeRef(r.ref, v);
            break;
          }
          case Op.RefLocal:
            stack.push(new RefVal({ kind: "stack", index: base + ins.a }));
            break;
          case Op.RefGlobal:
            stack.push(new RefVal({ kind: "global", index: ins.a }));
            break;
          case Op.Deref: {
            const r = stack.pop()!;
            if (r === UNINIT) {
              throw new Fault("R0009", "dereferencing a pointer that was never assigned", "this pointer points nowhere")
                .help("assign it first, e.g. `P ← ^SomeVariable`");
            }
            if (!(r instanceof RefVal)) throw Fault.typeError("a pointer", this.typeName(r));
            const v = this.readRef(r.ref);
            if (v === UNINIT) {
              throw new Fault(
                "R0002",
                "read through a pointer to an uninitialized variable",
                "the target has no value yet",
              );
            }
            stack.push(v);
            break;
          }
          case Op.StoreDeref: {
            const v = stack.pop()!;
            const r = stack.pop()!;
            if (r === UNINIT) {
              throw new Fault(
                "R0009",
                "assigning through a pointer that was never assigned",
                "this pointer points nowhere",
              );
            }
            if (!(r instanceof RefVal)) throw Fault.typeError("a pointer", this.typeName(r));
            this.writeRef(r.ref, v);
            break;
          }

          case Op.LoadSelf:
            stack.push(stack[base]);
            break;
          case Op.LoadSelfField:
            stack.push(this.fieldValue(stack[base] as Obj, ins.a));
            break;
          case Op.StoreSelfField:
            (stack[base] as Obj).fields[ins.a] = stack.pop()!;
            break;
          case Op.RefSelfField:
            stack.push(new RefVal({ kind: "field", obj: stack[base] as Obj, index: ins.a }));
            break;
          case Op.GetField:
            stack.push(this.fieldValue(this.object(stack.pop()!, "reading a field"), ins.a));
            break;
          case Op.SetField: {
            const v = stack.pop()!;
            this.object(stack.pop()!, "assigning a field").fields[ins.a] = v;
            break;
          }
          case Op.FieldRef:
            stack.push(
              new RefVal({ kind: "field", obj: this.object(stack.pop()!, "referencing a field"), index: ins.a }),
            );
            break;
          case Op.GetFieldNamed: {
            const o = this.object(stack.pop()!, "reading a field");
            stack.push(this.fieldValue(o, this.namedField(ins.b, o, ins.a, proto)));
            break;
          }
          case Op.SetFieldNamed: {
            const v = stack.pop()!;
            const o = this.object(stack.pop()!, "assigning a field");
            o.fields[this.namedField(ins.b, o, ins.a, proto)] = v;
            break;
          }
          case Op.FieldRefNamed: {
            const o = this.object(stack.pop()!, "referencing a field");
            stack.push(new RefVal({ kind: "field", obj: o, index: this.namedField(ins.b, o, ins.a, proto) }));
            break;
          }
          case Op.Index: {
            // Fast path: one in-bounds INTEGER index into a 1-D array, no allocation.
            if (ins.a === 1) {
              const i = stack[stack.length - 1], arr = stack[stack.length - 2];
              if (typeof i === "number" && arr instanceof ArrayObj && arr.dims.length === 1) {
                const lo = arr.dims[0][0];
                const v = arr.data[i - lo];
                if (v !== undefined && v !== UNINIT && i <= arr.dims[0][1] && i >= lo) {
                  stack.length -= 2;
                  stack.push(v);
                  break;
                }
              }
            }
            const [arr, i] = this.arrayIndex(ins.a);
            const v = arr.data[i];
            if (v === UNINIT) {
              throw new Fault("R0002", "array element read before it was assigned", "this element has no value yet")
                .help("assign every element (e.g. in a FOR loop) before reading it");
            }
            stack.push(v);
            break;
          }
          case Op.StoreIndex: {
            const v = stack.pop()!;
            if (ins.a === 1) {
              const i = stack[stack.length - 1], arr = stack[stack.length - 2];
              if (typeof i === "number" && arr instanceof ArrayObj && arr.dims.length === 1) {
                const [lo, hi] = arr.dims[0];
                if (i >= lo && i <= hi) {
                  stack.length -= 2;
                  arr.data[i - lo] = v;
                  break;
                }
              }
            }
            const [arr, i] = this.arrayIndex(ins.a);
            arr.data[i] = v;
            break;
          }
          case Op.IndexRef: {
            const [arr, i] = this.arrayIndex(ins.a);
            stack.push(new RefVal({ kind: "elem", array: arr, index: i }));
            break;
          }

          case Op.Add:
          case Op.Sub:
          case Op.Mul: {
            const b = stack.pop()!, a = stack.pop()!;
            if (typeof a === "number" && typeof b === "number") {
              const r = ins.op === Op.Add ? a + b : ins.op === Op.Sub ? a - b : a * b;
              if (Number.isSafeInteger(r)) {
                stack.push(r === 0 ? 0 : r);
                break;
              }
            }
            stack.push(this.arith(ins.op, a, b));
            break;
          }
          case Op.Div: {
            const b = stack.pop()!, a = stack.pop()!;
            const x = asReal(a), y = asReal(b);
            if (x === undefined || y === undefined) {
              throw new Fault("R0004", `cannot divide ${this.typeName(a)} by ${this.typeName(b)}`, "invalid operands");
            }
            if (y === 0) {
              throw new Fault("R0003", "division by zero", `${this.show(a)} / 0`).help(
                "check the divisor before dividing",
              );
            }
            stack.push(new Real(x / y));
            break;
          }
          case Op.IntDiv:
          case Op.Mod: {
            const b = this.popInt(), a = this.popInt();
            if (b === 0) {
              throw new Fault("R0003", "division by zero", `${a} ${ins.op === Op.IntDiv ? "DIV" : "MOD"} 0`)
                .help("check the divisor before dividing");
            }
            stack.push(ins.op === Op.IntDiv ? Math.trunc(a / b) : a % b);
            break;
          }
          case Op.Neg: {
            const v = stack.pop()!;
            if (typeof v === "number") stack.push(v === 0 ? 0 : -v);
            else if (v instanceof Real) stack.push(new Real(-v.v));
            else throw Fault.typeError("a number", this.typeName(v));
            break;
          }
          case Op.Concat: {
            const b = this.popStr(), a = this.popStr();
            stack.push(a + b);
            break;
          }
          case Op.Eq:
          case Op.Ne: {
            const b = stack.pop()!, a = stack.pop()!;
            stack.push(valuesEqual(a, b) === (ins.op === Op.Eq));
            break;
          }
          case Op.Lt:
          case Op.Le:
          case Op.Gt:
          case Op.Ge: {
            const b = stack.pop()!, a = stack.pop()!;
            const ord = compare(a, b);
            if (ord === undefined) {
              throw new Fault(
                "R0004",
                `cannot compare ${this.typeName(a)} with ${this.typeName(b)}`,
                "values are not ordered",
              );
            }
            stack.push(
              ins.op === Op.Lt ? ord < 0 : ins.op === Op.Le ? ord <= 0 : ins.op === Op.Gt ? ord > 0 : ord >= 0,
            );
            break;
          }
          case Op.Not: {
            const v = stack.pop()!;
            if (typeof v !== "boolean") throw Fault.typeError("BOOLEAN", this.typeName(v));
            stack.push(!v);
            break;
          }
          case Op.IntToReal: {
            const v = stack[stack.length - 1];
            if (typeof v === "number") stack[stack.length - 1] = new Real(v);
            break;
          }
          case Op.Convert:
            stack.push(this.convert(stack.pop()!, ins.a));
            break;
          case Op.Check:
            stack.push(this.check(stack.pop()!, ins.a));
            break;
          case Op.Coerce:
            stack[base + ins.a] = this.check(stack[base + ins.a], ins.b);
            break;

          case Op.Jump:
            ip = ins.a;
            break;
          case Op.JumpIfFalse: {
            const v = stack.pop()!;
            if (v === false) ip = ins.a;
            else if (v !== true) throw Fault.typeError("BOOLEAN", this.typeName(v));
            break;
          }
          case Op.JumpIfFalseOrPop:
            if (stack[stack.length - 1] === false) ip = ins.a;
            else stack.pop();
            break;
          case Op.JumpIfTrueOrPop:
            if (stack[stack.length - 1] === true) ip = ins.a;
            else stack.pop();
            break;
          case Op.ForCheck: {
            const g = this.globals;
            const v = ins.a < 0 ? g[-ins.a - 1] : stack[base + ins.a];
            const e = ins.b < 0 ? g[-ins.b - 1] : stack[base + ins.b];
            const s = ins.c < 0 ? g[-ins.c - 1] : stack[base + ins.c];
            if (typeof v !== "number" || typeof e !== "number" || typeof s !== "number") {
              throw new Fault(
                "R0004",
                "FOR loop counter is not an INTEGER",
                "the loop variable was changed to a non-INTEGER value",
              );
            }
            if ((s >= 0 && v > e) || (s < 0 && v < e)) ip = ins.d;
            break;
          }
          case Op.ForStep: {
            const g = this.globals;
            const v = ins.a < 0 ? g[-ins.a - 1] : stack[base + ins.a];
            const s = ins.b < 0 ? g[-ins.b - 1] : stack[base + ins.b];
            if (typeof v !== "number" || typeof s !== "number") {
              throw new Fault("R0004", "FOR loop counter is not an INTEGER", "the loop variable was changed");
            }
            const n = v + s;
            if (!Number.isSafeInteger(n)) {
              throw new Fault("R0003", "integer overflow in FOR loop", "counter overflowed");
            }
            if (ins.a < 0) g[-ins.a - 1] = n;
            else stack[base + ins.a] = n;
            ip = ins.c;
            break;
          }

          case Op.Call:
            frame.ip = ip;
            frame = this.pushFrame(this.program.functions[ins.a], stack.length - ins.b, false);
            proto = frame.proto;
            code = proto.code;
            ip = 0;
            base = frame.base;
            break;
          case Op.CallBuiltin: {
            const args = stack.splice(stack.length - ins.b, ins.b);
            stack.push(callBuiltin(this, ins.a, args));
            break;
          }
          case Op.Send:
          case Op.SendSelf: {
            const argc = ins.b;
            if (ins.op === Op.SendSelf) stack.splice(stack.length - argc, 0, stack[base]);
            this.stats.sends++;
            const recvAt = stack.length - argc - 1;
            const recv = stack[recvAt];
            const sel = this.program.symbols[ins.a];
            if (recv === UNINIT) {
              throw new Fault(
                "R0009",
                `sending \`${sel}\` to an object variable that was never assigned`,
                "this object does not exist yet",
              )
                .help("create it first with NEW, e.g. `X ← NEW ClassName(...)`");
            }
            if (!(recv instanceof Obj) || recv.record) {
              throw new Fault(
                "R0010",
                `${this.typeName(recv)} value does not understand the message \`${sel}\``,
                "only objects respond to messages",
              );
            }
            const target = this.sendTarget(ins.c, recv.shape, ins.a);
            this.checkPrivateMethod(target, ins.a, proto);
            frame.ip = ip;
            frame = this.pushFrame(this.program.functions[target.func], recvAt, false);
            proto = frame.proto;
            code = proto.code;
            ip = 0;
            base = frame.base;
            break;
          }
          case Op.Construct: {
            const obj = this.newObj(ins.a, false);
            if (ins.b < 0) stack.push(obj);
            else {
              const at = stack.length - ins.c;
              stack.splice(at, 0, obj);
              frame.ip = ip;
              frame = this.pushFrame(this.program.functions[ins.b], at, true);
              proto = frame.proto;
              code = proto.code;
              ip = 0;
              base = frame.base;
            }
            break;
          }
          case Op.Return:
          case Op.ReturnVoid:
            frame = this.popFrame(ins.op === Op.Return ? stack.pop()! : VOID);
            proto = frame.proto;
            code = proto.code;
            ip = frame.ip;
            base = frame.base;
            break;
          case Op.MissingReturn:
            throw new Fault(
              "R0008",
              `FUNCTION \`${proto.name}\` finished without returning a value`,
              "execution reached the end of the function",
            )
              .note(`signature: ${proto.signature}`)
              .help("make sure every path through the function ends in RETURN");

          case Op.Output: {
            const vals = stack.splice(stack.length - ins.a, ins.a);
            this.output.push(vals.map((v) => this.show(v)).join(""));
            break;
          }
          case Op.Input:
            this.pendingInput = ins.a;
            frame.ip = ip;
            this.stats.instructions += executed;
            return { tag: "input" };
          case Op.OpenFile:
            this.files.openFile(this.popStr(), ins.a as FileMode);
            break;
          case Op.ReadFile:
            stack.push(parseAs(this.files.readLine(this.popStr()), ins.a));
            break;
          case Op.WriteFile: {
            const v = stack.pop()!;
            this.files.writeLine(this.popStr(), this.show(v));
            break;
          }
          case Op.CloseFile:
            this.files.close(this.popStr());
            break;
          case Op.Seek: {
            const addr = this.popInt();
            this.files.seek(this.popStr(), addr);
            break;
          }
          case Op.GetRecord:
            stack.push(this.files.getRecord(this.popStr()));
            break;
          case Op.PutRecord: {
            const v = deepCopy(stack.pop()!);
            this.files.putRecord(this.popStr(), v);
            break;
          }
          case Op.Echo: {
            const v = stack.pop()!;
            if (v !== VOID) {
              this.echoes.push({
                name: proto.consts[ins.a] as string,
                ty: proto.consts[ins.b] as string,
                value: this.repr(v),
              });
            }
            break;
          }
          case Op.Halt:
            frame.ip = ip - 1;
            this.files.closeAll();
            return { tag: "halt" };
        }
      }
    } catch (e) {
      if (!(e instanceof Fault)) throw e;
      frame.ip = ip;
      this.files.closeAll();
      throw this.locate(e);
    } finally {
      this.stats.instructions += executed;
    }
  }

  private pushFrame(callee: Proto, base: number, ctor: boolean): Frame {
    if (this.frames.length >= MAX_FRAMES) {
      throw new Fault("R0007", "stack overflow", `too many nested calls (${MAX_FRAMES})`)
        .note(`while calling \`${callee.name}\``)
        .help("check that recursive routines have a base case that is always reached");
    }
    const stack = this.stack;
    for (let i = stack.length; i < base + callee.numSlots; i++) stack.push(UNINIT);
    const frame: Frame = { proto: callee, ip: 0, base, ctor };
    this.frames.push(frame);
    if (this.frames.length > this.stats.maxDepth) this.stats.maxDepth = this.frames.length;
    this.stats.calls++;
    return frame;
  }

  /** Pop the current frame, leaving its result on the stack; returns the caller's frame. */
  private popFrame(value: Value): Frame {
    const done = this.frames.pop()!;
    const stack = this.stack;
    // Constructors answer the new object.
    const result = done.ctor ? stack[done.base] : value;
    stack.length = done.base;
    stack.push(result);
    return this.frames[this.frames.length - 1];
  }

  private arith(op: Op, a: Value, b: Value): Value {
    const sym = op === Op.Add ? "+" : op === Op.Sub ? "-" : "*";
    if (typeof a === "number" && typeof b === "number") {
      const r = op === Op.Add ? a + b : op === Op.Sub ? a - b : a * b;
      if (!Number.isSafeInteger(r)) {
        throw new Fault("R0003", "integer overflow", `${a} ${sym} ${b} does not fit in an INTEGER`)
          .help("use REAL values for very large numbers");
      }
      return r === 0 ? 0 : r;
    }
    const x = asReal(a), y = asReal(b);
    if (x === undefined || y === undefined) {
      throw new Fault(
        "R0004",
        `cannot apply \`${sym}\` to ${this.typeName(a)} and ${this.typeName(b)}`,
        "invalid operands",
      );
    }
    return new Real(op === Op.Add ? x + y : op === Op.Sub ? x - y : x * y);
  }

  private traceOp(trace: (line: string) => void, proto: Proto, ip: number, ins: Instr): void {
    const top = this.stack.slice(-4).reverse().map((v) => this.repr(v)).join(" ");
    const indent = "  ".repeat(this.frames.length - 1);
    trace(
      `${indent}[${proto.name}:${String(ip).padStart(4, "0")}] ${
        this.program.describeOp(proto, ins).padEnd(40)
      } | ${top}`,
    );
  }

  private convert(v: Value, to: Conv): Value {
    const bad = (what: string) =>
      new Fault("R0004", `cannot convert ${this.repr(v)} to ${what}`, `not a valid ${what}`);
    const parse = (what: string) => {
      try {
        return parseAs(v as string, to);
      } catch {
        throw bad(what);
      }
    };
    switch (to) {
      case Conv.Int:
        if (typeof v === "number") return v;
        if (v instanceof Real) return Math.trunc(v.v);
        if (typeof v === "boolean") return v ? 1 : 0;
        if (v instanceof Char) return v.c.codePointAt(0)!;
        if (v instanceof EnumVal) return v.ord;
        if (v instanceof DateVal) return v.days;
        if (typeof v === "string") return parse("INTEGER");
        throw bad("INTEGER");
      case Conv.Real:
        if (typeof v === "number") return new Real(v);
        if (v instanceof Real) return v;
        if (typeof v === "string") return parse("REAL");
        throw bad("REAL");
      case Conv.Str:
        return this.show(v);
      case Conv.Char:
        if (typeof v === "number" && v >= 0 && v <= 0x10ffff) return new Char(String.fromCodePoint(v));
        if (v instanceof Char) return v;
        if (typeof v === "string" && [...v].length === 1) return new Char(v);
        throw bad("CHAR");
      case Conv.Bool:
        if (typeof v === "boolean") return v;
        if (typeof v === "number") return v !== 0;
        if (typeof v === "string") return parse("BOOLEAN");
        throw bad("BOOLEAN");
      case Conv.Date:
        if (v instanceof DateVal) return v;
        if (typeof v === "string") return parse("DATE");
        throw bad("DATE");
      case Conv.Any:
        return v;
    }
  }

  /** Gradual-typing boundary: the value must already have type `to` (with INTEGER->REAL and CHAR->STRING widening). */
  private check(v: Value, to: Conv): Value {
    switch (to) {
      case Conv.Int:
        if (typeof v === "number") return v;
        break;
      case Conv.Real:
        if (v instanceof Real) return v;
        if (typeof v === "number") return new Real(v);
        break;
      case Conv.Bool:
        if (typeof v === "boolean") return v;
        break;
      case Conv.Char:
        if (v instanceof Char) return v;
        break;
      case Conv.Str:
        if (typeof v === "string") return v;
        if (v instanceof Char) return v.c;
        break;
      case Conv.Date:
        if (v instanceof DateVal) return v;
        break;
      case Conv.Any:
        return v;
    }
    if (v === VOID) {
      throw new Fault("R0004", `expected ${convName(to)} but the routine is a PROCEDURE`, "no value produced");
    }
    throw Fault.typeError(convName(to), this.typeName(v))
      .note("this value's type could only be checked at run time (it came from a routine defined later in the file)");
  }
}

export function convName(c: Conv): string {
  return ["INTEGER", "REAL", "BOOLEAN", "CHAR", "STRING", "DATE", "a value"][c];
}

/** Parse text read by INPUT / READFILE into a value of the given type. */
export function parseAs(text: string, conv: Conv): Value {
  const t = text.trim();
  const bad = (what: string, hint: string) =>
    new Fault("R0006", `invalid input for ${what}: ${JSON.stringify(text)}`, `expected ${what}`).help(hint);
  switch (conv) {
    case Conv.Int:
      if (/^[+-]?\d+$/.test(t) && Number.isSafeInteger(Number(t))) return Number(t);
      throw bad("INTEGER", "enter a whole number such as 42");
    case Conv.Real:
      if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return new Real(Number(t));
      throw bad("REAL", "enter a number such as 3.5");
    case Conv.Bool:
      if (t.toUpperCase() === "TRUE") return true;
      if (t.toUpperCase() === "FALSE") return false;
      throw bad("BOOLEAN", "enter TRUE or FALSE");
    case Conv.Char:
      if ([...text].length === 1) return new Char(text);
      throw bad("CHAR", "enter exactly one character");
    case Conv.Date: {
      const m = /^(\d+)\/(\d+)\/(\d+)$/.exec(t);
      const days = m ? daysFromCivil(Number(m[3]), Number(m[2]), Number(m[1])) : undefined;
      if (days !== undefined) return new DateVal(days);
      throw bad("DATE", "enter a date as dd/mm/yyyy");
    }
    case Conv.Str:
    case Conv.Any:
      return text;
  }
}

function asReal(v: Value): number | undefined {
  if (typeof v === "number") return v;
  if (v instanceof Real) return v.v;
  return undefined;
}

function refEquals(a: Ref, b: Ref): boolean {
  if (a.kind !== b.kind || a.index !== b.index) return false;
  if (a.kind === "elem") return a.array === (b as typeof a).array;
  if (a.kind === "field") return a.obj === (b as typeof a).obj;
  return true;
}

export function valuesEqual(a: Value, b: Value): boolean {
  if (a instanceof Obj && b instanceof Obj) {
    if (!a.record || !b.record) return a === b;
    return a.shape === b.shape && a.fields.every((f, i) => valuesEqual(f, b.fields[i]));
  }
  if (a instanceof ArrayObj && b instanceof ArrayObj) {
    return a.data.length === b.data.length && a.dims.every(([l, h], i) => l === b.dims[i][0] && h === b.dims[i][1]) &&
      a.data.every((x, i) => valuesEqual(x, b.data[i]));
  }
  if (a instanceof RefVal && b instanceof RefVal) return refEquals(a.ref, b.ref);
  if (typeof a === "boolean" && typeof b === "boolean") return a === b;
  return compare(a, b) === 0;
}

/** Ordering of two values (negative, zero, positive), or undefined if they are not comparable. */
export function compare(a: Value, b: Value): number | undefined {
  const x = asReal(a), y = asReal(b);
  if (x !== undefined && y !== undefined) return x < y ? -1 : x > y ? 1 : x === y ? 0 : undefined;
  const text = (v: Value) => (typeof v === "string" ? v : v instanceof Char ? v.c : undefined);
  const s = text(a), t = text(b);
  if (s !== undefined && t !== undefined) return s < t ? -1 : s > t ? 1 : 0;
  if (a instanceof DateVal && b instanceof DateVal) return a.days - b.days;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  if (a instanceof EnumVal && b instanceof EnumVal && a.ty === b.ty) return a.ord - b.ord;
  return undefined;
}
