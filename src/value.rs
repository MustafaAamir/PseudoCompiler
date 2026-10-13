//! Runtime values shared by the compiler (constant pools) and the VM.

use std::cell::RefCell;
use std::rc::Rc;

/// A heap object: either a record (value semantics, copied on assignment)
/// or a class instance (reference semantics, like Smalltalk objects).
/// Both use a fixed slot layout described by a [`crate::bytecode::Shape`].
#[derive(Debug)]
pub struct Obj {
    pub shape: u32,
    pub fields: RefCell<Vec<Value>>,
}

#[derive(Debug, Clone)]
pub struct ArrayObj {
    /// Inclusive `(lower, upper)` bounds per dimension.
    pub dims: Rc<[(i64, i64)]>,
    pub data: Vec<Value>,
}

impl ArrayObj {
    /// Row-major flat index, or the offending dimension on failure.
    pub fn flat_index(&self, idx: &[i64]) -> Result<usize, usize> {
        let mut flat = 0usize;
        for (d, (&i, &(lo, hi))) in idx.iter().zip(self.dims.iter()).enumerate() {
            if i < lo || i > hi {
                return Err(d);
            }
            flat = flat * (hi - lo + 1) as usize + (i - lo) as usize;
        }
        Ok(flat)
    }
}

/// A first-class reference to a storage location: the target of a pointer
/// (`^X`) or a `BYREF` parameter.
#[derive(Debug, Clone)]
pub enum Ref {
    Stack(usize),
    Global(u32),
    Elem(Rc<RefCell<ArrayObj>>, usize),
    Field(Rc<Obj>, u16),
}

#[derive(Debug, Clone, Default)]
pub enum Value {
    /// A declared but never assigned variable. Reading one is a runtime error.
    #[default]
    Uninit,
    /// The result of calling a procedure.
    Void,
    Int(i64),
    Real(f64),
    Bool(bool),
    Char(char),
    Str(Rc<str>),
    /// Days since 1970-01-01.
    Date(i32),
    Enum {
        ty: u32,
        ord: u32,
    },
    Array(Rc<RefCell<ArrayObj>>),
    Record(Rc<Obj>),
    Object(Rc<Obj>),
    Ref(Ref),
}

impl Value {
    pub fn str(s: &str) -> Value {
        Value::Str(Rc::from(s))
    }

    pub fn type_name(&self) -> &'static str {
        match self {
            Value::Uninit => "uninitialized",
            Value::Void => "nothing",
            Value::Int(_) => "INTEGER",
            Value::Real(_) => "REAL",
            Value::Bool(_) => "BOOLEAN",
            Value::Char(_) => "CHAR",
            Value::Str(_) => "STRING",
            Value::Date(_) => "DATE",
            Value::Enum { .. } => "enumeration",
            Value::Array(_) => "ARRAY",
            Value::Record(_) => "record",
            Value::Object(_) => "object",
            Value::Ref(_) => "pointer",
        }
    }

    /// Deep copy for value-semantics aggregates (arrays and records).
    /// Objects keep reference semantics.
    pub fn deep_copy(&self) -> Value {
        match self {
            Value::Array(a) => {
                let a = a.borrow();
                Value::Array(Rc::new(RefCell::new(ArrayObj {
                    dims: a.dims.clone(),
                    data: a.data.iter().map(Value::deep_copy).collect(),
                })))
            }
            Value::Record(r) => Value::Record(Rc::new(Obj {
                shape: r.shape,
                fields: RefCell::new(r.fields.borrow().iter().map(Value::deep_copy).collect()),
            })),
            other => other.clone(),
        }
    }
}

// Calendar conversions (Howard Hinnant's civil-from-days algorithms).

pub fn days_from_civil(y: i32, m: u32, d: u32) -> Option<i32> {
    if !(1..=12).contains(&m) || d == 0 || d > days_in_month(y, m) {
        return None;
    }
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u32;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146097 + doe as i32 - 719468)
}

pub fn civil_from_days(z: i32) -> (i32, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i32 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn days_in_month(y: i32, m: u32) -> u32 {
    match m {
        2 if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

pub fn format_date(days: i32) -> String {
    let (y, m, d) = civil_from_days(days);
    format!("{d:02}/{m:02}/{y:04}")
}

pub fn format_real(r: f64) -> String {
    if r.is_finite() && r.fract() == 0.0 && r.abs() < 1e15 {
        format!("{r:.1}")
    } else {
        format!("{r}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn date_roundtrip() {
        let d = days_from_civil(2024, 2, 29).unwrap();
        assert_eq!(civil_from_days(d), (2024, 2, 29));
        assert_eq!(days_from_civil(1970, 1, 1), Some(0));
        assert_eq!(days_from_civil(2023, 2, 29), None);
        assert_eq!(format_date(d), "29/02/2024");
    }
}
