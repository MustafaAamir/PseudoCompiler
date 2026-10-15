/**
 * The browser playground.
 *
 * RxJS turns DOM events into streams (edits, cursor moves, key presses, tab
 * switches) and schedules the work they trigger: highlighting on every edit,
 * a debounced type check, bytecode rendering only while its tab is visible.
 * Running a program is an Effect fiber whose services print into the console
 * and ask for INPUT inline; Stop interrupts the fiber between time slices.
 */

import { Cause, Effect, Exit, Fiber, Layer, Option } from "effect";
import {
  BehaviorSubject,
  combineLatest,
  debounceTime,
  distinctUntilChanged,
  filter,
  fromEvent,
  map,
  merge,
  type Observable,
  shareReplay,
  skip,
  Subject,
} from "rxjs";
import {
  BUILTINS,
  compile,
  compileSource,
  Console,
  type Diagnostic,
  drive,
  explain,
  Files,
  KEYWORDS,
  type Program,
  Renderer,
  Session,
  Source,
  type Span,
  Stdin,
  VirtualFs,
  Vm,
  VmConfig,
} from "../src/mod.ts";
import { highlight, type Mark } from "./highlight.ts";
import { Terminal } from "./terminal.ts";

declare global {
  /** Example programs, keyed by file name; injected by the build. */
  var PSEUDO_EXAMPLES: Record<string, string> | undefined;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// Browser storage is a convenience: it can be missing or throw, and the page works without it.
const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`pseudo.${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(`pseudo.${key}`, value);
    } catch {
      // Storage full or blocked: nothing to persist to.
    }
  },
};

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

const EXAMPLES: Record<string, string> = globalThis.PSEUDO_EXAMPLES ?? {};
const HELLO = 'DECLARE Name : STRING\nOUTPUT "What is your name?"\nINPUT Name\nOUTPUT "Hello, ", Name\n';

const fs = new VirtualFs(JSON.parse(store.get("files") ?? "{}"));
const saveFiles = () => store.set("files", JSON.stringify(Object.fromEntries(fs.files)));

const fileName$ = new BehaviorSubject(store.get("file") ?? "program.pseudo");
const text$ = new BehaviorSubject(store.get("draft") ?? EXAMPLES["basics.pseudo"] ?? HELLO);
/** The span of the last run-time error, until the next edit. */
const runtimeMark$ = new BehaviorSubject<Span | undefined>(undefined);
const tab$ = new BehaviorSubject(location.hash.slice(1) || store.get("tab") || "console");
const running$ = new BehaviorSubject<Fiber.RuntimeFiber<unknown, unknown> | undefined>(undefined);
const runState$ = new BehaviorSubject<{ text: string; cls?: string }>({ text: "Ready" });
const lastVm$ = new BehaviorSubject<Vm | undefined>(undefined);
const filesChanged$ = new Subject<void>();

interface Check {
  readonly text: string;
  readonly source: Source;
  readonly program: Program | undefined;
  readonly diagnostics: readonly Diagnostic[];
}

const check$: Observable<Check> = combineLatest([text$, fileName$]).pipe(
  debounceTime(160),
  distinctUntilChanged((a, b) => a[0] === b[0] && a[1] === b[1]),
  map(([text, name]) => {
    const source = new Source(name, text);
    const { program, diagnostics } = compile(source);
    return { text, source, program, diagnostics: diagnostics.sorted() };
  }),
  shareReplay({ bufferSize: 1, refCount: false }),
);

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

const ta = $<HTMLTextAreaElement>("source");
const codeLayer = $("code-layer");
const gutter = $("gutter");
const editor = $("editor");
ta.value = text$.value;

fromEvent(ta, "input").subscribe(() => text$.next(ta.value));
text$.pipe(skip(1)).subscribe(() => runtimeMark$.value && runtimeMark$.next(undefined));
text$.pipe(debounceTime(400)).subscribe((t) => store.set("draft", t));
fileName$.subscribe((n) => {
  $("file-name").textContent = n;
  store.set("file", n);
});

function loadProgram(name: string, text: string): void {
  ta.value = text;
  ta.scrollTop = 0;
  fileName$.next(name);
  text$.next(text);
}

/** Squiggles are only drawn when the check is of the text on screen. */
function squiggles(text: string, check: Check | undefined, runtime: Span | undefined): Mark[] {
  const widen = (s: Span, cls: string): Mark => {
    if (s.end > s.start) return { start: s.start, end: s.end, cls };
    return s.start < text.length && text[s.start] !== "\n"
      ? { start: s.start, end: s.start + 1, cls }
      : { start: Math.max(0, s.start - 1), end: s.start, cls };
  };
  const marks: Mark[] = [];
  if (check && check.text === text) {
    for (const d of check.diagnostics) {
      const s = d.primarySpan();
      if (s) marks.push(widen(s, d.isError ? "sq-error" : "sq-warning"));
    }
  }
  if (runtime) marks.push(widen(runtime, "sq-runtime"));
  return marks;
}

let latestCheck: Check | undefined;
check$.subscribe((c) => (latestCheck = c));

combineLatest([text$, merge(check$, new BehaviorSubject(undefined)), runtimeMark$]).pipe(
  debounceTime(0),
).subscribe(([text, check, runtime]) => {
  codeLayer.innerHTML = highlight(text, squiggles(text, check ?? latestCheck, runtime));
  const lines = text.split("\n").length;
  const bad = new Map<number, string>();
  if (check && check.text === text) {
    for (const d of [...check.diagnostics].reverse()) {
      const s = d.primarySpan();
      if (s) bad.set(check.source.lineIndex(s.start), d.isError ? "has-error" : "has-warning");
    }
  }
  let html = "";
  for (let i = 0; i < lines; i++) html += bad.has(i) ? `<span class="${bad.get(i)}">${i + 1}</span>\n` : `${i + 1}\n`;
  gutter.innerHTML = html;
  syncScroll();
});

function syncScroll(): void {
  codeLayer.scrollTop = ta.scrollTop;
  codeLayer.scrollLeft = ta.scrollLeft;
  gutter.scrollTop = ta.scrollTop;
  const lh = lineHeight();
  editor.style.setProperty("--ruling-offset", `${10 - (ta.scrollTop % lh)}px`);
}
fromEvent(ta, "scroll").subscribe(syncScroll);

function lineHeight(): number {
  return parseFloat(getComputedStyle(ta).lineHeight) || 21;
}

/** Insert text at the caret, keeping the browser's undo history where possible. */
function insert(field: HTMLTextAreaElement, text: string): void {
  if (!document.execCommand("insertText", false, text)) {
    field.setRangeText(text, field.selectionStart, field.selectionEnd, "end");
    field.dispatchEvent(new Event("input"));
  }
}

const OPENS_BLOCK =
  /^(IF|ELSE|WHILE|REPEAT|FOR|CASE|OTHERWISE|PROCEDURE|FUNCTION|CLASS|((PUBLIC|PRIVATE)\s+(PROCEDURE|FUNCTION))|TYPE\s+\w+\s*$)\b/;

function currentLine(field: HTMLTextAreaElement): string {
  const before = field.value.slice(0, field.selectionStart);
  return before.slice(before.lastIndexOf("\n") + 1);
}

/** Editing keys shared by the editor and the REPL input. */
function editingKey(field: HTMLTextAreaElement, e: KeyboardEvent): boolean {
  if (e.key === "-" && !e.ctrlKey && !e.metaKey && field.value[field.selectionStart - 1] === "<") {
    field.setSelectionRange(field.selectionStart - 1, field.selectionEnd);
    insert(field, "←");
    return true;
  }
  if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && field === ta) {
    insert(field, "    ");
    return true;
  }
  return false;
}

const CLOSES_BLOCK = /^(END[A-Z]+|ELSE|UNTIL|NEXT|OTHERWISE)\b/;

/** A terminator typed at the body's indentation moves back out to its block's. */
function dedentTerminator(field: HTMLTextAreaElement): void {
  const line = currentLine(field);
  const before = field.value.slice(0, field.selectionStart - line.length);
  const previous = before.slice(before.lastIndexOf("\n", before.length - 2) + 1);
  if (
    CLOSES_BLOCK.test(line.trim()) && /^ {4}/.test(line) &&
    /^ */.exec(previous)![0].length >= /^ */.exec(line)![0].length
  ) {
    const caret = field.selectionStart;
    const start = caret - line.length;
    field.setSelectionRange(start, start + 4);
    insert(field, "");
    field.setSelectionRange(caret - 4, caret - 4);
  }
}

function newlineWithIndent(field: HTMLTextAreaElement): void {
  dedentTerminator(field);
  const line = currentLine(field);
  const indent = /^\s*/.exec(line)![0];
  insert(field, "\n" + indent + (OPENS_BLOCK.test(line.trim()) ? "    " : ""));
}

fromEvent<KeyboardEvent>(ta, "keydown").subscribe((e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    run();
  } else if (e.key === "Escape" && running$.value) {
    e.preventDefault();
    stop();
  } else if (editingKey(ta, e)) {
    e.preventDefault();
  } else if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    newlineWithIndent(ta);
  } else if (e.key === "Tab" && e.shiftKey) {
    e.preventDefault();
    const start = ta.value.lastIndexOf("\n", ta.selectionStart - 1) + 1;
    const n = /^ {0,4}/.exec(ta.value.slice(start))![0].length;
    if (n) {
      const caret = ta.selectionStart;
      ta.setSelectionRange(start, start + n);
      insert(ta, "");
      ta.setSelectionRange(caret - n, caret - n);
    }
  }
});

/** Select a span in the editor and scroll it into view. */
function reveal(start: number, end = start): void {
  const line = ta.value.slice(0, start).split("\n").length - 1;
  ta.focus({ preventScroll: true });
  ta.setSelectionRange(start, Math.max(start, end));
  ta.scrollTop = Math.max(0, line * lineHeight() - ta.clientHeight / 3);
  syncScroll();
  if (matchMedia("(max-width: 820px)").matches) editor.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function offsetOf(source: Source, line: number, col: number): number {
  let at = source.lineStart(line - 1) ?? source.text.length;
  for (let c = 1; c < col && at < source.text.length && source.text[at] !== "\n"; c++) {
    at += source.text.codePointAt(at)! > 0xffff ? 2 : 1;
  }
  return at;
}

// Cursor position and the diagnostic under it.
const cursor$ = merge(
  fromEvent(document, "selectionchange").pipe(filter(() => document.activeElement === ta)),
  fromEvent(ta, "keyup"),
  fromEvent(ta, "click"),
  text$,
).pipe(map(() => ta.selectionStart), distinctUntilChanged());

combineLatest([cursor$, check$]).subscribe(([pos, check]) => {
  const src = new Source("", ta.value);
  const [line, col] = src.lineCol(pos);
  $("cursor-pos").textContent = `${line}:${col}`;
  const el = $("cursor-diag");
  const here = check.text === ta.value
    ? check.diagnostics.find((d) => {
      const s = d.primarySpan();
      return s && s.start <= pos && pos <= Math.max(s.end, s.start + 1);
    }) ?? check.diagnostics.find((d) => {
      const s = d.primarySpan();
      return s && src.lineIndex(s.start) === line - 1;
    })
    : undefined;
  if (here) {
    el.textContent = `${here.code}: ${here.message}`;
    el.className = `cursor-diag ${here.severity}`;
  } else if (el.classList.length > 1) {
    el.textContent = check.diagnostics.length ? "" : "No problems";
    el.className = "cursor-diag";
  }
});

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

const tabButtons = [...document.querySelectorAll<HTMLButtonElement>(".tabs [data-tab]")];
merge(...tabButtons.map((b) => fromEvent(b, "click").pipe(map(() => b.dataset.tab!)))).subscribe((t) => tab$.next(t));
tab$.pipe(distinctUntilChanged()).subscribe((tab) => {
  if (!tabButtons.some((b) => b.dataset.tab === tab)) return tab$.next("console");
  for (const b of tabButtons) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  for (const v of document.querySelectorAll<HTMLElement>(".view")) v.hidden = v.dataset.view !== tab;
  store.set("tab", tab);
  if (tab === "repl") replIn.focus({ preventScroll: true });
});

// ---------------------------------------------------------------------------
// Problems, summary, bytecode
// ---------------------------------------------------------------------------

check$.subscribe((check) => {
  const errors = check.diagnostics.filter((d) => d.isError).length;
  const warnings = check.diagnostics.length - errors;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const parts = [
    errors && `<span class="e">${plural(errors, "error")}</span>`,
    warnings && `<span class="w">${plural(warnings, "warning")}</span>`,
  ]
    .filter(Boolean);
  $("check-summary").innerHTML = parts.length ? parts.join(" · ") : `<span class="ok">Type-checks</span>`;
  const count = $("problem-count");
  count.textContent = errors || warnings ? String(errors || warnings) : "";
  count.className = `count ${errors ? "e" : warnings ? "w" : ""}`;

  const r = new Renderer(check.source, "html");
  const list = $("problems");
  list.replaceChildren(...check.diagnostics.map((d) => problemItem(d, r, check.source)));
});

function problemItem(d: Diagnostic, r: Renderer, source: Source): HTMLLIElement {
  const li = document.createElement("li");
  li.className = `problem ${d.severity}`;
  const pre = document.createElement("pre");
  pre.innerHTML = r.render(d);
  const span = d.primarySpan();
  pre.title = "Show in the editor";
  pre.addEventListener("click", () => span && reveal(span.start, span.end));
  const actions = document.createElement("div");
  actions.className = "problem-actions";
  if (span) {
    const go = button(`Go to line ${source.lineIndex(span.start) + 1}`, () => reveal(span.start, span.end));
    actions.append(go);
  }
  const text = explain(d.code);
  if (text) {
    const box = document.createElement("div");
    box.className = "explanation";
    box.hidden = true;
    box.textContent = text;
    const toggle = button(`Explain ${d.code}`, () => {
      box.hidden = !box.hidden;
      toggle.textContent = box.hidden ? `Explain ${d.code}` : "Hide explanation";
    });
    actions.append(toggle);
    li.append(pre, actions, box);
  } else li.append(pre, actions);
  return li;
}

function button(label: string, onClick: () => void, cls = "link"): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot" }[c]};`);

