// The post lifecycle as plans: which copies and deletes to run, in the order that keeps a
// reader from ever seeing a post that points at nothing. A plan performs no I/O.

import { reference } from "./canonicalize.js";
import { limits } from "./data.js";
import { fail, ValidationError } from "./errors.js";
import { checkPublicKey, timestampIdMicros } from "./ids.js";
import { type JsonObject, readJson } from "./json/read.js";
import { writeJson } from "./json/write.js";
import { checkSafeNumbers, validate } from "./models/common.js";
import { checkReferences, checkTimestampId, envelopeRefs, post, type Post } from "./models/post.js";
import { compareBytes } from "./text.js";
import { LEGACY_ROOT, parsePath, type Root, SEGMENT, socialPath, splitPubky, versionOf } from "./path.js";

export interface Copy {
  from: string;
  to: string;
}

const ownerPrefix = (owner: string) => `pubky://${owner}`;
const mediaPrefix = (owner: string, root: Root) => ownerPrefix(owner) + socialPath(root, "files/");
const toPath = (uri: string, owner: string) => (uri.startsWith(ownerPrefix(owner)) ? uri.slice(ownerPrefix(owner).length) : uri);

// Every caller has matched the owner's media prefix first, so the URI has an owner and a path
const isMediaObject = (uri: string): boolean => parsePath(splitPubky(uri)?.path ?? null)?.kind === "file";

function isPrivRooted(uri: string): boolean {
  const path = splitPubky(uri)?.path;
  return path === "priv" || path?.startsWith("priv/") === true;
}

function mediaRefs(value: Post): string[] {
  const refs = value.attachments.map((a) => a.uri);
  const { cover } = envelopeRefs(value);
  return cover === null ? refs : [...refs, cover];
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
  const others = [value.parent, value.embed, value.lock].filter((uri): uri is string => uri !== null).concat(envelopeRefs(value).items);
  const hidden = others.find(isPrivRooted);
  if (hidden !== undefined) fail(`cannot publish: a public post cannot reference a private object: ${hidden}`);
  return media;
}

function toPublic(uri: string, owner: string): string {
  const priv = mediaPrefix(owner, "private");
  return uri.startsWith(priv) ? mediaPrefix(owner, "public") + uri.slice(priv.length) : uri;
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
  const { cover } = envelopeRefs(published);
  if (cover !== null && toPublic(cover, owner) !== cover) {
    // A cover is only ever read out of an envelope that parsed as an object
    const envelope = readJson(published.content) as JsonObject;
    try {
      checkSafeNumbers(envelope);
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
  return versionOf(leaf)?.editId ?? fail(`not a post version path: ${path}`);
}

function checkLegacyPaths(id: string, paths: string[]): void {
  const stray = paths.find((path) => path !== `${LEGACY_ROOT}posts/${id}`);
  if (stray !== undefined) fail(`not a legacy path of post ${id}: ${stray}`);
}

// A path `editIdOf` took is under `/pub/`, so only its root segment changes
const toPrivate = (path: string) => `/${SEGMENT.private}/${path.slice(`/${SEGMENT.public}/`.length)}`;

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
    copies: back.map((v): Copy => ({ from: v.path, to: toPrivate(v.path) })),
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
