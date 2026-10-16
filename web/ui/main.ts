/**
 * The browser playground.
 *
 * RxJS turns DOM events into streams and schedules the work they trigger:
 * highlighting on every edit, a debounced type check, bytecode rendering
 * only while its tab is visible. Running a program is an Effect fiber whose
 * services print into the console and ask for INPUT inline; Stop interrupts
 * the fiber between time slices.
 */

import { Cause, Effect, Exit, Fiber, Option } from "effect";
import {
  BehaviorSubject,
  combineLatest,
  debounceTime,
  distinctUntilChanged,
  filter,
  fromEvent,
  map,
  merge,
  shareReplay,
  skip,
  Subject,
} from "rxjs";
import {
  compile,
  compileSource,
  type Diagnostic,
  drive,
  escapeHtml,
  explain,
  type Program,
  Renderer,
  Source,
  type Span,
  VirtualFs,
  Vm,
} from "../src/mod.ts";
import { $, store } from "./dom.ts";
import { Editor, type Squiggle } from "./editor.ts";
import { mountFiles } from "./files.ts";
import { mountRepl } from "./repl.ts";
import { Terminal, terminalLayer } from "./terminal.ts";

declare global {
  /** Example programs keyed by file name, injected by the build. */
  var PSEUDO_EXAMPLES: Record<string, string> | undefined;
}

const EXAMPLES = globalThis.PSEUDO_EXAMPLES ?? {};
const HELLO = 'DECLARE Name : STRING\nOUTPUT "What is your name?"\nINPUT Name\nOUTPUT "Hello, ", Name\n';
const TABS = ["console", "repl", "problems", "bytecode", "stats", "files"] as const;
type Tab = (typeof TABS)[number];

const fs = new VirtualFs(JSON.parse(store.get("files") ?? "{}"));
const saveFiles = () => store.set("files", JSON.stringify(Object.fromEntries(fs.files)));
const filesChanged$ = new Subject<void>();

const fileName$ = new BehaviorSubject(store.get("file") ?? "program.pseudo");
const tab$ = new BehaviorSubject<Tab>(
  TABS.find((t) => t === (location.hash.slice(1) || store.get("tab"))) ?? "console",
);
const running$ = new BehaviorSubject<Fiber.RuntimeFiber<unknown, unknown> | undefined>(undefined);
/** Where the last run-time error happened, until the next edit. */
const fault$ = new BehaviorSubject<Span | undefined>(undefined);
const lastVm$ = new BehaviorSubject<Vm | undefined>(undefined);

const editor = new Editor(
  $<HTMLTextAreaElement>("source"),
  $("code-layer"),
  $("gutter"),
  store.get("draft") ?? EXAMPLES["basics.pseudo"] ?? HELLO,
  { run, stop },
);

interface Check {
  readonly text: string;
  readonly source: Source;
  readonly program: Program | undefined;
  readonly diagnostics: readonly Diagnostic[];
}

const check$ = combineLatest([editor.text$, fileName$]).pipe(
  debounceTime(150),
  distinctUntilChanged((a, b) => a[0] === b[0] && a[1] === b[1]),
  map(([text, name]): Check => {
    const source = new Source(name, text);
    const { program, diagnostics } = compile(source);
    return { text, source, program, diagnostics: diagnostics.sorted() };
  }),
  shareReplay(1),
);

editor.text$.pipe(skip(1)).subscribe(() => fault$.value && fault$.next(undefined));
editor.text$.pipe(debounceTime(400)).subscribe((t) => store.set("draft", t));
fileName$.subscribe((n) => {
  $("file-name").textContent = n;
  store.set("file", n);
});

// Squiggles only make sense for the text that was checked; while typing, the old ones are hidden.
combineLatest([editor.text$, check$, fault$]).pipe(debounceTime(0)).subscribe(([text, check, fault]) => {
  const squiggles: Squiggle[] = [];
  if (check.text === text) {
    for (const d of check.diagnostics) {
      const span = d.primarySpan();
      if (span) squiggles.push({ span, severity: d.isError ? "error" : "warning" });
    }
  }
  if (fault) squiggles.push({ span: fault, severity: "runtime" });
  editor.render(squiggles);
  $("line-count").textContent = `${text.split("\n").length} lines`;
});

