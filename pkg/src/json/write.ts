// The bytes the reference serializer writes for a value: members in the order given, numbers
// and escapes spelled its way.

import type { Json } from "./read.js";

const NAMED: Record<string, string> = { '"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t" };
// eslint-disable-next-line no-control-regex
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

/** Keys in the order of their UTF-8 bytes, which is code point order, not UTF-16 order. */
export function compareKeys(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let x = a.charCodeAt(i);
    let y = b.charCodeAt(i);
    if (x === y) continue;
    // A surrogate stands for a code point above every BMP one
    if (x >= 0xd800 && x <= 0xdfff) x += 0x2000;
    else if (x >= 0xe000) x -= 0x800;
    if (y >= 0xd800 && y <= 0xdfff) y += 0x2000;
    else if (y >= 0xe000) y -= 0x800;
    return x - y;
  }
  return a.length - b.length;
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
  const members = [...value.keys()].sort(compareKeys).map((key) => `${writeString(key)}:${writeJson(value.get(key) as Json)}`);
  return `{${members.join(",")}}`;
}
