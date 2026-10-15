/**
 * The Effect layer: compiling and running programs as typed effects.
 *
 * I/O is provided through services, so the same program runs against a
 * browser console, a terminal or an in-memory test harness:
 *
 * - {@link Console} receives each line written by OUTPUT;
 * - {@link Stdin} supplies lines for INPUT, possibly asynchronously (a user typing);
 * - {@link Files} is the virtual file system used by OPENFILE and friends;
 * - {@link VmConfig} tunes the time slice, random seed and tracing.
 *
 * The VM runs in slices and yields to the host between them, so a running
 * program never freezes the page and can be stopped by interrupting its fiber.
 */

import { Context, Data, Effect, Layer, Option } from "effect";
import type { Program } from "./core/bytecode.ts";
import type { Diagnostic, Diagnostics } from "./core/diag.ts";
import { Source } from "./core/source.ts";
import { compile } from "./compiler/mod.ts";
import { RuntimeError } from "./vm/fault.ts";
import { VirtualFs } from "./vm/files.ts";
import { type Echo, Vm } from "./vm/vm.ts";
import { Conv, Op } from "./core/bytecode.ts";

export class Console extends Context.Tag("pseudo/Console")<Console, {
  readonly print: (line: string) => Effect.Effect<void>;
}>() {}

/** What an INPUT statement is waiting for. */
export interface InputRequest {
  readonly type: string;
}

export class Stdin extends Context.Tag("pseudo/Stdin")<Stdin, {
  /** The next line of input, or `None` at end of input. */
  readonly readLine: (request: InputRequest) => Effect.Effect<Option.Option<string>>;
}>() {}

export class Files extends Context.Tag("pseudo/Files")<Files, VirtualFs>() {}

export interface VmSettings {
  /** Instructions executed between yields to the host. */
  readonly sliceSize: number;
  readonly seed?: number;
  readonly today?: () => number;
  readonly trace?: (line: string) => void;
}

export class VmConfig extends Context.Tag("pseudo/VmConfig")<VmConfig, VmSettings>() {
  static readonly Default = Layer.succeed(VmConfig, { sliceSize: 200_000 });
}

export class CompileError extends Data.TaggedError("CompileError")<{
  readonly source: Source;
  readonly diagnostics: readonly Diagnostic[];
}> {}

export class RuntimeFailure extends Data.TaggedError("RuntimeFailure")<{
  readonly source: Source;
  readonly error: RuntimeError;
}> {}

/** Compile, failing with every diagnostic if there are errors. Warnings are returned on success. */
export const compileSource = (
  source: Source,
  repl = false,
): Effect.Effect<{ program: Program; diagnostics: Diagnostics }, CompileError> =>
  Effect.suspend(() => {
    const { program, diagnostics } = compile(source, { repl });
    return program
      ? Effect.succeed({ program, diagnostics })
      : Effect.fail(new CompileError({ source, diagnostics: diagnostics.sorted() }));
  });

/** A function that may throw a {@link RuntimeError}, as an effect. */
const guard = <A>(source: Source, f: () => A): Effect.Effect<A, RuntimeFailure> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(f());
    } catch (e) {
      if (e instanceof RuntimeError) return Effect.fail(new RuntimeFailure({ source, error: e }));
      return Effect.die(e);
    }
  });

const INPUT_TYPES = ["INTEGER", "REAL", "BOOLEAN", "CHAR", "STRING", "DATE", "STRING"];

/** Run a VM (already positioned with `start`) to completion, yielding to the host between time slices. */
export const drive = (vm: Vm, source: Source): Effect.Effect<void, RuntimeFailure, Console | Stdin | VmConfig> =>
  Effect.gen(function* () {
    const console = yield* Console;
    const stdin = yield* Stdin;
    const { sliceSize } = yield* VmConfig;
    const flush = Effect.suspend(() => Effect.forEach(vm.takeOutput(), console.print, { discard: true }));
    const loop = Effect.gen(function* () {
      for (;;) {
        const step = yield* guard(source, () => vm.run(sliceSize));
        yield* flush;
        if (step.tag === "halt") return;
        if (step.tag === "input") {
          const type = INPUT_TYPES[vm.awaitingInput ?? Conv.Str];
          const line = yield* stdin.readLine({ type });
          yield* guard(source, () => (Option.isSome(line) ? vm.provideInput(line.value) : vm.inputEnded()));
        } else {
          // A macrotask boundary: the page can repaint and a Stop button can interrupt us here.
          yield* Effect.sleep(0);
        }
      }
    });
    yield* loop.pipe(Effect.ensuring(flush));
  });

export interface RunResult {
  readonly program: Program;
  readonly diagnostics: Diagnostics;
  readonly vm: Vm;
}

/** Compile and run a whole program. */
export const runSource = (
  source: Source,
): Effect.Effect<RunResult, CompileError | RuntimeFailure, Console | Stdin | Files | VmConfig> =>
  Effect.gen(function* () {
    const { program, diagnostics } = yield* compileSource(source);
    const fs = yield* Files;
    const cfg = yield* VmConfig;
    const vm = new Vm(program, { fs, seed: cfg.seed, today: cfg.today, trace: cfg.trace });
    yield* drive(vm, source);
    return { program, diagnostics, vm };
  });

