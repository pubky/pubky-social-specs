// Strings as the reference sees them: lengths in code points or UTF-8 bytes, and a whitespace
// set frozen at one Unicode version, since ids hash text trimmed by it.

const FROZEN_WHITESPACE = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003,
  0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f,
  0x3000,
]);

/** By UTF-16 unit, which is the code point here: the whole set is in the BMP. */
export function isFrozenWhitespace(unit: number): boolean {
  return FROZEN_WHITESPACE.has(unit);
}

/** Not `String.prototype.trim`, whose set follows the engine's Unicode version. */
export function frozenTrim(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && isFrozenWhitespace(s.charCodeAt(start))) start++;
  while (end > start && isFrozenWhitespace(s.charCodeAt(end - 1))) end--;
  return s.slice(start, end);
}

export function hasFrozenWhitespace(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (isFrozenWhitespace(s.charCodeAt(i))) return true;
  return false;
}

/** A to Z only: `toLowerCase` folds far more and differently per engine version. */
export function asciiFold(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

export function codePointLen(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const unit = s.charCodeAt(i);
    // The low half of a pair was counted with its high half
    if (unit < 0xdc00 || unit > 0xdfff) n++;
  }
  return n;
}

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

/** U+0000 to U+001F and U+007F. */
export function isAsciiControl(unit: number): boolean {
  return unit < 0x20 || unit === 0x7f;
}

/** A Rust string cannot hold a lone surrogate, so no text holding one has a reference answer. */
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
