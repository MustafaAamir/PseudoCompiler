//! The data model shared by the pseudocode compiler and VM: source spans,
//! diagnostics, run-time values, bytecode and built-in routine signatures.

/// `writeln!` into a `String`, which cannot fail.
macro_rules! outln {
    ($out:expr, $($arg:tt)*) => {{
        let _ = writeln!($out, $($arg)*);
    }};
}

pub mod builtins;
pub mod bytecode;
pub mod diag;
pub mod source;
pub mod value;

pub use source::{Source, Span};
