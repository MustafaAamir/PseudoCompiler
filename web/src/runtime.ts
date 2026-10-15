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
import { Op, type Program } from "./core/bytecode.ts";
import type { Diagnostic, Diagnostics } from "./core/diag.ts";
import { Source } from "./core/source.ts";
import { compile } from "./compiler/mod.ts";
import { RuntimeError } from "./vm/fault.ts";
import { VirtualFs } from "./vm/files.ts";
import { convName, type Echo, Vm, type VmHost } from "./vm/vm.ts";

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

export interface VmSettings extends Omit<VmHost, "fs"> {
  /** Instructions executed between yields to the host. */
  readonly sliceSize: number;
}

export class VmConfig extends Context.Tag("pseudo/VmConfig")<VmConfig, VmSettings>() {}

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
): Effect.Effect<{ program: Program; diagnostics: Diagnostics }, CompileError> =>
  Effect.suspend(() => {
    const { program, diagnostics } = compile(source);
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
          const line = yield* stdin.readLine({ type: convName(vm.awaitingInput!) });
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
  readonly diagnostics: Diagnostics;
  readonly vm: Vm;
}

/** Compile and run a whole program. */
export const runSource = (
  source: Source,
): Effect.Effect<RunResult, CompileError | RuntimeFailure, Console | Stdin | Files | VmConfig> =>
  Effect.gen(function* () {
    const { program, diagnostics } = yield* compileSource(source);
    const vm = new Vm(program, { fs: yield* Files, ...yield* VmConfig });
    yield* drive(vm, source);
    return { diagnostics, vm };
  });

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

  get currentProgram(): Program | undefined {
    return this.program;
  }

  /** Start from scratch, forgetting all variables and definitions. */
  reset(): void {
    this.transcript = "";
    this.program = undefined;
    this.vm = undefined;
  }

  /** The transcript extended with `input`, compiled; diagnostics are only those about `input`. */
  private compileWith(input: string): { source: Source; program?: Program; diagnostics: Diagnostic[] } {
    const offset = this.transcript.length;
    const source = new Source(this.name, this.transcript + input + "\n");
    const { program, diagnostics } = compile(source, { repl: true });
    return {
      source,
      program,
      diagnostics: diagnostics.sorted().filter((d) => (d.primarySpan()?.start ?? offset) >= offset),
    };
  }

  /** Compile only: what `input` would report, and the types of the values it would print. */
  check(input: string): { diagnostics: readonly Diagnostic[]; echoTypes: readonly string[] } {
    const { program, diagnostics } = this.compileWith(input);
    const code = program?.main.code ?? [];
    const echoTypes = code.slice(this.haltIndex()).filter((ins) => ins.op === Op.Echo)
      .map((ins) => String(program!.main.consts[ins.b]));
    return { diagnostics, echoTypes };
  }

  private haltIndex(): number {
    return this.program ? this.program.main.code.length - 1 : 0;
  }

  submit(
    input: string,
  ): Effect.Effect<SubmitResult, CompileError | RuntimeFailure, Console | Stdin | Files | VmConfig> {
    return Effect.gen(this, function* () {
      const { source, program, diagnostics } = this.compileWith(input);
      if (!program) {
        return yield* Effect.fail(new CompileError({ source, diagnostics: diagnostics.filter((d) => d.isError) }));
      }
      const previous = this.program;
      const from = this.haltIndex();
      // Accept the input before running it: definitions stay even if it fails at run time.
      this.transcript = source.text;
      this.program = program;
      let vm = this.vm;
      if (vm) vm.start(program, from);
      else vm = this.vm = new Vm(program, { fs: yield* Files, ...yield* VmConfig });
      yield* drive(vm, source);
      return { echoes: vm.takeEchoes(), declared: declarations(previous, program), warnings: diagnostics, source };
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

export interface MemoryIo {
  readonly layer: Layer.Layer<Console | Stdin | Files | VmConfig>;
  readonly output: string[];
}

/** I/O services backed by arrays: `inputs` feed INPUT, OUTPUT lines are collected in `output`. */
export function memoryIo(inputs: readonly string[] = [], settings: Partial<VmSettings> = {}): MemoryIo {
  const output: string[] = [];
  const queue = [...inputs];
  const layer = Layer.mergeAll(
    Layer.succeed(Console, { print: (line) => Effect.sync(() => void output.push(line)) }),
    Layer.succeed(Stdin, { readLine: () => Effect.sync(() => Option.fromNullable(queue.shift())) }),
    Layer.succeed(Files, new VirtualFs()),
    Layer.succeed(VmConfig, { sliceSize: 200_000, seed: 42, ...settings }),
  );
  return { layer, output };
}
