// What every stored object shares: the size cap and the rules on members no version knows.

import { type Each, fail, throwing, ValidationError } from "../errors.js";
import { type Json, JsonError, type JsonObject, Reader } from "../json/read.js";
import type { Codec } from "../json/schema.js";
import { compareBytes, utf8, utf8Len } from "../text.js";

const MAX_SAFE = 9007199254740991n;

/** Reads one whole document as `codec`, a refusal of the reader becoming the package's error. */
export function parse<T>(codec: Codec<T>, input: Uint8Array | string, context = ""): T {
  const reader = new Reader(typeof input === "string" ? utf8(input) : input);
  try {
    const value = codec.read(reader);
    reader.end();
    return value;
  } catch (e) {
    if (e instanceof JsonError) throw new ValidationError(`${context}${e.message}`, undefined, { cause: e });
    throw e;
  }
}

/** An integer past 2^53 would come back changed from any JS caller that reads and rewrites it. */
export function checkSafeInt(value: bigint, where = ""): void {
  if (value > MAX_SAFE || value < -MAX_SAFE) fail(`integer ${value} outside the JSON-safe range${where}`);
}

export function checkSafeNumbers(value: Json, where = ""): void {
  if (typeof value === "bigint") checkSafeInt(value, where);
  else if (Array.isArray(value)) for (const item of value) checkSafeNumbers(item, where);
  else if (value instanceof Map) for (const key of [...value.keys()].sort(compareBytes)) checkSafeNumbers(value.get(key) as Json, where);
}

export function checkExtra(extra: JsonObject): void {
  for (const key of [...extra.keys()].sort(compareBytes)) checkSafeNumbers(extra.get(key) as Json, ` (in extra member ${key})`);
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
  if (bytes > max) fail(`object exceeds ${max} bytes`);
}

/** The cap on the written form first, then the rules, so no in-memory path skips the cap. */
export function validate<T>(model: Model<T>, value: T, id: string | null, publicRoot: boolean, each: Each = throwing): string {
  const body = model.codec.write(value);
  each(() => checkSize(utf8Len(body), model.maxBytes));
  model.check(value, id, publicRoot, each);
  return body;
}

/** Accepts the stored bytes as written or refuses them; a reader never rewrites. */
export function readStored<T>(model: Model<T>, bytes: Uint8Array, id: string, publicRoot: boolean): { value: T; body: string } {
  checkSize(bytes.length, model.maxBytes);
  const value = parse(model.codec, bytes);
  return { value, body: validate(model, value, id, publicRoot) };
}
