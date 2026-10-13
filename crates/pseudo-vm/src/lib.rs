//! A stack-based bytecode VM with Smalltalk-style message dispatch:
//!
//! * objects have fixed slot layouts (`Shape`s), so field access compiled
//!   against a known class is a single indexed load;
//! * every send site owns an inline cache that goes from empty to
//!   monomorphic to polymorphic (up to `POLY_MAX` receiver classes) to
//!   megamorphic;
//! * megamorphic sites and cache misses go through a global
//!   `(class, selector) -> method` lookup cache before falling back to a
//!   walk of the method dictionaries up the superclass chain.

mod error;
mod files;
mod natives;

use pseudo_core::{bytecode, diag, source, value};

pub use error::RuntimeError;
use error::{Fault, TraceFrame};

use crate::bytecode::{Conv, MethodMeta, Op, Program, Proto, ProtoKind, VarLoc};
use crate::source::Span;
use crate::value::{ArrayObj, Obj, Ref, Value, days_from_civil, format_date, format_real};
use std::cell::RefCell;
use std::cmp::Ordering;
use std::io::{BufRead, Write};
use std::rc::Rc;

const POLY_MAX: usize = 4;
const GLOBAL_CACHE_SIZE: usize = 512;
const MAX_FRAMES: usize = 10_000;

#[derive(Clone, Copy, Debug)]
enum InlineCache {
    Empty,
    Mono { class: u32, target: MethodMeta },
    Poly { n: u8, entries: [(u32, MethodMeta); POLY_MAX] },
    Mega,
}

#[derive(Clone, Copy)]
struct FieldCache {
    shape: u32,
    slot: u16,
}

#[derive(Default)]
struct Stats {
    instructions: u64,
    calls: u64,
    sends: u64,
    mono_hits: u64,
    poly_hits: u64,
    mega_lookups: u64,
    global_cache_hits: u64,
    full_lookups: u64,
    max_depth: usize,
}

/// The interpreter's registers for the running frame.
struct Regs {
    proto: Rc<Proto>,
    ip: usize,
    base: usize,
}

struct Frame {
    proto: Rc<Proto>,
    ip: usize,
    base: usize,
    ctor: bool,
}

pub struct Vm<'p> {
    program: &'p Program,
    stack: Vec<Value>,
    frames: Vec<Frame>,
    globals: Vec<Value>,
    caches: Vec<InlineCache>,
    field_caches: Vec<Option<FieldCache>>,
    global_cache: Vec<Option<(u32, u32, MethodMeta)>>,
    files: files::FileTable,
    out: Box<dyn Write + 'p>,
    input: Box<dyn BufRead + 'p>,
    rng: u64,
    pub trace: bool,
    stats: Stats,
}