combineLatest([editor.caret$, check$]).subscribe(([caret, check]) => {
  const source = new Source("", editor.text);
  const [line, col] = source.lineCol(caret);
  $("cursor-pos").textContent = `Ln ${line}, Col ${col}`;
  const el = $("cursor-diag");
  const at = (d: Diagnostic) => {
    const s = d.primarySpan();
    return s !== undefined && s.start <= caret && caret <= Math.max(s.end, s.start + 1);
  };
  const onLine = (d: Diagnostic) => {
    const s = d.primarySpan();
    return s !== undefined && source.lineIndex(s.start) === line - 1;
  };
  const here = check.text === editor.text ? check.diagnostics.find(at) ?? check.diagnostics.find(onLine) : undefined;
  el.textContent = here ? `${here.severity}[${here.code}]: ${here.message}` : "";
  el.className = here?.severity ?? "dim";
});

// ---------------------------------------------------------------------------
// Tabs: click or arrow keys; the selected tab is remembered.

const tabButtons = TABS.map((t) => $<HTMLButtonElement>(`tab-${t}`));
merge(...tabButtons.map((b, i) => fromEvent(b, "click").pipe(map(() => TABS[i])))).subscribe((t) => {
  tab$.next(t);
  // Stacked layout: bring the whole tools pane on screen so its input rows are reachable.
  if (matchMedia("(max-width: 860px)").matches) $("tab-console").closest(".pane")!.scrollIntoView({ block: "start" });
});
fromEvent<KeyboardEvent>($("tab-console").parentElement!, "keydown").subscribe((e) => {
  const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
  if (!step) return;
  const next = TABS[(TABS.indexOf(tab$.value) + step + TABS.length) % TABS.length];
  tab$.next(next);
  $(`tab-${next}`).focus();
});
tab$.pipe(distinctUntilChanged()).subscribe((tab) => {
  tabButtons.forEach((b, i) => {
    b.setAttribute("aria-selected", String(TABS[i] === tab));
    b.tabIndex = TABS[i] === tab ? 0 : -1;
  });
  for (const v of document.querySelectorAll<HTMLElement>(".view")) v.hidden = v.dataset.view !== tab;
  store.set("tab", tab);
  if (tab === "repl") $("repl-input").focus({ preventScroll: true });
});

// ---------------------------------------------------------------------------
// Problems and the toolbar summary

check$.subscribe((check) => {
  const errors = check.diagnostics.filter((d) => d.isError).length;
  const warnings = check.diagnostics.length - errors;
  const n = (k: number, w: string) => `${k} ${w}${k === 1 ? "" : "s"}`;
  $("check-summary").innerHTML = errors || warnings
    ? [
      errors && `<span class="e">${n(errors, "error")}</span>`,
      warnings && `<span class="w">${n(warnings, "warning")}</span>`,
    ]
      .filter(Boolean).join("")
    : `<span>0 errors, 0 warnings</span>`;
  const count = $("problem-count");
  count.textContent = errors || warnings ? String(errors || warnings) : "";
  count.className = `count ${errors ? "e" : "w"}`;

  const r = new Renderer(check.source, "html");
  const list = $("problems");
  list.dataset.empty = `No diagnostics: ${check.source.name} compiles with 0 errors and 0 warnings.`;
  list.replaceChildren(...check.diagnostics.map((d) => problem(d, r, check.source)));
});

function problem(d: Diagnostic, r: Renderer, source: Source): HTMLLIElement {
  const li = document.createElement("li");
  li.className = `problem ${d.severity}`;
  const pre = document.createElement("pre");
  pre.innerHTML = r.render(d);
  const actions = document.createElement("div");
  actions.className = "actions";
  li.append(pre, actions);

  const span = d.primarySpan();
  if (span) {
    const show = () => editor.reveal(span.start, span.end);
    pre.title = "Select the primary span in the editor";
    pre.addEventListener("click", show);
    actions.append(textButton(`Go to line ${source.lineIndex(span.start) + 1}`, show));
  }
  const explanation = explain(d.code);
  if (explanation) {
    const box = document.createElement("p");
    box.className = "explanation";
    box.hidden = true;
    box.textContent = explanation;
    const toggle = textButton(`Explain ${d.code}`, () => {
      box.hidden = !box.hidden;
      toggle.textContent = box.hidden ? `Explain ${d.code}` : "Hide explanation";
    });
    actions.append(toggle);
    li.append(box);
  }
  return li;
}

