// The port over a session of the pubky SDK, `@synonymdev/pubky` >=0.11 <1: the session
// storage it calls has the same shape and answers from 0.11 to 0.14. Only its types are
// imported: the adapter works on the session it is given, so the host installs the SDK and the
// engine never loads it. The package does not declare it as a peer dependency, since a host on
// another SDK line would fail to install.

import type { Path, PubkyErrorName, Session } from "@synonymdev/pubky";
import { MigrationPortError, refusal } from "../port.js";
import type { MigrationPort, PortErrorKind, PutOptions } from "../port.js";

export interface SdkPortOptions {
  /** URLs per LIST page, 1 to 1000; the homeserver caps it at 1000. */
  pageSize?: number;
  /**
   * Milliseconds a read may wait for its answer before it counts as `network`, 60000 by
   * default: LIST, HEAD and the GET of a JSON object. A blob's GET grows with its size, and a
   * write (`putJson`, `putBytes`, DELETE) stays pending until the SDK settles it: the SDK takes
   * no signal, and a write abandoned at a deadline could still land after a later run cleaned
   * up behind it.
   */
  deadlineMs?: number;
}

const MAX_PAGE = 1000;
const DEFAULT_DEADLINE_MS = 60_000;
// The two media directories of the trees the engine reads and writes
const isBlobPath = (path: string): boolean => path.startsWith("/pub/pubky.app/blobs/") || path.startsWith("/pub/social/v1/files/");

// What a homeserver without the private root answers a request under `/priv/`. A current one
// names both roots in the same refusal, for paths outside them, which the engine never asks.
const PRE_PRIV = "other than '/pub/' is forbidden";

// Without a status, the SDK's name says whether the request went out at all
const NAMED: Partial<Record<PubkyErrorName, PortErrorKind>> = {
  AuthenticationError: "unauthorized",
  InvalidInput: "rejected",
  ClientStateError: "rejected",
  InternalError: "rejected",
};

const statusOf = (error: unknown): number | undefined => {
  const status = (error as { data?: { statusCode?: unknown } } | null)?.data?.statusCode;
  return typeof status === "number" ? status : undefined;
};

