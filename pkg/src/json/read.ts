// A JSON reader that refuses what the reference parser refuses, with its message, at the same
// point of the text. `JSON.parse` cannot stand in: it reads every number as a double, keeps
// one of two equal keys without a trace, and words its errors per engine.

import { utf8, utf8Text } from "../text.js";

/** A refusal of the reader. The message is the parser's own, with no position. */
export class JsonError extends Error {}

/** An integer keeps its digits as a bigint; a number is a double the text spelled as one. */
export type Json = null | boolean | string | number | bigint | Json[] | JsonObject;
export type JsonObject = Map<string, Json>;

const U64_MAX = 0xffff_ffff_ffff_ffffn;
const I32_MAX = 2147483647;
const POW10 = Array.from({ length: 309 }, (_, i) => Number(`1e${i}`));

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const isDigit = (b: number) => b >= 0x30 && b <= 0x39;

export class Reader {
  pos = 0;
  readonly bytes: Uint8Array;
  // Arrays and objects still open; the parser gives up at 128
  private depth = 0;
  private readonly exactFloats: boolean;

  /**
   * `exactFloats` reads a double correctly rounded, where the reference parser's own
   * arithmetic can land a unit away: for text this package wrote and must read back unchanged.
   */
  constructor(bytes: Uint8Array, exactFloats = false) {
    this.bytes = bytes;
    this.exactFloats = exactFloats;
  }

  fail(message: string): never {
    throw new JsonError(message);
  }

  peek(): number | undefined {
    return this.bytes[this.pos];
  }

  /** The next byte that is not a space, tab, line feed or carriage return, left unread. */
  peekToken(): number | undefined {
    for (;;) {
      const b = this.bytes[this.pos];
      if (b !== 0x20 && b !== 0x0a && b !== 0x09 && b !== 0x0d) return b;
      this.pos++;
    }
  }

  /** Nothing but whitespace may follow the one value of a document. */
  end(): void {
    if (this.peekToken() !== undefined) this.fail("trailing characters");
  }

  ident(rest: string): void {
    for (let i = 0; i < rest.length; i++) {
      const b = this.bytes[this.pos++];
      if (b === undefined) this.fail("EOF while parsing a value");
      if (b !== rest.charCodeAt(i)) this.fail("expected ident");
    }
  }

  enter(): void {
    if (++this.depth === 128) this.fail("recursion limit exceeded");
  }

  leave(): void {
    this.depth--;
  }

  /** Any value. `null`, `true` and `false` are read whole, so `nul` is an error here. */
  value(): Json {
    const b = this.peekToken();
    if (b === undefined) this.fail("EOF while parsing a value");
    switch (b) {
      case 0x6e:
        this.pos++;
        this.ident("ull");
        return null;
      case 0x74:
        this.pos++;
        this.ident("rue");
        return true;
      case 0x66:
        this.pos++;
        this.ident("alse");
        return false;
      case 0x2d:
        this.pos++;
        return this.number(false);
      case QUOTE:
        this.pos++;
        return this.string();
      case 0x5b: {
        const items: Json[] = [];
        this.array(() => items.push(this.value()));
        return items;
      }
      case 0x7b: {
        // The last of two equal keys wins, and no key is the object's prototype
        const members: JsonObject = new Map();
        this.object((key) => void members.set(key, this.value()));
        return members;
      }
      default:
        if (isDigit(b)) return this.number(true);
        return this.fail("expected value");
    }
  }

  /** An array, `element` reading each item. It may stop early by returning false. */
  array(element: () => unknown): void {
    this.pos++;
    this.enter();
    let first = true;
    let more = true;
    while (more) {
      let b = this.peekToken();
      if (b === 0x5d) break;
      if (b === undefined) this.fail("EOF while parsing a list");
      if (!first) {
        if (b !== 0x2c) this.fail("expected `,` or `]`");
        this.pos++;
        b = this.peekToken();
        if (b === 0x5d) this.fail("trailing comma");
        if (b === undefined) this.fail("EOF while parsing a value");
      }
      first = false;
      more = element() !== false;
    }
    this.leave();
    const b = this.peekToken();
    if (b === 0x5d) {
      this.pos++;
      return;
    }
    if (b === undefined) this.fail("EOF while parsing a list");
    if (b === 0x2c) {
      this.pos++;
      if (this.peekToken() === 0x5d) this.fail("trailing comma");
    }
    this.fail("trailing characters");
  }

