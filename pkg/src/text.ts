// Strings as the reference sees them: lengths in code points or UTF-8 bytes, and a whitespace
// set frozen at one Unicode version, since ids hash text trimmed by it.

import { DEBUG_ESCAPED } from "./data.js";

// The 25 code points that were whitespace at Unicode 15.1, spelled out: `\s` follows the engine
const WS = "\\t-\\r \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const EDGES = new RegExp(`^[${WS}]+|[${WS}]+$`, "g");
const ANY_WS = new RegExp(`[${WS}]`);
// eslint-disable-next-line no-control-regex
const CONTROL_OR_WS = new RegExp(`[\\x00-\\x1f\\x7f${WS}]`);

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export const utf8 = (s: string): Uint8Array<ArrayBuffer> => encoder.encode(s) as Uint8Array<ArrayBuffer>;

/** The text of `bytes`, or null when they are not UTF-8. A leading BOM is text like any other. */
export function utf8Text(bytes: Uint8Array): string | null {
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

/** Not `String.prototype.trim`, whose set follows the engine's Unicode version. */
export const frozenTrim = (s: string): string => s.replace(EDGES, "");
export const hasFrozenWhitespace = (s: string): boolean => ANY_WS.test(s);
/** An ASCII control (U+0000 to U+001F, U+007F) or a frozen whitespace anywhere. */
export const hasControlOrWhitespace = (s: string): boolean => CONTROL_OR_WS.test(s);
export const trimmedOrNull = (s: string | null): string | null => (s === null ? null : frozenTrim(s) || null);

/** A to Z only: `toLowerCase` folds far more and differently per engine version. */
export const asciiFold = (s: string): string => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

export function codePointLen(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const unit = s.charCodeAt(i);
    // The low half of a pair was counted with its high half
    if (unit < 0xdc00 || unit > 0xdfff) n++;
  }
  return n;
}

/** Counted, not encoded: this runs on every object for its size cap. */
export function utf8Len(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const unit = s.charCodeAt(i);
    if (unit < 0x80) n += 1;
    else if (unit < 0x800) n += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** By UTF-8 bytes, which is code point order and not the engine's UTF-16 order. */
export function compareBytes(a: string, b: string): number {
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

/** A Rust string cannot hold a lone surrogate, so text holding one has no reference answer. */
export function isWellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const unit = s.charCodeAt(i);
    if (unit < 0xd800 || unit > 0xdfff) continue;
    const next = s.charCodeAt(i + 1);
    if (unit > 0xdbff || !(next >= 0xdc00 && next <= 0xdfff)) return false;
    i++;
  }
  return true;
}

const NAMED_DEBUG: Record<string, string> = { "\t": "\\t", "\n": "\\n", "\r": "\\r", "\0": "\\0", "\\": "\\\\", '"': '\\"' };

function isDebugEscaped(codePoint: number): boolean {
  for (let i = 0; i < DEBUG_ESCAPED.length; i += 2) {
    if (codePoint < (DEBUG_ESCAPED[i] as number)) return false;
    if (codePoint <= (DEBUG_ESCAPED[i + 1] as number)) return true;
  }
  return false;
}

/** Text as the reference quotes it inside a type error: Rust's `{:?}` of a string. */
export function debugQuote(s: string): string {
  let out = '"';
  for (const c of s) {
    const codePoint = c.codePointAt(0) as number;
    out += NAMED_DEBUG[c] ?? (isDebugEscaped(codePoint) ? `\\u{${codePoint.toString(16)}}` : c);
  }
  return `${out}"`;
}
