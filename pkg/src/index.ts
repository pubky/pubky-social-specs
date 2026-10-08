// pubky-social-specs: the Pubky social data model as plain functions.
//
// Nothing here performs I/O or needs to be loaded first. A builder returns where an object
// goes and the exact bytes to PUT there; `decodeObject` reads what a GET returns. A value the
// data model refuses throws a `ValidationError` carrying the reference message; a value of
// the wrong JS shape throws a `TypeError`.
//
// Three spellings of a place run through every signature:
//   - an owner: the bare z-base32 public key, 52 characters, no `pubky://`;
//   - a URL: the full `pubky://<owner>/...` of one stored object, what a builder returns as
//     `url` and `decodeObject` reads at;
//   - a path: the same without `pubky://<owner>`, what a builder returns as `path`, what the
//     SDK's storage calls take, and what every plan and listing is made of.
// A reference to a post from another object is none of these: it is `buildUri(owner, "post",
// id)`, which names the post and not one version of it.
//
// Each of these is a branded type (`Owner`, `PubkyUrl`, `OwnerPath`, `PostRef`, and the ids
// `PostId`, `EditId`, `MediaId`), so passing one for another fails to compile; a plain string
// is taken anywhere, and `parseOwner` and its siblings brand one where data enters. Every
// argument is copied by `snapshot` first, and only the copy is read.

import { plainBytes } from "./bytes.js";
import { rememberUnknown, warnIfMilliseconds, warnIfUnknownDropped } from "./dev.js";
import { snapshot } from "./input.js";
import * as ids from "./ids.js";
import * as deletion from "./deletion.js";
import { fail, misuse, nameOf, ValidationError } from "./errors.js";
import { arrayOf, type Codec, inputOf, rootOf } from "./json/schema.js";
import * as lifecycle from "./lifecycle.js";
import { parse as parseText } from "./models/common.js";
import * as feeds from "./models/feed.js";
import * as files from "./models/file.js";
import * as graph from "./models/graph.js";
import * as posts from "./models/post.js";
import * as users from "./models/user.js";
import * as objects from "./objects.js";
import { isCanonicalSegment, isObjectKind, OBJECT_KINDS, parsePath } from "./path.js";
import { checkWellFormed, utf8 } from "./text.js";
import type * as T from "./types.js";
import * as uris from "./uri.js";

export { limits, validMimeTypes } from "./data.js";
export { ArgumentError, ValidationError } from "./errors.js";
export type { ErrorCode } from "./errors.js";
export { collectionLayouts, feedLayouts, feedReaches, feedSorts, postKinds } from "./models/kinds.js";
export type { CollectionLayout, FeedLayout, FeedReach, FeedSort, KnownCollectionLayout, KnownFeedLayout, KnownFeedReach, KnownFeedSort, KnownPostKind, PostKind } from "./models/kinds.js";
export type * from "./types.js";
export { feedSchema, postSchema, tagSchema, userSchema, validateFeed, validatePost, validateTag, validateUser } from "./validate.js";
export type { Issue, StandardSchemaV1, Validation } from "./validate.js";

function text(value: unknown, name: string): string {
  if (typeof value !== "string") misuse(name, "a string");
  return checkWellFormed(value, name);
}

/** A URL argument. A path passed for one is the commonest first mistake, so it is named as such. */
function url(value: unknown, name: string): string {
  const given = text(value, name);
  if (given.startsWith("/")) fail("path", `${name} must be a pubky:// URL, not the path ${given}: pass the url of a builder result`, name);
  return given;
}

/** A public key argument: refused under its own name, which the reference text does not carry. */
function key(value: unknown, name: string): string {
  const given = text(value, name);
  // The commonest wrong spelling, which the reference words only as a wrong length
  if (given.startsWith("pubky")) fail("format", `${name} must be the bare public key, not ${given}: parseOwner reads it out of a pubky:// URL`, name);
  ids.checkPublicKey(given, name);
  return given;
}

function bytesOf(value: unknown, name: string): T.Bytes {
  return plainBytes(value) ?? misuse(name, "a Uint8Array or an ArrayBuffer");
}

const strings = (value: unknown, name: string): string[] => arrayOf(value, name).map((item, index) => text(item, `${name}[${index}]`));

type Made<V> = { id: string; path: string; value: V; body: string };

function built<V, P, Id extends string = string>(owner: string, codec: Codec<V>, made: Made<V>): T.Built<P, Id> {
  const url = `pubky://${owner}${made.path}` as T.Built<P, Id>["url"];
  return { id: made.id as Id, path: made.path as T.OwnerPath, url, object: codec.plain(made.value) as P, body: utf8(made.body) };
}

const builtPost = (owner: string, made: posts.Minted): T.BuiltPost => ({ ...built<posts.Post, T.Post, T.PostId>(owner, posts.post.codec, made), editId: made.editId as T.EditId });

/**
 * Reads what is stored at `uri`, a full `pubky://` URL, by the rules of the kind the URL names:
 * the id where the id is derived from the content (a tag, a feed, a bookmark, media), the root,
 * and for a post the author. Media comes back as its bytes, a view of the ones given.
 *
 * Throws a `ValidationError` when the bytes are no valid object there. Other people's data can
 * be anything, so decode it inside a try. A post of a kind this version does not know is
 * refused too: it has rules this version cannot check.
 *
 * @throws `ValidationError` when the bytes are no valid object at `uri` (`code` `json` for bytes
 *  that are not the stored shape, the rule's code otherwise, `field` the member), `code: "path"`
 *  for a URL that names no stored object or another kind than `kind`; `ArgumentError` for bytes
 *  that are not a `Uint8Array` or an `ArrayBuffer`.
 *
 * @example
 * ```ts
 * import { buildPost, decodeObject } from "pubky-social-specs";
 * const owner = "8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto";
 * const { url, body } = buildPost(owner, { content: "Hello" });
 * const post = decodeObject(url, body, "post");
 * console.log(post.content);
 * ```
 */
