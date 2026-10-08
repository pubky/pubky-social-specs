import type { Dropped, SkipReason } from "./wasm.js";
import type { MigrationPort } from "./port.js";
import type { Bucket } from "./order.js";

/** What happened to one 0.x object. */
export type Outcome =
  | SkipReason
  /** Copied to its 1.x path. */
  | "written"
  /** Its 1.x copy exists already, in either root; it is never overwritten. */
  | "already_present"
  /** The 0.x object vanished during the run, so its copy was deleted or never made. */
  | "deleted_mid_run"
  /** The homeserver did not answer, three retries included, or refused a read. The run ends incomplete. */
  | "io_error"
  /** The homeserver refused the PUT. */
  | "put_rejected";

export type Counts = Record<Outcome, number>;

export type Phase = "probe" | "listing" | "migrating" | "flag" | "done" | "incomplete" | "paused" | "aborted";

export type ErrorCode =
  /** Another tab holds the lock for this owner. */
  | "ALREADY_RUNNING"
  /** The homeserver has no private root; migration needs it for the private types and the flag. */
  | "PRIV_UNSUPPORTED"
  /** The session lacks part of `ENGINE_CAPS`. */
  | "CAPS_MISSING"
  /** The homeserver is full; `needBytes` estimates what the rest of the media needs. */
  | "QUOTA"
  /** The session expired or lost its capabilities mid-run. */
  | "SESSION_EXPIRED"
  /** A LIST, a File object or the flag could not be read or written. */
  | "IO_ERROR"
  /** This build writes an epoch the engine does not walk to. */
  | "UNSUPPORTED_EPOCH"
  /** The caller's `signal` fired. */
  | "ABORTED";

export interface MigrationError {
  code: ErrorCode;
  message: string;
  needBytes?: number;
  /** With `CAPS_MISSING`: the scopes to ask for. */
  caps?: string;
}

export interface ProgressEvent {
  phase: Phase;
  /** The pass being walked, named by its 0.x directory. */
  pass?: Bucket;
  /** 0.x objects finished, out of `total` listed. */
  done: number;
  total: number;
  counts: Counts;
  /** Values the 1.x rules refused and left out of an object that still migrated. */
  dropped: number;
  /** The 0.x URL just finished. */
  current?: string;
  error?: MigrationError;
}

export interface MigrationReport {
  /**
   * `incomplete`: the walk finished but some objects hit `io_error`, so no flag was written
   * and the next run walks again.
   */
  status: "done" | "already_migrated" | "incomplete" | "paused" | "aborted";
  mode: "run" | "dry";
  done: number;
  total: number;
  counts: Counts;
  dropped: number;
  /** Owner-relative 0.x path to the values left out of it. */
  droppedValues: Record<string, Dropped[]>;
  /** The owner-relative 0.x paths that did not land, by outcome: what the flag records. */
  skipped: Partial<Record<Outcome, string[]>>;
  /** Detail for a path in `skipped`: the reader's message, the refusal's status. */
  notes: { path: string; message: string }[];
  error?: MigrationError;
}

/** The part of an `AbortSignal` the run uses, which browsers and Node share. */
export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

/**
 * Runs `fn` holding the lock `name`, and passes it `null` when another holder has it, which
 * is what `(name, fn) => navigator.locks.request(name, { ifAvailable: true }, fn)` does.
 */
export type MigrationLock = <T>(name: string, fn: (lock: unknown) => Promise<T>) => Promise<T>;

export interface RunOptions {
  /** The pubky whose tree migrates; the session must be theirs. */
  owner: string;
  port: MigrationPort;
  /** `"dry"` reads and counts, and writes, re-checks and deletes nothing. */
  mode?: "run" | "dry";
  /** Walk the tree even when the flag says this revision already did. */
  rescan?: boolean;
  onProgress?: (event: ProgressEvent) => void;
  /** Stops the run after the objects in flight; run again to resume. */
  signal?: AbortSignalLike;
  /** Without one the run is unlocked. */
  lock?: MigrationLock;
  /**
   * The session's capabilities, as one comma-separated string or a list of scopes. When given,
   * the run checks they cover `ENGINE_CAPS` before any request.
   */
  caps?: string | string[];
  /** How the run waits between retries; it should resolve early when `signal` aborts. A timer by default. */
  sleep?: (ms: number, signal?: AbortSignalLike) => Promise<void>;
}
