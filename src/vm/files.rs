//! Text and random-access files.

use super::Fault;
use crate::bytecode::FileMode;
use crate::value::{Obj, Value};
use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::{BufWriter, Write};
use std::rc::Rc;

enum Handle {
    Read(VecDeque<String>),
    Write(BufWriter<fs::File>),
    Random { records: Vec<Value>, pos: usize },
}

#[derive(Default)]
pub struct FileTable {
    open: HashMap<String, Handle>,
}

fn not_open(name: &str, op: &str) -> Fault {
    Fault::new(
        "R0005",
        format!("{op}: file {name:?} is not open"),
        "file not open",
    )
    .help(format!("open it first with `OPENFILE \"{name}\" FOR ...`"))
}

fn wrong_mode(name: &str, op: &str, needed: &str) -> Fault {
    Fault::new(
        "R0005",
        format!("{op}: file {name:?} was not opened FOR {needed}"),
        "wrong file mode",
    )
}

impl FileTable {
    pub fn open(&mut self, name: &str, mode: FileMode) -> Result<(), Fault> {
        if self.open.contains_key(name) {
            return Err(Fault::new(
                "R0005",
                format!("file {name:?} is already open"),
                "opened twice",
            )
            .help("CLOSEFILE it before opening it again"));
        }
        let io = |e: std::io::Error| {
            Fault::new(
                "R0005",
                format!("cannot open file {name:?}: {e}"),
                "OPENFILE failed",
            )
        };
        let handle = match mode {
            FileMode::Read => {
                let text = fs::read_to_string(name).map_err(io)?;
                Handle::Read(text.lines().map(str::to_string).collect())
            }
            FileMode::Write => Handle::Write(BufWriter::new(fs::File::create(name).map_err(io)?)),
            FileMode::Append => Handle::Write(BufWriter::new(
                fs::OpenOptions::new()
                    .append(true)
                    .create(true)
                    .open(name)
                    .map_err(io)?,
            )),
            FileMode::Random => {
                let records = fs::read_to_string(name)
                    .map(|t| t.lines().map(decode).collect())
                    .unwrap_or_default();
                Handle::Random { records, pos: 1 }
            }
        };
        self.open.insert(name.to_string(), handle);
        Ok(())
    }

    pub fn read_line(&mut self, name: &str) -> Result<String, Fault> {
        match self.open.get_mut(name) {
            Some(Handle::Read(lines)) => lines.pop_front().ok_or_else(|| {
                Fault::new(
                    "R0005",
                    format!("READFILE: no more lines in {name:?}"),
                    "read past the end of the file",
                )
                .help(format!("guard the loop with `WHILE NOT EOF(\"{name}\")`"))
            }),
            Some(_) => Err(wrong_mode(name, "READFILE", "READ")),
            None => Err(not_open(name, "READFILE")),
        }
    }

    pub fn eof(&self, name: &str) -> Result<bool, Fault> {
        match self.open.get(name) {
            Some(Handle::Read(lines)) => Ok(lines.is_empty()),
            Some(Handle::Random { records, pos }) => Ok(*pos > records.len()),
            Some(_) => Err(wrong_mode(name, "EOF", "READ")),
            None => Err(not_open(name, "EOF")),
        }
    }

    pub fn write_line(&mut self, name: &str, text: &str) -> Result<(), Fault> {
        match self.open.get_mut(name) {
            Some(Handle::Write(w)) => writeln!(w, "{text}").map_err(|e| {
                Fault::new(
                    "R0005",
                    format!("WRITEFILE to {name:?} failed: {e}"),
                    "I/O error",
                )
            }),
            Some(_) => Err(wrong_mode(name, "WRITEFILE", "WRITE or APPEND")),
            None => Err(not_open(name, "WRITEFILE")),
        }
    }

    pub fn seek(&mut self, name: &str, addr: i64) -> Result<(), Fault> {
        match self.open.get_mut(name) {
            Some(Handle::Random { pos, .. }) if addr >= 1 => {
                *pos = addr as usize;
                Ok(())
            }
            Some(Handle::Random { .. }) => Err(Fault::new(
                "R0005",
                format!("SEEK: invalid record address {addr}"),
                "addresses start at 1",
            )),
            Some(_) => Err(wrong_mode(name, "SEEK", "RANDOM")),
            None => Err(not_open(name, "SEEK")),
        }
    }

