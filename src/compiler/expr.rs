//! Expression compilation with deferred loads.

use super::*;
use crate::builtins::P;
use crate::bytecode::Conv;

/// A storage location whose address computation (if any) is already on the
/// stack, but whose final load/store/reference instruction has not been
/// emitted yet.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Place {
    Local {
        slot: u16,
        byref: bool,
    },
    Global(u32),
    SelfField(u16),
    /// Object on the stack, slot known statically.
    Field(u16),
    /// Object on the stack, receiver type unknown: resolved by name at run time.
    FieldNamed {
        sym: u32,
        site: u32,
    },
    /// Array and indices on the stack.
    Index(u8),
    /// Reference on the stack.
    Deref,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum CallKind {
    Procedure,
    Function,
    Method,
    Builtin,
    Pending(usize),
}

pub(super) struct Expr {
    /// `None` once the value has been pushed.
    pub place: Option<Place>,
    pub ty: Ty,
    pub span: Span,
    pub call: Option<CallKind>,
    /// The variable this place names directly, for use/assignment tracking.
    pub var: Option<VarLoc>,
    /// Compile-time value of a literal (for folding and constant checks).
    pub constant: Option<Value>,
}

impl Expr {
    pub fn value(ty: Ty, span: Span) -> Self {
        Expr { place: None, ty, span, call: None, var: None, constant: None }
    }

    fn place(place: Place, ty: Ty, span: Span) -> Self {
        Expr { place: Some(place), ty, span, call: None, var: None, constant: None }
    }

    pub fn error(span: Span) -> Self {
        Expr::value(Ty::Error, span)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum BinOp {
    Add,
    Sub,
    Mul,
    Div,
    IntDiv,
    Mod,
    Concat,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
}

impl BinOp {
    fn symbol(self) -> &'static str {
        match self {
            BinOp::Add => "+",
            BinOp::Sub => "-",
            BinOp::Mul => "*",
            BinOp::Div => "/",
            BinOp::IntDiv => "DIV",
            BinOp::Mod => "MOD",
            BinOp::Concat => "&",
            BinOp::Eq => "=",
            BinOp::Ne => "<>",
            BinOp::Lt => "<",
            BinOp::Le => "<=",
            BinOp::Gt => ">",
            BinOp::Ge => ">=",
        }
    }

    fn is_relational(self) -> bool {
        matches!(self, BinOp::Lt | BinOp::Le | BinOp::Gt | BinOp::Ge)
    }
}

/// Parsed argument list of a call.
pub(super) struct Args {
    pub count: usize,
    pub span: Span,
    pub deferred: Vec<PendingArg>,
}

impl Compiler<'_> {
    /// Emit the pending load of `e`, if any.
    pub(super) fn discharge(&mut self, e: Expr) -> Expr {
        self.discharge_tracked(e).0
    }

    /// Like [`discharge`], also returning the load instruction and the
    /// reference instruction that could replace it (for forward BYREF calls).
    fn discharge_tracked(&mut self, mut e: Expr) -> (Expr, Option<(usize, Op)>) {
        let Some(place) = e.place.take() else {
            return (e, None);
        };
        if let Some(v) = e.var {
            self.mark_var(v, true, false);
        }
        let span = e.span;
        let patch = match place {
            Place::Local { slot, byref: false } => (self.emit(Op::LoadLocal(slot), span), Op::RefLocal(slot)),
            Place::Local { slot, byref: true } => {
                self.emit(Op::LoadLocal(slot), span);
                (self.emit(Op::Deref, span), Op::Nop)
            }
            Place::Global(g) => (self.emit(Op::LoadGlobal(g), span), Op::RefGlobal(g)),
            Place::SelfField(s) => (self.emit(Op::LoadSelfField(s), span), Op::RefSelfField(s)),
            Place::Field(s) => (self.emit(Op::GetField(s), span), Op::FieldRef(s)),
            Place::FieldNamed { sym, site } => {
                (self.emit(Op::GetFieldNamed { sym, site }, span), Op::FieldRefNamed { sym, site })
            }
            Place::Index(n) => (self.emit(Op::Index(n), span), Op::IndexRef(n)),
            Place::Deref => (self.emit(Op::Deref, span), Op::Nop),
        };
        (e, Some(patch))
    }

    /// Push a reference to the place (for BYREF arguments and `^X`).
    pub(super) fn emit_ref(&mut self, place: Place, span: Span) {
        let op = match place {
            Place::Local { slot, byref: false } => Op::RefLocal(slot),
            Place::Local { slot, byref: true } => Op::LoadLocal(slot),
            Place::Global(g) => Op::RefGlobal(g),
            Place::SelfField(s) => Op::RefSelfField(s),
            Place::Field(s) => Op::FieldRef(s),
            Place::FieldNamed { sym, site } => Op::FieldRefNamed { sym, site },
            Place::Index(n) => Op::IndexRef(n),
            Place::Deref => return,
        };
        self.emit(op, span);
    }

    /// Store the value on top of the stack into the place.
    pub(super) fn emit_store(&mut self, place: Place, span: Span) {
        let op = match place {
            Place::Local { slot, byref: false } => Op::StoreLocal(slot),
            Place::Local { slot, byref: true } => Op::StoreLocalDeref(slot),
            Place::Global(g) => Op::StoreGlobal(g),
            Place::SelfField(s) => Op::StoreSelfField(s),
            Place::Field(s) => Op::SetField(s),
            Place::FieldNamed { sym, site } => Op::SetFieldNamed { sym, site },
            Place::Index(n) => Op::StoreIndex(n),
            Place::Deref => Op::StoreDeref,
        };
        self.emit(op, span);
    }

    /// A complete expression, value pushed.
    pub(super) fn expr(&mut self) -> Expr {
        let e = self.expr_desc();
        self.discharge(e)
    }

    /// A complete expression, possibly still a place.
    pub(super) fn expr_desc(&mut self) -> Expr {
        self.or_expr()
    }

