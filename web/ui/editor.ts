/**
 * The source editor: a transparent textarea over a <pre> that shows the same
 * text highlighted, with squiggles under diagnostics and a line-number gutter.
 */

import { BehaviorSubject, distinctUntilChanged, filter, fromEvent, map, merge, type Observable } from "rxjs";
import type { Span } from "../src/mod.ts";
import { insertText, newline, outdent, typeArrow } from "./dom.ts";
import { highlight, type Mark } from "./highlight.ts";

export interface Squiggle {
  readonly span: Span;
  readonly severity: "error" | "warning" | "runtime";
}

export class Editor {
  readonly text$: BehaviorSubject<string>;
  /** Caret offset. */
  readonly caret$: Observable<number>;

  constructor(
    private readonly input: HTMLTextAreaElement,
    private readonly layer: HTMLElement,
    private readonly gutter: HTMLElement,
    text: string,
    keys: { run: () => void; stop: () => void },
  ) {
    input.value = text;
    this.text$ = new BehaviorSubject(text);
    fromEvent(input, "input").subscribe(() => this.text$.next(input.value));
    fromEvent(input, "scroll").subscribe(() => this.syncScroll());
    fromEvent<KeyboardEvent>(input, "keydown").subscribe((e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) keys.run();
      else if (e.key === "Escape") keys.stop();
      else if (typeArrow(input, e)) { /* handled */ }
      else if (e.key === "Tab" && !e.ctrlKey && !e.altKey) e.shiftKey ? outdent(input) : insertText(input, "    ");
      else if (e.key === "Enter" && !e.shiftKey && !e.altKey) newline(input);
      else return;
      e.preventDefault();
    });
    this.caret$ = merge(
      fromEvent(document, "selectionchange").pipe(filter(() => document.activeElement === input)),
      this.text$,
    ).pipe(map(() => input.selectionStart), distinctUntilChanged());
  }

  get text(): string {
    return this.input.value;
  }

  set text(text: string) {
    this.input.value = text;
    this.input.scrollTop = 0;
    this.text$.next(text);
  }

  render(squiggles: readonly Squiggle[]): void {
    const text = this.input.value;
    const marks = squiggles.map(({ span, severity }): Mark => {
      const cls = `sq-${severity}`;
      if (span.end > span.start) return { start: span.start, end: span.end, cls };
      // Widen empty spans to a visible character, preferring the one after.
      return span.start < text.length && text[span.start] !== "\n"
        ? { start: span.start, end: span.start + 1, cls }
        : { start: Math.max(0, span.start - 1), end: span.start, cls };
    });
    this.layer.innerHTML = highlight(text, marks);

    const flagged = new Map<number, string>();
    for (const { span, severity } of squiggles) {
      const line = text.slice(0, span.start).split("\n").length;
      if (flagged.get(line) !== "error") flagged.set(line, severity === "warning" ? "warning" : "error");
    }
    const lines = text.split("\n").length;
    let html = "";
    for (let i = 1; i <= lines; i++) {
      html += flagged.has(i) ? `<span class="${flagged.get(i)}">${i}</span>\n` : `${i}\n`;
    }
    this.gutter.innerHTML = html;
    this.syncScroll();
  }

  /** Select a range and scroll it into view. */
  reveal(start: number, end = start): void {
    const line = this.input.value.slice(0, start).split("\n").length - 1;
    this.input.focus({ preventScroll: true });
    this.input.setSelectionRange(start, Math.max(start, end));
    this.input.scrollTop = Math.max(0, line * this.lineHeight() - this.input.clientHeight / 3);
    this.syncScroll();
    this.input.closest(".pane")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  private lineHeight(): number {
    return parseFloat(getComputedStyle(this.input).lineHeight) || 21;
  }

  private syncScroll(): void {
    this.layer.scrollTop = this.gutter.scrollTop = this.input.scrollTop;
    this.layer.scrollLeft = this.input.scrollLeft;
  }
}
