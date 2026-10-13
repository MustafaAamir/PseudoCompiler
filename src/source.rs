//! Source files and byte-offset spans.

/// A half-open byte range `[start, end)` into a [`Source`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Span {
    pub start: u32,
    pub end: u32,
}

impl Span {
    pub const DUMMY: Span = Span { start: 0, end: 0 };

    pub fn new(start: usize, end: usize) -> Self {
        Span { start: start as u32, end: end as u32 }
    }

    /// The smallest span covering both `self` and `other`.
    pub fn to(self, other: Span) -> Span {
        Span { start: self.start.min(other.start), end: self.end.max(other.end) }
    }

    /// An empty span positioned just after `self`.
    pub fn after(self) -> Span {
        Span { start: self.end, end: self.end }
    }

    pub fn is_empty(self) -> bool {
        self.start == self.end
    }

    pub fn range(self) -> std::ops::Range<usize> {
        self.start as usize..self.end as usize
    }
}

/// A named source file with a precomputed line table.
pub struct Source {
    pub name: String,
    pub text: String,
    line_starts: Vec<u32>,
}

impl Source {
    pub fn new(name: impl Into<String>, text: impl Into<String>) -> Self {
        let text = text.into();
        let line_starts = std::iter::once(0).chain(text.match_indices('\n').map(|(i, _)| i as u32 + 1)).collect();
        Source { name: name.into(), text, line_starts }
    }

    pub fn slice(&self, span: Span) -> &str {
        &self.text[span.range()]
    }

    /// Zero-based line index containing `offset`.
    pub fn line_index(&self, offset: u32) -> usize {
        match self.line_starts.binary_search(&offset) {
            Ok(i) => i,
            Err(i) => i - 1,
        }
    }

    pub fn line_start(&self, line: usize) -> u32 {
        self.line_starts[line]
    }

    /// Text of a zero-based line, without its trailing newline.
    pub fn line_text(&self, line: usize) -> &str {
        let start = self.line_starts[line] as usize;
        let end = self.line_starts.get(line + 1).map_or(self.text.len(), |&e| e as usize);
        self.text[start..end].trim_end_matches(['\n', '\r'])
    }

    /// One-based `(line, column)` of a byte offset; columns count characters.
    pub fn line_col(&self, offset: u32) -> (usize, usize) {
        let line = self.line_index(offset);
        let start = self.line_starts[line] as usize;
        let end = (offset as usize).min(self.text.len());
        let col = self.text[start..end].chars().count() + 1;
        (line + 1, col)
    }
}
