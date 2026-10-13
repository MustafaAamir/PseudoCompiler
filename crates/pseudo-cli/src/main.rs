mod explain;

use pseudo_compiler::compile;
use pseudo_compiler::lexer::{Lexer, Tok};
use pseudo_core::Source;
use pseudo_core::diag::Renderer;
use pseudo_vm as vm;
use std::io::{self, IsTerminal, Write};
use std::process::ExitCode;

const USAGE: &str = "\
pseudo — compiler and VM for Cambridge-style pseudocode

USAGE:
    pseudo [run] <file> [--trace] [--stats]   compile and run a program
    pseudo check <file>                       type-check only
    pseudo disasm <file>                      show bytecode with debug info
    pseudo tokens <file>                      show the token stream
    pseudo explain <CODE>                     explain an error code (e.g. E0300)

OPTIONS:
    --trace          print every instruction executed (to stderr)
    --stats          print execution and inline-cache statistics
    --deny-warnings  treat warnings as errors
    --no-color       disable coloured diagnostics (also: NO_COLOR=1)
";

struct Opts {
    trace: bool,
    stats: bool,
    deny_warnings: bool,
    color: bool,
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut opts = Opts {
        trace: false,
        stats: false,
        deny_warnings: false,
        color: io::stderr().is_terminal() && std::env::var_os("NO_COLOR").is_none(),
    };
    let mut positional = Vec::new();
    for a in &args {
        match a.as_str() {
            "--trace" => opts.trace = true,
            "--stats" => opts.stats = true,
            "--deny-warnings" => opts.deny_warnings = true,
            "--no-color" => opts.color = false,
            "-h" | "--help" => {
                print!("{USAGE}");
                return ExitCode::SUCCESS;
            }
            flag if flag.starts_with("--") => {
                eprintln!("error: unknown option `{flag}`\n\n{USAGE}");
                return ExitCode::from(64);
            }
            _ => positional.push(a.as_str()),
        }
    }
    match positional.as_slice() {
        ["explain", code] => match explain::explain(code) {
            Some(text) => {
                println!("{}\n\n{text}", code.to_uppercase());
                ExitCode::SUCCESS
            }
            None => {
                eprintln!("error: no explanation for `{code}`");
                ExitCode::from(64)
            }
        },
        ["run", file] | [file] if *file != "explain" => with_source(file, |src| run(src, &opts)),
        ["check", file] => with_source(file, |src| check(src, &opts)),
        ["disasm", file] => with_source(file, |src| disasm(src, &opts)),
        ["tokens", file] => with_source(file, tokens),
        _ => {
            eprint!("{USAGE}");
            ExitCode::from(64)
        }
    }
}

fn with_source(path: &str, f: impl FnOnce(&Source) -> ExitCode) -> ExitCode {
    match std::fs::read_to_string(path) {
        Ok(text) => f(&Source::new(path, text)),
        Err(e) => {
            eprintln!("error: cannot read `{path}`: {e}");
            ExitCode::from(66)
        }
    }
}

/// Print diagnostics; returns `None` if compilation failed.
fn report(src: &Source, opts: &Opts) -> Option<pseudo_core::bytecode::Program> {
    let (program, diags) = compile(src);
    let r = Renderer::new(src, opts.color);
    let mut err = io::stderr().lock();
    for d in diags.sorted() {
        let _ = writeln!(err, "{}", r.render(d));
    }
    let _ = write!(err, "{}", r.summary(&diags));
    if opts.deny_warnings && diags.warning_count() > 0 {
        let _ = writeln!(err, "error: aborting because of warnings (--deny-warnings)");
        return None;
    }
    program
}

fn run(src: &Source, opts: &Opts) -> ExitCode {
    let Some(program) = report(src, opts) else {
        return ExitCode::FAILURE;
    };
    let stdout = io::stdout();
    let stdin = io::stdin();
    let mut vm = vm::Vm::new(&program, Box::new(io::BufWriter::new(stdout.lock())), Box::new(stdin.lock()));
    vm.trace = opts.trace;
    let start = std::time::Instant::now();
    let result = vm.run();
    let elapsed = start.elapsed();
    if opts.stats {
        eprintln!("{}", vm.report());
        eprintln!("wall time             : {elapsed:.2?}");
    }
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            let r = Renderer::new(src, opts.color);
            eprintln!("{}", r.render(&e.to_diagnostic()));
            ExitCode::from(2)
        }
    }
}

fn check(src: &Source, opts: &Opts) -> ExitCode {
    match report(src, opts) {
        Some(_) => {
            eprintln!("`{}` type-checks successfully", src.name);
            ExitCode::SUCCESS
        }
        None => ExitCode::FAILURE,
    }
}

fn disasm(src: &Source, opts: &Opts) -> ExitCode {
    let Some(program) = report(src, opts) else {
        return ExitCode::FAILURE;
    };
    print!("{}", program.disassemble(src));
    ExitCode::SUCCESS
}

fn tokens(src: &Source) -> ExitCode {
    let mut lx = Lexer::new(&src.text);
    loop {
        let t = lx.next_token();
        let (line, col) = src.line_col(t.span.start);
        let nl = if t.line_start { "⏎" } else { " " };
        println!("{line:>4}:{col:<3} {nl} {:<24} {:?}", format!("{:?}", t.tok), src.slice(t.span));
        if let Some(d) = lx.take_error() {
            eprintln!("{}", Renderer::new(src, false).render(&d));
        }
        if t.tok == Tok::Eof {
            return ExitCode::SUCCESS;
        }
    }
}