impl<'p> Vm<'p> {
    pub fn new(program: &'p Program, out: Box<dyn Write + 'p>, input: Box<dyn BufRead + 'p>) -> Self {
        let seed = std::env::var("PSEUDO_SEED").ok().and_then(|s| s.parse().ok()).unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0x2545F4914F6CDD1D, |d| d.as_nanos() as u64)
        });
        Vm {
            program,
            stack: Vec::with_capacity(1024),
            frames: Vec::with_capacity(64),
            globals: vec![Value::Uninit; program.globals.len()],
            caches: vec![InlineCache::Empty; program.num_sites as usize],
            field_caches: vec![None; program.num_sites as usize],
            global_cache: vec![None; GLOBAL_CACHE_SIZE],
            files: files::FileTable::default(),
            out,
            input,
            rng: seed | 1,
            trace: false,
            stats: Stats::default(),
        }
    }

    /// Run the main program to completion.
    pub fn run(&mut self) -> Result<(), Box<RuntimeError>> {
        let main = self.program.main.clone();
        self.stack.resize(main.num_slots as usize, Value::Uninit);
        self.frames.push(Frame { proto: main, ip: 0, base: 0, ctor: false });
        let result = self.execute();
        let _ = self.out.flush();
        self.files.close_all();
        result.map_err(|fault| Box::new(self.locate(fault)))
    }

    /// Execution statistics and the final state of every send site's inline cache.
    pub fn report(&self) -> String {
        let st = &self.stats;
        let mut lines = vec![
            "── execution statistics ──".to_string(),
            format!("instructions executed : {}", st.instructions),
            format!("calls / sends         : {} / {}", st.calls, st.sends),
            format!("max call depth        : {}", st.max_depth),
            format!("inline cache hits     : {} monomorphic, {} polymorphic", st.mono_hits, st.poly_hits),
            format!("megamorphic lookups   : {}", st.mega_lookups),
            format!("global cache hits     : {}", st.global_cache_hits),
            format!("full method lookups   : {}", st.full_lookups),
            format!("send sites ({} total):", self.program.num_sites),
        ];
        let name = |cls: &u32| self.program.shapes[*cls as usize].name.clone();
        for (i, c) in self.caches.iter().enumerate() {
            lines.push(match c {
                InlineCache::Empty => continue,
                InlineCache::Mono { class, .. } => format!("  @ic{i}: monomorphic [{}]", name(class)),
                InlineCache::Poly { n, entries } => {
                    let cs: Vec<String> = entries[..*n as usize].iter().map(|(c, _)| name(c)).collect();
                    format!("  @ic{i}: polymorphic [{}]", cs.join(", "))
                }
                InlineCache::Mega => format!("  @ic{i}: megamorphic"),
            });
        }
        lines.join("\n")
    }

    fn locate(&self, fault: Fault) -> RuntimeError {
        let mut backtrace = Vec::new();
        for f in self.frames.iter().rev() {
            let pc = f.ip.saturating_sub(1).min(f.proto.spans.len().saturating_sub(1));
            let span = f.proto.spans.get(pc).copied().unwrap_or(Span::DUMMY);
            let name = match f.proto.kind {
                ProtoKind::Main => "the main program".to_string(),
                ProtoKind::Method { .. } => format!("method `{}`", f.proto.name),
                ProtoKind::Function => format!("function `{}`", f.proto.name),
                ProtoKind::Procedure => format!("procedure `{}`", f.proto.name),
            };
            backtrace.push(TraceFrame { name, span });
        }
        let span = backtrace.first().map_or(Span::DUMMY, |f| f.span);
        let locals = self.frames.last().map(|f| self.frame_locals(f)).unwrap_or_default();
        RuntimeError { fault, span, backtrace, locals }
    }

    fn frame_locals(&self, f: &Frame) -> Vec<(String, String)> {
        let short = |s: String| {
            if s.chars().count() > 60 { format!("{}…", s.chars().take(60).collect::<String>()) } else { s }
        };
        if f.proto.kind == ProtoKind::Main {
            return self
                .program
                .globals
                .iter()
                .zip(&self.globals)
                .filter(|(g, _)| !g.name.starts_with('<'))
                .map(|(g, v)| (g.name.clone(), short(self.repr(v))))
                .collect();
        }
        f.proto
            .locals
            .iter()
            .filter(|l| !l.name.starts_with('<'))
            .filter_map(|l| {
                let v = self.stack.get(f.base + l.slot as usize)?;
                let shown = match (v, l.byref) {
                    (Value::Ref(r), true) => {
                        format!("{} (BYREF)", self.repr(&self.read_ref(r).unwrap_or(Value::Uninit)))
                    }
                    _ => self.repr(v),
                };
                Some((l.name.clone(), short(shown)))
            })
            .collect()
    }

    /// How OUTPUT prints a value.
    pub fn show(&self, v: &Value) -> String {
        match v {
            Value::Uninit => "<uninitialized>".into(),
            Value::Void => String::new(),
            Value::Int(i) => i.to_string(),
            Value::Real(r) => format_real(*r),
            Value::Bool(b) => if *b { "TRUE" } else { "FALSE" }.into(),
            Value::Char(c) => c.to_string(),
            Value::Str(s) => s.to_string(),
            Value::Date(d) => format_date(*d),
            Value::Enum { ty, ord } => self.program.enums[*ty as usize].variants[*ord as usize].clone(),
            Value::Array(a) => {
                let a = a.borrow();
                let items: Vec<String> = a.data.iter().map(|v| self.repr(v)).collect();
                format!("[{}]", items.join(", "))
            }
            Value::Record(o) => self.fields_repr(o),
            Value::Object(o) => format!("<{} object>", self.program.shapes[o.shape as usize].name),
            Value::Ref(_) => "<pointer>".into(),
        }
    }

    /// Debug representation (strings quoted) used in error reports and arrays.
    pub fn repr(&self, v: &Value) -> String {
        match v {
            Value::Str(s) => format!("{s:?}"),
            Value::Char(c) => format!("'{c}'"),
            Value::Object(o) => self.fields_repr(o),
            other => self.show(other),
        }
    }

    /// `Name { field: value, .. }`. Nested objects are not expanded, so
    /// cyclic structures print finitely.
    fn fields_repr(&self, o: &Obj) -> String {
        let shape = &self.program.shapes[o.shape as usize];
        let fields: Vec<String> = (shape.fields.iter().zip(o.fields.borrow().iter()))
            .map(|(f, v)| match v {
                Value::Object(inner) => format!("{}: <{}>", f.name, self.program.shapes[inner.shape as usize].name),
                v => format!("{}: {}", f.name, self.repr(v)),
            })
            .collect();
        format!("{} {{ {} }}", shape.name, fields.join(", "))
    }

    fn type_name(&self, v: &Value) -> String {
        match v {
            Value::Object(o) | Value::Record(o) => self.program.shapes[o.shape as usize].name.clone(),
            Value::Enum { ty, .. } => self.program.enums[*ty as usize].name.clone(),
            other => other.type_name().to_string(),
        }
    }

    fn pop(&mut self) -> Value {
        self.stack.pop().expect("stack underflow")
    }

    fn pop_int(&mut self) -> Result<i64, Fault> {
        match self.pop() {
            Value::Int(i) => Ok(i),
            other => Err(Fault::type_error("INTEGER", &self.type_name(&other))),
        }
    }

    fn pop_str(&mut self) -> Result<Rc<str>, Fault> {
        match self.pop() {
            Value::Str(s) => Ok(s),
            Value::Char(c) => Ok(Rc::from(c.to_string())),
            other => Err(Fault::type_error("STRING", &self.type_name(&other))),
        }
    }

    fn make_init(&self, idx: u32) -> Value {
        match &self.program.inits[idx as usize] {
            crate::bytecode::Init::Uninit => Value::Uninit,
            crate::bytecode::Init::Record(s) => Value::Record(self.new_obj(*s)),
            crate::bytecode::Init::Array { dims, elem } => {
                let len: usize = dims.iter().map(|(l, h)| (h - l + 1) as usize).product();
                let data = (0..len).map(|_| self.make_init(*elem)).collect();
                Value::Array(Rc::new(RefCell::new(ArrayObj { dims: dims.clone(), data })))
            }
        }
    }

    fn new_obj(&self, shape: u32) -> Rc<Obj> {
        let s = &self.program.shapes[shape as usize];
        let fields = s.field_inits.iter().map(|&i| self.make_init(i)).collect();
        Rc::new(Obj { shape, fields: RefCell::new(fields) })
    }

    fn read_ref(&self, r: &Ref) -> Result<Value, Fault> {
        let v = match r {
            Ref::Stack(i) => match self.stack.get(*i) {
                Some(v) => v.clone(),
                None => {
                    return Err(Fault::new(
                        "R0009",
                        "dangling pointer",
                        "the variable this points to no longer exists",
                    ));
                }
            },
            Ref::Global(g) => self.globals[*g as usize].clone(),
            Ref::Elem(a, i) => a.borrow().data[*i].clone(),
            Ref::Field(o, i) => o.fields.borrow()[*i as usize].clone(),
        };
        Ok(v)
    }

    fn write_ref(&mut self, r: &Ref, v: Value) -> Result<(), Fault> {
        match r {
            Ref::Stack(i) => match self.stack.get_mut(*i) {
                Some(slot) => *slot = v,
                None => {
                    return Err(Fault::new(
                        "R0009",
                        "dangling pointer",
                        "the variable this points to no longer exists",
                    ));
                }
            },
            Ref::Global(g) => self.globals[*g as usize] = v,
            Ref::Elem(a, i) => a.borrow_mut().data[*i] = v,
            Ref::Field(o, i) => o.fields.borrow_mut()[*i as usize] = v,
        }
        Ok(())
    }

    fn var_get(&self, base: usize, v: VarLoc) -> &Value {
        match v {
            VarLoc::Local(s) => &self.stack[base + s as usize],
            VarLoc::Global(g) => &self.globals[g as usize],
        }
    }

    fn var_set(&mut self, base: usize, v: VarLoc, val: Value) {
        match v {
            VarLoc::Local(s) => self.stack[base + s as usize] = val,
            VarLoc::Global(g) => self.globals[g as usize] = val,
        }
    }

    fn uninit_local(&self, proto: &Proto, slot: u16) -> Fault {
        match proto.local_name(slot) {
            Some(l) => Fault::new(
                "R0002",
                format!("use of uninitialized variable `{}`", l.name),
                format!("`{}` has not been given a value yet", l.name),
            )
            .secondary(l.decl, "declared here")
            .help(format!("assign `{}` a value before reading it", l.name)),
            None => Fault::new("R0002", "use of uninitialized variable", "read before assignment"),
        }
    }

    fn uninit_global(&self, g: u32) -> Fault {
        let info = &self.program.globals[g as usize];
        Fault::new(
            "R0002",
            format!("use of uninitialized variable `{}`", info.name),
            format!("`{}` has not been given a value yet", info.name),
        )
        .secondary(info.decl, "declared here")
        .help(format!("assign `{}` a value (or INPUT it) before reading it", info.name))
    }

    fn object(&self, v: Value, what: &str) -> Result<Rc<Obj>, Fault> {
        match v {
            Value::Object(o) | Value::Record(o) => Ok(o),
            Value::Uninit => Err(Fault::new(
                "R0009",
                format!("{what} on an object variable that was never assigned"),
                "this object does not exist yet",
            )
            .help("create the object first, e.g. `MyPet ← NEW Pet(...)`")),
            other => Err(Fault::type_error("an object", &self.type_name(&other))),
        }
    }

    fn field_value(&self, o: &Obj, slot: u16) -> Result<Value, Fault> {
        let v = o.fields.borrow()[slot as usize].clone();
        if let Value::Uninit = v {
            let shape = &self.program.shapes[o.shape as usize];
            let fname = &shape.fields[slot as usize].name;
            let f = Fault::new(
                "R0002",
                format!("field `{fname}` of `{}` read before it was assigned", shape.name),
                format!("`{fname}` has no value yet"),
            );
            return Err(if shape.is_class {
                f.help(format!("give `{fname}` an initial value in the constructor `PUBLIC PROCEDURE NEW(...)`"))
            } else {
                f.help(format!("assign `.{fname}` before reading it"))
            });
        }
        Ok(v)
    }

    fn array_index(&mut self, n: u8) -> Result<(Rc<RefCell<ArrayObj>>, usize), Fault> {
        let mut idx = [0i64; 8];
        let n = n as usize;
        if n > idx.len() {
            return Err(Fault::new("R0001", "too many array dimensions", "at most 8 dimensions are supported"));
        }
        for i in (0..n).rev() {
            idx[i] = self.pop_int()?;
        }
        let arr = match self.pop() {
            Value::Array(a) => a,
            Value::Uninit => {
                return Err(Fault::new("R0002", "indexing an uninitialized array", "this array has no value"));
            }
            other => return Err(Fault::type_error("ARRAY", &self.type_name(&other))),
        };
        let flat = {
            let a = arr.borrow();
            if a.dims.len() != n {
                return Err(Fault::new(
                    "R0001",
                    format!("expected {} indices, found {n}", a.dims.len()),
                    "wrong number of indices",
                ));
            }
            match a.flat_index(&idx[..n]) {
                Ok(f) => f,
                Err(d) => {
                    let (lo, hi) = a.dims[d];
                    let shown: Vec<String> = idx[..n].iter().map(i64::to_string).collect();
                    let bounds: Vec<String> = a.dims.iter().map(|(l, h)| format!("{l}:{h}")).collect();
                    return Err(Fault::new(
                        "R0001",
                        "array index out of bounds",
                        format!("index {} is outside {lo}:{hi}", idx[d]),
                    )
                    .note(format!("accessed [{}] of an ARRAY[{}]", shown.join(", "), bounds.join(", ")))
                    .help(if idx[d] == hi + 1 {
                        "this is one past the end: check the loop's upper bound (off-by-one?)".to_string()
                    } else if idx[d] == lo - 1 {
                        format!("this is one before the start: the array starts at {lo}")
                    } else {
                        format!("valid indices for this dimension are {lo} to {hi}")
                    }));
                }
            }
        };
        Ok((arr, flat))
    }

    fn next_random(&mut self) -> f64 {
        self.rng ^= self.rng << 13;
        self.rng ^= self.rng >> 7;
        self.rng ^= self.rng << 17;
        (self.rng >> 11) as f64 / (1u64 << 53) as f64
    }

    fn lookup_method(&mut self, class: u32, sym: u32) -> Option<MethodMeta> {
        let slot = ((class as usize).wrapping_mul(31) ^ sym as usize) % GLOBAL_CACHE_SIZE;
        if let Some((c, s, m)) = self.global_cache[slot]
            && c == class
            && s == sym
        {
            self.stats.global_cache_hits += 1;
            return Some(m);
        }
        self.stats.full_lookups += 1;
        let mut cls = class;
        loop {
            let shape = &self.program.shapes[cls as usize];
            if let Some(m) = shape.methods.get(&sym) {
                self.global_cache[slot] = Some((class, sym, *m));
                return Some(*m);
            }
            cls = shape.parent?;
        }
    }

    fn send_target(&mut self, site: u32, class: u32, sym: u32) -> Result<MethodMeta, Fault> {
        let site = site as usize;
        match self.caches[site] {
            InlineCache::Mono { class: c, target } if c == class => {
                self.stats.mono_hits += 1;
                return Ok(target);
            }
            InlineCache::Poly { n, entries } => {
                if let Some((_, t)) = entries[..n as usize].iter().find(|(c, _)| *c == class) {
                    self.stats.poly_hits += 1;
                    return Ok(*t);
                }
            }
            InlineCache::Mega => self.stats.mega_lookups += 1,
            _ => {}
        }
        let Some(target) = self.lookup_method(class, sym) else {
            return Err(self.not_understood(class, sym));
        };
        self.caches[site] = match self.caches[site] {
            InlineCache::Empty => InlineCache::Mono { class, target },
            InlineCache::Mono { class: c, target: t } => {
                let mut entries = [(c, t); POLY_MAX];
                entries[1] = (class, target);
                InlineCache::Poly { n: 2, entries }
            }
            InlineCache::Poly { n, mut entries } if (n as usize) < POLY_MAX => {
                entries[n as usize] = (class, target);
                InlineCache::Poly { n: n + 1, entries }
            }
            _ => InlineCache::Mega,
        };
        Ok(target)
    }

    fn not_understood(&self, class: u32, sym: u32) -> Fault {
        let shape = &self.program.shapes[class as usize];
        let sel = &self.program.symbols[sym as usize];
        let mut methods = Vec::new();
        let mut c = Some(class);
        while let Some(cls) = c {
            let s = &self.program.shapes[cls as usize];
            methods.extend(s.methods.keys().map(|k| self.program.symbols[*k as usize].clone()));
            c = s.parent;
        }
        methods.sort();
        let mut f = Fault::new(
            "R0010",
            format!("`{}` does not understand the message `{sel}`", shape.name),
            format!("no method `{sel}` in `{}` or its superclasses", shape.name),
        );
        if let Some(m) = crate::diag::best_match(sel, methods.iter().map(String::as_str)) {
            f = f.help(format!("did you mean `{m}`?"));
        } else if !methods.is_empty() {
            f = f.note(format!("`{}` understands: {}", shape.name, methods.join(", ")));
        }
        f
    }

    fn check_private_method(&self, target: &MethodMeta, sym: u32, caller: &Proto) -> Result<(), Fault> {
        if target.private && caller.kind != (ProtoKind::Method { class: target.owner }) {
            let owner = &self.program.shapes[target.owner as usize].name;
            return Err(Fault::new(
                "R0011",
                format!("method `{}` of `{owner}` is private", self.program.symbols[sym as usize]),
                "private methods can only be called from inside their class",
            ));
        }
        Ok(())
    }

    fn named_field(&mut self, site: u32, obj: &Obj, sym: u32, caller: &Proto) -> Result<u16, Fault> {
        if let Some(fc) = self.field_caches[site as usize]
            && fc.shape == obj.shape
        {
            return Ok(fc.slot);
        }
        let shape = &self.program.shapes[obj.shape as usize];
        let Some(slot) = shape.fields.iter().position(|f| f.sym == sym) else {
            let name = &self.program.symbols[sym as usize];
            let mut f = Fault::new("R0010", format!("`{}` has no field `{name}`", shape.name), "unknown field");
            let names: Vec<&str> = shape.fields.iter().map(|f| f.name.as_str()).collect();
            if let Some(m) = crate::diag::best_match(name, names.iter().copied()) {
                f = f.help(format!("did you mean `{m}`?"));
            }
            return Err(f);
        };
        let meta = &shape.fields[slot];
        if meta.private && caller.kind != (ProtoKind::Method { class: meta.owner }) {
            return Err(Fault::new(
                "R0011",
                format!("field `{}` of `{}` is private", meta.name, self.program.shapes[meta.owner as usize].name),
                "private fields can only be used inside their class",
            ));
        }
        self.field_caches[site as usize] = Some(FieldCache { shape: obj.shape, slot: slot as u16 });
        Ok(slot as u16)
    }

    fn execute(&mut self) -> Result<(), Fault> {
        let mut r = Regs { proto: self.frames.last().unwrap().proto.clone(), ip: 0, base: 0 };
        loop {
            let op = r.proto.code[r.ip];
            if self.trace {
                self.trace_op(&r.proto, r.ip, &op);
            }
            r.ip += 1;
            self.stats.instructions += 1;
            match self.step(op, &mut r) {
                Ok(true) => {}
                Ok(false) => return Ok(()),
                Err(f) => {
                    // Saved so the error report points at this instruction.
                    self.frames.last_mut().unwrap().ip = r.ip;
                    return Err(f);
                }
            }
        }
    }

    /// Execute one instruction; `Ok(false)` means the program halted.
    #[inline(always)]
    fn step(&mut self, op: Op, r: &mut Regs) -> Result<bool, Fault> {
        match op {
            Op::Nop => {}
            Op::Const(i) => self.stack.push(r.proto.consts[i as usize].clone()),
            Op::PushInt(v) => self.stack.push(Value::Int(v)),
            Op::True => self.stack.push(Value::Bool(true)),
            Op::False => self.stack.push(Value::Bool(false)),
            Op::Pop => {
                self.pop();
            }
            Op::Init(i) => {
                let v = self.make_init(i);
                self.stack.push(v);
            }
            Op::Copy => {
                let v = self.pop().deep_copy();
                self.stack.push(v);
            }

            Op::LoadLocal(s) => {
                let v = &self.stack[r.base + s as usize];
                if let Value::Uninit = v {
                    return Err(self.uninit_local(&r.proto, s));
                }
                let v = v.clone();
                self.stack.push(v);
            }
            Op::StoreLocal(s) => {
                let v = self.pop();
                self.stack[r.base + s as usize] = v;
            }
            Op::LoadGlobal(g) => {
                let v = &self.globals[g as usize];
                if let Value::Uninit = v {
                    return Err(self.uninit_global(g));
                }
                let v = v.clone();
                self.stack.push(v);
            }
            Op::StoreGlobal(g) => {
                let v = self.pop();
                self.globals[g as usize] = v;
            }
            Op::StoreLocalDeref(s) => {
                let v = self.pop();
                let Value::Ref(r) = self.stack[r.base + s as usize].clone() else {
                    return Err(Fault::new("R0004", "BYREF parameter does not hold a reference", "internal error"));
                };
                self.write_ref(&r, v)?;
            }
            Op::RefLocal(s) => self.stack.push(Value::Ref(Ref::Stack(r.base + s as usize))),
            Op::RefGlobal(g) => self.stack.push(Value::Ref(Ref::Global(g))),
            Op::Deref => {
                let r = match self.pop() {
                    Value::Ref(r) => r,
                    Value::Uninit => {
                        return Err(Fault::new(
                            "R0009",
                            "dereferencing a pointer that was never assigned",
                            "this pointer points nowhere",
                        )
                        .help("assign it first, e.g. `P ← ^SomeVariable`"));
                    }
                    other => return Err(Fault::type_error("a pointer", &self.type_name(&other))),
                };
                let v = self.read_ref(&r)?;
                if let Value::Uninit = v {
                    return Err(Fault::new(
                        "R0002",
                        "read through a pointer to an uninitialized variable",
                        "the target has no value yet",
                    ));
                }
                self.stack.push(v);
            }
            Op::StoreDeref => {
                let v = self.pop();
                match self.pop() {
                    Value::Ref(r) => self.write_ref(&r, v)?,
                    Value::Uninit => {
                        return Err(Fault::new(
                            "R0009",
                            "assigning through a pointer that was never assigned",
                            "this pointer points nowhere",
                        ));
                    }
                    other => return Err(Fault::type_error("a pointer", &self.type_name(&other))),
                }
            }

            Op::LoadSelf => {
                let v = self.stack[r.base].clone();
                self.stack.push(v);
            }
            Op::LoadSelfField(s) => {
                let Value::Object(o) = &self.stack[r.base] else { unreachable!("SELF is not an object") };
                let v = self.field_value(o, s)?;
                self.stack.push(v);
            }
            Op::StoreSelfField(s) => {
                let v = self.pop();
                let Value::Object(o) = &self.stack[r.base] else { unreachable!("SELF is not an object") };
                o.fields.borrow_mut()[s as usize] = v;
            }
            Op::RefSelfField(s) => {
                let Value::Object(o) = self.stack[r.base].clone() else { unreachable!("SELF is not an object") };
                self.stack.push(Value::Ref(Ref::Field(o, s)));
            }
            Op::GetField(s) => {
                let v = self.pop();
                let o = self.object(v, "reading a field")?;
                let v = self.field_value(&o, s)?;
                self.stack.push(v);
            }
            Op::SetField(s) => {
                let v = self.pop();
                let o = self.pop();
                let o = self.object(o, "assigning a field")?;
                o.fields.borrow_mut()[s as usize] = v;
            }
            Op::FieldRef(s) => {
                let o = self.pop();
                let o = self.object(o, "referencing a field")?;
                self.stack.push(Value::Ref(Ref::Field(o, s)));
            }
            Op::GetFieldNamed { sym, site } => {
                let o = self.pop();
                let o = self.object(o, "reading a field")?;
                let slot = self.named_field(site, &o, sym, &r.proto)?;
                let v = self.field_value(&o, slot)?;
                self.stack.push(v);
            }
            Op::SetFieldNamed { sym, site } => {
                let v = self.pop();
                let o = self.pop();
                let o = self.object(o, "assigning a field")?;
                let slot = self.named_field(site, &o, sym, &r.proto)?;
                o.fields.borrow_mut()[slot as usize] = v;
            }
            Op::FieldRefNamed { sym, site } => {
                let o = self.pop();
                let o = self.object(o, "referencing a field")?;
                let slot = self.named_field(site, &o, sym, &r.proto)?;
                self.stack.push(Value::Ref(Ref::Field(o, slot)));
            }
            Op::Index(n) => {
                let (arr, i) = self.array_index(n)?;
                let v = arr.borrow().data[i].clone();
                if let Value::Uninit = v {
                    return Err(Fault::new(
                        "R0002",
                        "array element read before it was assigned",
                        "this element has no value yet",
                    )
                    .help("assign every element (e.g. in a FOR loop) before reading it"));
                }
                self.stack.push(v);
            }
            Op::StoreIndex(n) => {
                let v = self.pop();
                let (arr, i) = self.array_index(n)?;
                arr.borrow_mut().data[i] = v;
            }
            Op::IndexRef(n) => {
                let (arr, i) = self.array_index(n)?;
                self.stack.push(Value::Ref(Ref::Elem(arr, i)));
            }

            Op::Add => {
                let b = self.pop();
                let a = self.pop();
                let v = self.arith(op, a, b)?;
                self.stack.push(v);
            }
            Op::Sub => {
                let b = self.pop();
                let a = self.pop();
                let v = self.arith(op, a, b)?;
                self.stack.push(v);
            }
            Op::Mul => {
                let b = self.pop();
                let a = self.pop();
                let v = self.arith(op, a, b)?;
                self.stack.push(v);
            }
            Op::Div => {
                let b = self.pop();
                let a = self.pop();
                let (Some(x), Some(y)) = (as_real(&a), as_real(&b)) else {
                    return Err(Fault::new(
                        "R0004",
                        format!("cannot divide {} by {}", self.type_name(&a), self.type_name(&b)),
                        "invalid operands",
                    ));
                };
                if y == 0.0 {
                    return Err(Fault::new("R0003", "division by zero", format!("{} / 0", self.show(&a)))
                        .help("check the divisor before dividing"));
                }
                self.stack.push(Value::Real(x / y));
            }
            Op::IntDiv | Op::Mod => {
                let b = self.pop_int()?;
                let a = self.pop_int()?;
                if b == 0 {
                    let what = if op == Op::IntDiv { "DIV" } else { "MOD" };
                    return Err(Fault::new("R0003", "division by zero", format!("{a} {what} 0"))
                        .help("check the divisor before dividing"));
                }
                let v = if op == Op::IntDiv { a.wrapping_div(b) } else { a.wrapping_rem(b) };
                self.stack.push(Value::Int(v));
            }
            Op::Neg => {
                let v = match self.pop() {
                    Value::Int(i) => Value::Int(-i),
                    Value::Real(r) => Value::Real(-r),
                    other => return Err(Fault::type_error("a number", &self.type_name(&other))),
                };
                self.stack.push(v);
            }
            Op::Concat => {
                let b = self.pop_str()?;
                let a = self.pop_str()?;
                let mut s = String::with_capacity(a.len() + b.len());
                s.push_str(&a);
                s.push_str(&b);
                self.stack.push(Value::Str(Rc::from(s)));
            }
            Op::Eq | Op::Ne => {
                let b = self.pop();
                let a = self.pop();
                let eq = values_equal(&a, &b);
                self.stack.push(Value::Bool(eq == (op == Op::Eq)));
            }
            Op::Lt | Op::Le | Op::Gt | Op::Ge => {
                let b = self.pop();
                let a = self.pop();
                let Some(ord) = compare(&a, &b) else {
                    return Err(Fault::new(
                        "R0004",
                        format!("cannot compare {} with {}", self.type_name(&a), self.type_name(&b)),
                        "values are not ordered",
                    ));
                };
                let r = match op {
                    Op::Lt => ord == Ordering::Less,
                    Op::Le => ord != Ordering::Greater,
                    Op::Gt => ord == Ordering::Greater,
                    _ => ord != Ordering::Less,
                };
                self.stack.push(Value::Bool(r));
            }
            Op::Not => match self.pop() {
                Value::Bool(b) => self.stack.push(Value::Bool(!b)),
                other => return Err(Fault::type_error("BOOLEAN", &self.type_name(&other))),
            },
            Op::IntToReal => {
                if let Some(Value::Int(i)) = self.stack.last() {
                    let r = *i as f64;
                    *self.stack.last_mut().unwrap() = Value::Real(r);
                }
            }
            Op::Convert(to) => {
                let v = self.pop();
                let v = self.convert(v, to)?;
                self.stack.push(v);
            }
            Op::Check(to) => {
                let v = self.pop();
                let v = self.check(v, to)?;
                self.stack.push(v);
            }
            Op::Coerce { slot, to } => {
                let v = std::mem::take(&mut self.stack[r.base + slot as usize]);
                let v = self.check(v, to)?;
                self.stack[r.base + slot as usize] = v;
            }

            Op::Jump(t) => r.ip = t as usize,
            Op::JumpIfFalse(t) => match self.pop() {
                Value::Bool(false) => r.ip = t as usize,
                Value::Bool(true) => {}
                other => return Err(Fault::type_error("BOOLEAN", &self.type_name(&other))),
            },
            Op::JumpIfFalseOrPop(t) => match self.stack.last() {
                Some(Value::Bool(false)) => r.ip = t as usize,
                _ => {
                    self.pop();
                }
            },
            Op::JumpIfTrueOrPop(t) => match self.stack.last() {
                Some(Value::Bool(true)) => r.ip = t as usize,
                _ => {
                    self.pop();
                }
            },
            Op::ForCheck { var, end, step, exit } => {
                let (Value::Int(v), Value::Int(e), Value::Int(s)) =
                    (self.var_get(r.base, var), self.var_get(r.base, end), self.var_get(r.base, step))
                else {
                    return Err(Fault::new(
                        "R0004",
                        "FOR loop counter is not an INTEGER",
                        "the loop variable was changed to a non-INTEGER value",
                    ));
                };
                if (*s >= 0 && v > e) || (*s < 0 && v < e) {
                    r.ip = exit as usize;
                }
            }
            Op::ForStep { var, step, back } => {
                let (Value::Int(v), Value::Int(s)) = (self.var_get(r.base, var), self.var_get(r.base, step)) else {
                    return Err(Fault::new(
                        "R0004",
                        "FOR loop counter is not an INTEGER",
                        "the loop variable was changed",
                    ));
                };
                match v.checked_add(*s) {
                    Some(n) => self.var_set(r.base, var, Value::Int(n)),
                    None => return Err(Fault::new("R0003", "integer overflow in FOR loop", "counter overflowed")),
                }
                r.ip = back as usize;
            }

            Op::Call { func, argc } => {
                let callee = self.program.functions[func as usize].clone();
                let new_base = self.stack.len() - argc as usize;
                self.call(r, callee, new_base, false)?;
            }
            Op::CallBuiltin { builtin, argc } => {
                let at = self.stack.len() - argc as usize;
                let args: Vec<Value> = self.stack.drain(at..).collect();
                let v = self.call_builtin(builtin, &args)?;
                self.stack.push(v);
            }
            Op::Send { sym, argc, site } | Op::SendSelf { sym, argc, site } => {
                if let Op::SendSelf { .. } = op {
                    let me = self.stack[r.base].clone();
                    let at = self.stack.len() - argc as usize;
                    self.stack.insert(at, me);
                }
                self.stats.sends += 1;
                let recv_at = self.stack.len() - argc as usize - 1;
                let class = match &self.stack[recv_at] {
                    Value::Object(o) => o.shape,
                    Value::Uninit => {
                        return Err(Fault::new(
                            "R0009",
                            format!(
                                "sending `{}` to an object variable that was never assigned",
                                self.program.symbols[sym as usize]
                            ),
                            "this object does not exist yet",
                        )
                        .help("create it first with NEW, e.g. `X ← NEW ClassName(...)`"));
                    }
                    other => {
                        let tn = self.type_name(other);
                        return Err(Fault::new(
                            "R0010",
                            format!(
                                "{tn} value does not understand the message `{}`",
                                self.program.symbols[sym as usize]
                            ),
                            "only objects respond to messages",
                        ));
                    }
                };
                let target = self.send_target(site, class, sym)?;
                self.check_private_method(&target, sym, &r.proto)?;
                let callee = self.program.functions[target.func as usize].clone();
                self.call(r, callee, recv_at, false)?;
            }
            Op::Construct { class, ctor, argc } => {
                let obj = Value::Object(self.new_obj(class));
                if ctor == u32::MAX {
                    self.stack.push(obj);
                } else {
                    let at = self.stack.len() - argc as usize;
                    self.stack.insert(at, obj);
                    let callee = self.program.functions[ctor as usize].clone();
                    self.call(r, callee, at, true)?;
                }
            }
            Op::Return => {
                let v = self.pop();
                self.ret(r, v);
            }
            Op::ReturnVoid => self.ret(r, Value::Void),
            Op::MissingReturn => {
                return Err(Fault::new(
                    "R0008",
                    format!("FUNCTION `{}` finished without returning a value", r.proto.name),
                    "execution reached the end of the function",
                )
                .note(format!("signature: {}", r.proto.signature))
                .help("make sure every path through the function ends in RETURN"));
            }

            Op::Output(n) => {
                let at = self.stack.len() - n as usize;
                let mut line = String::new();
                for v in &self.stack[at..] {
                    line.push_str(&self.show(v));
                }
                self.stack.truncate(at);
                let _ = writeln!(self.out, "{line}");
            }
            Op::Input(conv) => {
                let _ = self.out.flush();
                let mut line = String::new();
                match self.input.read_line(&mut line) {
                    Ok(0) | Err(_) => {
                        return Err(Fault::new("R0006", "no more input", "INPUT reached the end of the input stream"));
                    }
                    Ok(_) => {}
                }
                let text = line.trim_end_matches(['\n', '\r']);
                let v = parse_as(text, conv)?;
                self.stack.push(v);
            }
            Op::OpenFile(mode) => {
                let name = self.pop_str()?;
                self.files.open(&name, mode)?;
            }
            Op::ReadFile(conv) => {
                let name = self.pop_str()?;
                let line = self.files.read_line(&name)?;
                let v = parse_as(&line, conv)?;
                self.stack.push(v);
            }
            Op::WriteFile => {
                let v = self.pop();
                let name = self.pop_str()?;
                let text = self.show(&v);
                self.files.write_line(&name, &text)?;
            }
            Op::CloseFile => {
                let name = self.pop_str()?;
                self.files.close(&name)?;
            }
            Op::Seek => {
                let addr = self.pop_int()?;
                let name = self.pop_str()?;
                self.files.seek(&name, addr)?;
            }
            Op::GetRecord => {
                let name = self.pop_str()?;
                let v = self.files.get_record(&name)?;
                self.stack.push(v);
            }
            Op::PutRecord => {
                let v = self.pop().deep_copy();
                let name = self.pop_str()?;
                self.files.put_record(&name, v)?;
            }
            Op::Halt => return Ok(false),
        }
        Ok(true)
    }

    fn call(&mut self, r: &mut Regs, callee: Rc<Proto>, base: usize, ctor: bool) -> Result<(), Fault> {
        if self.frames.len() >= MAX_FRAMES {
            return Err(Fault::new("R0007", "stack overflow", format!("too many nested calls ({MAX_FRAMES})"))
                .note(format!("while calling `{}`", callee.name))
                .help("check that recursive routines have a base case that is always reached"));
        }
        self.frames.last_mut().unwrap().ip = r.ip;
        self.stack.resize(base + callee.num_slots as usize, Value::Uninit);
        self.frames.push(Frame { proto: callee.clone(), ip: 0, base, ctor });
        self.stats.max_depth = self.stats.max_depth.max(self.frames.len());
        self.stats.calls += 1;
        *r = Regs { proto: callee, ip: 0, base };
        Ok(())
    }

    fn ret(&mut self, r: &mut Regs, value: Value) {
        let frame = self.frames.pop().unwrap();
        // Constructors answer the new object.
        let value = if frame.ctor { self.stack[frame.base].clone() } else { value };
        self.stack.truncate(frame.base);
        self.stack.push(value);
        let top = self.frames.last().unwrap();
        *r = Regs { proto: top.proto.clone(), ip: top.ip, base: top.base };
    }

    fn arith(&self, op: Op, a: Value, b: Value) -> Result<Value, Fault> {
        let sym = match op {
            Op::Add => "+",
            Op::Sub => "-",
            _ => "*",
        };
        if let (Value::Int(x), Value::Int(y)) = (&a, &b) {
            let r = match op {
                Op::Add => x.checked_add(*y),
                Op::Sub => x.checked_sub(*y),
                _ => x.checked_mul(*y),
            };
            return r.map(Value::Int).ok_or_else(|| {
                Fault::new("R0003", "integer overflow", format!("{x} {sym} {y} does not fit in an INTEGER"))
                    .help("use REAL values for very large numbers")
            });
        }
        let (Some(x), Some(y)) = (as_real(&a), as_real(&b)) else {
            let msg = format!("cannot apply `{sym}` to {} and {}", self.type_name(&a), self.type_name(&b));
            return Err(Fault::new("R0004", msg, "invalid operands"));
        };
        Ok(Value::Real(match op {
            Op::Add => x + y,
            Op::Sub => x - y,
            _ => x * y,
        }))
    }

    fn trace_op(&self, proto: &Proto, ip: usize, op: &Op) {
        let depth = self.frames.len().saturating_sub(1);
        let top: Vec<String> = self.stack.iter().rev().take(4).map(|v| self.repr(v)).collect();
        eprintln!(
            "{:indent$}[{}:{ip:04}] {:<40} | {}",
            "",
            proto.name,
            self.program.describe_op(proto, op),
            top.join(" "),
            indent = depth * 2
        );
    }

    fn convert(&self, v: Value, to: Conv) -> Result<Value, Fault> {
        let bad = |v: &Value, what: &str| {
            Err(Fault::new(
                "R0004",
                format!("cannot convert {} to {what}", self.repr(v)),
                format!("not a valid {what}"),
            ))
        };
        Ok(match (to, v) {
            (Conv::Int, Value::Int(i)) => Value::Int(i),
            (Conv::Int, Value::Real(r)) => Value::Int(r.trunc() as i64),
            (Conv::Int, Value::Bool(b)) => Value::Int(i64::from(b)),
            (Conv::Int, Value::Char(c)) => Value::Int(c as i64),
            (Conv::Int, Value::Enum { ord, .. }) => Value::Int(ord as i64),
            (Conv::Int, Value::Date(d)) => Value::Int(d as i64),
            (Conv::Int, v @ Value::Str(_)) => match parse_as(&self.show(&v), Conv::Int) {
                Ok(x) => x,
                Err(_) => return bad(&v, "INTEGER"),
            },
            (Conv::Real, Value::Int(i)) => Value::Real(i as f64),
            (Conv::Real, Value::Real(r)) => Value::Real(r),
            (Conv::Real, v @ Value::Str(_)) => match parse_as(&self.show(&v), Conv::Real) {
                Ok(x) => x,
                Err(_) => return bad(&v, "REAL"),
            },
            (Conv::Str, v) => Value::str(&self.show(&v)),
            (Conv::Char, Value::Int(i)) => match u32::try_from(i).ok().and_then(char::from_u32) {
                Some(c) => Value::Char(c),
                None => return bad(&Value::Int(i), "CHAR"),
            },
            (Conv::Char, Value::Char(c)) => Value::Char(c),
            (Conv::Char, Value::Str(s)) if s.chars().count() == 1 => Value::Char(s.chars().next().unwrap()),
            (Conv::Bool, Value::Bool(b)) => Value::Bool(b),
            (Conv::Bool, Value::Int(i)) => Value::Bool(i != 0),
            (Conv::Bool, v @ Value::Str(_)) => match parse_as(&self.show(&v), Conv::Bool) {
                Ok(x) => x,
                Err(_) => return bad(&v, "BOOLEAN"),
            },
            (Conv::Date, Value::Date(d)) => Value::Date(d),
            (Conv::Date, v @ Value::Str(_)) => match parse_as(&self.show(&v), Conv::Date) {
                Ok(x) => x,
                Err(_) => return bad(&v, "DATE"),
            },
            (Conv::Any, v) => v,
            (to, v) => return bad(&v, conv_name(to)),
        })
    }

    /// Gradual-typing boundary: the value must already have type `to`
    /// (with INTEGER->REAL and CHAR->STRING widening).
    fn check(&self, v: Value, to: Conv) -> Result<Value, Fault> {
        Ok(match (to, v) {
            (Conv::Int, v @ Value::Int(_))
            | (Conv::Real, v @ Value::Real(_))
            | (Conv::Bool, v @ Value::Bool(_))
            | (Conv::Char, v @ Value::Char(_))
            | (Conv::Str, v @ Value::Str(_))
            | (Conv::Date, v @ Value::Date(_))
            | (Conv::Any, v) => v,
            (Conv::Real, Value::Int(i)) => Value::Real(i as f64),
            (Conv::Str, Value::Char(c)) => Value::str(&c.to_string()),
            (to, Value::Void) => {
                return Err(Fault::new(
                    "R0004",
                    format!("expected {} but the routine is a PROCEDURE", conv_name(to)),
                    "no value produced",
                ));
            }
            (to, v) => {
                return Err(Fault::type_error(conv_name(to), &self.type_name(&v))
                    .note("this value's type could only be checked at run time (it came from a routine defined later in the file)"));
            }
        })
    }
}

