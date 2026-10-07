import * as deletion from "./deletion.js";
import * as lifecycle from "./lifecycle.js";
import type * as T from "./types.js";
export { limits, validMimeTypes } from "./data.js";
export { ValidationError } from "./errors.js";
export { collectionLayouts, feedLayouts, feedReaches, feedSorts, postKinds } from "./models/kinds.js";
export type { CollectionLayout, FeedLayout, FeedReach, FeedSort, KnownCollectionLayout, KnownFeedLayout, KnownFeedReach, KnownFeedSort, KnownPostKind, PostKind } from "./models/kinds.js";
export type { Copy, StoredCopy } from "./lifecycle.js";
export type { Listing } from "./deletion.js";
export type * from "./types.js";
/**
 * Replaces the clock, for tests: `nowMs` gives milliseconds as `Date.now` does, so ids and
 * `created_at` are known in advance. Without an argument the engine's clock is back. Either
 * way the guard that keeps ids increasing starts over.
 */
export declare function setClock(nowMs?: () => number): void;
/**
 * Reads what is stored at `uri`, checked against the id, the root and the author the URI
 * names. Media comes back as its bytes.
 */
export declare function decodeObject(uri: string, bytes: Uint8Array): T.Decoded;
/**
 * The bytes to PUT for an object read and then changed, its unknown members kept. `at` is the
 * URI it goes to; `{ kind }` instead checks it by the rules that need no path, for bytes bound
 * elsewhere.
 */
export declare function encodeObject(at: string | {
    kind: T.ObjectKind;
    root?: T.Root | null;
}, object: T.Stored[keyof T.Stored] | Uint8Array): T.Bytes;
/** The envelope inside the `content` of an article or a collection; null for any other kind. */
export declare function decodeContent(post: T.Post): {
    kind: "article";
    content: T.ArticleContent;
} | {
    kind: "collection";
    content: T.CollectionContent;
} | null;
/** The `content` string of an article or a collection, for a post about to be edited. */
export declare function encodeContent(content: T.ArticleContent | T.CollectionContent): string;
/** A fresh profile. To change a stored one and keep what this version does not know: decode, edit, encode. */
export declare function buildUser(owner: string, input: T.NewUser): T.Built<T.User>;
/** A new post at `posts/{id}/{id}[-slug].json`, the id minted here. */
export declare function buildPost(owner: string, input: T.NewPost): T.BuiltPost;
/**
 * An edit of the post whose newest version is at `headUri`: a new version in the same post,
 * with an id above the head's. `root` defaults to the head's own.
 */
export declare function editPost(headUri: string, post: T.Post, options?: {
    root?: T.Root | null;
    slug?: string | null;
} | null): T.BuiltPost;
/** A feed at its private path; the id is derived from the filter alone. */
export declare function buildFeed(owner: string, input: T.NewFeed): T.Built<T.Feed>;
/** The id of a feed object: an edited filter moves the feed, and this is where to. */
export declare function feedId(feed: T.Feed): string;
/** A tag on `uri`. The builder folds the label; the uri must already be canonical. */
export declare function buildTag(owner: string, uri: string, label: string): T.Built<T.Tag>;
/** A bookmark of `target`. Its id carries the target, so a LIST alone tells what is bookmarked. */
export declare function buildBookmark(owner: string, target: string): T.Built<T.Bookmark>;
export declare function buildFollow(owner: string, followee: string): T.Built<T.Follow>;
/** A mute, stored under the private root. */
export declare function buildMute(owner: string, mutee: string): T.Built<T.Mute>;
/**
 * Where media goes: content addressed, so the id is the hash of the bytes. Pass the bytes, or
 * an id from `createMediaHasher` when they were hashed elsewhere, as in a worker.
 */
export declare function buildFile(owner: string, input: T.NewFile): {
    id: string;
    path: string;
    url: string;
};
/**
 * A media id fed a chunk at a time, for bytes too large to hold at once or hashed off the main
 * thread. `id()` is what `buildFile` gives for the same bytes, and may be read at any point.
 */
export declare function createMediaHasher(): {
    update(chunk: Uint8Array): void;
    id(): string;
};
/** Publishing one private version: the media copies to run first, then the post to PUT. */
export declare function planPublish(owner: string, version: {
    id: string;
    editId: string;
    post: T.Post;
}): {
    copies: lifecycle.Copy[];
    put: T.BuiltPost;
};
/** Unpublishing: the copies back into the private root, then the deletes, each in order. */
export declare function planUnpublish(post: {
    id: string;
    publicPaths: string[];
    legacyPaths?: string[] | null;
    privateHead?: string | null;
}): {
    copies: lifecycle.Copy[];
    deletes: string[];
};
/** Deleting a post everywhere: the deletes in order, then the media to consider collecting. */
export declare function planDelete(owner: string, post: {
    id: string;
    legacyPaths?: string[] | null;
    copies?: lifecycle.StoredCopy[] | null;
    versions?: T.Post[] | null;
}): {
    deletes: string[];
    mediaGcCandidates: string[];
};
/**
 * Every stored copy of one object across both epochs and both roots, legacy first.
 * `listings` are the copies the caller found; only a post, a file and a tag take any.
 */
export declare function deletionPaths(target: {
    kind: T.ObjectKind;
    id: string;
    listings?: deletion.Listing[] | null;
}): string[];
/** Classifies a URI. Throws only when it is not a canonical pubky URI with a known root. */
export declare function parseUri(uri: string): T.ParsedUri;
/**
 * Where an object of `kind` lives under `owner`. A post URI is versionless, the form a
 * reference takes; a file takes its full `{hash}.{ext}` name; a feed gets its private path.
 */
export declare function buildUri(owner: string, kind: "user"): string;
export declare function buildUri(owner: string, kind: Exclude<T.ObjectKind, "user">, id: string): string;
/** The LIST prefix of one of an owner's trees. Not a URI: the trailing slash is deliberate. */
export declare function listPrefix(owner: string, tree: T.Root | "legacy"): string;
//# sourceMappingURL=index.d.ts.map