    /// An expression that must be BOOLEAN (conditions).
    pub(super) fn condition(&mut self, owner: &str, owner_span: Span) {
        let e = self.expr();
        if self.at(Tok::Arrow) {
            let span = self.tok.span;
            self.parse_error(
                Diagnostic::error("E0100", "assignment is not allowed in a condition")
                    .primary(span, "this assigns a value")
                    .suggest(span, "=", "use `=` to compare for equality"),
            );
            return;
        }
        if !self.convert_top(&Ty::Bool, &e.ty, e.span) {
            let found = self.ty_name(&e.ty);
            let d = self
                .mismatch(&Ty::Bool, &e.ty, e.span)
                .secondary(owner_span, format!("`{owner}` conditions must be BOOLEAN"));
            let d = if found == "INTEGER" || found == "REAL" {
                d.suggest(e.span.after(), " <> 0", "compare the number explicitly")
            } else {
                d
            };
            self.error(d);
        }
    }

    fn or_expr(&mut self) -> Expr {
        self.logical(Kw::Or, Self::and_expr, Op::JumpIfTrueOrPop)
    }

    fn and_expr(&mut self) -> Expr {
        self.logical(Kw::And, Self::not_expr, Op::JumpIfFalseOrPop)
    }

    /// Left-associative short-circuit operator.
    fn logical(&mut self, kw: Kw, operand: fn(&mut Self) -> Expr, jump: fn(u32) -> Op) -> Expr {
        let mut l = operand(self);
        while self.at_kw(kw) {
            let op_span = self.tok.span;
            self.advance();
            l = self.discharge(l);
            self.expect_bool_operand(&l, kw.as_str(), op_span);
            let j = self.emit(jump(0), op_span);
            let r = operand(self);
            let r = self.discharge(r);
            self.expect_bool_operand(&r, kw.as_str(), op_span);
            self.patch_jump(j);
            l = Expr::value(Ty::Bool, l.span.to(r.span));
        }
        l
    }

    fn expect_bool_operand(&mut self, e: &Expr, op: &str, op_span: Span) {
        if !self.convert_top(&Ty::Bool, &e.ty, e.span) {
            let d =
                self.mismatch(&Ty::Bool, &e.ty, e.span).secondary(op_span, format!("`{op}` needs BOOLEAN operands"));
            self.error(d);
        }
    }

    fn not_expr(&mut self) -> Expr {
        if self.at_kw(Kw::Not) {
            let span = self.tok.span;
            self.advance();
            let e = self.not_expr();
            let e = self.discharge(e);
            self.expect_bool_operand(&e, "NOT", span);
            self.emit(Op::Not, span);
            return Expr::value(Ty::Bool, span.to(e.span));
        }
        self.comparison()
    }

    fn comparison(&mut self) -> Expr {
        let mut l = self.concat();
        loop {
            let op = match self.tok.tok {
                Tok::Eq => BinOp::Eq,
                Tok::Ne => BinOp::Ne,
                Tok::Lt => BinOp::Lt,
                Tok::Le => BinOp::Le,
                Tok::Gt => BinOp::Gt,
                Tok::Ge => BinOp::Ge,
                _ => return l,
            };
            l = self.binary(op, l, Self::concat);
        }
    }

    fn concat(&mut self) -> Expr {
        let mut l = self.additive();
        while self.at(Tok::Amp) {
            l = self.binary(BinOp::Concat, l, Self::additive);
        }
        l
    }

    fn additive(&mut self) -> Expr {
        let mut l = self.term();
        loop {
            let op = match self.tok.tok {
                Tok::Plus => BinOp::Add,
                Tok::Minus => BinOp::Sub,
                _ => return l,
            };
            l = self.binary(op, l, Self::term);
        }
    }

    fn term(&mut self) -> Expr {
        let mut l = self.unary();
        loop {
            let op = match self.tok.tok {
                Tok::Star => BinOp::Mul,
                Tok::Slash => BinOp::Div,
                Tok::Kw(Kw::Div) => BinOp::IntDiv,
                Tok::Kw(Kw::Mod) => BinOp::Mod,
                _ => return l,
            };
            l = self.binary(op, l, Self::unary);
        }
    }

    fn binary(&mut self, op: BinOp, l: Expr, rhs: fn(&mut Self) -> Expr) -> Expr {
        let op_span = self.tok.span;
        self.advance();
        let l = self.discharge(l);
        let r = rhs(self);
        let r = self.discharge(r);
        let ty = self.emit_binary(op, &l, &r, op_span);
        Expr::value(ty, l.span.to(r.span))
    }

    /// Type-check and emit a binary operator; both operands are on the stack.
    pub(super) fn emit_binary(&mut self, op: BinOp, l: &Expr, r: &Expr, op_span: Span) -> Ty {
        let (lt, rt) = (&l.ty, &r.ty);
        if lt == &Ty::Error || rt == &Ty::Error {
            return Ty::Error;
        }
        let dynamic = lt.is_dynamic() || rt.is_dynamic();
        let numeric = |t: &Ty| t.is_numeric() || t.is_dynamic();
        let result = match op {
            BinOp::Add | BinOp::Sub | BinOp::Mul if numeric(lt) && numeric(rt) => {
                self.emit(
                    match op {
                        BinOp::Add => Op::Add,
                        BinOp::Sub => Op::Sub,
                        _ => Op::Mul,
                    },
                    op_span,
                );
                Some(if lt == &Ty::Real || rt == &Ty::Real {
                    Ty::Real
                } else if dynamic {
                    Ty::Unknown
                } else {
                    Ty::Int
                })
            }
            BinOp::Div if numeric(lt) && numeric(rt) => {
                self.emit(Op::Div, op_span);
                Some(Ty::Real)
            }
            BinOp::IntDiv | BinOp::Mod
                if matches!(lt, Ty::Int | Ty::Unknown) && matches!(rt, Ty::Int | Ty::Unknown) =>
            {
                self.emit(if op == BinOp::IntDiv { Op::IntDiv } else { Op::Mod }, op_span);
                Some(Ty::Int)
            }
            BinOp::Concat if (lt.is_text() || dynamic) && (rt.is_text() || rt.is_dynamic()) => {
                self.emit(Op::Concat, op_span);
                Some(Ty::Str)
            }
            BinOp::Eq | BinOp::Ne | BinOp::Lt | BinOp::Le | BinOp::Gt | BinOp::Ge if self.comparable(op, lt, rt) => {
                let ins = match op {
                    BinOp::Eq => Op::Eq,
                    BinOp::Ne => Op::Ne,
                    BinOp::Lt => Op::Lt,
                    BinOp::Le => Op::Le,
                    BinOp::Gt => Op::Gt,
                    _ => Op::Ge,
                };
                self.emit(ins, op_span);
                Some(Ty::Bool)
            }
            _ => None,
        };
        if let Some(ty) = result {
            return ty;
        }
        self.operator_error(op, l, r, op_span);
        match op {
            BinOp::Concat => Ty::Str,
            BinOp::Eq | BinOp::Ne | BinOp::Lt | BinOp::Le | BinOp::Gt | BinOp::Ge => Ty::Bool,
            _ => Ty::Error,
        }
    }