fn conv_name(c: Conv) -> &'static str {
    match c {
        Conv::Int => "INTEGER",
        Conv::Real => "REAL",
        Conv::Bool => "BOOLEAN",
        Conv::Char => "CHAR",
        Conv::Str => "STRING",
        Conv::Date => "DATE",
        Conv::Any => "a value",
    }
}

/// Parse text read by INPUT / READFILE into a value of the given type.
pub fn parse_as(text: &str, conv: Conv) -> Result<Value, Fault> {
    let t = text.trim();
    let bad = |what: &str, hint: &str| {
        Err(Fault::new("R0006", format!("invalid input for {what}: {text:?}"), format!("expected {what}"))
            .help(hint.to_string()))
    };
    match conv {
        Conv::Int => t.parse().map(Value::Int).or_else(|_| bad("INTEGER", "enter a whole number such as 42")),
        Conv::Real => t.parse().map(Value::Real).or_else(|_| bad("REAL", "enter a number such as 3.5")),
        Conv::Bool => match t.to_uppercase().as_str() {
            "TRUE" => Ok(Value::Bool(true)),
            "FALSE" => Ok(Value::Bool(false)),
            _ => bad("BOOLEAN", "enter TRUE or FALSE"),
        },
        Conv::Char => {
            let mut cs = text.chars();
            match (cs.next(), cs.next()) {
                (Some(c), None) => Ok(Value::Char(c)),
                _ => bad("CHAR", "enter exactly one character"),
            }
        }
        Conv::Date => {
            let parts: Vec<&str> = t.split('/').collect();
            let parsed = match parts.as_slice() {
                [d, m, y] => match (d.parse(), m.parse(), y.parse()) {
                    (Ok(d), Ok(m), Ok(y)) => days_from_civil(y, m, d),
                    _ => None,
                },
                _ => None,
            };
            parsed.map(Value::Date).map_or_else(|| bad("DATE", "enter a date as dd/mm/yyyy"), Ok)
        }
        Conv::Str | Conv::Any => Ok(Value::str(text)),
    }
}