combineLatest([check$, tab$]).pipe(filter(([, tab]) => tab === "bytecode"), map(([c]) => c), distinctUntilChanged())
  .subscribe((check) => {
    const el = $("bytecode");
    if (!check.program) {
      el.innerHTML = `<span class="cm">; the program has errors: fix them to see its bytecode</span>`;
      return;
    }
    el.innerHTML = check.program.disassemble(check.source).split("\n").map((line) => {
      const loc = /; (\d+):(\d+)$/.exec(line);
      const ins = /^(\s+\d+\s+)([A-Z_]+)(.*)$/.exec(line);
      const body = ins
        ? `${ins[1]}<span class="op">${ins[2]}</span>${
          escape(ins[3]).replace(/(; \d+:\d+)$/, '<span class="cm">$1</span>')
        }`
        : line.startsWith(";")
        ? `<span class="cm">${escape(line)}</span>`
        : /^\S/.test(line)
        ? `<span class="hd">${escape(line)}</span>`
        : escape(line);
      return loc ? `<span data-at="${loc[1]}:${loc[2]}">${body}</span>` : body;
    }).join("\n");
  });

fromEvent<MouseEvent>($("bytecode"), "click").subscribe((e) => {
  const at = (e.target as HTMLElement).closest<HTMLElement>("[data-at]")?.dataset.at;
  if (!at || !latestCheck) return;
  const [l, c] = at.split(":").map(Number);
  reveal(offsetOf(latestCheck.source, l, c));
});

