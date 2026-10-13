//! rustc-style diagnostics: error codes, multi-label snippets, notes and
//! machine-applicable suggestions.

use crate::source::{Source, Span};
use std::collections::BTreeMap;
use std::fmt::Write as _;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Severity {
    Error,
    Warning,
}

#[derive(Clone, Debug)]
pub struct Label {
    pub span: Span,
    pub message: String,
    pub primary: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChildKind {
    Note,
    Help,
}

/// A trailing `note:` / `help:`. With a span it gets its own snippet; with a
/// replacement it is rendered as a suggested edit.
#[derive(Clone, Debug)]
pub struct Child {
    pub kind: ChildKind,
    pub message: String,
    pub span: Option<Span>,
    pub replacement: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Diagnostic {
    pub severity: Severity,
    pub code: Option<&'static str>,
    pub message: String,
    pub labels: Vec<Label>,
    pub children: Vec<Child>,
}

impl Diagnostic {
    pub fn error(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(Severity::Error, code, message)
    }

    pub fn warning(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(Severity::Warning, code, message)
    }

    fn new(severity: Severity, code: &'static str, message: impl Into<String>) -> Self {
        Diagnostic {
            severity,
            code: Some(code),
            message: message.into(),
            labels: Vec::new(),
            children: Vec::new(),
        }
    }

    pub fn primary(mut self, span: Span, message: impl Into<String>) -> Self {
        self.labels.push(Label {
            span,
            message: message.into(),
            primary: true,
        });
        self
    }

    pub fn secondary(mut self, span: Span, message: impl Into<String>) -> Self {
        self.labels.push(Label {
            span,
            message: message.into(),
            primary: false,
        });
        self
    }

    pub fn note(mut self, message: impl Into<String>) -> Self {
        self.children.push(Child {
            kind: ChildKind::Note,
            message: message.into(),
            span: None,
            replacement: None,
        });
        self
    }

    pub fn note_at(mut self, span: Span, message: impl Into<String>) -> Self {
        self.children.push(Child {
            kind: ChildKind::Note,
            message: message.into(),
            span: Some(span),
            replacement: None,
        });
        self
    }

    pub fn help(mut self, message: impl Into<String>) -> Self {
        self.children.push(Child {
            kind: ChildKind::Help,
            message: message.into(),
            span: None,
            replacement: None,
        });
        self
    }

    /// Suggest replacing `span` with `replacement`.
    pub fn suggest(
        mut self,
        span: Span,
        replacement: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        self.children.push(Child {
            kind: ChildKind::Help,
            message: message.into(),
            span: Some(span),
            replacement: Some(replacement.into()),
        });
        self
    }

    pub fn is_error(&self) -> bool {
        self.severity == Severity::Error
    }

    pub fn primary_span(&self) -> Option<Span> {
        self.labels.iter().find(|l| l.primary).map(|l| l.span)
    }
}

/// An ordered collection of diagnostics produced by one compilation.
#[derive(Default)]
pub struct Diagnostics {
    list: Vec<Diagnostic>,
}

impl Diagnostics {
    pub fn push(&mut self, d: Diagnostic) {
        self.list.push(d);
    }

    pub fn error_count(&self) -> usize {
        self.list.iter().filter(|d| d.is_error()).count()
    }

    pub fn warning_count(&self) -> usize {
        self.list.len() - self.error_count()
    }

    pub fn has_errors(&self) -> bool {
        self.error_count() > 0
    }

    pub fn iter(&self) -> impl Iterator<Item = &Diagnostic> {
        self.list.iter()
    }

    /// Diagnostics in source order (errors before warnings at the same spot).
    pub fn sorted(&self) -> Vec<&Diagnostic> {
        let mut v: Vec<&Diagnostic> = self.list.iter().collect();
        v.sort_by_key(|d| (d.primary_span().map_or(u32::MAX, |s| s.start), d.severity));
        v
    }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum Style {
    Plain,
    Error,
    Warning,
    Note,
    Help,
    Gutter,
    Secondary,
    Bold,
}

impl Style {
    fn ansi(self) -> &'static str {
        match self {
            Style::Plain => "",
            Style::Error => "\x1b[1;31m",
            Style::Warning => "\x1b[1;33m",
            Style::Note => "\x1b[1;36m",
            Style::Help => "\x1b[1;32m",
            Style::Gutter | Style::Secondary => "\x1b[1;34m",
            Style::Bold => "\x1b[1m",
        }
    }
}

/// Renders diagnostics against a [`Source`], optionally with ANSI colour.
pub struct Renderer<'a> {
    src: &'a Source,
    color: bool,
}

const TAB: &str = "    ";

impl<'a> Renderer<'a> {
    pub fn new(src: &'a Source, color: bool) -> Self {
        Renderer { src, color }
    }

