//! End-to-end tests: compile and run programs through the `pseudo` binary.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

struct Output {
    stdout: String,
    stderr: String,
    code: i32,
}

fn workdir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pseudo-test-{}-{name}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn run_with(name: &str, src: &str, stdin: &str, args: &[&str]) -> Output {
    let dir = workdir(name);
    let file = dir.join("prog.pseudo");
    std::fs::write(&file, src).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_pseudo"))
        .args(args)
        .arg(&file)
        .arg("--no-color")
        .current_dir(&dir)
        .env("PSEUDO_SEED", "42")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(stdin.as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    let _ = std::fs::remove_dir_all(&dir);
    Output {
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        code: out.status.code().unwrap_or(-1),
    }
}

fn run(name: &str, src: &str) -> Output {
    run_with(name, src, "", &[])
}

#[track_caller]
fn expect_output(name: &str, src: &str, expected: &str) {
    let o = run(name, src);
    assert_eq!(o.code, 0, "program failed:\n{}", o.stderr);
    assert_eq!(o.stdout.trim_end(), expected.trim_end(), "stderr:\n{}", o.stderr);
}

/// Compile `src`, expecting a compile error with `code` whose rendering
/// contains every string in `needles`.
#[track_caller]
fn expect_error(name: &str, src: &str, code: &str, needles: &[&str]) {
    let o = run(name, src);
    assert_eq!(o.code, 1, "expected a compile error, got exit {}:\n{}{}", o.code, o.stdout, o.stderr);
    assert!(o.stderr.contains(&format!("[{code}]")), "missing {code}:\n{}", o.stderr);
    for n in needles {
        assert!(o.stderr.contains(n), "missing {n:?} in:\n{}", o.stderr);
    }
}

#[track_caller]
fn expect_runtime_error(name: &str, src: &str, code: &str, needles: &[&str]) {
    let o = run(name, src);
    assert_eq!(o.code, 2, "expected a runtime error, got exit {}:\n{}{}", o.code, o.stdout, o.stderr);
    assert!(o.stderr.contains(&format!("[{code}]")), "missing {code}:\n{}", o.stderr);
    for n in needles {
        assert!(o.stderr.contains(n), "missing {n:?} in:\n{}", o.stderr);
    }
}

// ---------------------------------------------------------------------------
// Programs
// ---------------------------------------------------------------------------

#[test]
fn examples_run() {
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
    let basics = std::fs::read_to_string(format!("{root}/examples/basics.pseudo")).unwrap();
    expect_output(
        "basics",
        &basics,
        "Sum of squares: 385\nAverage: 38.5\nAfter swap: X=2 Y=1\n10! = 3628800\n\
         PSEUDOCODE has 10 letters; middle: eudo\nGood\n(keep going)\ncounting\none left\ndone",
    );
    let shapes = std::fs::read_to_string(format!("{root}/examples/shapes.pseudo")).unwrap();
    expect_output(
        "shapes",
        &shapes,
        "rectangle with area 12.0\ncircle with area 3.14\npoint with area 0.0\nTotal area: 15.14\n\
         Largest: rectangle with area 12.0",
    );
    let records = std::fs::read_to_string(format!("{root}/examples/records.pseudo")).unwrap();
    let o = run_with("records", &records, "17\n", &[]);
    assert_eq!(o.code, 0, "{}", o.stderr);
    assert!(o.stdout.contains("Ada / Grace"));
    assert!(o.stdout.contains("Through the pointer: 42"));
    assert!(o.stdout.contains("Marks: [90, 86, 99]"));
    assert!(o.stdout.contains("read: line 3"));
    assert!(o.stdout.contains("Next year you will be 18"));
}

#[test]
fn spec_class_example() {
    expect_output(
        "spec_class",
        r#"
CLASS Pet
    PRIVATE Name : STRING
    PUBLIC PROCEDURE NEW(GivenName : STRING)
        Name ← GivenName
    ENDPROCEDURE
    PUBLIC FUNCTION GetName() RETURNS STRING
        RETURN Name
    ENDFUNCTION
ENDCLASS

CLASS Cat INHERITS Pet
    PRIVATE Breed: STRING
    PUBLIC PROCEDURE NEW(GivenName : STRING, GivenBreed : STRING)
        SUPER.NEW(GivenName)
        Breed ← GivenBreed
    ENDPROCEDURE
    PUBLIC FUNCTION Describe() RETURNS STRING
        RETURN GetName() & " the " & Breed
    ENDFUNCTION
ENDCLASS

DECLARE MyCat : Cat
MyCat ← NEW Cat("Kitty", "Shorthaired")
OUTPUT MyCat.Describe()
"#,
        "Kitty the Shorthaired",
    );
}

#[test]
fn dynamic_dispatch_and_overrides() {
    expect_output(
        "dispatch",
        r#"
CLASS Animal
    PUBLIC FUNCTION Speak() RETURNS STRING
        RETURN "..."
    ENDFUNCTION
    PUBLIC FUNCTION Greet() RETURNS STRING
        RETURN "I say " & Speak()
    ENDFUNCTION
ENDCLASS
CLASS Dog INHERITS Animal
    PUBLIC FUNCTION Speak() RETURNS STRING
        RETURN "Woof"
    ENDFUNCTION
ENDCLASS
CLASS Cow INHERITS Animal
    PUBLIC FUNCTION Speak() RETURNS STRING
        RETURN "Moo"
    ENDFUNCTION
ENDCLASS
DECLARE Zoo : ARRAY[1:3] OF Animal
Zoo[1] ← NEW Dog()
Zoo[2] ← NEW Cow()
Zoo[3] ← NEW Animal()
FOR I ← 1 TO 3
    OUTPUT Zoo[I].Greet()
NEXT I
"#,
        "I say Woof\nI say Moo\nI say ...",
    );
}

#[test]
fn forward_references_and_byref_patching() {
    expect_output(
        "forward",
        r#"
DECLARE A, B : INTEGER
A ← 1
B ← 2
CALL Swap(A, B)
OUTPUT A, " ", B, " ", Twice(21)

PROCEDURE Swap(BYREF X : INTEGER, BYREF Y : INTEGER)
    DECLARE T : INTEGER
    T ← X
    X ← Y
    Y ← T
ENDPROCEDURE

FUNCTION Twice(N : INTEGER) RETURNS INTEGER
    RETURN N * 2
ENDFUNCTION
"#,
        "2 1 42",
    );
}

#[test]
fn self_sends_to_later_methods() {
    expect_output(
        "selfsend",
        r#"
CLASS Greeter
    PUBLIC PROCEDURE Run()
        CALL Hello("world")
    ENDPROCEDURE
    PRIVATE PROCEDURE Hello(Who : STRING)
        OUTPUT "Hello, ", Who
    ENDPROCEDURE
ENDCLASS
DECLARE G : Greeter
G ← NEW Greeter()
CALL G.Run()
"#,
        "Hello, world",
    );
}

#[test]
fn control_flow() {
    expect_output(
        "control",
        r#"
DECLARE N : INTEGER
N ← 0
WHILE TRUE
    N ← N + 1
    IF N MOD 2 = 0 THEN
        CONTINUE
    ENDIF
    IF N > 7 THEN
        BREAK
    ENDIF
    OUTPUT N
ENDWHILE
FOR I ← 10 TO 1 STEP -3
    OUTPUT "i", I
NEXT I
CASE OF N
    1 TO 5 : OUTPUT "small"
    9 : OUTPUT "nine"
    OTHERWISE : OUTPUT "other"
ENDCASE
"#,
        "1\n3\n5\n7\ni10\ni7\ni4\ni1\nnine",
    );
}

#[test]
fn short_circuit_and_types() {
    expect_output(
        "types",
        r#"
DECLARE Arr : ARRAY[1:3] OF INTEGER
DECLARE I : INTEGER
I ← 4
IF I <= 3 AND Arr[I] = 0 THEN
    OUTPUT "unreachable"
ENDIF
OUTPUT 7 DIV 2, " ", 7 MOD 2, " ", 7 / 2, " ", DIV(9, 4), " ", INT(3.9)
OUTPUT "a" & 'b' & "c", " ", LENGTH("hello"), " ", ASC('A'), " ", CHR(66)
OUTPUT NUM_TO_STR(12) & "!", " ", STR_TO_NUM("2.5") * 2, " ", INTEGER("42") + 1
OUTPUT LEFT("abcdef", 2), RIGHT("abcdef", 2), " ", LCASE("ABC"), " ", UCASE('q')
"#,
        "3 1 3.5 2 3\nabc 5 65 B\n12! 5.0 43\nabef abc Q",
    );
}

#[test]
fn two_dimensional_arrays_and_records() {
    expect_output(
        "grid",
        r#"
TYPE Point
    DECLARE X : INTEGER
    DECLARE Y : INTEGER
ENDTYPE
DECLARE Grid : ARRAY[1:3, 1:3] OF INTEGER
DECLARE P, Q : Point
FOR R ← 1 TO 3
    FOR C ← 1 TO 3
        Grid[R, C] ← R * C
    NEXT C
NEXT R
P.X ← 1
P.Y ← 2
Q ← P
Q.X ← 99
OUTPUT Grid[2, 3], " ", P.X, " ", Q.X, " ", P = Q
"#,
        "6 1 99 FALSE",
    );
}

#[test]
fn random_files() {
    expect_output(
        "random",
        r#"
TYPE Item
    DECLARE Name : STRING
    DECLARE Qty : INTEGER
ENDTYPE
DECLARE It, Back : Item
OPENFILE "stock.dat" FOR RANDOM
FOR K ← 1 TO 3
    It.Name ← "item" & NUM_TO_STR(K)
    It.Qty ← K * 10
    SEEK "stock.dat", K
    PUTRECORD "stock.dat", It
NEXT K
SEEK "stock.dat", 2
GETRECORD "stock.dat", Back
CLOSEFILE "stock.dat"
OUTPUT Back.Name, " ", Back.Qty
"#,
        "item2 20",
    );
}

// ---------------------------------------------------------------------------
// Compile-time diagnostics
// ---------------------------------------------------------------------------

#[test]
fn spec_example_type_bug_is_reported() {
    expect_error(
        "specbug",
        r#"
CLASS Pet
    PRIVATE Name : STRING
    PUBLIC PROCEDURE NEW(GivenName : STRING)
        Name ← GivenName
    ENDPROCEDURE
ENDCLASS
CLASS Cat INHERITS Pet
    PRIVATE Breed: INTEGER
    PUBLIC PROCEDURE NEW(GivenName : STRING, GivenBreed : STRING)
        SUPER.NEW(GivenName)
        Breed ← GivenBreed
    ENDPROCEDURE
ENDCLASS
"#,
        "E0300",
        &["expected `INTEGER`, found `STRING`", "STR_TO_NUM(GivenBreed)"],
    );
}

#[test]
fn assignment_with_equals() {
    expect_error("eq", "DECLARE X : INTEGER\nX = 5\nOUTPUT X\n", "E0100", &["X ← 5"]);
}

#[test]
fn concat_number_suggests_conversion() {
    expect_error("concat", "DECLARE N : INTEGER\nN ← 3\nOUTPUT \"N=\" & N\n", "E0303", &["NUM_TO_STR(N)"]);
}

#[test]
fn typo_suggests_name() {
    expect_error(
        "typo",
        "DECLARE Counter : INTEGER\nCounter ← 1\nOUTPUT Countr\n",
        "E0200",
        &["cannot find `Countr`", "OUTPUT Counter"],
    );
}

#[test]
fn lowercase_keyword() {
    expect_error("lower", "DECLARE A : INTEGER\nA ← 1\nif A > 0 THEN\n  OUTPUT A\nENDIF\n", "E0103", &["IF A > 0"]);
}

#[test]
fn unclosed_and_mismatched_blocks() {
    expect_error("unclosed", "IF TRUE THEN\n  OUTPUT 1\n", "E0101", &["this `IF` is never closed"]);
    let o = run("mismatch", "WHILE TRUE\n  OUTPUT 1\nENDIF\n");
    assert!(o.stderr.contains("[E0102]"), "{}", o.stderr);
    assert_eq!(o.stderr.matches("error[").count(), 1, "cascading errors:\n{}", o.stderr);
}

#[test]
fn constant_index_out_of_bounds() {
    expect_error("oob", "DECLARE A : ARRAY[1:5] OF INTEGER\nA[0] ← 1\n", "E0304", &["index 0 is outside 1:5"]);
}

#[test]
fn wrong_argument_count() {
    expect_error(
        "arity",
        "FUNCTION F(A : INTEGER) RETURNS INTEGER\n  RETURN A\nENDFUNCTION\nOUTPUT F(1, 2)\n",
        "E0301",
        &["takes 1 argument but 2 were supplied", "defined here"],
    );
}

#[test]
fn deferred_call_checks() {
    expect_error(
        "deferred",
        "CALL P(5)\nPROCEDURE P(BYREF X : INTEGER)\n  X ← 1\nENDPROCEDURE\n",
        "E0308",
        &["needs a variable"],
    );
    expect_error(
        "deferred2",
        "DECLARE V : INTEGER\nV ← Q()\nPROCEDURE Q()\nENDPROCEDURE\n",
        "E0302",
        &["does not return a value"],
    );
    expect_error("undefined", "CALL Missing()\n", "E0200", &["cannot find procedure or function `Missing`"]);
}

#[test]
fn private_member_access() {
    expect_error(
        "private",
        "CLASS A\n  PRIVATE Secret : INTEGER\nENDCLASS\nDECLARE X : A\nX ← NEW A()\nOUTPUT X.Secret\n",
        "E0307",
        &["is private", "declared PRIVATE here"],
    );
}

#[test]
fn next_mismatch() {
    expect_error("next", "FOR I ← 1 TO 3\nNEXT J\n", "E0204", &["NEXT I"]);
}

#[test]
fn function_without_return() {
    expect_error("noreturn", "FUNCTION F() RETURNS INTEGER\n  OUTPUT 1\nENDFUNCTION\n", "E0207", &["never returns"]);
}

#[test]
fn warnings_do_not_block_running() {
    let o = run("warn", "DECLARE Unused : INTEGER\nOUTPUT 1\n");
    assert_eq!(o.code, 0);
    assert!(o.stderr.contains("warning[W0001]"), "{}", o.stderr);
    let o = run_with("deny", "DECLARE Unused : INTEGER\nOUTPUT 1\n", "", &["--deny-warnings"]);
    assert_eq!(o.code, 1);
}

// ---------------------------------------------------------------------------
// Run-time errors
// ---------------------------------------------------------------------------

#[test]
fn runtime_out_of_bounds_has_backtrace_and_locals() {
    expect_runtime_error(
        "rt_oob",
        r#"
DECLARE Data : ARRAY[1:5] OF INTEGER
PROCEDURE Fill(N : INTEGER)
    FOR I ← 1 TO N
        Data[I] ← I
    NEXT I
ENDPROCEDURE
CALL Fill(6)
"#,
        "R0001",
        &["index 6 is outside 1:5", "off-by-one", "I = 6", "called from the main program"],
    );
}

#[test]
fn runtime_uninitialized_variable() {
    expect_runtime_error(
        "rt_uninit",
        "DECLARE X : INTEGER\nOUTPUT X + 1\n",
        "R0002",
        &["use of uninitialized variable `X`", "declared here"],
    );
}

#[test]
fn runtime_division_by_zero() {
    expect_runtime_error("rt_div", "DECLARE Z : INTEGER\nZ ← 0\nOUTPUT 10 DIV Z\n", "R0003", &["division by zero"]);
}

#[test]
fn runtime_recursion_is_collapsed() {
    expect_runtime_error(
        "rt_rec",
        "FUNCTION F(N : INTEGER) RETURNS INTEGER\n  RETURN F(N + 1)\nENDFUNCTION\nOUTPUT F(0)\n",
        "R0007",
        &["stack overflow", "times, recursively"],
    );
}

#[test]
fn runtime_bad_input() {
    let o = run_with("rt_input", "DECLARE N : INTEGER\nINPUT N\n", "abc\n", &[]);
    assert_eq!(o.code, 2);
    assert!(o.stderr.contains("invalid input for INTEGER"), "{}", o.stderr);
}

#[test]
fn explain_and_disasm() {
    let out = Command::new(env!("CARGO_BIN_EXE_pseudo")).args(["explain", "E0300"]).output().unwrap();
    assert!(String::from_utf8_lossy(&out.stdout).contains("NUM_TO_STR"));
    let o = run_with("disasm", "DECLARE A : INTEGER\nA ← 1\nOUTPUT A\n", "", &["disasm"]);
    assert!(o.stdout.contains("STORE_GLOBAL g0(A)"), "{}", o.stdout);
}
