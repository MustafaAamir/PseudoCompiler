/** Implementations of the built-in library routines. */

import { BUILTINS } from "../core/builtins.ts";
import { Conv } from "../core/bytecode.ts";
import { Char, civilFromDays, DateVal, daysFromCivil, Real, UNINIT, type Value } from "../core/value.ts";
import { Fault } from "./fault.ts";
import { parseAs, type Vm } from "./vm.ts";

const text = (v: Value): string => (typeof v === "string" ? v : v instanceof Char ? v.c : "");
const int = (v: Value): number => (typeof v === "number" ? v : v instanceof Real ? Math.trunc(v.v) : 0);
const real = (v: Value): number => (typeof v === "number" ? v : v instanceof Real ? v.v : 0);

export function callBuiltin(vm: Vm, index: number, args: Value[]): Value {
  const name = BUILTINS[index].name;
  if (args.some((a) => a === UNINIT)) {
    throw new Fault("R0002", `uninitialized value passed to ${name}`, "argument has no value");
  }
  const [a, b, c] = args;
  switch (name) {
    case "LENGTH":
      return [...text(a)].length;
    case "LEFT":
    case "RIGHT": {
      const s = [...text(a)];
      const n = int(b);
      if (n < 0 || n > s.length) {
        throw new Fault(
          "R0012",
          `${name}: cannot take ${n} characters from a string of length ${s.length}`,
          "length out of range",
        )
          .note(`the string is ${JSON.stringify(text(a))}`);
      }
      return (name === "LEFT" ? s.slice(0, n) : s.slice(s.length - n)).join("");
    }
    case "MID":
    case "SUBSTRING": {
      const s = [...text(a)];
      const start = int(b), n = int(c);
      if (start < 1 || n < 0 || start - 1 + n > s.length) {
        throw new Fault(
          "R0012",
          `${name}: range [${start}, ${start + n - 1}] is outside the string`,
          "substring out of range",
        )
          .note(`the string ${JSON.stringify(text(a))} has ${s.length} characters; positions start at 1`);
      }
      return s.slice(start - 1, start - 1 + n).join("");
    }
    case "UCASE":
    case "TO_UPPER":
      return a instanceof Char ? new Char([...a.c.toUpperCase()][0] ?? a.c) : text(a).toUpperCase();
    case "LCASE":
    case "TO_LOWER":
      return a instanceof Char ? new Char([...a.c.toLowerCase()][0] ?? a.c) : text(a).toLowerCase();
    case "NUM_TO_STR":
      return vm.show(a);
    case "STR_TO_NUM":
      try {
        return parseAs(text(a), Conv.Int);
      } catch {
        try {
          return parseAs(text(a), Conv.Real);
        } catch {
          throw new Fault("R0006", `STR_TO_NUM: ${JSON.stringify(text(a))} is not a number`, "cannot be parsed")
            .help("check the text with IS_NUM(...) first");
        }
      }
    case "IS_NUM":
      return text(a).trim() !== "" && !Number.isNaN(Number(text(a).trim()));
    case "ASC":
      return a instanceof Char ? a.c.codePointAt(0)! : 0;
    case "CHR": {
      const i = int(a);
      if (i < 0 || i > 0x10ffff) throw new Fault("R0012", `CHR: ${i} is not a valid character code`, "invalid code");
      return new Char(String.fromCodePoint(i));
    }
    case "INT":
      return Math.trunc(real(a));
    case "RAND":
      return new Real(vm.random() * real(a));
    case "ROUND": {
      const p = 10 ** int(b);
      return new Real(Math.round(real(a) * p) / p);
    }
    case "EOF":
      return vm.files.eof(text(a));
    case "DAY":
    case "MONTH":
    case "YEAR":
    case "DAYINDEX": {
      if (!(a instanceof DateVal)) throw Fault.typeError("DATE", vm.typeName(a));
      const [y, m, d] = civilFromDays(a.days);
      if (name === "DAY") return d;
      if (name === "MONTH") return m;
      if (name === "YEAR") return y;
      return (((a.days + 4) % 7) + 7) % 7 + 1;
    }
    case "SETDATE": {
      const days = daysFromCivil(int(c), int(b), int(a));
      if (days === undefined) {
        throw new Fault("R0012", `SETDATE: ${int(a)}/${int(b)}/${int(c)} is not a valid date`, "no such day");
      }
      return new DateVal(days);
    }
    case "NOW":
      return new DateVal(vm.today());
  }
  throw new Error(`unknown builtin ${name}`);
}
