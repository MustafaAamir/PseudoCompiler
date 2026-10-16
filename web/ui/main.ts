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
import { badge, diagnosticCard, emptyState, eventCard, h, rich, shortcuts, type Tone } from "./components.ts";

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
  el.replaceChildren(
    ...(here ? [badge(here.code, here.isError ? "err" : "warn"), rich(here.message)] : []),
  );
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
  $("check-summary").replaceChildren(
    ...(errors || warnings
      ? [errors && badge(n(errors, "error"), "err"), warnings && badge(n(warnings, "warning"), "warn")]
        .filter((b): b is HTMLSpanElement => !!b)
      : [badge("No problems", "ok")]),
  );
  const count = $("problem-count");
  count.textContent = errors || warnings ? String(errors || warnings) : "";
  count.className = `count ${errors ? "e" : "w"}`;

  const r = new Renderer(check.source, "html");
  const list = $("problems");
  if (!check.diagnostics.length) {
    return list.replaceChildren(h(
      "li",
      {},
      emptyState(
        "No problems",
        `\`${check.source.name}\` type-checks with no errors or warnings. Diagnostics appear here as you edit.`,
      ),
    ));
  }
  list.replaceChildren(...check.diagnostics.map((d) => h("li", {}, problem(d, r, check.source))));
});

function problem(d: Diagnostic, r: Renderer, source: Source): HTMLElement {
  const actions = h("div", { className: "actions" });
  const card = diagnosticCard(d, r, actions);
  const span = d.primarySpan();
  if (span) {
    const show = () => editor.reveal(span.start, span.end);
    card.querySelector("pre")!.addEventListener("click", show);
    actions.append(
      h(
        "button",
        { type: "button", className: "link", onclick: show },
        `Go to line ${source.lineIndex(span.start) + 1}`,
      ),
    );
  }
  const explanation = explain(d.code);
  if (explanation) {
    const box = h("p", { className: "explanation", hidden: true }, explanation);
    const toggle = h("button", {
      type: "button",
      className: "link",
      onclick: () => {
        box.hidden = !box.hidden;
        toggle.textContent = box.hidden ? `Explain ${d.code}` : "Hide explanation";
      },
    }, `Explain ${d.code}`);
    actions.append(toggle);
    card.append(box);
  }
  return card;
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
    el.replaceChildren(emptyState(
      "No bytecode",
      `\`${source.name}\` has ${n} compile error${n === 1 ? "" : "s"}. Bytecode is generated once it compiles; ` +
        "see Problems for details.",
    ));
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

function setStatus(text: string, tone: Tone = "neutral", time = "-", instr = "-"): void {
  $("run-state").replaceChildren(badge(text, tone));
  $("run-time").textContent = time;
  $("run-instr").textContent = instr;
}

function run(): void {
  if (running$.value) return;
  const source = new Source(fileName$.value, editor.text);
  fault$.next(undefined);
  term.clear();
  tab$.next("console");
  setStatus("Compiling", "info");

  let vm: Vm | undefined;
  const t0 = performance.now();
  const r = new Renderer(source, "html");
  const program = Effect.gen(function* () {
    const { program, diagnostics } = yield* compileSource(source);
    const warnings = diagnostics.sorted();
    term.add(eventCard({
      tone: "info",
      badge: "Compiled",
      title: source.name,
      figures: [
        ["Bytecode", program.main.code.length + program.functions.reduce((n, f) => n + f.code.length, 0)],
        ["Routines", program.functions.length + 1],
        ["Globals", program.globals.length],
        ["Classes and types", program.shapes.length],
        ["Warnings", warnings.length],
      ],
    }));
    for (const d of warnings) term.add(diagnosticCard(d, r));
    setStatus("Running", "info");
    vm = new Vm(program, { fs, seed: (Math.random() * 0x7fffffff) | 1 });
    yield* drive(vm, source);
  }).pipe(
    Effect.provide(
      terminalLayer(term, fs, (waiting) => setStatus(waiting ? "Waiting for input" : "Running", "info")),
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
    const figures: [string, string | number][] = vm
      ? [
        ["Instructions", vm.stats.instructions],
        ["Calls", vm.stats.calls],
        ["Message sends", vm.stats.sends],
        ["Max call depth", vm.stats.maxDepth],
        ["Wall time", time],
      ]
      : [];

    if (Exit.isSuccess(exit)) {
      term.add(eventCard({ tone: "ok", badge: "Exit 0", title: "Halted normally", figures }));
      return setStatus("Exited 0", "ok", time, instr);
    }
    if (Exit.isInterrupted(exit)) {
      term.add(eventCard({
        tone: "warn",
        badge: "Exit 130",
        title: "Interrupted",
        detail: "Execution was stopped at a VM time-slice boundary. Output produced so far is kept above.",
        figures,
      }));
      return setStatus("Interrupted", "warn", time, instr);
    }
    const failure = Cause.failureOption(exit.cause);
    if (Option.isNone(failure)) {
      term.add(eventCard({
        tone: "err",
        badge: "Internal",
        title: "Internal error in the playground",
        detail: Cause.pretty(exit.cause),
      }));
      return setStatus("Internal error", "err");
    }
    const e = failure.value;
    if (e._tag === "CompileError") {
      for (const d of e.diagnostics) term.add(diagnosticCard(d, r));
      const n = e.diagnostics.filter((d) => d.isError).length;
      term.add(eventCard({
        tone: "err",
        badge: "Exit 1",
        title: "Compilation failed",
        detail: `\`${source.name}\` has ${n} error${n === 1 ? "" : "s"}; no code was executed.`,
      }));
      return setStatus("Compile failed", "err");
    }
    term.add(diagnosticCard(e.error.toDiagnostic(), r));
    term.add(eventCard({
      tone: "err",
      badge: "Exit 2",
      title: `Run-time error ${e.error.fault.code}`,
      detail: "The faulting expression is highlighted in the editor.",
      figures,
    }));
    fault$.next(e.error.span);
    setStatus(`Error ${e.error.fault.code}`, "err", time, instr);
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
term.add(emptyState(
  "Console",
  "Standard output of the running program appears here. Run compiles the editor buffer and executes it in " +
    "slices of 100,000 instructions; `INPUT` statements ask for values in this panel.",
  shortcuts([["Ctrl+Enter", "Run"], ["Esc", "Stop"], ["Ctrl+D", "End of input"]]),
));
setStatus("Idle");

// ---------------------------------------------------------------------------
// Stats

lastVm$.subscribe((vm) => {
  const el = $("stats");
  if (!vm) {
    el.replaceChildren(emptyState(
      "No execution data",
      "Run the program to record instruction and call counts, the state of every message-send inline cache " +
        "(monomorphic, polymorphic or megamorphic) and the final values of its globals.",
    ));
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
      `<span class="badge ${
        { monomorphic: "ok", polymorphic: "warn", megamorphic: "err" }[x.state]
      }">${x.state}</span>`,
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
