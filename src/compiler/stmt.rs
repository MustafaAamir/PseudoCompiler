//! Statements and structured control flow, emitted directly as jumps.

use super::expr::{BinOp, CallKind, Expr};
use super::*;
use crate::bytecode::{Conv, FileMode};

impl Compiler<'_> {
    pub(super) fn program(&mut self) {
        while !self.at(Tok::Eof) {
            let before = self.tok.span;
            if let Tok::Kw(k) = self.tok.tok
                && k.is_block_end()
            {
                self.stray_terminator(k);
                self.advance();
                continue;
            }
            self.statement();
            self.end_of_statement();
            if self.tok.span == before && !self.at(Tok::Eof) {
                self.advance();
            }
        }
        let span = self.tok.span;
        self.emit(Op::Halt, span);
        let main = self.fs.pop().unwrap();
        self.main.locals = self.local_infos(&main);
        self.main.num_slots = main.locals.len() as u16;
        self.fs.push(main);
    }

    fn stray_terminator(&mut self, k: Kw) {
        let opener = match k {
            Kw::EndIf | Kw::Else => "IF",
            Kw::EndCase | Kw::Otherwise => "CASE OF",
            Kw::EndWhile => "WHILE",
            Kw::Until => "REPEAT",
            Kw::Next => "FOR",
            Kw::EndProcedure => "PROCEDURE",
            Kw::EndFunction => "FUNCTION",
            Kw::EndClass => "CLASS",
            _ => "TYPE",
        };
        self.error(
            Diagnostic::error(
                "E0102",
                format!("`{}` without a matching `{opener}`", k.as_str()),
            )
            .primary(self.tok.span, "nothing to close here")
            .help(format!(
                "remove it, or check for an earlier `{opener}` that was closed too soon"
            )),
        );
    }

    /// After a statement: recover from errors and reject trailing tokens.
    fn end_of_statement(&mut self) {
        if self.panic {
            self.synchronize();
            return;
        }
        let trailing = !self.tok.line_start
            && !self.at(Tok::Eof)
            && !matches!(self.tok.tok, Tok::Kw(k) if k.is_block_end());
        if trailing {
            let d = Diagnostic::error(
                "E0100",
                format!("expected end of line, found {}", self.found()),
            )
            .primary(self.tok.span, "unexpected after the end of the statement")
            .help("each statement goes on its own line");
            let d = if self.at(Tok::Eq) {
                d.suggest(self.tok.span, "←", "to assign, use `←`")
            } else {
                d
            };
            self.parse_error(d);
            self.synchronize();
        }
    }

    /// Compile statements up to (not including) a block terminator.
    /// Returns whether control can never fall out of the block.
    pub(super) fn block(&mut self, case_arms: bool) -> bool {
        let mut diverged: Option<Span> = None;
        let mut warned = false;
        loop {
            if self.at(Tok::Eof) {
                break;
            }
            if let Some(k) = self.miscased_keyword()
                && k.is_block_end()
                && self.tok.line_start
                && !self.is_declared(self.text(self.tok.span))
            {
                self.miscased_keyword_error(k);
                self.tok.tok = Tok::Kw(k);
            }
            if matches!(self.tok.tok, Tok::Kw(k) if k.is_block_end())
                || (case_arms && self.at_case_label())
            {
                break;
            }
            let start = self.tok.span;
            if let Some(ds) = diverged
                && !warned
            {
                warned = true;
                self.error(
                    Diagnostic::warning("W0002", "unreachable statement")
                        .primary(start, "this will never run")
                        .secondary(ds, "any code after this is unreachable"),
                );
            }
            let d = self.statement();
            if d && diverged.is_none() {
                diverged = Some(start);
            }
            self.end_of_statement();
            if self.tok.span == start && !self.at(Tok::Eof) {
                self.advance();
            }
        }
        diverged.is_some()
    }

    fn is_declared(&self, name: &str) -> bool {
        self.cur().locals.iter().any(|l| l.name == name) || self.names.contains_key(name)
    }

    fn at_case_label(&mut self) -> bool {
        if !self.tok.line_start {
            return false;
        }
        match self.tok.tok {
            Tok::Int(_) | Tok::Real(_) | Tok::Str | Tok::Char(_) | Tok::Date(_) | Tok::Minus => {
                true
            }
            Tok::Kw(Kw::True | Kw::False) => true,
            Tok::Ident => matches!(self.peek().tok, Tok::Colon | Tok::Kw(Kw::To)),
            _ => false,
        }
    }

    /// Expect the terminator of a block opened at `opener_span`.
    pub(super) fn open_block(&mut self, end: Kw) {
        self.open_blocks.push(end);
    }

    /// Whether an enclosing (not the innermost) open block accepts `k`.
    fn enclosing_accepts(&self, k: Kw) -> bool {
        let outer = &self.open_blocks[..self.open_blocks.len().saturating_sub(1)];
        outer.iter().any(|&e| {
            e == k || (k == Kw::Else && e == Kw::EndIf) || (k == Kw::Otherwise && e == Kw::EndCase)
        })
    }

    pub(super) fn close_block(&mut self, end: Kw, opener: &str, opener_span: Span) {
        self.close_block_inner(end, opener, opener_span);
        self.open_blocks.pop();
    }

    fn close_block_inner(&mut self, end: Kw, opener: &str, opener_span: Span) {
        if self.eat_kw(end) {
            return;
        }
        if self.miscased_keyword() == Some(end) {
            self.miscased_keyword_error(end);
            self.advance();
            return;
        }
        let e = end.as_str();
        let d = match self.tok.tok {
            Tok::Eof => Diagnostic::error("E0101", format!("unclosed `{opener}` block"))
                .primary(opener_span, format!("this `{opener}` is never closed"))
                .secondary(self.tok.span, format!("file ends here; expected `{e}`"))
                .help(format!("add `{e}` after the last statement of the block")),
            Tok::Kw(k) if k.is_block_end() => Diagnostic::error(
                "E0102",
                format!(
                    "mismatched block terminator: expected `{e}`, found `{}`",
                    k.as_str()
                ),
            )
            .primary(self.tok.span, format!("expected `{e}`"))
            .secondary(opener_span, format!("this `{opener}` must be closed first"))
            .help(format!(
                "insert `{e}` before this line, or check the nesting of your blocks"
            )),
            _ => self
                .expected_error(&format!("`{e}`"), &format!("to close `{opener}`"))
                .secondary(opener_span, format!("`{opener}` opened here")),
        };
        self.error(d);
        // A wrong terminator that no enclosing block wants is consumed here,
        // so it is not reported a second time as stray.
        if let Tok::Kw(k) = self.tok.tok
            && k.is_block_end()
            && !self.enclosing_accepts(k)
        {
            self.advance();
        }
    }

    pub(super) fn statement(&mut self) -> bool {
        // `output X` etc: a lower-case keyword at the start of a statement.
        if let Some(k) = self.miscased_keyword()
            && k.starts_statement()
            && !self.is_declared(self.text(self.tok.span))
        {
            self.miscased_keyword_error(k);
            self.tok.tok = Tok::Kw(k);
        }
        let Tok::Kw(k) = self.tok.tok else {
            if matches!(self.tok.tok, Tok::Ident | Tok::Caret) {
                self.expr_stmt();
            } else {
                let d = self
                    .expected_error("a statement", "")
                    .help("statements start with a keyword such as DECLARE, IF, OUTPUT, or with a variable to assign");
                self.parse_error(d);
            }
            return false;
        };
        match k {
            Kw::Declare => self.declare_stmt(),
            Kw::Constant => self.constant_stmt(),
            Kw::Type => self.type_stmt(),
            Kw::If => return self.if_stmt(),
            Kw::Case => return self.case_stmt(),
            Kw::While => self.while_stmt(),
            Kw::Repeat => self.repeat_stmt(),
            Kw::For => self.for_stmt(),
            Kw::Call => self.call_stmt(),
            Kw::Return => {
                self.return_stmt();
                return true;
            }
            Kw::Break | Kw::Continue => {
                self.jump_stmt(k);
                return true;
            }
            Kw::Output | Kw::Print => self.output_stmt(),
            Kw::Input | Kw::Read => self.input_stmt(),
            Kw::OpenFile => self.openfile_stmt(),
            Kw::ReadFile | Kw::GetRecord => self.read_record_stmt(k),
            Kw::WriteFile | Kw::PutRecord | Kw::Seek => self.write_record_stmt(k),
            Kw::CloseFile => {
                let span = self.tok.span;
                self.advance();
                self.file_name("CLOSEFILE");
                self.emit(Op::CloseFile, span);
            }
            Kw::Procedure | Kw::Function => self.routine_def(None),
            Kw::Class => self.class_def(),
            Kw::Super => self.expr_stmt(),
            Kw::Public | Kw::Private => {
                self.parse_error(
                    Diagnostic::error(
                        "E0100",
                        format!("`{}` is only allowed inside a CLASS", k.as_str()),
                    )
                    .primary(self.tok.span, "not inside a class definition"),
                );
            }
            _ => {
                let d = self.expected_error("a statement", "");
                self.parse_error(d);
            }
        }
        false
    }

    // -----------------------------------------------------------------------
    // Assignment and expression statements
    // -----------------------------------------------------------------------

    fn expr_stmt(&mut self) {
        let e = self.postfix();
        if self.at(Tok::Arrow) {
            self.assign(e);
            return;
        }
        if self.at(Tok::Eq) && e.place.is_some() {
            let span = self.tok.span;
            self.error(
                Diagnostic::error("E0100", "`=` compares values; it does not assign")
                    .primary(span, "this is a comparison")
                    .suggest(span, "←", "use `←` (or `<-`) to assign"),
            );
            self.assign(e);
            return;
        }
        match e.call {
            Some(kind) => {
                if let CallKind::Pending(i) = kind {
                    self.pending[i].as_statement = true;
                }
                self.emit(Op::Pop, e.span);
            }
            None if e.ty != Ty::Error => {
                let d = Diagnostic::error("E0100", "expected a statement, found an expression")
                    .primary(e.span, "this value is computed and then thrown away");
                let d = if e.place.is_some() {
                    d.help("to assign, write `variable ← value`; to display it, use OUTPUT")
                } else {
                    d.help("use OUTPUT to display a value")
                };
                self.parse_error(d);
            }
            None => {}
        }
    }

    fn assign(&mut self, target: Expr) {
        let arrow = self.tok.span;
        self.advance();
        let Some(place) = target.place else {
            if target.ty != Ty::Error {
                self.error(
                    Diagnostic::error("E0309", "cannot assign to this expression")
                        .primary(target.span, "not a variable, field or array element")
                        .secondary(arrow, "assignment here"),
                );
            }
            self.expr();
            return;
        };
        let v = self.expr();
        self.check_store(&target, &v);
        if target.ty.is_value_aggregate() {
            self.emit(Op::Copy, v.span);
        }
        if let Some(var) = target.var {
            self.mark_var(var, false, true);
        }
        self.emit_store(place, target.span);
    }

    /// Type-check `value` flowing into `target`, emitting conversions.
    fn check_store(&mut self, target: &Expr, value: &Expr) {
        if self.convert_top(&target.ty, &value.ty, value.span) {
            return;
        }
        let tn = self.ty_name(&target.ty);
        let mut d = self
            .mismatch(&target.ty, &value.ty, value.span)
            .secondary(target.span, format!("this has type `{tn}`"));
        if let Some(var) = target.var {
            let decl = self.var_decl_span(var);
            if self.src.line_index(decl.start) != self.src.line_index(target.span.start) {
                d = d.note_at(
                    decl,
                    format!("`{}` was declared as `{tn}` here", self.text(target.span)),
                );
            }
        }
        if value.ty == Ty::Void {
            d = d.note("procedures do not produce a value; only FUNCTIONs do");
        }
        self.error(d);
    }

    fn call_stmt(&mut self) {
        let call_span = self.tok.span;
        self.advance();
        let e = if self.at(Tok::Ident)
            && !matches!(self.peek().tok, Tok::Dot | Tok::LBracket | Tok::Caret)
        {
            let span = self.tok.span;
            let name = self.text(span).to_string();
            self.advance();
            self.call_named(&name, span)
        } else {
            self.postfix()
        };
        match e.call {
            Some(CallKind::Pending(i)) => self.pending[i].as_statement = true,
            Some(CallKind::Function | CallKind::Builtin) => self.error(
                Diagnostic::warning("W0003", "the result of this FUNCTION call is discarded")
                    .primary(e.span, "returns a value that is never used")
                    .secondary(call_span, "CALL is for PROCEDUREs")
                    .help("assign the result to a variable, e.g. `Result ← F(...)`"),
            ),
            Some(_) => {}
            None => {
                if e.ty != Ty::Error {
                    self.error(
                        Diagnostic::error("E0302", "CALL must be followed by a procedure call")
                            .primary(e.span, "this is not a call")
                            .secondary(call_span, "CALL here"),
                    );
                }
                return;
            }
        }
        self.emit(Op::Pop, e.span);
    }

    // -----------------------------------------------------------------------
    // Control flow
    // -----------------------------------------------------------------------

    fn if_stmt(&mut self) -> bool {
        let if_span = self.tok.span;
        self.advance();
        self.open_block(Kw::EndIf);
        self.condition("IF", if_span);
        self.expect_kw(Kw::Then, "after the IF condition");
        let mut false_jump = Some(self.emit(Op::JumpIfFalse(0), if_span));
        let mut branch_diverges = self.block(false);
        let mut all_diverge = branch_diverges;
        let mut end_jumps = Vec::new();
        let mut has_else = false;
        while self.at_kw(Kw::Else) {
            let else_span = self.tok.span;
            let next = self.peek();
            // A branch that always leaves (RETURN, ...) needs no jump to ENDIF.
            if !branch_diverges {
                end_jumps.push(self.emit(Op::Jump(0), else_span));
            }
            if let Some(j) = false_jump.take() {
                self.patch_jump(j);
            }
            self.advance();
            if next.tok == Tok::Kw(Kw::If) && !next.line_start {
                // ELSE IF chain sharing one ENDIF.
                let elif = self.tok.span;
                self.advance();
                self.condition("ELSE IF", elif);
                self.expect_kw(Kw::Then, "after the ELSE IF condition");
                false_jump = Some(self.emit(Op::JumpIfFalse(0), elif));
                branch_diverges = self.block(false);
                all_diverge &= branch_diverges;
            } else {
                all_diverge &= self.block(false);
                has_else = true;
                break;
            }
        }
        if let Some(j) = false_jump {
            self.patch_jump(j);
        }
        self.close_block(Kw::EndIf, "IF", if_span);
        for j in end_jumps {
            self.patch_jump(j);
        }
        has_else && all_diverge
    }

    fn case_stmt(&mut self) -> bool {
        let case_span = self.tok.span;
        self.advance();
        self.open_block(Kw::EndCase);
        self.expect_kw(Kw::Of, "after CASE");
        let subject = self.expr();
        let subj_ty = subject.ty.clone();
        let tmp = self.hidden_var("case subject", subj_ty.clone(), case_span);
        self.store_var(tmp, subject.span);

        let mut end_jumps = Vec::new();
        let mut all_diverge = true;
        let mut otherwise = false;
        let mut arms = 0;
        loop {
            if self.at_kw(Kw::Otherwise) {
                self.advance();
                self.eat(Tok::Colon);
                all_diverge &= self.block(true);
                otherwise = true;
                if !self.at_kw(Kw::EndCase) && self.at_case_label() {
                    self.error(
                        Diagnostic::error("E0100", "CASE arm after OTHERWISE")
                            .primary(self.tok.span, "this arm can never be reached")
                            .help("OTHERWISE must be the last branch of a CASE"),
                    );
                    continue;
                }
                break;
            }
            if !self.at_case_label() {
                break;
            }
            let mut fails = Vec::new();
            let subj = Expr::value(subj_ty.clone(), subject.span);
            self.load_var(tmp, subject.span);
            let lo = self.expr();
            if self.eat_kw(Kw::To) {
                self.emit_binary(BinOp::Ge, &subj, &lo, lo.span);
                fails.push(self.emit(Op::JumpIfFalse(0), lo.span));
                self.load_var(tmp, subject.span);
                let hi = self.expr();
                self.emit_binary(BinOp::Le, &subj, &hi, hi.span);
                fails.push(self.emit(Op::JumpIfFalse(0), hi.span));
            } else {
                self.emit_binary(BinOp::Eq, &subj, &lo, lo.span);
                fails.push(self.emit(Op::JumpIfFalse(0), lo.span));
            }
            self.expect(Tok::Colon, "after the CASE label");
            all_diverge &= self.block(true);
            end_jumps.push(self.emit(Op::Jump(0), case_span));
            for f in fails {
                self.patch_jump(f);
            }
            arms += 1;
            if self.panic {
                self.synchronize();
            }
        }
        if arms == 0 && !otherwise {
            self.error(
                Diagnostic::warning("W0005", "CASE statement has no branches")
                    .primary(case_span, "this CASE does nothing"),
            );
        }
        self.close_block(Kw::EndCase, "CASE", case_span);
        for j in end_jumps {
            self.patch_jump(j);
        }
        otherwise && all_diverge
    }

    fn while_stmt(&mut self) {
        let span = self.tok.span;
        self.advance();
        self.open_block(Kw::EndWhile);
        let start = self.pc() as u32;
        self.condition("WHILE", span);
        self.eat_kw(Kw::Do);
        let exit = self.emit(Op::JumpIfFalse(0), span);
        self.cur_mut().loops.push(LoopCtx {
            breaks: vec![],
            continues: vec![],
        });
        self.block(false);
        let ctx = self.cur_mut().loops.pop().unwrap();
        self.emit(Op::Jump(start), span);
        self.patch_jump(exit);
        self.finish_loop(ctx, start);
        self.close_block(Kw::EndWhile, "WHILE", span);
    }

    fn repeat_stmt(&mut self) {
        let span = self.tok.span;
        self.advance();
        self.open_block(Kw::Until);
        let start = self.pc() as u32;
        self.cur_mut().loops.push(LoopCtx {
            breaks: vec![],
            continues: vec![],
        });
        self.block(false);
        let ctx = self.cur_mut().loops.pop().unwrap();
        let cond_pc = self.pc() as u32;
        self.close_block(Kw::Until, "REPEAT", span);
        let until = self.prev;
        self.condition("UNTIL", until);
        self.emit(Op::JumpIfFalse(start), until);
        for c in &ctx.continues {
            self.patch_jump_to(*c, cond_pc);
        }
        for b in ctx.breaks {
            self.patch_jump(b);
        }
    }

    fn finish_loop(&mut self, ctx: LoopCtx, continue_target: u32) {
        for c in ctx.continues {
            self.patch_jump_to(c, continue_target);
        }
        for b in ctx.breaks {
            self.patch_jump(b);
        }
    }

    fn for_stmt(&mut self) {
        let for_span = self.tok.span;
        self.advance();
        self.open_block(Kw::Next);
        let Some((name, name_span)) = self.expect_ident("after FOR") else {
            self.open_blocks.pop();
            return;
        };

        // The loop variable: an existing INTEGER variable, or declared implicitly.
        let existing = self
            .cur()
            .locals
            .iter()
            .find(|l| l.name == name && !l.hidden)
            .map(|l| (VarLoc::Local(l.slot), l.byref))
            .or_else(|| match self.names.get(&name) {
                Some(Name::Var(g)) => Some((VarLoc::Global(*g), false)),
                _ => None,
            });
        let var = match existing {
            Some((_, true)) => {
                self.error(
                    Diagnostic::error("E0309", "a BYREF parameter cannot be a FOR loop counter")
                        .primary(name_span, "BYREF parameter")
                        .help("copy it to a local INTEGER variable and loop over that"),
                );
                self.hidden_var("for", Ty::Int, name_span)
            }
            Some((v, false)) => {
                let ty = self.var_ty(v);
                if !matches!(ty, Ty::Int | Ty::Error) {
                    let tn = self.ty_name(&ty);
                    self.error(
                        Diagnostic::error(
                            "E0300",
                            format!("FOR loop counter `{name}` must be INTEGER"),
                        )
                        .primary(name_span, format!("`{name}` has type `{tn}`"))
                        .secondary(self.var_decl_span(v), "declared here"),
                    );
                }
                v
            }
            None => {
                let v = self.declare_var(&name, Ty::Int, name_span);
                self.mark_var(v, true, true);
                v
            }
        };
        self.mark_var(var, true, true);
        if !self.at(Tok::Arrow) && self.at(Tok::Eq) {
            self.error(
                Diagnostic::error("E0100", "expected `←` after the FOR loop counter")
                    .primary(self.tok.span, "found `=`")
                    .suggest(
                        self.tok.span,
                        "←",
                        "FOR loops assign the start value with `←`",
                    ),
            );
            self.advance();
        } else {
            self.expect(Tok::Arrow, "after the FOR loop counter");
        }
        let start = self.expr();
        self.int_operand(&start, "the FOR start value");
        self.store_var(var, start.span);
        self.expect_kw(Kw::To, "after the FOR start value");
        let end = self.expr();
        self.int_operand(&end, "the FOR end value");
        let end_var = self.hidden_var("for end", Ty::Int, end.span);
        self.store_var(end_var, end.span);
        if self.eat_kw(Kw::Step) {
            let step = self.expr();
            self.int_operand(&step, "the FOR STEP");
            if matches!(step.constant, Some(Value::Int(0))) {
                self.error(
                    Diagnostic::error("E0300", "FOR loop STEP cannot be zero")
                        .primary(step.span, "this loop would never end"),
                );
            }
        } else {
            self.emit(Op::PushInt(1), for_span);
        }
        let step_var = self.hidden_var("for step", Ty::Int, for_span);
        self.store_var(step_var, for_span);

        let check = self.emit(
            Op::ForCheck {
                var,
                end: end_var,
                step: step_var,
                exit: 0,
            },
            for_span,
        );
        self.cur_mut().loops.push(LoopCtx {
            breaks: vec![],
            continues: vec![],
        });
        self.block(false);
        let ctx = self.cur_mut().loops.pop().unwrap();
        let step_pc = self.pc() as u32;
        self.emit(
            Op::ForStep {
                var,
                step: step_var,
                back: check as u32,
            },
            for_span,
        );
        self.patch_jump(check);
        self.finish_loop(ctx, step_pc);

        self.close_block(Kw::Next, "FOR", for_span);
        if self.at(Tok::Ident) && !self.tok.line_start {
            let span = self.tok.span;
            let next_name = self.text(span).to_string();
            self.advance();
            if next_name != name {
                self.error(
                    Diagnostic::error(
                        "E0204",
                        format!("`NEXT {next_name}` does not match `FOR {name}`"),
                    )
                    .primary(span, format!("expected `{name}`"))
                    .secondary(
                        name_span,
                        "the innermost FOR loop counts with this variable",
                    )
                    .suggest(span, name.clone(), "use the loop's own counter"),
                );
            }
        }
    }

    fn int_operand(&mut self, e: &Expr, what: &str) {
        if !self.convert_top(&Ty::Int, &e.ty, e.span) {
            let d = self
                .mismatch(&Ty::Int, &e.ty, e.span)
                .note(format!("{what} must be an INTEGER"));
            self.error(d);
        }
    }

    fn return_stmt(&mut self) {
        let span = self.tok.span;
        self.advance();
        self.cur_mut().saw_return = true;
        let has_value = !self.tok.line_start
            && !self.at(Tok::Eof)
            && !matches!(self.tok.tok, Tok::Kw(k) if k.is_block_end());
        if self.cur().is_main() {
            self.error(
                Diagnostic::error("E0206", "RETURN outside of a PROCEDURE or FUNCTION")
                    .primary(span, "the main program cannot RETURN"),
            );
            if has_value {
                self.expr();
            }
            return;
        }
        match self.cur().ret.clone() {
            Some((ty, ret_span)) => {
                if !has_value {
                    let tn = self.ty_name(&ty);
                    self.error(
                        Diagnostic::error("E0206", "RETURN in a FUNCTION needs a value")
                            .primary(span, format!("expected a `{tn}` value after RETURN"))
                            .secondary(ret_span, "the function's return type"),
                    );
                    return;
                }
                let e = self.expr();
                if !self.convert_top(&ty, &e.ty, e.span) {
                    let tn = self.ty_name(&ty);
                    let d = self.mismatch(&ty, &e.ty, e.span).secondary(
                        ret_span,
                        format!("expected `{tn}` because of this return type"),
                    );
                    self.error(d);
                }
                self.emit(Op::Return, span);
            }
            None => {
                if has_value {
                    let e = self.expr();
                    self.error(
                        Diagnostic::error("E0206", "a PROCEDURE cannot return a value")
                            .primary(e.span, "unexpected value")
                            .help("make it a FUNCTION with `RETURNS <type>`, or remove the value"),
                    );
                }
                self.emit(Op::ReturnVoid, span);
            }
        }
    }

    fn jump_stmt(&mut self, k: Kw) {
        let span = self.tok.span;
        self.advance();
        if self.cur().loops.is_empty() {
            self.error(
                Diagnostic::error("E0205", format!("`{}` outside of a loop", k.as_str()))
                    .primary(span, "not inside WHILE, REPEAT or FOR"),
            );
            return;
        }
        let j = self.emit(Op::Jump(0), span);
        let ctx = self.cur_mut().loops.last_mut().unwrap();
        if k == Kw::Break {
            ctx.breaks.push(j)
        } else {
            ctx.continues.push(j)
        }
    }

    // -----------------------------------------------------------------------
    // Input / output
    // -----------------------------------------------------------------------

    fn output_stmt(&mut self) {
        let span = self.tok.span;
        self.advance();
        let mut n = 0u8;
        loop {
            let e = self.expr();
            if e.ty == Ty::Void {
                self.error(
                    Diagnostic::error("E0302", "cannot OUTPUT the result of a procedure")
                        .primary(e.span, "procedures do not produce a value"),
                );
            }
            n = n.saturating_add(1);
            if !self.eat(Tok::Comma) {
                break;
            }
        }
        self.emit(Op::Output(n), span);
    }

    /// Parse an assignable target for INPUT / READFILE / GETRECORD.
    fn input_target(&mut self, what: &str) -> Option<(super::expr::Place, Expr)> {
        let e = self.postfix();
        match e.place {
            Some(p) => {
                if let Some(v) = e.var {
                    self.mark_var(v, false, true);
                }
                Some((p, e))
            }
            None => {
                if e.ty != Ty::Error {
                    self.error(
                        Diagnostic::error(
                            "E0309",
                            format!("{what} needs a variable to store into"),
                        )
                        .primary(e.span, "not a variable"),
                    );
                }
                None
            }
        }
    }

    fn input_conv(&mut self, e: &Expr, what: &str) -> Conv {
        let c = e.ty.conv();
        if c == Conv::Any && !e.ty.is_dynamic() {
            let tn = self.ty_name(&e.ty);
            self.error(
                Diagnostic::error("E0300", format!("cannot {what} a value of type `{tn}`"))
                    .primary(e.span, format!("`{tn}` cannot be read from text"))
                    .help("read into a STRING, INTEGER, REAL, CHAR, BOOLEAN or DATE variable"),
            );
        }
        c
    }

    fn input_stmt(&mut self) {
        let span = self.tok.span;
        self.advance();
        let Some((place, e)) = self.input_target("INPUT") else {
            return;
        };
        let conv = self.input_conv(&e, "INPUT");
        self.emit(Op::Input(conv), span);
        self.emit_store(place, e.span);
    }

    fn file_name(&mut self, what: &str) -> Expr {
        let e = self.expr();
        if !matches!(e.ty, Ty::Str | Ty::Unknown | Ty::Error) {
            let d = self
                .mismatch(&Ty::Str, &e.ty, e.span)
                .note(format!("{what} takes the file name as a STRING"));
            self.error(d);
        }
        e
    }

    fn openfile_stmt(&mut self) {
        let span = self.tok.span;
        self.advance();
        self.file_name("OPENFILE");
        self.expect_kw(Kw::For, "after the file name");
        let mode = match self.tok.tok {
            Tok::Kw(Kw::Read) => FileMode::Read,
            Tok::Kw(Kw::Write) => FileMode::Write,
            Tok::Kw(Kw::Append) => FileMode::Append,
            Tok::Kw(Kw::Random) => FileMode::Random,
            _ => {
                let d = self
                    .expected_error("a file mode", "after FOR")
                    .help("valid modes: READ, WRITE, APPEND, RANDOM");
                self.parse_error(d);
                return;
            }
        };
        self.advance();
        self.emit(Op::OpenFile(mode), span);
    }

    /// READFILE f, Var  /  GETRECORD f, Var
    fn read_record_stmt(&mut self, k: Kw) {
        let span = self.tok.span;
        self.advance();
        let f = self.file_name(k.as_str());
        let tmp = self.hidden_var("file", Ty::Str, f.span);
        self.store_var(tmp, f.span);
        self.expect(Tok::Comma, "after the file name");
        let Some((place, e)) = self.input_target(k.as_str()) else {
            return;
        };
        self.load_var(tmp, f.span);
        if k == Kw::ReadFile {
            let conv = self.input_conv(&e, "READFILE");
            self.emit(Op::ReadFile(conv), span);
        } else {
            self.emit(Op::GetRecord, span);
        }
        self.emit_store(place, e.span);
    }

    /// WRITEFILE f, Expr  /  PUTRECORD f, Expr  /  SEEK f, Address
    fn write_record_stmt(&mut self, k: Kw) {
        let span = self.tok.span;
        self.advance();
        self.file_name(k.as_str());
        self.expect(Tok::Comma, "after the file name");
        let e = self.expr();
        let op = match k {
            Kw::WriteFile => Op::WriteFile,
            Kw::PutRecord => Op::PutRecord,
            _ => {
                self.int_operand(&e, "the SEEK address");
                Op::Seek
            }
        };
        self.emit(op, span);
    }
}
