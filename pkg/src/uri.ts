// Paths and URIs: the parser, the builders, and the keys that join the two epochs of a tree.

import { canonicalPubky, isPublicKey } from "./canonicalize.js";
import { limits, STRIP_SET } from "./data.js";
import { fail, ValidationError } from "./errors.js";
import { checkHashId, checkPublicKey, timestampIdMicros } from "./ids.js";

export type Root = "public" | "private";

export type ParsedUri = { userId: string; root: Root; path: string } & Resource;

export type Resource =
  | { kind: "user" }
  | { kind: "post"; id: string; editId?: string; slug?: string }
  | { kind: "follow" | "mute" | "bookmark" | "tag" | "file" | "feed"; id: string }
  | { kind: "foreign"; namespace: string; version?: string; rest: string[] }
  | { kind: "unsupportedVersion"; version: string }
  | { kind: "unknown" };

const refuses = (check: () => unknown): boolean => {
  try {
    check();
    return false;
  } catch (e) {
    if (e instanceof ValidationError) return true;
    throw e;
  }
};
const isTimestampId = (id: string) => !refuses(() => timestampIdMicros(id));
const isHashId = (id: string) => !refuses(() => checkHashId(id));
const isEpoch = (segment: string) => /^v[0-9]+$/.test(segment);
const json = (leaf: string) => (leaf.endsWith(".json") ? leaf.slice(0, -5) : null);

export function isSlug(slug: string): boolean {
  return slug.length <= limits.postSlugMaxLength && /^[a-z0-9-]+$/.test(slug);
}

/** The id of a media filename: one rightmost extension stripped, only when it is a known one. */
export function mediaStem(filename: string): string | null {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 && STRIP_SET.includes(filename.slice(dot + 1)) ? filename.slice(0, dot) : null;
}

// 187 bytes of target are 250 characters of unpadded base64url
const BOOKMARK_ID_MAX = Math.ceil((limits.bookmarkTargetUriMaxBytes * 4) / 3);

/** The form only: the round trip that recovers the target runs when the object is read. */
export function isBookmarkId(name: string): boolean {
  if (name.startsWith("~")) return isHashId(name.slice(1));
  return !name.startsWith("_") && name.length <= BOOKMARK_ID_MAX && name.length % 4 !== 1 && /^[A-Za-z0-9_-]+$/.test(name);
}

