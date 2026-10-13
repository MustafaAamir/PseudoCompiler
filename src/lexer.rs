//! An on-demand, zero-copy lexer. The compiler pulls one token at a time;
//! no token vector is ever materialized.

use crate::diag::Diagnostic;
use crate::source::Span;
use std::fmt;

macro_rules! keywords {
    ($($variant:ident => $text:literal),* $(,)?) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub enum Kw { $($variant),* }

        impl Kw {
            pub fn as_str(self) -> &'static str {
                match self { $(Kw::$variant => $text),* }
            }

            pub fn lookup(s: &str) -> Option<Kw> {
                match s { $($text => Some(Kw::$variant),)* _ => None }
            }
        }
    };
}

keywords! {
    Declare => "DECLARE", Constant => "CONSTANT", Type => "TYPE", EndType => "ENDTYPE",
    Array => "ARRAY", Of => "OF",
    If => "IF", Then => "THEN", Else => "ELSE", EndIf => "ENDIF",
    Case => "CASE", Otherwise => "OTHERWISE", EndCase => "ENDCASE", To => "TO",
    While => "WHILE", Do => "DO", EndWhile => "ENDWHILE",
    Repeat => "REPEAT", Until => "UNTIL",
    For => "FOR", Step => "STEP", Next => "NEXT",
    Call => "CALL", Return => "RETURN", Returns => "RETURNS",
    Break => "BREAK", Continue => "CONTINUE",
    Output => "OUTPUT", Print => "PRINT", Input => "INPUT", Read => "READ",
    OpenFile => "OPENFILE", ReadFile => "READFILE", WriteFile => "WRITEFILE",
    Seek => "SEEK", GetRecord => "GETRECORD", PutRecord => "PUTRECORD", CloseFile => "CLOSEFILE",
    Write => "WRITE", Append => "APPEND", Random => "RANDOM",
    And => "AND", Or => "OR", Not => "NOT", Div => "DIV", Mod => "MOD",
    True => "TRUE", False => "FALSE",
    Integer => "INTEGER", Real => "REAL", Boolean => "BOOLEAN", Char => "CHAR",
    String => "STRING", Date => "DATE",
    Procedure => "PROCEDURE", EndProcedure => "ENDPROCEDURE",
    Function => "FUNCTION", EndFunction => "ENDFUNCTION",
    ByRef => "BYREF", ByVal => "BYVAL",
    Class => "CLASS", EndClass => "ENDCLASS", Inherits => "INHERITS",
    Public => "PUBLIC", Private => "PRIVATE", Super => "SUPER", New => "NEW",
}

/// Keywords that close a block; used for recovery and mismatch reports.
const BLOCK_ENDS: &[Kw] = {
    use Kw::*;
    &[EndIf, Else, EndCase, Otherwise, EndWhile, Until, Next, EndProcedure, EndFunction, EndClass, EndType]
};

const STATEMENT_STARTS: &[Kw] = {
    use Kw::*;
    &[
        Declare, Constant, Type, If, Case, While, Repeat, For, Call, Return, Break, Continue, Output, Print, Input,
        Read, OpenFile, ReadFile, WriteFile, Seek, GetRecord, PutRecord, CloseFile, Procedure, Function, Class, Super,
    ]
};

impl Kw {
    pub fn is_block_end(self) -> bool {
        BLOCK_ENDS.contains(&self)
    }

    pub fn starts_statement(self) -> bool {
        STATEMENT_STARTS.contains(&self)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Tok {
    Ident,
    Kw(Kw),
    Int(i64),
    Real(f64),
    /// String literal; the contents are the span minus the quotes.
    Str,
    Char(char),
    /// Days since 1970-01-01.
    Date(i32),
    Arrow,
    Plus,
    Minus,
    Star,
    Slash,
    Amp,
    Eq,
    Ne,
    Lt,
    Gt,
    Le,
    Ge,
    LParen,
    RParen,
    LBracket,
    RBracket,
    Comma,
    Colon,
    Dot,
    Caret,
    /// A lexical error; the diagnostic is available from [`Lexer::take_error`].
    Error,
    Eof,
}

impl Tok {
    pub fn describe(&self) -> String {
        match self {
            Tok::Ident => "identifier".into(),
            Tok::Kw(k) => format!("keyword `{}`", k.as_str()),
            Tok::Int(_) => "integer literal".into(),
            Tok::Real(_) => "real literal".into(),
            Tok::Str => "string literal".into(),
            Tok::Char(_) => "character literal".into(),
            Tok::Date(_) => "date literal".into(),
            Tok::Error => "invalid token".into(),
            Tok::Eof => "end of file".into(),
            other => format!("`{other}`"),
        }
    }
}

impl fmt::Display for Tok {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            Tok::Arrow => "←",
            Tok::Plus => "+",
            Tok::Minus => "-",
            Tok::Star => "*",
            Tok::Slash => "/",
            Tok::Amp => "&",
            Tok::Eq => "=",
            Tok::Ne => "<>",
            Tok::Lt => "<",
            Tok::Gt => ">",
            Tok::Le => "<=",
            Tok::Ge => ">=",
            Tok::LParen => "(",
            Tok::RParen => ")",
            Tok::LBracket => "[",
            Tok::RBracket => "]",
            Tok::Comma => ",",
            Tok::Colon => ":",
            Tok::Dot => ".",
            Tok::Caret => "^",
            Tok::Kw(k) => k.as_str(),
            other => return write!(f, "{}", other.describe()),
        };
        f.write_str(s)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Token {
    pub tok: Tok,
    pub span: Span,
    /// Whether a line break separates this token from the previous one.
    /// Pseudocode is line oriented; the compiler uses this for `ELSE IF`,
    /// `CASE` arm detection and bare `RETURN`.
    pub line_start: bool,
}

pub struct Lexer<'s> {
    src: &'s str,
    pos: usize,
    error: Option<Diagnostic>,
}

impl<'s> Lexer<'s> {
    pub fn new(src: &'s str) -> Self {
        Lexer { src, pos: 0, error: None }
    }