export function decodeObject<K extends keyof T.Stored>(uri: T.UrlArg, bytes: Uint8Array | ArrayBuffer, kind: K): T.Stored[K];
export function decodeObject(uri: T.UrlArg, bytes: Uint8Array | ArrayBuffer, kind: "file"): T.Bytes;
export function decodeObject(uri: T.UrlArg, bytes: Uint8Array | ArrayBuffer): T.Decoded;
export function decodeObject(uri: T.UrlArg, bytes: Uint8Array | ArrayBuffer, kind?: T.ObjectKind): T.Decoded | T.Stored[keyof T.Stored] | T.Bytes {
  const at = url(uri, "uri");
  bytes = snapshot(bytes, "bytes") as T.Bytes;
  if (kind !== undefined) {
    nameOf(kind, "kind", OBJECT_KINDS);
    // Before the bytes are read: the URL alone says what is stored there
    const named = uris.parse(at).kind;
    if (named !== kind) fail("path", `${at} names ${isObjectKind(named) ? `a ${named}` : "no stored object"}, not a ${kind}`, "uri");
  }
  const read = objects.read(at, bytesOf(bytes, "bytes"));
  if (read.kind === "file") return kind === undefined ? { kind: "file", bytes: read.value as T.Bytes } : (read.value as T.Bytes);
  const object = objects.modelOf(read.kind).codec.plain(read.value) as T.Stored[keyof T.Stored];
  rememberUnknown(at, object);
  return kind === undefined ? ({ kind: read.kind, object } as T.Decoded) : object;
}

/**
 * The bytes to PUT for an object read and then changed, its unknown members kept. `object` is
 * the `.object` of a `decodeObject` or builder result, never its bytes or the result itself;
 * for media it is the bytes, returned as they are once checked.
 *
 * `at` is the URL it goes to. `{ kind, root? }` instead checks the object by the rules that
 * need no path, for bytes bound somewhere the data model does not name.
 *
 * @throws `ValidationError` when `object` breaks a rule of its kind at `at`, with the member as
 *  `field`; `ArgumentError` for a member the stored object does not have, a value of the wrong
 *  type, or bytes passed for an object.
 *
 * @example
 * ```ts
 * import { buildPost, decodeObject, encodeObject } from "pubky-social-specs";
 * const owner = "8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto";
 * const { url, body } = buildPost(owner, { content: "Hello" });
 * const read = decodeObject(url, body, "post");
 * // A spread keeps the members another client added, in $unknown
 * const bytes = encodeObject(url, { ...read, content: "Hello again" });
 * console.log(bytes.length);
 * ```
 */
export function encodeObject<K extends keyof T.Stored>(at: T.UrlArg<K> | { kind: K; root?: T.Root | null }, object: T.Stored[K]): T.Bytes;
export function encodeObject(at: T.UrlArg<"file"> | { kind: "file"; root?: T.Root | null }, object: Uint8Array | ArrayBuffer): T.Bytes;
export function encodeObject(at: T.UrlArg | { kind: T.ObjectKind; root?: T.Root | null }, object: T.Stored[keyof T.Stored] | Uint8Array | ArrayBuffer): T.Bytes {
  at = snapshot(at, "at") as typeof at;
  object = snapshot(object, "object") as typeof object;
  const media = plainBytes(object);
  if (typeof at === "string") {
    if (media === null) {
      warnIfUnknownDropped(at, object, "encodeObject");
      warnIfMilliseconds(object, "encodeObject");
    }
    return objects.write(url(at, "at"), media ?? object);
  }
  const where = inputOf(at, "at", ["kind", "root"]);
  return objects.write({ kind: text(where.kind, "at.kind") as T.ObjectKind, root: rootOf(where.root, "at.root") }, media ?? object);
}

/**
 * The envelope inside the `content` of an article or a collection; null for any other kind.
 * `post` is a stored post, the `.object` of a result. Throws a `ValidationError` when the
 * content is not a readable envelope.
 *
 * @throws `ValidationError` with `code: "json"` when the content of an
 *  article or a collection is not its envelope.
 *
 * @example
 * ```ts
 * import { buildPost, decodeContent } from "pubky-social-specs";
 * const owner = "8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto";
 * const article = buildPost(owner, { kind: "article", title: "On pubky", body: "..." });
 * const envelope = decodeContent(article.object);
 * if (envelope?.kind === "article") console.log(envelope.content.title);
 * ```
 */
export function decodeContent(post: T.Post): { kind: "article"; content: T.ArticleContent } | { kind: "collection"; content: T.CollectionContent } | null {
  const given = snapshot(post, "post");
  const member = (key: "content" | "kind") => (typeof given === "object" && given !== null && Object.hasOwn(given, key) ? (given as Record<string, unknown>)[key] : undefined);
  const content = text(member("content"), "post.content");
  const kind = member("kind");
  if (kind === "article") {
    const envelope = parseText(posts.article, content, "Article content must be a valid JSON envelope: ");
    return { kind: "article", content: posts.article.plain(envelope) as T.ArticleContent };
  }
  if (kind === "collection") {
    const envelope = parseText(posts.collection, content, "Collection content must be a valid JSON envelope: ");
    return { kind: "collection", content: posts.collection.plain(envelope) as T.CollectionContent };
  }
  return null;
}

/**
 * The `content` string of an article (an envelope with a `title`) or a collection (one with a
 * `name`), for a post about to be edited. It only spells the envelope: the rules run when the
 * post is passed to `editPost` or `encodeObject`.
 *
 * @throws `ArgumentError` for an envelope that has neither `title` nor `name`, or a member of the
 *  wrong type.
 *
 * @example
 * ```ts
 * import { encodeContent } from "pubky-social-specs";
 * const content = encodeContent({ title: "On pubky", body: "...", cover_image: null });
 * console.log(content);
 * ```
 */
