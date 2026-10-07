// The bytes the reference serializer writes for a value: members in the order given, numbers
// and escapes spelled its way.

import { compareBytes } from "../text.js";
import type { Json, JsonObject } from "./read.js";

const NAMED: Record<string, string> = { '"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t" };
const ESCAPED = /["\\\u0000-\u001f]/g;

/** Only the quote, the backslash and the C0 controls are escaped. */
export function writeString(s: string): string {
  return `"${s.replace(ESCAPED, (c) => NAMED[c] ?? `\\u00${c.charCodeAt(0).toString(16).padStart(2, "0")}`)}"`;
}

/**
 * A double as the reference spells it: the shortest digits that read back to it, as a plain
 * decimal with at least one fraction digit from 1e-5 up to 1e16, in exponent form outside.
 */
export function writeFloat(f: number): string {
  if (!Number.isFinite(f)) return "null";
  if (f === 0) return Object.is(f, -0) ? "-0.0" : "0.0";
  // The engine's shortest digits; only the layout differs from what it would print
  const [mantissa, exponent] = Math.abs(f).toExponential().split("e") as [string, string];
  const digits = mantissa.replace(".", "");
  const exp = Number(exponent);
  const sign = f < 0 ? "-" : "";
  if (exp < -5 || exp > 15) {
    const fraction = digits.length > 1 ? `.${digits.slice(1)}` : "";
    return `${sign}${digits[0]}${fraction}e${exp < 0 ? "-" : "+"}${Math.abs(exp)}`;
  }
  if (exp < 0) return `${sign}0.${"0".repeat(-exp - 1)}${digits}`;
  if (digits.length - 1 <= exp) return `${sign}${digits}${"0".repeat(exp + 1 - digits.length)}.0`;
  return `${sign}${digits.slice(0, exp + 1)}.${digits.slice(exp + 1)}`;
}

/** A value with every object's members sorted, as an unknown member of an object is kept. */
export function writeJson(value: Json): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return writeString(value);
    case "bigint":
      return value.toString();
    case "number":
      return writeFloat(value);
  }
  if (Array.isArray(value)) return `[${value.map(writeJson).join(",")}]`;
  return `{${writeMembers(value).join(",")}}`;
}

/** The members of an object, sorted by the bytes of their keys. */
export function writeMembers(members: JsonObject): string[] {
  return [...members.keys()].sort(compareBytes).map((key) => `${writeString(key)}:${writeJson(members.get(key) as Json)}`);
}
