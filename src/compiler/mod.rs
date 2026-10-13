//! A single-pass compiler: tokens are pulled lazily from the lexer, parsed
//! by recursive descent and turned straight into bytecode while being type
//! checked. There is no token list and no AST.
//!
//! The key technique (borrowed from Lua's `expdesc`) is that an expression
//! is compiled into an [`expr::Expr`] *descriptor* whose final load is
//! deferred. The same parse of `A[I].Name` can therefore become a load,
//! a store target, or a reference for a `BYREF` argument, depending on
//! what follows it — without building a tree.
//!
//! Forward references (calls to functions defined later) are compiled
//! against a placeholder and recorded. When the whole file has been seen
//! they are checked against the real signature, and argument loads are
//! patched in place into reference-producing instructions where the
//! parameter turns out to be `BYREF`.

mod decl;
mod expr;
mod stmt;
pub mod types;

use crate::builtins::Builtin;
use crate::bytecode::{
    EnumInfo, FieldMeta, GlobalInfo, Init, LocalInfo, MethodMeta, Op, Program, Proto, ProtoKind,
    Shape, VarLoc,
};
use crate::diag::{Diagnostic, Diagnostics, best_match};
use crate::lexer::{Kw, Lexer, Tok, Token};
use crate::source::{Source, Span};
use crate::value::Value;
use std::collections::HashMap;
use std::rc::Rc;
use types::{ArrayTy, Compat, Ty};

