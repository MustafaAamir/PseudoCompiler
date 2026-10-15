/**
 * Text and random-access files over an in-memory file system: the browser
 * has no disk, so file contents live in a {@link VirtualFs} map that the host
 * may persist (e.g. to localStorage) or inspect.
 */

import { FileMode } from "../core/bytecode.ts";
import { Char, DateVal, deepCopy, EnumVal, Obj, Real, UNINIT, type Value } from "../core/value.ts";
import { Fault } from "./fault.ts";

/** File name -> contents. */
export class VirtualFs {
  readonly files = new Map<string, string>();

  constructor(initial: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(initial)) this.files.set(k, v);
  }
}

type Handle =
  | { readonly kind: "read"; readonly lines: string[] }
  | { readonly kind: "write"; readonly chunks: string[] }
  | { readonly kind: "random"; readonly records: Value[]; pos: number };

const notOpen = (name: string, op: string) =>
  new Fault("R0005", `${op}: file ${JSON.stringify(name)} is not open`, "file not open")
    .help(`open it first with \`OPENFILE "${name}" FOR ...\``);

const wrongMode = (name: string, op: string, needed: string) =>
  new Fault("R0005", `${op}: file ${JSON.stringify(name)} was not opened FOR ${needed}`, "wrong file mode");

export class FileTable {
  private readonly open = new Map<string, Handle>();

  constructor(private readonly fs: VirtualFs) {}

  private handle(name: string, op: string): Handle {
    const h = this.open.get(name);
    if (!h) throw notOpen(name, op);
    return h;
  }

  openFile(name: string, mode: FileMode): void {
    if (this.open.has(name)) {
      throw new Fault("R0005", `file ${JSON.stringify(name)} is already open`, "opened twice")
        .help("CLOSEFILE it before opening it again");
    }
    const text = this.fs.files.get(name);
    let h: Handle;
    switch (mode) {
      case FileMode.Read:
        if (text === undefined) {
          throw new Fault("R0005", `cannot open file ${JSON.stringify(name)}: no such file`, "OPENFILE failed")
            .help("create it first by opening it FOR WRITE");
        }
        h = { kind: "read", lines: text === "" ? [] : text.replace(/\n$/, "").split("\n") };
        break;
      case FileMode.Write:
        this.fs.files.set(name, "");
        h = { kind: "write", chunks: [] };
        break;
      case FileMode.Append:
        h = { kind: "write", chunks: text === undefined ? [] : [text] };
        break;
      case FileMode.Random:
        h = { kind: "random", records: text ? text.replace(/\n$/, "").split("\n").map(decode) : [], pos: 1 };
        break;
    }
    this.open.set(name, h);
  }

  readLine(name: string): string {
    const h = this.handle(name, "READFILE");
    if (h.kind !== "read") throw wrongMode(name, "READFILE", "READ");
    const line = h.lines.shift();
    if (line === undefined) {
      throw new Fault("R0005", `READFILE: no more lines in ${JSON.stringify(name)}`, "read past the end of the file")
        .help(`guard the loop with \`WHILE NOT EOF("${name}")\``);
    }
    return line;
  }

  eof(name: string): boolean {
    const h = this.handle(name, "EOF");
    if (h.kind === "read") return h.lines.length === 0;
    if (h.kind === "random") return h.pos > h.records.length;
    throw wrongMode(name, "EOF", "READ");
  }

  writeLine(name: string, text: string): void {
    const h = this.handle(name, "WRITEFILE");
    if (h.kind !== "write") throw wrongMode(name, "WRITEFILE", "WRITE or APPEND");
    h.chunks.push(text + "\n");
  }

  seek(name: string, addr: number): void {
    const h = this.handle(name, "SEEK");
    if (h.kind !== "random") throw wrongMode(name, "SEEK", "RANDOM");
    if (addr < 1) throw new Fault("R0005", `SEEK: invalid record address ${addr}`, "addresses start at 1");
    h.pos = addr;
  }

  getRecord(name: string): Value {
    const h = this.handle(name, "GETRECORD");
    if (h.kind !== "random") throw wrongMode(name, "GETRECORD", "RANDOM");
    const v = h.records[h.pos - 1];
    if (v === undefined || v === UNINIT) {
      throw new Fault(
        "R0005",
        `GETRECORD: no record at address ${h.pos} of ${JSON.stringify(name)}`,
        "empty record slot",
      );
    }
    return deepCopy(v);
  }

  putRecord(name: string, v: Value): void {
    const h = this.handle(name, "PUTRECORD");
    if (h.kind !== "random") throw wrongMode(name, "PUTRECORD", "RANDOM");
    while (h.records.length < h.pos) h.records.push(UNINIT);
    h.records[h.pos - 1] = v;
  }

  close(name: string): void {
    const h = this.handle(name, "CLOSEFILE");
    this.open.delete(name);
    this.flush(name, h);
  }

  private flush(name: string, h: Handle): void {
    if (h.kind === "write") this.fs.files.set(name, h.chunks.join(""));
    else if (h.kind === "random") this.fs.files.set(name, h.records.map(encode).map((l) => l + "\n").join(""));
  }

  closeAll(): void {
    for (const [name, h] of this.open) this.flush(name, h);
    this.open.clear();
  }
}

// Random files store one record per line as tab-separated tagged fields.

function encode(v: Value): string {
  return v instanceof Obj && v.record ? [`R${v.shape}`, ...v.fields.map(encodeScalar)].join("\t") : encodeScalar(v);
}

function encodeScalar(v: Value): string {
  if (typeof v === "number") return `i${v}`;
  if (typeof v === "boolean") return `b${v ? 1 : 0}`;
  if (typeof v === "string") return `s${v.replaceAll("\\", "\\\\").replaceAll("\t", "\\t")}`;
  if (v instanceof Real) return `r${v.v}`;
  if (v instanceof Char) return `c${v.c}`;
  if (v instanceof DateVal) return `d${v.days}`;
  if (v instanceof EnumVal) return `e${v.ty}:${v.ord}`;
  return "-";
}

function decode(line: string): Value {
  if (line.startsWith("R")) {
    const [shape, ...fields] = line.slice(1).split("\t");
    return new Obj(Number(shape), fields.map(decodeScalar), true);
  }
  return decodeScalar(line);
}

function decodeScalar(s: string): Value {
  const body = s.slice(1);
  switch (s[0]) {
    case "i":
      return Number(body);
    case "r":
      return new Real(Number(body));
    case "b":
      return body === "1";
    case "c":
      return new Char(body);
    case "s":
      return body.replaceAll("\\t", "\t").replaceAll("\\\\", "\\");
    case "d":
      return new DateVal(Number(body));
    case "e": {
      const [ty, ord] = body.split(":").map(Number);
      return new EnumVal(ty, ord);
    }
    default:
      return UNINIT;
  }
}