    fn comparable(&self, op: BinOp, l: &Ty, r: &Ty) -> bool {
        if l.is_dynamic() || r.is_dynamic() {
            return true;
        }
        let ordered = (l.is_numeric() && r.is_numeric())
            || (l.is_text() && r.is_text())
            || (l == r && matches!(l, Ty::Date | Ty::Enum(_)));
        if ordered {
            return true;
        }
        let equality = matches!(op, BinOp::Eq | BinOp::Ne);
        equality
            && (l == r
                || matches!((l, r), (Ty::Class(a), Ty::Class(b)) if self.is_subclass(*a, *b) || self.is_subclass(*b, *a)))
    }

    fn operator_error(&mut self, op: BinOp, l: &Expr, r: &Expr, op_span: Span) {
        let (ln, rn) = (self.ty_name(&l.ty), self.ty_name(&r.ty));
        let sym = op.symbol();
        let mut d = Diagnostic::error("E0303", format!("cannot apply `{sym}` to `{ln}` and `{rn}`"))
            .primary(op_span, "no implementation for these operand types")
            .secondary(l.span, format!("`{ln}`"))
            .secondary(r.span, format!("`{rn}`"));
        d = match op {
            BinOp::Add if l.ty.is_text() || r.ty.is_text() => {
                d.suggest(op_span, "&", "use `&` to join strings together")
            }
            BinOp::Concat => {
                let bad = if l.ty.is_text() { r } else { l };
                if bad.ty.is_numeric() {
                    let text = self.text(bad.span);
                    d.suggest(bad.span, format!("NUM_TO_STR({text})"), "convert the number to a STRING first")
                } else {
                    d.note("`&` concatenates STRING and CHAR values")
                }
            }
            BinOp::IntDiv | BinOp::Mod if l.ty == Ty::Real || r.ty == Ty::Real => d
                .note(format!("`{sym}` is only defined for INTEGER operands"))
                .help("use `/` for REAL division, or INT(...) to truncate first"),
            o if o.is_relational() && l.ty == Ty::Bool && r.ty.is_numeric() => {
                d.note("comparison operators cannot be chained").help("split the comparison, e.g. `A < B AND B < C`")
            }
            _ => d,
        };
        self.error(d);
    }

    fn unary(&mut self) -> Expr {
        if self.at(Tok::Minus) {
            let span = self.tok.span;
            self.advance();
            let e = self.unary();
            let e = self.discharge(e);
            let full = span.to(e.span);
            // Fold negative literals so constants such as `-1` stay constants.
            match e.constant {
                Some(Value::Int(v)) => {
                    let pc = self.pc() - 1;
                    self.proto().code[pc] = Op::PushInt(-v);
                    let mut out = Expr::value(Ty::Int, full);
                    out.constant = Some(Value::Int(-v));
                    return out;
                }
                Some(Value::Real(v)) => {
                    let pc = self.pc() - 1;
                    if let Op::Const(i) = self.proto().code[pc] {
                        self.proto().consts[i as usize] = Value::Real(-v);
                    }
                    let mut out = Expr::value(Ty::Real, full);
                    out.constant = Some(Value::Real(-v));
                    return out;
                }
                _ => {}
            }
            if !(e.ty.is_numeric() || e.ty.is_dynamic()) {
                let n = self.ty_name(&e.ty);
                self.error(
                    Diagnostic::error("E0303", format!("cannot negate a value of type `{n}`"))
                        .primary(span, "unary `-` needs a number")
                        .secondary(e.span, format!("`{n}`")),
                );
                return Expr::error(full);
            }
            self.emit(Op::Neg, span);
            return Expr::value(e.ty, full);
        }
        self.postfix()
    }

    pub(super) fn postfix(&mut self) -> Expr {
        let mut e = self.primary();
        loop {
            match self.tok.tok {
                Tok::Dot => {
                    self.advance();
                    let Some((name, name_span)) = self.member_name() else {
                        return Expr::error(e.span);
                    };
                    e = self.discharge(e);
                    e = if self.at(Tok::LParen) {
                        self.method_call(e, &name, name_span)
                    } else {
                        self.field_access(e, &name, name_span)
                    };
                }
                Tok::LBracket => {
                    e = self.discharge(e);
                    e = self.index(e);
                }
                Tok::Caret => {
                    let span = self.tok.span;
                    self.advance();
                    e = self.discharge(e);
                    let full = e.span.to(span);
                    e = match &e.ty {
                        Ty::Pointer(t) => Expr::place(Place::Deref, (**t).clone(), full),
                        Ty::Unknown | Ty::Error => Expr::place(Place::Deref, e.ty.clone(), full),
                        other => {
                            let n = self.ty_name(other);
                            self.error(
                                Diagnostic::error("E0304", format!("cannot dereference a value of type `{n}`"))
                                    .primary(span, "`^` after a value follows a pointer")
                                    .secondary(e.span, format!("this is `{n}`, not a pointer")),
                            );
                            Expr::error(full)
                        }
                    };
                }
                _ => return e,
            }
        }
    }

    /// Member names may be identifiers or the keyword `NEW` (constructors).
    fn member_name(&mut self) -> Option<(String, Span)> {
        if self.at_kw(Kw::New) {
            let span = self.tok.span;
            self.advance();
            return Some(("NEW".into(), span));
        }
        self.expect_ident("after `.`")
    }