    pub fn take_error(&mut self) -> Option<Diagnostic> {
        self.error.take()
    }

    fn peek_char(&self) -> Option<char> {
        self.src[self.pos..].chars().next()
    }

    fn peek_char_at(&self, n: usize) -> Option<char> {
        self.src[self.pos..].chars().nth(n)
    }

    fn eat_char(&mut self, c: char) -> bool {
        let hit = self.peek_char() == Some(c);
        if hit {
            self.pos += c.len_utf8();
        }
        hit
    }

    fn bump(&mut self) -> Option<char> {
        let c = self.peek_char()?;
        self.pos += c.len_utf8();
        Some(c)
    }

    /// Skips whitespace and `//` comments, reporting whether a newline was crossed.
    fn skip_trivia(&mut self) -> bool {
        let mut newline = self.pos == 0;
        loop {
            match self.peek_char() {
                Some('\n') => {
                    newline = true;
                    self.pos += 1;
                }
                Some(c) if c.is_whitespace() => self.pos += c.len_utf8(),
                Some('/') if self.peek_char_at(1) == Some('/') => {
                    self.pos = self.src[self.pos..].find('\n').map_or(self.src.len(), |i| self.pos + i);
                }
                _ => return newline,
            }
        }
    }

    pub fn next_token(&mut self) -> Token {
        let line_start = self.skip_trivia();
        let start = self.pos;
        let tok = match self.bump() {
            None => Tok::Eof,
            Some(c) => self.lex_from(c, start),
        };
        Token { tok, span: Span::new(start, self.pos), line_start }
    }

    fn lex_from(&mut self, c: char, start: usize) -> Tok {
        match c {
            '←' => Tok::Arrow,
            '+' => Tok::Plus,
            '-' => Tok::Minus,
            '*' => Tok::Star,
            '/' => Tok::Slash,
            '&' => Tok::Amp,
            '=' => Tok::Eq,
            '(' => Tok::LParen,
            ')' => Tok::RParen,
            '[' => Tok::LBracket,
            ']' => Tok::RBracket,
            ',' => Tok::Comma,
            ':' => Tok::Colon,
            '.' => Tok::Dot,
            '^' | '↑' => Tok::Caret,
            '≠' => Tok::Ne,
            '≤' => Tok::Le,
            '≥' => Tok::Ge,
            '<' if self.eat_char('-') => Tok::Arrow,
            '<' if self.eat_char('>') => Tok::Ne,
            '<' if self.eat_char('=') => Tok::Le,
            '<' => Tok::Lt,
            '>' if self.eat_char('=') => Tok::Ge,
            '>' => Tok::Gt,
            '"' | '“' | '”' => self.string(start, c),
            '\'' | '‘' | '’' => self.char_lit(start),
            c if c.is_ascii_digit() => self.number(start),
            c if c.is_alphabetic() || c == '_' => {
                while self.peek_char().is_some_and(|c| c.is_alphanumeric() || c == '_') {
                    self.bump();
                }
                Kw::lookup(&self.src[start..self.pos]).map_or(Tok::Ident, Tok::Kw)
            }
            other => {
                let mut d = Diagnostic::error("E0001", format!("unknown character `{other}`"))
                    .primary(Span::new(start, self.pos), "not valid in pseudocode");
                d = match other {
                    '!' => d.help("use `<>` for \"not equal\" and `NOT` for negation"),
                    ';' => d.help("statements end at the end of a line; no `;` is needed"),
                    '{' | '}' => d.help("blocks are closed with keywords such as `ENDIF` and `ENDWHILE`"),
                    '%' => d.help("use `MOD` for the remainder of an integer division"),
                    '|' => d.help("use `OR` for logical disjunction"),
                    _ => d,
                };
                self.error = Some(d);
                Tok::Error
            }
        }
    }

