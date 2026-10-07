import type * as T from "./types.js";
export { limits, validMimeTypes } from "./data.js";
export { ValidationError } from "./errors.js";
export { collectionLayouts, feedLayouts, feedReaches, feedSorts, postKinds } from "./models/kinds.js";
export type { CollectionLayout, FeedLayout, FeedReach, FeedSort, KnownCollectionLayout, KnownFeedLayout, KnownFeedReach, KnownFeedSort, KnownPostKind, PostKind } from "./models/kinds.js";
export type * from "./types.js";
/**
 * Reads what is stored at `uri`, a full `pubky://` URL, by the rules of the kind the URL names:
 * the id where the id is derived from the content (a tag, a feed, a bookmark, media), the root,
 * and for a post the author. Media comes back as its bytes, a view of the ones given.
 *
 * Throws a `ValidationError` when the bytes are no valid object there. Other people's data can
 * be anything, so decode it inside a try. A post of a kind this version does not know is
 * refused too: it has rules this version cannot check.
 */
export declare function decodeObject<K extends keyof T.Stored>(uri: T.UrlArg, bytes: Uint8Array | ArrayBuffer, kind: K): T.Stored[K];
export declare function decodeObject(uri: T.UrlArg, bytes: Uint8Array | ArrayBuffer, kind: "file"): T.Bytes;
export declare function decodeObject(uri: T.UrlArg, bytes: Uint8Array | ArrayBuffer): T.Decoded;
/**
 * The bytes to PUT for an object read and then changed, its unknown members kept. `object` is
 * the `.object` of a `decodeObject` or builder result, never its bytes or the result itself;
 * for media it is the bytes, returned as they are once checked.
 *
 * `at` is the URL it goes to. `{ kind, root? }` instead checks the object by the rules that
 * need no path, for bytes bound somewhere the data model does not name.
 */
export declare function encodeObject(at: T.UrlArg | {
    kind: T.ObjectKind;
    root?: T.Root | null;
}, object: T.Stored[keyof T.Stored] | Uint8Array | ArrayBuffer): T.Bytes;
/**
 * The envelope inside the `content` of an article or a collection; null for any other kind.
 * `post` is a stored post, the `.object` of a result. Throws a `ValidationError` when the
 * content is not a readable envelope.
 */
export declare function decodeContent(post: T.Post): {
    kind: "article";
    content: T.ArticleContent;
} | {
    kind: "collection";
    content: T.CollectionContent;
} | null;
/**
 * The `content` string of an article (an envelope with a `title`) or a collection (one with a
 * `name`), for a post about to be edited. It only spells the envelope: the rules run when the
 * post is passed to `editPost` or `encodeObject`.
 */
export declare function encodeContent(content: T.ArticleContent | T.CollectionContent): string;
/**
 * A fresh profile for `owner`, a bare public key. Name, bio, status and link titles are
 * trimmed; `image` and each link `url` are stored as written and must be canonical already.
 * To change a stored profile and keep what this version does not know: decode, edit, encode.
 */
export declare function buildUser(owner: T.Given<"Owner">, input: T.NewUser): T.Built<T.User>;
/**
 * A new post at `posts/{id}/{id}[-slug].json`, the id minted here from the clock. The input is
 * told apart by `kind`: an article takes `title` and `body`, a collection `name` and `items`,
 * and any other kind (`note` when absent, `image`, `video`, `link`, `file`) takes `content`.
 * `parent`, `embed`, `lock`, attachment and item URIs are references: stored as written.
 */
export declare function buildPost<const I extends T.NewPost>(owner: T.Given<"Owner">, input: I & T.CheckedPost<I>): T.BuiltPost;
/**
 * An edit of the post whose newest version is at `headUri`: a new version in the same post,
 * with an id above the head's. `headUri` is the URL of that version, in the caller's own
 * storage: the owner and the post id are read from it. `post` is the stored post as it should
 * now read, the `.object` of a decode with its changes. `root` defaults to the head's own; a
 * slug is not carried over from the head.
 */
