/** End-to-end tests: compile and run programs through the Effect runtime with in-memory I/O. */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Cause, Effect, Exit, Fiber, Option } from "effect";
import { compile, explain, memoryIo, Renderer, runSource, Session, Source, Stdin } from "../src/mod.ts";

interface Outcome {
  /** 0 = success, 1 = compile error, 2 = run-time error (as the CLI's exit code). */
  readonly code: 0 | 1 | 2;
  readonly output: string;
  readonly messages: string;
}

async function run(text: string, inputs: string[] = []): Promise<Outcome> {
  const source = new Source("prog.pseudo", text);
  const io = memoryIo(inputs);
  const exit = await Effect.runPromiseExit(runSource(source).pipe(Effect.provide(io.layer)));
  const r = new Renderer(source);
  const output = io.output.join("\n");
  if (Exit.isSuccess(exit)) {
    return { code: 0, output, messages: exit.value.diagnostics.sorted().map((d) => r.render(d)).join("\n") };
  }
  const failure = Cause.failureOption(exit.cause);
  if (Option.isNone(failure)) throw Cause.squash(exit.cause);
  const e = failure.value;
  if (e._tag === "CompileError") return { code: 1, output, messages: e.diagnostics.map((d) => r.render(d)).join("\n") };
  return { code: 2, output, messages: r.render(e.error.toDiagnostic()) };
}

async function expectOutput(text: string, expected: string, inputs: string[] = []): Promise<void> {
  const o = await run(text, inputs);
  assertEquals(o.code, 0, o.messages);
  assertEquals(o.output.trimEnd(), expected.trimEnd(), o.messages);
}

/** A compile error (`E` codes, exit code 1) or run-time error (`R` codes, exit code 2) whose message has `needles`. */
async function expectError(text: string, code: string, needles: string[]): Promise<void> {
  const o = await run(text);
  assertEquals(o.code, code.startsWith("R") ? 2 : 1, `expected ${code}, got:\n${o.output}${o.messages}`);
  assertStringIncludes(o.messages, `[${code}]`);
  for (const n of needles) assertStringIncludes(o.messages, n);
}

const example = (name: string) => Deno.readTextFile(new URL(`../../examples/${name}.pseudo`, import.meta.url));

// ---------------------------------------------------------------------------
// Programs
// ---------------------------------------------------------------------------

Deno.test("examples run", async () => {
  await expectOutput(
    await example("basics"),
    "Sum of squares: 385\nAverage: 38.5\nAfter swap: X=2 Y=1\n10! = 3628800\n" +
      "PSEUDOCODE has 10 letters; middle: eudo\nGood\n(keep going)\ncounting\none left\ndone",
  );
  await expectOutput(
    await example("shapes"),
    "rectangle with area 12.0\ncircle with area 3.14\npoint with area 0.0\nTotal area: 15.14\n" +
      "Largest: rectangle with area 12.0",
  );
  const o = await run(await example("records"), ["17"]);
  assertEquals(o.code, 0, o.messages);
  for (
    const s of [
      "Ada / Grace",
      "Through the pointer: 42",
      "Marks: [90, 86, 99]",
      "read: line 3",
      "Next year you will be 18",
    ]
  ) {
    assertStringIncludes(o.output, s);
  }
});

Deno.test("spec class example", () =>
  expectOutput(
    '\nCLASS Pet\n    PRIVATE Name : STRING\n    PUBLIC PROCEDURE NEW(GivenName : STRING)\n        Name ← GivenName\n    ENDPROCEDURE\n    PUBLIC FUNCTION GetName() RETURNS STRING\n        RETURN Name\n    ENDFUNCTION\nENDCLASS\n\nCLASS Cat INHERITS Pet\n    PRIVATE Breed: STRING\n    PUBLIC PROCEDURE NEW(GivenName : STRING, GivenBreed : STRING)\n        SUPER.NEW(GivenName)\n        Breed ← GivenBreed\n    ENDPROCEDURE\n    PUBLIC FUNCTION Describe() RETURNS STRING\n        RETURN GetName() & " the " & Breed\n    ENDFUNCTION\nENDCLASS\n\nDECLARE MyCat : Cat\nMyCat ← NEW Cat("Kitty", "Shorthaired")\nOUTPUT MyCat.Describe()\n',
    "Kitty the Shorthaired",
  ));