// ---------------------------------------------------------------------------
// Running programs
// ---------------------------------------------------------------------------

const term = new Terminal($("console"));

function ioLayer(t: Terminal, onAsk?: (waiting: boolean) => void) {
  return Layer.mergeAll(
    Layer.succeed(Console, { print: (line) => Effect.sync(() => t.print(line)) }),
    Layer.succeed(Stdin, {
      readLine: (req) =>
        Effect.async<Option.Option<string>>((resume) => {
          onAsk?.(true);
          const withdraw = t.ask(req.type, (line) => {
            onAsk?.(false);
            resume(Effect.succeed(Option.fromNullable(line)));
          });
          return Effect.sync(() => {
            onAsk?.(false);
            withdraw();
          });
        }),
    }),
    Layer.succeed(Files, fs),
    Layer.succeed(VmConfig, { sliceSize: 100_000 }),
  );
}

const ms = (t: number) => (t < 1000 ? `${Math.round(t)} ms` : `${(t / 1000).toFixed(2)} s`);

function run(): void {
  if (running$.value) return;
  const source = new Source(fileName$.value, ta.value);
  runtimeMark$.next(undefined);
  term.clear();
  tab$.next("console");
  term.print(`Running ${source.name}`, "sys");
  let vm: Vm | undefined;
  const t0 = performance.now();
  const program = Effect.gen(function* () {
    const { program } = yield* compileSource(source);
    vm = new Vm(program, { fs, seed: (Math.random() * 0x7fffffff) | 1 });
    yield* drive(vm, source);
  }).pipe(
    Effect.provide(
      ioLayer(
        term,
        (waiting) =>
          runState$.next(waiting ? { text: "Waiting for input", cls: "running" } : { text: "Running", cls: "running" }),
      ),
    ),
  );

  runState$.next({ text: "Running", cls: "running" });
  const fiber = Effect.runFork(program);
  running$.next(fiber);
  fiber.addObserver((exit) => {
    running$.next(undefined);
    const took = ms(performance.now() - t0);
    const steps = vm ? ` · ${vm.stats.instructions.toLocaleString("en")} instructions` : "";
    fs.files.size && saveFiles();
    filesChanged$.next();
    lastVm$.next(vm);
    if (Exit.isSuccess(exit)) {
      term.print(`Finished in ${took}${steps}`, "sys ok");
      runState$.next({ text: `Finished in ${took}` });
      return;
    }
    if (Exit.isInterrupted(exit)) {
      term.print(`Stopped after ${took}${steps}`, "sys bad");
      runState$.next({ text: "Stopped", cls: "failed" });
      return;
    }
    const failure = Cause.failureOption(exit.cause);
    if (Option.isNone(failure)) {
      term.print(`Internal error: ${String(Cause.squash(exit.cause))}`, "sys bad");
      runState$.next({ text: "Internal error", cls: "failed" });
      return;
    }
    const e = failure.value;
    const r = new Renderer(source, "html");
    if (e._tag === "CompileError") {
      const n = e.diagnostics.filter((d) => d.isError).length;
      term.print(`Did not run: ${n} error${n === 1 ? "" : "s"}`, "sys bad");
      for (const d of e.diagnostics) term.html(r.render(d), "diag");
      runState$.next({ text: "Compile errors", cls: "failed" });
    } else {
      term.html(r.render(e.error.toDiagnostic()), "diag");
      term.print(`Run-time error after ${took}${steps}`, "sys bad");
      runtimeMark$.next(e.error.span);
      runState$.next({ text: `Run-time error ${e.error.code}`, cls: "failed" });
    }
  });
}