export declare function editPost(headUri: T.UrlArg<"post">, post: T.Post, options?: {
    root?: T.Root | null;
    slug?: string | null;
} | null): T.BuiltPost;
/**
 * A feed at its private path. The id is derived from the filter alone (reach, layout, sort,
 * content, tags), so two feeds with one filter are one feed whatever their names, and an
 * edited filter is a new path. `icon` is 1 to 50 of a-z, 0-9 and `-`.
 */
export declare function buildFeed(owner: T.Given<"Owner">, input: T.NewFeed): T.Built<T.Feed>;
/** The id of a feed object: an edited filter moves the feed, and this is where to. */
export declare function feedId(feed: T.Feed): string;
/**
 * A tag on `uri`, a reference: for a post, `buildUri(author, "post", id)`. The builder trims
 * the label and lowercases its ASCII letters; a label holds no whitespace, comma or colon.
 */
export declare function buildTag(owner: T.Given<"Owner">, uri: T.Reference, label: string): T.Built<T.Tag>;
/** A bookmark of `target`. Its id carries the target, so a LIST alone tells what is bookmarked. */
export declare function buildBookmark(owner: T.Given<"Owner">, target: T.Reference): T.Built<T.Bookmark>;
/** A follow of `followee`, a bare public key, stored under the public root. */
export declare function buildFollow(owner: T.Given<"Owner">, followee: T.Given<"Owner">): T.Built<T.Follow, T.Owner>;
/** A mute, stored under the private root. */
export declare function buildMute(owner: T.Given<"Owner">, mutee: T.Given<"Owner">): T.Built<T.Mute, T.Owner>;
/**
 * Where media goes: content addressed, so the id is the hash of the bytes. Pass the bytes, or
 * an id from `createMediaHasher` when they were hashed elsewhere, as in a worker. The bytes are
 * yours to PUT at `url`; nothing else is stored.
 *
 * `type` picks the extension of the path; one the package does not map, an empty one included,
 * gets `.bin`. Empty bytes and bytes over `limits.maxFileSizeBytes` are refused; with an `id`
 * the size is the caller's to check.
 */
export declare function buildFile(owner: T.Given<"Owner">, input: T.NewFile): T.BuiltFile;
/**
 * A media id fed a chunk at a time, for bytes too large to hold at once or hashed off the main
 * thread. `id()` is what `buildFile` gives for the same bytes, and may be read at any point.
 */
export declare function createMediaHasher(): {
    update(chunk: Uint8Array): void;
    id(): T.MediaId;
};
/**
 * The media id of a `Blob` (a `File` included) or a stream of bytes, read a chunk at a time:
 * the thread is free between chunks, so a large file does not freeze a page. The same id as
 * `buildFile` gives for the same bytes; pass it there as `id`.
 */
export declare function hashMedia(source: T.MediaSource): Promise<T.MediaId>;
/**
 * Publishing one private version: the media copies to run first, then the post to PUT. Every
 * path in a plan is owner-relative.
 */
export declare function planPublish(owner: T.Given<"Owner">, version: {
    id: T.Given<"PostId">;
    editId: T.Given<"EditId">;
    post: T.Post;
}): {
    copies: T.Copy[];
    put: T.BuiltPost;
};
/**
 * Unpublishing: the copies back into the private root, then the deletes, each in order.
 * `publicPaths` are the paths of the post's public versions as a LIST gave them, `privateHead`
 * the path of its newest private version when it has one, `legacyPaths` its 0.x copy.
 */
export declare function planUnpublish(post: {
    id: T.Given<"PostId">;
    publicPaths: T.PathArg[];
    legacyPaths?: T.PathArg[] | null;
    privateHead?: T.PathArg | null;
}): {
    copies: T.Copy[];
    deletes: T.OwnerPath[];
};
/**
 * Deleting a post everywhere: the deletes in order, then the media to consider collecting.
 * `copies` are the stored versions found by LIST, each `{ root, path }`; `versions` the ones
 * that could be read. A media candidate is deleted only once nothing else references it, which
 * only the caller can know.
 */
