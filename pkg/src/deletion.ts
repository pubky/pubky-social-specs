// Every stored copy of one object, across the two epochs and the two roots, in the order to
// delete them: legacy first.

import { canonicalPubky, canonicalUniversal } from "./canonicalize.js";
import { fail, misuse } from "./errors.js";
import { checkHashId, checkPublicKey, hashText, timestampIdFault } from "./ids.js";
import { inputOf, string } from "./json/schema.js";
import { deleteOrder } from "./lifecycle.js";
import { mimeToExt } from "./mime.js";
import { foldLabel } from "./models/label.js";
import { compareBytes } from "./text.js";
import { isBookmarkId, isObjectKind, LEGACY_ROOT, mediaStem, type ObjectKind, socialPath, splitPubky } from "./path.js";
import { legacyMediaKey, stableKey } from "./uri.js";

type V0Tag = { path: string; uri: string; label: string; src: string | null; contentType: string | null };
type Entry = { path: string; file?: { src: string }; tag?: V0Tag };

const maybe = (js: unknown, at: string) => (js === null || js === undefined ? null : string.parse(js, at));

function entryOf(listing: unknown, index: number): Entry {
  const at = `listings[${index}]`;
  if (typeof listing === "string") return { path: string.parse(listing, at) };
  const l = inputOf(listing, at, ["path", "src", "uri", "label", "contentType"]);
  const path = string.parse(l.path, `${at}.path`);
  if (l.uri === undefined) return { path, file: { src: string.parse(l.src, `${at}.src`) } };
  return {
    path,
    tag: { path, uri: string.parse(l.uri, `${at}.uri`), label: string.parse(l.label, `${at}.label`), src: maybe(l.src, `${at}.src`), contentType: maybe(l.contentType, `${at}.contentType`) },
  };
}

const notACopy = (kind: string, id: string, path: string) => fail(`not a stored copy of ${kind} ${id}: ${path}`);
const sorted = (paths: string[]) => [...new Set(paths)].sort(compareBytes);

function postPaths(id: string, entries: Entry[]): string[] {
  const paths = sorted(entries.map((e) => (e.file || e.tag ? notACopy("post", id, e.path) : e.path)));
  const legacy = paths.filter((path) => path.startsWith(LEGACY_ROOT));
  // The root is the path's own first segment; a path under neither is refused by the order
  const copies = paths.filter((path) => !path.startsWith(LEGACY_ROOT)).map((path) => ({ root: path.startsWith("/priv/") ? ("private" as const) : ("public" as const), path }));
  return deleteOrder(id, legacy, copies);
}

// The target of a 0.x tag as the migration respells it for v1
function v1TagTarget(tag: V0Tag): string {
  const { uri } = tag;
  if (uri.startsWith("pubky")) {
    const split = splitPubky(canonicalPubky(uri) ?? "");
    if (split === null) return fail(`not a pubky uri: ${uri}`);
    if (split.path === null) return fail(`not a stored object: ${uri}`);
    const stable = stableKey(split.path);
    if (stable === null) return fail(`not a stored object: ${uri}`);
    let key: string;
    if ("key" in stable) key = stable.key;
    else {
      if (tag.src === null || tag.contentType === null) return fail("a legacy tag on a file needs its File src and content_type");
      const media = legacyMediaKey(tag.src);
      if (media === null) return fail(`not a legacy blob src: ${tag.src}`);
      key = `${media}.${mimeToExt(tag.contentType)}`;
    }
    const leaf = key.startsWith("posts/") || key.startsWith("files/") ? key : `${key}.json`;
    return `pubky://${split.owner}${socialPath("public", leaf)}`;
  }
  if (uri.startsWith("http://") || uri.startsWith("https://")) return canonicalUniversal(uri) ?? fail(`not a canonical web uri: ${uri}`);
  return fail(`not a tag target v1 spells: ${uri}`);
}

function tagPaths(id: string, entries: Entry[]): string[] {
  checkHashId(id);
  const deletes: string[] = [];
  for (const { path, tag } of entries) {
    if (!tag) return notACopy("tag", id, path);
    // The 0.x id proves the entry is a tag; only the v1 id proves it is this one
    if (path !== `${LEGACY_ROOT}tags/${hashText(`${tag.uri}:${tag.label}`)}`) return notACopy("tag", id, path);
    if (hashText(`${v1TagTarget(tag)}:${foldLabel(tag.label)}`) !== id) fail(`legacy tag ${path} is not a copy of tag ${id}`);
    deletes.push(path);
  }
  return [...sorted(deletes), socialPath("public", `tags/${id}.json`)];
}

function filePaths(hash: string, entries: Entry[]): string[] {
  checkHashId(hash);
  const blob = `${LEGACY_ROOT}blobs/${hash}`;
  const dirs = [socialPath("public", "files/"), socialPath("private", "files/")];
  const v0Objects: string[] = [];
  const filenames: string[] = [];
  for (const { path, file, tag } of entries) {
    if (tag) return notACopy("file", hash, path);
    if (file) {
      // A 0.x File object belongs to this file only when its src resolves to these bytes
      const tsid = path.startsWith(`${LEGACY_ROOT}files/`) ? path.slice(`${LEGACY_ROOT}files/`.length) : null;
      if (tsid === null || timestampIdFault(tsid) !== null || legacyMediaKey(file.src) !== `files/${hash}`) return notACopy("file", hash, path);
      v0Objects.push(path);
    } else if (path !== blob) {
      const dir = dirs.find((d) => path.startsWith(d));
      const leaf = dir === undefined ? null : path.slice(dir.length);
      if (leaf === null || mediaStem(leaf) !== hash) return notACopy("file", hash, path);
      filenames.push(leaf);
    }
  }
  // The 0.x objects go before the bytes they point at; then the public copy before the
  // private one, so the file stops being world-readable first
  const names = sorted(filenames);
  return [...sorted(v0Objects), blob, ...names.map((f) => socialPath("public", `files/${f}`)), ...names.map((f) => socialPath("private", `files/${f}`))];
}

/** The paths to DELETE for the object of `kind` named `id`, given the copies the caller found. */
export function deletionPaths(kind: ObjectKind, id: string, listings: readonly unknown[]): string[] {
  if (!isObjectKind(kind)) misuse("kind", "an object kind");
  const entries = listings.map(entryOf);
  switch (kind) {
    case "post":
      return postPaths(id, entries);
    case "file":
      return filePaths(id, entries);
    case "tag":
      return tagPaths(id, entries);
  }
  // A listed copy here would be one nothing deletes, so it is refused, not ignored
  const [listed] = entries;
  if (listed !== undefined) fail(`a ${kind} delete takes no listings, found ${listed.path}`);
  switch (kind) {
    case "feed":
      checkHashId(id);
      return [socialPath("public", `feeds/${id}.json`), socialPath("private", `feeds/${id}.json`)];
    case "user":
      if (id !== "") fail(`the profile has no id, found ${id}`);
      return [`${LEGACY_ROOT}profile.json`, socialPath("public", "profile.json")];
    case "follow":
      checkPublicKey(id);
      return [`${LEGACY_ROOT}follows/${id}`, socialPath("public", `follows/${id}.json`)];
    case "mute":
      checkPublicKey(id);
      return [socialPath("private", `mutes/${id}.json`)];
    case "bookmark":
      if (!isBookmarkId(id)) fail(`not a bookmark filename: ${id}`);
      return [socialPath("private", `bookmarks/${id}.json`)];
  }
  return misuse("kind", "an object kind");
}
