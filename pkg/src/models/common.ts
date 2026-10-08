// What every stored object shares: the size cap and the rules on members no version knows.

import { type Each, fail, member, throwing, ValidationError } from "../errors.js";
import { type Json, JsonError, type JsonObject, Reader } from "../json/read.js";
import { arrayOf, type Codec, string } from "../json/schema.js";
import { compareBytes, utf8, utf8Len } from "../text.js";

const MAX_SAFE = 9007199254740991n;

const absent = (js: unknown) => js === null || js === undefined;

/**
 * How a builder reads a caller's members under `each`: a member whose shape is refused reads
 * as `fallback`, so the rules after it still run. An absent optional member reads as null.
 */
export function inputReads(each: Each) {
  return {
    str: (js: unknown, at: string, fallback = "") => member(each, () => string.parse(js, at), fallback),
    opt: (js: unknown, at: string, fallback: string | null = null) => member(each, () => (absent(js) ? null : string.parse(js, at)), fallback),
    // An item that is no object refuses the whole list, which then reads as null
    items: <T>(js: unknown, at: string, item: (js: unknown, at: string) => T): T[] | null =>
      member(each, () => (absent(js) ? null : arrayOf(js, at).map((entry, index) => item(entry, `${at}[${index}]`))), null),
  };
}

/** Reads one whole document as `codec`, a refusal of the reader becoming the package's error. */
export function parse<T>(codec: Codec<T>, input: Uint8Array | string, context = "", field?: string): T {
  const reader = new Reader(typeof input === "string" ? utf8(input) : input);
  try {
    const value = codec.read(reader);
    reader.end();
    return value;
  } catch (e) {
    if (e instanceof JsonError) throw new ValidationError("json", `${context}${e.message}`, field, undefined, { cause: e });
    throw e;
  }
}

/** An integer past 2^53 would come back changed from any JS caller that reads and rewrites it. */
export function checkSafeInt(value: bigint, field: string, where = ""): void {
  if (value > MAX_SAFE || value < -MAX_SAFE) fail("unsafe_integer", `integer ${value} outside the JSON-safe range${where}`, field);
}

function checkSafeNumbers(value: Json, field: string, where: string): void {
  if (typeof value === "bigint") checkSafeInt(value, field, where);
  else if (Array.isArray(value)) for (let i = 0; i < value.length; i++) checkSafeNumbers(value[i] as Json, field, where);
  // Sorted, so the member refused first is the one the reference names
  else if (value instanceof Map) for (const key of value.size < 2 ? value.keys() : [...value.keys()].sort(compareBytes)) checkSafeNumbers(value.get(key) as Json, field, where);
}

/** The members no version knows: what a JS caller reads back has to be what was stored. `at` is the object they belong to. */
export function checkExtra(extra: JsonObject, at = ""): void {
  for (const key of [...extra.keys()].sort(compareBytes)) checkSafeNumbers(extra.get(key) as Json, `${at}$unknown.${key}`, ` (in extra member ${key})`);
}

/** A stored object: its codec, its cap and its rules. */
export interface Model<T> {
  codec: Codec<T>;
  maxBytes: number;
  /**
   * The rules beyond the shape. `id` is what the path names, null for a value not yet stored.
   * Each rule runs through `each`, in the reference's order.
   */
  check(value: T, id: string | null, publicRoot: boolean, each: Each): void;
}

function checkSize(bytes: number, max: number): void {
  if (bytes > max) fail("size", `object exceeds ${max} bytes`, undefined, max);
}

/** The cap on the written form first, then the rules, so no in-memory path skips the cap. */
export function validate<T>(model: Model<T>, value: T, id: string | null, publicRoot: boolean, each: Each = throwing): string {
  const body = model.codec.write(value);
  each(() => checkSize(utf8Len(body), model.maxBytes));
  model.check(value, id, publicRoot, each);
  return body;
}

/**
 * Accepts the stored bytes as written or refuses them; a reader never rewrites. The cap holds
 * the bytes as stored, so defaults the reader fills in are not counted against it.
 */
export function readStored<T>(model: Model<T>, bytes: Uint8Array, id: string, publicRoot: boolean): T {
  checkSize(bytes.length, model.maxBytes);
  const value = parse(model.codec, bytes);
  model.check(value, id, publicRoot, throwing);
  return value;
}
