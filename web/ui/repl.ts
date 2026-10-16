/**
 * The utop-style REPL: each input runs as soon as it is complete, values echo
 * as `- : TYPE = value`, and a hint line shows completions or the type the
 * input would print.
 */

import { Cause, Effect, Exit, Fiber, Option } from "effect";
import { BehaviorSubject, debounceTime, distinctUntilChanged, fromEvent, map, merge, type Subject } from "rxjs";
import { BUILTINS, escapeHtml, KEYWORDS, Renderer, Session, type VirtualFs } from "../src/mod.ts";
import { $, dedentTerminator, insertText, newline, store, typeArrow } from "./dom.ts";
import { highlight } from "./highlight.ts";
import { Terminal, terminalLayer } from "./terminal.ts";
import { badge, diagnosticCard, emptyState, eventCard, h, rich } from "./components.ts";

const WORD = /[\p{L}_][\p{L}\p{N}_]*$/u;
const WORD_CHAR = /[\p{L}\p{N}_]/u;

export function mountRepl(fs: VirtualFs, filesChanged$: Subject<void>): void {
  const scroller = $("repl");
  const term = new Terminal($("repl-log"), scroller);
  const input = $<HTMLTextAreaElement>("repl-input");
  const hint = $("repl-hint");
  const session = new Session("repl");
  const busy$ = new BehaviorSubject<Fiber.RuntimeFiber<unknown, unknown> | undefined>(undefined);
  const history: string[] = JSON.parse(store.get("history") ?? "[]");
  let historyAt = history.length;

  function submit(text: string, remember = true): Promise<void> {
    if (busy$.value) return Promise.resolve();
    text.split("\n").forEach((line, i) => term.html(highlight(line).slice(0, -1), i ? "in cont" : "in"));
    if (remember && history.at(-1) !== text) {
      history.push(text);
      store.set("history", JSON.stringify(history.slice(-200)));
    }
    historyAt = history.length;

    const fiber = Effect.runFork(session.submit(text).pipe(Effect.provide(terminalLayer(term, fs))));
    busy$.next(fiber);
    return new Promise((done) =>
      fiber.addObserver((exit) => {
        busy$.next(undefined);
        filesChanged$.next();
        done();
        queueMicrotask(() => term.scrollToEnd());
        if (Exit.isSuccess(exit)) {
          const { declared, echoes, warnings, source } = exit.value;
          const r = new Renderer(source, "html");
          for (const w of warnings) term.add(diagnosticCard(w, r));
          for (const d of declared) {
            const m = /^(\w+) : (.*)$/.exec(d);
            term.html(
              m
                ? `<span class="nm">${escapeHtml(m[1])}</span> : <span class="ty">${escapeHtml(m[2])}</span>`
                : escapeHtml(d),
              "decl",
            );
          }
          for (const { name, ty, value } of echoes) {
            term.html(
              `<span class="nm">${escapeHtml(name)}</span> : <span class="ty">${escapeHtml(ty)}</span> = ${
                escapeHtml(value)
              }`,
              "val",
            );
          }
        } else if (Exit.isInterrupted(exit)) {
          term.add(eventCard({
            tone: "warn",
            badge: "Interrupted",
            title: "Evaluation stopped",
            detail: "Stopped at a VM time-slice boundary. Definitions and assignments made before that point are kept.",
          }));
        } else {
          const failure = Cause.failureOption(exit.cause);
          if (Option.isNone(failure)) {
            term.add(eventCard({
              tone: "err",
              badge: "Internal",
              title: "Internal error in the playground",
              detail: Cause.pretty(exit.cause),
            }));
          } else {
            const e = failure.value;
            const r = new Renderer(e.source, "html");
            const diags = e._tag === "CompileError" ? e.diagnostics : [e.error.toDiagnostic()];
            for (const d of diags) term.add(diagnosticCard(d, r));
          }
        }
      })
    );
  }

  function setInput(text: string): void {
    input.value = text;
    input.setSelectionRange(text.length, text.length);
    input.dispatchEvent(new Event("input"));
  }

  function completions(text: string, caret: number): { start: number; options: string[] } | undefined {
    const word = WORD.exec(text.slice(0, caret));
    if (!word) return undefined;
    const p = session.currentProgram;
    const names = new Set([
      ...(p?.globals.map((g) => g.name) ?? []),
      ...(p?.functions.filter((f) => f.kind.tag !== "method").map((f) => f.name) ?? []),
      ...(p?.shapes.map((s) => s.name) ?? []),
      ...BUILTINS.map((b) => b.name),
      ...KEYWORDS,
    ]);
    const prefix = word[0].toUpperCase();
    const options = [...names]
      .filter((n) => !n.startsWith("<") && n !== word[0] && n.toUpperCase().startsWith(prefix))
      .sort((a, b) => a.length - b.length || a.localeCompare(b))
      .slice(0, 12);
    return options.length ? { start: word.index, options } : undefined;
  }

  // Successive Tabs cycle through the same completion list.
  let cycle: { start: number; options: string[]; index: number } | undefined;

  fromEvent<KeyboardEvent>(input, "keydown").subscribe((e) => {
    if (e.key !== "Tab") cycle = undefined;
    const caret = input.selectionStart;
    if (typeArrow(input, e)) { /* handled */ }
    else if (e.key === "Escape" && busy$.value) Effect.runFork(Fiber.interrupt(busy$.value));
    else if (e.key === "l" && e.ctrlKey) term.clear();
    else if (e.key === "Tab") {
      if (cycle) cycle.index = (cycle.index + 1) % cycle.options.length;
      else {
        const found = completions(input.value, caret);
        if (!found) return e.preventDefault();
        cycle = { ...found, index: 0 };
      }
      input.setSelectionRange(cycle.start, caret);
      insertText(input, cycle.options[cycle.index]);
    } else if (e.key === "Enter" && e.shiftKey) newline(input);
    else if (e.key === "Enter") {
      if (!input.value.trim() || busy$.value) return e.preventDefault();
      // An unclosed block (IF without ENDIF, ...) continues on the next line.
      if (session.check(input.value).diagnostics.some((d) => d.code === "E0101")) newline(input);
      else {
        dedentTerminator(input);
        const text = input.value;
        setInput("");
        void submit(text);
      }
    } else if (e.key === "ArrowUp" && historyAt > 0 && !input.value.slice(0, caret).includes("\n")) {
      setInput(history[--historyAt]);
    } else if (
      e.key === "ArrowDown" && historyAt < history.length && !input.value.slice(input.selectionEnd).includes("\n")
    ) {
      setInput(history[++historyAt] ?? "");
    } else return;
    e.preventDefault();
  });

  fromEvent(input, "input").subscribe(() => (input.rows = Math.min(12, input.value.split("\n").length)));

  merge(fromEvent(input, "input"), fromEvent(input, "keyup"), busy$).pipe(
    debounceTime(120),
    map(() => [input.value, input.selectionStart] as const),
    distinctUntilChanged((a, b) => a[0] === b[0] && a[1] === b[1]),
  ).subscribe(([text, caret]) => {
    if (!text.trim()) {
      hint.replaceChildren(...(busy$.value ? [badge("Evaluating", "info"), "Press Esc to interrupt."] : []));
      return;
    }
    const found = completions(text, caret);
    if (found && WORD_CHAR.test(text[caret - 1] ?? "") && !WORD_CHAR.test(text[caret] ?? "")) {
      hint.replaceChildren(
        h("span", { className: "hint-label" }, "Complete"),
        ...found.options.map((o) =>
          h("button", {
            type: "button",
            className: "chip",
            onclick: () => {
              input.focus();
              input.setSelectionRange(found.start, caret);
              insertText(input, o);
            },
          }, o)
        ),
      );
      return;
    }
    const { diagnostics, echoTypes } = session.check(text);
    const error = diagnostics.find((d) => d.isError);
    if (error?.code === "E0101") {
      hint.replaceChildren(badge("Open block", "info"), "Enter adds a line. The input runs once the block is closed.");
    } else if (error) hint.replaceChildren(badge(error.code, "err"), rich(error.message));
    else if (echoTypes.length) {
      hint.replaceChildren(h("span", { className: "hint-label" }, "Result"), h("code", {}, echoTypes.join(", ")));
    } else hint.replaceChildren();
  });

  fromEvent($("repl-reset"), "click").subscribe(() => {
    if (busy$.value) return;
    session.reset();
    term.clear();
    term.add(eventCard({
      tone: "neutral",
      badge: "Reset",
      title: "New session",
      detail: "The transcript, globals, routines, types and classes were discarded and inline caches cleared.",
    }));
  });

  term.add(emptyState(
    "Interactive session",
    "Each input is compiled together with everything entered before it, and the VM resumes where the previous " +
      "input halted, so globals, routines, classes and warm inline caches persist. Expressions and assignments " +
      "print `name : TYPE = value`.",
  ));

  // Clicking anywhere in the transcript focuses the prompt, unless text is being selected or an INPUT field was hit.
  fromEvent<MouseEvent>(scroller, "click").subscribe((e) => {
    if ((e.target as HTMLElement).closest("input, textarea, button") || getSelection()?.toString()) return;
    input.focus({ preventScroll: true });
    term.scrollToEnd();
  });
  (async () => {
    for (const text of ["DECLARE Marks : ARRAY[1:3] OF INTEGER", "Marks[1] ← 72", 'LENGTH("Pseudocode") * 2']) {
      await submit(text, false);
    }
  })();
}
