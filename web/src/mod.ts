/**
 * pseudo: a single-pass compiler and Smalltalk-style bytecode VM for
 * Cambridge-style pseudocode, for browsers and Deno.
 *
 * Pipeline: lexer (pulled lazily by the compiler) -> compiler (recursive
 * descent that type-checks and emits bytecode directly, no AST) -> VM
 * (resumable stack machine with inline-cached message sends), driven by
 * Effect services for I/O.
 */

export { type Builtin, BUILTINS, signatureOf } from "./core/builtins.ts";
export { Op, Program, Proto } from "./core/bytecode.ts";
export { bestMatch, Diagnostic, Diagnostics, escapeHtml, Renderer, type RenderMode } from "./core/diag.ts";
export { Source, Span } from "./core/source.ts";
export {
  compile,
  type CompileOptions,
  describe,
  isBlockEnd,
  isKeyword,
  KEYWORDS,
  type Kind,
  Lexer,
  type Token,
} from "./compiler/mod.ts";
export { RuntimeError } from "./vm/fault.ts";
export { VirtualFs } from "./vm/files.ts";
export { type Echo, type SendSite, type Stats, type Step, Vm, type VmHost } from "./vm/vm.ts";
export { explain, EXPLANATIONS } from "./explain.ts";
export {
  CompileError,
  compileSource,
  Console,
  drive,
  Files,
  type InputRequest,
  type MemoryIo,
  memoryIo,
  type RunResult,
  runSource,
  RuntimeFailure,
  Session,
  Stdin,
  type SubmitResult,
  VmConfig,
  type VmSettings,
} from "./runtime.ts";
