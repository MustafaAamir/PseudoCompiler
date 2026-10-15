/**
 * rustc-style diagnostics: error codes, multi-label snippets, notes and
 * suggested edits, rendered as plain text, ANSI-coloured text or HTML.
 */

import type { Source, Span } from "./source.ts";

export type Severity = "error" | "warning";

export interface Label {
  readonly span: Span;
  readonly message: string;
  readonly primary: boolean;
}

/** A trailing `note:`/`help:`. With a span it gets its own snippet; with a replacement it is a suggested edit. */
export interface Child {
  readonly kind: "note" | "help";
  readonly message: string;
  readonly span?: Span;
  readonly replacement?: string;
}

export class Diagnostic {
  readonly labels: Label[] = [];
  readonly children: Child[] = [];

  private constructor(readonly severity: Severity, readonly code: string, readonly message: string) {}

  static error(code: string, message: string): Diagnostic {
    return new Diagnostic("error", code, message);
  }

  static warning(code: string, message: string): Diagnostic {
    return new Diagnostic("warning", code, message);
  }

  primary(span: Span, message: string): this {
    this.labels.push({ span, message, primary: true });
    return this;
  }

  secondary(span: Span, message: string): this {
    this.labels.push({ span, message, primary: false });
    return this;
  }

  note(message: string): this {
    this.children.push({ kind: "note", message });
    return this;
  }

  noteAt(span: Span, message: string): this {
    this.children.push({ kind: "note", message, span });
    return this;
  }

  help(message: string): this {
    this.children.push({ kind: "help", message });
    return this;
  }

  /** Suggest replacing `span` with `replacement`. */
  suggest(span: Span, replacement: string, message: string): this {
    this.children.push({ kind: "help", message, span, replacement });
    return this;
  }

  get isError(): boolean {
    return this.severity === "error";
  }

  primarySpan(): Span | undefined {
    return this.labels.find((l) => l.primary)?.span;
  }
}

/** The diagnostics produced by one compilation. */
export class Diagnostics {
  readonly list: Diagnostic[] = [];

  push(d: Diagnostic): void {
    this.list.push(d);
  }

  get errorCount(): number {
    return this.list.filter((d) => d.isError).length;
  }

  get warningCount(): number {
    return this.list.length - this.errorCount;
  }

  get hasErrors(): boolean {
    return this.list.some((d) => d.isError);
  }

