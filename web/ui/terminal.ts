/** A scrolling transcript that programs print to and that asks for INPUT inline. */

import { Effect, Layer, Option } from "effect";
import { Console, Files, Stdin, type VirtualFs, VmConfig } from "../src/mod.ts";

/** Older lines are dropped beyond this, so a chatty program cannot exhaust the page. */
const MAX_LINES = 5000;

export class Terminal {
  constructor(private readonly el: HTMLElement) {}

  private append(node: HTMLElement): void {
    const atBottom = this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 40;
    this.el.append(node);
    while (this.el.childElementCount > MAX_LINES) this.el.firstElementChild!.remove();
    if (atBottom) this.el.scrollTop = this.el.scrollHeight;
  }

  print(text: string, cls = "out"): void {
    const div = document.createElement("div");
    div.className = cls;
    div.textContent = text;
    this.append(div);
  }

  /** Already escaped HTML: diagnostics, highlighted code. */
  html(html: string, cls: string): void {
    const div = document.createElement("div");
    div.className = cls;
    div.innerHTML = html;
    this.append(div);
  }

  clear(): void {
    this.el.replaceChildren();
  }

  /**
   * Show an input field; `done` receives the line, or `undefined` for Ctrl+D (end of input).
   * Returns a function that withdraws an unanswered request.
   */
  ask(type: string, done: (line: string | undefined) => void): () => void {
    const row = document.createElement("div");
    row.className = "ask";
    const field = document.createElement("input");
    field.id = `ask-${crypto.randomUUID()}`;
    field.autocomplete = "off";
    field.spellcheck = false;
    field.placeholder = "Enter sends · Ctrl+D ends input";
    const label = document.createElement("label");
    label.htmlFor = field.id;
    label.textContent = `INPUT ${type}`;
    row.append(label, field);
    this.append(row);
    field.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      const eof = e.key === "d" && e.ctrlKey;
      if (e.key !== "Enter" && !eof) return;
      e.preventDefault();
      field.removeEventListener("keydown", onKey);
      field.readOnly = true;
      row.classList.add("answered");
      if (eof) field.value = "(end of input)";
      done(eof ? undefined : field.value);
    };
    field.addEventListener("keydown", onKey);
    return () => {
      if (!row.classList.contains("answered")) row.remove();
    };
  }
}

/** I/O services that print into `term` and ask it for INPUT. `onWait` tracks whether a request is pending. */
export function terminalLayer(term: Terminal, fs: VirtualFs, onWait?: (waiting: boolean) => void) {
  return Layer.mergeAll(
    Layer.succeed(Console, { print: (line) => Effect.sync(() => term.print(line)) }),
    Layer.succeed(Stdin, {
      readLine: ({ type }) =>
        Effect.async<Option.Option<string>>((resume) => {
          onWait?.(true);
          const withdraw = term.ask(type, (line) => {
            onWait?.(false);
            resume(Effect.succeed(Option.fromNullable(line)));
          });
          return Effect.sync(() => {
            onWait?.(false);
            withdraw();
          });
        }),
    }),
    Layer.succeed(Files, fs),
    Layer.succeed(VmConfig, { sliceSize: 100_000 }),
  );
}