function stop(): void {
  const fiber = running$.value;
  if (fiber) Effect.runFork(Fiber.interrupt(fiber));
}

const runBtn = $<HTMLButtonElement>("run");
const stopBtn = $<HTMLButtonElement>("stop");
fromEvent(runBtn, "click").subscribe(run);
fromEvent(stopBtn, "click").subscribe(stop);
running$.subscribe((f) => {
  runBtn.disabled = !!f;
  stopBtn.disabled = !f;
});
runState$.subscribe(({ text, cls }) => {
  const el = $("run-state");
  el.textContent = text;
  el.className = `run-state ${cls ?? ""}`;
});

term.print("Press Run or Ctrl+Enter to compile and run the program. OUTPUT appears here; INPUT asks inline.", "sys");

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

lastVm$.subscribe((vm) => {
  const el = $("stats");
  if (!vm) {
    el.innerHTML =
      `<p class="empty">Run a program to see how many instructions it executed and how its message sends were cached.</p>`;
    return;
  }
  const s = vm.stats;
  const tile = (n: number, label: string) =>
    `<div class="stat"><b>${n.toLocaleString("en")}</b><span>${label}</span></div>`;
  const sites = vm.sendSites();
  const pill = { monomorphic: "mono", polymorphic: "poly", megamorphic: "mega" } as const;
  const globals = vm.globalsView();
  el.innerHTML = `
    <div class="stat-grid">
      ${tile(s.instructions, "instructions executed")}
      ${tile(s.calls, "procedure and function calls")}
      ${tile(s.sends, "message sends")}
      ${tile(s.monoHits + s.polyHits, "inline cache hits")}
      ${tile(s.globalCacheHits, "global cache hits")}
      ${tile(s.fullLookups, "full method lookups")}
      ${tile(s.megaLookups, "megamorphic lookups")}
      ${tile(s.maxDepth, "deepest call stack")}
    </div>
    <h3>Send sites (${sites.length} of ${vm.program.numSites} executed)</h3>
    <pre class="sites">${
    sites.length
      ? sites.map((x) =>
        `@ic${String(x.site).padEnd(4)} <span class="pill ${pill[x.state]}">${x.state}</span>  ${
          escape(x.classes.join(", "))
        }`
      )
        .join("\n")
      : "no message sends ran"
  }</pre>
    <h3>Globals at exit</h3>
    <pre class="sites">${
    globals.map((g) => `${escape(g.name)} : ${escape(g.ty)} = ${escape(g.value)}`).join("\n") || "none"
  }</pre>`;
});