  /** Source order; errors before warnings at the same position. */
  sorted(): Diagnostic[] {
    const key = (d: Diagnostic) => d.primarySpan()?.start ?? Number.MAX_SAFE_INTEGER;
    return [...this.list].sort((a, b) => key(a) - key(b) || (a.isError ? 0 : 1) - (b.isError ? 0 : 1));
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

type Style = "plain" | "error" | "warning" | "note" | "help" | "gutter" | "secondary" | "bold";

const ANSI: Record<Style, string> = {
  plain: "",
  error: "\x1b[1;31m",
  warning: "\x1b[1;33m",
  note: "\x1b[1;36m",
  help: "\x1b[1;32m",
  gutter: "\x1b[1;34m",
  secondary: "\x1b[1;34m",
  bold: "\x1b[1m",
};

export type RenderMode = "plain" | "ansi" | "html";

const TAB = "    ";

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** Renders diagnostics against a {@link Source}. HTML output uses `d-<style>` CSS classes. */
export class Renderer {
  constructor(private readonly src: Source, private readonly mode: RenderMode = "plain") {}

  private paint(text: string, style: Style): string {
    if (this.mode === "html") {
      const t = escapeHtml(text);
      return style === "plain" || text === "" ? t : `<span class="d-${style}">${t}</span>`;
    }
    if (this.mode === "ansi" && style !== "plain" && text !== "") return `${ANSI[style]}${text}\x1b[0m`;
    return text;
  }

  private heading(out: string[], kind: string, style: Style, message: string): void {
    out.push(this.paint(kind, style) + this.paint(`: ${message}`, "bold"));
  }

  private bar(line: number | undefined, gutter: number): string {
    const num = line === undefined ? "" : String(line + 1);
    return this.paint(`${num.padStart(gutter)} |`, "gutter");
  }

  render(d: Diagnostic): string {
    const out: string[] = [];
    const sevStyle: Style = d.severity;
    this.heading(out, `${d.severity}[${d.code}]`, sevStyle, d.message);

    const gutter = this.gutterWidth(d);
    const primary = d.primarySpan() ?? d.labels[0]?.span;
    if (primary) {
      this.location(out, primary, gutter);
      this.snippet(
        out,
        d.labels.map((l) => [l.span, l.message, l.primary ? sevStyle : "secondary"] as const),
        gutter,
      );
    }

    // Plain notes/helps go in the `= note:` trailer; spanned ones get snippets.
    for (const c of d.children.filter((c) => !c.span)) {
      const [first, ...rest] = c.message.split("\n");
      const eq = this.paint(`${"".padStart(gutter)} =`, "gutter");
      out.push(`${eq} ${this.paint(c.kind, c.kind)}: ${this.paint(first, "plain")}`);
      for (const l of rest) {
        out.push(`${"".padStart(gutter)}   ${" ".repeat(c.kind.length + 2)}${this.paint(l, "plain")}`);
      }
    }
    for (const c of d.children.filter((c) => c.span)) {
      this.heading(out, c.kind, c.kind, c.message);
      if (c.replacement !== undefined) this.suggestion(out, c.span!, c.replacement, gutter);
      else {
        this.location(out, c.span!, gutter);
        this.snippet(out, [[c.span!, "", c.kind]], gutter);
      }
    }
    return out.join("\n") + "\n";
  }

  private gutterWidth(d: Diagnostic): number {
    const spans = [...d.labels.map((l) => l.span), ...d.children.flatMap((c) => (c.span ? [c.span] : []))];
    const max = spans.reduce((m, s) => Math.max(m, this.src.lineIndex(s.end) + 1), 1);
    return String(max).length;
  }

  private location(out: string[], span: Span, gutter: number): void {
    const [line, col] = this.src.lineCol(span.start);
    out.push(
      `${" ".repeat(gutter)}${this.paint("-->", "gutter")} ${this.paint(`${this.src.name}:${line}:${col}`, "plain")}`,
    );
  }

  /** Display column (tab-expanded, code-point based) of an offset within a line. */
  private static displayCol(lineText: string, offsetInLine: number): number {
    let col = 0;
    for (const ch of lineText.slice(0, offsetInLine)) col += ch === "\t" ? TAB.length : 1;
    return col;
  }

  private snippet(out: string[], labels: readonly (readonly [Span, string, Style])[], gutter: number): void {
    interface OnLine {
      start: number;
      end: number;
      msg: string;
      style: Style;
    }
    const byLine = new Map<number, OnLine[]>();
    for (const [span, msg, style] of labels) {
      const line = this.src.lineIndex(span.start);
      const text = this.src.lineText(line);
      const ls = this.src.lineStart(line);
      // Multi-line spans are underlined to the end of their first line.
      const endLine = this.src.lineIndex(Math.max(span.end, span.start + 1) - 1);
      const eOff = endLine === line ? span.end - ls : text.length;
      const start = Renderer.displayCol(text, span.start - ls);
      const end = Math.max(Renderer.displayCol(text, Math.min(eOff, text.length)), start + 1);
      if (!byLine.has(line)) byLine.set(line, []);
      byLine.get(line)!.push({ start, end, msg, style });
    }

    const bar = this.bar(undefined, gutter);
    out.push(bar);
    let prev: number | undefined;
    for (const line of [...byLine.keys()].sort((a, b) => a - b)) {
      if (prev !== undefined && line === prev + 2) this.sourceLine(out, prev + 1, gutter);
      else if (prev !== undefined && line > prev + 2) out.push(this.paint("...", "gutter"));
      this.sourceLine(out, line, gutter);
      const ls = byLine.get(line)!.sort((a, b) => a.start - b.start);

      // Underline row, carrying the rightmost label's message inline.
      const canvas = new Canvas();
      for (const l of ls) {
        for (let c = l.start; c < l.end; c++) canvas.put(c, l.style === "secondary" ? "-" : "^", l.style);
      }
      const last = ls[ls.length - 1];
      canvas.text(Math.max(...ls.map((l) => l.end)) + 1, last.msg, last.style);
      out.push(`${bar} ${canvas.render((t, s) => this.paint(t, s))}`);

      // Hanging messages for the remaining labels, right to left.
      const pending = ls.slice(0, -1).filter((l) => l.msg !== "");
      for (let i = pending.length - 1; i >= 0; i--) {
        const conn = new Canvas();
        for (const l of pending.slice(0, i + 1)) conn.put(l.start, "|", l.style);
        out.push(`${bar} ${conn.render((t, s) => this.paint(t, s))}`);
        const msg = new Canvas();
        for (const l of pending.slice(0, i)) msg.put(l.start, "|", l.style);
        msg.text(pending[i].start, pending[i].msg, pending[i].style);
        out.push(`${bar} ${msg.render((t, s) => this.paint(t, s))}`);
      }
      prev = line;
    }
    out.push(bar);
  }

  private sourceLine(out: string[], line: number, gutter: number): void {
    out.push(`${this.bar(line, gutter)} ${this.paint(this.src.lineText(line).replaceAll("\t", TAB), "plain")}`);
  }

  private suggestion(out: string[], span: Span, replacement: string, gutter: number): void {
    const line = this.src.lineIndex(span.start);
    const text = this.src.lineText(line);
    const ls = this.src.lineStart(line);
    const s = span.start - ls;
    const e = Math.min(span.end - ls, text.length);
    const newLine = text.slice(0, s) + replacement + text.slice(e);
    const marks = (span.isEmpty() ? "+" : "~").repeat(Math.max([...replacement].length, 1));
    const bar = this.bar(undefined, gutter);
    out.push(bar);
    out.push(`${this.bar(line, gutter)} ${this.paint(newLine.replaceAll("\t", TAB), "plain")}`);
    out.push(`${bar} ${" ".repeat(Renderer.displayCol(text, s))}${this.paint(marks, "help")}`);
    out.push(bar);
  }

  /** The closing `error: could not compile ...` summary. */
  summary(diags: Diagnostics): string {
    const plural = (n: number) => (n === 1 ? "" : "s");
    const { errorCount: e, warningCount: w } = diags;
    const out: string[] = [];
    const name = this.src.name;
    if (w > 0) this.heading(out, "warning", "warning", `\`${name}\` generated ${w} warning${plural(w)}`);
    if (e > 0) {
      this.heading(out, "error", "error", `could not compile \`${name}\` due to ${e} previous error${plural(e)}`);
      const first = diags.sorted().find((d) => d.isError);
      if (first) out.push(this.paint(`For more information about an error, try \`explain ${first.code}\`.`, "bold"));
    }
    return out.length ? out.join("\n") + "\n" : "";
  }
}

/** A sparse row of styled characters used to draw underline/annotation rows. */
class Canvas {
  private readonly cells: [string, Style][] = [];

  put(col: number, ch: string, style: Style): void {
    while (this.cells.length <= col) this.cells.push([" ", "plain"]);
    this.cells[col] = [ch, style];
  }

  text(col: number, s: string, style: Style): void {
    [...s].forEach((ch, i) => this.put(col + i, ch, style));
  }

  render(paint: (text: string, style: Style) => string): string {
    let end = this.cells.length;
    while (end > 0 && this.cells[end - 1][0] === " ") end--;
    let out = "", run = "", runStyle: Style = "plain";
    for (const [ch, st] of this.cells.slice(0, end)) {
      if (st !== runStyle && run) {
        out += paint(run, runStyle);
        run = "";
      }
      runStyle = st;
      run += ch;
    }
    return out + paint(run, runStyle);
  }
}

// ---------------------------------------------------------------------------
// "Did you mean" helpers
// ---------------------------------------------------------------------------

/** Optimal string alignment distance (Levenshtein + adjacent transpositions). */
export function editDistance(a: string, b: string): number {
  const x = [...a], y = [...b];
  const d = Array.from(
    { length: x.length + 1 },
    (_, i) => Array.from({ length: y.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[x.length][y.length];
}

/** Best close match for `name`, preferring case-only differences. */
export function bestMatch(name: string, candidates: Iterable<string>): string | undefined {
  // Very short names only match case-insensitively; anything else is noise.
  const len = [...name].length;
  const limit = len < 3 ? 0 : Math.max(Math.floor(len / 3), 1);
  const lower = name.toLowerCase();
  let best: [number, string] | undefined;
  for (const c of candidates) {
    if (c === name) continue;
    const cl = c.toLowerCase();
    const dist = cl === lower ? 0 : editDistance(lower, cl);
    if (dist <= limit && (!best || dist < best[0])) best = [dist, c];
  }
  return best?.[1];
}
