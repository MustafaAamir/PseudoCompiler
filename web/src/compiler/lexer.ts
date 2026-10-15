/** An on-demand lexer. The compiler pulls one token at a time; no token array is ever built. */

import { Diagnostic } from "../core/diag.ts";
import { Span } from "../core/source.ts";
import { daysFromCivil } from "../core/value.ts";

export const KEYWORDS = [
  "DECLARE",
  "CONSTANT",
  "TYPE",
  "ENDTYPE",
  "ARRAY",
  "OF",
  "IF",
  "THEN",
  "ELSE",
  "ENDIF",
  "CASE",
  "OTHERWISE",
  "ENDCASE",
  "TO",
  "WHILE",
  "DO",
  "ENDWHILE",
  "REPEAT",
  "UNTIL",
  "FOR",
  "STEP",
  "NEXT",
  "CALL",
  "RETURN",
  "RETURNS",
  "BREAK",
  "CONTINUE",
  "OUTPUT",
  "PRINT",
  "INPUT",
  "READ",
  "OPENFILE",
  "READFILE",
  "WRITEFILE",
  "SEEK",
  "GETRECORD",
  "PUTRECORD",
  "CLOSEFILE",
  "WRITE",
  "APPEND",
  "RANDOM",
  "AND",
  "OR",
  "NOT",
  "DIV",
  "MOD",
  "TRUE",
  "FALSE",
  "INTEGER",
  "REAL",
  "BOOLEAN",
  "CHAR",
  "STRING",
  "DATE",
  "PROCEDURE",
  "ENDPROCEDURE",
  "FUNCTION",
  "ENDFUNCTION",
  "BYREF",
  "BYVAL",
  "CLASS",
  "ENDCLASS",
  "INHERITS",
  "PUBLIC",
  "PRIVATE",
  "SUPER",
  "NEW",
] as const;
export type Kw = (typeof KEYWORDS)[number];

const PUNCTS = [
  "←",
  "+",
  "-",
  "*",
  "/",
  "&",
  "=",
  "<>",
  "<",
  ">",
  "<=",
  ">=",
  "(",
  ")",
  "[",
  "]",
  ",",
  ":",
  ".",
  "^",
] as const;
type Punct = (typeof PUNCTS)[number];

/** Token kinds: keywords and punctuation are their own spelling. */
export type Kind = Kw | Punct | "ident" | "int" | "real" | "str" | "char" | "date" | "error" | "eof";

const KEYWORD_SET: ReadonlySet<string> = new Set(KEYWORDS);

export function lookupKeyword(s: string): Kw | undefined {
  return KEYWORD_SET.has(s) ? (s as Kw) : undefined;
}

export function isKeyword(k: Kind): k is Kw {
  return KEYWORD_SET.has(k);
}

/** Keywords that close a block; used for recovery and mismatch reports. */
const BLOCK_ENDS: ReadonlySet<Kind> = new Set<Kind>([
  "ENDIF",
  "ELSE",
  "ENDCASE",
  "OTHERWISE",
  "ENDWHILE",
  "UNTIL",
  "NEXT",
  "ENDPROCEDURE",
  "ENDFUNCTION",
  "ENDCLASS",
  "ENDTYPE",
]);

const STATEMENT_STARTS: ReadonlySet<Kind> = new Set<Kind>([
  "DECLARE",
  "CONSTANT",
  "TYPE",
  "IF",
  "CASE",
  "WHILE",
  "REPEAT",
  "FOR",
  "CALL",
  "RETURN",
  "BREAK",
  "CONTINUE",
  "OUTPUT",
  "PRINT",
  "INPUT",
  "READ",
  "OPENFILE",
  "READFILE",
  "WRITEFILE",
  "SEEK",
  "GETRECORD",
  "PUTRECORD",
  "CLOSEFILE",
  "PROCEDURE",
  "FUNCTION",
  "CLASS",
  "SUPER",
]);

export const isBlockEnd = (k: Kind): boolean => BLOCK_ENDS.has(k);
export const startsStatement = (k: Kind): boolean => STATEMENT_STARTS.has(k);