pub fn values_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => Rc::ptr_eq(x, y),
        (Value::Record(x), Value::Record(y)) => {
            x.shape == y.shape
                && x.fields.borrow().iter().zip(y.fields.borrow().iter()).all(|(p, q)| values_equal(p, q))
        }
        (Value::Array(x), Value::Array(y)) => {
            let (x, y) = (x.borrow(), y.borrow());
            x.dims == y.dims && x.data.iter().zip(&y.data).all(|(p, q)| values_equal(p, q))
        }
        (Value::Ref(x), Value::Ref(y)) => match (x, y) {
            (Ref::Stack(i), Ref::Stack(j)) => i == j,
            (Ref::Global(i), Ref::Global(j)) => i == j,
            (Ref::Elem(a, i), Ref::Elem(b, j)) => Rc::ptr_eq(a, b) && i == j,
            (Ref::Field(a, i), Ref::Field(b, j)) => Rc::ptr_eq(a, b) && i == j,
            _ => false,
        },
        (Value::Bool(x), Value::Bool(y)) => x == y,
        _ => compare(a, b) == Some(Ordering::Equal),
    }
}

fn as_real(v: &Value) -> Option<f64> {
    match v {
        Value::Int(i) => Some(*i as f64),
        Value::Real(r) => Some(*r),
        _ => None,
    }
}

pub fn compare(a: &Value, b: &Value) -> Option<Ordering> {
    match (a, b) {
        (Value::Int(x), Value::Int(y)) => Some(x.cmp(y)),
        (Value::Int(x), Value::Real(y)) => (*x as f64).partial_cmp(y),
        (Value::Real(x), Value::Int(y)) => x.partial_cmp(&(*y as f64)),
        (Value::Real(x), Value::Real(y)) => x.partial_cmp(y),
        (Value::Char(x), Value::Char(y)) => Some(x.cmp(y)),
        (Value::Str(x), Value::Str(y)) => Some(x.cmp(y)),
        (Value::Char(x), Value::Str(y)) => Some(x.to_string().as_str().cmp(y)),
        (Value::Str(x), Value::Char(y)) => Some((**x).cmp(y.to_string().as_str())),
        (Value::Date(x), Value::Date(y)) => Some(x.cmp(y)),
        (Value::Bool(x), Value::Bool(y)) => Some(x.cmp(y)),
        (Value::Enum { ty: t1, ord: o1 }, Value::Enum { ty: t2, ord: o2 }) if t1 == t2 => Some(o1.cmp(o2)),
        _ => None,
    }
}
