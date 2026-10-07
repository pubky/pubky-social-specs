import { MigrationPortError } from "./port.js";
import type { GetOptions, MigrationPort, PutOptions } from "./port.js";

/** A port call, as `intercept` sees it. */
export type PortOp = "list" | "get" | "head" | "putJson" | "putBytes" | "delete";

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
  /** URLs per LIST page; a homeserver caps it at 1000. */
  pageSize?: number;
}

const encoder = new TextEncoder();

/** A homeserver tree in memory, with the LIST semantics of a real one. */
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
    this.#pageSize = options.pageSize ?? 1000;
  }

  async list(prefixUrl: string, cursor?: string): Promise<{ urls: string[]; next?: string }> {
    await this.#enter("list", prefixUrl);
    if (prefixUrl === "") return { urls: [] };
    const matching = [...this.store.keys()]
      .filter((url) => url.startsWith(prefixUrl) && (cursor === undefined || url > cursor))
      .sort();
    const urls = matching.slice(0, this.#pageSize);
    const last = urls.at(-1);
    return matching.length > this.#pageSize && last !== undefined ? { urls, next: last } : { urls };
  }

  async get(url: string, options?: GetOptions): Promise<Uint8Array | null> {
    await this.#enter("get", url);
    const bytes = this.store.get(url);
    if (bytes === undefined) return null;
    if (options?.maxBytes !== undefined && bytes.length > options.maxBytes) throw new MigrationPortError("too_large");
    return bytes.slice();
  }

  async head(url: string): Promise<boolean> {
    await this.#enter("head", url);
    return this.store.has(url);
  }

  async putJson(url: string, object: unknown, options?: PutOptions): Promise<void> {
    await this.#enter("putJson", url);
    this.#put(url, encoder.encode(JSON.stringify(object)), options);
  }

  async putBytes(url: string, bytes: Uint8Array, options?: PutOptions): Promise<void> {
    await this.#enter("putBytes", url);
    this.#put(url, bytes.slice(), options);
  }

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