    pub fn get_record(&mut self, name: &str) -> Result<Value, Fault> {
        match self.open.get_mut(name) {
            Some(Handle::Random { records, pos }) => match records.get(*pos - 1) {
                Some(v) if !matches!(v, Value::Uninit) => Ok(v.deep_copy()),
                _ => Err(Fault::new(
                    "R0005",
                    format!("GETRECORD: no record at address {pos} of {name:?}"),
                    "empty record slot",
                )),
            },
            Some(_) => Err(wrong_mode(name, "GETRECORD", "RANDOM")),
            None => Err(not_open(name, "GETRECORD")),
        }
    }

    pub fn put_record(&mut self, name: &str, v: Value) -> Result<(), Fault> {
        match self.open.get_mut(name) {
            Some(Handle::Random { records, pos }) => {
                if records.len() < *pos {
                    records.resize(*pos, Value::Uninit);
                }
                records[*pos - 1] = v;
                Ok(())
            }
            Some(_) => Err(wrong_mode(name, "PUTRECORD", "RANDOM")),
            None => Err(not_open(name, "PUTRECORD")),
        }
    }

    pub fn close(&mut self, name: &str) -> Result<(), Fault> {
        match self.open.remove(name) {
            Some(h) => Self::flush(name, h),
            None => Err(not_open(name, "CLOSEFILE")),
        }
    }

    fn flush(name: &str, h: Handle) -> Result<(), Fault> {
        let io = |e: std::io::Error| {
            Fault::new(
                "R0005",
                format!("closing {name:?} failed: {e}"),
                "I/O error",
            )
        };
        match h {
            Handle::Write(mut w) => w.flush().map_err(io),
            Handle::Random { records, .. } => {
                let text: String = records.iter().map(|r| encode(r) + "\n").collect();
                fs::write(name, text).map_err(io)
            }
            Handle::Read(_) => Ok(()),
        }
    }

    pub fn close_all(&mut self) {
        for (_, h) in self.open.drain() {
            if let Handle::Write(mut w) = h {
                let _ = w.flush();
            }
        }
    }
}

// Random files store one record per line as tab-separated tagged fields.

fn encode(v: &Value) -> String {
    match v {
        Value::Record(o) => {
            let mut s = format!("R{}", o.shape);
            for f in o.fields.borrow().iter() {
                s.push('\t');
                s += &encode_scalar(f);
            }
            s
        }
        other => encode_scalar(other),
    }
}

fn encode_scalar(v: &Value) -> String {
    match v {
        Value::Int(i) => format!("i{i}"),
        Value::Real(r) => format!("r{r}"),
        Value::Bool(b) => format!("b{}", u8::from(*b)),
        Value::Char(c) => format!("c{c}"),
        Value::Str(s) => format!("s{}", s.replace('\\', "\\\\").replace('\t', "\\t")),
        Value::Date(d) => format!("d{d}"),
        Value::Enum { ty, ord } => format!("e{ty}:{ord}"),
        _ => "-".into(),
    }
}

fn decode(line: &str) -> Value {
    if let Some(rest) = line.strip_prefix('R') {
        let mut parts = rest.split('\t');
        let shape = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let fields = parts.map(decode_scalar).collect();
        return Value::Record(Rc::new(Obj {
            shape,
            fields: RefCell::new(fields),
        }));
    }
    decode_scalar(line)
}

fn decode_scalar(s: &str) -> Value {
    let (tag, body) = s.split_at(s.len().min(1));
    match tag {
        "i" => body.parse().map_or(Value::Uninit, Value::Int),
        "r" => body.parse().map_or(Value::Uninit, Value::Real),
        "b" => Value::Bool(body == "1"),
        "c" => body.chars().next().map_or(Value::Uninit, Value::Char),
        "s" => Value::str(&body.replace("\\t", "\t").replace("\\\\", "\\")),
        "d" => body.parse().map_or(Value::Uninit, Value::Date),
        "e" => {
            let mut it = body.split(':').map(|x| x.parse().unwrap_or(0));
            Value::Enum {
                ty: it.next().unwrap_or(0),
                ord: it.next().unwrap_or(0),
            }
        }
        _ => Value::Uninit,
    }
}