    fn field_access(&mut self, obj: Expr, name: &str, name_span: Span) -> Expr {
        let full = obj.span.to(name_span);
        let shape = match &obj.ty {
            Ty::Record(s) | Ty::Class(s) => *s,
            Ty::Unknown => {
                let sym = self.intern(name);
                let site = self.new_site();
                return Expr::place(Place::FieldNamed { sym, site }, Ty::Unknown, full);
            }
            Ty::Error => return Expr::error(full),
            other => {
                let n = self.ty_name(other);
                let mut d = Diagnostic::error("E0305", format!("`{n}` values have no fields"))
                    .primary(name_span, format!("no field `{name}`"))
                    .secondary(obj.span, format!("this has type `{n}`"));
                if Builtin::lookup(&name.to_uppercase()).is_some() && other.is_text() {
                    d = d.help(format!("string operations are functions: `{}(...)`", name.to_uppercase()));
                }
                self.error(d);
                return Expr::error(full);
            }
        };
        if let Some(idx) = self.shapes[shape as usize].fields.iter().position(|f| f.name == name) {
            let f = &self.shapes[shape as usize].fields[idx];
            let ty = f.ty.clone();
            self.check_field_visibility(shape, idx, name_span);
            return Expr::place(Place::Field(idx as u16), ty, full);
        }
        if self.shapes[shape as usize].is_class && self.find_method(shape, name).is_some() {
            // `obj.Method` without parentheses: a zero-argument send.
            return self.method_call(obj, name, name_span);
        }
        self.no_member_error(shape, name, name_span, obj.span, "field");
        Expr::error(full)
    }

    fn check_field_visibility(&mut self, shape: u32, idx: usize, span: Span) {
        let f = &self.shapes[shape as usize].fields[idx];
        if !f.private || self.cur().class == Some(f.owner) {
            return;
        }
        let owner = self.shapes[f.owner as usize].name.clone();
        let (fname, fspan) = (f.name.clone(), f.span);
        let mut d = Diagnostic::error("E0307", format!("field `{fname}` of class `{owner}` is private"))
            .primary(span, "private field")
            .secondary(fspan, "declared PRIVATE here");
        d = if self.cur().class.is_some_and(|c| self.is_subclass(c, f.owner)) {
            d.note("PRIVATE members are not visible to subclasses")
                .help(format!("call a PUBLIC method of `{owner}` (for example via `SUPER`) instead"))
        } else {
            d.help(format!("add a PUBLIC method to `{owner}` that reads or updates `{fname}`"))
        };
        self.error(d);
    }

    pub(super) fn no_member_error(&mut self, shape: u32, name: &str, span: Span, obj_span: Span, what: &str) {
        let s = &self.shapes[shape as usize];
        let mut names: Vec<String> = s.fields.iter().map(|f| f.name.clone()).collect();
        if s.is_class {
            names.extend(self.all_method_names(shape));
        }
        let sname = s.name.clone();
        let kind = if s.is_class { "class" } else { "record type" };
        let mut d = Diagnostic::error(
            if what == "field" { "E0305" } else { "E0306" },
            format!("no {what} `{name}` on {kind} `{sname}`"),
        )
        .primary(span, format!("unknown {what}"))
        .secondary(obj_span, format!("this is a `{sname}`"));
        if let Some(m) = best_match(name, names.iter().map(String::as_str)) {
            d = d.suggest(span, m, format!("there is a member with a similar name: `{m}`"));
        } else if !names.is_empty() {
            d = d.note(format!("`{sname}` has: {}", names.join(", ")));
        }
        self.error(d);
    }

    fn index(&mut self, arr: Expr) -> Expr {
        let open = self.tok.span;
        self.advance();
        let mut n = 0usize;
        let mut idx_exprs = Vec::new();
        loop {
            let i = self.expr();
            if !self.convert_top(&Ty::Int, &i.ty, i.span) {
                let d = self.mismatch(&Ty::Int, &i.ty, i.span).note("array indices must be INTEGER");
                self.error(d);
            }
            idx_exprs.push((i.span, i.constant));
            n += 1;
            if !self.eat(Tok::Comma) {
                break;
            }
        }
        self.expect(Tok::RBracket, "to close the array index");
        let full = arr.span.to(self.prev);
        let ty = match &arr.ty {
            Ty::Array(a) => {
                if a.dims.len() != n {
                    let tn = self.ty_name(&arr.ty);
                    self.error(
                        Diagnostic::error(
                            "E0304",
                            format!("wrong number of indices: expected {}, found {n}", a.dims.len()),
                        )
                        .primary(open.to(self.prev), format!("{n} ind{}", if n == 1 { "ex" } else { "ices" }))
                        .secondary(arr.span, format!("this is `{tn}`")),
                    );
                    return Expr::error(full);
                }
                for ((span, c), &(lo, hi)) in idx_exprs.iter().zip(&a.dims) {
                    if let Some(Value::Int(v)) = c
                        && (*v < lo || *v > hi)
                    {
                        self.error(
                            Diagnostic::error("E0304", "array index out of bounds")
                                .primary(*span, format!("index {v} is outside {lo}:{hi}"))
                                .secondary(arr.span, format!("valid indices are {lo} to {hi}")),
                        );
                    }
                }
                a.elem.clone()
            }
            Ty::Unknown => Ty::Unknown,
            Ty::Error => Ty::Error,
            other => {
                let tn = self.ty_name(other);
                let mut d = Diagnostic::error("E0304", format!("cannot index into a value of type `{tn}`"))
                    .primary(open, "indexing needs an ARRAY")
                    .secondary(arr.span, format!("this is `{tn}`"));
                if other.is_text() {
                    d = d.help("use MID(s, start, 1) to read one character of a STRING");
                }
                self.error(d);
                Ty::Error
            }
        };
        let mut e = Expr::place(Place::Index(n as u8), ty, full);
        e.var = None;
        e
    }

    fn literal(&mut self, v: Value, ty: Ty) -> Expr {
        let span = self.tok.span;
        self.advance();
        self.constant(v.clone(), span);
        let mut e = Expr::value(ty, span);
        e.constant = Some(v);
        e
    }

