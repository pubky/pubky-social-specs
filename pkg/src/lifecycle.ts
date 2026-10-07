// The post lifecycle as plans: which copies and deletes to run, in the order that keeps a
// reader from ever seeing a post that points at nothing. A plan performs no I/O.

import { reference } from "./canonicalize.js";
import { limits } from "./data.js";
import { fail, ValidationError } from "./errors.js";
import { checkPublicKey, timestampIdFault, timestampIdMicros } from "./ids.js";
import { type Json, JsonError, type JsonObject, readJson } from "./json/read.js";
import { writeJson } from "./json/write.js";
import { checkSafeInt, parse, validate } from "./models/common.js";
import { checkReferences, checkTimestampId, collection, post, type Post } from "./models/post.js";
import { compareBytes } from "./text.js";
import { isSlug, parsePath, type Root, socialPath } from "./uri.js";

export interface Copy {
  from: string;
  to: string;
}

const ownerPrefix = (owner: string) => `pubky://${owner}`;
const mediaPrefix = (owner: string, root: Root) => ownerPrefix(owner) + socialPath(root, "files/");
const toPath = (uri: string, owner: string) => (uri.startsWith(ownerPrefix(owner)) ? uri.slice(ownerPrefix(owner).length) : uri);

function isMediaObject(uri: string): boolean {
  const rest = uri.startsWith("pubky://") ? uri.slice(8) : "";
  const slash = rest.indexOf("/");
  return slash > 0 && parsePath(rest.slice(slash + 1))?.kind === "file";
}

function isPrivRooted(uri: string): boolean {
  if (!uri.startsWith("pubky://")) return false;
  const rest = uri.slice(8);
  const slash = rest.indexOf("/");
  if (slash < 0) return false;
  const path = rest.slice(slash + 1);
  return path === "priv" || path.startsWith("priv/");
}

function envelopeOf(value: Post): JsonObject | null {
  if (value.kind !== "article" && value.kind !== "collection") return null;
  try {
    const envelope = readJson(value.content);
    return envelope instanceof Map ? envelope : null;
  } catch (e) {
    if (e instanceof JsonError) return null;
    throw e;
  }
}

function coverOf(value: Post): string | null {
  const cover = envelopeOf(value)?.get("cover_image");
  return typeof cover === "string" ? cover : null;
}

function mediaRefs(value: Post): string[] {
  const refs = value.attachments.map((a) => a.uri);
  const cover = coverOf(value);
  return cover === null ? refs : [...refs, cover];
}

function itemUris(value: Post): string[] {
  if (value.kind !== "collection") return [];
  try {
    return parse(collection, value.content).items.map((entry) => entry.uri);
  } catch (e) {
    if (e instanceof ValidationError) return [];
    throw e;
  }
}

/** The owner's private media a version references, each once, in order of appearance. */
function privateMediaRefs(value: Post, owner: string): string[] {
  const ownPrivate = mediaPrefix(owner, "private");
  const media: string[] = [];
  for (const uri of mediaRefs(value)) {
    const result = reference(uri, "pubky or web", limits.referenceUriMaxLength, false, owner);
    if ("refusal" in result) fail(`cannot publish: media uri ${result.refusal}`);
    if (result.canonical !== uri) fail(`cannot publish: media uri must be spelled in canonical form: ${uri}`);
    if (uri.startsWith(ownPrivate)) {
      // The leaf must be media the parser reads, or the copy would land where no reader looks
      if (!isMediaObject(uri)) fail(`cannot publish: a private reference in a media position is not a media object: ${uri}`);
      if (!media.includes(uri)) media.push(uri);
    } else if (isPrivRooted(uri)) fail(`cannot publish: a private reference in a media position is not media: ${uri}`);
  }
  const others = [value.parent, value.embed, value.lock].filter((uri): uri is string => uri !== null).concat(itemUris(value));
  const hidden = others.find(isPrivRooted);
  if (hidden !== undefined) fail(`cannot publish: a public post cannot reference a private object: ${hidden}`);
  return media;
}

function toPublic(uri: string, owner: string): string {
  const priv = mediaPrefix(owner, "private");
  return uri.startsWith(priv) ? mediaPrefix(owner, "public") + uri.slice(priv.length) : uri;
}

function checkSafe(value: Json): void {
  if (typeof value === "bigint") checkSafeInt(value);
  else if (Array.isArray(value)) value.forEach(checkSafe);
  else if (value instanceof Map) for (const key of [...value.keys()].sort(compareBytes)) checkSafe(value.get(key) as Json);
}

/**
 * Publishing one private version: the media copies to run first, then the post to PUT, its
 * private media references respelled to their public form in the reference positions only.
 */
