// The bytes the reference serializer writes for a value: members in the order given, numbers
// and escapes spelled its way.

import { compareBytes } from "../text.js";
import type { Json, JsonObject } from "./read.js";

// A Map, so no character reaches a prototype
const NAMED = new Map([['"', '\\"'], ["\\", "\\\\"], ["\b", "\\b"], ["\f", "\\f"], ["\n", "\\n"], ["\r", "\\r"], ["\t", "\\t"]]);
const ESCAPED = /["\\\u0000-\u001f]/g;

/** Only the quote, the backslash and the C0 controls are escaped. */
export function writeString(s: string): string {
  return `"${s.replace(ESCAPED, (c) => NAMED.get(c) ?? `\\u00${c.charCodeAt(0).toString(16).padStart(2, "0")}`)}"`;
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
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return writeString(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return writeFloat(value);
  // Concatenated in place, which the engine keeps as a rope: a hostile value nests thousands of
  // containers, and an array of parts per container is most of what writing it would cost
  let out = "";
  if (Array.isArray(value)) {
    out = "[";
    for (let i = 0; i < value.length; i++) out += (i > 0 ? "," : "") + writeJson(value[i] as Json);
    return out + "]";
  }
  const keys = sortedKeys(value);
  out = "{";
  for (let i = 0; i < keys.length; i++) out += `${i > 0 ? "," : ""}${writeString(keys[i] as string)}:${writeJson(value.get(keys[i] as string) as Json)}`;
  return out + "}";
}

const sortedKeys = (members: JsonObject): string[] => (members.size < 2 ? [...members.keys()] : [...members.keys()].sort(compareBytes));

/** The members of an object, sorted by the bytes of their keys. */
export function writeMembers(members: JsonObject): string[] {
  return sortedKeys(members).map((key) => `${writeString(key)}:${writeJson(members.get(key) as Json)}`);
}
