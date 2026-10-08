// Paths and URIs: the parser and the builders.

import { canonicalPubky } from "./canonicalize.js";
import { fail, nameOf } from "./errors.js";
import { checkPublicKey } from "./ids.js";
import { LEGACY_ROOT } from "./legacy.js";
import { type Located, OBJECT_KINDS, type ObjectKind, parsePath, type Root, socialPath, splitPubky } from "./path.js";

export type Parsed = { owner: string } & Located;

/** Classifies a URI. Throws only when it is not a canonical pubky URI with a known root. */
export function parse(uri: string): Parsed {
  const split = splitPubky(canonicalPubky(uri) ?? "");
  if (split === null) return fail("path", `Not a canonical pubky URI: ${uri}`);
  const located = parsePath(split.path);
  if (located === null) fail("path", `Unknown root in URI: ${uri}`);
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
  // Where the builder writes a feed; its published copy is the same leaf under the public root
  feed: (id) => ["private", `feeds/${id}.json`],
};

/** Where an object of `kind` lives under `owner`. The owner key is checked, the id is spelled as given. */
export function build(owner: string, kind: ObjectKind, id: string): `pubky://${string}` {
  checkPublicKey(owner);
  const [root, leaf] = LEAF[nameOf(kind, "kind", OBJECT_KINDS)](id);
  return `pubky://${owner}${socialPath(root, leaf)}`;
}

/** `build`, and only for an id the parser reads back as that object: no other path comes out. */
export function buildChecked(owner: string, kind: ObjectKind, id: string): `pubky://${string}` {
  const uri = build(owner, kind, id);
  const canonical = canonicalPubky(uri);
  const located = canonical === null ? null : parsePath(splitPubky(canonical)?.path ?? null);
  const named =
    located !== null &&
    located.kind === kind &&
    (located.kind === "user" || located.kind === "file" || (located.kind === "post" ? located.editId === undefined && located.id === id : "id" in located && located.id === id));
  return named ? uri : fail("format", `not ${kind === "file" ? "a media file name" : `the id of a ${kind}`}: ${id}`, "id");
}

/** The LIST prefix of a tree. Not a URI: the trailing slash is deliberate. */
export function listPrefix(owner: string, tree: Root | "legacy"): `pubky://${string}` {
  checkPublicKey(owner);
  const given = nameOf(tree, "tree", ["public", "private", "legacy"] as const);
  if (given === "legacy") return `pubky://${owner}${LEGACY_ROOT}`;
  return `pubky://${owner}${socialPath(given, "")}`;
}
