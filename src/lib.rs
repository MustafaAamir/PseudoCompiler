//! `pseudo`: a single-pass compiler and Smalltalk-style bytecode VM for
//! Cambridge-style pseudocode.
//!
//! Pipeline: [`lexer`] (lazy, pulled by the compiler) → [`compiler`]
//! (recursive descent that type-checks and emits [`bytecode`] directly, no
//! AST) → [`vm`] (stack machine with inline-cached message sends).

/// `writeln!` into a `String`, which cannot fail.
macro_rules! outln {
    ($out:expr, $($arg:tt)*) => {{
        let _ = writeln!($out, $($arg)*);
    }};
}

pub mod builtins;
pub mod bytecode;
pub mod compiler;
pub mod diag;
pub mod explain;
pub mod lexer;
pub mod source;
pub mod value;
pub mod vm;

pub use compiler::compile;
pub use source::Source;
