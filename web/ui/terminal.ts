/** A scrolling transcript that programs print to and that asks for INPUT inline. */

import { Effect, Layer, Option } from "effect";
import { Console, Files, Stdin, type VirtualFs, VmConfig } from "../src/mod.ts";
import { badge, h } from "./components.ts";

/** Older lines are dropped beyond this, so a chatty program cannot exhaust the page. */
const MAX_LINES = 5000;
let asks = 0;

export class Terminal {
  /** Lines go into `el`; `scroller` is the element that scrolls (`el` itself, or a container around it). */
  constructor(private readonly el: HTMLElement, private readonly scroller: HTMLElement = el) {}

  /** Append a node, following the output if the view was already scrolled to the end. */
  add(node: Node): void {
    const s = this.scroller;
    const atBottom = s.scrollHeight - s.scrollTop - s.clientHeight < 48;
    this.el.append(node);
    while (this.el.childElementCount > MAX_LINES) this.el.firstElementChild!.remove();
    if (atBottom) this.scrollToEnd();
  }

  scrollToEnd(): void {
    this.scroller.scrollTop = this.scroller.scrollHeight;
  }

  /** A line of program output. */
  print(text: string): void {
    this.add(h("div", { className: "out" }, text));
  }

  /** Already escaped HTML, such as highlighted source. */
  html(html: string, cls: string): void {
    this.add(h("div", { className: cls, html }));
  }

  clear(): void {
    this.el.replaceChildren();
  }

  /**
   * Ask for a line of standard input; `done` receives it, or `undefined` at end of input.
   * Returns a function that withdraws an unanswered request.
   */
  ask(type: string, done: (line: string | undefined) => void): () => void {
    const id = `stdin-${++asks}`;
    const field = h("input", { id, autocomplete: "off", spellcheck: "false", enterkeyhint: "send" });
    const answer = (line: string | undefined) => {
      card.replaceWith(
        h(
          "div",
          { className: "stdin-echo" },
          badge("stdin", "info"),
          line === undefined ? h("em", {}, "end of input") : h("code", {}, line),
        ),
      );
      done(line);
    };
    const card = h(
      "form",
      { className: "stdin", onsubmit: (e: Event) => (e.preventDefault(), answer(field.value)) },
      h(
        "label",
        { for: id },
        badge("INPUT", "info"),
        h("span", {}, "The program is waiting for a value of type "),
        h("code", {}, type),
      ),
      h(
        "div",
        { className: "stdin-row" },
        field,
        h("button", { type: "submit", className: "primary" }, "Send"),
        h("button", { type: "button", onclick: () => answer(undefined), title: "Signal end of input (Ctrl+D)" }, "EOF"),
      ),
    );
    field.addEventListener("keydown", (e) => {
      if (e.key === "d" && e.ctrlKey) {
        e.preventDefault();
        answer(undefined);
      }
    });
    this.add(card);
    this.scrollToEnd();
    field.focus({ preventScroll: true });
    return () => card.remove();
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
