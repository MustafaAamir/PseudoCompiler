//! Run-time errors, rendered as diagnostics with a backtrace and the values
//! of the local variables in the failing frame.

use crate::diag::Diagnostic;
use crate::source::Span;

/// A failure raised by an instruction, before location information is
/// attached. Boxed so that `Result<_, Fault>` stays one word wide on the
/// interpreter's hot paths.
#[derive(Debug)]
pub struct Fault(Box<FaultInfo>);

#[derive(Debug)]
pub struct FaultInfo {
    pub code: &'static str,
    pub message: String,
    pub label: String,
    pub secondary: Vec<(Span, String)>,
    pub notes: Vec<String>,
    pub help: Option<String>,
}

impl std::ops::Deref for Fault {
    type Target = FaultInfo;

    fn deref(&self) -> &FaultInfo {
        &self.0
    }
}

impl Fault {
    pub fn new(code: &'static str, message: impl Into<String>, label: impl Into<String>) -> Self {
        Fault(Box::new(FaultInfo {
            code,
            message: message.into(),
            label: label.into(),
            secondary: Vec::new(),
            notes: Vec::new(),
            help: None,
        }))
    }

    pub fn note(mut self, n: impl Into<String>) -> Self {
        self.0.notes.push(n.into());
        self
    }

    pub fn help(mut self, h: impl Into<String>) -> Self {
        self.0.help = Some(h.into());
        self
    }

    pub fn secondary(mut self, span: Span, msg: impl Into<String>) -> Self {
        if span != Span::DUMMY {
            self.0.secondary.push((span, msg.into()));
        }
        self
    }

    pub fn type_error(expected: &str, found: &str) -> Self {
        Fault::new(
            "R0004",
            format!("type error: expected {expected}, found {found}"),
            format!("this produced a {found}"),
        )
    }
}

#[derive(Debug)]
pub struct TraceFrame {
    pub name: String,
    pub span: Span,
}

#[derive(Debug)]
pub struct RuntimeError {
    pub fault: Fault,
    pub span: Span,
    /// Innermost first.
    pub backtrace: Vec<TraceFrame>,
    pub locals: Vec<(String, String)>,
}

impl RuntimeError {
    pub fn to_diagnostic(&self) -> Diagnostic {
        let f = &self.fault;
        let mut d = Diagnostic::error(f.code, format!("run-time error: {}", f.message)).primary(self.span, &f.label);
        for (s, m) in &f.secondary {
            d = d.secondary(*s, m);
        }
        if let Some(fr) = self.backtrace.first() {
            d = d.note(format!("in {} (call depth {})", fr.name, self.backtrace.len()));
        }
        if !self.locals.is_empty() {
            let vals: Vec<String> = self.locals.iter().map(|(n, v)| format!("{n} = {v}")).collect();
            d = d.note(format!("variables at the time of the error:\n  {}", vals.join("\n  ")));
        }
        for n in &f.notes {
            d = d.note(n);
        }
        if let Some(h) = &f.help {
            d = d.help(h);
        }
        // Collapse runs of identical frames (recursion) into one entry.
        const SHOWN: usize = 8;
        let mut runs: Vec<(&TraceFrame, usize)> = Vec::new();
        for fr in self.backtrace.iter().skip(1) {
            match runs.last_mut() {
                Some((prev, n)) if prev.name == fr.name && prev.span == fr.span => *n += 1,
                _ => runs.push((fr, 1)),
            }
        }
        for (fr, n) in runs.iter().take(SHOWN) {
            let times = if *n > 1 { format!(" ({n} times, recursively)") } else { String::new() };
            d = d.note_at(fr.span, format!("called from {}{times}", fr.name));
        }
        if runs.len() > SHOWN {
            d = d.note(format!("... and {} more call sites", runs.len() - SHOWN));
        }
        d
    }
}
