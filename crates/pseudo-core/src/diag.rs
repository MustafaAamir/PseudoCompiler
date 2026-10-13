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

/// A trailing `note:`/`help:`. With a span it gets its own snippet; with a
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
    pub code: &'static str,
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
        Diagnostic { severity, code, message: message.into(), labels: Vec::new(), children: Vec::new() }
    }

    fn label(mut self, span: Span, message: impl Into<String>, primary: bool) -> Self {
        self.labels.push(Label { span, message: message.into(), primary });
        self
    }

    fn child(
        mut self,
        kind: ChildKind,
        span: Option<Span>,
        replacement: Option<String>,
        message: impl Into<String>,
    ) -> Self {
        self.children.push(Child { kind, message: message.into(), span, replacement });
        self
    }

    pub fn primary(self, span: Span, message: impl Into<String>) -> Self {
        self.label(span, message, true)
    }

    pub fn secondary(self, span: Span, message: impl Into<String>) -> Self {
        self.label(span, message, false)
    }

    pub fn note(self, message: impl Into<String>) -> Self {
        self.child(ChildKind::Note, None, None, message)
    }

    pub fn note_at(self, span: Span, message: impl Into<String>) -> Self {
        self.child(ChildKind::Note, Some(span), None, message)
    }

    pub fn help(self, message: impl Into<String>) -> Self {
        self.child(ChildKind::Help, None, None, message)
    }

    /// Suggest replacing `span` with `replacement`.
    pub fn suggest(self, span: Span, replacement: impl Into<String>, message: impl Into<String>) -> Self {
        self.child(ChildKind::Help, Some(span), Some(replacement.into()), message)
    }

    pub fn is_error(&self) -> bool {
        self.severity == Severity::Error
    }

    pub fn primary_span(&self) -> Option<Span> {
        self.labels.iter().find(|l| l.primary).map(|l| l.span)
    }
}

/// The diagnostics produced by one compilation.
#[derive(Default)]
pub struct Diagnostics(Vec<Diagnostic>);

impl Diagnostics {
    pub fn push(&mut self, d: Diagnostic) {
        self.0.push(d);
    }

    pub fn error_count(&self) -> usize {
        self.0.iter().filter(|d| d.is_error()).count()
    }

    pub fn warning_count(&self) -> usize {
        self.0.len() - self.error_count()
    }

    pub fn has_errors(&self) -> bool {
        self.error_count() > 0
    }