export function encodeContent(content: T.ArticleContent | T.CollectionContent): string {
  const given = snapshot(content, "content");
  if (typeof given !== "object" || given === null) return misuse("content", "an article or a collection envelope");
  if (Object.hasOwn(given, "title")) return posts.article.write(posts.article.parse(given, "content"));
  if (Object.hasOwn(given, "name")) return posts.collection.write(posts.collection.parse(given, "content"));
  return misuse("content", "an article envelope, with a title, or a collection envelope, with a name");
}

/**
 * A fresh profile for `owner`, a bare public key. Name, bio, status and link titles are
 * trimmed; `image` and each link `url` are stored as written and must be canonical already.
 * To change a stored profile and keep what this version does not know: decode, edit, encode.
 *
 * @throws `ValidationError` for a rule of the profile (`code` `length`, `blank` or `reference`,
 *  `field` the member) or a malformed `owner` (`field: "owner"`); `ArgumentError` for a member of
 *  the wrong type or one `NewUser` does not have.
 *
 * @example
 * ```ts
 * import { buildUser } from "pubky-social-specs";
 * const owner = "8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto";
 * const profile = buildUser(owner, { name: "Alice", bio: "Hiking and Rust" });
 * // PUT profile.body at profile.path with the SDK session
 * console.log(profile.path);
 * ```
 */
export function buildUser(owner: T.Given<"Owner">, input: T.NewUser): T.Built<T.User> {
  return built(owner, users.user.codec, users.buildUser(key(owner, "owner"), snapshot(input, "input")));
}

/**
 * A new post at `posts/{id}/{id}[-slug].json`, the id minted here from the clock. The input is
 * told apart by `kind`: an article takes `title` and `body`, a collection `name` and `items`,
 * and any other kind (`note` when absent, `image`, `video`, `link`, `file`) takes `content`.
 * `parent`, `embed`, `lock`, attachment and item URIs are references: stored as written.
 *
 * @throws `ValidationError` for a rule of the post (`field` the member: `content`,
 *  `attachments[0].uri`, `slug`, `title`) or a malformed `owner`; `ArgumentError` for a member of
 *  the wrong type or one the kind does not take.
 *
 * @example
 * ```ts
 * import { buildPost, buildUri } from "pubky-social-specs";
 * const owner = "8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto";
 * const friend = "dzswkfy7ek3bqnoc89jxuqqfbzhjrj6mi8qthgbxxcqkdugm3rio";
 * const hello = buildPost(owner, { content: "Hello" });
 * const reply = buildPost(owner, { content: "Welcome", parent: buildUri(friend, "post", "0034A0X7NJ52C") });
 * console.log(hello.path, reply.object.parent);
 * ```
 */
export function buildPost<const I extends T.NewPost>(owner: T.Given<"Owner">, input: I & T.CheckedPost<I>): T.BuiltPost {
  return builtPost(owner, posts.buildPost(key(owner, "owner"), snapshot(input, "input")));
}

/**
 * An edit of the post whose newest version is at `headUri`: a new version in the same post,
 * with an id above the head's. `headUri` is the URL of that version in `owner`'s own tree,
 * which is where the edit goes; the post id is read from it. `post` is the stored post as it
 * should now read, the `.object` of a decode with its changes. `root` defaults to the head's
 * own; a slug is not carried over from the head.
 *
 * @throws `ValidationError` with `field: "headUri"` when `headUri` is no stored post version or is
 *  in another user's tree, `field: "head"` when the head leaves no room for a newer id, and any
 *  rule of the post; `ArgumentError` for an option it does not take.
 *
 * @example
 * ```ts
 * import { buildPost, editPost } from "pubky-social-specs";
 * const owner = "8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto";
 * const first = buildPost(owner, { content: "Helo" });
 * const fixed = editPost(owner, first.url, { ...first.object, content: "Hello" });
 * console.log(fixed.id === first.id, fixed.editId > first.editId);
 * ```
 */
export function editPost(owner: T.Given<"Owner">, headUri: T.UrlArg<"post">, post: T.Post, options?: { root?: T.Root | null; slug?: string | null } | null): T.BuiltPost {
  const me = key(owner, "owner");
  post = snapshot(post, "post") as T.Post;
  options = snapshot(options, "options") as typeof options;
  const head = uris.parse(url(headUri, "headUri"));
  if (head.kind !== "post" || head.editId === undefined) return fail("path", `not the URI of a stored post version: ${headUri}`, "headUri");
  // Only the owner writes their tree: an edit of another user's post is a reply or a quote
  if (head.owner !== me) fail("path", `the head ${headUri} is in another user's tree, not ${me}'s`, "headUri");
  warnIfUnknownDropped(headUri, post, "editPost");
  const given = options === undefined || options === null ? {} : inputOf(options, "options", ["root", "slug"]);
  const root = given.root === undefined || given.root === null ? head.root : rootOf(given.root, "options.root");
  const slug = given.slug === undefined || given.slug === null ? null : text(given.slug, "options.slug");
  const value = posts.post.codec.parse(post, "post");
  return builtPost(me, posts.editPost(me, value, head.id, head.editId, root, slug));
}

/**
 * A feed at its private path. The id is derived from the filter alone (reach, layout, sort,
 * content, tags, domain tags), so two feeds with one filter are one feed whatever their names, and an
 * edited filter is a new path. `icon` is 1 to 50 of a-z, 0-9 and `-`.
 *
 * @throws `ValidationError` for a rule of the feed (`field` the member: `tags`, `icon`, `name`) or
 *  an unknown reach, layout, sort or content (`code: "unknown_name"`); `ArgumentError` for a member
 *  of the wrong type.
 *
 * @example
 * ```ts
 * import { buildFeed } from "pubky-social-specs";
 * const owner = "8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto";
 * const feed = buildFeed(owner, { name: "Rust", icon: "crab", reach: "all", layout: "columns", sort: "recent", tags: ["rust"] });
 * console.log(feed.path);
 * ```
 */
export function buildFeed(owner: T.Given<"Owner">, input: T.NewFeed): T.Built<T.Feed> {
  return built(owner, feeds.feed.codec, feeds.buildFeed(key(owner, "owner"), snapshot(input, "input")));
}

