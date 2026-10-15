/** Built-in library routines: names and static signatures. Implementations live in `vm/natives.ts`. */

/** Parameter/return type pattern. */
export type Pat =
  | "Int"
  | "Real"
  | "Num" // INTEGER or REAL
  | "Bool"
  | "Char"
  | "Str"
  | "Text" // STRING or CHAR
  | "Date"
  | "SameAsArg0"
  | "Dynamic"; // INTEGER or REAL, known only at run time

export interface Builtin {
  readonly name: string;
  readonly params: readonly Pat[];
  readonly ret: Pat;
  readonly doc: string;
}

const b = (name: string, params: Pat[], ret: Pat, doc: string): Builtin => ({ name, params, ret, doc });

export const BUILTINS: readonly Builtin[] = [
  b("LENGTH", ["Str"], "Int", "number of characters in a string"),
  b("LEFT", ["Str", "Int"], "Str", "the leftmost n characters"),
  b("RIGHT", ["Str", "Int"], "Str", "the rightmost n characters"),
  b("MID", ["Str", "Int", "Int"], "Str", "MID(s, start, length): substring starting at 1-based `start`"),
  b("SUBSTRING", ["Str", "Int", "Int"], "Str", "alias of MID"),
  b("UCASE", ["Text"], "SameAsArg0", "upper-case a CHAR or STRING"),
  b("LCASE", ["Text"], "SameAsArg0", "lower-case a CHAR or STRING"),
  b("TO_UPPER", ["Text"], "SameAsArg0", "upper-case a CHAR or STRING"),
  b("TO_LOWER", ["Text"], "SameAsArg0", "lower-case a CHAR or STRING"),
  b("NUM_TO_STR", ["Num"], "Str", "convert a number to its STRING form"),
  b("STR_TO_NUM", ["Text"], "Dynamic", "parse a STRING as an INTEGER or REAL"),
  b("IS_NUM", ["Text"], "Bool", "whether a STRING is a valid number"),
  b("ASC", ["Char"], "Int", "character code of a CHAR"),
  b("CHR", ["Int"], "Char", "CHAR with the given character code"),
  b("INT", ["Num"], "Int", "integer part of a number (truncates toward zero)"),
  b("RAND", ["Num"], "Real", "random REAL in [0, x)"),
  b("ROUND", ["Num", "Int"], "Real", "round to the given number of decimal places"),
  b("EOF", ["Str"], "Bool", "whether a file opened FOR READ is exhausted"),
  b("DAY", ["Date"], "Int", "day of month of a DATE"),
  b("MONTH", ["Date"], "Int", "month of a DATE"),
  b("YEAR", ["Date"], "Int", "year of a DATE"),
  b("DAYINDEX", ["Date"], "Int", "day of week, Sunday = 1"),
  b("SETDATE", ["Int", "Int", "Int"], "Date", "SETDATE(day, month, year)"),
  b("NOW", [], "Date", "today's date"),
];

const byName = new Map(BUILTINS.map((x, i) => [x.name, i]));

/** Index of a builtin by its exact name. */
export function lookupBuiltin(name: string): number | undefined {
  return byName.get(name);
}

export function patName(p: Pat): string {
  switch (p) {
    case "Int":
      return "INTEGER";
    case "Real":
      return "REAL";
    case "Num":
    case "Dynamic":
      return "INTEGER or REAL";
    case "Bool":
      return "BOOLEAN";
    case "Char":
      return "CHAR";
    case "Str":
      return "STRING";
    case "Text":
      return "STRING or CHAR";
    case "Date":
      return "DATE";
    case "SameAsArg0":
      return "same type as argument";
  }
}

export function signatureOf(b: Builtin): string {
  return `${b.name}(${b.params.map(patName).join(", ")}) RETURNS ${patName(b.ret)}`;
}
