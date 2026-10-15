/** Run-time errors, rendered as diagnostics with a backtrace and the variables of the failing frame. */

import { Diagnostic } from "../core/diag.ts";
import { Span } from "../core/source.ts";

/** A failure raised by an instruction, before location information is attached. */
export class Fault {
  readonly secondary: [Span, string][] = [];
  readonly notes: string[] = [];
  helpText: string | undefined;

  constructor(readonly code: string, readonly message: string, readonly label: string) {}

  note(n: string): this {
    this.notes.push(n);
    return this;
  }

  help(h: string): this {
    this.helpText = h;
    return this;
  }

  withSecondary(span: Span, msg: string): this {
    if (!span.equals(Span.DUMMY)) this.secondary.push([span, msg]);
    return this;
  }

  static typeError(expected: string, found: string): Fault {
    return new Fault("R0004", `type error: expected ${expected}, found ${found}`, `this produced a ${found}`);
  }
}

export interface TraceFrame {
  readonly name: string;
  readonly span: Span;
}

/** A located run-time error. */
export class RuntimeError extends Error {
  constructor(
    readonly fault: Fault,
    readonly span: Span,
    /** Innermost first. */
    readonly backtrace: readonly TraceFrame[],
    readonly locals: readonly [string, string][],
  ) {
    super(fault.message);
    this.name = "RuntimeError";
  }

  toDiagnostic(): Diagnostic {
    const f = this.fault;
    const d = Diagnostic.error(f.code, `run-time error: ${f.message}`).primary(this.span, f.label);
    for (const [s, m] of f.secondary) d.secondary(s, m);
    if (this.backtrace.length) d.note(`in ${this.backtrace[0].name} (call depth ${this.backtrace.length})`);
    if (this.locals.length) {
      d.note(`variables at the time of the error:\n  ${this.locals.map(([n, v]) => `${n} = ${v}`).join("\n  ")}`);
    }
    for (const n of f.notes) d.note(n);
    if (f.helpText) d.help(f.helpText);
    // Collapse runs of identical frames (recursion) into one entry.
    const SHOWN = 8;
    const runs: [TraceFrame, number][] = [];
    for (const fr of this.backtrace.slice(1)) {
      const last = runs[runs.length - 1];
      if (last && last[0].name === fr.name && last[0].span.equals(fr.span)) last[1]++;
      else runs.push([fr, 1]);
    }
    for (const [fr, n] of runs.slice(0, SHOWN)) {
      d.noteAt(fr.span, `called from ${fr.name}${n > 1 ? ` (${n} times, recursively)` : ""}`);
    }
    if (runs.length > SHOWN) d.note(`... and ${runs.length - SHOWN} more call sites`);
    return d;
  }
}
