// Paths and URIs: the parser, the builders, and the keys that join the two epochs of a tree.

import { canonicalPubky } from "./canonicalize.js";
import { fail, misuse } from "./errors.js";
import { checkPublicKey, publicKeyFault } from "./ids.js";
import { isCanonicalSegment, LEGACY_NAMESPACE, LEGACY_ROOT, type Located, type ObjectKind, parsePath, type Root, socialPath, splitPubky } from "./path.js";
import { trimWhere, utf8 } from "./text.js";

export * from "./path.js";

const isPublicKey = (key: string) => publicKeyFault(key) === null;
const json = (leaf: string) => (leaf.endsWith(".json") ? leaf.slice(0, -5) : null);

export type Parsed = { owner: string } & Located;

/** Classifies a URI. Throws only when it is not a canonical pubky URI with a known root. */
export function parse(uri: string): Parsed {
  const split = splitPubky(canonicalPubky(uri) ?? "");
  if (split === null) return fail(`Not a canonical pubky URI: ${uri}`);
  const located = parsePath(split.path);
  if (located === null) fail(`Unknown root in URI: ${uri}`);
  return { owner: split.owner, ...located };
}

const LEAF: Record<ObjectKind, (id: string) => [Root, string]> = {
  user: () => ["public", "profile.json"],
  post: (id) => ["public", `posts/${id}`],
  follow: (id) => ["public", `follows/${id}.json`],
  mute: (id) => ["private", `mutes/${id}.json`],
  bookmark: (id) => ["private", `bookmarks/${id}.json`],
  tag: (id) => ["public", `tags/${id}.json`],
  // The full `{hash}.{ext}` filename: an extension cannot be derived from an id
  file: (id) => ["public", `files/${id}`],
  // The private path, where a feed lives
  feed: (id) => ["private", `feeds/${id}.json`],
};

/** Where an object of `kind` lives under `owner`. The owner key is checked, the id is spelled as given. */
export function build(owner: string, kind: ObjectKind, id = ""): `pubky://${string}` {
  checkPublicKey(owner);
  if (!Object.hasOwn(LEAF, kind)) misuse("kind", "an object kind");
  const [root, leaf] = LEAF[kind](id);
  return `pubky://${owner}${socialPath(root, leaf)}`;
}

/** `build`, and only for an id the parser reads back as that object: no other path comes out. */
export function buildChecked(owner: string, kind: ObjectKind, id = ""): `pubky://${string}` {
  const uri = build(owner, kind, id);
  const canonical = canonicalPubky(uri);
  const located = canonical === null ? null : parsePath(splitPubky(canonical)?.path ?? null);
  const named =
    located !== null &&
    located.kind === kind &&
    (located.kind === "user" ||
      located.kind === "file" ||
      (located.kind === "post" ? located.editId === undefined && located.id === id : "id" in located && located.id === id));
  return named ? uri : fail(`not ${kind === "file" ? "a media file name" : `the id of a ${kind}`}: ${id}`, "id");
}

/** The LIST prefix of a tree. Not a URI: the trailing slash is deliberate. */
export function listPrefix(owner: string, tree: Root | "legacy"): `pubky://${string}` {
  checkPublicKey(owner);
  if (tree === "legacy") return `pubky://${owner}${LEGACY_ROOT}`;
  if (tree !== "public" && tree !== "private") misuse("tree", '"public", "private" or "legacy"');
  return `pubky://${owner}${socialPath(tree, "")}`;
}

const stripJson = (leaf: string) => json(leaf) ?? leaf;

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
    if (!path.split("/").every(isCanonicalSegment)) return null;
    const parsed = parsePath(path);
    if (parsed === null) return null;
    if (parsed.kind === "user") return { key: "profile" };
    return "id" in parsed ? { key: `${parsed.kind}s/${parsed.id}` } : null;
  }
  if (namespace !== LEGACY_NAMESPACE) return null;
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

// What a URL parser percent-encodes in the path of a non-special scheme: controls, space,
// `"#<>?\`{}` and non-ASCII. A backslash is no separator there and stays as it is
function encodeSegment(segment: string): string {
  let out = "";
  for (const byte of utf8(segment)) {
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
  const input = trimWhere(v0FileSrc, (unit) => unit <= 0x20).replace(/[\t\n\r]/g, "");
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
