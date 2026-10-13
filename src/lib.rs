//! `pseudo`: a single-pass compiler and Smalltalk-style bytecode VM for
//! Cambridge-style pseudocode.
//!
//! Pipeline: [`lexer`] (lazy, pulled by the compiler) → [`compiler`]
//! (recursive descent that type-checks and emits [`bytecode`] directly, no
//! AST) → [`vm`] (stack machine with inline-cached message sends).

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

use std::io::{BufRead, Write};

/// Outcome of [`run_source`].
pub struct RunOutcome {
    pub diagnostics: diag::Diagnostics,
    pub runtime_error: Option<Box<vm::RuntimeError>>,
    pub compiled: bool,
}

/// Compile and run a program, writing program output to `out`.
pub fn run_source(src: &Source, out: &mut dyn Write, input: &mut dyn BufRead) -> RunOutcome {
    let (program, diagnostics) = compile(src);
    let Some(program) = program else {
        return RunOutcome {
            diagnostics,
            runtime_error: None,
            compiled: false,
        };
    };
    let mut vm = vm::Vm::new(&program, Box::new(out), Box::new(input));
    let runtime_error = vm.run().err();
    RunOutcome {
        diagnostics,
        runtime_error,
        compiled: true,
    }
}
