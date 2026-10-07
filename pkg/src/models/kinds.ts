// The closed name sets. A stored name this version does not know reads as "unknown", so a
// reader survives a newer writer; a builder takes only the names it knows.

import { fail } from "../errors.js";
import { variant } from "../json/schema.js";

export const postKinds = ["note", "article", "image", "video", "link", "file", "collection"] as const;
export const feedReaches = ["following", "followers", "friends", "all", "wot", "me"] as const;
export const feedLayouts = ["columns", "wide", "visual", "list"] as const;
export const feedSorts = ["recent", "popularity"] as const;
export const collectionLayouts = ["grid", "list", "visual"] as const;

export type PostKind = (typeof postKinds)[number] | "unknown";
export type FeedReach = (typeof feedReaches)[number] | "unknown";
export type FeedLayout = (typeof feedLayouts)[number] | "unknown";
export type FeedSort = (typeof feedSorts)[number] | "unknown";
export type CollectionLayout = (typeof collectionLayouts)[number] | "unknown";

const stored = <T extends string>(names: readonly T[]) => variant<T | "unknown">([...names, "unknown"], "unknown");

export const postKind = stored(postKinds);
export const feedReach = stored(feedReaches);
export const feedLayout = stored(feedLayouts);
export const feedSort = stored(feedSorts);
export const collectionLayout = stored(collectionLayouts);

/** A name a builder was given: one of `names`, or a refusal naming `what`. */
export function known<T extends string>(names: readonly T[], what: string, name: string): T {
  return (names as readonly string[]).includes(name) ? (name as T) : fail(`Invalid ${what}: ${name}`);
}