/**
 * The id of a feed object: an edited filter moves the feed, and this is where to.
 *
 * @throws `ValidationError` when the feed breaks one of its rules.
 *
 * @example
 * ```ts
 * import { buildFeed, feedId } from "pubky-social-specs";
 * const owner = "8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto";
 * const feed = buildFeed(owner, { name: "Rust", icon: "crab", reach: "all", layout: "columns", sort: "recent" });
 * const moved = feedId({ ...feed.object, feed: { ...feed.object.feed, sort: "popularity" } });
 * console.log(moved !== feed.id);
 * ```
 */
export function feedId(feed: T.Feed): string {
  return feeds.feedId(feeds.feed.codec.parse(snapshot(feed, "feed"), "feed"));
}

/**
 * A tag on `uri`, a reference: for a post, `buildUri(author, "post", id)`. The builder trims
 * the label and lowercases its ASCII letters; a label holds no whitespace, comma or colon.
 *
 * @throws `ValidationError` with `field: "uri"` for a target the reference rules refuse (a post
 *  version included) and `field: "label"` for a label the tag rules refuse.
 *
 * @example
 * ```ts
 * import { buildTag, buildUri } from "pubky-social-specs";
 * const owner = "8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto";
 * const friend = "dzswkfy7ek3bqnoc89jxuqqfbzhjrj6mi8qthgbxxcqkdugm3rio";
 * const tag = buildTag(owner, buildUri(friend, "post", "0034A0X7NJ52C"), "Rust");
 * console.log(tag.object.label);
 * ```
 */
export function buildTag(owner: T.Given<"Owner">, uri: T.Reference, label: string): T.Built<T.Tag> {
  return built(owner, graph.tag.codec, graph.buildTag(key(owner, "owner"), text(uri, "uri"), text(label, "label")));
}

/**
 * A bookmark of `target`. Its id carries the target, so a LIST alone tells what is bookmarked.
 *
 * @throws `ValidationError` with `field: "target"` for a target the reference rules refuse, a post
 *  version included.
 *
 * @example
 * ```ts
 * import { buildBookmark, parseUri } from "pubky-social-specs";
 * const owner = "8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto";
 * const bookmark = buildBookmark(owner, "https://example.com/a");
 * const parsed = parseUri(bookmark.url);
 * if (parsed.kind === "bookmark") console.log(parsed.target);
 * ```
 */
export function buildBookmark(owner: T.Given<"Owner">, target: T.Reference): T.Built<T.Bookmark> {
  return built(owner, graph.bookmark.codec, graph.buildBookmark(key(owner, "owner"), text(target, "target")));
}

/**
 * A follow of `followee`, a bare public key, stored under the public root.
 *
 * @throws `ValidationError` with `field: "owner"` or `field: "followee"` for a key that is not 52
 *  z-base32 characters.
 *
 * @example
 * ```ts
 * import { buildFollow } from "pubky-social-specs";
 * const owner = "8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto";
 * const friend = "dzswkfy7ek3bqnoc89jxuqqfbzhjrj6mi8qthgbxxcqkdugm3rio";
 * const follow = buildFollow(owner, friend);
 * console.log(follow.path);
 * ```
 */
export function buildFollow(owner: T.Given<"Owner">, followee: T.Given<"Owner">): T.Built<T.Follow, T.Owner> {
  return built(owner, graph.follow.codec, graph.buildFollow(key(owner, "owner"), key(followee, "followee")));
}

/**
 * A mute, stored under the private root.
 *
 * @throws `ValidationError` with `field: "owner"` or `field: "mutee"` for a key that is not 52
 *  z-base32 characters.
 *
 * @example
 * ```ts
 * import { buildMute } from "pubky-social-specs";
 * const owner = "8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto";
 * const friend = "dzswkfy7ek3bqnoc89jxuqqfbzhjrj6mi8qthgbxxcqkdugm3rio";
 * const mute = buildMute(owner, friend);
 * console.log(mute.path);
 * ```
 */
export function buildMute(owner: T.Given<"Owner">, mutee: T.Given<"Owner">): T.Built<T.Mute, T.Owner> {
  return built(owner, graph.mute.codec, graph.buildMute(key(owner, "owner"), key(mutee, "mutee")));
}

/**
 * Where media goes: content addressed, so the id is the hash of the bytes. Pass the bytes, or
 * an id from `createMediaHasher` when they were hashed elsewhere, as in a worker. The bytes are
 * yours to PUT at `url`; nothing else is stored.
 *
 * `type` picks the extension of the path; one the package does not map, an empty one included,
 * gets `.bin`. Empty bytes and bytes over `limits.maxFileSizeBytes` are refused; with an `id`
 * the size is the caller's to check.
 *
 * @throws `ValidationError` with `field: "bytes"` for empty bytes or bytes over
 *  `limits.maxFileSizeBytes`, `code: "format"` for an id that is not a hash; `ArgumentError` when both
 *  or neither of `bytes` and `id` are given.
 *
 * @example
 * ```ts
 * import { buildFile, buildPost } from "pubky-social-specs";
 * const owner = "8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto";
 * const bytes = new TextEncoder().encode("a picture");
 * const file = buildFile(owner, { bytes, type: "image/png" });
 * // PUT the bytes at file.path, then reference them
 * const post = buildPost(owner, { kind: "image", content: "", attachments: [{ uri: file.url, alt: "a picture" }] });
 * console.log(post.object.attachments[0]?.uri === file.url);
 * ```
 */
export function buildFile(owner: T.Given<"Owner">, input: T.NewFile): T.BuiltFile {
  const given = inputOf(snapshot(input, "input"), "input", ["bytes", "id", "type", "root"]);
  if ((given.bytes === undefined) === (given.id === undefined)) misuse("input", "given either bytes or an id");
  const source = given.bytes !== undefined ? { bytes: bytesOf(given.bytes, "input.bytes") } : { id: text(given.id, "input.id") };
  const made = files.buildFile(key(owner, "owner"), source, text(given.type, "input.type"), rootOf(given.root, "input.root"));
  return { id: made.id as T.MediaId, path: made.path as T.OwnerPath, url: `pubky://${owner}${made.path}` as T.PubkyUrl<"file"> };
}