  /** An object, `member` reading the value of each key. */
  object(member: (key: string) => void): void {
    this.pos++;
    this.enter();
    let first = true;
    for (;;) {
      let b = this.peekToken();
      if (b === 0x7d) break;
      if (b === undefined) this.fail("EOF while parsing an object");
      if (!first) {
        if (b !== 0x2c) this.fail("expected `,` or `}`");
        this.pos++;
        b = this.peekToken();
      }
      first = false;
      if (b === 0x7d) this.fail("trailing comma");
      if (b === undefined) this.fail("EOF while parsing a value");
      if (b !== QUOTE) this.fail("key must be a string");
      this.pos++;
      const key = this.string();
      const colon = this.peekToken();
      if (colon === undefined) this.fail("EOF while parsing an object");
      if (colon !== 0x3a) this.fail("expected `:`");
      this.pos++;
      member(key);
    }
    this.leave();
    this.pos++;
  }

  private hex(): number {
    if (this.pos + 4 > this.bytes.length) {
      this.pos = this.bytes.length;
      this.fail("EOF while parsing a string");
    }
    let n = 0;
    for (let i = 0; i < 4; i++) {
      const b = this.bytes[this.pos++] as number;
      const digit = isDigit(b) ? b - 0x30 : (b | 0x20) >= 0x61 && (b | 0x20) <= 0x66 ? (b | 0x20) - 0x57 : -1;
      if (digit < 0) this.fail("invalid escape");
      n = n * 16 + digit;
    }
    return n;
  }

  private byteOrEof(): number {
    const b = this.bytes[this.pos];
    if (b === undefined) this.fail("EOF while parsing a string");
    return b;
  }

  /** The text of a string whose opening quote is read. */
  string(): string {
    let out = "";
    let start = this.pos;
    // The parser looks at the encoding only at the closing quote, so an error later in the
    // same string comes first
    let invalid = false;
    const flush = () => {
      if (this.pos === start) return;
      const text = utf8Text(this.bytes.subarray(start, this.pos));
      if (text === null) invalid = true;
      else out += text;
    };
    for (;;) {
      const b = this.byteOrEof();
      if (b === QUOTE) {
        flush();
        this.pos++;
        if (invalid) this.fail("invalid unicode code point");
        return out;
      }
      if (b < 0x20) {
        this.pos++;
        this.fail("control character (\\u0000-\\u001F) found while parsing a string");
      }
      if (b !== BACKSLASH) {
        this.pos++;
        continue;
      }
      flush();
      this.pos++;
      const escape = this.byteOrEof();
      this.pos++;
      const plain = ESCAPES[escape];
      if (plain !== undefined) out += plain;
      else if (escape === 0x75) out += this.unicodeEscape();
      else this.fail("invalid escape");
      start = this.pos;
    }
  }

  private unicodeEscape(): string {
    const n = this.hex();
    if (n >= 0xdc00 && n <= 0xdfff) this.fail("lone leading surrogate in hex escape");
    if (n < 0xd800 || n > 0xdbff) return String.fromCharCode(n);
    // The low half must follow as its own escape
    if (this.byteOrEof() !== BACKSLASH) {
      this.pos++;
      this.fail("unexpected end of hex escape");
    }
    this.pos++;
    if (this.byteOrEof() !== 0x75) {
      this.pos++;
      this.fail("unexpected end of hex escape");
    }
    this.pos++;
    const low = this.hex();
    if (low < 0xdc00 || low > 0xdfff) this.fail("lone leading surrogate in hex escape");
    return String.fromCharCode(n, low);
  }

  /** A number whose sign is read: a bigint for an integer in 64 bits, else a double. */
  number(positive: boolean): bigint | number {
    const start = positive ? this.pos : this.pos - 1;
    const value = this.scanNumber(positive);
    if (!this.exactFloats || typeof value === "bigint") return value;
    // A number is ASCII; decoded, not spread, since a token has no bound on its length
    return Number(utf8Text(this.bytes.subarray(start, this.pos)));
  }

  private scanNumber(positive: boolean): bigint | number {
    const first = this.bytes[this.pos++];
    if (first === undefined) this.fail("EOF while parsing a value");
    if (first === 0x30) {
      const next = this.peek();
      if (next !== undefined && isDigit(next)) this.fail("invalid number");
      return this.afterInteger(positive, 0n);
    }
    if (!isDigit(first)) this.fail("invalid number");
    let significand = BigInt(first - 0x30);
    for (;;) {
      const b = this.peek();
      if (b === undefined || !isDigit(b)) return this.afterInteger(positive, significand);
      const next = significand * 10n + BigInt(b - 0x30);
      // Past 64 bits the remaining digits only scale the value
      if (next > U64_MAX) return this.longInteger(positive, significand);
      this.pos++;
      significand = next;
    }
  }