// ---------------------------------------------------------------------------
// Virtual files
// ---------------------------------------------------------------------------

const fileList = $("file-list");
const fileText = $<HTMLTextAreaElement>("file-text");
const fileDelete = $<HTMLButtonElement>("file-delete");
const openFile$ = new BehaviorSubject<string | undefined>(undefined);

merge(filesChanged$, openFile$).subscribe(() => {
  const open = openFile$.value;
  fileList.replaceChildren(
    ...[...fs.files.keys()].sort().map((name) => {
      const li = document.createElement("li");
      const b = button("", () => openFile$.next(name), "");
      b.innerHTML = `<span>${escape(name)}</span><small>${
        fs.files.get(name)!.split("\n").filter(Boolean).length
      } lines</small>`;
      b.setAttribute("aria-current", String(name === open));
      li.append(b);
      return li;
    }),
  );
  $("file-open-name").textContent = open ?? "No file selected";
  fileText.disabled = !open || !fs.files.has(open);
  fileText.value = open ? fs.files.get(open) ?? "" : "";
  fileDelete.hidden = !open;
  fileDelete.textContent = "Delete";
});
fromEvent(fileText, "input").pipe(debounceTime(200)).subscribe(() => {
  const open = openFile$.value;
  if (open) {
    fs.files.set(open, fileText.value);
    saveFiles();
  }
});
fromEvent(fileDelete, "click").subscribe(() => {
  const open = openFile$.value;
  if (!open) return;
  if (fileDelete.textContent === "Delete") {
    fileDelete.textContent = `Delete ${open}?`;
    return;
  }
  fs.files.delete(open);
  saveFiles();
  openFile$.next(undefined);
});
fromEvent<SubmitEvent>($("new-file"), "submit").subscribe((e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>("new-file-name");
  const name = input.value.trim();
  if (!name) return;
  if (!fs.files.has(name)) fs.files.set(name, "");
  saveFiles();
  input.value = "";
  openFile$.next(name);
  fileText.focus();
});