/**
 * A media id fed a chunk at a time, for bytes too large to hold at once or hashed off the main
 * thread. `id()` is what `buildFile` gives for the same bytes, and may be read at any point.
 *
 * @throws `ArgumentError` when a chunk is not a `Uint8Array`.
 *
 * @example
 * ```ts
 * import { buildFile, createMediaHasher } from "pubky-social-specs";
 * const owner = "8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto";
 * const hasher = createMediaHasher();
 * for (const chunk of ["a pic", "ture"]) hasher.update(new TextEncoder().encode(chunk));
 * const file = buildFile(owner, { id: hasher.id(), type: "image/png" });
 * console.log(file.id);
 * ```
 */
export function createMediaHasher(): { update(chunk: Uint8Array): void; id(): T.MediaId } {
  const hasher = ids.createMediaHasher();
  return { update: (chunk) => hasher.update(bytesOf(chunk, "chunk")), id: () => hasher.id() as T.MediaId };
}

/**
 * The media id of a `Blob` (a `File` included) or a stream of bytes, read a chunk at a time:
 * the thread is free between chunks, so a large file does not freeze a page. The same id as
 * `buildFile` gives for the same bytes; pass it there as `id`.
 *
 * @throws `ArgumentError` when `source` is neither a `Blob` nor a stream of bytes; a rejection of
 *  the stream itself passes through.
 *
 * @example
 * ```ts
 * import { buildFile, hashMedia } from "pubky-social-specs";
 * const owner = "8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto";
 * const blob = new Blob(["a picture"], { type: "image/png" });
 * const id = await hashMedia(blob);
 * console.log(buildFile(owner, { id, type: blob.type }).path);
 * ```
 */
export async function hashMedia(source: T.MediaSource): Promise<T.MediaId> {
  // Typed for a caller, checked for one that is not
  const given: unknown = source;
  const stream: unknown = typeof (given as { stream?: unknown } | null)?.stream === "function" ? (given as T.BlobLike).stream() : given;
  if (typeof (stream as { getReader?: unknown } | null)?.getReader !== "function") misuse("source", "a Blob or a ReadableStream of bytes");
  const reader = (stream as T.ByteStream).getReader();
  const hasher = ids.createMediaHasher();
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) hasher.update(bytesOf(chunk.value, "a chunk of source"));
  } finally {
    reader.releaseLock();
  }
  return hasher.id() as T.MediaId;
}

/**
 * Publishing one private version: the media copies to run first, then the post to PUT. Every
 * path in a plan is owner-relative. `slug` is the one the private version's path carries
 * (`parseUri(url).slug`), so the public leaf keeps it.
 *
 * @throws `ValidationError` for an id out of its time bounds (`field: "id"` or `"editId"`), an
 *  editId older than the post (`field: "editId"`), a bad `slug`, a private reference the public
 *  post cannot keep (`code: "reference"`), and any rule of the post.
 *
 * @example
 * ```ts
 * import { buildPost, planPublish } from "pubky-social-specs";
 * const owner = "8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto";
 * const draft = buildPost(owner, { content: "Soon", root: "private" });
 * const plan = planPublish(owner, { id: draft.id, editId: draft.editId, post: draft.object });
 * // Run plan.copies first, then PUT plan.put.body at plan.put.path
 * console.log(plan.copies.length, plan.put.path);
 * ```
 */
export function planPublish(
  owner: T.Given<"Owner">,
  version: { id: T.Given<"PostId">; editId: T.Given<"EditId">; post: T.Post; slug?: string | null },
): { copies: T.Copy[]; put: T.BuiltPost } {
  const given = inputOf(snapshot(version, "version"), "version", ["id", "editId", "post", "slug"]);
  const value = posts.post.codec.parse(given.post, "version.post");
  const slug = given.slug === undefined || given.slug === null ? null : text(given.slug, "version.slug");
  const plan = lifecycle.planPublish(key(owner, "owner"), text(given.id, "version.id"), text(given.editId, "version.editId"), value, slug);
  return { copies: plan.copies as T.Copy[], put: builtPost(owner, plan.put) };
}

/**
 * Unpublishing: the copies back into the private root, then the deletes, each in order.
 * `publicPaths` are the paths of the post's public versions as a LIST gave them, `privateHead`
 * the path of its newest private version when it has one, `legacyPaths` its 0.x copy.
 *
 * @throws `ValidationError` with `code: "path"` for a path that is no version of the post, and
 *  `code: "conflict"` when there is nothing to unpublish.
 *
 * @example
 * ```ts
 * import { buildPost, planPublish, planUnpublish } from "pubky-social-specs";
 * const owner = "8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto";
 * const draft = buildPost(owner, { content: "Soon", root: "private" });
 * const { put } = planPublish(owner, { id: draft.id, editId: draft.editId, post: draft.object });
 * const plan = planUnpublish({ id: draft.id, publicPaths: [put.path] });
 * console.log(plan.copies, plan.deletes);
 * ```
 */
export function planUnpublish(post: { id: T.Given<"PostId">; publicPaths: T.PathArg[]; legacyPaths?: T.PathArg[] | null; privateHead?: T.PathArg | null }): {
  copies: T.Copy[];
  deletes: T.OwnerPath[];
} {
  const given = inputOf(snapshot(post, "post"), "post", ["id", "publicPaths", "legacyPaths", "privateHead"]);
  const head = given.privateHead === undefined || given.privateHead === null ? null : text(given.privateHead, "post.privateHead");
  return lifecycle.planUnpublish(text(given.id, "post.id"), strings(given.publicPaths, "post.publicPaths"), strings(given.legacyPaths ?? [], "post.legacyPaths"), head) as {
    copies: T.Copy[];
    deletes: T.OwnerPath[];
  };
}