Deno.test("dynamic dispatch and overrides", () =>
  expectOutput(
    '\nCLASS Animal\n    PUBLIC FUNCTION Speak() RETURNS STRING\n        RETURN "..."\n    ENDFUNCTION\n    PUBLIC FUNCTION Greet() RETURNS STRING\n        RETURN "I say " & Speak()\n    ENDFUNCTION\nENDCLASS\nCLASS Dog INHERITS Animal\n    PUBLIC FUNCTION Speak() RETURNS STRING\n        RETURN "Woof"\n    ENDFUNCTION\nENDCLASS\nCLASS Cow INHERITS Animal\n    PUBLIC FUNCTION Speak() RETURNS STRING\n        RETURN "Moo"\n    ENDFUNCTION\nENDCLASS\nDECLARE Zoo : ARRAY[1:3] OF Animal\nZoo[1] ← NEW Dog()\nZoo[2] ← NEW Cow()\nZoo[3] ← NEW Animal()\nFOR I ← 1 TO 3\n    OUTPUT Zoo[I].Greet()\nNEXT I\n',
    "I say Woof\nI say Moo\nI say ...",
  ));

Deno.test("forward references and BYREF patching", () =>
  expectOutput(
    '\nDECLARE A, B : INTEGER\nA ← 1\nB ← 2\nCALL Swap(A, B)\nOUTPUT A, " ", B, " ", Twice(21)\n\nPROCEDURE Swap(BYREF X : INTEGER, BYREF Y : INTEGER)\n    DECLARE T : INTEGER\n    T ← X\n    X ← Y\n    Y ← T\nENDPROCEDURE\n\nFUNCTION Twice(N : INTEGER) RETURNS INTEGER\n    RETURN N * 2\nENDFUNCTION\n',
    "2 1 42",
  ));

Deno.test("self sends to later methods", () =>
  expectOutput(
    '\nCLASS Greeter\n    PUBLIC PROCEDURE Run()\n        CALL Hello("world")\n    ENDPROCEDURE\n    PRIVATE PROCEDURE Hello(Who : STRING)\n        OUTPUT "Hello, ", Who\n    ENDPROCEDURE\nENDCLASS\nDECLARE G : Greeter\nG ← NEW Greeter()\nCALL G.Run()\n',
    "Hello, world",
  ));

Deno.test("control flow", () =>
  expectOutput(
    '\nDECLARE N : INTEGER\nN ← 0\nWHILE TRUE\n    N ← N + 1\n    IF N MOD 2 = 0 THEN\n        CONTINUE\n    ENDIF\n    IF N > 7 THEN\n        BREAK\n    ENDIF\n    OUTPUT N\nENDWHILE\nFOR I ← 10 TO 1 STEP -3\n    OUTPUT "i", I\nNEXT I\nCASE OF N\n    1 TO 5 : OUTPUT "small"\n    9 : OUTPUT "nine"\n    OTHERWISE : OUTPUT "other"\nENDCASE\n',
    "1\n3\n5\n7\ni10\ni7\ni4\ni1\nnine",
  ));

Deno.test("short circuit and types", () =>
  expectOutput(
    '\nDECLARE Arr : ARRAY[1:3] OF INTEGER\nDECLARE I : INTEGER\nI ← 4\nIF I <= 3 AND Arr[I] = 0 THEN\n    OUTPUT "unreachable"\nENDIF\nOUTPUT 7 DIV 2, " ", 7 MOD 2, " ", 7 / 2, " ", DIV(9, 4), " ", INT(3.9)\nOUTPUT "a" & \'b\' & "c", " ", LENGTH("hello"), " ", ASC(\'A\'), " ", CHR(66)\nOUTPUT NUM_TO_STR(12) & "!", " ", STR_TO_NUM("2.5") * 2, " ", INTEGER("42") + 1\nOUTPUT LEFT("abcdef", 2), RIGHT("abcdef", 2), " ", LCASE("ABC"), " ", UCASE(\'q\')\n',
    "3 1 3.5 2 3\nabc 5 65 B\n12! 5.0 43\nabef abc Q",
  ));

Deno.test("two-dimensional arrays and records", () =>
  expectOutput(
    '\nTYPE Point\n    DECLARE X : INTEGER\n    DECLARE Y : INTEGER\nENDTYPE\nDECLARE Grid : ARRAY[1:3, 1:3] OF INTEGER\nDECLARE P, Q : Point\nFOR R ← 1 TO 3\n    FOR C ← 1 TO 3\n        Grid[R, C] ← R * C\n    NEXT C\nNEXT R\nP.X ← 1\nP.Y ← 2\nQ ← P\nQ.X ← 99\nOUTPUT Grid[2, 3], " ", P.X, " ", Q.X, " ", P = Q\n',
    "6 1 99 FALSE",
  ));

