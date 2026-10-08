// The closed name sets. A stored name this version does not know is kept as it was read, so a
// reader survives a newer writer and writes its name back; a builder takes only the names it
// knows.

import { fail } from "../errors.js";
import { type Codec, string } from "../json/schema.js";

/**
 * @example
 * ```ts
 * import { postKinds } from "pubky-social-specs";
 * console.log(postKinds.includes("article"));
 * ```
 */
export const postKinds = Object.freeze(["note", "article", "image", "video", "link", "file", "collection"] as const);
/**
 * @example
 * ```ts
 * import { feedReaches } from "pubky-social-specs";
 * for (const reach of feedReaches) console.log(reach);
 * ```
 */
export const feedReaches = Object.freeze(["following", "followers", "friends", "all", "wot", "me"] as const);
/**
 * @example
 * ```ts
 * import { feedLayouts } from "pubky-social-specs";
 * console.log(feedLayouts.join(", "));
 * ```
 */
export const feedLayouts = Object.freeze(["columns", "wide", "visual", "list"] as const);
/**
 * @example
 * ```ts
 * import { feedSorts } from "pubky-social-specs";
 * console.log(feedSorts.join(", "));
 * ```
 */
export const feedSorts = Object.freeze(["recent", "popularity"] as const);
/**
 * @example
 * ```ts
 * import { collectionLayouts } from "pubky-social-specs";
 * console.log(collectionLayouts.join(", "));
 * ```
 */
export const collectionLayouts = Object.freeze(["grid", "list", "visual"] as const);

export type KnownPostKind = (typeof postKinds)[number];
export type KnownFeedReach = (typeof feedReaches)[number];
export type KnownFeedLayout = (typeof feedLayouts)[number];
export type KnownFeedSort = (typeof feedSorts)[number];
export type KnownCollectionLayout = (typeof collectionLayouts)[number];
/** A name of the set, or one a newer writer used, kept with its spelling. */
export type OrNewer<T extends string> = T | (string & {});
export type PostKind = OrNewer<KnownPostKind>;
export type FeedReach = OrNewer<KnownFeedReach>;
export type FeedLayout = OrNewer<KnownFeedLayout>;
export type FeedSort = OrNewer<KnownFeedSort>;
export type CollectionLayout = OrNewer<KnownCollectionLayout>;

// A name is read and written as a string; the model's rules decide whether one this version
// does not know is valid where it stands
export const postKind: Codec<PostKind> = string;
export const feedReach: Codec<FeedReach> = string;
export const feedLayout: Codec<FeedLayout> = string;
export const feedSort: Codec<FeedSort> = string;
export const collectionLayout: Codec<CollectionLayout> = string;

/** Whether `name` is one of `names`, not one a newer writer used. */
export const isKnown = (names: readonly string[], name: string): boolean => names.includes(name);

/** A name a builder was given at `input.{field}`: one of `names`, or a refusal naming `what`. */
export function known<T extends string>(names: readonly T[], what: string, js: unknown, field: string): T {
  const name = string.parse(js, `input.${field}`);
  return (names as readonly string[]).includes(name) ? (name as T) : fail("unknown_name", `Invalid ${what}: ${name}`, field);
}