/**
 * Deleting a post everywhere: the deletes in order, then the media to consider collecting.
 * `copies` are the stored versions found by LIST, each `{ root, path }`; `versions` the ones
 * that could be read. A media candidate is deleted only once nothing else references it, which
 * only the caller can know.
 *
 * @throws `ValidationError` with `code: "path"` for a copy or a legacy path that is no version of
 *  the post.
 *
 * @example
 * ```ts
 * import { buildPost, planDelete } from "pubky-social-specs";
 * const owner = "8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto";
 * const post = buildPost(owner, { content: "Gone soon" });
 * const plan = planDelete(owner, { id: post.id, copies: [{ root: "public", path: post.path }], versions: [post.object] });
 * console.log(plan.deletes, plan.mediaGcCandidates);
 * ```
 */
export function planDelete(
  owner: T.Given<"Owner">,
  post: { id: T.Given<"PostId">; legacyPaths?: T.PathArg[] | null; copies?: T.StoredCopy[] | null; versions?: T.Post[] | null },
): { deletes: T.OwnerPath[]; mediaGcCandidates: T.OwnerPath[] } {
  const given = inputOf(snapshot(post, "post"), "post", ["id", "legacyPaths", "copies", "versions"]);
  const copies = arrayOf(given.copies ?? [], "post.copies").map((copy, index) => {
    const given = inputOf(copy, `post.copies[${index}]`, ["root", "path"]);
    return { root: rootOf(given.root, `post.copies[${index}].root`), path: text(given.path, `post.copies[${index}].path`) };
  });
  const versions = arrayOf(given.versions ?? [], "post.versions").map((version, index) => posts.post.codec.parse(version, `post.versions[${index}]`));
  return lifecycle.planDelete(key(owner, "owner"), text(given.id, "post.id"), strings(given.legacyPaths ?? [], "post.legacyPaths"), copies, versions) as {
    deletes: T.OwnerPath[];
    mediaGcCandidates: T.OwnerPath[];
  };
}

/**
 * The paths to DELETE for one object, legacy first. What the id alone gives is derived: the
 * profile, a follow, and the 1.x path of everything else. For a post, a file and a tag the
 * other copies come from `listings`, the owner-relative paths found by LIST (and for a 0.x
 * File object or tag, what proves it belongs to this one); a post with no listings gives none.
 *
 * @throws `ValidationError` for an id the kind cannot have (`code: "format"`), a listing that is no
 *  copy of the object (`code: "path"` or `"id"`), and listings given to a kind that takes none
 *  (`code: "conflict"`).
 *
 * @example
 * ```ts
 * import { deletionPaths } from "pubky-social-specs";
 * const friend = "dzswkfy7ek3bqnoc89jxuqqfbzhjrj6mi8qthgbxxcqkdugm3rio";
 * console.log(deletionPaths({ kind: "follow", id: friend }));
 * ```
 */
export function deletionPaths(target: { kind: T.ObjectKind; id: string; listings?: T.Listing[] | null }): T.OwnerPath[] {
  const given = inputOf(snapshot(target, "target"), "target", ["kind", "id", "listings"]);
  return deletion.deletionPaths(text(given.kind, "target.kind") as T.ObjectKind, text(given.id, "target.id"), arrayOf(given.listings ?? [], "target.listings")) as T.OwnerPath[];
}

/**
 * Classifies a URI by its path alone, without the clock. `pubky://<owner>/...` and the short
 * `pubky<owner>/...` are both read. Throws only when the string is neither, or its path holds
 * a segment no canonical path has (`..`, an empty one, `%`, whitespace), or its root is not
 * `pub` or `priv`. A 0.x path reads as `{ kind: "foreign", namespace: "pubky.app" }`.
 *
 * @throws `ValidationError` with `code: "path"` for a string that is not a canonical pubky URI
 *  under `pub` or `priv`. A path it cannot name is a kind, not an error.
 *
 * @example
 * ```ts
 * import { buildPost, parseUri } from "pubky-social-specs";
 * const owner = "8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto";
 * const parsed = parseUri(buildPost(owner, { content: "Hello" }).url);
 * if (parsed.kind === "post") console.log(parsed.id, parsed.editId);
 * ```
 */
export function parseUri(uri: string): T.ParsedUri {
  const parsed = uris.parse(text(uri, "uri")) as T.ParsedUri;
  // What `buildUri` takes back: a file is named by its hash and spelled with its extension
  if (parsed.kind === "file") return { ...parsed, filename: parsed.path.slice(parsed.path.lastIndexOf("/") + 1) };
  if (parsed.kind !== "bookmark" || parsed.id.startsWith("~")) return parsed;
  try {
    return { ...parsed, target: graph.targetOf(parsed.id, { created_at: 0n, target: null, extra: new Map() }) };
  } catch (e) {
    // The form of the id passed; what it carries is no valid target, which a reader skips
    if (e instanceof ValidationError) return parsed;
    throw e;
  }
}

/**
 * Where an object of `kind` lives under `owner`. A post URI is versionless, the form a
 * reference takes; a file takes its full `{hash}.{ext}` name, the `filename` of `parseUri`; a
 * feed gets its private path. The owner and the id are checked: an id the kind cannot have,
 * such as one holding `/` or `..`, is refused, so only a URI `parseUri` reads as that object
 * comes out.
 *
 * @throws `ValidationError` with `field: "owner"` for a malformed key, `field: "id"` for an id the
 *  kind cannot have, and `code: "unknown_name"` for an unknown kind.
 *
 * @example
 * ```ts
 * import { buildUri } from "pubky-social-specs";
 * const owner = "8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto";
 * console.log(buildUri(owner, "user"), buildUri(owner, "post", "0034A0X7NJ52C"));
 * ```
 */