function textButton(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "link";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

// ---------------------------------------------------------------------------
// Bytecode: rendered only while visible; a line with a source position jumps to it.

combineLatest([check$, tab$]).pipe(
  filter(([, tab]) => tab === "bytecode"),
  map(([check]) => check),
  distinctUntilChanged(),
).subscribe((check) => {
  const { program, source } = check;
  const el = $("bytecode");
  if (!program) {
    const n = check.diagnostics.filter((d) => d.isError).length;
    el.innerHTML = `<span class="cm">; no bytecode: compilation of ${escapeHtml(source.name)} failed with ${n} error${
      n === 1 ? "" : "s"
    } (see Problems)</span>`;
    return;
  }
  el.innerHTML = program.disassemble(source).split("\n").map((line) => {
    const loc = /; (\d+):(\d+)$/.exec(line);
    const ins = /^(\s+\d+\s+)([A-Z_]+)(.*?)(\s*; \d+:\d+)?$/.exec(line);
    const html = ins
      ? `${ins[1]}<span class="op">${ins[2]}</span>${escapeHtml(ins[3])}<span class="cm">${ins[4] ?? ""}</span>`
      : line.startsWith(";")
      ? `<span class="cm">${escapeHtml(line)}</span>`
      : /^\S/.test(line)
      ? `<span class="hd">${escapeHtml(line)}</span>`
      : escapeHtml(line);
    return loc ? `<span data-at="${loc[1]}:${loc[2]}">${html}</span>` : html;
  }).join("\n");
});

fromEvent<MouseEvent>($("bytecode"), "click").subscribe((e) => {
  const at = (e.target as HTMLElement).closest<HTMLElement>("[data-at]")?.dataset.at;
  if (!at) return;
  const [line, col] = at.split(":").map(Number);
  const source = new Source("", editor.text);
  let offset = source.lineStart(line - 1) ?? source.text.length;
  for (let c = 1; c < col && offset < source.text.length; c++) {
    offset += source.text.codePointAt(offset)! > 0xffff ? 2 : 1;
  }
  editor.reveal(offset);
});

// ---------------------------------------------------------------------------
// Running

const term = new Terminal($("console"));
const runBtn = $<HTMLButtonElement>("run");
const stopBtn = $<HTMLButtonElement>("stop");

function setStatus(text: string, cls = "", time = "-", instr = "-"): void {
  const el = $("run-state");
  el.textContent = text;
  el.className = cls;
  $("run-time").textContent = time;
  $("run-instr").textContent = instr;
}

function run(): void {
  if (running$.value) return;
  const source = new Source(fileName$.value, editor.text);
  fault$.next(undefined);
  term.clear();
  tab$.next("console");
  setStatus("compiling", "running");

  let vm: Vm | undefined;
  const t0 = performance.now();
  const r = new Renderer(source, "html");
  const program = Effect.gen(function* () {
    const { program, diagnostics } = yield* compileSource(source);
    const warnings = diagnostics.sorted();
    for (const d of warnings) term.html(r.render(d), "diag warning");
    term.print(
      `compiled ${source.name}: 0 errors, ${warnings.length} warning${warnings.length === 1 ? "" : "s"}; ` +
        `${program.main.code.length + program.functions.reduce((n, f) => n + f.code.length, 0)} instructions in ` +
        `${program.functions.length + 1} routine${program.functions.length ? "s" : ""}, ` +
        `${program.globals.length} globals, ${program.shapes.length} shapes`,
      "sys",
    );
    setStatus("running", "running");
    vm = new Vm(program, { fs, seed: (Math.random() * 0x7fffffff) | 1 });
    yield* drive(vm, source);
  }).pipe(
    Effect.provide(
      terminalLayer(term, fs, (waiting) => setStatus(waiting ? "waiting for stdin" : "running", "running")),
    ),
  );

  const fiber = Effect.runFork(program);
  running$.next(fiber);
  fiber.addObserver((exit) => {
    running$.next(undefined);
    saveFiles();
    filesChanged$.next();
    lastVm$.next(vm);
    const ms = performance.now() - t0;
    const time = ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
    const instr = vm ? vm.stats.instructions.toLocaleString("en") : "-";
    const counts = vm
      ? `${instr} instructions, ${vm.stats.calls.toLocaleString("en")} calls, ` +
        `${vm.stats.sends.toLocaleString("en")} sends, max call depth ${vm.stats.maxDepth}, wall time ${time}`
      : "";

    if (Exit.isSuccess(exit)) {
      term.print(`exit 0: halted normally (${counts})`, "sys ok");
      return setStatus("exited 0", "ok", time, instr);
    }
    if (Exit.isInterrupted(exit)) {
      term.print(`exit 130: interrupted by user at a VM slice boundary (${counts})`, "sys bad");
      return setStatus("interrupted", "failed", time, instr);
    }
    const failure = Cause.failureOption(exit.cause);
    if (Option.isNone(failure)) {
      term.print(`internal error (please report): ${Cause.pretty(exit.cause)}`, "sys bad");
      return setStatus("internal error", "failed");
    }
    const e = failure.value;
    if (e._tag === "CompileError") {
      for (const d of e.diagnostics) term.html(r.render(d), d.isError ? "diag" : "diag warning");
      const n = e.diagnostics.filter((d) => d.isError).length;
      term.print(
        `exit 1: compilation of ${source.name} failed with ${n} error${n === 1 ? "" : "s"}; no code was executed`,
        "sys bad",
      );
      return setStatus("compile failed", "failed");
    }
    term.html(r.render(e.error.toDiagnostic()), "diag");
    term.print(
      `exit 2: run-time error ${e.error.fault.code} (${counts}); the faulting expression is marked in the source`,
      "sys bad",
    );
    fault$.next(e.error.span);
    setStatus(`error ${e.error.fault.code}`, "failed", time, instr);
  });
}

function stop(): void {
  if (running$.value) Effect.runFork(Fiber.interrupt(running$.value));
}

fromEvent(runBtn, "click").subscribe(run);
fromEvent(stopBtn, "click").subscribe(stop);
running$.subscribe((fiber) => {
  runBtn.disabled = !!fiber;
  stopBtn.disabled = !fiber;
});
term.print(
  "Console: standard output of the running program. Run (Ctrl+Enter) compiles the editor buffer and executes it " +
    "in slices of 100,000 instructions; INPUT and READ prompt here for standard input. Stop (Esc) interrupts execution.",
  "sys",
);

// ---------------------------------------------------------------------------
// Stats

lastVm$.subscribe((vm) => {
  const el = $("stats");
  if (!vm) {
    el.innerHTML =
      `<p class="empty">No execution data. Run the program to record instruction and call counts, the state of every ` +
      `message-send inline cache (monomorphic, polymorphic or megamorphic) and the final values of its globals.</p>`;
    return;
  }
  const s = vm.stats;
  const figure = (n: number, label: string) => `<div><b>${n.toLocaleString("en")}</b><span>${label}</span></div>`;
  const sites = vm.sendSites();
  const globals = vm.globalsView();
  const rows = (cells: string[][]) => cells.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
  el.innerHTML = `
    <section>
      <h3>Execution</h3>
      <div class="figures">
        ${figure(s.instructions, "instructions")}
        ${figure(s.calls, "calls")}
        ${figure(s.sends, "message sends")}
        ${figure(s.maxDepth, "max call depth")}
        ${figure(s.monoHits, "monomorphic hits")}
        ${figure(s.polyHits, "polymorphic hits")}
        ${figure(s.globalCacheHits, "global cache hits")}
        ${figure(s.fullLookups + s.megaLookups, "full lookups")}
      </div>
    </section>
    <section>
      <h3>Send sites: ${sites.length} of ${vm.program.numSites} executed</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Site</th><th>Cache</th><th>Receiver classes</th></tr></thead>
        <tbody>${
    rows(sites.map((x) => [
      `@ic${x.site}`,
      `<span class="state ${x.state}">${x.state}</span>`,
      escapeHtml(x.classes.join(", ") || "(any)"),
    ])) || `<tr><td colspan="3" class="dim">No message sends were executed.</td></tr>`
  }</tbody>
      </table></div>
    </section>
    <section>
      <h3>Globals at exit</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Type</th><th>Value</th></tr></thead>
        <tbody>${
    rows(globals.map((g) => [escapeHtml(g.name), escapeHtml(g.ty), escapeHtml(g.value)])) ||
    `<tr><td colspan="3" class="dim">The program declares no globals.</td></tr>`
  }</tbody>
      </table></div>
    </section>`;
});

// ---------------------------------------------------------------------------
// Examples, files, REPL

const picker = $<HTMLSelectElement>("example");
picker.innerHTML = `<option value="">Load example</option>` +
  [...Object.keys(EXAMPLES), "hello.pseudo"].map((n) => `<option>${escapeHtml(n)}</option>`).join("");
fromEvent(picker, "change").subscribe(() => {
  if (picker.value) {
    fileName$.next(picker.value);
    editor.text = EXAMPLES[picker.value] ?? HELLO;
  }
  picker.value = "";
});

mountFiles(fs, filesChanged$, saveFiles);
mountRepl(fs, filesChanged$);
