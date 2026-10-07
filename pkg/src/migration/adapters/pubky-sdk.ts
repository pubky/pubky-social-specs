// The port over a session of the pubky SDK, `@synonymdev/pubky` >=0.11 <1: the session
// storage it calls has the same shape and answers from 0.11 to 0.14. The adapter works on the
// session it is given and declares the part it calls itself, so the host installs the SDK, the
// engine never loads it, and these declarations compile without it. The package does not
// declare it as a peer dependency, since a host on another SDK line would fail to install.

import { isCanonicalSegment } from "../../canonicalize.js";
import { MigrationPortError, refusal } from "../port.js";
import type { GetOptions, MigrationPort, PortErrorKind, PutOptions } from "../port.js";

/** The part of a streamed `Response` the port reads. */
export interface SdkResponse {
  headers: { get(name: string): string | null };
  body: {
    getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> };
    cancel(): Promise<void>;
  } | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** The part of a signed-in SDK `Session` the port calls, as 0.11 to 0.14 declare it. */
export interface SdkSession {
  info: { publicKey: { z32(): string } };
  storage: {
    list(path: string, cursor: string | null, reverse: boolean, limit: number, shallow: boolean): Promise<string[]>;
    getBytes(path: string): Promise<Uint8Array>;
    get(path: string): Promise<SdkResponse>;
    exists(path: string): Promise<boolean>;
    putJson(path: string, body: unknown): Promise<void>;
    putBytes(path: string, bytes: Uint8Array): Promise<void>;
    delete(path: string): Promise<void>;
  };
}

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
const NAMED: Partial<Record<string, PortErrorKind>> = {
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
    return new MigrationPortError((Object.hasOwn(NAMED, name) && NAMED[name]) || "network", message);
  }
  if (status === 403 && message.includes(PRE_PRIV)) return new MigrationPortError("unsupported", message, status);
  // The SDK reads a 410 as missing, as its `exists` does
  if (status === 410) return new MigrationPortError("not_found", message, status);
  return refusal(status, message);
};

class SdkPort implements MigrationPort {
  readonly #storage: SdkSession["storage"];
  readonly #ownerPrefix: string;
  readonly #pageSize: number;
  readonly #deadlineMs: number;

  constructor(session: SdkSession, options: SdkPortOptions = {}) {
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

  async get(url: string, options?: GetOptions): Promise<Uint8Array | null> {
    const path = this.#path(url);
    const max = options?.maxBytes;
    try {
      // A blob's download grows with its size and the SDK gives no progress, so only an
      // object's GET has the deadline
      const read = () => (max === undefined ? this.#storage.getBytes(path) : this.#capped(path, max));
      return await this.#call(read, !isBlobPath(path));
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

  /** The body, read as a stream and dropped once it runs past `max`. */
  async #capped(path: string, max: number): Promise<Uint8Array> {
    const response = await this.#storage.get(path);
    const tooLarge = () => new MigrationPortError("too_large", `${path} is over ${max} bytes`);
    if (Number(response.headers.get("content-length")) > max) {
      await response.body?.cancel();
      throw tooLarge();
    }
    if (response.body === null) return new Uint8Array(await response.arrayBuffer());
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      if (chunk.value === undefined) continue;
      total += chunk.value.length;
      if (total > max) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    return bytes;
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

  #path(url: string): string {
    const path = url.startsWith(this.#ownerPrefix) ? url.slice(this.#ownerPrefix.length - 1) : "";
    // Every segment but a directory's empty tail, so no dot segment resolves elsewhere
    const segments = path.split("/").slice(2);
    const clean = segments.every((segment, i) => isCanonicalSegment(segment) || (segment === "" && i === segments.length - 1));
    if ((!path.startsWith("/pub/") && !path.startsWith("/priv/")) || !clean) {
      throw new MigrationPortError("rejected", `${url} is not a clean path under /pub/ or /priv/ of the session's owner`);
    }
    return path;
  }
}

/**
 * The migration port over a signed-in session of `@synonymdev/pubky` >=0.11 <1: every URL has to
 * be in the session owner's tree. `ifAbsent` is a HEAD then the PUT, which leaves a one round
 * trip window.
 */
const sdkPort = (session: SdkSession, options?: SdkPortOptions): MigrationPort => new SdkPort(session, options);

export { sdkPort };
