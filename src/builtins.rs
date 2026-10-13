//! Built-in library routines: names and static signatures. The
//! implementations live in the VM (`vm::builtins`).

/// Parameter/return type pattern of a builtin.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum P {
    Int,
    Real,
    /// INTEGER or REAL.
    Num,
    Bool,
    Char,
    Str,
    /// STRING or CHAR.
    Text,
    Date,
    /// Return type equals the type of the first argument.
    SameAsArg0,
    /// Return type is only known at run time (INTEGER or REAL).
    Dynamic,
}

macro_rules! builtins {
    ($($variant:ident => $name:literal ($($p:ident),*) -> $ret:ident, $doc:literal;)*) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub enum Builtin { $($variant),* }

        impl Builtin {
            pub const ALL: &'static [Builtin] = &[$(Builtin::$variant),*];

            pub fn name(self) -> &'static str {
                match self { $(Builtin::$variant => $name),* }
            }

            pub fn params(self) -> &'static [P] {
                match self { $(Builtin::$variant => &[$(P::$p),*]),* }
            }

            pub fn ret(self) -> P {
                match self { $(Builtin::$variant => P::$ret),* }
            }

            pub fn doc(self) -> &'static str {
                match self { $(Builtin::$variant => $doc),* }
            }

            pub fn lookup(name: &str) -> Option<Builtin> {
                match name { $($name => Some(Builtin::$variant),)* _ => None }
            }
        }
    };
}

builtins! {
    Length => "LENGTH"(Str) -> Int, "number of characters in a string";
    Left => "LEFT"(Str, Int) -> Str, "the leftmost n characters";
    Right => "RIGHT"(Str, Int) -> Str, "the rightmost n characters";
    Mid => "MID"(Str, Int, Int) -> Str, "MID(s, start, length): substring starting at 1-based `start`";
    Substring => "SUBSTRING"(Str, Int, Int) -> Str, "alias of MID";
    UCase => "UCASE"(Text) -> SameAsArg0, "upper-case a CHAR or STRING";
    LCase => "LCASE"(Text) -> SameAsArg0, "lower-case a CHAR or STRING";
    ToUpper => "TO_UPPER"(Text) -> SameAsArg0, "upper-case a CHAR or STRING";
    ToLower => "TO_LOWER"(Text) -> SameAsArg0, "lower-case a CHAR or STRING";
    NumToStr => "NUM_TO_STR"(Num) -> Str, "convert a number to its STRING form";
    StrToNum => "STR_TO_NUM"(Text) -> Dynamic, "parse a STRING as an INTEGER or REAL";
    IsNum => "IS_NUM"(Text) -> Bool, "whether a STRING is a valid number";
    Asc => "ASC"(Char) -> Int, "character code of a CHAR";
    Chr => "CHR"(Int) -> Char, "CHAR with the given character code";
    Int => "INT"(Num) -> Int, "integer part of a number (truncates toward zero)";
    Rand => "RAND"(Num) -> Real, "random REAL in [0, x)";
    Round => "ROUND"(Num, Int) -> Real, "round to the given number of decimal places";
    Eof => "EOF"(Str) -> Bool, "whether a file opened FOR READ is exhausted";
    Day => "DAY"(Date) -> Int, "day of month of a DATE";
    Month => "MONTH"(Date) -> Int, "month of a DATE";
    Year => "YEAR"(Date) -> Int, "year of a DATE";
    DayIndex => "DAYINDEX"(Date) -> Int, "day of week, Sunday = 1";
    SetDate => "SETDATE"(Int, Int, Int) -> Date, "SETDATE(day, month, year)";
    Now => "NOW"() -> Date, "today's date";
}
