// The walk order over the 0.x tree. The File objects come first because the run reads them
// to rewrite every media reference after them; the rest is leaf first, so a reference tends
// to land after its target, and the private types last.

import { LEGACY_ROOT } from "../legacy.js";
import { splitPubky } from "../path.js";

const BUCKETS = ["files", "blobs", "posts", "tags", "follows", "profile", "feeds", "bookmarks", "mutes"] as const;

/** One pass of the walk, named by the 0.x resource segment. */
export type Bucket = (typeof BUCKETS)[number];

/**
 * The bucket of a path relative to the 0.x namespace (`posts/X`, `profile.json`), or `null`
 * for one no pass migrates, such as `settings.json` and `last_read`.
 */
const legacyBucket = (legacyRelative: string): Bucket | null => {
  if (legacyRelative === "profile.json") return "profile";
  const slash = legacyRelative.indexOf("/");
  if (slash <= 0 || slash === legacyRelative.length - 1) return null;
  const segment = legacyRelative.slice(0, slash);
  return (BUCKETS as readonly string[]).includes(segment) && segment !== "profile" ? (segment as Bucket) : null;
};

/** Items grouped by bucket in walk order, and the ones no pass takes. */
const ordered = <T>(items: T[], legacyRelative: (item: T) => string): { passes: [Bucket, T[]][]; rest: T[] } => {
  const groups = new Map<Bucket, T[]>(BUCKETS.map((bucket) => [bucket, []]));
  const rest: T[] = [];
  for (const item of items) {
    const bucket = legacyBucket(legacyRelative(item));
    if (bucket === null) rest.push(item);
    else groups.get(bucket)?.push(item);
  }
  return { passes: [...groups], rest };
};

// The 0.x namespace is frozen, so the path is spelled here instead of asking the wasm for it
const LEGACY_NAMESPACE = LEGACY_ROOT.slice(1);

/**
 * The pass that walks a stored object, by its owner-relative path (`pub/pubky.app/posts/X`,
 * with or without a leading `/`) or its `pubky://` URL: what an app counts over a LIST to
 * preview a migration without running it. `"rest"` is an object no pass migrates, which a run
 * counts `not_migrated`, or a path outside the 0.x tree.
 *
 * @example
 * ```ts
 * import { bucketOf } from "pubky-social-specs/migration";
 * console.log(bucketOf("/pub/pubky.app/posts/0034A0X7NJ52C"));
 * ```
 */
const bucketOf = (ownerRelativePathOrUrl: string): Bucket | "rest" => {
  const split = splitPubky(ownerRelativePathOrUrl);
  const path = split !== null ? (split.path ?? "") : ownerRelativePathOrUrl.replace(/^\//, "");
  if (!path.startsWith(LEGACY_NAMESPACE)) return "rest";
  return legacyBucket(path.slice(LEGACY_NAMESPACE.length)) ?? "rest";
};

export { bucketOf, ordered };
