# pseudo

A compiler and virtual machine for Cambridge-style pseudocode, written in Rust
with no dependencies.

```
$ pseudo examples/shapes.pseudo
rectangle with area 12.0
circle with area 3.14
...
```

## Usage

```
pseudo [run] <file> [--trace] [--stats]   compile and run
pseudo check <file>                       type-check only
pseudo disasm <file>                      bytecode + debug info
pseudo tokens <file>                      token stream
pseudo explain <CODE>                     long explanation of an error code
```

Exit codes: `0` success, `1` compile error, `2` run-time error.
`--deny-warnings` turns warnings into errors; `NO_COLOR=1` or `--no-color`
disables colour; `PSEUDO_SEED` makes `RAND` deterministic.

## Architecture

```
source ──► Lexer ◄─pull── Compiler ──► Program (bytecode + debug info) ──► VM
           (lazy)         (parse + type-check + emit, one pass)
```

**No token list, no AST.** The lexer is a cursor that the compiler pulls one
token from at a time (with one token of lookahead). The recursive-descent
compiler type-checks and emits bytecode as it parses.

* **Deferred loads (Lua's `expdesc` technique).** An expression is compiled
  into a descriptor such as "local slot 3", "element of the array on the
  stack" or "field 2 of the object on the stack". The final instruction is
  only emitted once the context is known. The same parse of `A[I].Name` can
  then become a load, the target of `←`, or a reference passed `BYREF`,
  without building a tree.
* **Forward references without a second pass.** A call to a routine defined
  later in the file is compiled against a placeholder and recorded. When the
  file ends, it is checked against the real signature: arity, argument
  types, and procedure-versus-function use. If a parameter turns out to be
  `BYREF`, the argument's load instruction is patched in place into the
  matching reference instruction (`LOAD_LOCAL` → `REF_LOCAL`, `INDEX` →
  `INDEX_REF`, ...). Inside a class, unknown calls are re-resolved at
  `ENDCLASS`, and may become sends to `SELF`.
* **Gradual typing at the edges.** Everything is statically typed except the
  results of forward calls. Where such a value meets a typed slot, a
  `CHECK` instruction verifies it at run time.
* **Superinstructions.** `FOR` loops compile to fused `FOR_CHECK`/`FOR_STEP`
  instructions, and negative literals are folded.

### Smalltalk-style objects

* **Fixed slot layouts ("shapes"/maps).** A subclass layout extends its
  parent's, so field access on a statically known class is one indexed
  load. Receivers whose type is not known statically use
  `GET_FIELD_NAMED`, with a per-site cache from shape to slot.
* **Message sends with per-site inline caches.** Each send site moves from
  empty → monomorphic → polymorphic (up to 4 receiver classes) →
  megamorphic.
* **Global lookup cache.** Misses and megamorphic sites go through a
  `(class, selector) → method` cache, as in Smalltalk-80, before falling back
  to walking method dictionaries up the superclass chain.
* **Interned selectors.** `SUPER` sends are bound statically. `NEW` runs
  the constructor and returns the receiver. An unknown message raises
  `R0010 ... does not understand` (Smalltalk's `doesNotUnderstand:`).

`--stats` reports instruction counts and the state of each inline cache:

```
inline cache hits     : 999999 monomorphic, 0 polymorphic
send sites (2 total):
  @ic0: polymorphic [Rectangle, Circle, Shape]
```

## Diagnostics

Errors follow rustc: codes, primary and secondary labels, notes, and
suggested fixes that show the corrected line.

```
error[E0300]: mismatched types
  --> spec.pseudo:12:17
   |
12 |         Breed ← GivenBreed
   |         -----   ^^^^^^^^^^ expected `INTEGER`, found `STRING`
   |         |
   |         this has type `INTEGER`
   |
help: parse the text as a number
   |
12 |         Breed ← STR_TO_NUM(GivenBreed)
   |                 ~~~~~~~~~~~~~~~~~~~~~~
```

Some of the cases covered:

* "did you mean" for misspelled names, fields, methods and types
* lower-case keywords (`if` → `IF`)
* `=` used for assignment
* `"a" & 3` → suggests `NUM_TO_STR(3)`
* chained comparisons
* mismatched or unclosed blocks, with a label pointing at the opening keyword
* `NEXT J` closing `FOR I`
* private-member access, including from a subclass
* incompatible overrides
* a constant array index that is out of bounds
* functions that never return
* unreachable code, unused variables and shadowing (as warnings)

**Run-time errors** point at the failing expression. They include:

* a backtrace, with recursive frames collapsed
* the values of every variable in the failing frame
* a hint where one applies, such as "one past the end: check the loop's
  upper bound"

Reading an uninitialised variable, array element or field is caught and
reported with its declaration.

`pseudo disasm` prints bytecode with source lines interleaved, `line:col`
for every instruction, the local-variable table of each routine, globals,
and shapes with their method dictionaries. `--trace` prints each executed
instruction with the top of the stack.

## Language notes

The grammar in the specification is implemented, plus:

* `PROCEDURE Name(BYREF A : INTEGER, B : REAL) ... ENDPROCEDURE` and
  `FUNCTION Name(...) RETURNS Type ... ENDFUNCTION`.
* `CLASS ... [INHERITS ...] ... ENDCLASS` with `PUBLIC`/`PRIVATE` fields and
  methods, `NEW Class(...)` and `SUPER.Method(...)`.
* `ELSE IF` on one line continues the chain and shares the `ENDIF`. `ELSE`
  followed by `IF` on a new line starts a nested `IF`.
* `DO` after `WHILE` and the colon after `OTHERWISE` are optional.
* `AND` binds tighter than `OR` (the grammar puts them at one level); both
  short-circuit.
* An undeclared `FOR` counter is declared implicitly as `INTEGER`.
* INTEGER widens to REAL and CHAR to STRING implicitly. No other conversion
  is implicit.
* Records and arrays are copied on assignment. Objects are references.
* Date literals are `dd/mm/yyyy`.
* Built-ins: `LENGTH LEFT RIGHT MID SUBSTRING UCASE LCASE TO_UPPER TO_LOWER
  NUM_TO_STR STR_TO_NUM IS_NUM ASC CHR INT RAND ROUND EOF DAY MONTH YEAR
  DAYINDEX SETDATE NOW`.

## Layout

| Path | Contents |
|------|----------|
| `src/lexer.rs` | on-demand lexer |
| `src/compiler/` | single-pass compiler (`expr`, `stmt`, `decl`, `types`) |
| `src/bytecode.rs` | instruction set, prototypes, shapes, disassembler |
| `src/vm/` | interpreter, inline caches, built-ins, files, run-time errors |
| `src/diag.rs` | diagnostic model and rustc-style renderer |
| `src/explain.rs` | `pseudo explain` texts |
| `tests/cli.rs` | end-to-end tests |
| `examples/` | sample programs |
