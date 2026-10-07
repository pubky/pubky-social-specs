// pubky-social-specs: the Pubky social data model as plain functions.
//
// Nothing here performs I/O or needs to be loaded first. A builder returns where an object
// goes and the exact bytes to PUT there; `decodeObject` reads what a GET returns. A value the
// data model refuses throws a `ValidationError` carrying the reference message; a value of
// the wrong JS shape throws a `TypeError`.

import * as clock from "./clock.js";
import * as ids from "./ids.js";
import * as deletion from "./deletion.js";
import { fail, misuse } from "./errors.js";
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
  if (!isWellFormed(value)) fail("text must be well-formed UTF-16");
  return value;
}

function bytesOf(value: unknown, name: string): Uint8Array {
  // By shape, not `instanceof`: bytes from another realm are bytes too
  const view = value as Uint8Array | null;
  if (!ArrayBuffer.isView(view) || view.BYTES_PER_ELEMENT !== 1 || view instanceof DataView) misuse(name, "a Uint8Array");
  // A plain view of the same memory: a subclass may report a length it does not have
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
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
 * Replaces the clock, for tests: `nowMs` gives milliseconds as `Date.now` does, so ids and
 * `created_at` are known in advance. Without an argument the engine's clock is back. Either
 * way the guard that keeps ids increasing starts over.
 */
export function setClock(nowMs?: () => number): void {
  clock.pin(nowMs ? () => BigInt(nowMs()) * 1000n : null);
}

/**
 * Reads what is stored at `uri`, checked against the id, the root and the author the URI
 * names. Media comes back as its bytes.
 */
export function decodeObject(uri: string, bytes: Uint8Array): T.Decoded {
  const read = objects.read(text(uri, "uri"), bytesOf(bytes, "bytes"));
  if (read.kind === "file") return { kind: "file", bytes: read.body };
  return { kind: read.kind, object: objects.models[read.kind].codec.plain(read.value) } as T.Decoded;
}

/**
 * The bytes to PUT for an object read and then changed, its unknown members kept. `at` is the
 * URI it goes to; `{ kind }` instead checks it by the rules that need no path, for bytes bound
 * elsewhere.
 */
export function encodeObject(at: string | { kind: T.ObjectKind; root?: T.Root | null }, object: T.Stored[keyof T.Stored] | Uint8Array): T.Bytes {
  if (typeof at === "string") return objects.write(text(at, "at"), object);
  if (typeof at !== "object" || at === null) misuse("at", "a URI or { kind }");
  return objects.write({ kind: at.kind, root: rootOf(at.root, "at.root") }, object);
}

/** The envelope inside the `content` of an article or a collection; null for any other kind. */
export function decodeContent(post: T.Post): { kind: "article"; content: T.ArticleContent } | { kind: "collection"; content: T.CollectionContent } | null {
  const content = text(post?.content, "post.content");
  if (post.kind === "article") {
    const envelope = parseText(posts.article, content, "Article content must be a valid JSON envelope: ");
    return { kind: "article", content: posts.article.plain(envelope) as T.ArticleContent };
  }
  if (post.kind === "collection") {
    const envelope = parseText(posts.collection, content, "Collection content must be a valid JSON envelope: ");
    return { kind: "collection", content: posts.collection.plain(envelope) as T.CollectionContent };
  }
  return null;
}

/** The `content` string of an article or a collection, for a post about to be edited. */
export function encodeContent(content: T.ArticleContent | T.CollectionContent): string {
  if (typeof content !== "object" || content === null) misuse("content", "an article or a collection envelope");
  return "title" in content ? posts.article.write(posts.article.parse(content, "content")) : posts.collection.write(posts.collection.parse(content, "content"));
}

/** A fresh profile. To change a stored one and keep what this version does not know: decode, edit, encode. */
export function buildUser(owner: string, input: T.NewUser): T.Built<T.User> {
  return built(owner, users.user.codec, users.buildUser(text(owner, "owner"), input));
}

/** A new post at `posts/{id}/{id}[-slug].json`, the id minted here. */
export function buildPost(owner: string, input: T.NewPost): T.BuiltPost {
  return builtPost(owner, posts.buildPost(text(owner, "owner"), input));
}

/**
 * An edit of the post whose newest version is at `headUri`: a new version in the same post,
 * with an id above the head's. `root` defaults to the head's own.
 */
export function editPost(headUri: string, post: T.Post, options?: { root?: T.Root | null; slug?: string | null } | null): T.BuiltPost {
  const head = uris.parse(text(headUri, "headUri"));
  if (head.kind !== "post" || head.editId === undefined) return fail(`not the URI of a stored post version: ${headUri}`);
  const root = options?.root === undefined || options.root === null ? head.root : rootOf(options.root, "options.root");
  const slug = options?.slug === undefined || options.slug === null ? null : text(options.slug, "options.slug");
  const value = posts.post.codec.parse(post, "post");
  return builtPost(head.owner, posts.editPost(head.owner, value, head.id, head.editId, root, slug));
}

/** A feed at its private path; the id is derived from the filter alone. */
export function buildFeed(owner: string, input: T.NewFeed): T.Built<T.Feed> {
  return built(owner, feeds.feed.codec, feeds.buildFeed(text(owner, "owner"), input));
}

/** The id of a feed object: an edited filter moves the feed, and this is where to. */
export function feedId(feed: T.Feed): string {
  return feeds.feedId(feeds.feed.codec.parse(feed, "feed"));
}

/** A tag on `uri`. The builder folds the label; the uri must already be canonical. */
export function buildTag(owner: string, uri: string, label: string): T.Built<T.Tag> {
  return built(owner, graph.tag.codec, graph.buildTag(text(owner, "owner"), text(uri, "uri"), text(label, "label")));
}

/** A bookmark of `target`. Its id carries the target, so a LIST alone tells what is bookmarked. */
export function buildBookmark(owner: string, target: string): T.Built<T.Bookmark> {
  return built(owner, graph.bookmark.codec, graph.buildBookmark(text(owner, "owner"), text(target, "target")));
}

export function buildFollow(owner: string, followee: string): T.Built<T.Follow> {
  return built(owner, graph.follow.codec, graph.buildFollow(text(owner, "owner"), text(followee, "followee")));
}

/** A mute, stored under the private root. */
export function buildMute(owner: string, mutee: string): T.Built<T.Mute> {
  return built(owner, graph.mute.codec, graph.buildMute(text(owner, "owner"), text(mutee, "mutee")));
}

/**
 * Where media goes: content addressed, so the id is the hash of the bytes. Pass the bytes, or
 * an id from `createMediaHasher` when they were hashed elsewhere, as in a worker.
 */
export function buildFile(owner: string, input: T.NewFile): { id: string; path: string; url: string } {
  if (typeof input !== "object" || input === null) misuse("input", "an object");
  const source = "bytes" in input ? { bytes: bytesOf(input.bytes, "input.bytes") } : { id: text(input.id, "input.id") };
  const made = files.buildFile(text(owner, "owner"), source, text(input.type, "input.type"), rootOf(input.root, "input.root"));
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

/** Publishing one private version: the media copies to run first, then the post to PUT. */
export function planPublish(owner: string, version: { id: string; editId: string; post: T.Post }): { copies: lifecycle.Copy[]; put: T.BuiltPost } {
  if (typeof version !== "object" || version === null) misuse("version", "an object");
  const value = posts.post.codec.parse(version.post, "version.post");
  const plan = lifecycle.planPublish(text(owner, "owner"), text(version.id, "version.id"), text(version.editId, "version.editId"), value);
  return { copies: plan.copies, put: builtPost(owner, plan.put) };
}

/** Unpublishing: the copies back into the private root, then the deletes, each in order. */
export function planUnpublish(post: { id: string; publicPaths: string[]; legacyPaths?: string[] | null; privateHead?: string | null }): { copies: lifecycle.Copy[]; deletes: string[] } {
  if (typeof post !== "object" || post === null) misuse("post", "an object");
  const head = post.privateHead === undefined || post.privateHead === null ? null : text(post.privateHead, "post.privateHead");
  return lifecycle.planUnpublish(text(post.id, "post.id"), strings(post.publicPaths, "post.publicPaths"), strings(post.legacyPaths ?? [], "post.legacyPaths"), head);
}

/** Deleting a post everywhere: the deletes in order, then the media to consider collecting. */
export function planDelete(owner: string, post: { id: string; legacyPaths?: string[] | null; copies?: lifecycle.StoredCopy[] | null; versions?: T.Post[] | null }): { deletes: string[]; mediaGcCandidates: string[] } {
  if (typeof post !== "object" || post === null) misuse("post", "an object");
  const copies = arrayOf(post.copies ?? [], "post.copies").map((copy, index) => {
    const given = inputOf(copy, `post.copies[${index}]`, ["root", "path"]);
    return { root: rootOf(given.root, `post.copies[${index}].root`), path: text(given.path, `post.copies[${index}].path`) };
  });
  const versions = arrayOf(post.versions ?? [], "post.versions").map((version, index) => posts.post.codec.parse(version, `post.versions[${index}]`));
  return lifecycle.planDelete(text(owner, "owner"), text(post.id, "post.id"), strings(post.legacyPaths ?? [], "post.legacyPaths"), copies, versions);
}

/**
 * Every stored copy of one object across both epochs and both roots, legacy first.
 * `listings` are the copies the caller found; only a post, a file and a tag take any.
 */
export function deletionPaths(target: { kind: T.ObjectKind; id: string; listings?: deletion.Listing[] | null }): string[] {
  if (typeof target !== "object" || target === null) misuse("target", "an object");
  return deletion.deletionPaths(text(target.kind, "target.kind") as T.ObjectKind, text(target.id, "target.id"), arrayOf(target.listings ?? [], "target.listings"));
}

/** Classifies a URI. Throws only when it is not a canonical pubky URI with a known root. */
export function parseUri(uri: string): T.ParsedUri {
  const parsed = uris.parse(text(uri, "uri"));
  if (parsed.kind !== "bookmark" || parsed.id.startsWith("~")) return parsed;
  try {
    return { ...parsed, target: graph.targetOf(parsed.id, { created_at: 0n, target: null, extra: new Map() }) };
  } catch (e) {
    // The form of the id passed; what it carries is no valid target, which a reader skips
    if (e instanceof Error && e.name === "ValidationError") return parsed;
    throw e;
  }
}

/**
 * Where an object of `kind` lives under `owner`. A post URI is versionless, the form a
 * reference takes; a file takes its full `{hash}.{ext}` name; a feed gets its private path.
 */
export function buildUri(owner: string, kind: "user"): string;
export function buildUri(owner: string, kind: Exclude<T.ObjectKind, "user">, id: string): string;
export function buildUri(owner: string, kind: T.ObjectKind, id?: string): string {
  return uris.build(text(owner, "owner"), text(kind, "kind") as T.ObjectKind, kind === "user" ? "" : text(id, "id"));
}

/** The LIST prefix of one of an owner's trees. Not a URI: the trailing slash is deliberate. */
export function listPrefix(owner: string, tree: T.Root | "legacy"): string {
  return uris.listPrefix(text(owner, "owner"), tree);
}