export function buildUri(owner: T.Given<"Owner">, kind: "user"): T.PubkyUrl<"user">;
export function buildUri(owner: T.Given<"Owner">, kind: "post", id: T.Given<"PostId">): T.PostRef;
export function buildUri(owner: T.Given<"Owner">, kind: "file", filename: string): T.PubkyUrl<"file">;
export function buildUri<K extends Exclude<T.ObjectKind, "user" | "post" | "file">>(owner: T.Given<"Owner">, kind: K, id: string): T.PubkyUrl<K>;
export function buildUri(owner: T.Given<"Owner">, kind: Exclude<T.ObjectKind, "user">, id: T.Given<"PostId" | "MediaId" | "Owner">): T.PubkyUrl | T.PostRef;
export function buildUri(owner: string, kind: T.ObjectKind, id?: string): string {
  return uris.buildChecked(key(owner, "owner"), text(kind, "kind") as T.ObjectKind, kind === "user" ? "" : text(id, "id"));
}

/**
 * The LIST prefix of one of an owner's trees. Not a URI: the trailing slash is deliberate.
 *
 * @throws `ValidationError` for a malformed key (`field: "owner"`) or a tree other than the three
 *  (`code: "unknown_name"`).
 *
 * @example
 * ```ts
 * import { listPrefix } from "pubky-social-specs";
 * const owner = "8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto";
 * // LIST this with the SDK to see every 1.x public object
 * console.log(listPrefix(owner, "public"));
 * ```
 */
export function listPrefix(owner: T.Given<"Owner">, tree: T.Root | "legacy"): T.ListPrefix {
  return uris.listPrefix(key(owner, "owner"), tree) as T.ListPrefix;
}

/**
 * The owner-relative path of a `pubky://` URL, as the SDK's storage calls, every plan and
 * `deletionPaths` take it: a URL a LIST gave, with `pubky://<owner>` stripped.
 *
 * @throws `ValidationError` with `code: "path"` for a string that is no URL of a stored object.
 *
 * @example
 * ```ts
 * import { buildPost, toPath } from "pubky-social-specs";
 * const owner = "8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto";
 * const { url } = buildPost(owner, { content: "Hello" });
 * console.log(toPath(url));
 * ```
 */
export function toPath(uri: string): T.OwnerPath {
  const parsed = uris.parse(text(uri, "uri"));
  return parsed.path === "" ? fail("path", `not the URL of a stored object: ${uri}`, "uri") : (parsed.path as T.OwnerPath);
}

// Where data enters: a string from a form, a LIST or another app, checked once and branded,
// so nothing downstream checks it again. Each throws a `ValidationError` naming what it refuses.

/**
 * A bare public key as an `Owner`.
 *
 * @throws `ValidationError` with `code: "format"` for a string that is not 52 z-base32 characters.
 *
 * @example
 * ```ts
 * import { parseOwner, buildFollow } from "pubky-social-specs";
 * const owner = "8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto";
 * const fromForm = "dzswkfy7ek3bqnoc89jxuqqfbzhjrj6mi8qthgbxxcqkdugm3rio";
 * console.log(buildFollow(owner, parseOwner(fromForm)).path);
 * ```
 */
export function parseOwner(value: string): T.Owner {
  return key(value, "owner") as T.Owner;
}

/**
 * A post id as a `PostId`: a canonical TimestampId. The time bound is the stored object's rule.
 *
 * @throws `ValidationError` with `code: "format"` for a string that is not a canonical timestamp
 *  id.
 *
 * @example
 * ```ts
 * import { parsePostId, buildUri } from "pubky-social-specs";
 * const owner = "8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto";
 * console.log(buildUri(owner, "post", parsePostId("0034A0X7NJ52C")));
 * ```
 */
export function parsePostId(value: string): T.PostId {
  ids.timestampIdMicros(text(value, "id"), "id");
  return value as T.PostId;
}

/**
 * A version id as an `EditId`: a canonical TimestampId, as `parsePostId` checks one.
 *
 * @throws `ValidationError` with `code: "format"` for a string that is not a canonical timestamp
 *  id.
 *
 * @example
 * ```ts
 * import { parseEditId } from "pubky-social-specs";
 * console.log(parseEditId("0034A0X7NJ52C"));
 * ```
 */
export function parseEditId(value: string): T.EditId {
  ids.timestampIdMicros(text(value, "editId"), "editId");
  return value as T.EditId;
}

/**
 * A media id as a `MediaId`: the canonical spelling of a content hash.
 *
 * @throws `ValidationError` with `code: "format"` for a string that is not a canonical hash id.
 *
 * @example
 * ```ts
 * import { parseMediaId } from "pubky-social-specs";
 * console.log(parseMediaId("AKSZ57W2RFKHV1EHK007FQQ8TW"));
 * ```
 */
export function parseMediaId(value: string): T.MediaId {
  ids.checkHashId(text(value, "id"), "id");
  return value as T.MediaId;
}

/**
 * The URL of a stored object as a `PubkyUrl`, in its full `pubky://` spelling: a post's must
 * name one version. A path under another namespace, an unknown leaf or a post reference is
 * refused.
 *
 * @throws `ValidationError` with `code: "path"` for a string that is no URL of a stored object.
 *
 * @example
 * ```ts
 * import { parsePubkyUrl } from "pubky-social-specs";
 * console.log(parsePubkyUrl("pubky8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto/pub/social/v1/profile.json"));
 * ```
 */
export function parsePubkyUrl(value: string): T.PubkyUrl {
  const parsed = uris.parse(text(value, "uri"));
  if (!isObjectKind(parsed.kind) || parsed.path === "" || (parsed.kind === "post" && parsed.editId === undefined)) fail("path", `not the URL of a stored object: ${value}`, "uri");
  return `pubky://${parsed.owner}${parsed.path}` as T.PubkyUrl;
}

/**
 * Whether `value` is the canonical URL of a stored object, as `parsePubkyUrl` gives it: the
 * guard for a URL a LIST or another user handed over, with no exception to catch.
 *
 * @throws Nothing: a value that is not a URL of a stored object is `false`.
 *
 * @example
 * ```ts
 * import { decodeObject, isPubkyUrl } from "pubky-social-specs";
 * const url: string = "pubky://8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto/pub/social/v1/profile.json";
 * if (isPubkyUrl(url)) console.log(decodeObject.length, url);
 * ```
 */