/// Compile a source file. Returns the program if there were no errors;
/// diagnostics (including warnings) are returned either way.
pub fn compile(src: &Source) -> (Option<Program>, Diagnostics) {
    let mut c = Compiler::new(src);
    c.program();
    c.finish()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProtoRef {
    Main,
    Func(u32),
}

#[derive(Clone, Debug)]
struct Param {
    name: String,
    ty: Ty,
    byref: bool,
    span: Span,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FnKind {
    Function,
    Procedure,
}

struct FnEntry {
    kind: FnKind,
    params: Vec<Param>,
    ret: Ty,
    proto: Proto,
    defined: bool,
    span: Span,
    class: Option<u32>,
}

struct GlobalVar {
    name: String,
    ty: Ty,
    span: Span,
    used: bool,
    assigned: bool,
    hidden: bool,
}

struct Local {
    name: String,
    ty: Ty,
    slot: u16,
    span: Span,
    used: bool,
    assigned: bool,
    byref: bool,
    param: bool,
    hidden: bool,
}

#[derive(Clone, Debug)]
enum TypeName {
    Record(u32),
    Class(u32),
    Enum(u32),
    Alias(Ty),
}

/// Top-level namespace entries.
#[derive(Clone, Debug)]
enum Name {
    Var(u32),
    Const { value: Value, ty: Ty, span: Span },
    Func(u32),
    Type { def: TypeName, span: Span },
    Variant { ty: u32, ord: u32, span: Span },
}

struct FieldDef {
    name: String,
    ty: Ty,
    private: bool,
    owner: u32,
    span: Span,
}

struct MethodDef {
    func: u32,
    private: bool,
    owner: u32,
}

struct ShapeDef {
    name: String,
    span: Span,
    is_class: bool,
    parent: Option<u32>,
    fields: Vec<FieldDef>,
    methods: HashMap<String, MethodDef>,
    complete: bool,
}

struct LoopCtx {
    breaks: Vec<usize>,
    continues: Vec<usize>,
}

struct FnState {
    proto: ProtoRef,
    func: Option<u32>,
    locals: Vec<Local>,
    consts: HashMap<String, (Value, Ty, Span)>,
    loops: Vec<LoopCtx>,
    /// `Some` inside a FUNCTION: the declared return type.
    ret: Option<(Ty, Span)>,
    class: Option<u32>,
    saw_return: bool,
}

impl FnState {
    fn is_main(&self) -> bool {
        self.proto == ProtoRef::Main
    }
}

/// A use of a function that was not yet defined at the point of the call.
struct PendingCall {
    func: u32,
    name: String,
    name_span: Span,
    args_span: Span,
    proto: ProtoRef,
    call_pc: usize,
    args: Vec<PendingArg>,
    as_statement: bool,
    /// Inside a class body: the call may turn out to be a send to `self`.
    self_class: Option<u32>,
    resolved: bool,
}

struct PendingArg {
    ty: Ty,
    span: Span,
    /// The instruction that loaded this argument, and the reference-producing
    /// instruction to swap in if the parameter is `BYREF`.
    patch: Option<(usize, Op)>,
}

/// A method looked up on a class that was still being defined.
struct PendingMethodCheck {
    class: u32,
    name: String,
    span: Span,
}

pub(crate) struct Compiler<'s> {
    src: &'s Source,
    lx: Lexer<'s>,
    tok: Token,
    ahead: Option<Token>,
    prev: Span,
    panic: bool,
    diags: Diagnostics,

    main: Proto,
    funcs: Vec<FnEntry>,
    globals: Vec<GlobalVar>,
    names: HashMap<String, Name>,
    shapes: Vec<ShapeDef>,
    enums: Vec<EnumInfo>,
    inits: Vec<Init>,
    symbols: Vec<String>,
    symbol_ids: HashMap<String, u32>,
    sites: u32,

    fs: Vec<FnState>,
    pending: Vec<PendingCall>,
    pending_methods: Vec<PendingMethodCheck>,
    /// Terminators of the blocks currently open, innermost last.
    open_blocks: Vec<Kw>,
}

impl<'s> Compiler<'s> {
    fn new(src: &'s Source) -> Self {
        let mut c = Compiler {
            src,
            lx: Lexer::new(&src.text),
            tok: Token {
                tok: Tok::Eof,
                span: Span::DUMMY,
                line_start: true,
            },
            ahead: None,
            prev: Span::DUMMY,
            panic: false,
            diags: Diagnostics::default(),
            main: Proto::new("<main>", ProtoKind::Main, Span::DUMMY),
            funcs: Vec::new(),
            globals: Vec::new(),
            names: HashMap::new(),
            shapes: Vec::new(),
            enums: Vec::new(),
            inits: vec![Init::Uninit],
            symbols: Vec::new(),
            symbol_ids: HashMap::new(),
            sites: 0,
            fs: vec![FnState {
                proto: ProtoRef::Main,
                func: None,
                locals: Vec::new(),
                consts: HashMap::new(),
                loops: Vec::new(),
                ret: None,
                class: None,
                saw_return: false,
            }],
            pending: Vec::new(),
            pending_methods: Vec::new(),
            open_blocks: Vec::new(),
        };
        c.main.signature = "main program".into();
        c.advance();
        c
    }

    // -----------------------------------------------------------------------
    // Tokens
    // -----------------------------------------------------------------------

    fn lex(&mut self) -> Token {
        {
            let t = self.lx.next_token();
            if t.tok == Tok::Error
                && let Some(d) = self.lx.take_error()
            {
                self.diags.push(d);
            }
            t
        }
    }

    fn advance(&mut self) {
        self.prev = self.tok.span;
        self.tok = match self.ahead.take() {
            Some(t) => t,
            None => self.lex(),
        };
    }

    fn peek(&mut self) -> Token {
        if self.ahead.is_none() {
            self.ahead = Some(self.lex());
        }
        self.ahead.unwrap()
    }

    fn at(&self, t: Tok) -> bool {
        self.tok.tok == t
    }

    fn at_kw(&self, k: Kw) -> bool {
        self.tok.tok == Tok::Kw(k)
    }

    fn eat(&mut self, t: Tok) -> bool {
        let hit = self.at(t);
        if hit {
            self.advance();
        }
        hit
    }

    fn eat_kw(&mut self, k: Kw) -> bool {
        self.eat(Tok::Kw(k))
    }

    fn text(&self, span: Span) -> &'s str {
        &self.src.text[span.range()]
    }

    fn found(&self) -> String {
        match self.tok.tok {
            Tok::Ident => format!("identifier `{}`", self.text(self.tok.span)),
            t => t.describe(),
        }
    }

    /// If the current token is an identifier spelling a keyword in the wrong
    /// case, return that keyword.
    fn miscased_keyword(&self) -> Option<Kw> {
        if self.tok.tok != Tok::Ident {
            return None;
        }
        Kw::lookup(&self.text(self.tok.span).to_uppercase())
    }

    fn miscased_keyword_error(&mut self, kw: Kw) {
        let span = self.tok.span;
        let d = Diagnostic::error("E0103", "keywords must be written in upper case")
            .primary(
                span,
                format!("this looks like the keyword `{}`", kw.as_str()),
            )
            .suggest(span, kw.as_str(), "write the keyword in capitals");
        self.diags.push(d);
    }

    fn expect(&mut self, t: Tok, context: &str) -> bool {
        if self.eat(t) {
            return true;
        }
        let d = self.expected_error(&format!("`{t}`"), context);
        let d = match t {
            Tok::Arrow if self.at(Tok::Eq) => d.suggest(
                self.tok.span,
                "←",
                "use `←` (or `<-`) for assignment; `=` compares values",
            ),
            Tok::RParen | Tok::RBracket if self.tok.line_start => d.suggest(
                self.prev.after(),
                t.to_string(),
                format!("insert the missing `{t}`"),
            ),
            _ => d,
        };
        self.parse_error(d);
        false
    }

    fn expect_kw(&mut self, k: Kw, context: &str) -> bool {
        if self.eat_kw(k) {
            return true;
        }
        if self.miscased_keyword() == Some(k) {
            self.miscased_keyword_error(k);
            self.advance();
            return true;
        }
        let d = self.expected_error(&format!("`{}`", k.as_str()), context);
        let d = if matches!(k, Kw::Then | Kw::Do | Kw::Of | Kw::To) {
            d.suggest(
                self.prev.after(),
                format!(" {}", k.as_str()),
                format!("add `{}`", k.as_str()),
            )
        } else {
            d
        };
        self.parse_error(d);
        false
    }

    fn expected_error(&self, what: &str, context: &str) -> Diagnostic {
        let found = self.found();
        let label = if self.at(Tok::Eof) {
            format!("expected {what}{context}")
        } else {
            format!("expected {what}")
        };
        let context = if context.is_empty() {
            String::new()
        } else {
            format!(" {context}")
        };
        let mut d = Diagnostic::error("E0100", format!("expected {what}{context}, found {found}"));
        // Point just past the previous token when the problem is a missing
        // token at end of line; that is where the user needs to type.
        if self.tok.line_start && self.prev != Span::DUMMY {
            d = d
                .primary(self.prev.after(), label)
                .secondary(self.tok.span, "unexpected token");
        } else {
            d = d.primary(self.tok.span, label);
        }
        d
    }

    fn expect_ident(&mut self, context: &str) -> Option<(String, Span)> {
        if self.at(Tok::Ident) {
            let span = self.tok.span;
            self.advance();
            return Some((self.text(span).to_string(), span));
        }
        let mut d = self.expected_error("an identifier", context);
        if let Tok::Kw(k) = self.tok.tok {
            d = d.note(format!(
                "`{}` is a reserved keyword and cannot be used as a name",
                k.as_str()
            ));
        }
        self.parse_error(d);
        None
    }

    // -----------------------------------------------------------------------
    // Diagnostics
    // -----------------------------------------------------------------------

    /// Report a syntax error. Further syntax errors are suppressed until the
    /// parser re-synchronises at a statement boundary.
    fn parse_error(&mut self, d: Diagnostic) {
        // An invalid token was already reported by the lexer.
        if !self.panic && self.tok.tok != Tok::Error {
            self.diags.push(d);
        }
        self.panic = true;
    }

    fn error(&mut self, d: Diagnostic) {
        self.diags.push(d);
    }

    /// Skip tokens until something that can start a statement at the start
    /// of a line, or a block terminator.
    fn synchronize(&mut self) {
        while !self.at(Tok::Eof) {
            if let Tok::Kw(k) = self.tok.tok
                && (k.is_block_end() || (k.starts_statement() && self.tok.line_start))
            {
                break;
            }
            if self.tok.line_start && self.at(Tok::Ident) {
                break;
            }
            self.advance();
        }
        self.panic = false;
    }

    // -----------------------------------------------------------------------
    // Emission
    // -----------------------------------------------------------------------

    fn cur(&self) -> &FnState {
        self.fs.last().unwrap()
    }

    fn cur_mut(&mut self) -> &mut FnState {
        self.fs.last_mut().unwrap()
    }

    fn proto_of(&mut self, r: ProtoRef) -> &mut Proto {
        match r {
            ProtoRef::Main => &mut self.main,
            ProtoRef::Func(i) => &mut self.funcs[i as usize].proto,
        }
    }

    fn proto(&mut self) -> &mut Proto {
        let r = self.cur().proto;
        self.proto_of(r)
    }

    fn emit(&mut self, op: Op, span: Span) -> usize {
        let p = self.proto();
        p.code.push(op);
        p.spans.push(span);
        p.code.len() - 1
    }

    fn pc(&mut self) -> usize {
        self.proto().code.len()
    }

    /// Point the jump at `at` to the current end of code.
    fn patch_jump(&mut self, at: usize) {
        let target = self.pc() as u32;
        self.patch_jump_to(at, target);
    }

    fn patch_jump_to(&mut self, at: usize, target: u32) {
        match &mut self.proto().code[at] {
            Op::Jump(t) | Op::JumpIfFalse(t) | Op::JumpIfFalseOrPop(t) | Op::JumpIfTrueOrPop(t) => {
                *t = target
            }
            Op::ForCheck { exit, .. } => *exit = target,
            other => unreachable!("patching non-jump {other:?}"),
        }
    }

    fn constant(&mut self, v: Value, span: Span) {
        if let Value::Int(i) = v {
            self.emit(Op::PushInt(i), span);
            return;
        }
        if let Value::Bool(b) = v {
            self.emit(if b { Op::True } else { Op::False }, span);
            return;
        }
        let p = self.proto();
        let idx = p.consts.len() as u32;
        p.consts.push(v);
        self.emit(Op::Const(idx), span);
    }

    fn intern(&mut self, s: &str) -> u32 {
        if let Some(&id) = self.symbol_ids.get(s) {
            return id;
        }
        let id = self.symbols.len() as u32;
        self.symbols.push(s.to_string());
        self.symbol_ids.insert(s.to_string(), id);
        id
    }

    fn new_site(&mut self) -> u32 {
        self.sites += 1;
        self.sites - 1
    }

    // -----------------------------------------------------------------------
    // Variables
    // -----------------------------------------------------------------------

    /// Where a name is already declared in the current scope, if anywhere.
    fn existing_decl(&self, name: &str) -> Option<Span> {
        let f = self.cur();
        if f.is_main() {
            return match self.names.get(name)? {
                Name::Var(g) => Some(self.globals[*g as usize].span),
                Name::Const { span, .. } | Name::Type { span, .. } | Name::Variant { span, .. } => {
                    Some(*span)
                }
                Name::Func(i) => self.funcs[*i as usize]
                    .defined
                    .then(|| self.funcs[*i as usize].span),
            };
        }
        f.locals
            .iter()
            .find(|l| l.name == name && !l.hidden)
            .map(|l| l.span)
            .or_else(|| f.consts.get(name).map(|c| c.2))
    }

    fn duplicate_error(&mut self, name: &str, span: Span, first: Span) {
        self.error(
            Diagnostic::error("E0201", format!("`{name}` is declared more than once"))
                .primary(span, format!("`{name}` redeclared here"))
                .secondary(first, format!("first declaration of `{name}`"))
                .help("rename one of the declarations, or remove the duplicate"),
        );
    }

    fn declare_var(&mut self, name: &str, ty: Ty, span: Span) -> VarLoc {
        if let Some(first) = self.existing_decl(name) {
            self.duplicate_error(name, span, first);
        }
        if self.cur().is_main() {
            let g = self.globals.len() as u32;
            self.globals.push(GlobalVar {
                name: name.to_string(),
                ty,
                span,
                used: false,
                assigned: false,
                hidden: false,
            });
            self.names.insert(name.to_string(), Name::Var(g));
            VarLoc::Global(g)
        } else {
            if let Some(Name::Var(g)) = self.names.get(name) {
                let gspan = self.globals[*g as usize].span;
                self.error(
                    Diagnostic::warning(
                        "W0004",
                        format!("local `{name}` shadows a global variable"),
                    )
                    .primary(span, "this local declaration...")
                    .secondary(gspan, "...hides this global")
                    .help("inside this routine the global cannot be reached; consider renaming"),
                );
            }
            self.push_local(name, ty, span, false, false, false)
        }
    }

    fn push_local(
        &mut self,
        name: &str,
        ty: Ty,
        span: Span,
        param: bool,
        byref: bool,
        hidden: bool,
    ) -> VarLoc {
        let f = self.cur_mut();
        let slot = f.locals.len() as u16;
        f.locals.push(Local {
            name: name.to_string(),
            ty,
            slot,
            span,
            used: false,
            assigned: param,
            byref,
            param,
            hidden,
        });
        VarLoc::Local(slot)
    }

    /// A compiler-generated variable (loop bounds, CASE subjects, ...).
    fn hidden_var(&mut self, what: &str, ty: Ty, span: Span) -> VarLoc {
        if self.cur().is_main() {
            let g = self.globals.len() as u32;
            self.globals.push(GlobalVar {
                name: format!("<{what}>"),
                ty,
                span,
                used: true,
                assigned: true,
                hidden: true,
            });
            VarLoc::Global(g)
        } else {
            self.push_local(&format!("<{what}>"), ty, span, false, false, true)
        }
    }

    fn load_var(&mut self, v: VarLoc, span: Span) {
        match v {
            VarLoc::Local(s) => self.emit(Op::LoadLocal(s), span),
            VarLoc::Global(g) => self.emit(Op::LoadGlobal(g), span),
        };
    }

    fn store_var(&mut self, v: VarLoc, span: Span) {
        match v {
            VarLoc::Local(s) => self.emit(Op::StoreLocal(s), span),
            VarLoc::Global(g) => self.emit(Op::StoreGlobal(g), span),
        };
    }

    fn var_ty(&self, v: VarLoc) -> Ty {
        match v {
            VarLoc::Local(s) => self.cur().locals[s as usize].ty.clone(),
            VarLoc::Global(g) => self.globals[g as usize].ty.clone(),
        }
    }

    fn mark_var(&mut self, v: VarLoc, used: bool, assigned: bool) {
        match v {
            VarLoc::Local(s) => {
                let l = &mut self.cur_mut().locals[s as usize];
                l.used |= used;
                l.assigned |= assigned;
            }
            VarLoc::Global(g) => {
                let gl = &mut self.globals[g as usize];
                gl.used |= used;
                gl.assigned |= assigned;
            }
        }
    }

    fn var_decl_span(&self, v: VarLoc) -> Span {
        match v {
            VarLoc::Local(s) => self.cur().locals[s as usize].span,
            VarLoc::Global(g) => self.globals[g as usize].span,
        }
    }

    /// Every name visible here, for "did you mean" suggestions.
    fn visible_names(&self) -> Vec<String> {
        let f = self.cur();
        let mut v: Vec<String> = f
            .locals
            .iter()
            .filter(|l| !l.hidden)
            .map(|l| l.name.clone())
            .collect();
        v.extend(f.consts.keys().cloned());
        if let Some(c) = f.class {
            v.extend(
                self.shapes[c as usize]
                    .fields
                    .iter()
                    .map(|f| f.name.clone()),
            );
            v.extend(self.all_method_names(c));
        }
        v.extend(self.names.keys().cloned());
        v.extend(Builtin::ALL.iter().map(|b| b.name().to_string()));
        v
    }

    // -----------------------------------------------------------------------
    // Types
    // -----------------------------------------------------------------------

    fn ty_name(&self, ty: &Ty) -> String {
        match ty {
            Ty::Int => "INTEGER".into(),
            Ty::Real => "REAL".into(),
            Ty::Bool => "BOOLEAN".into(),
            Ty::Char => "CHAR".into(),
            Ty::Str => "STRING".into(),
            Ty::Date => "DATE".into(),
            Ty::Array(a) => {
                let dims: Vec<String> = a.dims.iter().map(|(l, h)| format!("{l}:{h}")).collect();
                format!("ARRAY[{}] OF {}", dims.join(", "), self.ty_name(&a.elem))
            }
            Ty::Record(s) | Ty::Class(s) => self.shapes[*s as usize].name.clone(),
            Ty::Enum(e) => self.enums[*e as usize].name.clone(),
            Ty::Pointer(t) => format!("^{}", self.ty_name(t)),
            Ty::Void => "no value".into(),
            Ty::Unknown => "{unknown}".into(),
            Ty::Error => "{error}".into(),
        }
    }

    fn is_subclass(&self, mut c: u32, ancestor: u32) -> bool {
        loop {
            if c == ancestor {
                return true;
            }
            match self.shapes[c as usize].parent {
                Some(p) => c = p,
                None => return false,
            }
        }
    }

    fn compat(&self, target: &Ty, src: &Ty) -> Compat {
        if target == src {
            return Compat::Same;
        }
        match (target, src) {
            (Ty::Error, _) | (_, Ty::Error) | (Ty::Unknown, _) => Compat::Same,
            (t, Ty::Unknown) => match t.conv() {
                crate::bytecode::Conv::Any => Compat::Same,
                c => Compat::Check(c),
            },
            (Ty::Real, Ty::Int) => Compat::IntToReal,
            (Ty::Str, Ty::Char) => Compat::CharToStr,
            (Ty::Class(a), Ty::Class(b)) if self.is_subclass(*b, *a) => Compat::Same,
            _ => Compat::Incompatible,
        }
    }

    /// The default-value initializer for a type, if it needs one.
    fn init_for(&mut self, ty: &Ty) -> Option<u32> {
        let init = match ty {
            Ty::Array(a) => {
                let elem = self.init_for(&a.elem).unwrap_or(0);
                Init::Array {
                    dims: Rc::from(a.dims.as_slice()),
                    elem,
                }
            }
            Ty::Record(s) => Init::Record(*s),
            _ => return None,
        };
        self.inits.push(init);
        Some(self.inits.len() as u32 - 1)
    }

    // -----------------------------------------------------------------------
    // Classes
    // -----------------------------------------------------------------------

    fn find_method(&self, mut class: u32, name: &str) -> Option<&MethodDef> {
        loop {
            let s = &self.shapes[class as usize];
            if let Some(m) = s.methods.get(name) {
                return Some(m);
            }
            class = s.parent?;
        }
    }

    fn all_method_names(&self, mut class: u32) -> Vec<String> {
        let mut out = Vec::new();
        loop {
            let s = &self.shapes[class as usize];
            out.extend(s.methods.keys().cloned());
            match s.parent {
                Some(p) => class = p,
                None => return out,
            }
        }
    }

    // -----------------------------------------------------------------------
    // Finishing
    // -----------------------------------------------------------------------

    fn finish(mut self) -> (Option<Program>, Diagnostics) {
        self.resolve_pending_calls();
        self.warn_unused_globals();

        if self.diags.has_errors() {
            return (None, self.diags);
        }

        let shapes = self
            .shapes
            .iter()
            .enumerate()
            .map(|(i, s)| {
                let fields: Vec<FieldMeta> = s
                    .fields
                    .iter()
                    .map(|f| FieldMeta {
                        name: f.name.clone(),
                        sym: *self.symbol_ids.get(&f.name).unwrap_or(&u32::MAX),
                        private: f.private,
                        owner: f.owner,
                        ty: self.ty_name(&f.ty),
                    })
                    .collect();
                let methods = s
                    .methods
                    .iter()
                    .map(|(n, m)| {
                        let sym = self.symbol_ids[n];
                        (
                            sym,
                            MethodMeta {
                                func: m.func,
                                private: m.private,
                                owner: m.owner,
                            },
                        )
                    })
                    .collect();
                (i, fields, methods)
            })
            .collect::<Vec<_>>();
        let mut shape_out = Vec::new();
        for (i, fields, methods) in shapes {
            let tys: Vec<Ty> = self.shapes[i].fields.iter().map(|f| f.ty.clone()).collect();
            let field_inits = tys.iter().map(|t| self.init_for(t).unwrap_or(0)).collect();
            let s = &self.shapes[i];
            shape_out.push(Shape {
                name: s.name.clone(),
                is_class: s.is_class,
                parent: s.parent,
                fields,
                field_inits,
                methods,
            });
        }

        let globals = self
            .globals
            .iter()
            .map(|g| GlobalInfo {
                name: g.name.clone(),
                ty: self.ty_name(&g.ty),
                decl: g.span,
            })
            .collect();
        let functions = self.funcs.into_iter().map(|f| Rc::new(f.proto)).collect();
        let program = Program {
            main: Rc::new(self.main),
            functions,
            globals,
            shapes: shape_out,
            enums: self.enums,
            inits: self.inits,
            symbols: self.symbols,
            num_sites: self.sites,
        };
        (Some(program), self.diags)
    }

    fn resolve_pending_calls(&mut self) {
        let pending = std::mem::take(&mut self.pending);
        for call in pending.iter().filter(|c| !c.resolved) {
            let f = &self.funcs[call.func as usize];
            if !f.defined {
                let candidates = self.visible_names();
                let mut d = Diagnostic::error(
                    "E0200",
                    format!("cannot find procedure or function `{}`", call.name),
                )
                .primary(call.name_span, "not defined anywhere in this file");
                if let Some(m) = best_match(&call.name, candidates.iter().map(String::as_str)) {
                    d = d.suggest(
                        call.name_span,
                        m,
                        format!("a routine with a similar name exists: `{m}`"),
                    );
                } else {
                    d = d.help(format!(
                        "define it with `PROCEDURE {}(...)` ... `ENDPROCEDURE` or `FUNCTION {}(...) RETURNS ...`",
                        call.name, call.name
                    ));
                }
                self.error(d);
                continue;
            }
            let params = f.params.clone();
            let kind = f.kind;
            let decl = f.span;
            let sig = f.proto.signature.clone();
            self.check_deferred_args(call, &params, decl, &sig);
            if kind == FnKind::Procedure && !call.as_statement {
                self.error(
                    Diagnostic::error(
                        "E0302",
                        format!("procedure `{}` does not return a value", call.name),
                    )
                    .primary(call.name_span.to(call.args_span), "used as a value here")
                    .secondary(decl, "declared as a PROCEDURE here")
                    .help("declare it as a FUNCTION with `RETURNS <type>` to produce a value"),
                );
            }
        }
    }

    /// Check (and patch) the arguments of a call compiled before its callee.
    fn check_deferred_args(&mut self, call: &PendingCall, params: &[Param], decl: Span, sig: &str) {
        if call.args.len() != params.len() {
            self.arity_error(
                &call.name,
                call.name_span.to(call.args_span),
                params.len(),
                call.args.len(),
                decl,
                sig,
            );
            return;
        }
        for (arg, p) in call.args.iter().zip(params) {
            if p.byref {
                match arg.patch {
                    Some((pc, op)) => {
                        self.proto_of(call.proto).code[pc] = op;
                        if self.compat(&p.ty, &arg.ty) != Compat::Same
                            || self.compat(&arg.ty, &p.ty) != Compat::Same
                        {
                            self.byref_type_error(arg.span, &arg.ty, p);
                        }
                    }
                    None => self.byref_value_error(arg.span, p),
                }
            } else if self.compat(&p.ty, &arg.ty) == Compat::Incompatible {
                let d = self
                    .mismatch(&p.ty, &arg.ty, arg.span)
                    .secondary(p.span, format!("parameter `{}` declared here", p.name));
                self.error(d);
            }
        }
    }

    fn warn_unused_globals(&mut self) {
        let mut ws = Vec::new();
        for g in &self.globals {
            if g.hidden || g.name.starts_with('_') {
                continue;
            }
            if !g.used && !g.assigned {
                ws.push(
                    Diagnostic::warning("W0001", format!("unused variable `{}`", g.name))
                        .primary(g.span, "declared but never used")
                        .help(format!(
                            "remove it, or prefix it with an underscore: `_{}`",
                            g.name
                        )),
                );
            } else if !g.used {
                ws.push(
                    Diagnostic::warning(
                        "W0001",
                        format!("variable `{}` is assigned but never read", g.name),
                    )
                    .primary(g.span, "declared here"),
                );
            }
        }
        for w in ws {
            self.error(w);
        }
    }

    // Shared error constructors -------------------------------------------

    fn arity_error(
        &mut self,
        name: &str,
        span: Span,
        expected: usize,
        got: usize,
        decl: Span,
        sig: &str,
    ) {
        let plural = |n: usize| if n == 1 { "" } else { "s" };
        let mut d = Diagnostic::error(
            "E0301",
            format!(
                "`{name}` takes {expected} argument{} but {got} {} supplied",
                plural(expected),
                if got == 1 { "was" } else { "were" }
            ),
        )
        .primary(
            span,
            format!("expected {expected} argument{}", plural(expected)),
        );
        if decl != Span::DUMMY {
            d = d.secondary(decl, "defined here");
        }
        self.error(d.note(format!("signature: {sig}")));
    }

    fn byref_value_error(&mut self, span: Span, p: &Param) {
        self.error(
            Diagnostic::error(
                "E0308",
                format!("`BYREF` parameter `{}` needs a variable", p.name),
            )
            .primary(span, "this is a value, not a variable")
            .secondary(p.span, "parameter declared BYREF here")
            .help("store the value in a variable first and pass that variable")
            .note("a BYREF parameter lets the routine modify the caller's variable"),
        );
    }

    fn byref_type_error(&mut self, span: Span, found: &Ty, p: &Param) {
        let (e, f) = (self.ty_name(&p.ty), self.ty_name(found));
        self.error(
            Diagnostic::error("E0300", "mismatched types for `BYREF` argument")
                .primary(span, format!("expected a variable of type `{e}`, found `{f}`"))
                .secondary(p.span, format!("`{}` is BYREF `{e}`", p.name))
                .note("BYREF arguments must match the parameter type exactly; no conversion is applied"),
        );
    }

    /// A type-mismatch diagnostic with conversion suggestions.
    fn mismatch(&self, expected: &Ty, found: &Ty, span: Span) -> Diagnostic {
        let (e, f) = (self.ty_name(expected), self.ty_name(found));
        let text = self.text(span);
        let mut d = Diagnostic::error("E0300", "mismatched types")
            .primary(span, format!("expected `{e}`, found `{f}`"));
        d = match (expected, found) {
            (Ty::Str, Ty::Int | Ty::Real) => {
                d.suggest(span, format!("NUM_TO_STR({text})"), "convert the number to a STRING")
            }
            (Ty::Int | Ty::Real, Ty::Str | Ty::Char) => {
                d.suggest(span, format!("STR_TO_NUM({text})"), "parse the text as a number")
            }
            (Ty::Int, Ty::Real) => d
                .suggest(span, format!("INT({text})"), "truncate the REAL to an INTEGER")
                .note("REAL values are never converted to INTEGER implicitly, because that loses information"),
            (Ty::Char, Ty::Str) if text.chars().count() == 3 && text.starts_with('"') => d.suggest(
                span,
                format!("'{}'", &text[1..text.len() - 1]),
                "use single quotes for a CHAR literal",
            ),
            (Ty::Bool, Ty::Int) => d.note("INTEGER values are not truth values; compare explicitly, e.g. `X <> 0`"),
            (Ty::Class(a), Ty::Class(b)) => d.note(format!(
                "`{}` does not inherit from `{}`",
                self.shapes[*b as usize].name, self.shapes[*a as usize].name
            )),
            _ => d,
        };
        d
    }

    /// Emit the conversion that lets a value of `found` (on top of the stack)
    /// flow into a slot of type `expected`. Returns `false` on mismatch,
    /// leaving error reporting to the caller.
    fn convert_top(&mut self, expected: &Ty, found: &Ty, span: Span) -> bool {
        match self.compat(expected, found) {
            Compat::Same => true,
            Compat::IntToReal => {
                self.emit(Op::IntToReal, span);
                true
            }
            Compat::CharToStr => {
                self.emit(Op::Convert(crate::bytecode::Conv::Str), span);
                true
            }
            Compat::Check(c) => {
                self.emit(Op::Check(c), span);
                true
            }
            Compat::Incompatible => false,
        }
    }

    fn new_array_ty(dims: Vec<(i64, i64)>, elem: Ty) -> Ty {
        Ty::Array(Rc::new(ArrayTy { dims, elem }))
    }

    fn local_infos(&self, f: &FnState) -> Vec<LocalInfo> {
        f.locals
            .iter()
            .map(|l| LocalInfo {
                name: l.name.clone(),
                slot: l.slot,
                ty: self.ty_name(&l.ty),
                decl: l.span,
                byref: l.byref,
            })
            .collect()
    }

    fn warn_unused_locals(&mut self, f: &FnState) {
        for l in &f.locals {
            if l.hidden || l.name.starts_with('_') || l.name == "SELF" {
                continue;
            }
            let what = if l.param { "parameter" } else { "variable" };
            if !l.used && !(l.assigned && !l.param) {
                self.error(
                    Diagnostic::warning("W0001", format!("unused {what} `{}`", l.name))
                        .primary(l.span, format!("{what} is never used"))
                        .help(format!(
                            "if this is intentional, prefix it with an underscore: `_{}`",
                            l.name
                        )),
                );
            } else if !l.used && !l.byref {
                self.error(
                    Diagnostic::warning(
                        "W0001",
                        format!("{what} `{}` is assigned but never read", l.name),
                    )
                    .primary(l.span, "declared here"),
                );
            }
        }
    }
}
