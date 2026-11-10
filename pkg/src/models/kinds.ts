// The closed name sets. A stored name this version does not know is kept as it was read, so a
// reader survives a newer writer and writes its name back; a builder takes only the names it
// knows.

import { fail } from "../errors.js";
import { type Codec, string } from "../json/schema.js";

/**
 * The post kinds this version knows: `note` (the default), `article` and `collection`, whose content is an envelope, and `image`, `video`, `link` and `file`, hints for how to show the text.
 *
 * @example
 * ```ts
 * import { postKinds } from "pubky-social-specs";
 * console.log(postKinds.includes("article"));
 * ```
 */
export const postKinds = Object.freeze(["note", "article", "image", "video", "link", "file", "collection"] as const);
/**
 * Whose posts a feed shows: `following` and `followers` of the owner, mutual `friends`, `all`, the owner's `wot` (web of trust) and `me`.
 *
 * @example
 * ```ts
 * import { feedReaches } from "pubky-social-specs";
 * for (const reach of feedReaches) console.log(reach);
 * ```
 */
export const feedReaches = Object.freeze(["following", "followers", "friends", "all", "wot", "me"] as const);
/**
 * How a client lays a feed out: `columns`, `wide`, `visual` (media first), `list` and `cards`.
 *
 * @example
 * ```ts
 * import { feedLayouts } from "pubky-social-specs";
 * console.log(feedLayouts.join(", "));
 * ```
 */
export const feedLayouts = Object.freeze(["columns", "wide", "visual", "list", "cards"] as const);
/**
 * The orders of a feed: `recent` and `popularity`.
 *
 * @example
 * ```ts
 * import { feedSorts } from "pubky-social-specs";
 * console.log(feedSorts.join(", "));
 * ```
 */
export const feedSorts = Object.freeze(["recent", "popularity"] as const);
/**
 * What a feed lists: `posts`, the default, stored as no member, and `resources`, the external links people tag.
 *
 * @example
 * ```ts
 * import { feedTargets } from "pubky-social-specs";
 * console.log(feedTargets.join(", "));
 * ```
 */
export const feedTargets = Object.freeze(["posts", "resources"] as const);
/**
 * The kinds of external resource a feed of `resources` may list instead of every kind, in its `content`: `music`, `video`, `podcast`, `place`, `event`, `book`, `article` and `software`.
 *
 * @example
 * ```ts
 * import { resourceFamilies } from "pubky-social-specs";
 * console.log(resourceFamilies.includes("music"));
 * ```
 */
export const resourceFamilies = Object.freeze(["music", "video", "podcast", "place", "event", "book", "article", "software"] as const);
/**
 * How a creator would show a collection: `grid`, `list` and `visual`. A reader may choose its own.
 *
 * @example
 * ```ts
 * import { collectionLayouts } from "pubky-social-specs";
 * console.log(collectionLayouts.join(", "));
 * ```
 */
export const collectionLayouts = Object.freeze(["grid", "list", "visual"] as const);

/** A post kind this version knows: what a builder takes and what a decoded post holds. */
export type KnownPostKind = (typeof postKinds)[number];
/** A feed reach this version knows. */
export type KnownFeedReach = (typeof feedReaches)[number];
/** A feed layout this version knows. */
export type KnownFeedLayout = (typeof feedLayouts)[number];
/** A feed sort this version knows. */
export type KnownFeedSort = (typeof feedSorts)[number];
/** A feed target this version knows. */
export type KnownFeedTarget = (typeof feedTargets)[number];
/** A resource family this version knows. */
export type KnownResourceFamily = (typeof resourceFamilies)[number];

/**
 * The schema.org types each resource family stands for: a resource is of the family when its type is one of these or a subtype of one.
 *
 * @example
 * ```ts
 * import { resourceFamilyRootTypes } from "pubky-social-specs";
 * console.log(resourceFamilyRootTypes.music.join(","));
 * ```
 */
export const resourceFamilyRootTypes: Readonly<Record<KnownResourceFamily, readonly string[]>> = Object.freeze({
  music: Object.freeze(["MusicRecording", "MusicPlaylist", "MusicGroup"]),
  video: Object.freeze(["VideoObject", "Movie", "TVSeries"]),
  podcast: Object.freeze(["PodcastSeries", "PodcastEpisode"]),
  place: Object.freeze(["Place"]),
  event: Object.freeze(["Event"]),
  book: Object.freeze(["Book"]),
  article: Object.freeze(["Article"]),
  software: Object.freeze(["SoftwareApplication", "SoftwareSourceCode"]),
});
/** A collection layout this version knows. */
export type KnownCollectionLayout = (typeof collectionLayouts)[number];
/** A name of the set, or one a newer writer used, kept with its spelling. */
export type OrNewer<T extends string> = T | (string & {});
/** A post kind as a read can hold it: a known one, or a newer writer's name kept as written (a feed's `content` filter). */
export type PostKind = OrNewer<KnownPostKind>;
/** A feed reach as the model holds it before its rules run; a stored feed holds a known one. */
export type FeedReach = OrNewer<KnownFeedReach>;
/** A feed layout as the model holds it before its rules run; a stored feed holds a known one. */
export type FeedLayout = OrNewer<KnownFeedLayout>;
/** A feed sort as the model holds it before its rules run; a stored feed holds a known one. */
export type FeedSort = OrNewer<KnownFeedSort>;
/** A feed target as the model holds it before its rules run; a stored feed holds a known one. */
export type FeedTarget = OrNewer<KnownFeedTarget>;
/** A collection layout as a read can hold it: a known one, or a newer writer's name kept as written. */
export type CollectionLayout = OrNewer<KnownCollectionLayout>;

// A name is read and written as a string; the model's rules decide whether one this version
// does not know is valid where it stands
export const postKind: Codec<PostKind> = string;
export const feedReach: Codec<FeedReach> = string;
export const feedLayout: Codec<FeedLayout> = string;
export const feedSort: Codec<FeedSort> = string;
export const feedTarget: Codec<FeedTarget> = string;
export const collectionLayout: Codec<CollectionLayout> = string;

/** Whether `name` is one of `names`, not one a newer writer used. */
export const isKnown = (names: readonly string[], name: string): boolean => names.includes(name);

/** A name a builder was given at `input.{field}`: one of `names`, or a refusal naming `what`. */
export function known<T extends string>(names: readonly T[], what: string, name: string, field: string): T {
  return isKnown(names, name) ? (name as T) : fail("unknown_name", `Invalid ${what}: ${name}`, field);
}
