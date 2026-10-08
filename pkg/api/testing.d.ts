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
//# sourceMappingURL=testing.d.ts.map