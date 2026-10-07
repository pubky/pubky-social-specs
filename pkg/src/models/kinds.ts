// The closed name sets. A stored name this version does not know reads as "unknown", so a
// reader survives a newer writer; a builder takes only the names it knows.

import { fail } from "../errors.js";
import { string, variant } from "../json/schema.js";

export const postKinds = Object.freeze(["note", "article", "image", "video", "link", "file", "collection"] as const);
export const feedReaches = Object.freeze(["following", "followers", "friends", "all", "wot", "me"] as const);
export const feedLayouts = Object.freeze(["columns", "wide", "visual", "list"] as const);
export const feedSorts = Object.freeze(["recent", "popularity"] as const);
export const collectionLayouts = Object.freeze(["grid", "list", "visual"] as const);

export type KnownPostKind = (typeof postKinds)[number];
export type KnownFeedReach = (typeof feedReaches)[number];
export type KnownFeedLayout = (typeof feedLayouts)[number];
export type KnownFeedSort = (typeof feedSorts)[number];
export type KnownCollectionLayout = (typeof collectionLayouts)[number];
export type PostKind = KnownPostKind | "unknown";
export type FeedReach = KnownFeedReach | "unknown";
export type FeedLayout = KnownFeedLayout | "unknown";
export type FeedSort = KnownFeedSort | "unknown";
export type CollectionLayout = KnownCollectionLayout | "unknown";

export const postKind = variant(postKinds);
export const feedReach = variant(feedReaches);
export const feedLayout = variant(feedLayouts);
export const feedSort = variant(feedSorts);
export const collectionLayout = variant(collectionLayouts);

/** A name a builder was given at `input.{field}`: one of `names`, or a refusal naming `what`. */
export function known<T extends string>(names: readonly T[], what: string, js: unknown, field: string): T {
  const name = string.parse(js, `input.${field}`);
  return (names as readonly string[]).includes(name) ? (name as T) : fail(`Invalid ${what}: ${name}`, field);
}
