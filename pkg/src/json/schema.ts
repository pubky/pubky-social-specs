// How each type is read from stored text, written back, and passed to and from a caller.
//
// Reading follows the reference: a member is read where it stands in the text, so the first
// thing wrong in document order is the error, in the reference's words. A caller's value is
// another matter: it comes from typed code, so a wrong shape there is a TypeError.

import { fail, misuse } from "../errors.js";
import { debugQuote, isWellFormed } from "../text.js";
import { type Json, JsonError, type JsonObject, readJson, type Reader } from "./read.js";
import { writeFloat, writeJson, writeMembers, writeString } from "./write.js";

export interface Codec<T> {
  read(r: Reader): T;
  write(value: T): string;
  /** The value as a caller holds it: plain data, integers as numbers. */
  plain(value: T): unknown;
  /** A caller's value, checked for its shape. `at` names it in the error. */
  parse(js: unknown, at: string): T;
  /** An absent member of this type reads as null. */
  optional?: true;
  /** What an absent member reads as, when not an error. */
  absent?: () => T;
  /** Not written when null. */
  skipNull?: true;
}

/** Refuses the value ahead as the wrong type, naming what it is. Reads it to name it. */
function invalidType(r: Reader, expected: string): never {
  const b = r.peekToken();
  if (b === undefined) r.fail("EOF while parsing a value");
  let met: string;
  if (b === 0x5b) met = "sequence";
  else if (b === 0x7b) met = "map";
  else {
    const value = r.value();
    if (value === null) met = "null";
    else if (typeof value === "boolean") met = `boolean \`${value}\``;
    else if (typeof value === "string") met = `string ${debugQuote(value)}`;
    else if (typeof value === "bigint") met = `integer \`${value}\``;
    else met = `floating point \`${writeFloat(value as number)}\``;
  }
  return r.fail(`invalid type: ${met}, expected ${expected}`);
}

export const string: Codec<string> = {
  read(r: Reader) {
    if (r.peekToken() !== 0x22) invalidType(r, "a string");
    r.pos++;
    return r.string();
  },
  write: writeString,
  plain: (value) => value,
  parse(js, at) {
    if (typeof js !== "string") misuse(at, "a string");
    // A Rust string cannot hold a lone surrogate, so no rule has an answer for one
    if (!isWellFormed(js)) fail("text must be well-formed UTF-16");
    return js;
  },
};

const I64_MAX = 0x7fff_ffff_ffff_ffffn;

/** A signed 64-bit integer: a bigint inside, so no digit is lost before it is checked. */
export const i64: Codec<bigint> = {
  read(r: Reader) {
    const b = r.peekToken();
    if (b === undefined) r.fail("EOF while parsing a value");
    if (b !== 0x2d && !(b >= 0x30 && b <= 0x39)) invalidType(r, "i64");
    if (b === 0x2d) r.pos++;
    const n = r.number(b !== 0x2d);
    if (typeof n === "number") r.fail(`invalid type: floating point \`${writeFloat(n)}\`, expected i64`);
    if (n > I64_MAX) r.fail(`invalid value: integer \`${n}\`, expected i64`);
    return n;
  },
  write: (value) => value.toString(),
  // Every stored integer is checked to fit a double before it gets here
  plain: (value) => Number(value),
  parse(js, at) {
    if (typeof js !== "number" || !Number.isInteger(js)) misuse(at, "an integer (a timestamp is microseconds since the epoch)");
    return BigInt(js);
  },
};

export function option<T>(inner: Codec<T>): Codec<T | null> {
  return {
    read(r: Reader) {
      if (r.peekToken() !== 0x6e) return inner.read(r);
      r.pos++;
      r.ident("ull");
      return null;
    },
    write: (value) => (value === null ? "null" : inner.write(value)),
    plain: (value) => (value === null ? null : inner.plain(value)),
    parse: (js, at) => (js === null || js === undefined ? null : inner.parse(js, at)),
    optional: true,
  };
}

/** An optional member that is left out of the text when null. */
export const omitted = <T>(inner: Codec<T>): Codec<T | null> => ({ ...option(inner), absent: () => null, skipNull: true });

/** A member that reads as `make()` when absent. */
export const defaulted = <T>(inner: Codec<T>, make: () => T): Codec<T> => ({ ...inner, absent: make });

export function list<T>(inner: Codec<T>): Codec<T[]> {
  return {
    read(r: Reader) {
      if (r.peekToken() !== 0x5b) invalidType(r, "a sequence");
      const items: T[] = [];
      r.array(() => items.push(inner.read(r)));
      return items;
    },
    write: (items) => `[${items.map(inner.write).join(",")}]`,
    plain: (items) => items.map(inner.plain),
    parse(js, at) {
      return arrayOf(js, at).map((item, index) => inner.parse(item, `${at}[${index}]`));
    },
  };
}

/**
 * One of a closed set of names. A name this version does not know reads as "unknown" and is
 * written back as that, which is how a reader survives a newer writer.
 */
