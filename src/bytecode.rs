//! Bytecode, function prototypes, runtime metadata and the disassembler.
//!
//! Every instruction carries a source span, and every prototype keeps a
//! table of its locals, so the VM can map any failure back to source.

use crate::builtins::Builtin;
use crate::source::{Source, Span};
use crate::value::{Value, format_date, format_real};
use std::collections::HashMap;
use std::fmt::Write as _;
use std::rc::Rc;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VarLoc {
    Local(u16),
    Global(u32),
}

/// Target of a conversion (`INTEGER(x)`, `INPUT`, parameter coercion).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Conv {
    Int,
    Real,
    Bool,
    Char,
    Str,
    Date,
    Any,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FileMode {
    Read,
    Write,
    Append,
    Random,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Op {
    Nop,
    Const(u32),
    PushInt(i64),
    True,
    False,
    Pop,
    /// Push a fresh default value built from `Program::inits[i]`.
    Init(u32),
    /// Deep-copy the aggregate on top of the stack (records/arrays have value semantics).
    Copy,

    LoadLocal(u16),
    StoreLocal(u16),
    LoadGlobal(u32),
    StoreGlobal(u32),
    /// Store through the reference held in a local (a `BYREF` parameter).
    StoreLocalDeref(u16),
    RefLocal(u16),
    RefGlobal(u32),
    Deref,
    /// `[ref, value] -> []`
    StoreDeref,

    LoadSelf,
    LoadSelfField(u16),
    StoreSelfField(u16),
    RefSelfField(u16),
    /// `[obj] -> [value]` with a statically known slot.
    GetField(u16),
    /// `[obj, value] -> []`
    SetField(u16),
    FieldRef(u16),
    /// Field access on a receiver whose type is unknown at compile time.
    /// Resolved by name and memoized in an inline cache.
    GetFieldNamed {
        sym: u32,
        site: u32,
    },
    SetFieldNamed {
        sym: u32,
        site: u32,
    },
    FieldRefNamed {
        sym: u32,
        site: u32,
    },
    /// `[array, i1..in] -> [value]`
    Index(u8),
    /// `[array, i1..in, value] -> []`
    StoreIndex(u8),
    IndexRef(u8),

    Add,
    Sub,
    Mul,
    Div,
    IntDiv,
    Mod,
    Neg,
    Concat,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    Not,
    IntToReal,
    Convert(Conv),
    /// Run-time type check where a statically unknown value meets a typed slot.
    Check(Conv),
    /// Prologue coercion of a parameter slot (e.g. INTEGER argument to REAL parameter).
    Coerce {
        slot: u16,
        to: Conv,
    },

    Jump(u32),
    JumpIfFalse(u32),
    /// Short-circuit `AND`: jump keeping the value if false, otherwise pop.
    JumpIfFalseOrPop(u32),
    /// Short-circuit `OR`: jump keeping the value if true, otherwise pop.
    JumpIfTrueOrPop(u32),
    /// Fused FOR-loop test: exit if `var` has passed `end` in the direction of `step`.
    ForCheck {
        var: VarLoc,
        end: VarLoc,
        step: VarLoc,
        exit: u32,
    },
    /// Fused FOR-loop increment and back-edge.
    ForStep {
        var: VarLoc,
        step: VarLoc,
        back: u32,
    },

    /// Call `functions[func]` with `argc` stack slots (including `self` for methods).
    Call {
        func: u32,
        argc: u8,
    },
    CallBuiltin {
        builtin: Builtin,
        argc: u8,
    },
    /// Dynamic message send through a per-site inline cache:
    /// `[receiver, args..] -> [result]`.
    Send {
        sym: u32,
        argc: u8,
        site: u32,
    },
    /// Send to the current receiver (`self`), which is not on the stack.
    SendSelf {
        sym: u32,
        argc: u8,
        site: u32,
    },
    /// Allocate an instance of `class` and run its constructor (`u32::MAX` = none).
    Construct {
        class: u32,
        ctor: u32,
        argc: u8,
    },
    Return,
    ReturnVoid,
    /// Reached the end of a FUNCTION without a RETURN.
    MissingReturn,

    Output(u8),
    Input(Conv),
    OpenFile(FileMode),
    ReadFile(Conv),
    WriteFile,
    CloseFile,
    Seek,
    GetRecord,
    PutRecord,
    Halt,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProtoKind {
    Main,
    Function,
    Procedure,
    Method { class: u32 },
}

#[derive(Clone, Debug)]
pub struct LocalInfo {
    pub name: String,
    pub slot: u16,
    pub ty: String,
    pub decl: Span,
    pub byref: bool,
}

/// A compiled function, procedure, method or the main program.
#[derive(Clone, Debug)]
pub struct Proto {
    pub name: String,
    pub kind: ProtoKind,
    /// Number of argument slots, including `self` for methods.
    pub arity: u16,
    pub num_slots: u16,
    pub code: Vec<Op>,
    pub spans: Vec<Span>,
    pub consts: Vec<Value>,
    pub locals: Vec<LocalInfo>,
    pub decl: Span,
    pub signature: String,
}

impl Proto {
    pub fn new(name: impl Into<String>, kind: ProtoKind, decl: Span) -> Self {
        Proto {
            name: name.into(),
            kind,
            arity: 0,
            num_slots: 0,
            code: Vec::new(),
            spans: Vec::new(),
            consts: Vec::new(),
            locals: Vec::new(),
            decl,
            signature: String::new(),
        }
    }

    pub fn local_name(&self, slot: u16) -> Option<&LocalInfo> {
        self.locals.iter().find(|l| l.slot == slot)
    }
}

#[derive(Clone, Debug)]
pub struct GlobalInfo {
    pub name: String,
    pub ty: String,
    pub decl: Span,
}

#[derive(Clone, Debug)]
pub struct FieldMeta {
    pub name: String,
    pub sym: u32,
    pub private: bool,
    /// Shape that declared the field (differs from the holder for inherited fields).
    pub owner: u32,
    pub ty: String,
}

#[derive(Clone, Copy, Debug)]
pub struct MethodMeta {
    pub func: u32,
    pub private: bool,
    pub owner: u32,
}

/// Fixed slot layout of a record type or class ("hidden class"/"map").
/// Subclass layouts extend their parent's, so inherited field slots are
/// stable and statically addressable.
#[derive(Clone, Debug)]
pub struct Shape {
    pub name: String,
    pub is_class: bool,
    pub parent: Option<u32>,
    pub fields: Vec<FieldMeta>,
    pub field_inits: Vec<u32>,
    /// Method dictionary: selector symbol -> method. Only methods defined
    /// directly in this class; lookup walks the superclass chain.
    pub methods: HashMap<u32, MethodMeta>,
}

#[derive(Clone, Debug)]
pub enum Init {
    Uninit,
    Array { dims: Rc<[(i64, i64)]>, elem: u32 },
    Record(u32),
}

#[derive(Clone, Debug)]
pub struct EnumInfo {
    pub name: String,
    pub variants: Vec<String>,
}

#[derive(Debug)]
pub struct Program {
    pub main: Rc<Proto>,
    pub functions: Vec<Rc<Proto>>,
    pub globals: Vec<GlobalInfo>,
    pub shapes: Vec<Shape>,
    pub enums: Vec<EnumInfo>,
    pub inits: Vec<Init>,
    pub symbols: Vec<String>,
    pub num_sites: u32,
}

impl Program {
    pub fn describe_const(&self, v: &Value) -> String {
        match v {
            Value::Str(s) => format!("{s:?}"),
            Value::Char(c) => format!("'{c}'"),
            Value::Real(r) => format_real(*r),
            Value::Date(d) => format_date(*d),
            Value::Enum { ty, ord } => self.enums[*ty as usize].variants[*ord as usize].clone(),
            Value::Int(i) => i.to_string(),
            Value::Bool(b) => if *b { "TRUE" } else { "FALSE" }.into(),
            other => other.type_name().into(),
        }
    }

    pub fn disassemble(&self, src: &Source) -> String {
        let mut out = String::new();
        outln!(out, "; program `{}`", src.name);
        outln!(
            out,
            "; {} functions, {} globals, {} shapes, {} selectors, {} inline-cache sites\n",
            self.functions.len(),
            self.globals.len(),
            self.shapes.len(),
            self.symbols.len(),
            self.num_sites
        );
        if !self.globals.is_empty() {
            outln!(out, "globals:");
            for (i, g) in self.globals.iter().enumerate() {
                let (l, c) = src.line_col(g.decl.start);
                outln!(out, "  g{i:<4} {:<20} : {:<24} ; declared {l}:{c}", g.name, g.ty);
            }
            out.push('\n');
        }
        for (i, s) in self.shapes.iter().enumerate() {
            let kind = if s.is_class { "class" } else { "record" };
            let parent = s.parent.map(|p| format!(" inherits {}", self.shapes[p as usize].name)).unwrap_or_default();
            outln!(out, "shape #{i} {kind} {}{parent}", s.name);
            for (slot, f) in s.fields.iter().enumerate() {
                let vis = if f.private { "PRIVATE" } else { "PUBLIC " };
                outln!(out, "  [{slot}] {vis} {} : {}", f.name, f.ty);
            }
            let mut methods: Vec<_> = s.methods.iter().collect();
            methods.sort_by_key(|(sym, _)| self.symbols[**sym as usize].clone());
            for (sym, m) in methods {
                let vis = if m.private { "PRIVATE" } else { "PUBLIC " };
                outln!(out, "  #{} {vis} -> fn{}", self.symbols[*sym as usize], m.func);
            }
            out.push('\n');
        }
        self.disassemble_proto(&mut out, src, &self.main, None);
        for (i, f) in self.functions.iter().enumerate() {
            self.disassemble_proto(&mut out, src, f, Some(i));
        }
        out
    }

    fn disassemble_proto(&self, out: &mut String, src: &Source, p: &Proto, index: Option<usize>) {
        let id = index.map_or("main".to_string(), |i| format!("fn{i}"));
        outln!(out, "{id}: {}  ; {} slots, arity {}", p.signature, p.num_slots, p.arity);
        for l in &p.locals {
            let (line, col) = src.line_col(l.decl.start);
            let byref = if l.byref { " BYREF" } else { "" };
            outln!(out, "  ; local %{} {}{byref} : {}  (declared {line}:{col})", l.slot, l.name, l.ty);
        }
        let mut last_line = usize::MAX;
        for (pc, op) in p.code.iter().enumerate() {
            let span = p.spans[pc];
            let (line, col) = src.line_col(span.start);
            if line != last_line && span != Span::DUMMY {
                outln!(out, "  ;; {line:>4} | {}", src.line_text(line - 1).trim());
                last_line = line;
            }
            outln!(out, "  {pc:05}  {:<44} ; {line}:{col}", self.describe_op(p, op));
        }
        out.push('\n');
    }

    fn var_name(&self, p: &Proto, v: VarLoc) -> String {
        match v {
            VarLoc::Local(s) => p.local_name(s).map_or(format!("%{s}"), |l| format!("%{s}({})", l.name)),
            VarLoc::Global(g) => format!("g{g}({})", self.globals[g as usize].name),
        }
    }

    pub fn describe_op(&self, p: &Proto, op: &Op) -> String {
        let debug = format!("{op:?}");
        let name_end = debug.find(|c: char| !c.is_alphanumeric()).unwrap_or(debug.len());
        let mnemonic = screaming_snake(&debug[..name_end]);
        let local = |s: u16| self.var_name(p, VarLoc::Local(s));
        let sym = |s: u32| &self.symbols[s as usize];
        let operands = match *op {
            Op::Const(i) => self.describe_const(&p.consts[i as usize]),
            Op::Init(i) => self.describe_init(i),
            Op::LoadLocal(s) | Op::StoreLocal(s) | Op::StoreLocalDeref(s) | Op::RefLocal(s) => local(s),
            Op::LoadGlobal(g) | Op::StoreGlobal(g) | Op::RefGlobal(g) => self.var_name(p, VarLoc::Global(g)),
            Op::GetFieldNamed { sym: s, site }
            | Op::SetFieldNamed { sym: s, site }
            | Op::FieldRefNamed { sym: s, site } => {
                format!(".{} @ic{site}", sym(s))
            }
            Op::GetField(s)
            | Op::SetField(s)
            | Op::FieldRef(s)
            | Op::LoadSelfField(s)
            | Op::StoreSelfField(s)
            | Op::RefSelfField(s) => format!("[{s}]"),
            Op::Coerce { slot, to } => format!("{} -> {to:?}", local(slot)),
            Op::ForCheck { var, end, step, exit } => format!(
                "{} to {} step {} else ->{exit}",
                self.var_name(p, var),
                self.var_name(p, end),
                self.var_name(p, step)
            ),
            Op::ForStep { var, step, back } => {
                format!("{} += {} ->{back}", self.var_name(p, var), self.var_name(p, step))
            }
            Op::Jump(t) | Op::JumpIfFalse(t) | Op::JumpIfFalseOrPop(t) | Op::JumpIfTrueOrPop(t) => format!("->{t}"),
            Op::Call { func, argc } => format!("fn{func}({}) argc={argc}", self.functions[func as usize].name),
            Op::CallBuiltin { builtin, argc } => format!("{} argc={argc}", builtin.name()),
            Op::Send { sym: s, argc, site } | Op::SendSelf { sym: s, argc, site } => {
                format!("#{} argc={argc} @ic{site}", sym(s))
            }
            Op::Construct { class, ctor, argc } => {
                let ctor = if ctor == u32::MAX { "none".to_string() } else { format!("fn{ctor}") };
                format!("{} ctor={ctor} argc={argc}", self.shapes[class as usize].name)
            }
            _ => debug[name_end..].trim_matches(['(', ')', ' ']).to_string(),
        };
        if operands.is_empty() { mnemonic } else { format!("{mnemonic} {operands}") }
    }

    fn describe_init(&self, i: u32) -> String {
        match &self.inits[i as usize] {
            Init::Uninit => "uninit".into(),
            Init::Record(s) => format!("record {}", self.shapes[*s as usize].name),
            Init::Array { dims, elem } => {
                let d: Vec<String> = dims.iter().map(|(l, h)| format!("{l}:{h}")).collect();
                format!("array[{}] of {}", d.join(","), self.describe_init(*elem))
            }
        }
    }
}

/// `GetField` -> `GET_FIELD`
fn screaming_snake(name: &str) -> String {
    let mut out = String::new();
    for (i, ch) in name.chars().enumerate() {
        if i > 0 && ch.is_uppercase() {
            out.push('_');
        }
        out.push(ch.to_ascii_uppercase());
    }
    out
}