    fn primary(&mut self) -> Expr {
        let span = self.tok.span;
        match self.tok.tok {
            Tok::Int(v) => self.literal(Value::Int(v), Ty::Int),
            Tok::Real(v) => self.literal(Value::Real(v), Ty::Real),
            Tok::Char(c) => self.literal(Value::Char(c), Ty::Char),
            Tok::Date(d) => self.literal(Value::Date(d), Ty::Date),
            Tok::Kw(Kw::True) => self.literal(Value::Bool(true), Ty::Bool),
            Tok::Kw(Kw::False) => self.literal(Value::Bool(false), Ty::Bool),
            Tok::Str => {
                let text = self.text(span);
                let inner: String = {
                    let mut cs = text.chars();
                    cs.next();
                    cs.next_back();
                    cs.collect()
                };
                self.literal(Value::str(&inner), Ty::Str)
            }
            Tok::LParen => {
                self.advance();
                let e = self.expr();
                self.expect(Tok::RParen, "to close the parenthesis");
                Expr { span: span.to(self.prev), ..e }
            }
            Tok::Kw(k @ (Kw::Integer | Kw::Real | Kw::Boolean | Kw::Char | Kw::String | Kw::Date)) => self.cast(k),
            Tok::Kw(k @ (Kw::Div | Kw::Mod)) => {
                self.advance();
                self.expect(Tok::LParen, &format!("after function-style `{}`", k.as_str()));
                let a = self.expr();
                self.expect(Tok::Comma, "between the two operands");
                let b = self.expr();
                self.expect(Tok::RParen, "to close the argument list");
                let op = if k == Kw::Div { BinOp::IntDiv } else { BinOp::Mod };
                let ty = self.emit_binary(op, &a, &b, span);
                Expr::value(ty, span.to(self.prev))
            }
            Tok::Ident => self.ident_expr(),
            Tok::Error => {
                self.advance();
                Expr::error(span)
            }
            Tok::Caret => {
                self.advance();
                let target = self.postfix();
                let full = span.to(target.span);
                match target.place {
                    Some(place) => {
                        if let Some(v) = target.var {
                            self.mark_var(v, true, true);
                        }
                        self.emit_ref(place, full);
                        Expr::value(Ty::Pointer(Rc::new(target.ty)), full)
                    }
                    None => {
                        self.error(
                            Diagnostic::error("E0309", "cannot take the address of a temporary value")
                                .primary(target.span, "this is not a variable")
                                .note("`^X` creates a pointer to the variable X"),
                        );
                        Expr::error(full)
                    }
                }
            }
            Tok::Kw(Kw::New) => self.construct(),
            Tok::Kw(Kw::Super) => self.super_call(),
            _ => {
                let mut d = self.expected_error("an expression", "");
                if let Some(kw) = self.miscased_keyword() {
                    d = d.note(format!("`{}` looks like the keyword `{}`", self.text(span), kw.as_str()));
                }
                self.parse_error(d);
                Expr::error(span)
            }
        }
    }

    fn cast(&mut self, k: Kw) -> Expr {
        let span = self.tok.span;
        self.advance();
        if !self.at(Tok::LParen) {
            self.parse_error(
                Diagnostic::error("E0100", format!("type name `{}` used as a value", k.as_str()))
                    .primary(span, "expected an expression")
                    .help(format!("to convert a value, write `{}(value)`", k.as_str())),
            );
            return Expr::error(span);
        }
        self.advance();
        let e = self.expr();
        self.expect(Tok::RParen, "to close the conversion");
        let full = span.to(self.prev);
        let (to, ty) = match k {
            Kw::Integer => (Conv::Int, Ty::Int),
            Kw::Real => (Conv::Real, Ty::Real),
            Kw::Boolean => (Conv::Bool, Ty::Bool),
            Kw::Char => (Conv::Char, Ty::Char),
            Kw::String => (Conv::Str, Ty::Str),
            _ => (Conv::Date, Ty::Date),
        };
        let ok = e.ty.is_dynamic()
            || matches!(e.ty, Ty::Int | Ty::Real | Ty::Bool | Ty::Char | Ty::Str | Ty::Date | Ty::Enum(_));
        if !ok {
            let n = self.ty_name(&e.ty);
            self.error(
                Diagnostic::error("E0300", format!("cannot convert `{n}` to `{}`", k.as_str()))
                    .primary(e.span, format!("`{n}` has no {} form", k.as_str())),
            );
        }
        self.emit(Op::Convert(to), full);
        Expr::value(ty, full)
    }

    fn ident_expr(&mut self) -> Expr {
        let span = self.tok.span;
        let name = self.text(span).to_string();
        self.advance();
        if self.at(Tok::LParen) {
            return self.call_named(&name, span);
        }

        // Locals, local constants, then fields of SELF, then globals.
        if let Some(v @ VarLoc::Local(slot)) = self.find_local(&name) {
            let l = self.var(v);
            let mut e = Expr::place(Place::Local { slot, byref: l.byref }, l.ty.clone(), span);
            e.var = Some(v);
            return e;
        }
        let f = self.cur();
        if let Some((v, ty, decl)) = f.consts.get(&name).cloned() {
            return self.const_expr(&name, v, ty, decl, span);
        }
        if let Some(class) = f.class {
            if let Some(idx) = self.shapes[class as usize].fields.iter().position(|f| f.name == name) {
                let ty = self.shapes[class as usize].fields[idx].ty.clone();
                self.check_field_visibility(class, idx, span);
                return Expr::place(Place::SelfField(idx as u16), ty, span);
            }
            if self.find_method(class, &name).is_some() {
                return self.call_named(&name, span);
            }
        }
        match self.names.get(&name).cloned() {
            Some(Name::Var(g)) => {
                let mut e = Expr::place(Place::Global(g), self.globals[g as usize].ty.clone(), span);
                e.var = Some(VarLoc::Global(g));
                e
            }
            Some(Name::Const { value, ty, span: decl }) => self.const_expr(&name, value, ty, decl, span),
            Some(Name::Variant { ty, ord, .. }) => {
                let v = Value::Enum { ty, ord };
                self.constant(v.clone(), span);
                let mut e = Expr::value(Ty::Enum(ty), span);
                e.constant = Some(v);
                e
            }
            Some(Name::Func(i)) => {
                let f = &self.funcs[i as usize];
                let what = if f.kind == FnKind::Procedure { "procedure" } else { "function" };
                let decl = f.span;
                let mut d = Diagnostic::error("E0302", format!("{what} `{name}` used without an argument list"))
                    .primary(span, format!("this names a {what}"))
                    .suggest(span.after(), "()", "add parentheses to call it");
                if f.defined {
                    d = d.secondary(decl, format!("{what} defined here"));
                }
                self.error(d);
                Expr::error(span)
            }
            Some(Name::Type { def, .. }) => {
                let mut d = Diagnostic::error("E0302", format!("type `{name}` used as a value"))
                    .primary(span, "this is a type, not a value");
                if matches!(def, TypeName::Class(_)) {
                    d = d.suggest(span, format!("NEW {name}()"), "create an instance of the class with NEW");
                }
                self.error(d);
                Expr::error(span)
            }
            None => {
                if Builtin::lookup(&name).is_some() {
                    self.error(
                        Diagnostic::error("E0302", format!("built-in function `{name}` used without arguments"))
                            .primary(span, "missing argument list")
                            .suggest(span.after(), "()", "call it with parentheses"),
                    );
                    return Expr::error(span);
                }
                self.unresolved_name(&name, span);
                Expr::error(span)
            }
        }
    }

