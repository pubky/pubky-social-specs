// The transforms, which are the reference crate compiled to wasm: they read 0.x objects
// through its frozen reader, whose URL and MIME parsing no JS engine reproduces. Nothing
// outside this subpath loads a wasm.

import { sha256 } from "@noble/hashes/sha2.js";
import { viewBytes } from "../bytes.js";
import { limits, skipReasons } from "../data.js";
import { ValidationError } from "../errors.js";
import { checkWellFormed } from "../text.js";
import type { ObjectKind } from "../uri.js";
// The wasm itself, embedded in the module or, under Node, read from the file beside it
import * as glue from "#glue";

export type SkipReason = (typeof skipReasons)[number];

/** What a profile lost on the way: a member 1.x has no valid spelling for. */
export type Dropped = "profile_image" | `profile_link[${number}]`;

interface Meta {
  id: string;
  path: string;
  url: string;
}

/** A write as a reader of the stored bytes gets it, and where it goes. */
export type MigratedWrite = { kind: Exclude<ObjectKind, "file">; object: Record<string, unknown>; meta: Meta } | { kind: "file"; object: { bytes: Uint8Array }; meta: Meta };

export type MigrateResult = { writes: MigratedWrite[]; dropped: Dropped[] } | { skip: SkipReason; note?: string };

/** Where a blob goes; its bytes stay with the caller. */
export type MigrateBlobResult = { writes: { kind: "file"; meta: Meta }[]; dropped: Dropped[] } | { skip: SkipReason; note?: string };

export type Migration = glue.Migration;

let loading: Promise<void> | null = null;

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * The embedded wasm, once its digest is the one the build recorded. Hashed here, not through
 * `crypto.subtle`, which a page served over plain HTTP does not have.
 */
function checkedWasm(): Uint8Array {
  const bytes = glue.__wbg_bytes();
  const digest = hex(sha256(bytes));
  if (digest !== glue.__wbg_sha256) throw new Error(`pubky-social-specs/migration: the embedded wasm hashes to ${digest}, not the ${glue.__wbg_sha256} its build recorded`);
  return bytes;
}

/** Loads the wasm once, after checking its digest. A failed load can be tried again. */
export function init(): Promise<void> {
  loading ??= Promise.resolve()
    .then(() => glue.__wbg_init(checkedWasm()))
    .catch((e: unknown) => {
      loading = null;
      throw e;
    });
  return loading;
}

// What reaches the wasm comes from a port, which is someone else's code: a value of another
// type in a string slot reads memory it does not own, and whatever is copied into linear
// memory stays allocated for the rest of the run. So each argument is checked here first.

// A value of the wrong type is a fault of the port or of the engine, never of the data
function refuse(call: string, slot: number, what: string): never {
  throw new TypeError(`pubky-social-specs/migration: ${call}() argument ${slot} ${what}`);
}

function text(call: string, slot: number, value: unknown): string {
  if (typeof value !== "string") refuse(call, slot, "must be a string");
  checkWellFormed(value);
  // No path or id is longer than the largest object
  if (value.length > limits.postMaxBytes) refuse(call, slot, `is over ${limits.postMaxBytes} characters`);
  return value;
}

// A plain view: a subclass that lies about its length would have the glue copy past its memory
function bytes(call: string, slot: number, value: unknown): Uint8Array {
  return viewBytes(value) ?? refuse(call, slot, "must be a Uint8Array");
}

// A freed handle holds no pointer
function live(call: string, value: unknown): Migration {
  const held = value instanceof glue.Migration && (value as unknown as { __wbg_ptr: number }).__wbg_ptr !== 0;
  return held ? value : refuse(call, 1, "must be a Migration handle");
}

const HASH_CHUNK = 4 * 1024 * 1024;
const PREFIX = "Validation Error: ";

// The crate words a refusal of its rules with the prefix; the glue throws it as a plain Error
function refused<T>(call: () => T): T {
  try {
    return call();
  } catch (e) {
    if (e instanceof Error && !(e instanceof ValidationError) && e.message.startsWith(PREFIX)) {
      throw new ValidationError(e.message.slice(PREFIX.length), undefined, { cause: e });
    }
    throw e;
  }
}

/**
 * The transforms as the engine calls them. One object, so a test of the engine can stand a
 * transform of its own in for one of them.
 */
export const transforms = {
  createMigration: (owner: string): Migration => refused(() => glue.createMigration(text("createMigration", 1, owner))),
  /** One 0.x object by its path or its URL: the 1.x writes it becomes, or why it becomes none. */
  migrate: (run: Migration, v0Path: string, data: Uint8Array): MigrateResult =>
    refused(() => glue.migrate(live("migrate", run), text("migrate", 2, v0Path), bytes("migrate", 3, data)) as MigrateResult),
  /** A 0.x blob by its path, size and media id, so its bytes are never copied into the wasm. */
  migrateBlob(run: Migration, v0Path: string, size: number, hash: string): MigrateBlobResult {
    live("migrateBlob", run);
    if (!Number.isSafeInteger(size) || size < 0) refuse("migrateBlob", 3, "must be a non-negative integer");
    return refused(() => glue.migrateBlob(run, text("migrateBlob", 2, v0Path), size, text("migrateBlob", 4, hash)) as MigrateBlobResult);
  },
  /** The media id of `data`, fed to the wasm a view at a time: far faster than hashing in JS. */
  mediaId(data: Uint8Array): string {
    const view = bytes("mediaId", 1, data);
    const hasher = glue.hasherNew();
    try {
      for (let at = 0; at < view.length; at += HASH_CHUNK) glue.hasherUpdate(hasher, view.subarray(at, at + HASH_CHUNK));
    } catch (e) {
      hasher.free();
      throw e;
    }
    return glue.hasherFinish(hasher);
  },
};