    fn paint(&self, text: &str, style: Style) -> String {
        if self.color && style != Style::Plain && !text.is_empty() {
            format!("{}{}\x1b[0m", style.ansi(), text)
        } else {
            text.to_string()
        }
    }

    fn severity_style(sev: Severity) -> Style {
        match sev {
            Severity::Error => Style::Error,
            Severity::Warning => Style::Warning,
        }
    }

    pub fn render(&self, d: &Diagnostic) -> String {
        let mut out = String::new();
        let sev_style = Self::severity_style(d.severity);
        let word = match d.severity {
            Severity::Error => "error",
            Severity::Warning => "warning",
        };
        let head = match d.code {
            Some(c) => format!("{word}[{c}]"),
            None => word.to_string(),
        };
        let _ = writeln!(
            out,
            "{}{}",
            self.paint(&head, sev_style),
            self.paint(&format!(": {}", d.message), Style::Bold)
        );

        let gutter = self.gutter_width(d);
        if let Some(primary) = d
            .primary_span()
            .or_else(|| d.labels.first().map(|l| l.span))
        {
            self.location_line(&mut out, primary, gutter);
            let labels: Vec<(Span, &str, Style)> = d
                .labels
                .iter()
                .map(|l| {
                    let st = if l.primary {
                        sev_style
                    } else {
                        Style::Secondary
                    };
                    (l.span, l.message.as_str(), st)
                })
                .collect();
            self.snippet(&mut out, &labels, gutter);
        }

        // Plain notes/helps go in the `= note:` trailer; spanned ones get snippets.
        let (plain, spanned): (Vec<&Child>, Vec<&Child>) =
            d.children.iter().partition(|c| c.span.is_none());
        for c in plain {
            let (kw, st) = Self::child_kind(c.kind);
            let mut lines = c.message.lines();
            let first = lines.next().unwrap_or("");
            let _ = writeln!(
                out,
                "{} {}: {}",
                self.paint(&format!("{:>w$} =", "", w = gutter), Style::Gutter),
                self.paint(kw, st),
                first
            );
            for l in lines {
                let _ = writeln!(
                    out,
                    "{:>w$}   {}{}",
                    "",
                    " ".repeat(kw.len() + 2),
                    l,
                    w = gutter
                );
            }
        }
        for c in spanned {
            let (kw, st) = Self::child_kind(c.kind);
            let span = c.span.unwrap();
            let _ = writeln!(
                out,
                "{}{}",
                self.paint(kw, st),
                self.paint(&format!(": {}", c.message), Style::Bold)
            );
            match &c.replacement {
                Some(rep) => self.suggestion(&mut out, span, rep, gutter),
                None => {
                    self.location_line(&mut out, span, gutter);
                    self.snippet(&mut out, &[(span, "", st)], gutter);
                }
            }
        }
        out
    }

    fn child_kind(k: ChildKind) -> (&'static str, Style) {
        match k {
            ChildKind::Note => ("note", Style::Note),
            ChildKind::Help => ("help", Style::Help),
        }
    }

    fn gutter_width(&self, d: &Diagnostic) -> usize {
        let max_line = d
            .labels
            .iter()
            .map(|l| l.span)
            .chain(d.children.iter().filter_map(|c| c.span))
            .map(|s| self.src.line_index(s.end) + 1)
            .max()
            .unwrap_or(1);
        max_line.to_string().len()
    }

    fn location_line(&self, out: &mut String, span: Span, gutter: usize) {
        let (line, col) = self.src.line_col(span.start);
        let _ = writeln!(
            out,
            "{}{} {}:{}:{}",
            " ".repeat(gutter),
            self.paint("-->", Style::Gutter),
            self.src.name,
            line,
            col
        );
    }

    /// Display column (tab-expanded, character based) of a byte offset in a line.
    fn display_col(line_text: &str, byte_in_line: usize) -> usize {
        let mut col = 0;
        for (i, ch) in line_text.char_indices() {
            if i >= byte_in_line {
                break;
            }
            col += if ch == '\t' { TAB.len() } else { 1 };
        }
        col
    }