Deno.test("random files", () =>
  expectOutput(
    '\nTYPE Item\n    DECLARE Name : STRING\n    DECLARE Qty : INTEGER\nENDTYPE\nDECLARE It, Back : Item\nOPENFILE "stock.dat" FOR RANDOM\nFOR K ← 1 TO 3\n    It.Name ← "item" & NUM_TO_STR(K)\n    It.Qty ← K * 10\n    SEEK "stock.dat", K\n    PUTRECORD "stock.dat", It\nNEXT K\nSEEK "stock.dat", 2\nGETRECORD "stock.dat", Back\nCLOSEFILE "stock.dat"\nOUTPUT Back.Name, " ", Back.Qty\n',
    "item2 20",
  ));

// ---------------------------------------------------------------------------
// Compile-time diagnostics
// ---------------------------------------------------------------------------

Deno.test("the specification's class example has a type bug", () =>
  expectError(
    "\nCLASS Pet\n    PRIVATE Name : STRING\n    PUBLIC PROCEDURE NEW(GivenName : STRING)\n        Name ← GivenName\n    ENDPROCEDURE\nENDCLASS\nCLASS Cat INHERITS Pet\n    PRIVATE Breed: INTEGER\n    PUBLIC PROCEDURE NEW(GivenName : STRING, GivenBreed : STRING)\n        SUPER.NEW(GivenName)\n        Breed ← GivenBreed\n    ENDPROCEDURE\nENDCLASS\n",
    "E0300",
    ["expected `INTEGER`, found `STRING`", "STR_TO_NUM(GivenBreed)"],
  ));

Deno.test("assignment with =", () => expectError("DECLARE X : INTEGER\nX = 5\nOUTPUT X\n", "E0100", ["X ← 5"]));

Deno.test("concatenating a number suggests NUM_TO_STR", () =>
  expectError('DECLARE N : INTEGER\nN ← 3\nOUTPUT "N=" & N\n', "E0303", ["NUM_TO_STR(N)"]));

Deno.test("typos suggest a name", () =>
  expectError("DECLARE Counter : INTEGER\nCounter ← 1\nOUTPUT Countr\n", "E0200", [
    "cannot find `Countr`",
    "OUTPUT Counter",
  ]));

Deno.test("lower-case keyword", () =>
  expectError("DECLARE A : INTEGER\nA ← 1\nif A > 0 THEN\n  OUTPUT A\nENDIF\n", "E0103", ["IF A > 0"]));