// ---------------------------------------------------------------------------
// Examples
// ---------------------------------------------------------------------------

const picker = $<HTMLSelectElement>("example");
picker.innerHTML = `<option value="">Examples…</option>` +
  Object.keys(EXAMPLES).map((n) => `<option value="${escape(n)}">${escape(n)}</option>`).join("") +
  `<option value="hello.pseudo">hello.pseudo</option>`;
fromEvent(picker, "change").subscribe(() => {
  const name = picker.value;
  if (name) loadProgram(name, EXAMPLES[name] ?? HELLO);
  picker.value = "";
});

// ---------------------------------------------------------------------------
// REPL
// ---------------------------------------------------------------------------

const replTerm = new Terminal($("repl-log"));
const replIn = $<HTMLTextAreaElement>("repl-input");
const replHint = $("repl-hint");
const session = new Session("repl");
const replBusy$ = new BehaviorSubject<Fiber.RuntimeFiber<unknown, unknown> | undefined>(undefined);
const history: string[] = JSON.parse(store.get("history") ?? "[]");
let historyAt = history.length;

function replHighlight(line: string): string {
  return highlight(line).replace(/\n$/, "");
}

function submitRepl(input: string, remember = true): Promise<void> {
  if (replBusy$.value) return Promise.resolve();
  input.split("\n").forEach((line, i) => replTerm.html(replHighlight(line), i ? "in cont" : "in"));
  if (remember && input.trim() && history[history.length - 1] !== input) {
    history.push(input);
    store.set("history", JSON.stringify(history.slice(-200)));
  }
  historyAt = history.length;
  const fiber = Effect.runFork(session.submit(input).pipe(Effect.provide(ioLayer(replTerm))));
  replBusy$.next(fiber);
  return new Promise((done) =>
    fiber.addObserver((exit) => {
      done();
      replBusy$.next(undefined);
      filesChanged$.next();
      if (Exit.isSuccess(exit)) {
        const { declared, echoes, warnings, source } = exit.value;
        const r = new Renderer(source, "html");
        for (const w of warnings) replTerm.html(r.render(w), "diag");
        for (const d of declared) {
          const m = /^(\w+) : (.*)$/.exec(d);
          replTerm.html(
            m ? `<span class="nm">${escape(m[1])}</span> : <span class="ty">${escape(m[2])}</span>` : escape(d),
            "decl",
          );
        }
        for (const e of echoes) {
          replTerm.html(
            `<span class="nm">${escape(e.name)}</span> : <span class="ty">${escape(e.ty)}</span> = ${escape(e.value)}`,
            "val",
          );
        }
      } else if (Exit.isInterrupted(exit)) {
        replTerm.print("Interrupted", "sys bad");
      } else {
        const failure = Cause.failureOption(exit.cause);
        if (Option.isNone(failure)) replTerm.print(`Internal error: ${String(Cause.squash(exit.cause))}`, "sys bad");
        else if (failure.value._tag === "CompileError") {
          const r = new Renderer(failure.value.source, "html");
          for (const d of failure.value.diagnostics) replTerm.html(r.render(d), "diag");
        } else {
          const r = new Renderer(failure.value.source, "html");
          replTerm.html(r.render(failure.value.error.toDiagnostic()), "diag");
        }
      }
      replTerm.el.scrollTop = replTerm.el.scrollHeight;
    })
  );
}

