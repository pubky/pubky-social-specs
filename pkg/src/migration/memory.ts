import { MigrationPortError } from "./port.js";
import type { GetOptions, MigrationPort, PutOptions } from "./port.js";

/** A port call, as `intercept` sees it. */
export type PortOp = "list" | "get" | "head" | "putJson" | "putBytes" | "delete";

/** How a `MemoryPort` plays a homeserver. */
export interface MemoryPortOptions {
  /**
   * `false` plays a homeserver without the private root: every `/priv/` call throws `unsupported`
   * with the 403 such a homeserver answers.
   */
  privSupported?: boolean;
  /**
   * Runs before every call. Throw a `MigrationPortError` to fail the call, such as
   * `refusal(500)` for the answer a homeserver gives, or change `store` to race it, as another
   * device would.
   */
  intercept?: (op: PortOp, url: string) => void | Promise<void>;
  /** URLs per LIST page, an integer from 1 to 1000 (1000 by default); a homeserver caps it at 1000. A `RangeError` refuses anything else. */
  pageSize?: number;
}

const encoder = new TextEncoder();

/**
 * A homeserver tree in memory, with the LIST semantics of a real one.
 *
 * @example
 * ```ts
 * import { MemoryPort } from "pubky-social-specs/migration";
 * const port = new MemoryPort({ pageSize: 2 });
 * await port.putBytes("pubky://8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto/pub/x", new Uint8Array([1]));
 * console.log(port.store.size, port.calls);
 * ```
 */
class MemoryPort implements MigrationPort {
  /** URL to stored bytes. Read it to check what a run wrote; write it to build a tree. */
  readonly store: Map<string, Uint8Array> = new Map();
  /** Every call in order, including the ones `intercept` failed. */
  readonly calls: { op: PortOp; url: string }[] = [];
  readonly #privSupported: boolean;
  readonly #intercept?: MemoryPortOptions["intercept"];
  readonly #pageSize: number;

  constructor(options: MemoryPortOptions = {}) {
    this.#privSupported = options.privSupported ?? true;
    this.#intercept = options.intercept;
    const pageSize = options.pageSize ?? 1000;
    // An empty first page would read as an empty tree, and a run would finish having seen nothing
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) throw new RangeError(`MemoryPort: pageSize must be an integer from 1 to 1000, not ${pageSize}`);
    this.#pageSize = pageSize;
  }

  /** One page of the stored URLs under `prefixUrl`, as `MigrationPort.list` defines it. */
  async list(prefixUrl: string, cursor?: string): Promise<{ urls: string[]; next?: string }> {
    await this.#enter("list", prefixUrl);
    if (prefixUrl === "") return { urls: [] };
    const matching = [...this.store.keys()].filter((url) => url.startsWith(prefixUrl) && (cursor === undefined || url > cursor)).sort();
    const urls = matching.slice(0, this.#pageSize);
    const last = urls.at(-1);
    return matching.length > this.#pageSize && last !== undefined ? { urls, next: last } : { urls };
  }

  /** The stored bytes, or null. */
  async get(url: string, options?: GetOptions): Promise<Uint8Array | null> {
    await this.#enter("get", url);
    const bytes = this.store.get(url);
    if (bytes === undefined) return null;
    if (options?.maxBytes !== undefined && bytes.length > options.maxBytes) throw new MigrationPortError("too_large");
    return bytes.slice();
  }

  /** Whether `url` is in `store`. */
  async head(url: string): Promise<boolean> {
    await this.#enter("head", url);
    return this.store.has(url);
  }

  /** Stores `object` as its `JSON.stringify` bytes. */
  async putJson(url: string, object: unknown, options?: PutOptions): Promise<void> {
    await this.#enter("putJson", url);
    this.#put(url, encoder.encode(JSON.stringify(object)), options);
  }

  /** Stores a copy of `bytes`. */
  async putBytes(url: string, bytes: Uint8Array, options?: PutOptions): Promise<void> {
    await this.#enter("putBytes", url);
    this.#put(url, bytes.slice(), options);
  }

  /** Removes `url` from `store`. */
  async delete(url: string): Promise<void> {
    await this.#enter("delete", url);
    if (!this.store.delete(url)) throw new MigrationPortError("not_found", undefined, 404);
  }

  #put(url: string, bytes: Uint8Array, options?: PutOptions): void {
    if (options?.ifAbsent && this.store.has(url)) {
      throw new MigrationPortError("exists", undefined, 412);
    }
    this.store.set(url, bytes);
  }

  async #enter(op: PortOp, url: string): Promise<void> {
    this.calls.push({ op, url });
    await this.#intercept?.(op, url);
    if (!this.#privSupported && /^pubky:\/\/[^/]+\/priv\//.test(url)) {
      throw new MigrationPortError("unsupported", "Writing to directories other than '/pub/' is forbidden", 403);
    }
  }
}

export { MemoryPort };
