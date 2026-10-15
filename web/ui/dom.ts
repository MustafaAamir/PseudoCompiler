/** DOM helpers shared by the playground's panels. */

export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

/** localStorage, which may be missing or throw (private windows, blocked storage): the page works without it. */
export const store = {
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
      // Nothing to persist to.
    }
  },
};

/** Insert text at the caret through the browser's editing pipeline, so undo works. */
export function insertText(field: HTMLTextAreaElement, text: string): void {
  if (!document.execCommand("insertText", false, text)) {
    field.setRangeText(text, field.selectionStart, field.selectionEnd, "end");
    field.dispatchEvent(new Event("input"));
  }
}

const OPENS_BLOCK =
  /^(IF|ELSE|WHILE|REPEAT|FOR|CASE|OTHERWISE|PROCEDURE|FUNCTION|CLASS|(PUBLIC|PRIVATE)\s+(PROCEDURE|FUNCTION)|TYPE\s+\w+\s*$)\b/;
const CLOSES_BLOCK = /^(END[A-Z]+|ELSE|UNTIL|NEXT|OTHERWISE)\b/;
const INDENT = "    ";

function lineBeforeCaret(field: HTMLTextAreaElement): string {
  const before = field.value.slice(0, field.selectionStart);
  return before.slice(before.lastIndexOf("\n") + 1);
}

/** Moves a block terminator typed at its body's indentation back out to the block's. */
export function dedentTerminator(field: HTMLTextAreaElement): void {
  const line = lineBeforeCaret(field);
  const start = field.selectionStart - line.length;
  const prev = field.value.slice(field.value.lastIndexOf("\n", start - 2) + 1, start);
  const indent = (s: string) => /^ */.exec(s)![0].length;
  if (!CLOSES_BLOCK.test(line.trim()) || !line.startsWith(INDENT) || indent(prev) < indent(line)) return;
  const caret = field.selectionStart;
  field.setSelectionRange(start, start + INDENT.length);
  insertText(field, "");
  field.setSelectionRange(caret - INDENT.length, caret - INDENT.length);
}

/** Enter: keep the indentation, one level deeper after a line that opens a block. */
export function newline(field: HTMLTextAreaElement): void {
  dedentTerminator(field);
  const line = lineBeforeCaret(field);
  insertText(field, "\n" + /^\s*/.exec(line)![0] + (OPENS_BLOCK.test(line.trim()) ? INDENT : ""));
}

/** `<-` becomes `←` as it is typed. Returns whether the key was handled. */
export function typeArrow(field: HTMLTextAreaElement, e: KeyboardEvent): boolean {
  if (e.key !== "-" || e.ctrlKey || e.metaKey || field.value[field.selectionStart - 1] !== "<") return false;
  field.setSelectionRange(field.selectionStart - 1, field.selectionEnd);
  insertText(field, "←");
  return true;
}

/** Shift+Tab: remove one level of indentation from the caret's line. */
export function outdent(field: HTMLTextAreaElement): void {
  const start = field.value.lastIndexOf("\n", field.selectionStart - 1) + 1;
  const n = /^ {0,4}/.exec(field.value.slice(start))![0].length;
  if (!n) return;
  const caret = field.selectionStart;
  field.setSelectionRange(start, start + n);
  insertText(field, "");
  field.setSelectionRange(Math.max(start, caret - n), Math.max(start, caret - n));
}
