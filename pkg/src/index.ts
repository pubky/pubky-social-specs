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

import { plainBytes } from "./bytes.js";
import * as ids from "./ids.js";
import * as deletion from "./deletion.js";
import { fail, misuse, ValidationError } from "./errors.js";
import { arrayOf, type Codec, inputOf } from "./json/schema.js";
import * as lifecycle from "./lifecycle.js";
import { parse as parseText } from "./models/common.js";
import * as feeds from "./models/feed.js";
import * as files from "./models/file.js";
import * as graph from "./models/graph.js";
import * as posts from "./models/post.js";
import * as users from "./models/user.js";
import * as objects from "./objects.js";
import { isWellFormed, utf8 } from "./text.js";
import type * as T from "./types.js";
import * as uris from "./uri.js";

export { limits, validMimeTypes } from "./data.js";
export { ValidationError } from "./errors.js";
export { collectionLayouts, feedLayouts, feedReaches, feedSorts, postKinds } from "./models/kinds.js";
export type { CollectionLayout, FeedLayout, FeedReach, FeedSort, KnownCollectionLayout, KnownFeedLayout, KnownFeedReach, KnownFeedSort, KnownPostKind, PostKind } from "./models/kinds.js";
export type { Copy, StoredCopy } from "./lifecycle.js";
export type { Listing } from "./deletion.js";
export type * from "./types.js";

// A Rust string cannot hold a lone surrogate, so no rule of the model has an answer for one
function text(value: unknown, name: string): string {
  if (typeof value !== "string") misuse(name, "a string");
  if (!isWellFormed(value)) fail("text must be well-formed UTF-16", name.includes(".") ? undefined : name);
  return value;
}

/** A public key argument: refused under its own name, which the reference text does not carry. */
function key(value: unknown, name: string): string {
  ids.checkPublicKey(text(value, name), name);
  return value as string;
}

function bytesOf(value: unknown, name: string): T.Bytes {
  return plainBytes(value) ?? misuse(name, "a Uint8Array or an ArrayBuffer");
}

const strings = (value: unknown, name: string): string[] => arrayOf(value, name).map((item, index) => text(item, `${name}[${index}]`));

const rootOf = (value: unknown, name: string): uris.Root => {
  if (value === undefined || value === null) return "public";
  if (value !== "public" && value !== "private") misuse(name, '"public" or "private"');
  return value;
};

type Made<V> = { id: string; path: string; value: V; body: string };

function built<P, V>(owner: string, codec: Codec<V>, made: Made<V>): T.Built<P> {
  return { id: made.id, path: made.path, url: `pubky://${owner}${made.path}`, object: codec.plain(made.value) as P, body: utf8(made.body) };
}

const builtPost = (owner: string, made: posts.Minted): T.BuiltPost => ({ ...built<T.Post, posts.Post>(owner, posts.post.codec, made), editId: made.editId });

/**
 * Reads what is stored at `uri`, a full `pubky://` URL, by the rules of the kind the URL names:
 * the id where the id is derived from the content (a tag, a feed, a bookmark, media), the root,
 * and for a post the author. Media comes back as its bytes, a view of the ones given.
 *
 * Throws a `ValidationError` when the bytes are no valid object there. Other people's data can
 * be anything, so decode it inside a try. A post of a kind this version does not know is
 * refused too: it has rules this version cannot check.
 */
export function decodeObject(uri: string, bytes: Uint8Array): T.Decoded {
  const read = objects.read(text(uri, "uri"), bytesOf(bytes, "bytes"));
  if (read.kind === "file") return { kind: "file", bytes: read.body };
  return { kind: read.kind, object: objects.models[read.kind].codec.plain(read.value) } as T.Decoded;
}

/**
 * The bytes to PUT for an object read and then changed, its unknown members kept. `object` is
 * the `.object` of a `decodeObject` or builder result, never its bytes or the result itself;
 * for media it is the bytes, returned as they are once checked.
 *
 * `at` is the URL it goes to. `{ kind, root? }` instead checks the object by the rules that
 * need no path, for bytes bound somewhere the data model does not name.
 */
export function encodeObject(at: string | { kind: T.ObjectKind; root?: T.Root | null }, object: T.Stored[keyof T.Stored] | Uint8Array): T.Bytes {
  object = plainBytes(object) ?? object;
  if (typeof at === "string") return objects.write(text(at, "at"), object);
  const where = inputOf(at, "at", ["kind", "root"]);
  return objects.write({ kind: text(where.kind, "at.kind") as T.ObjectKind, root: rootOf(where.root, "at.root") }, object);
}

/**
 * The envelope inside the `content` of an article or a collection; null for any other kind.
 * `post` is a stored post, the `.object` of a result. Throws a `ValidationError` when the
 * content is not a readable envelope.
 */