export function planPublish(owner: string, id: string, editId: string, value: Post) {
  checkPublicKey(owner);
  checkTimestampId(id);
  checkTimestampId(editId);
  if (compareBytes(editId, id) < 0) fail(`editId ${editId} predates the post id ${id}`);
  const copies: Copy[] = privateMediaRefs(value, owner).map((uri) => ({ from: toPath(uri, owner), to: toPath(toPublic(uri, owner), owner) }));
  const published: Post = { ...value, attachments: value.attachments.map((a) => ({ ...a, uri: toPublic(a.uri, owner) })) };
  const cover = coverOf(published);
  if (cover !== null && toPublic(cover, owner) !== cover) {
    const envelope = envelopeOf(published);
    if (envelope === null) return fail("cannot publish: the cover did not parse");
    try {
      checkSafe(envelope);
    } catch (e) {
      if (e instanceof ValidationError) fail(`cannot publish: ${e.reason}`, e.field);
      throw e;
    }
    envelope.set("cover_image", toPublic(cover, owner));
    published.content = writeJson(envelope);
  }
  const body = validate(post, published, id, true);
  checkReferences(published, true, owner);
  return { copies, put: { id, editId, path: socialPath("public", `posts/${id}/${editId}.json`), value: published, body } };
}

function editIdOf(id: string, root: Root, path: string): string {
  const dir = socialPath(root, `posts/${id}/`);
  const leaf = path.startsWith(dir) ? path.slice(dir.length) : null;
  if (leaf === null || leaf.includes("/")) return fail(`not a version path of post ${id} under ${dir}: ${path}`);
  const stem = leaf.endsWith(".json") ? leaf.slice(0, -5) : null;
  const dash = stem?.indexOf("-") ?? -1;
  const editId = stem === null ? null : dash < 0 ? stem : stem.slice(0, dash);
  const sound = editId !== null && (dash < 0 || isSlug((stem as string).slice(dash + 1))) && timestampIdFault(editId) === null;
  return sound ? editId : fail(`not a post version path: ${path}`);
}

function checkLegacyPaths(id: string, paths: string[]): void {
  const stray = paths.find((path) => path !== `/pub/pubky.app/posts/${id}`);
  if (stray !== undefined) fail(`not a legacy path of post ${id}: ${stray}`);
}

const under = (root: Root, path: string) => {
  const trimmed = path.replace(/^\/+/, "");
  const slash = trimmed.indexOf("/");
  return `/${root === "public" ? "pub" : "priv"}/${slash < 0 ? "" : trimmed.slice(slash + 1)}`;
};

/**
 * Unpublishing: every public version newer than the private head is copied back, oldest
 * first; without a private tree the newest public version seeds it. Then the deletes.
 */
export function planUnpublish(id: string, publicPaths: string[], legacyPaths: string[], privateHead: string | null) {
  timestampIdMicros(id);
  checkLegacyPaths(id, legacyPaths);
  const versions = publicPaths.map((path) => ({ editId: editIdOf(id, "public", path), path })).sort((a, b) => compareBytes(a.editId, b.editId));
  const head = privateHead === null ? null : editIdOf(id, "private", privateHead);
  if (versions.length === 0 && head === null) fail(`nothing to unpublish for post ${id}`);
  const back = head === null ? versions.slice(-1) : versions.filter((v) => compareBytes(v.editId, head) > 0);
  return {
    copies: back.map((v): Copy => ({ from: v.path, to: under("private", v.path) })),
    deletes: [...legacyPaths, ...versions.map((v) => v.path)],
  };
}

export interface StoredCopy {
  root: Root;
  path: string;
}

/** Legacy first, then every version oldest first with `pub` before `priv`. */
export function deleteOrder(id: string, legacyPaths: string[], copies: StoredCopy[]): string[] {
  timestampIdMicros(id);
  checkLegacyPaths(id, legacyPaths);
  const keyed = copies
    .map((copy) => ({ editId: editIdOf(id, copy.root, copy.path), copy }))
    .sort((a, b) => compareBytes(a.editId, b.editId) || Number(a.copy.root === "private") - Number(b.copy.root === "private"));
  return [...legacyPaths, ...keyed.map((k) => k.copy.path)];
}

/** Deleting a post everywhere: the deletes in order, then the media to consider collecting. */
export function planDelete(owner: string, id: string, legacyPaths: string[], copies: StoredCopy[], versions: Post[]) {
  checkPublicKey(owner);
  const deletes = deleteOrder(id, legacyPaths, copies);
  const prefixes = [mediaPrefix(owner, "public"), mediaPrefix(owner, "private")];
  const candidates = versions
    .flatMap(mediaRefs)
    .filter((uri) => prefixes.some((prefix) => uri.startsWith(prefix)) && isMediaObject(uri))
    .map((uri) => toPath(uri, owner));
  return { deletes, mediaGcCandidates: [...new Set(candidates)].sort(compareBytes) };
}