export function variant<T extends string>(names: readonly T[]): Codec<T | "unknown"> {
  const named = (name: string): T | "unknown" => ((names as readonly string[]).includes(name) ? (name as T) : "unknown");
  return {
    read(r: Reader) {
      const b = r.peekToken();
      if (b === undefined) r.fail("EOF while parsing a value");
      if (b === 0x22) {
        r.pos++;
        return named(r.string());
      }
      if (b !== 0x7b) r.fail("expected value");
      // The parser also takes the one-member object form, `{"name": null}`
      r.enter();
      r.pos++;
      if (r.peekToken() !== 0x22) invalidType(r, "variant identifier");
      r.pos++;
      const value = named(r.string());
      const colon = r.peekToken();
      if (colon === undefined) r.fail("EOF while parsing an object");
      if (colon !== 0x3a) r.fail("expected `:`");
      r.pos++;
      if (r.peekToken() !== 0x6e) invalidType(r, "unit");
      r.pos++;
      r.ident("ull");
      r.leave();
      const close = r.peekToken();
      if (close === undefined) r.fail("EOF while parsing an object");
      if (close !== 0x7d) r.fail("expected value");
      r.pos++;
      return value;
    },
    write: writeString,
    plain: (value) => value,
    // A caller's name is one of the set, or the "unknown" a read gave it: a typo is not stored
    parse(js, at) {
      const name = string.parse(js, at);
      if (name !== "unknown" && !(names as readonly string[]).includes(name)) misuse(at, `one of ${names.join(", ")}`);
      return name as T | "unknown";
    },
  };
}

/** The members an object carries beyond the ones its type names, kept by value. */
export type Extra = { extra: JsonObject };

// A caller holds the unknown members as text it carries along and cannot respell: a number
// read into a JS value and written back would lose the difference between `1` and `1.0`
function unknownOf(js: unknown, at: string, known: readonly string[]): JsonObject {
  if (js === undefined) return new Map();
  if (typeof js !== "string") misuse(`${at}.$unknown`, "the text it was read with");
  if (!isWellFormed(js)) fail("text must be well-formed UTF-16");
  let members: Json;
  try {
    members = readJson(js, true);
  } catch (e) {
    if (e instanceof JsonError) return misuse(`${at}.$unknown`, "the text it was read with");
    throw e;
  }
  if (!(members instanceof Map)) return misuse(`${at}.$unknown`, "the text it was read with");
  for (const key of known) if (members.has(key)) misuse(`${at}.$unknown`, `without the known member ${key}`);
  return members;
}

/** An object that keeps the members it does not know, under `extra`. */
export function object<T extends Extra>(name: string, fields: Record<string, Codec<any>>): Codec<T> {
  const names = Object.keys(fields);
  const entries = Object.entries(fields);
  const absent = (key: string, codec: Codec<unknown>, missing: () => never) => (codec.absent ? codec.absent() : codec.optional ? null : missing());
  return {
    read(r: Reader) {
      if (r.peekToken() !== 0x7b) invalidType(r, `struct ${name}`);
      const out: Record<string, unknown> = {};
      const extra: JsonObject = new Map();
      r.object((key) => {
        const codec = Object.hasOwn(fields, key) ? fields[key] : undefined;
        if (!codec) return void extra.set(key, r.value());
        if (Object.hasOwn(out, key)) r.fail(`duplicate field \`${key}\``);
        out[key] = codec.read(r);
      });
      for (const [key, codec] of entries) {
        if (!Object.hasOwn(out, key)) out[key] = absent(key, codec, () => r.fail(`missing field \`${key}\``));
      }
      out.extra = extra;
      return out as T;
    },
    write(value) {
      const known: string[] = [];
      for (const [key, codec] of entries) {
        const member = (value as Record<string, unknown>)[key];
        if (!(codec.skipNull && member === null)) known.push(`${writeString(key)}:${codec.write(member)}`);
      }
      return `{${[...known, ...writeMembers(value.extra)].join(",")}}`;
    },
    plain(value) {
      const out: Record<string, unknown> = {};
      for (const [key, codec] of entries) out[key] = codec.plain((value as Record<string, unknown>)[key]);
      if (value.extra.size > 0) out.$unknown = writeJson(value.extra);
      return out;
    },
    parse(js, at) {
      if (typeof js !== "object" || js === null || Array.isArray(js)) misuse(at, "an object");
      const given = js as Record<string, unknown>;
      for (const key of Object.keys(given)) {
        if (key !== "$unknown" && !Object.hasOwn(fields, key)) {
          misuse(`${at}.${key}`, "a member of the stored object: pass the .object a builder or decodeObject returned (members this version does not know travel in its $unknown)");
        }
      }
      const out: Record<string, unknown> = {};
      for (const [key, codec] of entries) {
        const member = given[key];
        out[key] = member === undefined ? absent(key, codec, () => misuse(`${at}.${key}`, "given")) : codec.parse(member, `${at}.${key}`);
      }
      out.extra = unknownOf(given.$unknown, at, names);
      return out as T;
    },
  };
}

// No list of the model, and no history a caller walks, comes near this
const MAX_ITEMS = 1 << 20;

/** A caller's array as a plain one: bounded, and a hole an absent item, not a skipped one. */
export function arrayOf(js: unknown, at: string): unknown[] {
  if (!Array.isArray(js)) misuse(at, "an array");
  // Checked before it is walked: a length is free to claim
  if (js.length > MAX_ITEMS) misuse(at, `an array of at most ${MAX_ITEMS} items`);
  return Array.from(js);
}

/** The members of a caller's input object, none of them outside `allowed`. */
export function inputOf(js: unknown, at: string, allowed: readonly string[]): Record<string, unknown> {
  if (typeof js !== "object" || js === null || Array.isArray(js)) misuse(at, "an object");
  for (const key of Object.keys(js)) if (!allowed.includes(key)) misuse(`${at}.${key}`, `one of ${allowed.join(", ")}`);
  return js as Record<string, unknown>;
}

export type { Json };
