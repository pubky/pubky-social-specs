// pubky-social-specs/testing: what a test of code built on the package needs and an app never
// does. Kept off the main entry so a production import cannot freeze every id.

import * as clock from "./clock.js";
import { misuse } from "./errors.js";
import { ZBASE32 } from "./ids.js";
import { buildFeed, buildPost, buildUser } from "./index.js";
import type { SdkPublicStorage, SdkResponse, SdkSession } from "./session.js";
import type { Built, BuiltPost, Feed, Given, NewFeed, NewNote, NewUser, Owner, User } from "./types.js";

/**
 * Replaces the clock, for tests: `nowMs` gives milliseconds as `Date.now` does, so ids and
 * `created_at` are known in advance. Without an argument the engine's clock is back. Either
 * way the guard that keeps ids increasing starts over. The clock is per copy of the
 * package, so test workers that share one module instance share it too.
 *
 * @example
 * ```ts
 * import { buildPost } from "pubky-social-specs";
 * import { setClock } from "pubky-social-specs/testing";
 * const owner = "8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto";
 * setClock(() => Date.UTC(2026, 0, 1));
 * console.log(buildPost(owner, { content: "pinned" }).id);
 * setClock();
 * ```
 */
export function setClock(nowMs?: () => number): void {
  if (nowMs === undefined) {
    clock.pin(null);
    return;
  }
  if (typeof nowMs !== "function") misuse("nowMs", "a function giving milliseconds, as Date.now does");
  clock.pin(() => {
    const now = nowMs();
    if (!Number.isSafeInteger(now)) misuse("the clock given to setClock", "returning an integer of milliseconds");
    return BigInt(now) * 1000n;
  });
}

/**
 * A public key for test data, the same for the same `n`: well formed, so every builder takes
 * it, with no private key behind it, so it can sign nothing.
 *
 * @example
 * ```ts
 * import { buildFollow } from "pubky-social-specs";
 * import { fakeOwner } from "pubky-social-specs/testing";
 * const follow = buildFollow(fakeOwner(1), fakeOwner(2));
 * console.log(follow.path);
 * ```
 */
export function fakeOwner(n = 0): Owner {
  if (!Number.isSafeInteger(n) || n < 0) misuse("n", "a non-negative integer");
  let s = (n ^ 0x2545f491) >>> 0 || 1;
  let key = "";
  for (let i = 0; i < 51; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    key += ZBASE32.charAt((s >>> 0) % 32);
  }
  // The last character's spare bits are zero in the one canonical spelling
  return `${key}y` as Owner;
}

/**
 * A post for test data: a note by `fakeOwner()` unless the input or the owner says otherwise.
 *
 * @example
 * ```ts
 * import { decodeObject } from "pubky-social-specs";
 * import { samplePost } from "pubky-social-specs/testing";
 * const post = samplePost({ content: "Fixture" });
 * console.log(decodeObject(post.url, post.body, "post").content);
 * ```
 */
export function samplePost(input: Partial<NewNote> = {}, owner: Given<"Owner"> = fakeOwner()): BuiltPost {
  return buildPost(owner, { content: "A sample post", ...input });
}

/**
 * A profile for test data.
 *
 * @example
 * ```ts
 * import { sampleUser } from "pubky-social-specs/testing";
 * console.log(sampleUser({ bio: "Testing" }).object.name);
 * ```
 */
export function sampleUser(input: Partial<NewUser> = {}, owner: Given<"Owner"> = fakeOwner()): Built<User> {
  return buildUser(owner, { name: "Sample User", ...input });
}

/**
 * A feed for test data.
 *
 * @example
 * ```ts
 * import { sampleFeed } from "pubky-social-specs/testing";
 * console.log(sampleFeed({ tags: ["rust"] }).path);
 * ```
 */
export function sampleFeed(input: Partial<NewFeed> = {}, owner: Given<"Owner"> = fakeOwner()): Built<Feed> {
  return buildFeed(owner, { name: "Sample Feed", icon: "star", reach: "all", layout: "columns", sort: "recent", ...input });
}

/** A session of the in-memory homeserver, as the SDK's: `info`, with the grant's capabilities, and `storage`. */
export type MemorySession = SdkSession & { info: { capabilities: string[] } };

/** What `memoryHomeserver` gives: two users, their sessions, and anyone's public tree. */
export interface MemoryHomeserver {
  /** The signed-in user of the examples: a bare z-base32 key, 52 characters, no `pubky://`. */
  owner: Owner;
  /** Another user, to follow, reply to and read. */
  friend: Owner;
  /** A signed-in session of `owner`. */
  session: MemorySession;
  /** A signed-in session of `friend`, to put something in another user's tree. */
  friendSession: MemorySession;
  /** Anyone's public tree by `pubky://` address, as the SDK's `pubky.publicStorage`. */
  publicStorage: SdkPublicStorage;
  /** A signed-in session of any key, on the same store. */
  sessionOf(owner: Given<"Owner">): MemorySession;
}

