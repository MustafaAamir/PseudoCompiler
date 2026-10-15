/** Static types tracked by the single-pass compiler. */

import { Conv } from "../core/bytecode.ts";

export type Ty =
  | { readonly k: "int" | "real" | "bool" | "char" | "str" | "date" }
  /** The "value" of a procedure call. */
  | { readonly k: "void" }
  /** Statically unknown (e.g. a call to a function defined later); checked at run time where it meets a typed slot. */
  | { readonly k: "unknown" }
  /** Produced after a reported error; compatible with everything so one mistake does not cascade. */
  | { readonly k: "error" }
  | { readonly k: "array"; readonly dims: readonly (readonly [number, number])[]; readonly elem: Ty }
  | { readonly k: "record" | "class" | "enum"; readonly id: number }
  | { readonly k: "pointer"; readonly to: Ty };

export const T = {
  Int: { k: "int" },
  Real: { k: "real" },
  Bool: { k: "bool" },
  Char: { k: "char" },
  Str: { k: "str" },
  Date: { k: "date" },
  Void: { k: "void" },
  Unknown: { k: "unknown" },
  Error: { k: "error" },
} as const satisfies Record<string, Ty>;

export function tyEquals(a: Ty, b: Ty): boolean {
  if (a.k !== b.k) return false;
  switch (a.k) {
    case "array": {
      const bb = b as typeof a;
      return a.dims.length === bb.dims.length &&
        a.dims.every(([l, h], i) => l === bb.dims[i][0] && h === bb.dims[i][1]) &&
        tyEquals(a.elem, bb.elem);
    }
    case "record":
    case "class":
    case "enum":
      return a.id === (b as typeof a).id;
    case "pointer":
      return tyEquals(a.to, (b as typeof a).to);
    default:
      return true;
  }
}

export const isNumeric = (t: Ty): boolean => t.k === "int" || t.k === "real";
export const isText = (t: Ty): boolean => t.k === "str" || t.k === "char";
/** Unknown or Error: anything goes statically. */
export const isDynamic = (t: Ty): boolean => t.k === "unknown" || t.k === "error";
/** Records and arrays are copied on assignment. */
export const isValueAggregate = (t: Ty): boolean => t.k === "array" || t.k === "record";

export function convOf(t: Ty): Conv {
  switch (t.k) {
    case "int":
      return Conv.Int;
    case "real":
      return Conv.Real;
    case "bool":
      return Conv.Bool;
    case "char":
      return Conv.Char;
    case "str":
      return Conv.Str;
    case "date":
      return Conv.Date;
    default:
      return Conv.Any;
  }
}