    fn snippet(&self, out: &mut String, labels: &[(Span, &str, Style)], gutter: usize) {
        struct OnLine<'m> {
            start: usize,
            end: usize,
            msg: &'m str,
            style: Style,
        }
        let mut by_line: BTreeMap<usize, Vec<OnLine>> = BTreeMap::new();
        for &(span, msg, style) in labels {
            let line = self.src.line_index(span.start);
            let text = self.src.line_text(line);
            let ls = self.src.line_start(line) as usize;
            let s_byte = span.start as usize - ls;
            let end_line = self.src.line_index(span.end.max(span.start + 1) - 1);
            let e_byte = if end_line == line {
                span.end as usize - ls
            } else {
                text.len()
            };
            let start = Self::display_col(text, s_byte);
            let end = Self::display_col(text, e_byte.min(text.len())).max(start + 1);
            let end = if e_byte > text.len() {
                end.max(start + 1)
            } else {
                end
            };
            let msg_owned: &str = msg;
            by_line.entry(line).or_default().push(OnLine {
                start,
                end,
                msg: msg_owned,
                style,
            });
        }

        let bar = self.paint(&format!("{:>w$} |", "", w = gutter), Style::Gutter);
        let _ = writeln!(out, "{bar}");
        let mut prev: Option<usize> = None;
        let lines: Vec<usize> = by_line.keys().copied().collect();
        for &line in &lines {
            if let Some(p) = prev {
                if line == p + 2 {
                    self.source_line(out, p + 1, gutter);
                } else if line > p + 2 {
                    let _ = writeln!(out, "{}", self.paint("...", Style::Gutter));
                }
            }
            self.source_line(out, line, gutter);
            let mut ls = by_line.remove(&line).unwrap();
            ls.sort_by_key(|l| l.start);

            // Underline row, carrying the rightmost label's message inline.
            let mut canvas = Canvas::default();
            for l in &ls {
                let ch = if l.style == Style::Secondary {
                    '-'
                } else {
                    '^'
                };
                for c in l.start..l.end {
                    canvas.put(c, ch, l.style);
                }
            }
            let last = ls.last().unwrap();
            if !last.msg.is_empty() {
                let col = ls.iter().map(|l| l.end).max().unwrap() + 1;
                canvas.text(col, last.msg, last.style);
            }
            let _ = writeln!(out, "{bar} {}", canvas.render(self));

            // Hanging messages for the remaining labels, right to left.
            let pending: Vec<&OnLine> = ls[..ls.len() - 1]
                .iter()
                .filter(|l| !l.msg.is_empty())
                .collect();
            for i in (0..pending.len()).rev() {
                let mut conn = Canvas::default();
                for l in &pending[..=i] {
                    conn.put(l.start, '|', l.style);
                }
                let _ = writeln!(out, "{bar} {}", conn.render(self));
                let mut msg = Canvas::default();
                for l in &pending[..i] {
                    msg.put(l.start, '|', l.style);
                }
                msg.text(pending[i].start, pending[i].msg, pending[i].style);
                let _ = writeln!(out, "{bar} {}", msg.render(self));
            }
            prev = Some(line);
        }
        let _ = writeln!(out, "{bar}");
    }

    fn source_line(&self, out: &mut String, line: usize, gutter: usize) {
        let text = self.src.line_text(line).replace('\t', TAB);
        let _ = writeln!(
            out,
            "{} {}",
            self.paint(&format!("{:>w$} |", line + 1, w = gutter), Style::Gutter),
            text
        );
    }

    fn suggestion(&self, out: &mut String, span: Span, replacement: &str, gutter: usize) {
        let line = self.src.line_index(span.start);
        let text = self.src.line_text(line);
        let ls = self.src.line_start(line) as usize;
        let s = span.start as usize - ls;
        let e = (span.end as usize - ls).min(text.len());
        let new_line = format!("{}{}{}", &text[..s], replacement, &text[e..]);
        let start_col = Self::display_col(text, s);
        let width = replacement.chars().count().max(1);
        let mark = if span.is_empty() { '+' } else { '~' };
        let bar = self.paint(&format!("{:>w$} |", "", w = gutter), Style::Gutter);
        let _ = writeln!(out, "{bar}");
        let _ = writeln!(
            out,
            "{} {}",
            self.paint(&format!("{:>w$} |", line + 1, w = gutter), Style::Gutter),
            new_line.replace('\t', TAB)
        );
        let marks: String = std::iter::repeat_n(mark, width).collect();
        let _ = writeln!(
            out,
            "{bar} {}{}",
            " ".repeat(start_col),
            self.paint(&marks, Style::Help)
        );
        let _ = writeln!(out, "{bar}");
    }