    fn string(&mut self, start: usize, open: char) -> Tok {
        let close = |c: char| c == '"' || (open != '"' && c == '”');
        loop {
            match self.peek_char() {
                Some(c) if close(c) => {
                    self.bump();
                    return Tok::Str;
                }
                Some('\n') | None => {
                    self.error = Some(
                        Diagnostic::error("E0002", "unterminated string literal")
                            .primary(Span::new(start, start + open.len_utf8()), "string starts here")
                            .secondary(Span::new(self.pos, self.pos), "line ends before a closing `\"`")
                            .help("strings cannot span multiple lines; close it with `\"` on the same line"),
                    );
                    return Tok::Error;
                }
                Some(_) => {
                    self.bump();
                }
            }
        }
    }

    fn char_lit(&mut self, start: usize) -> Tok {
        let is_quote = |c: char| matches!(c, '\'' | '’' | '‘');
        let mut chars = Vec::new();
        loop {
            match self.peek_char() {
                Some(c) if is_quote(c) => {
                    self.bump();
                    break;
                }
                Some('\n') | None => {
                    self.error = Some(
                        Diagnostic::error("E0002", "unterminated character literal")
                            .primary(Span::new(start, start + 1), "character literal starts here")
                            .help("close it with `'`, e.g. `'A'`"),
                    );
                    return Tok::Error;
                }
                Some(c) => {
                    chars.push(c);
                    self.bump();
                }
            }
        }
        let span = Span::new(start, self.pos);
        self.error = Some(match chars.as_slice() {
            [c] => return Tok::Char(*c),
            [] => Diagnostic::error("E0003", "empty character literal").primary(span, "contains no character"),
            _ => Diagnostic::error("E0003", "character literal may only contain one character")
                .primary(span, format!("contains {} characters", chars.len()))
                .suggest(
                    span,
                    format!("\"{}\"", chars.iter().collect::<String>()),
                    "if you meant to write a STRING, use double quotes",
                ),
        });
        Tok::Error
    }

    fn digits(&mut self) {
        while self.peek_char().is_some_and(|c| c.is_ascii_digit()) {
            self.bump();
        }
    }

    fn number(&mut self, start: usize) -> Tok {
        self.digits();
        let int_end = self.pos;

        // Date literal: dd/mm/yyyy
        if self.peek_char() == Some('/') && int_end - start <= 2 {
            let save = self.pos;
            self.bump();
            let m_start = self.pos;
            self.digits();
            let m_len = self.pos - m_start;
            if (1..=2).contains(&m_len) && self.peek_char() == Some('/') {
                self.bump();
                let y_start = self.pos;
                self.digits();
                if self.pos - y_start == 4 {
                    let d: u32 = self.src[start..int_end].parse().unwrap();
                    let m: u32 = self.src[m_start..m_start + m_len].parse().unwrap();
                    let y: i32 = self.src[y_start..self.pos].parse().unwrap();
                    return match crate::value::days_from_civil(y, m, d) {
                        Some(days) => Tok::Date(days),
                        None => {
                            self.error = Some(
                                Diagnostic::error("E0003", format!("invalid date `{}`", &self.src[start..self.pos]))
                                    .primary(Span::new(start, self.pos), "no such calendar day")
                                    .note("date literals are written dd/mm/yyyy"),
                            );
                            Tok::Error
                        }
                    };
                }
            }
            self.pos = save;
        }

        let is_real = self.peek_char() == Some('.') && self.peek_char_at(1).is_some_and(|c| c.is_ascii_digit());
        if is_real {
            self.bump();
            self.digits();
            return Tok::Real(self.src[start..self.pos].parse().unwrap());
        }
        match self.src[start..self.pos].parse::<i64>() {
            Ok(v) => Tok::Int(v),
            Err(_) => {
                self.error = Some(
                    Diagnostic::error("E0003", "integer literal is too large")
                        .primary(Span::new(start, self.pos), "does not fit in a 64-bit INTEGER")
                        .note(format!("the largest INTEGER is {}", i64::MAX))
                        .help("write it as a REAL, e.g. `12345678901234567890.0`"),
                );
                Tok::Error
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn toks(s: &str) -> Vec<Tok> {
        let mut lx = Lexer::new(s);
        std::iter::from_fn(|| Some(lx.next_token().tok).filter(|t| *t != Tok::Eof)).collect()
    }

    #[test]
    fn arrows_and_ops() {
        assert_eq!(
            toks("X ← 1 <- 2.5 <> <="),
            vec![Tok::Ident, Tok::Arrow, Tok::Int(1), Tok::Arrow, Tok::Real(2.5), Tok::Ne, Tok::Le]
        );
    }

    #[test]
    fn dates_and_division() {
        assert!(matches!(toks("01/02/2024")[0], Tok::Date(_)));
        assert_eq!(toks("10/2"), vec![Tok::Int(10), Tok::Slash, Tok::Int(2)]);
    }

    #[test]
    fn keywords_are_case_sensitive() {
        assert_eq!(toks("IF if"), vec![Tok::Kw(Kw::If), Tok::Ident]);
    }

    #[test]
    fn comments_and_line_starts() {
        let mut lx = Lexer::new("A // c\nB");
        assert!(lx.next_token().line_start);
        assert!(lx.next_token().line_start);
    }
}