    /// Source order; errors before warnings at the same position.
    pub fn sorted(&self) -> Vec<&Diagnostic> {
        let mut v: Vec<&Diagnostic> = self.0.iter().collect();
        v.sort_by_key(|d| (d.primary_span().map_or(u32::MAX, |s| s.start), d.severity));
        v
    }
}

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
            format!("{}{text}\x1b[0m", style.ansi())
        } else {
            text.to_string()
        }
    }

    /// `kind: message` heading, e.g. `error[E0300]: mismatched types`.
    fn heading(&self, out: &mut String, kind: &str, style: Style, message: &str) {
        outln!(out, "{}{}", self.paint(kind, style), self.paint(&format!(": {message}"), Style::Bold));
    }

    /// The gutter: blank (`   |`) or numbered (` 12 |`).
    fn bar(&self, line: Option<usize>, gutter: usize) -> String {
        let num = line.map_or(String::new(), |l| (l + 1).to_string());
        self.paint(&format!("{num:>gutter$} |"), Style::Gutter)
    }

    pub fn render(&self, d: &Diagnostic) -> String {
        let mut out = String::new();
        let (word, sev_style) = match d.severity {
            Severity::Error => ("error", Style::Error),
            Severity::Warning => ("warning", Style::Warning),
        };
        self.heading(&mut out, &format!("{word}[{}]", d.code), sev_style, &d.message);

        let gutter = self.gutter_width(d);
        if let Some(primary) = d.primary_span().or_else(|| d.labels.first().map(|l| l.span)) {
            self.location(&mut out, primary, gutter);
            let labels: Vec<(Span, &str, Style)> = d
                .labels
                .iter()
                .map(|l| (l.span, l.message.as_str(), if l.primary { sev_style } else { Style::Secondary }))
                .collect();
            self.snippet(&mut out, &labels, gutter);
        }

        // Plain notes/helps go in the `= note:` trailer; spanned ones get snippets.
        let (plain, spanned): (Vec<&Child>, Vec<&Child>) = d.children.iter().partition(|c| c.span.is_none());
        for c in plain {
            let (kw, st) = Self::child_kind(c.kind);
            let mut lines = c.message.lines();
            let eq = self.paint(&format!("{:>gutter$} =", ""), Style::Gutter);
            outln!(out, "{eq} {}: {}", self.paint(kw, st), lines.next().unwrap_or(""));
            for l in lines {
                outln!(out, "{:>gutter$}   {}{l}", "", " ".repeat(kw.len() + 2));
            }
        }
        for c in spanned {
            let (kw, st) = Self::child_kind(c.kind);
            let span = c.span.unwrap();
            self.heading(&mut out, kw, st, &c.message);
            match &c.replacement {
                Some(rep) => self.suggestion(&mut out, span, rep, gutter),
                None => {
                    self.location(&mut out, span, gutter);
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
        let spans = d.labels.iter().map(|l| l.span).chain(d.children.iter().filter_map(|c| c.span));
        let max_line = spans.map(|s| self.src.line_index(s.end) + 1).max().unwrap_or(1);
        max_line.to_string().len()
    }

    fn location(&self, out: &mut String, span: Span, gutter: usize) {
        let (line, col) = self.src.line_col(span.start);
        outln!(out, "{}{} {}:{line}:{col}", " ".repeat(gutter), self.paint("-->", Style::Gutter), self.src.name);
    }

    /// Display column (tab-expanded, character based) of a byte offset in a line.
    fn display_col(line_text: &str, byte_in_line: usize) -> usize {
        line_text
            .char_indices()
            .take_while(|&(i, _)| i < byte_in_line)
            .map(|(_, ch)| if ch == '\t' { TAB.len() } else { 1 })
            .sum()
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
            // Multi-line spans are underlined to the end of their first line.
            let end_line = self.src.line_index(span.end.max(span.start + 1) - 1);
            let e_byte = if end_line == line { span.end as usize - ls } else { text.len() };
            let start = Self::display_col(text, span.start as usize - ls);
            let end = Self::display_col(text, e_byte.min(text.len())).max(start + 1);
            by_line.entry(line).or_default().push(OnLine { start, end, msg, style });
        }

        let bar = self.bar(None, gutter);
        outln!(out, "{bar}");
        let mut prev: Option<usize> = None;
        for (line, mut ls) in by_line {
            match prev {
                Some(p) if line == p + 2 => self.source_line(out, p + 1, gutter),
                Some(p) if line > p + 2 => {
                    outln!(out, "{}", self.paint("...", Style::Gutter));
                }
                _ => {}
            }
            self.source_line(out, line, gutter);
            ls.sort_by_key(|l| l.start);

            // Underline row, carrying the rightmost label's message inline.
            let mut canvas = Canvas::default();
            for l in &ls {
                let ch = if l.style == Style::Secondary { '-' } else { '^' };
                for c in l.start..l.end {
                    canvas.put(c, ch, l.style);
                }
            }
            let last = ls.last().unwrap();
            let col = ls.iter().map(|l| l.end).max().unwrap() + 1;
            canvas.text(col, last.msg, last.style);
            outln!(out, "{bar} {}", canvas.render(self));

            // Hanging messages for the remaining labels, right to left.
            let pending: Vec<&OnLine> = ls[..ls.len() - 1].iter().filter(|l| !l.msg.is_empty()).collect();
            for i in (0..pending.len()).rev() {
                let mut conn = Canvas::default();
                for l in &pending[..=i] {
                    conn.put(l.start, '|', l.style);
                }
                outln!(out, "{bar} {}", conn.render(self));
                let mut msg = Canvas::default();
                for l in &pending[..i] {
                    msg.put(l.start, '|', l.style);
                }
                msg.text(pending[i].start, pending[i].msg, pending[i].style);
                outln!(out, "{bar} {}", msg.render(self));
            }
            prev = Some(line);
        }
        outln!(out, "{bar}");
    }

    fn source_line(&self, out: &mut String, line: usize, gutter: usize) {
        outln!(out, "{} {}", self.bar(Some(line), gutter), self.src.line_text(line).replace('\t', TAB));
    }

    fn suggestion(&self, out: &mut String, span: Span, replacement: &str, gutter: usize) {
        let line = self.src.line_index(span.start);
        let text = self.src.line_text(line);
        let ls = self.src.line_start(line) as usize;
        let s = span.start as usize - ls;
        let e = (span.end as usize - ls).min(text.len());
        let new_line = format!("{}{replacement}{}", &text[..s], &text[e..]);
        let mark = if span.is_empty() { "+" } else { "~" };
        let marks = mark.repeat(replacement.chars().count().max(1));
        let bar = self.bar(None, gutter);
        outln!(out, "{bar}");
        outln!(out, "{} {}", self.bar(Some(line), gutter), new_line.replace('\t', TAB));
        outln!(out, "{bar} {}{}", " ".repeat(Self::display_col(text, s)), self.paint(&marks, Style::Help));
        outln!(out, "{bar}");
    }

    /// The closing `error: could not compile ...` summary.
    pub fn summary(&self, diags: &Diagnostics) -> String {
        let (e, w) = (diags.error_count(), diags.warning_count());
        let plural = |n: usize| if n == 1 { "" } else { "s" };
        let name = &self.src.name;
        let mut out = String::new();
        if w > 0 {
            self.heading(&mut out, "warning", Style::Warning, &format!("`{name}` generated {w} warning{}", plural(w)));
        }
        if e > 0 {
            let msg = format!("could not compile `{name}` due to {e} previous error{}", plural(e));
            self.heading(&mut out, "error", Style::Error, &msg);
            if let Some(first) = diags.sorted().into_iter().find(|d| d.is_error()) {
                let hint = format!("For more information about an error, try `pseudo explain {}`.", first.code);
                outln!(out, "{}", self.paint(&hint, Style::Bold));
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
            d[i][j] = (d[i - 1][j] + 1).min(d[i][j - 1] + 1).min(d[i - 1][j - 1] + cost);
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
        let dist = if c.to_lowercase() == lower { 0 } else { edit_distance(&lower, &c.to_lowercase()) };
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
        assert!(out.contains("^^^^ expected `INTEGER`, found `STRING`"), "{out}");
        assert!(out.contains("has type `INTEGER`"), "{out}");
    }
}
