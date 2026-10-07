// The transforms, which are the reference crate compiled to wasm: they read 0.x objects
// through its frozen reader, whose URL and MIME parsing no JS engine reproduces. Nothing
// outside this subpath loads a wasm.

import { limits, skipReasons } from "../data.js";
import { isWellFormed } from "../text.js";
import type { ObjectKind } from "../uri.js";
import * as glue from "./glue.js";

export type SkipReason = (typeof skipReasons)[number];

/** What a profile lost on the way: a member 1.x has no valid spelling for. */
export type Dropped = "profile_image" | `profile_link[${number}]`;

interface Meta {
  id: string;
  path: string;
  url: string;
}

/** A write as a reader of the stored bytes gets it, and where it goes. */
export type MigratedWrite =
  | { kind: Exclude<ObjectKind, "file">; object: Record<string, unknown>; meta: Meta }
  | { kind: "file"; object: { bytes: Uint8Array }; meta: Meta };

export type MigrateResult = { writes: MigratedWrite[]; dropped: Dropped[] } | { skip: SkipReason; note?: string };

/** Where a blob goes; its bytes stay with the caller. */
export type MigrateBlobResult = { writes: { kind: "file"; meta: Meta }[]; dropped: Dropped[] } | { skip: SkipReason; note?: string };

export type Migration = glue.Migration;

let loading: Promise<void> | null = null;

/** Loads the wasm once. A failed load can be tried again. */
export function init(): Promise<void> {
  loading ??= glue.__wbg_init().catch((e: unknown) => {
    loading = null;
    throw e;
  });
  return loading;
}

// What reaches the wasm comes from a port, which is someone else's code: a value of another
// type in a string slot reads memory it does not own, and whatever is copied into linear
// memory stays allocated for the rest of the run. So each argument is checked here first.

const TypedArray = Object.getPrototypeOf(Uint8Array.prototype) as object;
const intrinsic = (name: string) => Object.getOwnPropertyDescriptor(TypedArray, name)?.get as (this: unknown) => unknown;
const intrinsicLength = intrinsic("length");
const intrinsicBuffer = intrinsic("buffer");

// Any realm's Uint8Array: a view of single bytes whose own length agrees with what it reports
// (a subclass that lies would have the glue write past its allocation), over a live buffer
function isBytes(value: unknown): value is Uint8Array {
  const view = value as Uint8Array;
  if (!ArrayBuffer.isView(view) || view.BYTES_PER_ELEMENT !== 1) return false;
  try {
    new Uint8Array(intrinsicBuffer.call(view) as ArrayBuffer, 0, 0);
    return intrinsicLength.call(view) === view.length;
  } catch {
    return false;
  }
}

function refuse(call: string, slot: number, what: string): never {
  throw new Error(`Validation Error: ${call}() argument ${slot} ${what}`);
}

function text(call: string, slot: number, value: unknown): string {
  if (typeof value !== "string") refuse(call, slot, "must be a string");
  if (!isWellFormed(value)) throw new Error("Validation Error: text must be well-formed UTF-16");
  // No path or id is longer than the largest object
  if (value.length > limits.postMaxBytes) refuse(call, slot, `is over ${limits.postMaxBytes} characters`);
  return value;
}

function bytes(call: string, slot: number, value: unknown): Uint8Array {
  return isBytes(value) ? value : refuse(call, slot, "must be a Uint8Array");
}

// A freed handle holds no pointer
function live(call: string, value: unknown): Migration {
  const held = value instanceof glue.Migration && (value as unknown as { __wbg_ptr: number }).__wbg_ptr !== 0;
  return held ? value : refuse(call, 1, "must be a Migration handle");
}

const HASH_CHUNK = 4 * 1024 * 1024;

/**
 * The transforms as the engine calls them. One object, so a test of the engine can stand a
 * transform of its own in for one of them.
 */
export const transforms = {
  createMigration: (owner: string): Migration => glue.createMigration(text("createMigration", 1, owner)),
  /** One 0.x object by its path or its URL: the 1.x writes it becomes, or why it becomes none. */
  migrate: (run: Migration, v0Path: string, data: Uint8Array): MigrateResult =>
    glue.migrate(live("migrate", run), text("migrate", 2, v0Path), bytes("migrate", 3, data)) as MigrateResult,
  /** A 0.x blob by its path, size and media id, so its bytes are never copied into the wasm. */
  migrateBlob(run: Migration, v0Path: string, size: number, hash: string): MigrateBlobResult {
    live("migrateBlob", run);
    if (!Number.isSafeInteger(size) || size < 0) refuse("migrateBlob", 3, "must be a non-negative integer");
    return glue.migrateBlob(run, text("migrateBlob", 2, v0Path), size, text("migrateBlob", 4, hash)) as MigrateBlobResult;
  },
  /** The media id of `data`, fed to the wasm a view at a time: far faster than hashing in JS. */
  mediaId(data: Uint8Array): string {
    bytes("mediaId", 1, data);
    const hasher = glue.hasherNew();
    for (let at = 0; at < data.length; at += HASH_CHUNK) glue.hasherUpdate(hasher, data.subarray(at, at + HASH_CHUNK));
    return glue.hasherFinish(hasher);
  },
};