export function decodeContent(post: T.Post): { kind: "article"; content: T.ArticleContent } | { kind: "collection"; content: T.CollectionContent } | null {
  const own = (key: "content" | "kind") => (typeof post === "object" && post !== null && Object.hasOwn(post, key) ? post[key] : undefined);
  const content = text(own("content"), "post.content");
  const kind = own("kind");
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
 */
export function encodeContent(content: T.ArticleContent | T.CollectionContent): string {
  if (typeof content !== "object" || content === null) misuse("content", "an article or a collection envelope");
  if (Object.hasOwn(content, "title")) return posts.article.write(posts.article.parse(content, "content"));
  if (Object.hasOwn(content, "name")) return posts.collection.write(posts.collection.parse(content, "content"));
  return misuse("content", "an article envelope, with a title, or a collection envelope, with a name");
}

/**
 * A fresh profile for `owner`, a bare public key. Name, bio, status and link titles are
 * trimmed; `image` and each link `url` are stored as written and must be canonical already.
 * To change a stored profile and keep what this version does not know: decode, edit, encode.
 */
export function buildUser(owner: string, input: T.NewUser): T.Built<T.User> {
  return built(owner, users.user.codec, users.buildUser(key(owner, "owner"), input));
}

/**
 * A new post at `posts/{id}/{id}[-slug].json`, the id minted here from the clock. The input is
 * told apart by `kind`: an article takes `title` and `body`, a collection `name` and `items`,
 * and any other kind (`note` when absent, `image`, `video`, `link`, `file`) takes `content`.
 * `parent`, `embed`, `lock`, attachment and item URIs are references: stored as written.
 */
export function buildPost(owner: string, input: T.NewPost): T.BuiltPost {
  return builtPost(owner, posts.buildPost(key(owner, "owner"), input));
}

/**
 * An edit of the post whose newest version is at `headUri`: a new version in the same post,
 * with an id above the head's. `headUri` is the URL of that version, in the caller's own
 * storage: the owner and the post id are read from it. `post` is the stored post as it should
 * now read, the `.object` of a decode with its changes. `root` defaults to the head's own; a
 * slug is not carried over from the head.
 */
export function editPost(headUri: string, post: T.Post, options?: { root?: T.Root | null; slug?: string | null } | null): T.BuiltPost {
  const head = uris.parse(text(headUri, "headUri"));
  if (head.kind !== "post" || head.editId === undefined) return fail(`not the URI of a stored post version: ${headUri}`);
  const given = options === undefined || options === null ? {} : inputOf(options, "options", ["root", "slug"]);
  const root = given.root === undefined || given.root === null ? head.root : rootOf(given.root, "options.root");
  const slug = given.slug === undefined || given.slug === null ? null : text(given.slug, "options.slug");
  const value = posts.post.codec.parse(post, "post");
  return builtPost(head.owner, posts.editPost(head.owner, value, head.id, head.editId, root, slug));
}

/**
 * A feed at its private path. The id is derived from the filter alone (reach, layout, sort,
 * content, tags), so two feeds with one filter are one feed whatever their names, and an
 * edited filter is a new path. `icon` is 1 to 50 of a-z, 0-9 and `-`.
 */
export function buildFeed(owner: string, input: T.NewFeed): T.Built<T.Feed> {
  return built(owner, feeds.feed.codec, feeds.buildFeed(key(owner, "owner"), input));
}

/** The id of a feed object: an edited filter moves the feed, and this is where to. */
export function feedId(feed: T.Feed): string {
  return feeds.feedId(feeds.feed.codec.parse(feed, "feed"));
}

/**
 * A tag on `uri`, a reference: for a post, `buildUri(author, "post", id)`. The builder trims
 * the label and lowercases its ASCII letters; a label holds no whitespace, comma or colon.
 */
export function buildTag(owner: string, uri: string, label: string): T.Built<T.Tag> {
  return built(owner, graph.tag.codec, graph.buildTag(key(owner, "owner"), text(uri, "uri"), text(label, "label")));
}

/** A bookmark of `target`. Its id carries the target, so a LIST alone tells what is bookmarked. */
export function buildBookmark(owner: string, target: string): T.Built<T.Bookmark> {
  return built(owner, graph.bookmark.codec, graph.buildBookmark(key(owner, "owner"), text(target, "target")));
}

/** A follow of `followee`, a bare public key, stored under the public root. */
export function buildFollow(owner: string, followee: string): T.Built<T.Follow> {
  return built(owner, graph.follow.codec, graph.buildFollow(key(owner, "owner"), key(followee, "followee")));
}

/** A mute, stored under the private root. */
export function buildMute(owner: string, mutee: string): T.Built<T.Mute> {
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
 */
export function buildFile(owner: string, input: T.NewFile): { id: string; path: string; url: string } {
  const given = inputOf(input, "input", ["bytes", "id", "type", "root"]);
  if ((given.bytes === undefined) === (given.id === undefined)) misuse("input", "given either bytes or an id");
  const source = given.bytes !== undefined ? { bytes: bytesOf(given.bytes, "input.bytes") } : { id: text(given.id, "input.id") };
  const made = files.buildFile(key(owner, "owner"), source, text(given.type, "input.type"), rootOf(given.root, "input.root"));
  return { ...made, url: `pubky://${owner}${made.path}` };
}

/**
 * A media id fed a chunk at a time, for bytes too large to hold at once or hashed off the main
 * thread. `id()` is what `buildFile` gives for the same bytes, and may be read at any point.
 */
export function createMediaHasher(): { update(chunk: Uint8Array): void; id(): string } {
  const hasher = ids.createMediaHasher();
  return { update: (chunk) => hasher.update(bytesOf(chunk, "chunk")), id: hasher.id };
}

/**
 * Publishing one private version: the media copies to run first, then the post to PUT. Every
 * path in a plan is owner-relative.
 */
export function planPublish(owner: string, version: { id: string; editId: string; post: T.Post }): { copies: lifecycle.Copy[]; put: T.BuiltPost } {
  const given = inputOf(version, "version", ["id", "editId", "post"]);
  const value = posts.post.codec.parse(given.post, "version.post");
  const plan = lifecycle.planPublish(key(owner, "owner"), text(given.id, "version.id"), text(given.editId, "version.editId"), value);
  return { copies: plan.copies, put: builtPost(owner, plan.put) };
}

/**
 * Unpublishing: the copies back into the private root, then the deletes, each in order.
 * `publicPaths` are the paths of the post's public versions as a LIST gave them, `privateHead`
 * the path of its newest private version when it has one, `legacyPaths` its 0.x copy.
 */
export function planUnpublish(post: { id: string; publicPaths: string[]; legacyPaths?: string[] | null; privateHead?: string | null }): { copies: lifecycle.Copy[]; deletes: string[] } {
  const given = inputOf(post, "post", ["id", "publicPaths", "legacyPaths", "privateHead"]);
  const head = given.privateHead === undefined || given.privateHead === null ? null : text(given.privateHead, "post.privateHead");
  return lifecycle.planUnpublish(text(given.id, "post.id"), strings(given.publicPaths, "post.publicPaths"), strings(given.legacyPaths ?? [], "post.legacyPaths"), head);
}

/**
 * Deleting a post everywhere: the deletes in order, then the media to consider collecting.
 * `copies` are the stored versions found by LIST, each `{ root, path }`; `versions` the ones
 * that could be read. A media candidate is deleted only once nothing else references it, which
 * only the caller can know.
 */
export function planDelete(owner: string, post: { id: string; legacyPaths?: string[] | null; copies?: lifecycle.StoredCopy[] | null; versions?: T.Post[] | null }): { deletes: string[]; mediaGcCandidates: string[] } {
  const given = inputOf(post, "post", ["id", "legacyPaths", "copies", "versions"]);
  const copies = arrayOf(given.copies ?? [], "post.copies").map((copy, index) => {
    const given = inputOf(copy, `post.copies[${index}]`, ["root", "path"]);
    return { root: rootOf(given.root, `post.copies[${index}].root`), path: text(given.path, `post.copies[${index}].path`) };
  });
  const versions = arrayOf(given.versions ?? [], "post.versions").map((version, index) => posts.post.codec.parse(version, `post.versions[${index}]`));
  return lifecycle.planDelete(key(owner, "owner"), text(given.id, "post.id"), strings(given.legacyPaths ?? [], "post.legacyPaths"), copies, versions);
}

/**
 * The paths to DELETE for one object, legacy first. What the id alone gives is derived: the
 * profile, a follow, and the 1.x path of everything else. For a post, a file and a tag the
 * other copies come from `listings`, the owner-relative paths found by LIST (and for a 0.x
 * File object or tag, what proves it belongs to this one); a post with no listings gives none.
 */
export function deletionPaths(target: { kind: T.ObjectKind; id: string; listings?: deletion.Listing[] | null }): string[] {
  const given = inputOf(target, "target", ["kind", "id", "listings"]);
  return deletion.deletionPaths(text(given.kind, "target.kind") as T.ObjectKind, text(given.id, "target.id"), arrayOf(given.listings ?? [], "target.listings"));
}

/**
 * Classifies a URI by its path alone, without the clock. `pubky://<owner>/...` and the short
 * `pubky<owner>/...` are both read. Throws only when the string is neither, or its path holds
 * a segment no canonical path has (`..`, an empty one, `%`, whitespace), or its root is not
 * `pub` or `priv`. A 0.x path reads as `{ kind: "foreign", namespace: "pubky.app" }`.
 */
export function parseUri(uri: string): T.ParsedUri {
  const parsed = uris.parse(text(uri, "uri"));
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
 */
export function buildUri(owner: string, kind: "user"): string;
export function buildUri(owner: string, kind: Exclude<T.ObjectKind, "user">, id: string): string;
export function buildUri(owner: string, kind: T.ObjectKind, id?: string): string {
  return uris.buildChecked(key(owner, "owner"), text(kind, "kind") as T.ObjectKind, kind === "user" ? "" : text(id, "id"));
}

/** The LIST prefix of one of an owner's trees. Not a URI: the trailing slash is deliberate. */
export function listPrefix(owner: string, tree: T.Root | "legacy"): string {
  return uris.listPrefix(key(owner, "owner"), tree);
}
