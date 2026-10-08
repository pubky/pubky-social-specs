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

// A short run of ASCII spelled without a decoder call, which costs more than the run itself;
// anything else goes through the decoder, which also checks the encoding
function shortText(bytes: Uint8Array, start: number, end: number): string | null {
  let out = "";
  for (let i = start; i < end; i++) {
    const b = bytes[i] as number;
    if (b >= 0x80) return utf8Text(bytes.subarray(start, end));
    out += String.fromCharCode(b);
  }
  return out;
}

export class Reader {
  pos = 0;
  readonly bytes: Uint8Array;
  // Arrays and objects still open; the parser gives up at 128
  private depth = 0;

  constructor(input: Uint8Array | string) {
    this.bytes = typeof input === "string" ? utf8(input) : input;
  }

  fail(message: string): never {
    throw new JsonError(message);
  }

  private peek(): number | undefined {
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
      case 0x5b:
        return this.items();
      case 0x7b:
        return this.members();
      default:
        if (isDigit(b)) return this.number(true);
        return this.fail("expected value");
    }
  }

  private open(): void {
    this.pos++;
    if (++this.depth === 128) this.fail("recursion limit exceeded");
  }

  private close(): void {
    this.depth--;
    this.pos++;
  }

  // Up to the next element of the open array or object, past its comma; false at `close`
  private next(close: number, first: boolean): boolean {
    let b = this.peekToken();
    if (b === close) return false;
    const list = close === 0x5d;
    if (b === undefined) this.fail(list ? "EOF while parsing a list" : "EOF while parsing an object");
    if (!first) {
      if (b !== 0x2c) this.fail(list ? "expected `,` or `]`" : "expected `,` or `}`");
      this.pos++;
      b = this.peekToken();
      if (b === close) this.fail("trailing comma");
      if (b === undefined) this.fail("EOF while parsing a value");
    }
    return true;
  }

  private key(): string {
    if (this.peekToken() !== QUOTE) this.fail("key must be a string");
    this.pos++;
    return this.string();
  }

  private colon(): void {
    const b = this.peekToken();
    if (b === undefined) this.fail("EOF while parsing an object");
    if (b !== 0x3a) this.fail("expected `:`");
    this.pos++;
  }

  // The two below are `array` and `object` with the element read inline: a hostile document
  // nests thousands of them, and a closure per container is most of what it costs

  // Items are gathered on one stack and copied out at the size they have: an array grown by
  // `push` reserves room for many, and a document of a hundred thousand one-item arrays would
  // hold several times its own size
  private readonly stack: Json[] = [];

  private items(): Json[] {
    const base = this.stack.length;
    this.open();
    while (this.next(0x5d, this.stack.length === base)) this.stack.push(this.value());
    this.close();
    return this.stack.splice(base);
  }

  private members(): JsonObject {
    // The last of two equal keys wins, and no key is the object's prototype
    const members: JsonObject = new Map();
    this.open();
    for (let first = true; this.next(0x7d, first); first = false) {
      const key = this.key();
      this.colon();
      members.set(key, this.value());
    }
    this.close();
    return members;
  }

  /** An array, `element` reading each item. */
  array(element: () => void): void {
    this.open();
    for (let first = true; this.next(0x5d, first); first = false) element();
    this.close();
  }

  /**
   * An object. `member` is given each key as it is read, before its colon, as the parser
   * judges a key; it returns what reads the value.
   */
  object(member: (key: string) => () => void): void {
    this.open();
    for (let first = true; this.next(0x7d, first); first = false) {
      const read = member(this.key());
      this.colon();
      read();
    }
    this.close();
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
        const text = at - start <= 32 ? shortText(bytes, start, at) : utf8Text(bytes.subarray(start, at));
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
    const start = this.pos - 1;
    if (first === 0x30) {
      const next = this.peek();
      if (next !== undefined && isDigit(next)) this.fail("invalid number");
    } else this.digits();
    // Fifteen digits fit a double exactly; past them the digits are read as a bigint once
    const length = this.pos - start;
    let significand: bigint | null;
    if (length <= 15) {
      let n = 0;
      for (let i = start; i < this.pos; i++) n = n * 10 + ((this.bytes[i] as number) - 0x30);
      significand = BigInt(n);
    } else if (length <= 20) {
      significand = BigInt(utf8Text(this.bytes.subarray(start, this.pos)) as string);
      if (significand > U64_MAX) significand = null;
    } else significand = null;
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
export function readJson(text: string): Json {
  const reader = new Reader(text);
  const value = reader.value();
  reader.end();
  return value;
}