    fn const_expr(&mut self, name: &str, v: Value, ty: Ty, decl: Span, span: Span) -> Expr {
        if self.at(Tok::Arrow) {
            self.error(
                Diagnostic::error("E0202", format!("cannot assign to constant `{name}`"))
                    .primary(span, "constants cannot be changed")
                    .secondary(decl, "declared as a CONSTANT here")
                    .help(format!("declare `{name}` with DECLARE if it needs to change")),
            );
            return Expr::value(Ty::Error, span);
        }
        self.constant(v.clone(), span);
        let mut e = Expr::value(ty, span);
        e.constant = Some(v);
        e
    }

    pub(super) fn unresolved_name(&mut self, name: &str, span: Span) {
        if let Some(kw) = Kw::lookup(&name.to_uppercase()) {
            self.error(
                Diagnostic::error("E0103", format!("`{name}` is not defined; keywords must be upper case"))
                    .primary(span, format!("did you mean the keyword `{}`?", kw.as_str()))
                    .suggest(span, kw.as_str(), "write the keyword in capitals"),
            );
            return;
        }
        let candidates = self.visible_names();
        let mut d =
            Diagnostic::error("E0200", format!("cannot find `{name}` in this scope")).primary(span, "not declared");
        if let Some(m) = best_match(name, candidates.iter().map(String::as_str)) {
            d = d.suggest(span, m, format!("a name with a similar spelling exists: `{m}`"));
        } else {
            d = d.help(format!("declare it first, e.g. `DECLARE {name} : INTEGER`"));
        }
        if self.cur().is_main() {
            d = d.note("variables must be declared before they are used");
        }
        self.error(d);
    }

    /// `Name(args)` — a builtin, user routine, self-send or forward reference.
    pub(super) fn call_named(&mut self, name: &str, span: Span) -> Expr {
        // A variable followed by `(`.
        if let Some(v) = self.lookup_var(name) {
            let ty = self.var(v).ty.clone();
            let tn = self.ty_name(&ty);
            let mut d = Diagnostic::error("E0302", format!("`{name}` is a variable, not a routine"))
                .primary(span, format!("`{name}` has type `{tn}`"));
            if matches!(ty, Ty::Array(_)) {
                d = d.help(format!("use square brackets to index an array: `{name}[...]`"));
            }
            self.error(d);
            self.skip_args();
            return Expr::error(span);
        }

        // SELF method (methods shadow global routines inside a class).
        if let Some(class) = self.cur().class
            && let Some(m) = self.find_method(class, name)
        {
            let func = m.func;
            let params = self.funcs[func as usize].params.clone();
            let (ret, kind) = self.ret_of(func);
            let args = self.call_args(name, Some(&params), func);
            let sym = self.intern(name);
            let site = self.new_site();
            self.emit(Op::SendSelf { sym, argc: args.count as u8, site }, span);
            let mut e = Expr::value(ret, span.to(args.span));
            e.call = Some(if kind == FnKind::Procedure { CallKind::Procedure } else { CallKind::Method });
            return e;
        }

        match self.names.get(name).cloned() {
            Some(Name::Func(i)) if self.funcs[i as usize].defined => {
                let params = self.funcs[i as usize].params.clone();
                let (ret, kind) = self.ret_of(i);
                let args = self.call_args(name, Some(&params), i);
                self.emit(Op::Call { func: i, argc: args.count as u8 }, span);
                let mut e = Expr::value(ret, span.to(args.span));
                e.call = Some(if kind == FnKind::Procedure { CallKind::Procedure } else { CallKind::Function });
                return e;
            }
            Some(Name::Func(i)) => return self.forward_call(i, name, span),
            Some(Name::Type { def: TypeName::Class(_), .. }) => {
                self.skip_args();
                self.error(
                    Diagnostic::error("E0302", format!("`{name}` is a class, not a routine"))
                        .primary(span, "classes are instantiated with NEW")
                        .suggest(Span { start: span.start, end: span.start }, "NEW ", "create an instance"),
                );
                return Expr::error(span);
            }
            Some(_) => {
                self.skip_args();
                self.error(
                    Diagnostic::error("E0302", format!("`{name}` is not a procedure or function"))
                        .primary(span, "cannot be called"),
                );
                return Expr::error(span);
            }
            None => {}
        }

        if let Some(b) = Builtin::lookup(name) {
            return self.builtin_call(b, span);
        }
        if let Some(b) = Builtin::lookup(&name.to_uppercase()) {
            self.skip_args();
            self.error(
                Diagnostic::error("E0200", format!("cannot find function `{name}`"))
                    .primary(span, "not defined")
                    .suggest(span, b.name(), format!("built-in functions are upper case: `{}`", b.name())),
            );
            return Expr::error(span);
        }

        // Not seen yet: compile against a placeholder and check later.
        let i = self.new_fn_slot(name, Span::DUMMY);
        self.names.insert(name.to_string(), Name::Func(i));
        self.forward_call(i, name, span)
    }

    fn ret_of(&self, func: u32) -> (Ty, FnKind) {
        let f = &self.funcs[func as usize];
        let ret = if f.kind == FnKind::Procedure { Ty::Void } else { f.ret.clone() };
        (ret, f.kind)
    }

    fn forward_call(&mut self, func: u32, name: &str, span: Span) -> Expr {
        let args = self.call_args(name, None, func);
        let call_pc = self.emit(Op::Call { func, argc: args.count as u8 }, span);
        let idx = self.pending.len();
        let self_class = self.cur().class;
        let proto = self.cur().proto;
        self.pending.push(PendingCall {
            func,
            name: name.to_string(),
            name_span: span,
            args_span: args.span,
            proto,
            call_pc,
            args: args.deferred,
            as_statement: false,
            self_class,
            resolved: false,
        });
        let mut e = Expr::value(Ty::Unknown, span.to(args.span));
        e.call = Some(CallKind::Pending(idx));
        e
    }

