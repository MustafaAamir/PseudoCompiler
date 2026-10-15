/** Source files and spans. Offsets are UTF-16 code units (JavaScript string indices). */

/** A half-open range `[start, end)` into a {@link Source}. */
export class Span {
  static readonly DUMMY = new Span(0, 0);

  constructor(readonly start: number, readonly end: number) {}

  /** The smallest span covering both. */
  to(other: Span): Span {
    return new Span(Math.min(this.start, other.start), Math.max(this.end, other.end));
  }

  /** An empty span just after this one. */
  after(): Span {
    return new Span(this.end, this.end);
  }

  isEmpty(): boolean {
    return this.start === this.end;
  }

  equals(other: Span): boolean {
    return this.start === other.start && this.end === other.end;
  }
}

/** A named source text with a precomputed line table. */
export class Source {
  private readonly lineStarts: number[] = [0];

  constructor(readonly name: string, readonly text: string) {
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) this.lineStarts.push(i + 1);
    }
  }

  slice(span: Span): string {
    return this.text.slice(span.start, span.end);
  }

  /** Zero-based line containing `offset`. */
  lineIndex(offset: number): number {
    let lo = 0, hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  lineStart(line: number): number {
    return this.lineStarts[line];
  }

  /** Text of a zero-based line without its line terminator. */
  lineText(line: number): string {
    const end = line + 1 < this.lineStarts.length ? this.lineStarts[line + 1] : this.text.length;
    return this.text.slice(this.lineStarts[line], end).replace(/\r?\n$/, "");
  }

  /** One-based `[line, column]`; columns count code points. */
  lineCol(offset: number): [number, number] {
    const line = this.lineIndex(offset);
    const prefix = this.text.slice(this.lineStarts[line], Math.min(offset, this.text.length));
    return [line + 1, [...prefix].length + 1];
  }
}