const portError = (error: unknown): MigrationPortError => {
  // Already mapped once, by the deadline or an inner call
  if (error instanceof MigrationPortError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const status = statusOf(error);
  if (status === undefined) {
    const name = error instanceof Error ? error.name : "";
    return new MigrationPortError(NAMED[name as PubkyErrorName] ?? "network", message);
  }
  if (status === 403 && message.includes(PRE_PRIV)) return new MigrationPortError("unsupported", message, status);
  // The SDK reads a 410 as missing, as its `exists` does
  if (status === 410) return new MigrationPortError("not_found", message, status);
  return refusal(status, message);
};

class SdkPort implements MigrationPort {
  readonly #storage: Session["storage"];
  readonly #ownerPrefix: string;
  readonly #pageSize: number;
  readonly #deadlineMs: number;

  constructor(session: Session, options: SdkPortOptions = {}) {
    const pageSize = options.pageSize ?? MAX_PAGE;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE) {
      throw new RangeError(`sdkPort: pageSize must be an integer from 1 to ${MAX_PAGE}, not ${pageSize}`);
    }
    const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
    if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
      throw new RangeError(`sdkPort: deadlineMs must be a positive number, not ${deadlineMs}`);
    }
    this.#storage = session.storage;
    this.#ownerPrefix = `pubky://${session.info.publicKey.z32()}/`;
    this.#pageSize = pageSize;
    this.#deadlineMs = deadlineMs;
  }

  async list(prefixUrl: string, cursor?: string): Promise<{ urls: string[]; next?: string }> {
    // The SDK lists directories only, and a cursor is a URL it listed
    const path = this.#path(prefixUrl);
    if (!path.endsWith("/")) {
      throw new MigrationPortError("rejected", `${prefixUrl}: a LIST prefix must end with /`);
    }
    let urls: string[];
    try {
      urls = await this.#call(() => this.#storage.list(path, cursor ?? null, false, this.#pageSize, false));
    } catch (error) {
      const failure = portError(error);
      if (failure.kind === "not_found") return { urls: [] };
      throw failure;
    }
    // A server or a proxy may cap the page below the size asked, so only an empty page ends the walk
    return urls.length > 0 ? { urls, next: urls[urls.length - 1] } : { urls };
  }

  async get(url: string): Promise<Uint8Array | null> {
    const path = this.#path(url);
    try {
      // A blob's download grows with its size and the SDK gives no progress, so only an
      // object's GET has the deadline
      return await this.#call(() => this.#storage.getBytes(path), !isBlobPath(path));
    } catch (error) {
      const failure = portError(error);
      if (failure.kind === "not_found") return null;
      throw failure;
    }
  }

  async head(url: string): Promise<boolean> {
    const path = this.#path(url);
    try {
      return await this.#call(() => this.#storage.exists(path));
    } catch (error) {
      const failure = portError(error);
      if (failure.status !== 403) throw failure;
      // A HEAD carries no body, so the reason of the refusal is read from a GET, whose body is
      // dropped unread when it succeeds
      try {
        const response = await this.#call(() => this.#storage.get(path));
        await response.body?.cancel();
        return true;
      } catch (retry) {
        const refused = portError(retry);
        if (refused.kind === "not_found") return false;
        throw refused;
      }
    }
  }

  /**
   * With `ifAbsent`, a HEAD then the PUT: the homeserver ignores `If-None-Match` on a PUT, so
   * this is check-then-write, and a write landing between the two is overwritten. A PUT whose
   * answer was lost is retried the same way, so the HEAD finds the copy it made and it throws
   * `exists`.
   */
  async putJson(url: string, object: unknown, options?: PutOptions): Promise<void> {
    const path = this.#path(url);
    await this.#absent(url, options);
    await this.#call(() => this.#storage.putJson(path, object), false);
  }

  /** `ifAbsent` as `putJson` does it. */
  async putBytes(url: string, bytes: Uint8Array, options?: PutOptions): Promise<void> {
    const path = this.#path(url);
    await this.#absent(url, options);
    await this.#call(() => this.#storage.putBytes(path, bytes), false);
  }

  async delete(url: string): Promise<void> {
    const path = this.#path(url);
    await this.#call(() => this.#storage.delete(path), false);
  }

  async #absent(url: string, options?: PutOptions): Promise<void> {
    if (options?.ifAbsent && (await this.head(url))) {
      throw new MigrationPortError("exists", `${url} exists`);
    }
  }

  /**
   * An SDK call, under the deadline unless `bounded` is false: an answer that never comes is a
   * `network` failure. Only reads are bounded; a write abandoned by the caller could still
   * commit after the engine's retry and cleanup, so it stays pending until the SDK settles it.
   * The timer stays referenced while the race is pending, so a process waiting on it does not
   * exit before it fires; it is cleared as soon as the call settles.
   */
  async #call<T>(call: () => Promise<T>, bounded = true): Promise<T> {
    if (!bounded) {
      try {
        return await call();
      } catch (error) {
        throw portError(error);
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new MigrationPortError("network", `no answer in ${this.#deadlineMs} ms`)),
        this.#deadlineMs,
      );
    });
    try {
      return await Promise.race([call(), deadline]);
    } catch (error) {
      throw portError(error);
    } finally {
      clearTimeout(timer);
    }
  }

  #path(url: string): Path {
    const path = url.startsWith(this.#ownerPrefix) ? url.slice(this.#ownerPrefix.length - 1) : "";
    if (!path.startsWith("/pub/") && !path.startsWith("/priv/")) {
      throw new MigrationPortError("rejected", `${url} is not under /pub/ or /priv/ of the session's owner`);
    }
    return path as Path;
  }
}

/**
 * The migration port over a signed-in session of `@synonymdev/pubky` >=0.11 <1: every URL has to
 * be in the session owner's tree. `ifAbsent` is a HEAD then the PUT, which leaves a one round
 * trip window.
 */
const sdkPort = (session: Session, options?: SdkPortOptions): MigrationPort => new SdkPort(session, options);

export { sdkPort };
