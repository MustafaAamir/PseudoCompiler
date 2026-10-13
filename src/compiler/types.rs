//! Static types tracked by the single-pass compiler.

use crate::bytecode::{Conv, Op};
use std::rc::Rc;

#[derive(Clone, Debug, PartialEq)]
pub enum Ty {
    Int,
    Real,
    Bool,
    Char,
    Str,
    Date,
    Array(Rc<ArrayTy>),
    Record(u32),
    Class(u32),
    Enum(u32),
    Pointer(Rc<Ty>),
    /// The "value" of a procedure call.
    Void,
    /// Statically unknown (e.g. the result of a call to a function defined
    /// later in the file). Checked at run time where it meets a typed slot.
    Unknown,
    /// Produced after a reported error; silently compatible with everything
    /// so one mistake does not cascade.
    Error,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ArrayTy {
    pub dims: Vec<(i64, i64)>,
    pub elem: Ty,
}

impl Ty {
    pub fn is_numeric(&self) -> bool {
        matches!(self, Ty::Int | Ty::Real)
    }

    pub fn is_text(&self) -> bool {
        matches!(self, Ty::Str | Ty::Char)
    }

    /// Unknown or Error: anything goes statically.
    pub fn is_dynamic(&self) -> bool {
        matches!(self, Ty::Unknown | Ty::Error)
    }

    /// Records and arrays are copied on assignment.
    pub fn is_value_aggregate(&self) -> bool {
        matches!(self, Ty::Array(_) | Ty::Record(_))
    }

    pub fn conv(&self) -> Conv {
        match self {
            Ty::Int => Conv::Int,
            Ty::Real => Conv::Real,
            Ty::Bool => Conv::Bool,
            Ty::Char => Conv::Char,
            Ty::Str => Conv::Str,
            Ty::Date => Conv::Date,
            _ => Conv::Any,
        }
    }
}

/// How a value of one type may flow into a slot of another.
#[derive(Debug, PartialEq)]
pub enum Compat {
    Same,
    /// Needs this instruction: a widening (INTEGER -> REAL, CHAR -> STRING)
    /// or a run-time check of a statically unknown value.
    Convert(Op),
    Incompatible,
}
