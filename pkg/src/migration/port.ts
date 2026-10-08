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
  /** A GET found more than its `maxBytes` and stopped reading. The object skips as `oversize`. */
  | "too_large"
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

const BRAND = Symbol.for("pubky-social-specs.MigrationPortError");

/**
 * The one error type a port throws. Anything else it throws counts as `network`. A 5xx other
 * than 507 is `network` too, never `rejected`: the server failed and the same call may succeed
 * later, while a refusal is recorded as final. `refusal(status)` maps a status this way.
 *
 * @example
 * ```ts
 * import { MemoryPort, MigrationPortError, runMigration } from "pubky-social-specs/migration";
 * const owner = "8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto";
 * const port = new MemoryPort({ intercept: (op) => { if (op === "head") throw new MigrationPortError("unauthorized", "signed out", 401); } });
 * console.log((await runMigration({ owner, port })).error?.code);
 * ```
 */
class MigrationPortError extends Error {
  /** `"MigrationPortError"`, as a stack trace and a log print it. */
  override name = "MigrationPortError";
  /** What went wrong, in the terms the engine acts on: retry, stop, or count the object. */
  readonly kind: PortErrorKind;
  /** The HTTP status the homeserver answered, when there was one. */
  readonly status?: number;
  readonly [BRAND] = true;

  constructor(kind: PortErrorKind, message?: string, status?: number) {
    super(message ?? (status === undefined ? kind : `${kind} (${status})`));
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }

  // An adapter built against another installed copy of the package throws that copy's class
  static override [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === "object" && value !== null && Object.hasOwn(value, BRAND);
  }
}

/** What the engine asks of a GET. */
export interface GetOptions {
  /**
   * The most bytes the engine takes. Over it, a port throws `too_large` instead of reading
   * the rest; one that cannot tell may return the bytes, and the engine skips them all the same.
   */
  maxBytes?: number;
}

/** What the engine asks of a PUT. */
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
  /** One page of the URLs under `prefixUrl`, after `cursor`; `next` is absent on the last page. */
  list(prefixUrl: string, cursor?: string): Promise<{ urls: string[]; next?: string }>;
  /** The bytes at `url`, or null when nothing is stored there. */
  get(url: string, options?: GetOptions): Promise<Uint8Array | null>;
  /** Whether anything is stored at `url`. */
  head(url: string): Promise<boolean>;
  /** Stores `object` as JSON the port spells; the engine uses it only for the flag. */
  putJson(url: string, object: unknown, options?: PutOptions): Promise<void>;
  /** Stores `bytes` exactly as given. */
  putBytes(url: string, bytes: Uint8Array, options?: PutOptions): Promise<void>;
  /** Removes what is stored at `url`; nothing stored there is no error. */
  delete(url: string): Promise<void>;
}

const MAPPED: Partial<Record<number, PortErrorKind>> = {
  401: "unauthorized",
  403: "unauthorized",
  404: "not_found",
  412: "exists",
  429: "rate_limited",
  507: "quota",
};

/**
 * The error for a homeserver answer `status`, mapped as the kinds above say. A 403 that means
 * the root does not exist is `unsupported` only where the adapter can tell from its text; here
 * it is `unauthorized`.
 *
 * @example
 * ```ts
 * import { refusal } from "pubky-social-specs/migration";
 * console.log(refusal(507).kind, refusal(429).kind, refusal(503).kind);
 * ```
 */
const refusal = (status: number, message?: string): MigrationPortError => new MigrationPortError(MAPPED[status] ?? (status >= 500 ? "network" : "rejected"), message, status);

export { MigrationPortError, refusal };
