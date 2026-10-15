/**
 * Run-time values shared by the compiler (constant pools) and the VM.
 *
 * INTEGER, BOOLEAN and STRING are unboxed JavaScript primitives so the hot
 * paths never allocate. REAL, CHAR, DATE and enumeration values are wrapped
 * so the VM can tell `2` from `2.0` and `'a'` from `"a"`. INTEGER uses the
 * exact range of a double: ±(2^53 − 1).
 */

export const UNINIT: unique symbol = Symbol("uninit");
export const VOID: unique symbol = Symbol("void");

export class Real {
  constructor(readonly v: number) {}
}

export class Char {
  constructor(readonly c: string) {}
}

/** Days since 1970-01-01. */
export class DateVal {
  constructor(readonly days: number) {}
}

export class EnumVal {
  constructor(readonly ty: number, readonly ord: number) {}
}

export class ArrayObj {
  /** Inclusive `[lower, upper]` bounds per dimension. */
  constructor(readonly dims: readonly (readonly [number, number])[], readonly data: Value[]) {}

  /** Row-major flat index, or `-1 - dim` for the first offending dimension. */
  flatIndex(idx: readonly number[]): number {
    let flat = 0;
    for (let d = 0; d < idx.length; d++) {
      const [lo, hi] = this.dims[d];
      const i = idx[d];
      if (i < lo || i > hi) return -1 - d;
      flat = flat * (hi - lo + 1) + (i - lo);
    }
    return flat;
  }
}

/**
 * A heap object with a fixed slot layout described by a `Shape`: a record
 * (value semantics, copied on assignment) or a class instance (reference
 * semantics, like a Smalltalk object).
 */
export class Obj {
  constructor(readonly shape: number, readonly fields: Value[], readonly record: boolean) {}
}

/** A first-class reference to a storage location: the target of `^X` or a BYREF parameter. */
export type Ref =
  | { readonly kind: "stack"; readonly index: number }
  | { readonly kind: "global"; readonly index: number }
  | { readonly kind: "elem"; readonly array: ArrayObj; readonly index: number }
  | { readonly kind: "field"; readonly obj: Obj; readonly index: number };

export class RefVal {
  constructor(readonly ref: Ref) {}
}

export type Value =
  | number
  | boolean
  | string
  | Real
  | Char
  | DateVal
  | EnumVal
  | ArrayObj
  | Obj
  | RefVal
  | typeof UNINIT
  | typeof VOID;

export function typeName(v: Value): string {
  switch (typeof v) {
    case "number":
      return "INTEGER";
    case "boolean":
      return "BOOLEAN";
    case "string":
      return "STRING";
    case "symbol":
      return v === UNINIT ? "uninitialized" : "nothing";
  }
  if (v instanceof Real) return "REAL";
  if (v instanceof Char) return "CHAR";
  if (v instanceof DateVal) return "DATE";
  if (v instanceof EnumVal) return "enumeration";
  if (v instanceof ArrayObj) return "ARRAY";
  if (v instanceof Obj) return v.record ? "record" : "object";
  return "pointer";
}

/** Deep copy for value-semantics aggregates (arrays and records); objects keep reference semantics. */
export function deepCopy(v: Value): Value {
  if (v instanceof ArrayObj) return new ArrayObj(v.dims, v.data.map(deepCopy));
  if (v instanceof Obj && v.record) return new Obj(v.shape, v.fields.map(deepCopy), true);
  return v;
}

// Calendar conversions (Howard Hinnant's civil-from-days algorithms).

function daysInMonth(y: number, m: number): number {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

export function daysFromCivil(y: number, m: number, d: number): number | undefined {
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return undefined;
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor((yy >= 0 ? yy : yy - 399) / 400);
  const yoe = yy - era * 400;
  const mp = (m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function civilFromDays(z0: number): [number, number, number] {
  const z = z0 + 719468;
  const era = Math.floor((z >= 0 ? z : z - 146096) / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [m <= 2 ? y + 1 : y, m, d];
}

export function formatDate(days: number): string {
  const [y, m, d] = civilFromDays(days);
  return `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}/${String(y).padStart(4, "0")}`;
}

export function formatReal(r: number): string {
  if (Number.isNaN(r)) return "NaN";
  if (!Number.isFinite(r)) return r > 0 ? "inf" : "-inf";
  if (Number.isInteger(r) && Math.abs(r) < 1e15) return r.toFixed(1);
  return String(r);
}
