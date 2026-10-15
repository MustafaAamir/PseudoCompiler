/**
 * Terminal front end for Deno, mirroring the Rust `pseudo` binary:
 *
 *   deno task run <file>              compile and run
 *   deno task run check <file>        type-check only
 *   deno task run disasm <file>       bytecode with debug info
 *   deno task run tokens <file>       the token stream
 *   deno task run explain <CODE>      explain an error code
 *   deno task run repl                interactive session
 *
 * Options: --stats, --trace, --no-color. Files used by OPENFILE live in memory.
 */

import { Cause, Effect, Exit, Layer, Option } from "effect";
import {
  compile,
  type CompileError,
  Console,
  explain,
  Files,
  Lexer,
  Renderer,
  runSource,
  type RuntimeFailure,
  Session,
  Source,
  Stdin,
  VirtualFs,
  VmConfig,
} from "./mod.ts";

const args = Deno.args.filter((a) => !a.startsWith("--"));
const flags = new Set(Deno.args.filter((a) => a.startsWith("--")));
const color = !flags.has("--no-color") && Deno.stderr.isTerminal() && !Deno.env.get("NO_COLOR");
const encoder = new TextEncoder();
const err = (s: string) => Deno.stderr.writeSync(encoder.encode(s));

/** Lines of standard input, read on demand. */
async function* stdinLines(): AsyncGenerator<string> {
  let buf = "";
  for await (const chunk of Deno.stdin.readable.pipeThrough(new TextDecoderStream())) {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      yield buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
    }
  }
  if (buf) yield buf;
}
const lines = stdinLines();
const renderer = (src: Source) => new Renderer(src, color ? "ansi" : "plain");

const terminal = Layer.mergeAll(
  Layer.succeed(Console, { print: (line) => Effect.sync(() => console.log(line)) }),
  Layer.succeed(Stdin, {
    readLine: () =>
      Effect.promise(() => lines.next()).pipe(Effect.map((r) => (r.done ? Option.none() : Option.some(r.value)))),
  }),
  Layer.succeed(Files, new VirtualFs()),
  Layer.succeed(VmConfig, {
    sliceSize: 1_000_000,
    seed: Deno.env.get("PSEUDO_SEED") ? Number(Deno.env.get("PSEUDO_SEED")) : undefined,
    trace: flags.has("--trace") ? (l: string) => err(l + "\n") : undefined,
  }),
);

function report(e: CompileError | RuntimeFailure): number {
  const r = renderer(e.source);
  if (e._tag === "CompileError") {
    for (const d of e.diagnostics) err(r.render(d) + "\n");
    err(r.summary(e.diagnostics));
    return 1;
  }
  err(r.render(e.error.toDiagnostic()) + "\n");
  return 2;
}

async function read(path: string): Promise<Source> {
  return new Source(path, await Deno.readTextFile(path));
}

async function main(): Promise<number> {
  const [cmd, arg] = args;
  switch (cmd) {
    case "explain": {
      const text = arg ? explain(arg) : undefined;
      if (!text) return err(`error: no explanation for \`${arg}\`\n`), 64;
      console.log(`${arg.toUpperCase()}\n\n${text}`);
      return 0;
    }
    case "tokens": {
      const src = await read(arg);
      const lx = new Lexer(src.text);
      for (;;) {
        const t = lx.nextToken();
        const [l, c] = src.lineCol(t.span.start);
        console.log(
          `${String(l).padStart(4)}:${String(c).padEnd(3)} ${t.lineStart ? "⏎" : " "} ${t.kind.padEnd(12)} ${
            JSON.stringify(src.slice(t.span))
          }`,
        );
        if (t.kind === "eof") return 0;
      }
    }
    case "check":
    case "disasm": {
      const src = await read(arg);
      const { program, diagnostics } = compile(src);
      const r = renderer(src);
      const sorted = diagnostics.sorted();
      for (const d of sorted) err(r.render(d) + "\n");
      err(r.summary(sorted));
      if (!program) return 1;
      if (cmd === "disasm") console.log(program.disassemble(src));
      else err(`\`${src.name}\` type-checks successfully\n`);
      return 0;
    }
    case "repl":
      return await repl();
    case undefined:
      return err("usage: cli.ts [run|check|disasm|tokens|explain|repl] <file>\n"), 64;
    default: {
      const src = await read(cmd === "run" ? arg : cmd);
      const exit = await Effect.runPromiseExit(runSource(src).pipe(Effect.provide(terminal)));
      if (Exit.isSuccess(exit)) {
        const r = renderer(src);
        for (const d of exit.value.diagnostics.sorted()) err(r.render(d) + "\n");
        if (flags.has("--stats")) err(exit.value.vm.report() + "\n");
        return 0;
      }
      const failure = Cause.failureOption(exit.cause);
      if (Option.isSome(failure)) return report(failure.value);
      throw Cause.squash(exit.cause);
    }
  }
}

async function repl(): Promise<number> {
  const session = new Session();
  console.log("pseudo REPL — end a statement with an empty line to run a multi-line block; Ctrl-D quits");
  let pending = "";
  for (;;) {
    Deno.stdout.writeSync(encoder.encode(pending ? "  ... " : "pseudo # "));
    const r = await lines.next();
    if (r.done) return 0;
    pending += r.value + "\n";
    const { diagnostics } = session.check(pending);
    const incomplete = diagnostics.some((d) => d.code === "E0101");
    if (incomplete && r.value.trim() !== "") continue;
    const input = pending.replace(/\n$/, "");
    pending = "";
    const exit = await Effect.runPromiseExit(session.submit(input).pipe(Effect.provide(terminal)));
    if (Exit.isSuccess(exit)) {
      for (const d of exit.value.declared) console.log(`  ${d}`);
      for (const e of exit.value.echoes) console.log(`${e.name} : ${e.ty} = ${e.value}`);
    } else {
      const failure = Cause.failureOption(exit.cause);
      if (Option.isSome(failure)) report(failure.value);
      else throw Cause.squash(exit.cause);
    }
  }
}

Deno.exit(await main());