  private afterInteger(positive: boolean, significand: bigint): bigint | number {
    const b = this.peek();
    if (b === 0x2e) return this.decimal(positive, significand, 0);
    if (b === 0x65 || b === 0x45) return this.exponent(positive, significand, 0);
    if (positive) return significand;
    // A negative past 64 bits signed, and minus zero, are doubles
    const negated = BigInt.asIntN(64, -significand);
    return negated >= 0n ? -Number(significand) : negated;
  }

  private longInteger(positive: boolean, significand: bigint): number {
    let exponent = 0;
    for (;;) {
      const b = this.peek();
      if (b !== undefined && isDigit(b)) {
        this.pos++;
        exponent++;
      } else if (b === 0x2e) return this.decimal(positive, significand, exponent);
      else if (b === 0x65 || b === 0x45) return this.exponent(positive, significand, exponent);
      else return this.fromParts(positive, significand, exponent);
    }
  }

  private decimal(positive: boolean, significand: bigint, before: number): number {
    this.pos++;
    let after = 0;
    for (;;) {
      const b = this.peek();
      if (b === undefined || !isDigit(b)) break;
      const next = significand * 10n + BigInt(b - 0x30);
      if (next > U64_MAX) {
        // The digits that do not fit are dropped, not rounded
        while (isDigit(this.peek() ?? 0)) this.pos++;
        const e = this.peek();
        if (e === 0x65 || e === 0x45) return this.exponent(positive, significand, before + after);
        return this.fromParts(positive, significand, before + after);
      }
      this.pos++;
      significand = next;
      after--;
    }
    if (after === 0) this.fail(this.peek() === undefined ? "EOF while parsing a value" : "invalid number");
    const e = this.peek();
    if (e === 0x65 || e === 0x45) return this.exponent(positive, significand, before + after);
    return this.fromParts(positive, significand, before + after);
  }

  private exponent(positive: boolean, significand: bigint, starting: number): number {
    this.pos++;
    let positiveExp = true;
    const sign = this.peek();
    if (sign === 0x2b || sign === 0x2d) {
      this.pos++;
      positiveExp = sign === 0x2b;
    }
    const first = this.bytes[this.pos++];
    if (first === undefined) this.fail("EOF while parsing a value");
    if (!isDigit(first)) this.fail("invalid number");
    let exp = first - 0x30;
    for (;;) {
      const b = this.peek();
      if (b === undefined || !isDigit(b)) break;
      this.pos++;
      if (exp * 10 + (b - 0x30) > I32_MAX) {
        if (significand !== 0n && positiveExp) this.fail("number out of range");
        while (isDigit(this.peek() ?? 0)) this.pos++;
        return positive ? 0 : -0;
      }
      exp = exp * 10 + (b - 0x30);
    }
    const clamp = (n: number) => Math.max(-I32_MAX - 1, Math.min(I32_MAX, n));
    return this.fromParts(positive, significand, clamp(positiveExp ? starting + exp : starting - exp));
  }

  // The parser's own arithmetic, not a correctly rounded conversion: a long significand or a
  // large exponent lands a unit away from what `Number()` gives, and the bytes written back
  // follow this value
  private fromParts(positive: boolean, significand: bigint, exponent: number): number {
    let f = Number(significand);
    for (;;) {
      const pow = POW10[Math.abs(exponent)];
      if (pow !== undefined) {
        if (exponent >= 0) {
          f *= pow;
          if (f === Infinity) this.fail("number out of range");
        } else f /= pow;
        break;
      }
      if (f === 0) break;
      if (exponent >= 0) this.fail("number out of range");
      f /= 1e308;
      exponent += 308;
    }
    return positive ? f : -f;
  }
}

const ESCAPES: Record<number, string> = {
  0x22: '"', 0x5c: "\\", 0x2f: "/", 0x62: "\b", 0x66: "\f", 0x6e: "\n", 0x72: "\r", 0x74: "\t",
};

/** One document: a value and nothing after it. */
export function readJson(input: Uint8Array | string, exactFloats = false): Json {
  const reader = new Reader(typeof input === "string" ? utf8(input) : input, exactFloats);
  const value = reader.value();
  reader.end();
  return value;
}
