//! Implementations of the built-in library routines.

use super::{Fault, Vm, parse_as};
use crate::bytecode::Conv;
use crate::value::{Value, civil_from_days, days_from_civil};
use pseudo_core::builtins::Builtin;
use std::rc::Rc;

fn text(v: &Value) -> Rc<str> {
    match v {
        Value::Str(s) => s.clone(),
        Value::Char(c) => Rc::from(c.to_string()),
        _ => Rc::from(""),
    }
}

fn int(v: &Value) -> i64 {
    match v {
        Value::Int(i) => *i,
        Value::Real(r) => *r as i64,
        _ => 0,
    }
}

fn real(v: &Value) -> f64 {
    match v {
        Value::Int(i) => *i as f64,
        Value::Real(r) => *r,
        _ => 0.0,
    }
}

impl Vm<'_> {
    pub(super) fn call_builtin(&mut self, b: Builtin, args: &[Value]) -> Result<Value, Fault> {
        for a in args {
            if let Value::Uninit = a {
                return Err(Fault::new(
                    "R0002",
                    format!("uninitialized value passed to {}", b.name()),
                    "argument has no value",
                ));
            }
        }
        let arg = |i: usize| &args[i];
        Ok(match b {
            Builtin::Length => Value::Int(text(arg(0)).chars().count() as i64),
            Builtin::Left | Builtin::Right => {
                let s = text(arg(0));
                let n = int(arg(1));
                let len = s.chars().count() as i64;
                if n < 0 || n > len {
                    return Err(Fault::new(
                        "R0012",
                        format!("{}: cannot take {n} characters from a string of length {len}", b.name()),
                        "length out of range",
                    )
                    .note(format!("the string is {:?}", &*s)));
                }
                let r: String = if b == Builtin::Left {
                    s.chars().take(n as usize).collect()
                } else {
                    s.chars().skip((len - n) as usize).collect()
                };
                Value::str(&r)
            }
            Builtin::Mid | Builtin::Substring => {
                let s = text(arg(0));
                let (start, n) = (int(arg(1)), int(arg(2)));
                let len = s.chars().count() as i64;
                if start < 1 || n < 0 || start - 1 + n > len {
                    return Err(Fault::new(
                        "R0012",
                        format!("{}: range [{start}, {}] is outside the string", b.name(), start + n - 1),
                        "substring out of range",
                    )
                    .note(format!("the string {:?} has {len} characters; positions start at 1", &*s)));
                }
                Value::str(&s.chars().skip((start - 1) as usize).take(n as usize).collect::<String>())
            }
            Builtin::UCase | Builtin::ToUpper => match arg(0) {
                Value::Char(c) => Value::Char(c.to_uppercase().next().unwrap_or(*c)),
                v => Value::str(&text(v).to_uppercase()),
            },
            Builtin::LCase | Builtin::ToLower => match arg(0) {
                Value::Char(c) => Value::Char(c.to_lowercase().next().unwrap_or(*c)),
                v => Value::str(&text(v).to_lowercase()),
            },
            Builtin::NumToStr => Value::str(&self.show(arg(0))),
            Builtin::StrToNum => {
                let s = text(arg(0));
                match parse_as(&s, Conv::Int).or_else(|_| parse_as(&s, Conv::Real)) {
                    Ok(v) => v,
                    Err(_) => {
                        return Err(Fault::new(
                            "R0006",
                            format!("STR_TO_NUM: {:?} is not a number", &*s),
                            "cannot be parsed",
                        )
                        .help("check the text with IS_NUM(...) first"));
                    }
                }
            }
            Builtin::IsNum => {
                let s = text(arg(0));
                Value::Bool(s.trim().parse::<f64>().is_ok())
            }
            Builtin::Asc => match arg(0) {
                Value::Char(c) => Value::Int(*c as i64),
                _ => Value::Int(0),
            },
            Builtin::Chr => {
                let i = int(arg(0));
                match u32::try_from(i).ok().and_then(char::from_u32) {
                    Some(c) => Value::Char(c),
                    None => {
                        return Err(Fault::new(
                            "R0012",
                            format!("CHR: {i} is not a valid character code"),
                            "invalid code",
                        ));
                    }
                }
            }
            Builtin::Int => Value::Int(real(arg(0)).trunc() as i64),
            Builtin::Rand => Value::Real(self.next_random() * real(arg(0))),
            Builtin::Round => {
                let p = 10f64.powi(int(arg(1)) as i32);
                Value::Real((real(arg(0)) * p).round() / p)
            }
            Builtin::Eof => Value::Bool(self.files.eof(&text(arg(0)))?),
            Builtin::Day | Builtin::Month | Builtin::Year | Builtin::DayIndex => {
                let Value::Date(d) = arg(0) else {
                    return Err(Fault::type_error("DATE", arg(0).type_name()));
                };
                let (y, m, day) = civil_from_days(*d);
                Value::Int(match b {
                    Builtin::Day => day as i64,
                    Builtin::Month => m as i64,
                    Builtin::Year => y as i64,
                    _ => ((*d as i64 + 4).rem_euclid(7)) + 1,
                })
            }
            Builtin::SetDate => {
                let (d, m, y) = (int(arg(0)), int(arg(1)), int(arg(2)));
                match days_from_civil(y as i32, m as u32, d as u32) {
                    Some(days) => Value::Date(days),
                    None => {
                        return Err(Fault::new(
                            "R0012",
                            format!("SETDATE: {d}/{m}/{y} is not a valid date"),
                            "no such day",
                        ));
                    }
                }
            }
            Builtin::Now => {
                let secs =
                    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
                Value::Date((secs / 86_400) as i32)
            }
        })
    }
}