export function describe(k: Kind): string {
  switch (k) {
    case "ident":
      return "identifier";
    case "int":
      return "integer literal";
    case "real":
      return "real literal";
    case "str":
      return "string literal";
    case "char":
      return "character literal";
    case "date":
      return "date literal";
    case "error":
      return "invalid token";
    case "eof":
      return "end of file";
  }
  return isKeyword(k) ? `keyword \`${k}\`` : `\`${k}\``;
}

export interface Token {
  readonly kind: Kind;
  readonly span: Span;
  /**
   * Whether a line break separates this token from the previous one.
   * Pseudocode is line oriented: this drives `ELSE IF`, CASE arms and bare RETURN.
   */
  readonly lineStart: boolean;
  /** INTEGER/REAL/DATE value, or the CHAR. */
  readonly value?: number | string;
}

const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
const isIdentStart = (c: string) => /[\p{L}_]/u.test(c);
const isIdentChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}_]/u.test(c);

export class Lexer {
  private pos = 0;
  private error: Diagnostic | undefined;

  constructor(private readonly src: string) {}

  takeError(): Diagnostic | undefined {
    const e = this.error;
    this.error = undefined;
    return e;
  }

  private peek(n = 0): string | undefined {
    let p = this.pos;
    for (let i = 0; i < n && p < this.src.length; i++) p += this.src.codePointAt(p)! > 0xffff ? 2 : 1;
    if (p >= this.src.length) return undefined;
    return String.fromCodePoint(this.src.codePointAt(p)!);
  }

  private bump(): string | undefined {
    const c = this.peek();
    if (c !== undefined) this.pos += c.length;
    return c;
  }

  private eat(c: string): boolean {
    if (this.peek() !== c) return false;
    this.pos += c.length;
    return true;
  }

  /** Skips whitespace and `//` comments, reporting whether a newline was crossed. */
  private skipTrivia(): boolean {
    let newline = this.pos === 0;
    for (;;) {
      const c = this.peek();
      if (c === "\n") {
        newline = true;
        this.pos++;
      } else if (c !== undefined && /\s/u.test(c)) this.pos += c.length;
      else if (c === "/" && this.peek(1) === "/") {
        const nl = this.src.indexOf("\n", this.pos);
        this.pos = nl < 0 ? this.src.length : nl;
      } else return newline;
    }
  }

  nextToken(): Token {
    const lineStart = this.skipTrivia();
    const start = this.pos;
    const c = this.bump();
    let kind: Kind;
    let value: number | string | undefined;
    if (c === undefined) kind = "eof";
    else {
      [kind, value] = this.lexFrom(c, start);
    }
    return { kind, span: new Span(start, this.pos), lineStart, value };
  }

  private fail(d: Diagnostic): [Kind, undefined] {
    this.error = d;
    return ["error", undefined];
  }

  private lexFrom(c: string, start: number): [Kind, (number | string)?] {
    switch (c) {
      case "←":
        return ["←"];
      case "+":
      case "-":
      case "*":
      case "/":
      case "&":
      case "=":
      case "(":
      case ")":
      case "[":
      case "]":
      case ",":
      case ":":
      case ".":
      case "^":
        return [c];
      case "↑":
        return ["^"];
      case "≠":
        return ["<>"];
      case "≤":
        return ["<="];
      case "≥":
        return [">="];
      case "<":
        if (this.eat("-")) return ["←"];
        if (this.eat(">")) return ["<>"];
        if (this.eat("=")) return ["<="];
        return ["<"];
      case ">":
        return this.eat("=") ? [">="] : [">"];
      case '"':
      case "“":
      case "”":
        return this.string(start, c);
      case "'":
      case "‘":
      case "’":
        return this.charLit(start);
    }
    if (isDigit(c)) return this.number(start);
    if (isIdentStart(c)) {
      while (isIdentChar(this.peek())) this.bump();
      return [lookupKeyword(this.src.slice(start, this.pos)) ?? "ident"];
    }
    let d = Diagnostic.error("E0001", `unknown character \`${c}\``).primary(
      new Span(start, this.pos),
      "not valid in pseudocode",
    );
    const hints: Record<string, string> = {
      "!": 'use `<>` for "not equal" and `NOT` for negation',
      ";": "statements end at the end of a line; no `;` is needed",
      "{": "blocks are closed with keywords such as `ENDIF` and `ENDWHILE`",
      "}": "blocks are closed with keywords such as `ENDIF` and `ENDWHILE`",
      "%": "use `MOD` for the remainder of an integer division",
      "|": "use `OR` for logical disjunction",
    };
    if (hints[c]) d = d.help(hints[c]);
    return this.fail(d);
  }