// An address as the SDK takes one, `pubky://<key>/<path>` or `pubky<key>/<path>`, under the public root
function publicUrl(address: string): string {
  const url = address.startsWith("pubky://") ? address : address.startsWith("pubky") ? `pubky://${address.slice(5)}` : null;
  if (url === null) throw Object.assign(new Error(`not a pubky address: ${address}`), { name: "InvalidInput" });
  if (!/^pubky:\/\/[^/]+\/pub\//.test(url)) throw notFound(url);
  return url;
}

// What the SDK throws for a missing file or directory, which the port maps to absent
const notFound = (url: string) => Object.assign(new Error(`404 Not Found: ${url}`), { name: "RequestError", data: { statusCode: 404 } });

// Answered on a later tick, as the SDK answers, so a throw is a rejection
const later = <R>(answer: () => R): Promise<R> => Promise.resolve().then(answer);

/**
 * An in-memory homeserver with the calls, arguments and answers of `@synonymdev/pubky` 0.14,
 * for tests and examples: a missing file or directory is a `RequestError` with
 * `data.statusCode` 404, and a LIST is recursive, a page of at most `limit` URLs (1000 by
 * default) sorted as strings, after `cursor`. Each call makes a new, empty store.
 *
 * @example
 * ```ts
 * import { buildPost } from "pubky-social-specs";
 * import { memoryHomeserver } from "pubky-social-specs/testing";
 * const { owner, session } = memoryHomeserver();
 * const post = buildPost(owner, { content: "Hello" });
 * await session.storage.putBytes(post.path, post.body);
 * console.log(await session.storage.list("/pub/social/v1/posts/"));
 * ```
 */
export function memoryHomeserver(): MemoryHomeserver {
  // Every stored file of every user, by full `pubky://` URL
  const files = new Map<string, Uint8Array>();
  const listed = (prefix: string, cursor?: string | null, reverse?: boolean, limit?: number): string[] => {
    if (!prefix.endsWith("/")) throw Object.assign(new Error(`a LIST path ends with /: ${prefix}`), { name: "InvalidInput" });
    const urls = [...files.keys()].filter((url) => url.startsWith(prefix)).sort();
    if (urls.length === 0) throw notFound(prefix);
    if (reverse === true) urls.reverse();
    const after = cursor === undefined || cursor === null ? 0 : urls.indexOf(cursor) + 1;
    return urls.slice(after, after + (limit ?? 1000));
  };
  const read = (url: string): Uint8Array => {
    const bytes = files.get(url);
    if (bytes === undefined) throw notFound(url);
    return bytes;
  };
  const response = (bytes: Uint8Array): SdkResponse => {
    let done = false;
    const reader = {
      read: () => {
        const chunk = done ? { done: true } : { done: false, value: bytes };
        done = true;
        return Promise.resolve(chunk);
      },
      cancel: () => Promise.resolve(),
    };
    return {
      headers: { get: (name) => (name.toLowerCase() === "content-length" ? String(bytes.length) : null) },
      body: { getReader: () => reader, cancel: () => Promise.resolve() },
      arrayBuffer: () => Promise.resolve(bytes.slice().buffer),
    };
  };
  const sessionOf = (key: Given<"Owner">): MemorySession => {
    const url = (path: string) => `pubky://${key}${path}`;
    return {
      info: { publicKey: { z32: () => key }, capabilities: ["/pub/social/v1/:rw", "/priv/social/v1/:rw"] },
      storage: {
        list: (path, cursor, reverse, limit) => later(() => listed(url(path), cursor, reverse, limit)),
        getBytes: (path) => later(() => read(url(path))),
        get: (path) => later(() => response(read(url(path)))),
        exists: (path) => Promise.resolve(files.has(url(path))),
        putJson: (path, body) => Promise.resolve(void files.set(url(path), new TextEncoder().encode(JSON.stringify(body)))),
        putBytes: (path, bytes) => Promise.resolve(void files.set(url(path), new Uint8Array(bytes))),
        delete: (path) => Promise.resolve(void files.delete(url(path))),
      },
    };
  };
  const owner = "8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto" as Owner;
  const friend = "dzswkfy7ek3bqnoc89jxuqqfbzhjrj6mi8qthgbxxcqkdugm3rio" as Owner;
  return {
    owner,
    friend,
    session: sessionOf(owner),
    friendSession: sessionOf(friend),
    sessionOf,
    // Only the public root is anyone's to read
    publicStorage: {
      list: (address, cursor, reverse, limit) => later(() => listed(publicUrl(address), cursor, reverse, limit)),
      getBytes: (address) => later(() => read(publicUrl(address))),
    },
  };
}