    /// The closing `error: aborting ...` summary line.
    pub fn summary(&self, diags: &Diagnostics) -> String {
        let (e, w) = (diags.error_count(), diags.warning_count());
        let plural = |n: usize| if n == 1 { "" } else { "s" };
        let mut out = String::new();
        if w > 0 {
            let _ = writeln!(
                out,
                "{}{}",
                self.paint("warning", Style::Warning),
                self.paint(
                    &format!(": `{}` generated {w} warning{}", self.src.name, plural(w)),
                    Style::Bold
                )
            );
        }
        if e > 0 {
            let _ = writeln!(
                out,
                "{}{}",
                self.paint("error", Style::Error),
                self.paint(
                    &format!(
                        ": could not compile `{}` due to {e} previous error{}",
                        self.src.name,
                        plural(e)
                    ),
                    Style::Bold
                )
            );
            let codes: std::collections::BTreeSet<&str> = diags
                .iter()
                .filter(|d| d.is_error())
                .filter_map(|d| d.code)
                .collect();
            if let Some(first) = codes.iter().next() {
                let _ = writeln!(
                    out,
                    "{}",
                    self.paint(
                        &format!(
                            "For more information about an error, try `pseudo explain {first}`."
                        ),
                        Style::Bold
                    )
                );
            }
        }
        out
    }
}

/// A sparse row of styled characters used to draw underline/annotation rows.
#[derive(Default)]
struct Canvas {
    cells: Vec<(char, Style)>,
}

impl Canvas {
    fn put(&mut self, col: usize, ch: char, style: Style) {
        if self.cells.len() <= col {
            self.cells.resize(col + 1, (' ', Style::Plain));
        }
        self.cells[col] = (ch, style);
    }

    fn text(&mut self, col: usize, s: &str, style: Style) {
        for (i, ch) in s.chars().enumerate() {
            self.put(col + i, ch, style);
        }
    }

    fn render(&self, r: &Renderer) -> String {
        let mut out = String::new();
        let mut run = String::new();
        let mut run_style = Style::Plain;
        for &(ch, st) in &self.cells {
            if st != run_style && !run.is_empty() {
                out += &r.paint(&run, run_style);
                run.clear();
            }
            run_style = st;
            run.push(ch);
        }
        out += &r.paint(&run, run_style);
        out.trim_end().to_string()
    }
}

// ---------------------------------------------------------------------------
// "Did you mean" helpers
// ---------------------------------------------------------------------------

/// Optimal string alignment distance (Levenshtein + adjacent transpositions).
pub fn edit_distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut d = vec![vec![0usize; b.len() + 1]; a.len() + 1];
    for (i, row) in d.iter_mut().enumerate() {
        row[0] = i;
    }
    for (j, cell) in d[0].iter_mut().enumerate() {
        *cell = j;
    }
    for i in 1..=a.len() {
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            d[i][j] = (d[i - 1][j] + 1)
                .min(d[i][j - 1] + 1)
                .min(d[i - 1][j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                d[i][j] = d[i][j].min(d[i - 2][j - 2] + 1);
            }
        }
    }
    d[a.len()][b.len()]
}

/// Best close match for `name` among `candidates`, preferring case-only
/// differences.
pub fn best_match<'c, I>(name: &str, candidates: I) -> Option<&'c str>
where
    I: IntoIterator<Item = &'c str>,
{
    // Very short names only match case-insensitively; anything else is noise.
    let len = name.chars().count();
    let limit = if len < 3 { 0 } else { (len / 3).max(1) };
    let lower = name.to_lowercase();
    let mut best: Option<(usize, &str)> = None;
    for c in candidates {
        if c == name {
            continue;
        }
        let dist = if c.to_lowercase() == lower {
            0
        } else {
            edit_distance(&lower, &c.to_lowercase())
        };
        if dist <= limit && best.is_none_or(|(d, _)| dist < d) {
            best = Some((dist, c));
        }
    }
    best.map(|(_, c)| c)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distance() {
        assert_eq!(edit_distance("kitten", "sitting"), 3);
        assert_eq!(edit_distance("Countr", "Counter"), 1);
        assert_eq!(edit_distance("ab", "ba"), 1);
    }

    #[test]
    fn suggests_case_insensitive_first() {
        assert_eq!(best_match("total", ["Total", "tota"]), Some("Total"));
        assert_eq!(best_match("xyz", ["Total"]), None);
    }

    #[test]
    fn renders_labels() {
        let src = Source::new("t.pseudo", "DECLARE X : INTEGER\nX <- \"hi\"\n");
        let d = Diagnostic::error("E0300", "mismatched types")
            .primary(Span::new(25, 29), "expected `INTEGER`, found `STRING`")
            .secondary(Span::new(20, 21), "has type `INTEGER`");
        let out = Renderer::new(&src, false).render(&d);
        assert!(out.contains("error[E0300]: mismatched types"), "{out}");
        assert!(out.contains("--> t.pseudo:2:6"), "{out}");
        assert!(
            out.contains("^^^^ expected `INTEGER`, found `STRING`"),
            "{out}"
        );
        assert!(out.contains("has type `INTEGER`"), "{out}");
    }
}