function growRepl(): void {
  replIn.rows = Math.min(12, replIn.value.split("\n").length);
}

function setReplInput(text: string): void {
  replIn.value = text;
  growRepl();
  replIn.setSelectionRange(text.length, text.length);
  replIn.dispatchEvent(new Event("input"));
}

// Tab completion over keywords, built-ins and the session's own names.
let completion: { start: number; options: string[]; index: number } | undefined;

function sessionNames(): string[] {
  const p = session.currentProgram;
  if (!p) return [];
  return [
    ...p.globals.map((g) => g.name),
    ...p.functions.filter((f) => f.kind.tag !== "method").map((f) => f.name),
    ...p.shapes.map((s) => s.name),
  ].filter((n) => !n.startsWith("<"));
}

function completionsAt(text: string, caret: number): { start: number; options: string[] } | undefined {
  const word = /[\p{L}_][\p{L}\p{N}_]*$/u.exec(text.slice(0, caret));
  if (!word) return undefined;
  const prefix = word[0].toUpperCase();
  const all = new Set([...sessionNames(), ...BUILTINS.map((b) => b.name), ...KEYWORDS]);
  const options = [...all].filter((n) => n.toUpperCase().startsWith(prefix) && n !== word[0]).sort((a, b) =>
    a.length - b.length || a.localeCompare(b)
  );
  return options.length ? { start: word.index, options: options.slice(0, 12) } : undefined;
}