    /// Skip an argument list after an error, stopping at the end of the
    /// line if its parentheses are unbalanced.
    fn skip_args(&mut self) {
        if !self.eat(Tok::LParen) {
            return;
        }
        let mut depth = 1;
        while depth > 0 && !self.at(Tok::Eof) && !self.tok.line_start {
            match self.tok.tok {
                Tok::LParen => depth += 1,
                Tok::RParen => depth -= 1,
                _ => {}
            }
            self.advance();
        }
    }

    /// Compile an argument list. With a known signature arguments are
    /// checked now; otherwise their types and load sites are recorded.
    pub(super) fn call_args(&mut self, name: &str, params: Option<&[Param]>, func: u32) -> Args {
        let start = self.tok.span;
        let mut count = 0;
        let mut deferred = Vec::new();
        if self.eat(Tok::LParen) && !self.eat(Tok::RParen) {
            loop {
                let e = self.expr_desc();
                match params.and_then(|ps| ps.get(count)) {
                    Some(p) if p.byref => match e.place {
                        Some(place) => {
                            if let Some(v) = e.var {
                                self.mark_var(v, true, true);
                            }
                            self.emit_ref(place, e.span);
                            if self.compat(&p.ty, &e.ty) != Compat::Same || self.compat(&e.ty, &p.ty) != Compat::Same {
                                self.byref_type_error(e.span, &e.ty, p);
                            }
                        }
                        None => self.byref_value_error(e.span, p),
                    },
                    Some(p) => {
                        let e = self.discharge(e);
                        match self.compat(&p.ty, &e.ty) {
                            Compat::Incompatible => {
                                let d = self
                                    .mismatch(&p.ty, &e.ty, e.span)
                                    .secondary(p.span, format!("parameter `{}` of `{name}` declared here", p.name));
                                self.error(d);
                            }
                            Compat::Convert(op @ Op::Check(_)) => {
                                self.emit(op, e.span);
                            }
                            // Widening happens in the callee's prologue.
                            _ => {}
                        }
                    }
                    None if params.is_some() => {
                        self.discharge(e);
                    }
                    None => {
                        let (e, patch) = self.discharge_tracked(e);
                        deferred.push(PendingArg { ty: e.ty, span: e.span, patch });
                    }
                }
                count += 1;
                if !self.eat(Tok::Comma) {
                    break;
                }
            }
            self.expect(Tok::RParen, "to close the argument list");
        }
        // With no parentheses nothing was consumed: point just after the name.
        let span = if self.prev.start < start.start { start.after() } else { start.to(self.prev) };
        if let Some(ps) = params
            && ps.len() != count
        {
            let f = &self.funcs[func as usize];
            let (decl, sig) = (f.span, f.proto.signature.clone());
            self.arity_error(name, span, ps.len(), count, decl, &sig);
        }
        Args { count, span, deferred }
    }

    fn builtin_call(&mut self, b: Builtin, span: Span) -> Expr {
        let open = self.tok.span;
        let mut tys = Vec::new();
        self.advance(); // (
        if !self.eat(Tok::RParen) {
            loop {
                let e = self.expr();
                tys.push((e.ty, e.span));
                if !self.eat(Tok::Comma) {
                    break;
                }
            }
            self.expect(Tok::RParen, "to close the argument list");
        }
        let full = span.to(self.prev);
        let params = b.params();
        let sig = {
            let ps: Vec<&str> = params.iter().map(|p| pat_name(*p)).collect();
            format!("{}({}) RETURNS {}", b.name(), ps.join(", "), pat_name(b.ret()))
        };
        if tys.len() != params.len() {
            self.arity_error(b.name(), open.to(self.prev), params.len(), tys.len(), Span::DUMMY, &sig);
        } else {
            for (i, ((ty, aspan), p)) in tys.iter().zip(params).enumerate() {
                if !pat_accepts(*p, ty) {
                    let tn = self.ty_name(ty);
                    let mut d =
                        Diagnostic::error("E0300", format!("argument {} of `{}` has the wrong type", i + 1, b.name()))
                            .primary(*aspan, format!("expected {}, found `{tn}`", pat_name(*p)))
                            .note(format!("{sig}: {}", b.doc()));
                    if *p == P::Str && ty.is_numeric() {
                        let text = self.text(*aspan);
                        d = d.suggest(*aspan, format!("NUM_TO_STR({text})"), "convert the number to a STRING");
                    }
                    self.error(d);
                }
            }
        }
        self.emit(Op::CallBuiltin { builtin: b, argc: tys.len() as u8 }, full);
        let ret = match b.ret() {
            P::Int => Ty::Int,
            P::Real => Ty::Real,
            P::Bool => Ty::Bool,
            P::Char => Ty::Char,
            P::Str => Ty::Str,
            P::Date => Ty::Date,
            P::SameAsArg0 => tys.first().map_or(Ty::Error, |t| t.0.clone()),
            _ => Ty::Unknown,
        };
        let mut e = Expr::value(ret, full);
        e.call = Some(CallKind::Builtin);
        e
    }