Deno.test("unclosed and mismatched blocks", async () => {
  await expectError("IF TRUE THEN\n  OUTPUT 1\n", "E0101", ["this `IF` is never closed"]);
  const o = await run("WHILE TRUE\n  OUTPUT 1\nENDIF\n");
  assertStringIncludes(o.messages, "[E0102]");
  assertEquals(o.messages.match(/error\[/g)?.length, 1, `cascading errors:\n${o.messages}`);
});

Deno.test("constant index out of bounds", () =>
  expectError("DECLARE A : ARRAY[1:5] OF INTEGER\nA[0] ← 1\n", "E0304", ["index 0 is outside 1:5"]));

Deno.test("wrong argument count", () =>
  expectError(
    "FUNCTION F(A : INTEGER) RETURNS INTEGER\n  RETURN A\nENDFUNCTION\nOUTPUT F(1, 2)\n",
    "E0301",
    ["takes 1 argument but 2 were supplied", "defined here"],
  ));

Deno.test("deferred call checks", async () => {
  await expectError("CALL P(5)\nPROCEDURE P(BYREF X : INTEGER)\n  X ← 1\nENDPROCEDURE\n", "E0308", [
    "needs a variable",
  ]);
  await expectError("DECLARE V : INTEGER\nV ← Q()\nPROCEDURE Q()\nENDPROCEDURE\n", "E0302", [
    "does not return a value",
  ]);
  await expectError("CALL Missing()\n", "E0200", ["cannot find procedure or function `Missing`"]);
});

Deno.test("private member access", () =>
  expectError(
    "CLASS A\n  PRIVATE Secret : INTEGER\nENDCLASS\nDECLARE X : A\nX ← NEW A()\nOUTPUT X.Secret\n",
    "E0307",
    ["is private", "declared PRIVATE here"],
  ));

Deno.test("NEXT mismatch", () => expectError("FOR I ← 1 TO 3\nNEXT J\n", "E0204", ["NEXT I"]));

Deno.test("function without RETURN", () =>
  expectError("FUNCTION F() RETURNS INTEGER\n  OUTPUT 1\nENDFUNCTION\n", "E0207", ["never returns"]));

Deno.test("warnings do not block running", async () => {
  const o = await run("DECLARE Unused : INTEGER\nOUTPUT 1\n");
  assertEquals(o.code, 0);
  assertStringIncludes(o.messages, "warning[W0001]");
});

// ---------------------------------------------------------------------------
// Run-time errors
// ---------------------------------------------------------------------------

Deno.test("run-time out of bounds has a backtrace and locals", () =>
  expectError(
    "\nDECLARE Data : ARRAY[1:5] OF INTEGER\nPROCEDURE Fill(N : INTEGER)\n    FOR I ← 1 TO N\n        Data[I] ← I\n    NEXT I\nENDPROCEDURE\nCALL Fill(6)\n",
    "R0001",
    ["index 6 is outside 1:5", "off-by-one", "I = 6", "called from the main program"],
  ));

Deno.test("uninitialized variable", () =>
  expectError("DECLARE X : INTEGER\nOUTPUT X + 1\n", "R0002", [
    "use of uninitialized variable `X`",
    "declared here",
  ]));

Deno.test("division by zero", () =>
  expectError("DECLARE Z : INTEGER\nZ ← 0\nOUTPUT 10 DIV Z\n", "R0003", ["division by zero"]));

Deno.test("deep recursion is collapsed in the backtrace", () =>
  expectError(
    "FUNCTION F(N : INTEGER) RETURNS INTEGER\n  RETURN F(N + 1)\nENDFUNCTION\nOUTPUT F(0)\n",
    "R0007",
    ["stack overflow", "times, recursively"],
  ));

Deno.test("bad input", async () => {
  const o = await run("DECLARE N : INTEGER\nINPUT N\n", ["abc"]);
  assertEquals(o.code, 2);
  assertStringIncludes(o.messages, "invalid input for INTEGER");
});

Deno.test("explain and disassemble", () => {
  assertStringIncludes(explain("E0300")!, "NUM_TO_STR");
  const src = new Source("d.pseudo", "DECLARE A : INTEGER\nA ← 1\nOUTPUT A\n");
  assertStringIncludes(compile(src).program!.disassemble(src), "STORE_GLOBAL g0(A)");
});

// ---------------------------------------------------------------------------
// Effect runtime: sessions, asynchronous input, interruption
// ---------------------------------------------------------------------------

Deno.test("REPL session keeps state and echoes values", async () => {
  const io = memoryIo();
  const s = new Session();
  const submit = (input: string) => Effect.runPromise(s.submit(input).pipe(Effect.provide(io.layer)));
  const r1 = await submit("DECLARE X : INTEGER");
  assertEquals(r1.declared, ["X : INTEGER"]);
  const r2 = await submit("X ← 20 + 1");
  assertEquals(r2.echoes, [{ name: "X", ty: "INTEGER", value: "21" }]);
  const r3 = await submit("FUNCTION Twice(N : INTEGER) RETURNS INTEGER\n  RETURN N * 2\nENDFUNCTION");
  assertEquals(r3.declared, ["FUNCTION Twice(N : INTEGER) RETURNS INTEGER"]);
  const r4 = await submit("Twice(X)");
  assertEquals(r4.echoes, [{ name: "-", ty: "INTEGER", value: "42" }]);
  await submit('OUTPUT "x is ", X');
  assertEquals(io.output, ["x is 21"]);
  const bad = await Effect.runPromiseExit(s.submit("Y ← 1").pipe(Effect.provide(io.layer)));
  assert(Exit.isFailure(bad));
  // A rejected input does not disturb the session.
  assertEquals((await submit("X + 1")).echoes[0].value, "22");
});

Deno.test("INPUT waits for asynchronous input", async () => {
  const io = memoryIo();
  let resolve!: (line: string) => void;
  const pending = new Promise<string>((r) => (resolve = r));
  const program = runSource(new Source("p", "DECLARE N : INTEGER\nINPUT N\nOUTPUT N * 2\n")).pipe(
    Effect.provideService(Stdin, { readLine: () => Effect.promise(() => pending).pipe(Effect.map(Option.some)) }),
    Effect.provide(io.layer),
  );
  const done = Effect.runPromise(program);
  await new Promise((r) => setTimeout(r, 10));
  assertEquals(io.output, []);
  resolve("21");
  await done;
  assertEquals(io.output, ["42"]);
});

Deno.test("a runaway program can be interrupted", async () => {
  const io = memoryIo([], { sliceSize: 10_000 });
  const fiber = Effect.runFork(runSource(new Source("p", "WHILE TRUE\nENDWHILE\n")).pipe(Effect.provide(io.layer)));
  await new Promise((r) => setTimeout(r, 30));
  const exit = await Effect.runPromise(Fiber.interrupt(fiber));
  assert(Exit.isInterrupted(exit));
});
