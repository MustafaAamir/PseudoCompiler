//! Declarations: variables, constants, types, routines and classes.

use super::*;
use crate::bytecode::Conv;

impl Compiler<'_> {
    /// `A, B, C` — stops at the first missing identifier.
    fn ident_list(&mut self, context: &str) -> Vec<(String, Span)> {
        let mut names = Vec::new();
        while let Some(n) = self.expect_ident(context) {
            names.push(n);
            if !self.eat(Tok::Comma) {
                break;
            }
        }
        names
    }

    /// `A, B : Type`, as used for record and class fields.
    fn typed_names(&mut self, context: &str) -> (Vec<(String, Span)>, Ty) {
        let names = self.ident_list(context);
        if names.is_empty() {
            return (names, Ty::Error);
        }
        self.expect(Tok::Colon, "after the field name");
        (names, self.type_spec())
    }

    pub(super) fn declare_stmt(&mut self) {
        let span = self.tok.span;
        self.advance();
        let names = self.ident_list("in DECLARE");
        if names.is_empty() {
            return;
        }
        if !self.at(Tok::Colon) && self.at_type_start() {
            let at = self.prev.after();
            self.error(
                Diagnostic::error("E0100", "expected `:` between the variable name and its type")
                    .primary(at, "missing `:`")
                    .suggest(at, " :", "add a colon"),
            );
        } else if !self.expect(Tok::Colon, "after the variable name") {
            return;
        }
        let ty = self.type_spec();
        for (name, nspan) in names {
            let v = self.declare_var(&name, ty.clone(), nspan);
            if let Some(init) = self.init_for(&ty) {
                self.emit(Op::Init(init), span);
                self.store_var(v, span);
            }
        }
    }

    fn at_type_start(&self) -> bool {
        matches!(
            self.tok.tok,
            Tok::Kw(Kw::Integer | Kw::Real | Kw::Boolean | Kw::Char | Kw::String | Kw::Date | Kw::Array)
        )
    }

    /// `INTEGER`, `ARRAY[1:10, 1:3] OF REAL`, `^Node`, or a declared type name.
    pub(super) fn type_spec(&mut self) -> Ty {
        let span = self.tok.span;
        let ty = match self.tok.tok {
            Tok::Kw(Kw::Integer) => Ty::Int,
            Tok::Kw(Kw::Real) => Ty::Real,
            Tok::Kw(Kw::Boolean) => Ty::Bool,
            Tok::Kw(Kw::Char) => Ty::Char,
            Tok::Kw(Kw::String) => Ty::Str,
            Tok::Kw(Kw::Date) => Ty::Date,
            Tok::Kw(Kw::Array) => {
                self.advance();
                return self.array_spec();
            }
            Tok::Caret => {
                self.advance();
                return Ty::Pointer(Rc::new(self.type_spec()));
            }
            Tok::Ident => match self.names.get(self.text(span)) {
                Some(Name::Type { def: TypeName::Record(s), .. }) => Ty::Record(*s),
                Some(Name::Type { def: TypeName::Class(s), .. }) => Ty::Class(*s),
                Some(Name::Type { def: TypeName::Enum(e), .. }) => Ty::Enum(*e),
                Some(Name::Type { def: TypeName::Alias(t), .. }) => t.clone(),
                _ => {
                    self.unknown_type(self.text(span), span);
                    Ty::Error
                }
            },
            _ => {
                let d = self.expected_error("a type", "").help(
                    "types are INTEGER, REAL, BOOLEAN, CHAR, STRING, DATE, ARRAY[..] OF <type>, or a declared TYPE/CLASS",
                );
                self.parse_error(d);
                return Ty::Error;
            }
        };
        self.advance();
        ty
    }

    /// `[1:10, 1:3] OF REAL`, after `ARRAY`.
    fn array_spec(&mut self) -> Ty {
        self.expect(Tok::LBracket, "after ARRAY");
        let mut dims = Vec::new();
        loop {
            let lo_span = self.tok.span;
            let lo = self.const_int();
            self.expect(Tok::Colon, "between the lower and upper bound");
            let hi = self.const_int();
            if hi < lo {
                self.error(
                    Diagnostic::error("E0304", "array upper bound is below its lower bound")
                        .primary(lo_span.to(self.prev), format!("{lo}:{hi} contains no elements"))
                        .help(format!("did you mean {hi}:{lo}?")),
                );
            }
            dims.push((lo, hi.max(lo)));
            if !self.eat(Tok::Comma) {
                break;
            }
        }
        self.expect(Tok::RBracket, "to close the array bounds");
        self.expect_kw(Kw::Of, "after the array bounds");
        let elem = self.type_spec();
        Ty::Array(Rc::new(ArrayTy { dims, elem }))
    }

    fn unknown_type(&mut self, name: &str, span: Span) {
        if let Some(kw) = Kw::lookup(&name.to_uppercase()) {
            self.error(
                Diagnostic::error("E0103", format!("unknown type `{name}`; type names are upper case"))
                    .primary(span, "not a type")
                    .suggest(span, kw.as_str(), "write the type in capitals"),
            );
            return;
        }
        let mut types: Vec<String> =
            self.names.iter().filter(|(_, n)| matches!(n, Name::Type { .. })).map(|(k, _)| k.clone()).collect();
        types.extend(["INTEGER", "REAL", "BOOLEAN", "CHAR", "STRING", "DATE"].map(String::from));
        let mut d = Diagnostic::error("E0203", format!("cannot find type `{name}`")).primary(span, "unknown type");
        d = match best_match(name, types.iter().map(String::as_str)) {
            Some(m) => d.suggest(span, m, format!("a type with a similar name exists: `{m}`")),
            None => d.note("user-defined types must be declared with TYPE or CLASS before they are used"),
        };
        if matches!(name, "INT" | "FLOAT" | "DOUBLE" | "BOOL" | "STR") {
            let sug = match name {
                "INT" => "INTEGER",
                "BOOL" => "BOOLEAN",
                "STR" => "STRING",
                _ => "REAL",
            };
            d = d.suggest(span, sug, format!("pseudocode spells this type `{sug}`"));
        }
        self.error(d);
    }

    /// A compile-time INTEGER: a literal, a negated literal, or a CONSTANT.
    fn const_int(&mut self) -> i64 {
        let neg = self.eat(Tok::Minus);
        let span = self.tok.span;
        let value = match self.tok.tok {
            Tok::Int(v) => Some(v),
            Tok::Ident => {
                let name = self.text(span);
                match self.cur().consts.get(name).map(|c| &c.0).or(match self.names.get(name) {
                    Some(Name::Const { value, .. }) => Some(value),
                    _ => None,
                }) {
                    Some(Value::Int(v)) => Some(*v),
                    _ => None,
                }
            }
            _ => None,
        };
        let Some(v) = value else {
            self.error(
                Diagnostic::error("E0304", "array bounds must be constant INTEGERs")
                    .primary(span, "not a constant integer")
                    .help("use an integer literal or a name declared with CONSTANT"),
            );
            return 0;
        };
        self.advance();
        if neg { -v } else { v }
    }

    pub(super) fn constant_stmt(&mut self) {
        self.advance();
        let Some((name, span)) = self.expect_ident("after CONSTANT") else {
            return;
        };
        if !self.eat(Tok::Eq) && !self.eat(Tok::Arrow) {
            let d = self.expected_error("`=` or `←`", "after the constant name");
            self.parse_error(d);
            return;
        }
        let neg = self.eat(Tok::Minus);
        let vspan = self.tok.span;
        let (value, ty) = match self.tok.tok {
            Tok::Int(v) => (Value::Int(if neg { -v } else { v }), Ty::Int),
            Tok::Real(v) => (Value::Real(if neg { -v } else { v }), Ty::Real),
            Tok::Char(c) if !neg => (Value::Char(c), Ty::Char),
            Tok::Date(d) if !neg => (Value::Date(d), Ty::Date),
            Tok::Kw(Kw::True) if !neg => (Value::Bool(true), Ty::Bool),
            Tok::Kw(Kw::False) if !neg => (Value::Bool(false), Ty::Bool),
            Tok::Str if !neg => {
                let t = self.text(vspan);
                (Value::str(&t[1..t.len() - 1]), Ty::Str)
            }
            _ => {
                let d = self
                    .expected_error("a literal value", "for the constant")
                    .note("a CONSTANT must be given a literal such as 10, 3.5, \"text\", 'c' or TRUE");
                self.parse_error(d);
                return;
            }
        };
        self.advance();
        if let Some(first) = self.existing_decl(&name) {
            self.duplicate_error(&name, span, first);
        }
        if self.cur().is_main() {
            self.names.insert(name, Name::Const { value, ty, span });
        } else {
            self.cur_mut().consts.insert(name, (value, ty, span));
        }
    }

    /// `TYPE T = (A, B)`, `TYPE P = ^INTEGER`, or a record `TYPE T ... ENDTYPE`.
    pub(super) fn type_stmt(&mut self) {
        let type_span = self.tok.span;
        self.advance();
        let Some((name, span)) = self.expect_ident("after TYPE") else {
            return;
        };
        if let Some(first) = self.existing_decl_global(&name) {
            self.duplicate_error(&name, span, first);
        }
        if self.eat(Tok::Eq) {
            if self.eat(Tok::LParen) {
                let id = self.enums.len() as u32;
                let mut variants = Vec::new();
                loop {
                    let Some((v, vspan)) = self.expect_ident("in the enumeration") else {
                        return;
                    };
                    if let Some(first) = self.existing_decl_global(&v) {
                        self.duplicate_error(&v, vspan, first);
                    }
                    self.names.insert(v.clone(), Name::Variant { ty: id, ord: variants.len() as u32, span: vspan });
                    variants.push(v);
                    if !self.eat(Tok::Comma) {
                        break;
                    }
                }
                self.expect(Tok::RParen, "to close the enumeration");
                self.enums.push(EnumInfo { name: name.clone(), variants });
                self.names.insert(name, Name::Type { def: TypeName::Enum(id), span });
            } else {
                let t = self.type_spec();
                self.names.insert(name, Name::Type { def: TypeName::Alias(t), span });
            }
            return;
        }

        // Record type. Registered first so fields may point to it (`^Node`).
        self.open_block(Kw::EndType);
        let id = self.new_shape(name, span, false, None);
        loop {
            if self.at_kw(Kw::EndType) || self.at(Tok::Eof) || matches!(self.tok.tok, Tok::Kw(k) if k.is_block_end()) {
                break;
            }
            if !self.eat_kw(Kw::Declare) {
                let d = self
                    .expected_error("`DECLARE`", "inside a record TYPE")
                    .help("record fields are written `DECLARE Name : Type`");
                self.parse_error(d);
                self.synchronize();
                if !self.at_kw(Kw::Declare) {
                    break;
                }
                continue;
            }
            let (names, ty) = self.typed_names("in DECLARE");
            for (fname, fspan) in names {
                self.add_field(id, fname, ty.clone(), false, fspan);
            }
            if self.panic {
                self.synchronize();
            }
        }
        self.close_block(Kw::EndType, "TYPE", type_span);
        self.shapes[id as usize].complete = true;
    }

    /// Register a record type or class; a class inherits its parent's field layout.
    fn new_shape(&mut self, name: String, span: Span, is_class: bool, parent: Option<u32>) -> u32 {
        let id = self.shapes.len() as u32;
        let fields = parent.map_or_else(Vec::new, |p| self.shapes[p as usize].fields.clone());
        let def = if is_class { TypeName::Class(id) } else { TypeName::Record(id) };
        self.names.insert(name.clone(), Name::Type { def, span });
        let shape = ShapeDef { name, span, is_class, parent, fields, methods: HashMap::new(), complete: false };
        self.shapes.push(shape);
        id
    }

    fn add_field(&mut self, shape: u32, name: String, ty: Ty, private: bool, span: Span) {
        if let Some(prev) = self.shapes[shape as usize].fields.iter().find(|f| f.name == name) {
            let (pspan, owner) = (prev.span, prev.owner);
            let mut d = Diagnostic::error("E0201", format!("field `{name}` is declared more than once"))
                .primary(span, "redeclared here")
                .secondary(pspan, "first declared here");
            if owner != shape {
                d = d.note(format!("`{name}` is inherited from `{}`", self.shapes[owner as usize].name));
            }
            self.error(d);
            return;
        }
        self.intern(&name);
        self.shapes[shape as usize].fields.push(FieldDef { name, ty, private, owner: shape, span });
    }

    /// `PROCEDURE`/`FUNCTION` definition. `class` is `(class, private)` for methods.
    pub(super) fn routine_def(&mut self, class: Option<(u32, bool)>) {
        let kw_span = self.tok.span;
        let is_fn = self.at_kw(Kw::Function);
        let (kw, end_kw) = if is_fn { ("FUNCTION", Kw::EndFunction) } else { ("PROCEDURE", Kw::EndProcedure) };
        self.advance();
        if self.fs.len() > 1 {
            let outer = self.cur().func.map(|f| self.funcs[f as usize].span).unwrap_or(Span::DUMMY);
            self.error(
                Diagnostic::error("E0100", format!("a {kw} cannot be defined inside another routine"))
                    .primary(kw_span, "nested definition")
                    .secondary(outer, "inside this routine")
                    .help("move the definition to the top level of the file"),
            );
        }
        let (name, name_span) = if class.is_some() && self.at_kw(Kw::New) {
            let s = self.tok.span;
            self.advance();
            ("NEW".to_string(), s)
        } else {
            match self.expect_ident(&format!("after {kw}")) {
                Some(n) => n,
                None => return,
            }
        };

        let mut params: Vec<Param> = Vec::new();
        if self.eat(Tok::LParen) && !self.eat(Tok::RParen) {
            let mut byref = false;
            loop {
                if self.eat_kw(Kw::ByRef) {
                    byref = true;
                } else if self.eat_kw(Kw::ByVal) {
                    byref = false;
                }
                let Some((pname, pspan)) = self.expect_ident("for the parameter name") else {
                    break;
                };
                if let Some(prev) = params.iter().find(|p| p.name == pname) {
                    let first = prev.span;
                    self.duplicate_error(&pname, pspan, first);
                }
                self.expect(Tok::Colon, "after the parameter name");
                let ty = self.type_spec();
                params.push(Param { name: pname, ty, byref, span: pspan });
                if !self.eat(Tok::Comma) {
                    break;
                }
            }
            self.expect(Tok::RParen, "to close the parameter list");
        }

        let (ret, ret_span) = if is_fn {
            if self.expect_kw(Kw::Returns, "after the FUNCTION parameters") {
                let s = self.tok.span;
                let t = self.type_spec();
                (t, s.to(self.prev))
            } else {
                (Ty::Error, name_span)
            }
        } else {
            if self.at_kw(Kw::Returns) {
                self.error(
                    Diagnostic::error("E0206", "a PROCEDURE cannot have a return type")
                        .primary(self.tok.span, "RETURNS is only for FUNCTIONs")
                        .suggest(kw_span, "FUNCTION", "declare it as a FUNCTION"),
                );
                self.advance();
                self.type_spec();
            }
            (Ty::Void, name_span)
        };

        self.open_block(end_kw);
        let kind = if is_fn { FnKind::Function } else { FnKind::Procedure };
        let func = self.register_routine(&name, name_span, class, kind, &params, &ret);
        let (pkind, display) = match class {
            Some((c, _)) => (ProtoKind::Method { class: c }, format!("{}.{name}", self.shapes[c as usize].name)),
            None if is_fn => (ProtoKind::Function, name.clone()),
            None => (ProtoKind::Procedure, name.clone()),
        };
        let mut proto = Proto::new(display, pkind, name_span);
        proto.arity = params.len() as u16 + u16::from(class.is_some());
        proto.signature = self.signature(kw, class.map(|c| c.0), &name, &params, &ret);
        let entry = FnEntry { kind, params: params.clone(), ret: ret.clone(), proto, defined: true, span: name_span };
        self.funcs[func as usize] = entry;

        self.fs.push(FnState {
            proto: ProtoRef::Func(func),
            func: Some(func),
            locals: Vec::new(),
            consts: HashMap::new(),
            loops: Vec::new(),
            ret: is_fn.then(|| (ret.clone(), ret_span)),
            class: class.map(|c| c.0),
            saw_return: false,
        });
        if let Some((c, _)) = class {
            self.push_local("SELF", Ty::Class(c), kw_span, true, false, true);
        }
        for p in &params {
            let v = self.push_local(&p.name, p.ty.clone(), p.span, true, p.byref, false);
            let VarLoc::Local(slot) = v else { unreachable!() };
            if !p.byref && matches!(p.ty.conv(), Conv::Real | Conv::Str) {
                self.emit(Op::Coerce { slot, to: p.ty.conv() }, p.span);
            }
        }

        let diverges = self.block(false);
        let end_span = self.tok.span;
        if matches!(self.tok.tok, Tok::Kw(Kw::EndFunction | Kw::EndProcedure)) && !self.at_kw(end_kw) {
            self.error(
                Diagnostic::error("E0102", format!("a {kw} must end with `{}`", end_kw.as_str()))
                    .primary(end_span, format!("expected `{}`", end_kw.as_str()))
                    .secondary(kw_span, format!("{kw} starts here"))
                    .suggest(end_span, end_kw.as_str(), "use the matching terminator"),
            );
            self.advance();
            self.open_blocks.pop();
        } else {
            self.close_block(end_kw, kw, kw_span);
        }

        let saw_return = self.cur().saw_return;
        if is_fn && !diverges {
            if !saw_return {
                let tn = self.ty_name(&ret);
                self.error(
                    Diagnostic::error("E0207", format!("FUNCTION `{name}` never returns a value"))
                        .primary(name_span, format!("declared to return `{tn}`"))
                        .secondary(end_span, "reaches the end without a RETURN")
                        .help(format!("add `RETURN <{tn} value>` before {}", end_kw.as_str())),
                );
            } else {
                self.error(
                    Diagnostic::warning(
                        "W0007",
                        format!("FUNCTION `{name}` may reach `ENDFUNCTION` without returning"),
                    )
                    .primary(end_span, "control can fall through to here")
                    .secondary(name_span, "in this function")
                    .note("if that happens the program stops with a run-time error"),
                );
            }
            self.emit(Op::MissingReturn, end_span);
        } else if !is_fn {
            self.emit(Op::ReturnVoid, end_span);
        }

        let f = self.fs.pop().unwrap();
        let locals = self.local_infos(&f);
        let p = &mut self.funcs[func as usize].proto;
        p.num_slots = f.locals.len() as u16;
        p.locals = locals;
        self.warn_unused(&f.locals);
    }

    fn signature(&self, kw: &str, class: Option<u32>, name: &str, params: &[Param], ret: &Ty) -> String {
        let ps: Vec<String> = params
            .iter()
            .map(|p| format!("{}{} : {}", if p.byref { "BYREF " } else { "" }, p.name, self.ty_name(&p.ty)))
            .collect();
        let owner = class.map(|c| format!("{}.", self.shapes[c as usize].name)).unwrap_or_default();
        let ret = if *ret == Ty::Void { String::new() } else { format!(" RETURNS {}", self.ty_name(ret)) };
        format!("{kw} {owner}{name}({}){ret}", ps.join(", "))
    }

    /// Allocate (or reuse a forward-declared) function slot for a definition.
    fn register_routine(
        &mut self,
        name: &str,
        span: Span,
        class: Option<(u32, bool)>,
        kind: FnKind,
        params: &[Param],
        ret: &Ty,
    ) -> u32 {
        let Some((c, private)) = class else {
            if let Some(Name::Func(i)) = self.names.get(name)
                && !self.funcs[*i as usize].defined
            {
                return *i;
            }
            if let Some(first) = self.existing_decl_global(name) {
                self.duplicate_error(name, span, first);
            } else if let Some(b) = Builtin::lookup(name) {
                self.error(
                    Diagnostic::warning("W0004", format!("`{name}` shadows the built-in function `{}`", b.name()))
                        .primary(span, "this definition replaces the built-in")
                        .note(format!("built-in: {}", b.doc())),
                );
            }
            let f = self.new_fn_slot(name, span);
            self.names.insert(name.to_string(), Name::Func(f));
            return f;
        };
        if let Some(prev) = self.shapes[c as usize].methods.get(name) {
            let first = self.funcs[prev.func as usize].span;
            self.duplicate_error(name, span, first);
        }
        if let Some(parent) = self.shapes[c as usize].parent
            && let Some(m) = self.find_method(parent, name)
        {
            let pf = &self.funcs[m.func as usize];
            let same = pf.kind == kind
                && pf.ret == *ret
                && pf.params.len() == params.len()
                && pf.params.iter().zip(params).all(|(a, b)| a.ty == b.ty && a.byref == b.byref);
            if !same && name != "NEW" {
                let (psig, pspan) = (pf.proto.signature.clone(), pf.span);
                self.error(
                    Diagnostic::error(
                        "E0400",
                        format!("method `{name}` overrides an inherited method with a different signature"),
                    )
                    .primary(span, "incompatible override")
                    .secondary(pspan, "overridden method declared here")
                    .note(format!("expected: {psig}"))
                    .help("an override must take the same parameters and return the same type"),
                );
            }
        }
        let f = self.new_fn_slot(name, span);
        self.shapes[c as usize].methods.insert(name.to_string(), MethodDef { func: f, private, owner: c });
        self.intern(name);
        f
    }

    pub(super) fn class_def(&mut self) {
        let class_span = self.tok.span;
        self.advance();
        let Some((name, name_span)) = self.expect_ident("after CLASS") else {
            return;
        };
        if self.fs.len() > 1 {
            self.error(
                Diagnostic::error("E0100", "a CLASS cannot be defined inside a routine")
                    .primary(class_span, "nested class definition"),
            );
        }
        let parent = if self.eat_kw(Kw::Inherits) {
            self.expect_ident("after INHERITS").and_then(|(pname, pspan)| self.lookup_parent(&pname, pspan))
        } else {
            None
        };
        if let Some(first) = self.existing_decl_global(&name) {
            self.duplicate_error(&name, name_span, first);
        }

        let id = self.new_shape(name, name_span, true, parent);
        self.open_block(Kw::EndClass);

        loop {
            let start = self.tok.span;
            let bare_field = self.at(Tok::Ident) && self.peek().tok == Tok::Colon;
            match self.tok.tok {
                Tok::Eof | Tok::Kw(Kw::EndClass) => break,
                Tok::Kw(k) if k.is_block_end() => break,
                Tok::Kw(Kw::Public | Kw::Private) => {
                    let private = self.at_kw(Kw::Private);
                    self.advance();
                    if matches!(self.tok.tok, Tok::Kw(Kw::Procedure | Kw::Function)) {
                        self.routine_def(Some((id, private)));
                    } else {
                        self.field_decl(id, private);
                    }
                }
                Tok::Kw(Kw::Procedure | Kw::Function) => self.routine_def(Some((id, false))),
                Tok::Kw(Kw::Declare) => {
                    self.error(
                        Diagnostic::error("E0100", "class fields are declared with PUBLIC or PRIVATE")
                            .primary(start, "DECLARE is not used inside a CLASS")
                            .suggest(start, "PRIVATE", "declare a private field"),
                    );
                    self.advance();
                    self.field_decl(id, true);
                }
                Tok::Ident if bare_field => {
                    self.error(
                        Diagnostic::error("E0100", "class field without an access modifier")
                            .primary(start, "missing PUBLIC or PRIVATE")
                            .suggest(
                                Span::new(start.start as usize, start.start as usize),
                                "PRIVATE ",
                                "make the field private",
                            )
                            .note("every class member must be marked PUBLIC or PRIVATE"),
                    );
                    self.field_decl(id, true);
                }
                _ => {
                    let d = self
                        .expected_error("a class member", "")
                        .help("class bodies contain `PUBLIC`/`PRIVATE` fields, PROCEDUREs and FUNCTIONs");
                    self.parse_error(d);
                }
            }
            if self.panic {
                self.synchronize();
                while matches!(self.tok.tok, Tok::Kw(k) if k.is_block_end() && k != Kw::EndClass) {
                    self.advance();
                }
            }
            if self.tok.span == start && !self.at(Tok::Eof) {
                self.advance();
            }
        }
        self.close_block(Kw::EndClass, "CLASS", class_span);
        self.shapes[id as usize].complete = true;
        self.resolve_class_pending(id);
    }

    fn lookup_parent(&mut self, pname: &str, pspan: Span) -> Option<u32> {
        match self.names.get(pname) {
            Some(Name::Type { def: TypeName::Class(p), .. }) => Some(*p),
            Some(Name::Type { .. }) => {
                self.error(
                    Diagnostic::error("E0400", format!("`{pname}` is not a class"))
                        .primary(pspan, "only classes can be inherited from"),
                );
                None
            }
            _ => {
                let classes: Vec<String> = self.shapes.iter().filter(|s| s.is_class).map(|s| s.name.clone()).collect();
                let mut d = Diagnostic::error("E0400", format!("cannot find superclass `{pname}`"))
                    .primary(pspan, "not a known class");
                d = match best_match(pname, classes.iter().map(String::as_str)) {
                    Some(m) => d.suggest(pspan, m, "a class with a similar name exists"),
                    None => d.note("a superclass must be defined before the classes that inherit from it"),
                };
                self.error(d);
                None
            }
        }
    }

    fn field_decl(&mut self, class: u32, private: bool) {
        let (names, ty) = self.typed_names("for the field name");
        for (n, s) in names {
            self.add_field(class, n, ty.clone(), private, s);
        }
    }

    /// At `ENDCLASS`: calls inside the class body to names that were not yet
    /// known may be sends to `self`; patch them now.
    fn resolve_class_pending(&mut self, class: u32) {
        let mut pending = std::mem::take(&mut self.pending);
        for call in pending.iter_mut().filter(|c| !c.resolved && c.self_class == Some(class)) {
            let Some(m) = self.find_method(class, &call.name) else {
                continue;
            };
            let func = m.func;
            let f = &self.funcs[func as usize];
            let (params, decl, sig, kind) = (f.params.clone(), f.span, f.proto.signature.clone(), f.kind);
            let sym = self.intern(&call.name);
            let site = self.new_site();
            self.proto_of(call.proto).code[call.call_pc] = Op::SendSelf { sym, argc: call.args.len() as u8, site };
            self.check_deferred_args(call, &params, decl, &sig);
            if kind == FnKind::Procedure && !call.as_statement {
                self.error(
                    Diagnostic::error("E0302", format!("procedure `{}` does not return a value", call.name))
                        .primary(call.name_span, "used as a value here")
                        .secondary(decl, "declared as a PROCEDURE here"),
                );
            }
            call.resolved = true;
        }
        self.pending = pending;

        let checks = std::mem::take(&mut self.pending_methods);
        let (now, later): (Vec<_>, Vec<_>) = checks.into_iter().partition(|c| c.class == class);
        self.pending_methods = later;
        for c in now {
            if self.find_method(class, &c.name).is_none() {
                let span = self.shapes[class as usize].span;
                self.no_member_error(class, &c.name, c.span, span, "method");
            }
        }
    }
}
