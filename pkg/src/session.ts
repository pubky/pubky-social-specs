// The part of a signed-in pubky SDK session the package calls, `@synonymdev/pubky` >=0.11 <1,
// declared here so nothing that compiles against the package needs the SDK installed. The
// migration's adapter and the client take the same session.

/** The part of a streamed `Response` the port reads. */
export interface SdkResponse {
  /** The response headers; the port reads `content-length`. */
  headers: { get(name: string): string | null };
  /** The body as a stream, or null for none. */
  body: {
    getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>; cancel(): Promise<void> };
    cancel(): Promise<void>;
  } | null;
  /** The whole body at once. */
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** The part of a signed-in SDK `Session` the port calls, as 0.11 to 0.14 declare it. */
export interface SdkSession {
  /** Who the session belongs to: `info.publicKey.z32()` is the bare key. */
  info: { publicKey: { z32(): string } };
  /** Storage of the session's own tree, by absolute path (`/pub/...`, `/priv/...`). */
  storage: {
    list(path: string, cursor?: string | null, reverse?: boolean, limit?: number, shallow?: boolean): Promise<string[]>;
    getBytes(path: string): Promise<Uint8Array>;
    get(path: string): Promise<SdkResponse>;
    exists(path: string): Promise<boolean>;
    putJson(path: string, body: unknown): Promise<void>;
    putBytes(path: string, bytes: Uint8Array): Promise<void>;
    delete(path: string): Promise<void>;
  };
}

/** The part of the SDK's `pubky.publicStorage` the client reads other users' trees with. */
export interface SdkPublicStorage {
  /** The `pubky://` URLs under an address that ends with `/`, a page at a time. */
  list(address: string, cursor?: string | null, reverse?: boolean, limit?: number, shallow?: boolean): Promise<string[]>;
  /** The bytes stored at a `pubky://` address. */
  getBytes(address: string): Promise<Uint8Array>;
}
