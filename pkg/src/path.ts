// The grammar of a path inside an owner's tree: what each canonical path names, and the one
// place a path is assembled. No URI parsing here, so the canonicalizers can build on it.

import { limits } from "./data.js";
import { hashIdFault, isPublicKey, timestampIdFault } from "./ids.js";
import { MEDIA_EXTENSIONS } from "./mime.js";
import { hasControlOrWhitespace } from "./text.js";

export type Root = "public" | "private";

/** An owner-relative path: what the SDK's storage calls and every plan take. */
export type OwnerPath = `/pub/${string}` | `/priv/${string}`;
const OBJECT_KINDS = Object.freeze(["user", "post", "follow", "mute", "bookmark", "tag", "file", "feed"] as const);
export type ObjectKind = (typeof OBJECT_KINDS)[number];
export const isObjectKind = (kind: string): kind is ObjectKind => (OBJECT_KINDS as readonly string[]).includes(kind);

type Resource =
  | { kind: "user" }
  | { kind: "post"; id: string; editId?: string; slug?: string }
  | { [K in "follow" | "mute" | "bookmark" | "tag" | "file" | "feed"]: { kind: K; id: string } }["follow" | "mute" | "bookmark" | "tag" | "file" | "feed"]
  | { kind: "foreign"; namespace: string; version?: string; rest: string[] }
  | { kind: "unsupportedVersion"; version: string }
  | { kind: "unknown" };

export type Located = { root: Root; path: OwnerPath | "" } & Resource;

const isTimestampId = (id: string) => timestampIdFault(id) === null;
const isHashId = (id: string) => hashIdFault(id) === null;
const isEpoch = (segment: string) => /^v[0-9]+$/.test(segment);
/** The stem of a `.json` leaf, or null for any other leaf. */
export const jsonStem = (leaf: string): string | null => (leaf.endsWith(".json") ? leaf.slice(0, -5) : null);

export function isSlug(slug: string): boolean {
  return slug.length <= limits.postSlugMaxLength && /^[a-z0-9-]+$/.test(slug);
}

/** The id of a media filename: one rightmost extension stripped, only when it is a known one. */
export function mediaStem(filename: string): string | null {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 && MEDIA_EXTENSIONS.has(filename.slice(dot + 1)) ? filename.slice(0, dot) : null;
}

// 187 bytes of target are 250 characters of unpadded base64url
const BOOKMARK_ID_MAX = Math.ceil((limits.bookmarkTargetUriMaxBytes * 4) / 3);

/** The form only: the round trip that recovers the target runs when the object is read. */
export function isBookmarkId(name: string): boolean {
  if (name.startsWith("~")) return isHashId(name.slice(1));
  return !name.startsWith("_") && name.length <= BOOKMARK_ID_MAX && name.length % 4 !== 1 && /^[A-Za-z0-9_-]+$/.test(name);
}

/** The `{editId}[-{slug}].json` leaf of a post version, or null for any other leaf. */
export function versionOf(leaf: string): { editId: string; slug?: string } | null {
  const stem = jsonStem(leaf);
  if (stem === null) return null;
  const dash = stem.indexOf("-");
  const editId = dash < 0 ? stem : stem.slice(0, dash);
  if ((dash >= 0 && !isSlug(stem.slice(dash + 1))) || !isTimestampId(editId)) return null;
  return dash < 0 ? { editId } : { editId, slug: stem.slice(dash + 1) };
}

