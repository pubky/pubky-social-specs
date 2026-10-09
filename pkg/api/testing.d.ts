import type { SdkPublicStorage, SdkSession } from "./session.js";
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
export declare function setClock(nowMs?: () => number): void;
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
export declare function fakeOwner(n?: number): Owner;
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
export declare function samplePost(input?: Partial<NewNote>, owner?: Given<"Owner">): BuiltPost;
/**
 * A profile for test data.
 *
 * @example
 * ```ts
 * import { sampleUser } from "pubky-social-specs/testing";
 * console.log(sampleUser({ bio: "Testing" }).object.name);
 * ```
 */
export declare function sampleUser(input?: Partial<NewUser>, owner?: Given<"Owner">): Built<User>;
/**
 * A feed for test data.
 *
 * @example
 * ```ts
 * import { sampleFeed } from "pubky-social-specs/testing";
 * console.log(sampleFeed({ tags: ["rust"] }).path);
 * ```
 */
export declare function sampleFeed(input?: Partial<NewFeed>, owner?: Given<"Owner">): Built<Feed>;
/** A session of the in-memory homeserver, as the SDK's: `info`, with the grant's capabilities, and `storage`. */
export type MemorySession = SdkSession & {
    info: {
        capabilities: string[];
    };
};
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
export declare function memoryHomeserver(): MemoryHomeserver;
//# sourceMappingURL=testing.d.ts.map