// No time bound here: what a path names must not depend on the clock
function dispatch(root: Root, rest: string[]): Resource {
  const [segment, a, b] = rest;
  const unknown: Resource = { kind: "unknown" };
  if (rest.length === 1) return root === "public" && segment === "profile.json" ? { kind: "user" } : unknown;
  if (segment === "posts" && rest.length <= 3 && a !== undefined && isTimestampId(a)) {
    if (b === undefined) return { kind: "post", id: a };
    const stem = json(b);
    if (stem === null) return unknown;
    const dash = stem.indexOf("-");
    const editId = dash < 0 ? stem : stem.slice(0, dash);
    if ((dash >= 0 && !isSlug(stem.slice(dash + 1))) || !isTimestampId(editId)) return unknown;
    return dash < 0 ? { kind: "post", id: a, editId } : { kind: "post", id: a, editId, slug: stem.slice(dash + 1) };
  }
  if (rest.length !== 2 || a === undefined) return unknown;
  if (segment === "files") {
    const stem = mediaStem(a);
    return stem !== null && isHashId(stem) ? { kind: "file", id: stem } : unknown;
  }
  const id = json(a);
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
export function parsePath(host: string, path: string | null): ParsedUri | null {
  if (path === null) return { userId: host, root: "public", path: "", kind: "user" };
  const segments = path.split("/");
  const root = segments[0] === "pub" ? "public" : segments[0] === "priv" ? "private" : null;
  if (root === null) return null;
  const [, namespace, epoch] = segments;
  let resource: Resource;
  if (namespace === undefined) resource = { kind: "unknown" };
  else if (namespace !== "social") {
    // A namespace should carry an epoch as its second segment; named only when it has that shape
    const versioned = epoch !== undefined && isEpoch(epoch);
    resource = versioned
      ? { kind: "foreign", namespace, version: epoch, rest: segments.slice(3) }
      : { kind: "foreign", namespace, rest: segments.slice(2) };
  } else if (epoch === "v1") resource = dispatch(root, segments.slice(3));
  else if (epoch !== undefined && isEpoch(epoch)) resource = { kind: "unsupportedVersion", version: epoch };
  else resource = { kind: "unknown" };
  return { userId: host, root, path: `/${path}`, ...resource };
}

/** Classifies a URI. Throws only when it is not a canonical pubky URI with a known root. */
export function parseUri(uri: string): ParsedUri {
  const canonical = canonicalPubky(uri);
  if (canonical === null) fail(`Not a canonical pubky URI: ${uri}`);
  const rest = canonical.slice(8);
  const slash = rest.indexOf("/");
  const parsed = slash < 0 ? parsePath(rest, null) : parsePath(rest.slice(0, slash), rest.slice(slash + 1));
  return parsed ?? fail(`Unknown root in URI: ${uri}`);
}

const SEGMENT = { private: "priv", public: "pub" } as const;

/** `/{root}/social/v1/{leaf}`, the one place a path is assembled. */
export function socialPath(root: Root, leaf: string): string {
  return `/${SEGMENT[root]}/social/v1/${leaf}`;
}

// The builders check the owner key; the second part is spelled as given
function builder(root: Root, leaf: (id: string) => string) {
  return (owner: string, id: string): string => {
    checkPublicKey(owner);
    return `pubky://${owner}${socialPath(root, leaf(id))}`;
  };
}

export function userUri(owner: string): string {
  checkPublicKey(owner);
  return `pubky://${owner}${socialPath("public", "profile.json")}`;
}
export const postUri = builder("public", (id) => `posts/${id}`);
export const followUri = builder("public", (id) => `follows/${id}.json`);
export const muteUri = builder("private", (id) => `mutes/${id}.json`);
export const bookmarkUri = builder("private", (id) => `bookmarks/${id}.json`);
export const tagUri = builder("public", (id) => `tags/${id}.json`);
/** Takes the full `{hash}.{ext}` filename: an extension cannot be derived from an id. */
export const fileUri = builder("public", (filename) => `files/${filename}`);
/** The private path, where a feed lives. */
export const feedUri = builder("private", (id) => `feeds/${id}.json`);

/** The LIST prefix of a tree. Not a URI: the trailing slash is deliberate. */
export function listPrefix(owner: string, tree: Root | "legacy"): string {
  checkPublicKey(owner);
  if (tree === "legacy") return `pubky://${owner}/pub/pubky.app/`;
  if (tree !== "public" && tree !== "private") {
    fail(`unknown variant \`${tree}\`, expected one of \`public\`, \`private\`, \`legacy\``);
  }
  return `pubky://${owner}${socialPath(tree, "")}`;
}

const stripJson = (leaf: string) => json(leaf) ?? leaf;
const PLACEHOLDER = "y".repeat(52);
const KEY_SEGMENT: Record<string, string> = {
  post: "posts", follow: "follows", mute: "mutes", bookmark: "bookmarks", tag: "tags", file: "files", feed: "feeds",
};

/**
 * The key one object has under both epochs of a tree, from its owner-relative path:
 * `{key}`, or `{needsDeref}` for a legacy media reference that its 0.x File object
 * completes through `legacyMediaKey`, or null for a path that is no object.
 */
export function stableKey(ownerRelativePath: string): { key: string } | { needsDeref: string } | null {
  const path = ownerRelativePath.startsWith("/") ? ownerRelativePath.slice(1) : ownerRelativePath;
  const [root, namespace, ...rest] = path.split("/");
  if ((root !== "pub" && root !== "priv") || namespace === undefined || rest.length === 0) return null;
  if (namespace === "social") {
    if (canonicalPubky(`pubky://${PLACEHOLDER}/${path}`) === null) return null;
    const parsed = parsePath(PLACEHOLDER, path);
    if (parsed === null) return null;
    if (parsed.kind === "user") return { key: "profile" };
    return "id" in parsed ? { key: `${KEY_SEGMENT[parsed.kind]}/${parsed.id}` } : null;
  }
  if (namespace !== "pubky.app") return null;
  // The 0.x reader matched `[resource, id, ..]` and ignored what follows
  const [segment, leaf] = rest as [string, string | undefined];
  const hasLeaf = rest.length > 1 && rest.slice(1).join("/") !== "";
  if (hasLeaf && leaf === "") return null;
  if (!hasLeaf) {
    if (segment === "profile.json") return { key: "profile" };
    const name = stripJson(segment);
    return name === "last_read" || name === "settings" ? { key: name } : null;
  }
  const id = leaf as string;
  if (segment === "posts") return { key: `posts/${id}` };
  if (segment === "files") return { needsDeref: id };
  if (segment === "blobs") return { key: `files/${id}` };
  if (["tags", "follows", "mutes", "bookmarks", "feeds", "last_read", "settings"].includes(segment)) {
    const stripped = stripJson(id);
    return stripped === "" ? null : { key: `${segment}/${stripped}` };
  }
  return null;
}

const DOT = /^(\.|%2e)$/i;
const DOT_DOT = /^(\.|%2e){2}$/i;
const encoder = new TextEncoder();

// What a URL parser percent-encodes in a path: controls, space, `"#<>?\`{}` and non-ASCII
function encodeSegment(segment: string): string {
  let out = "";
  for (const byte of encoder.encode(segment)) {
    const c = String.fromCharCode(byte);
    out += byte <= 0x20 || byte >= 0x7f || '"#<>?`{}'.includes(c) ? `%${byte.toString(16).toUpperCase().padStart(2, "0")}` : c;
  }
  return out;
}

/**
 * Completes a legacy media key from the `src` of a 0.x File object
 * (`pubky://<pk>/pub/pubky.app/blobs/<hash>`): `files/<hash>`, or null when the src is no
 * legacy blob reference.
 *
 * The 0.x reader accepted a src on a URL parser's terms, so this reads one the same way for
 * the one scheme it can carry: surrounding controls and spaces dropped, tabs and newlines
 * removed anywhere, the scheme in any case, userinfo and a port ignored, the path
 * percent-encoded and its dot segments resolved.
 */
export function legacyMediaKey(v0FileSrc: string): string | null {
  // eslint-disable-next-line no-control-regex
  const input = v0FileSrc.replace(/^[\u0000- ]+|[\u0000- ]+$/g, "").replace(/[\t\n\r]/g, "");
  const scheme = /^pubky:\/\//i.exec(input);
  if (!scheme) return null;
  const rest = input.slice(scheme[0].length);
  const end = rest.search(/[/?#]/);
  const authority = end < 0 ? rest : rest.slice(0, end);
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  const colon = hostPort.indexOf(":");
  const host = colon < 0 ? hostPort : hostPort.slice(0, colon);
  const port = colon < 0 ? "" : hostPort.slice(colon + 1);
  if (!/^[0-9]*$/.test(port) || Number(port) > 65535 || !isPublicKey(host)) return null;
  if (end < 0 || rest[end] !== "/") return null;
  const raw = rest.slice(end + 1).split(/[?#]/, 1)[0] as string;
  const segments: string[] = [];
  const parts = raw.split("/");
  parts.forEach((part, i) => {
    const encoded = encodeSegment(part);
    const last = i === parts.length - 1;
    if (DOT_DOT.test(encoded)) {
      segments.pop();
      if (last) segments.push("");
    } else if (DOT.test(encoded)) {
      if (last) segments.push("");
    } else segments.push(encoded);
  });
  const [root, app, kind, id] = segments;
  return root === "pub" && app === "pubky.app" && kind === "blobs" && id ? `files/${id}` : null;
}