// No time bound here: what a path names must not depend on the clock
function dispatch(root: Root, rest: string[]): Resource {
  const [segment, a, b] = rest;
  const unknown: Resource = { kind: "unknown" };
  if (rest.length === 1) return root === "public" && segment === "profile.json" ? { kind: "user" } : unknown;
  if (segment === "posts" && rest.length <= 3 && a !== undefined && isTimestampId(a)) {
    if (b === undefined) return { kind: "post", id: a };
    const version = versionOf(b);
    return version === null ? unknown : { kind: "post", id: a, ...version };
  }
  if (rest.length !== 2 || a === undefined) return unknown;
  if (segment === "files") {
    const stem = mediaStem(a);
    return stem !== null && isHashId(stem) ? { kind: "file", id: stem } : unknown;
  }
  const id = jsonStem(a);
  if (id === null) return unknown;
  if (segment === "feeds") return isHashId(id) ? { kind: "feed", id } : unknown;
  if (root === "public") {
    if (segment === "tags") return isHashId(id) ? { kind: "tag", id } : unknown;
    if (segment === "follows") return isPublicKey(id) ? { kind: "follow", id } : unknown;
  } else {
    if (segment === "mutes") return isPublicKey(id) ? { kind: "mute", id } : unknown;
    if (segment === "bookmarks") return isBookmarkId(id) ? { kind: "bookmark", id } : unknown;
  }
  return unknown;
}

/** What a canonical path names, or null for a root that is neither `pub` nor `priv`. */
export function parsePath(path: string | null): Located | null {
  if (path === null) return { root: "public", path: "", kind: "user" };
  const segments = path.split("/");
  const root = segments[0] === "pub" ? "public" : segments[0] === "priv" ? "private" : null;
  if (root === null) return null;
  const [, namespace, epoch] = segments;
  let resource: Resource;
  if (namespace === undefined) resource = { kind: "unknown" };
  else if (namespace !== "social") {
    // A namespace should carry an epoch as its second segment; named only when it has that shape
    const versioned = epoch !== undefined && isEpoch(epoch);
    resource = versioned ? { kind: "foreign", namespace, version: epoch, rest: segments.slice(3) } : { kind: "foreign", namespace, rest: segments.slice(2) };
  } else if (epoch === "v1") resource = dispatch(root, segments.slice(3));
  else if (epoch !== undefined && isEpoch(epoch)) resource = { kind: "unsupportedVersion", version: epoch };
  else resource = { kind: "unknown" };
  return { root, path: `/${path}` as OwnerPath, ...resource };
}

export const SEGMENT = { private: "priv", public: "pub" } as const;

/** The 0.x namespace, and where the 0.x tree kept everything, public only. */
export const LEGACY_NAMESPACE = "pubky.app";
export const LEGACY_ROOT = `/pub/${LEGACY_NAMESPACE}/`;

/** `/{root}/social/v1/{leaf}`, the one place a path is assembled. */
export function socialPath(root: Root, leaf: string): OwnerPath {
  return `/${SEGMENT[root]}/social/v1/${leaf}`;
}

export function isCanonicalSegment(segment: string): boolean {
  return segment !== "" && segment !== "." && segment !== ".." && !/[/%?#]/.test(segment) && !hasControlOrWhitespace(segment);
}

/**
 * The owner-relative path of `url` when it is `pubky://<owner>/` and then a path under `pub/`
 * or `priv/` whose every segment is canonical, so no dot segment, empty segment, `%` or
 * control resolves anywhere else; null otherwise. A directory, with `directory`, may end in
 * `/`. The one check the engine's write fence and the SDK adapter share.
 */
export function ownedPath(url: string, owner: string, directory = false): string | null {
  const prefix = `pubky://${owner}/`;
  if (!url.startsWith(prefix)) return null;
  const segments = url.slice(prefix.length).split("/");
  const [root] = segments;
  if ((root !== "pub" && root !== "priv") || segments.length < 2) return null;
  const last = segments.length - 1;
  const clean = segments.every((segment, i) => isCanonicalSegment(segment) || (directory && i === last && i > 0 && segment === ""));
  return clean ? url.slice(prefix.length - 1) : null;
}

/** Whether a path split off by `splitPubky` is under the private root. */
export const isPrivatePath = (path: string | null): boolean => path === "priv" || path?.startsWith("priv/") === true;

/** A full `pubky://` URI split after its owner: the path without its leading `/`, null for none. */
export function splitPubky(uri: string): { owner: string; path: string | null } | null {
  if (!uri.startsWith("pubky://")) return null;
  const rest = uri.slice("pubky://".length);
  const slash = rest.indexOf("/");
  return slash < 0 ? { owner: rest, path: null } : { owner: rest.slice(0, slash), path: rest.slice(slash + 1) };
}
