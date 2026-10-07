// What every stored object shares: the size cap, the rules on unknown members, and the way a
// caller's value becomes the text that is checked.

import { limits } from "../data.js";
import { fail, ValidationError } from "../errors.js";
import { type Json, JsonError, type JsonObject, Reader } from "../json/read.js";
import type { Codec } from "../json/schema.js";
import { compareKeys } from "../json/write.js";
import { utf8Len } from "../text.js";

const encoder = new TextEncoder();
const MAX_SAFE = 9007199254740991n;

/** Reads one whole document as `codec`, a refusal of the reader becoming the package's error. */
export function parse<T>(codec: Codec<T>, input: Uint8Array | string, context = ""): T {
  const reader = new Reader(typeof input === "string" ? encoder.encode(input) : input);
  try {
    const value = codec.read(reader);
    reader.end();
    return value;
  } catch (e) {
    if (e instanceof JsonError) throw new ValidationError(`Validation Error: ${context}${e.message}`);
    throw e;
  }
}

export function checkSize(bytes: number, max: number): void {
  if (bytes > max) fail(`object exceeds ${max} bytes`);
}

function checkSafeNumbers(value: Json): void {
  // An integer past 2^53 would come back changed from any JS caller that reads and rewrites it
  if (typeof value === "bigint") {
    if (value > MAX_SAFE || value < -MAX_SAFE) fail(`integer ${value} outside the JSON-safe range`);
  } else if (Array.isArray(value)) value.forEach(checkSafeNumbers);
  else if (value instanceof Map) for (const key of [...value.keys()].sort(compareKeys)) checkSafeNumbers(value.get(key) as Json);
}

export function checkExtra(extra: JsonObject): void {
  for (const key of [...extra.keys()].sort(compareKeys)) {
    try {
      checkSafeNumbers(extra.get(key) as Json);
    } catch (e) {
      if (e instanceof ValidationError) throw new ValidationError(`${e.message} (in extra member ${key})`);
      throw e;
    }
  }
}

export function checkSafeInt(value: bigint): void {
  if (value > MAX_SAFE || value < -MAX_SAFE) fail(`integer ${value} outside the JSON-safe range`);
}

/** A stored object: its codec, its cap and its rules. */
export interface Model<T> {
  codec: Codec<T>;
  maxBytes: number;
  /** The rules beyond the shape. `id` is what the path names, absent for a value not yet stored. */
  check(value: T, id: string | null, publicRoot: boolean): void;
}

/** The cap on the written form first, then the rules, so no in-memory path skips the cap. */
export function validate<T>(model: Model<T>, value: T, id: string | null, publicRoot: boolean): string {
  const body = model.codec.write(value);
  checkSize(utf8Len(body), model.maxBytes);
  model.check(value, id, publicRoot);
  return body;
}

/** Accepts the stored bytes as written or refuses them; a reader never rewrites. */
export function readStored<T>(model: Model<T>, bytes: Uint8Array, id: string, publicRoot: boolean): { value: T; body: string } {
  checkSize(bytes.length, model.maxBytes);
  const value = parse(model.codec, bytes);
  return { value, body: validate(model, value, id, publicRoot) };
}

// Escaping expands a byte to six at most, so text past this holds no object under the largest cap
const JSON_CAP = 6 * limits.postMaxBytes;

/**
 * The text a PUT of `value` would send, which is what gets checked: `JSON.stringify` decides
 * what JS stores (a `toJSON`, a dropped `undefined`). An absent value reads as `null`.
 */
export function jsonOf(value: unknown): string {
  if (value === undefined) return "null";
  let text: unknown;
  try {
    text = JSON.stringify(value);
  } catch {
    text = undefined;
  }
  if (typeof text !== "string") fail("the value has no JSON form");
  if (text.length > JSON_CAP) fail(`the value's JSON form is over ${JSON_CAP} bytes`);
  return text;
}

export const SIZES = { object: limits.objectMaxBytes, post: limits.postMaxBytes } as const;
