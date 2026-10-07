// The I/O the engine needs, and nothing else. An adapter over a homeserver client implements
// it; `MemoryPort` implements it over a map for tests.

/** What went wrong with one call, as the engine branches on it. */
export type PortErrorKind =
  /** The homeserver is out of space for this user (507). The run pauses. */
  | "quota"
  /** Too many requests (429). The engine backs off and calls again. */
  | "rate_limited"
  /** The session is gone or lacks the capability (401, 403). The run aborts. */
  | "unauthorized"
  /** Nothing at that URL (404) where the call needed something. */
  | "not_found"
  /** An `ifAbsent` PUT found something at that URL (412) and wrote nothing. */
  | "exists"
  /** The homeserver does not serve that root at all, such as `/priv/` before it had one. */
  | "unsupported"
  /**
   * The request never got an answer, or the homeserver failed it (a 5xx other than 507). The
   * engine retries it, and an object it still fails on ends the run incomplete.
   */
  | "network"
  /**
   * A definitive refusal: a 4xx other than the mapped ones, such as a 413 for a body over the
   * server's limit, with its status.
   */
  | "rejected";

/**
 * The one error type a port throws. Anything else it throws counts as `network`. A 5xx other
 * than 507 is `network` too, never `rejected`: the server failed and the same call may succeed
 * later, while a refusal is recorded as final. `refusal(status)` maps a status this way.
 */
class MigrationPortError extends Error {
  readonly kind: PortErrorKind;
  readonly status?: number;

  constructor(kind: PortErrorKind, message?: string, status?: number) {
    super(message ?? (status === undefined ? kind : `${kind} (${status})`));
    this.name = "MigrationPortError";
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

export interface PutOptions {
  /**
   * Write only when nothing is stored at the URL, and throw `exists` otherwise. Over a
   * homeserver: `If-None-Match: *` where it supports conditional PUT, HEAD then PUT where not.
   */
  ifAbsent?: boolean;
}

/**
 * Every URL is a full `pubky://` URL. A LIST is deep and ascending: every stored URL that
 * starts with the prefix, spelled the same way, after `cursor` when one is given; `next` is
 * the cursor of the following page and absent on the last one. A LIST of a prefix with
 * nothing under it is empty, never an error. `get` gives `null` for a missing object.
 */
export interface MigrationPort {
  list(prefixUrl: string, cursor?: string): Promise<{ urls: string[]; next?: string }>;
  get(url: string): Promise<Uint8Array | null>;
  head(url: string): Promise<boolean>;
  putJson(url: string, object: unknown, options?: PutOptions): Promise<void>;
  putBytes(url: string, bytes: Uint8Array, options?: PutOptions): Promise<void>;
  delete(url: string): Promise<void>;
}

/**
 * The error for a homeserver answer `status`, mapped as the kinds above say. A 400 or 405 that
 * means the root does not exist is `unsupported` only where the adapter knows that; here it
 * is `rejected`.
 */
const refusal = (status: number, message?: string): MigrationPortError => {
  const kind: PortErrorKind =
    status === 507
      ? "quota"
      : status === 429
        ? "rate_limited"
        : status === 401 || status === 403
          ? "unauthorized"
          : status === 404
            ? "not_found"
            : status === 412
              ? "exists"
              : status >= 500
                ? "network"
                : "rejected";
  return new MigrationPortError(kind, message, status);
};

// By name, not by prototype: the ESM and CommonJS builds each have their own class
const portErrorKind = (error: unknown): PortErrorKind => {
  const candidate = error as { name?: unknown; kind?: unknown } | null;
  if (candidate?.name === "MigrationPortError" && typeof candidate.kind === "string") {
    return candidate.kind as PortErrorKind;
  }
  return "network";
};

export { MigrationPortError, portErrorKind, refusal };
