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

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const isDigit = (b: number) => b >= 0x30 && b <= 0x39;

export class Reader {
  pos = 0;
  readonly bytes: Uint8Array;
  // Arrays and objects still open; the parser gives up at 128
  private depth = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
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
    const bytes = this.bytes;
    let out = "";
    // The parser looks at the encoding only at the closing quote, so an error later in the
    // same string comes first
    let invalid = false;
    for (;;) {
      const start = this.pos;
      let at = start;
      let b = bytes[at];
      while (b !== undefined && b !== QUOTE && b !== BACKSLASH && b >= 0x20) b = bytes[++at];
      this.pos = at;
      if (at > start) {
        const text = utf8Text(bytes.subarray(start, at));
        if (text === null) invalid = true;
        else out += text;
      }
      if (b === undefined) this.fail("EOF while parsing a string");
      this.pos++;
      if (b === QUOTE) {
        if (invalid) this.fail("invalid unicode code point");
        return out;
      }
      if (b < 0x20) this.fail("control character (\\u0000-\\u001F) found while parsing a string");
      const escape = this.byteOrEof();
      this.pos++;
      const plain = ESCAPES.get(escape);
      if (plain !== undefined) out += plain;
      else if (escape === 0x75) out += this.unicodeEscape();
      else this.fail("invalid escape");
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
    const integer = this.scanNumber();
    if (integer !== null) {
      if (positive) return integer;
      // A negative past 64 bits signed, and minus zero, are doubles
      const negated = BigInt.asIntN(64, -integer);
      if (negated < 0n) return negated;
    }
    // Correctly rounded, as the reference reads a double. A number is ASCII; decoded, not
    // spread, since a token has no bound on its length
    const f = Number(utf8Text(this.bytes.subarray(start, this.pos)));
    if (!Number.isFinite(f)) this.fail("number out of range");
    return f;
  }

  /** The digits of a number, refused where the parser refuses them: the integer when the token is one that fits 64 bits, else null. */
  private scanNumber(): bigint | null {
    const first = this.bytes[this.pos++];
    if (first === undefined) this.fail("EOF while parsing a value");
    if (!isDigit(first)) this.fail("invalid number");
    let significand: bigint | null = BigInt(first - 0x30);
    if (first === 0x30) {
      const next = this.peek();
      if (next !== undefined && isDigit(next)) this.fail("invalid number");
    } else {
      for (let b = this.peek(); b !== undefined && isDigit(b); b = this.peek()) {
        this.pos++;
        if (significand !== null) {
          significand = significand * 10n + BigInt(b - 0x30);
          if (significand > U64_MAX) significand = null;
        }
      }
    }
    let b = this.peek();
    if (b === 0x2e) {
      this.pos++;
      if (!this.digits()) this.fail(this.peek() === undefined ? "EOF while parsing a value" : "invalid number");
      significand = null;
      b = this.peek();
    }
    if (b === 0x65 || b === 0x45) {
      this.pos++;
      const sign = this.peek();
      if (sign === 0x2b || sign === 0x2d) this.pos++;
      const digit = this.peek();
      if (digit === undefined) this.fail("EOF while parsing a value");
      if (!isDigit(digit)) this.fail("invalid number");
      this.digits();
      significand = null;
    }
    return significand;
  }

  /** Reads a run of digits; false when there was none. */
  private digits(): boolean {
    const start = this.pos;
    while (isDigit(this.peek() ?? 0)) this.pos++;
    return this.pos > start;
  }
}

// A Map, so no key reaches a prototype
const ESCAPES = new Map<number, string>([
  [0x22, '"'],
  [0x5c, "\\"],
  [0x2f, "/"],
  [0x62, "\b"],
  [0x66, "\f"],
  [0x6e, "\n"],
  [0x72, "\r"],
  [0x74, "\t"],
]);

/** One document: a value and nothing after it. */
export function readJson(input: Uint8Array | string): Json {
  const reader = new Reader(typeof input === "string" ? utf8(input) : input);
  const value = reader.value();
  reader.end();
  return value;
}