export declare function planDelete(owner: T.Given<"Owner">, post: {
    id: T.Given<"PostId">;
    legacyPaths?: T.PathArg[] | null;
    copies?: T.StoredCopy[] | null;
    versions?: T.Post[] | null;
}): {
    deletes: T.OwnerPath[];
    mediaGcCandidates: T.OwnerPath[];
};
/**
 * The paths to DELETE for one object, legacy first. What the id alone gives is derived: the
 * profile, a follow, and the 1.x path of everything else. For a post, a file and a tag the
 * other copies come from `listings`, the owner-relative paths found by LIST (and for a 0.x
 * File object or tag, what proves it belongs to this one); a post with no listings gives none.
 */
export declare function deletionPaths(target: {
    kind: T.ObjectKind;
    id: string;
    listings?: T.Listing[] | null;
}): T.OwnerPath[];
/**
 * Classifies a URI by its path alone, without the clock. `pubky://<owner>/...` and the short
 * `pubky<owner>/...` are both read. Throws only when the string is neither, or its path holds
 * a segment no canonical path has (`..`, an empty one, `%`, whitespace), or its root is not
 * `pub` or `priv`. A 0.x path reads as `{ kind: "foreign", namespace: "pubky.app" }`.
 */
export declare function parseUri(uri: string): T.ParsedUri;
/**
 * Where an object of `kind` lives under `owner`. A post URI is versionless, the form a
 * reference takes; a file takes its full `{hash}.{ext}` name, the `filename` of `parseUri`; a
 * feed gets its private path. The owner and the id are checked: an id the kind cannot have,
 * such as one holding `/` or `..`, is refused, so only a URI `parseUri` reads as that object
 * comes out.
 */
export declare function buildUri(owner: T.Given<"Owner">, kind: "user"): T.PubkyUrl<"user">;
export declare function buildUri(owner: T.Given<"Owner">, kind: "post", id: T.Given<"PostId">): T.PostRef;
export declare function buildUri(owner: T.Given<"Owner">, kind: "file", filename: string): T.PubkyUrl<"file">;
export declare function buildUri<K extends Exclude<T.ObjectKind, "user" | "post" | "file">>(owner: T.Given<"Owner">, kind: K, id: string): T.PubkyUrl<K>;
export declare function buildUri(owner: T.Given<"Owner">, kind: Exclude<T.ObjectKind, "user">, id: T.Given<"PostId" | "MediaId" | "Owner">): T.PubkyUrl | T.PostRef;
/** The LIST prefix of one of an owner's trees. Not a URI: the trailing slash is deliberate. */
export declare function listPrefix(owner: T.Given<"Owner">, tree: T.Root | "legacy"): `pubky://${string}`;
/**
 * The owner-relative path of a `pubky://` URL, as the SDK's storage calls, every plan and
 * `deletionPaths` take it: a URL a LIST gave, with `pubky://<owner>` stripped.
 */
export declare function toPath(uri: string): T.OwnerPath;
/** A bare public key as an `Owner`. */
export declare function parseOwner(value: string): T.Owner;
/** A post id as a `PostId`: a canonical TimestampId. The time bound is the stored object's rule. */
export declare function parsePostId(value: string): T.PostId;
/** A version id as an `EditId`: a canonical TimestampId, as `parsePostId` checks one. */
export declare function parseEditId(value: string): T.EditId;
/** A media id as a `MediaId`: the canonical spelling of a content hash. */
export declare function parseMediaId(value: string): T.MediaId;
/**
 * The URL of a stored object as a `PubkyUrl`, in its full `pubky://` spelling: a post's must
 * name one version. A path under another namespace, an unknown leaf or a post reference is
 * refused.
 */
export declare function parsePubkyUrl(value: string): T.PubkyUrl;
/** An owner-relative path as an `OwnerPath`: `/pub/` or `/priv/` and canonical segments. */
export declare function parseOwnerPath(value: string): T.OwnerPath;
/** A reference to a post as a `PostRef`, in its full `pubky://` spelling: versionless. */
export declare function parsePostRef(value: string): T.PostRef;
//# sourceMappingURL=index.d.ts.map