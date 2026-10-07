// Typed reading and writing, shaped as the reference derives it: a field is read where it
// stands in the text, so the first thing wrong in document order is the error, and an object
// is written with its known members in declared order and its unknown ones sorted after.

import { DEBUG_ESCAPED } from "../data.js";
import { debugQuote } from "../text.js";
import { type Json, type JsonObject, Reader } from "./read.js";
import { compareKeys, writeFloat, writeJson, writeString } from "./write.js";

/** How one type is read from the text and written back. */
export interface Codec<T> {
  read(r: Reader): T;
  write(value: T): string;
  /** An absent member of this type reads as null. */
  optional?: true;
}

const oneOf = (names: readonly string[], none: string) =>
  names.length === 0
    ? none
    : names.length === 1
      ? `expected \`${names[0]}\``
      : names.length === 2
        ? `expected \`${names[0]}\` or \`${names[1]}\``
        : `expected one of ${names.map((name) => `\`${name}\``).join(", ")}`;

/** Refuses the value ahead as the wrong type, naming what it is. Reads it to name it. */
export function invalidType(r: Reader, expected: string): never {
  const b = r.peekToken();
  if (b === undefined) r.fail("EOF while parsing a value");
  let met: string;
  if (b === 0x5b) met = "sequence";
  else if (b === 0x7b) met = "map";
  else {
    const value = r.value();
    if (value === null) met = "null";
    else if (typeof value === "boolean") met = `boolean \`${value}\``;
    else if (typeof value === "string") met = `string ${debugQuote(value, DEBUG_ESCAPED)}`;
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
};

const I64_MAX = 0x7fff_ffff_ffff_ffffn;

/** A signed 64-bit integer, kept as a bigint so no digit is lost before it is checked. */
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
};

/** Any value, as an unknown member is kept. */
export const any: Codec<Json> = { read: (r) => r.value(), write: writeJson };

export function option<T>(inner: Codec<T>): Codec<T | null> {
  return {
    read(r: Reader) {
      if (r.peekToken() !== 0x6e) return inner.read(r);
      r.pos++;
      r.ident("ull");
      return null;
    },
    write: (value) => (value === null ? "null" : inner.write(value)),
    optional: true,
  };
}

export function list<T>(inner: Codec<T>): Codec<T[]> {
  return {
    read(r: Reader) {
      if (r.peekToken() !== 0x5b) invalidType(r, "a sequence");
      const items: T[] = [];
      r.array(() => items.push(inner.read(r)));
      return items;
    },
    write: (items) => `[${items.map(inner.write).join(",")}]`,
  };
}

/**
 * One of a closed set of names. With `other`, a name this version does not know reads as
 * `other` and is written back as that, which is how a reader survives a newer writer.
 */
export function variant<T extends string>(names: readonly T[], other?: T): Codec<T> {
  const named = (r: Reader, name: string): T =>
    (names as readonly string[]).includes(name)
      ? (name as T)
      : other ?? r.fail(`unknown variant \`${name}\`, ${oneOf(names, "there are no variants")}`);
  return {
    read(r: Reader) {
      const b = r.peekToken();
      if (b === undefined) r.fail("EOF while parsing a value");
      if (b === 0x22) {
        r.pos++;
        return named(r, r.string());
      }
      if (b !== 0x7b) r.fail("expected value");
      // The parser also takes the one-member object form, `{"name": null}`
      r.enter();
      r.pos++;
      if (r.peekToken() !== 0x22) invalidType(r, "variant identifier");
      r.pos++;
      const value = named(r, r.string());
      const colon = r.peekToken();
      if (colon === undefined) r.fail("EOF while parsing an object");
      if (colon !== 0x3a) r.fail("expected `:`");
      r.pos++;
      if (r.peekToken() !== 0x6e) invalidType(r, "unit variant");
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
  };
}

export interface Field {
  codec: Codec<any>;
  /** The value of an absent member. Without one an absent member is an error, or null for an option. */
  absent?: () => unknown;
  /** Not written when null. */
  skipNull?: boolean;
}

function absent(r: Reader, name: string, field: Field): unknown {
  if (field.absent) return field.absent();
  if (field.codec.optional) return null;
  return r.fail(`missing field \`${name}\``);
}

/** An object that refuses a member it does not know. Also read from an array, in field order. */
export function closed<T>(name: string, fields: Record<string, Field>): Codec<T> {
  const names = Object.keys(fields);
  const expecting = `struct ${name}`;
  return {
    read(r: Reader) {
      const b = r.peekToken();
      const out: Record<string, unknown> = {};
      if (b === 0x5b) {
        let i = 0;
        r.array(() => {
          const key = names[i] as string;
          out[key] = (fields[key] as Field).codec.read(r);
          return ++i < names.length;
        });
        for (; i < names.length; i++) {
          const field = fields[names[i] as string] as Field;
          if (!field.absent) return r.fail(`invalid length ${i}, expected ${expecting} with ${names.length} element${names.length === 1 ? "" : "s"}`);
          out[names[i] as string] = field.absent();
        }
        return out as T;
      }
      if (b !== 0x7b) invalidType(r, expecting);
      r.object((key) => {
        const field = Object.hasOwn(fields, key) ? fields[key] : undefined;
        if (!field) return r.fail(`unknown field \`${key}\`, ${oneOf(names, "there are no fields")}`);
        if (Object.hasOwn(out, key)) r.fail(`duplicate field \`${key}\``);
        out[key] = field.codec.read(r);
      });
      for (const key of names) if (!Object.hasOwn(out, key)) out[key] = absent(r, key, fields[key] as Field);
      return out as T;
    },
    write: (value) => `{${members(fields, value as Record<string, unknown>).join(",")}}`,
  };
}

function members(fields: Record<string, Field>, value: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, field] of Object.entries(fields)) {
    if (field.skipNull && value[key] === null) continue;
    out.push(`${writeString(key)}:${field.codec.write(value[key])}`);
  }
  return out;
}

/** The members an object carries beyond the ones its type names, kept by value. */
export type Extra = { extra: JsonObject };

/** An object that keeps the members it does not know, under `extra`. Never read from an array. */
export function open<T extends Extra>(name: string, fields: Record<string, Field>): Codec<T> {
  const names = Object.keys(fields);
  return {
    read(r: Reader) {
      if (r.peekToken() !== 0x7b) invalidType(r, `struct ${name}`);
      const out: Record<string, unknown> = {};
      const extra: JsonObject = new Map();
      r.object((key) => {
        const field = Object.hasOwn(fields, key) ? fields[key] : undefined;
        if (!field) return void extra.set(key, r.value());
        if (Object.hasOwn(out, key)) r.fail(`duplicate field \`${key}\``);
        out[key] = field.codec.read(r);
      });
      for (const key of names) if (!Object.hasOwn(out, key)) out[key] = absent(r, key, fields[key] as Field);
      out.extra = extra;
      return out as T;
    },
    write(value) {
      const known = members(fields, value as unknown as Record<string, unknown>);
      const unknown = [...value.extra.keys()].sort(compareKeys).map((key) => `${writeString(key)}:${writeJson(value.extra.get(key) as Json)}`);
      return `{${[...known, ...unknown].join(",")}}`;
    },
  };
}