    /// `receiver.Name(args)` — a message send through an inline cache.
    fn method_call(&mut self, recv: Expr, name: &str, name_span: Span) -> Expr {
        let site = self.new_site();
        let sym = self.intern(name);
        let mut ret = Ty::Unknown;
        let mut kind = CallKind::Method;
        let mut params: Option<Vec<Param>> = None;
        let mut func = 0;
        match &recv.ty {
            Ty::Class(c) => match self.find_method(*c, name) {
                Some(m) => {
                    func = m.func;
                    let (private, owner) = (m.private, m.owner);
                    if private && self.cur().class != Some(owner) {
                        let oname = self.shapes[owner as usize].name.clone();
                        let decl = self.funcs[func as usize].span;
                        self.error(
                            Diagnostic::error("E0307", format!("method `{name}` of class `{oname}` is private"))
                                .primary(name_span, "private method")
                                .secondary(decl, "declared PRIVATE here")
                                .help("only methods of the same class can call it"),
                        );
                    }
                    params = Some(self.funcs[func as usize].params.clone());
                    let (r, k) = self.ret_of(func);
                    ret = r;
                    if k == FnKind::Procedure {
                        kind = CallKind::Procedure;
                    }
                }
                None if !self.shapes[*c as usize].complete => {
                    self.pending_methods.push(PendingMethodCheck {
                        class: *c,
                        name: name.to_string(),
                        span: name_span,
                    });
                }
                None => {
                    if self.shapes[*c as usize].fields.iter().any(|f| f.name == name) {
                        self.error(
                            Diagnostic::error("E0306", format!("`{name}` is a field, not a method"))
                                .primary(name_span, "cannot be called")
                                .help("remove the parentheses to read the field"),
                        );
                    } else {
                        self.no_member_error(*c, name, name_span, recv.span, "method");
                    }
                    ret = Ty::Error;
                }
            },
            Ty::Unknown | Ty::Error => {}
            other => {
                let tn = self.ty_name(other);
                let mut d = Diagnostic::error("E0306", format!("`{tn}` values have no methods"))
                    .primary(name_span, format!("no method `{name}`"))
                    .secondary(recv.span, format!("this is `{tn}`"));
                if let Some(b) = Builtin::lookup(&name.to_uppercase()) {
                    let text = self.text(recv.span);
                    d = d.suggest(
                        recv.span.to(name_span),
                        format!("{}({text}", b.name()),
                        "use the built-in function instead",
                    );
                }
                self.error(d);
                ret = Ty::Error;
            }
        }
        let args = self.call_args(name, params.as_deref(), func);
        self.emit(Op::Send { sym, argc: args.count as u8, site }, name_span);
        let mut e = Expr::value(ret, recv.span.to(args.span));
        e.call = Some(kind);
        e
    }

    /// `NEW ClassName(args)`
    fn construct(&mut self) -> Expr {
        let new_span = self.tok.span;
        self.advance();
        let Some((name, span)) = self.expect_ident("after `NEW`") else {
            return Expr::error(new_span);
        };
        let class = match self.names.get(&name) {
            Some(Name::Type { def: TypeName::Class(c), .. }) => *c,
            Some(Name::Type { .. }) => {
                self.skip_args();
                self.error(
                    Diagnostic::error("E0400", format!("`{name}` is not a class"))
                        .primary(span, "NEW can only create class instances")
                        .help("records are created by DECLARE-ing a variable of the record type"),
                );
                return Expr::error(new_span.to(span));
            }
            _ => {
                self.skip_args();
                let classes: Vec<String> = self.shapes.iter().filter(|s| s.is_class).map(|s| s.name.clone()).collect();
                let mut d =
                    Diagnostic::error("E0200", format!("cannot find class `{name}`")).primary(span, "no such class");
                if let Some(m) = best_match(&name, classes.iter().map(String::as_str)) {
                    d = d.suggest(span, m, "a class with a similar name exists");
                } else {
                    d = d.note("classes must be defined before they are instantiated");
                }
                self.error(d);
                return Expr::error(new_span.to(span));
            }
        };
        let (ctor, params) = match self.find_method(class, "NEW") {
            Some(m) => (m.func, Some(self.funcs[m.func as usize].params.clone())),
            None => (u32::MAX, Some(Vec::new())),
        };
        let fidx = if ctor == u32::MAX { 0 } else { ctor };
        let args = if ctor == u32::MAX && self.at(Tok::LParen) {
            // No constructor: only `NEW C()` is valid.
            let a = self.call_args(&name, None, 0);
            if a.count > 0 {
                let cname = self.shapes[class as usize].name.clone();
                self.error(
                    Diagnostic::error("E0301", format!("class `{cname}` has no constructor taking arguments"))
                        .primary(a.span, format!("{} argument(s) supplied", a.count))
                        .help(format!("define `PUBLIC PROCEDURE NEW(...)` in `{cname}`")),
                );
            }
            a
        } else {
            self.call_args(&name, params.as_deref(), fidx)
        };
        self.emit(Op::Construct { class, ctor, argc: args.count as u8 }, new_span.to(span));
        Expr::value(Ty::Class(class), new_span.to(args.span))
    }

    /// `SUPER.Name(args)` — a statically bound send to the superclass.
    fn super_call(&mut self) -> Expr {
        let span = self.tok.span;
        self.advance();
        let parent = match self.cur().class {
            Some(c) => self.shapes[c as usize].parent,
            None => None,
        };
        self.expect(Tok::Dot, "after `SUPER`");
        let Some((name, name_span)) = self.member_name() else {
            return Expr::error(span);
        };
        let Some(parent) = parent else {
            let msg = if self.cur().class.is_some() {
                "`SUPER` used in a class without a superclass"
            } else {
                "`SUPER` used outside of a class"
            };
            self.skip_args();
            self.error(
                Diagnostic::error("E0400", msg)
                    .primary(span, "no superclass here")
                    .help("declare a superclass with `CLASS Child INHERITS Parent`"),
            );
            return Expr::error(span);
        };
        let Some(m) = self.find_method(parent, &name) else {
            self.skip_args();
            self.no_member_error(parent, &name, name_span, span, "method");
            return Expr::error(span.to(name_span));
        };
        let func = m.func;
        let params = self.funcs[func as usize].params.clone();
        let (ret, kind) = self.ret_of(func);
        self.emit(Op::LoadSelf, span);
        let args = self.call_args(&name, Some(&params), func);
        self.emit(Op::Call { func, argc: args.count as u8 + 1 }, span.to(name_span));
        let mut e = Expr::value(ret, span.to(args.span));
        e.call = Some(if kind == FnKind::Procedure { CallKind::Procedure } else { CallKind::Method });
        e
    }
}

fn pat_accepts(p: P, ty: &Ty) -> bool {
    if ty.is_dynamic() {
        return true;
    }
    match p {
        P::Int => *ty == Ty::Int,
        P::Real | P::Num => ty.is_numeric(),
        P::Bool => *ty == Ty::Bool,
        P::Char => *ty == Ty::Char,
        P::Str | P::Text => ty.is_text(),
        P::Date => *ty == Ty::Date,
        P::SameAsArg0 | P::Dynamic => true,
    }
}

fn pat_name(p: P) -> &'static str {
    match p {
        P::Int => "INTEGER",
        P::Real => "REAL",
        P::Num => "INTEGER or REAL",
        P::Bool => "BOOLEAN",
        P::Char => "CHAR",
        P::Str => "STRING",
        P::Text => "STRING or CHAR",
        P::Date => "DATE",
        P::SameAsArg0 => "same type as argument",
        P::Dynamic => "INTEGER or REAL",
    }
}
