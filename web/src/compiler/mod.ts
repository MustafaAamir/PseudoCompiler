/** The single-pass compiler: source text in, bytecode and diagnostics out. */

import type { Program } from "../core/bytecode.ts";
import type { Diagnostics } from "../core/diag.ts";
import type { Source } from "../core/source.ts";
import { Compiler } from "./state.ts";
import { program } from "./stmt.ts";

export interface CompileOptions {
  /** Interactive mode: bare expressions are allowed and, like assignments, report their values through ECHO. */
  readonly repl?: boolean;
}

/** Compile a source file. The program is present only if there were no errors; diagnostics include warnings. */
export function compile(src: Source, options: CompileOptions = {}): { program?: Program; diagnostics: Diagnostics } {
  const c = new Compiler(src);
  c.repl = options.repl ?? false;
  program(c);
  const [prog, diagnostics] = c.finish();
  return { program: prog, diagnostics };
}

export { describe, isBlockEnd, isKeyword, KEYWORDS, type Kind, Lexer, type Token } from "./lexer.ts";
