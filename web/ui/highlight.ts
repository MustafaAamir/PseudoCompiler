/** Syntax highlighting with the compiler's own lexer, plus squiggles under diagnostic spans. */

import { BUILTINS, escapeHtml, isKeyword, type Kind, Lexer } from "../src/mod.ts";

const TYPE_WORDS = new Set<Kind>(["INTEGER", "REAL", "BOOLEAN", "CHAR", "STRING", "DATE", "ARRAY", "OF"]);
const BUILTIN_NAMES = new Set(BUILTINS.map((b) => b.name));

/** A highlighted range: `[start, end)` in UTF-16 offsets. */
export interface Mark {
  readonly start: number;
  readonly end: number;
  readonly cls: string;
}

function tokenClass(kind: Kind, text: string): string | undefined {
  switch (kind) {
    case "int":
    case "real":
      return "t-num";
    case "str":
    case "char":
      return "t-str";
    case "date":
      return "t-date";
    case "error":
      return "t-bad";
    case "ident":
      return BUILTIN_NAMES.has(text) ? "t-fn" : undefined;
    case "TRUE":
    case "FALSE":
      return "t-num";
  }
  if (TYPE_WORDS.has(kind)) return "t-ty";
  if (isKeyword(kind)) return "t-kw";
  return kind === "←" ? "t-arrow" : "t-op";
}

/** Token classes, comments included (they live in the gaps between tokens). */
export function tokenMarks(text: string): Mark[] {
  const marks: Mark[] = [];
  const comments = (from: number, to: number) => {
    for (let i = text.indexOf("//", from); i >= 0 && i < to; i = text.indexOf("//", i)) {
      const nl = text.indexOf("\n", i);
      const end = nl < 0 || nl > to ? to : nl;
      marks.push({ start: i, end, cls: "t-com" });
      i = end;
    }
  };
  const lx = new Lexer(text);
  let last = 0;
  // A runaway lexer is a bug, but highlighting must never hang the editor.
  for (let guard = 0; guard <= text.length + 1; guard++) {
    const t = lx.nextToken();
    lx.takeError();
    comments(last, t.span.start);
    if (t.kind === "eof") break;
    const cls = tokenClass(t.kind, text.slice(t.span.start, t.span.end));
    if (cls) marks.push({ start: t.span.start, end: t.span.end, cls });
    last = t.span.end;
  }
  return marks;
}

/**
 * HTML for `text` with token classes and squiggles. Squiggles may overlap tokens
 * arbitrarily, so the text is cut at every boundary of either kind of mark.
 */
export function highlight(text: string, squiggles: readonly Mark[] = []): string {
  const tokens = tokenMarks(text);
  const cuts = new Set([0, text.length]);
  for (const m of [...tokens, ...squiggles]) cuts.add(Math.min(m.start, text.length)).add(Math.min(m.end, text.length));
  const points = [...cuts].sort((a, b) => a - b);
  let out = "";
  let ti = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const [a, b] = [points[i], points[i + 1]];
    while (ti < tokens.length && tokens[ti].end <= a) ti++;
    const tok = tokens[ti] && tokens[ti].start <= a ? tokens[ti].cls : "";
    const sq = squiggles.find((s) => s.start <= a && b <= s.end)?.cls ?? "";
    const cls = [tok, sq].filter(Boolean).join(" ");
    const body = escapeHtml(text.slice(a, b));
    out += cls ? `<span class="${cls}">${body}</span>` : body;
  }
  // A trailing newline needs a character after it to take up a line in a <pre>.
  return out + "\n";
}