fromEvent<KeyboardEvent>(replIn, "keydown").subscribe((e) => {
  if (e.key !== "Tab") completion = undefined;
  if (editingKey(replIn, e)) return e.preventDefault();
  if (e.key === "Escape" && replBusy$.value) {
    e.preventDefault();
    Effect.runFork(Fiber.interrupt(replBusy$.value));
  } else if (e.key === "l" && e.ctrlKey) {
    e.preventDefault();
    replTerm.clear();
  } else if (e.key === "Tab") {
    e.preventDefault();
    const caret = replIn.selectionStart;
    if (!completion) {
      const found = completionsAt(replIn.value, caret);
      if (!found) return;
      completion = { ...found, index: 0 };
    } else completion.index = (completion.index + 1) % completion.options.length;
    replIn.setSelectionRange(completion.start, caret);
    insert(replIn, completion.options[completion.index]);
  } else if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (!replIn.value.trim()) return;
    dedentTerminator(replIn);
    const input = replIn.value;
    // An unclosed block (IF without ENDIF, ...) continues on the next line.
    if (session.check(input).diagnostics.some((d) => d.code === "E0101")) return newlineWithIndent(replIn);
    setReplInput("");
    void submitRepl(input);
  } else if (e.key === "Enter" && e.shiftKey) {
    e.preventDefault();
    newlineWithIndent(replIn);
  } else if (e.key === "ArrowUp" && !replIn.value.slice(0, replIn.selectionStart).includes("\n") && historyAt > 0) {
    e.preventDefault();
    setReplInput(history[--historyAt]);
  } else if (
    e.key === "ArrowDown" && !replIn.value.slice(replIn.selectionEnd).includes("\n") && historyAt < history.length
  ) {
    e.preventDefault();
    historyAt++;
    setReplInput(history[historyAt] ?? "");
  }
});

fromEvent(replIn, "input").subscribe(growRepl);

// The utop-style hint line: completions while typing a word, otherwise the type the input would print.
merge(fromEvent(replIn, "input"), fromEvent(replIn, "keyup"), replBusy$).pipe(
  debounceTime(120),
  map(() => [replIn.value, replIn.selectionStart] as const),
  distinctUntilChanged((a, b) => a[0] === b[0] && a[1] === b[1]),
).subscribe(([text, caret]) => {
  if (!text.trim()) {
    replHint.textContent = replBusy$.value ? "running… Esc interrupts" : "";
    return;
  }
  const found = completionsAt(text, caret);
  if (found && /[\p{L}\p{N}_]/u.test(text[caret - 1] ?? "") && !/[\p{L}\p{N}_]/u.test(text[caret] ?? "")) {
    replHint.innerHTML = `{${
      found.options.map((o, i) => (i ? escape(o) : `<span class="pick">${escape(o)}</span>`)).join(" | ")
    }}`;
    return;
  }
  const { diagnostics, echoTypes } = session.check(text);
  const error = diagnostics.find((d) => d.isError);
  if (error?.code === "E0101") replHint.textContent = "… block continues: Enter adds a line";
  else if (error) replHint.innerHTML = `<span class="err">${escape(`${error.code}: ${error.message}`)}</span>`;
  else if (echoTypes.length) replHint.innerHTML = `- : <span class="ty">${escape(echoTypes.join(", "))}</span>`;
  else replHint.textContent = "";
});

fromEvent($("repl-reset"), "click").subscribe(() => {
  if (replBusy$.value) return;
  session.reset();
  replTerm.clear();
  replTerm.print("Session reset: all variables and definitions are gone.", "sys");
});

replTerm.print(
  "Pseudo REPL. Statements run as you enter them and definitions persist. Expressions and assignments print their value.",
  "sys",
);
// A short sample so the transcript shows what a session looks like.
(async () => {
  for (const input of ["DECLARE Marks : ARRAY[1:3] OF INTEGER", "Marks[1] ← 72", 'LENGTH("Pseudocode") * 2']) {
    await submitRepl(input, false);
  }
})();
