// pubky-social-specs/testing: what a test of code built on the package needs and an app never
// does. Kept off the main entry so a production import cannot freeze every id.

import * as clock from "./clock.js";
import { misuse } from "./errors.js";
import { ZBASE32 } from "./ids.js";
import { buildFeed, buildPost, buildUser } from "./index.js";
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