// ---------------------------------------------------------------------------
// Interactive sessions
// ---------------------------------------------------------------------------

export interface SubmitResult {
  /** `- : INTEGER = 42` style results of expressions and assignments. */
  readonly echoes: readonly Echo[];
  /** Signatures of variables, routines, types and classes this input declared. */
  readonly declared: readonly string[];
  readonly warnings: readonly Diagnostic[];
  readonly source: Source;
}

/**
 * A REPL session. Each accepted input is appended to the transcript and the
 * whole transcript is recompiled; the compiler is deterministic, so earlier
 * code, globals and send sites keep their indices and the VM resumes right
 * where the previous input halted, with its globals and warm inline caches.
 * Earlier inputs never run again.
 */
export class Session {
  private transcript = "";
  private program: Program | undefined;
  private vm: Vm | undefined;

  constructor(private readonly name = "repl") {}

  get source(): Source {
    return new Source(this.name, this.transcript);
  }

  get currentProgram(): Program | undefined {
    return this.program;
  }

  get machine(): Vm | undefined {
    return this.vm;
  }

  /** Start from scratch, forgetting all variables and definitions. */
  reset(): void {
    this.transcript = "";
    this.program = undefined;
    this.vm = undefined;
  }

  /** Compile only: diagnostics `input` would produce, without running anything. */
  check(input: string): { diagnostics: readonly Diagnostic[]; source: Source; echoTypes: readonly string[] } {
    const text = this.transcript + input + "\n";
    const source = new Source(this.name, text);
    const { program, diagnostics } = compile(source, { repl: true });
    const offset = this.transcript.length;
    const echoTypes: string[] = [];
    if (program) {
      const main = program.main;
      for (let i = this.haltIndex(); i < main.code.length; i++) {
        const ins = main.code[i];
        if (ins.op === Op.Echo) echoTypes.push(String(main.consts[ins.b]));
      }
    }
    return {
      diagnostics: diagnostics.sorted().filter((d) => (d.primarySpan()?.start ?? offset) >= offset),
      source,
      echoTypes,
    };
  }

  private haltIndex(): number {
    return this.program ? this.program.main.code.length - 1 : 0;
  }

  submit(
    input: string,
  ): Effect.Effect<SubmitResult, CompileError | RuntimeFailure, Console | Stdin | Files | VmConfig> {
    return Effect.gen(this, function* () {
      const offset = this.transcript.length;
      const text = this.transcript + input + "\n";
      const source = new Source(this.name, text);
      const { program, diagnostics } = compile(source, { repl: true });
      const fresh = diagnostics.sorted().filter((d) => (d.primarySpan()?.start ?? offset) >= offset);
      if (!program) {
        return yield* Effect.fail(new CompileError({ source, diagnostics: fresh.filter((d) => d.isError) }));
      }

      const previous = this.program;
      const from = this.haltIndex();
      const fs = yield* Files;
      const cfg = yield* VmConfig;
      // Accept the input before running it: definitions stay even if it fails at run time.
      this.transcript = text;
      this.program = program;
      let vm = this.vm;
      if (vm) vm.start(program, from);
      else vm = this.vm = new Vm(program, { fs, seed: cfg.seed, today: cfg.today, trace: cfg.trace });
      yield* drive(vm, source);
      return { echoes: vm.takeEchoes(), declared: declarations(previous, program), warnings: fresh, source };
    });
  }
}

/** Human-readable summaries of what `next` declares beyond `prev`. */
function declarations(prev: Program | undefined, next: Program): string[] {
  const out: string[] = [];
  for (const g of next.globals.slice(prev?.globals.length ?? 0)) {
    if (!g.name.startsWith("<")) out.push(`${g.name} : ${g.ty}`);
  }
  for (const f of next.functions.slice(prev?.functions.length ?? 0)) {
    if (f.kind.tag !== "method" && f.signature) out.push(f.signature);
  }
  for (const s of next.shapes.slice(prev?.shapes.length ?? 0)) {
    const parent = s.parent === undefined ? "" : ` INHERITS ${next.shapes[s.parent].name}`;
    out.push(s.isClass ? `CLASS ${s.name}${parent}` : `TYPE ${s.name}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// In-memory I/O, for tests and headless use
// ---------------------------------------------------------------------------

export interface MemoryIo {
  readonly layer: Layer.Layer<Console | Stdin | Files | VmConfig>;
  readonly output: string[];
  readonly fs: VirtualFs;
}

/** I/O services backed by arrays: `inputs` feed INPUT, OUTPUT lines are collected in `output`. */
export function memoryIo(inputs: readonly string[] = [], settings: Partial<VmSettings> = {}): MemoryIo {
  const output: string[] = [];
  const queue = [...inputs];
  const fs = new VirtualFs();
  const layer = Layer.mergeAll(
    Layer.succeed(Console, { print: (line) => Effect.sync(() => void output.push(line)) }),
    Layer.succeed(Stdin, { readLine: () => Effect.sync(() => Option.fromNullable(queue.shift())) }),
    Layer.succeed(Files, fs),
    Layer.succeed(VmConfig, { sliceSize: 200_000, seed: 42, ...settings }),
  );
  return { layer, output, fs };
}