  private string(start: number, open: string): [Kind, string?] {
    const closes = (c: string) => c === '"' || (open !== '"' && c === "”");
    for (;;) {
      const c = this.peek();
      if (c !== undefined && closes(c)) {
        this.bump();
        return ["str", this.src.slice(start + 1, this.pos - 1)];
      }
      if (c === "\n" || c === undefined) {
        return this.fail(
          Diagnostic.error("E0002", "unterminated string literal")
            .primary(new Span(start, start + open.length), "string starts here")
            .secondary(new Span(this.pos, this.pos), 'line ends before a closing `"`')
            .help('strings cannot span multiple lines; close it with `"` on the same line'),
        );
      }
      this.bump();
    }
  }

  private charLit(start: number): [Kind, (number | string)?] {
    const isQuote = (c: string) => c === "'" || c === "’" || c === "‘";
    const chars: string[] = [];
    for (;;) {
      const c = this.peek();
      if (c !== undefined && isQuote(c)) {
        this.bump();
        break;
      }
      if (c === "\n" || c === undefined) {
        return this.fail(
          Diagnostic.error("E0002", "unterminated character literal")
            .primary(new Span(start, start + 1), "character literal starts here")
            .help("close it with `'`, e.g. `'A'`"),
        );
      }
      chars.push(c);
      this.bump();
    }
    const span = new Span(start, this.pos);
    if (chars.length === 1) return ["char", chars[0]];
    if (chars.length === 0) {
      return this.fail(Diagnostic.error("E0003", "empty character literal").primary(span, "contains no character"));
    }
    return this.fail(
      Diagnostic.error("E0003", "character literal may only contain one character")
        .primary(span, `contains ${chars.length} characters`)
        .suggest(span, `"${chars.join("")}"`, "if you meant to write a STRING, use double quotes"),
    );
  }

  private digits(): void {
    while (isDigit(this.peek())) this.bump();
  }

  private number(start: number): [Kind, (number | string)?] {
    this.digits();
    const intEnd = this.pos;

    // Date literal: dd/mm/yyyy
    if (this.peek() === "/" && intEnd - start <= 2) {
      const save = this.pos;
      this.bump();
      const mStart = this.pos;
      this.digits();
      const mLen = this.pos - mStart;
      if (mLen >= 1 && mLen <= 2 && this.peek() === "/") {
        this.bump();
        const yStart = this.pos;
        this.digits();
        if (this.pos - yStart === 4) {
          const d = Number(this.src.slice(start, intEnd));
          const m = Number(this.src.slice(mStart, mStart + mLen));
          const y = Number(this.src.slice(yStart, this.pos));
          const days = daysFromCivil(y, m, d);
          if (days !== undefined) return ["date", days];
          return this.fail(
            Diagnostic.error("E0003", `invalid date \`${this.src.slice(start, this.pos)}\``)
              .primary(new Span(start, this.pos), "no such calendar day")
              .note("date literals are written dd/mm/yyyy"),
          );
        }
      }
      this.pos = save;
    }

    if (this.peek() === "." && isDigit(this.peek(1))) {
      this.bump();
      this.digits();
      return ["real", Number(this.src.slice(start, this.pos))];
    }
    const v = Number(this.src.slice(start, this.pos));
    if (Number.isSafeInteger(v)) return ["int", v];
    return this.fail(
      Diagnostic.error("E0003", "integer literal is too large")
        .primary(new Span(start, this.pos), "does not fit in an INTEGER")
        .note(`the largest INTEGER is ${Number.MAX_SAFE_INTEGER}`)
        .help("write it as a REAL, e.g. `12345678901234567890.0`"),
    );
  }
}