export function isPubkyUrl(value: unknown): value is T.PubkyUrl {
  if (typeof value !== "string") return false;
  try {
    return parsePubkyUrl(value) === value;
  } catch (e) {
    if (e instanceof ValidationError) return false;
    throw e;
  }
}

/**
 * An owner-relative path as an `OwnerPath`: `/pub/` or `/priv/` and canonical segments.
 *
 * @throws `ValidationError` with `code: "path"` for a string that is no owner-relative path under a
 *  known root.
 *
 * @example
 * ```ts
 * import { parseOwnerPath, deletionPaths } from "pubky-social-specs";
 * // A path a LIST gave, branded once
 * const path = parseOwnerPath("/pub/social/v1/posts/0034A0X7NJ52C/0034A0X7NJ52C.json");
 * console.log(deletionPaths({ kind: "post", id: "0034A0X7NJ52C", listings: [path] }));
 * ```
 */
export function parseOwnerPath(value: string): T.OwnerPath {
  const path = text(value, "path");
  const segments = path.slice(1).split("/");
  if (!path.startsWith("/") || !segments.every(isCanonicalSegment) || parsePath(path.slice(1)) === null) fail("path", `not an owner-relative path: ${path}`, "path");
  return path as T.OwnerPath;
}

/**
 * A reference to a post as a `PostRef`, in its full `pubky://` spelling: versionless.
 *
 * @throws `ValidationError` with `code: "path"` for a string that is no versionless reference to a
 *  post.
 *
 * @example
 * ```ts
 * import { parsePostRef, buildPost } from "pubky-social-specs";
 * const owner = "8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto";
 * const parent = parsePostRef("pubky://dzswkfy7ek3bqnoc89jxuqqfbzhjrj6mi8qthgbxxcqkdugm3rio/pub/social/v1/posts/0034A0X7NJ52C");
 * console.log(buildPost(owner, { content: "Agreed", parent }).object.parent);
 * ```
 */
export function parsePostRef(value: string): T.PostRef {
  const parsed = uris.parse(text(value, "uri"));
  if (parsed.kind !== "post" || parsed.editId !== undefined) fail("path", `not a reference to a post: ${value}`, "uri");
  return `pubky://${parsed.owner}${parsed.path}` as T.PostRef;
}

/**
 * The time a post id or an edit id was minted, in microseconds since the epoch, the unit of
 * every stored timestamp.
 *
 * @throws `ValidationError` with `code: "format"` for a string that is not a canonical timestamp
 *  id.
 *
 * @example
 * ```ts
 * import { buildPost, idMicros, microsToDate } from "pubky-social-specs";
 * const post = buildPost("8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto", { content: "Hello" });
 * console.log(microsToDate(idMicros(post.id)).toISOString());
 * ```
 */
export function idMicros(id: T.Given<"PostId" | "EditId">): number {
  return Number(ids.timestampIdMicros(text(id, "id"), "id"));
}

/**
 * A `Date` for a stored timestamp in microseconds (`created_at`, `idMicros`), to the
 * millisecond a `Date` holds.
 *
 * @throws `ArgumentError` for a value that is not a safe integer.
 *
 * @example
 * ```ts
 * import { buildFollow, microsToDate } from "pubky-social-specs";
 * const follow = buildFollow("8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto", "dzswkfy7ek3bqnoc89jxuqqfbzhjrj6mi8qthgbxxcqkdugm3rio");
 * console.log(microsToDate(follow.object.created_at));
 * ```
 */
export function microsToDate(micros: number): Date {
  if (!Number.isSafeInteger(micros)) misuse("micros", "an integer of microseconds");
  return new Date(Math.floor(micros / 1000));
}

/**
 * The stored timestamp of a `Date`, or of milliseconds as `Date.now()` gives them: microseconds,
 * which is what every `created_at` holds.
 *
 * @throws `ArgumentError` for an invalid `Date` or a number that is not finite.
 *
 * @example
 * ```ts
 * import { dateToMicros } from "pubky-social-specs";
 * console.log(dateToMicros(new Date("2026-01-01T00:00:00Z"))); // 1767225600000000
 * ```
 */
export function dateToMicros(date: Date | number): number {
  const ms = date instanceof Date ? date.getTime() : date;
  if (!Number.isFinite(ms)) misuse("date", "a valid Date or a number of milliseconds");
  return Math.floor(ms) * 1000;
}

/**
 * `decodeObject` with the refusal returned instead of thrown, for a feed of other people's data
 * where a bad object is routine. A wrong argument still throws.
 *
 * @throws `ArgumentError` for arguments of the wrong type; a refusal of the bytes is returned, not
 *  thrown.
 *
 * @example
 * ```ts
 * import { tryDecodeObject } from "pubky-social-specs";
 * const url = "pubky://8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto/pub/social/v1/profile.json";
 * const result = tryDecodeObject(url, new TextEncoder().encode("{"), "user");
 * if (!result.ok) console.log(result.error.code); // json
 * ```
 */
export function tryDecodeObject<K extends keyof T.Stored>(uri: T.UrlArg, bytes: Uint8Array | ArrayBuffer, kind: K): { ok: true; value: T.Stored[K] } | { ok: false; error: ValidationError };
export function tryDecodeObject(uri: T.UrlArg, bytes: Uint8Array | ArrayBuffer): { ok: true; value: T.Decoded } | { ok: false; error: ValidationError };
export function tryDecodeObject(uri: T.UrlArg, bytes: Uint8Array | ArrayBuffer, kind?: keyof T.Stored): { ok: true; value: unknown } | { ok: false; error: ValidationError } {
  try {
    return { ok: true, value: kind === undefined ? decodeObject(uri, bytes) : decodeObject(uri, bytes, kind) };
  } catch (e) {
    if (e instanceof ValidationError) return { ok: false, error: e };
    throw e;
  }
}
