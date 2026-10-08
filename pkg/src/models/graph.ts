// Follows, mutes, tags and bookmarks: one small object each, named by what it points at.

import * as base64url from "../base64url.js";
import { checkReference, reference } from "../canonicalize.js";
import { nowMicros } from "../clock.js";
import { limits } from "../data.js";
import { type Each, fail, throwing } from "../errors.js";
import { checkPublicKey, hashText } from "../ids.js";
import { type Extra, i64, object, omitted, string } from "../json/schema.js";
import { utf8, utf8Len, utf8Text } from "../text.js";
import { type Root, socialPath } from "../path.js";
import { checkExtra, checkSafeInt, type Model, validate } from "./common.js";
import { checkLabel, foldLabel } from "./label.js";

export interface Edge extends Extra {
  /** Microseconds since the epoch. */
  created_at: bigint;
}

function edge(name: string): Model<Edge> {
  return {
    codec: object<Edge>(name, { created_at: i64 }),
    maxBytes: limits.objectMaxBytes,
    check(value, id, _publicRoot, each) {
      if (id !== null) each(() => checkPublicKey(id));
      each(() => checkExtra(value.extra));
      each(() => checkSafeInt(value.created_at, "created_at"));
    },
  };
}

export const follow = edge("PubkySocialFollow");
export const mute = edge("PubkySocialMute");

function buildEdge(model: Model<Edge>, root: Root, segment: string, owner: string, target: string) {
  checkPublicKey(owner);
  const value: Edge = { created_at: nowMicros(), extra: new Map() };
  const body = validate(model, value, target, root === "public");
  return { id: target, path: socialPath(root, `${segment}/${target}.json`), value, body };
}

export const buildFollow = (owner: string, followee: string) => buildEdge(follow, "public", "follows", owner, followee);
export const buildMute = (owner: string, mutee: string) => buildEdge(mute, "private", "mutes", owner, mutee);

export interface Tag extends Extra {
  uri: string;
  label: string;
  /** Microseconds since the epoch. */
  created_at: bigint;
}

const tagId = (value: Tag) => hashText(`${value.uri}:${value.label}`);

export const tag: Model<Tag> = {
  codec: object<Tag>("PubkySocialTag", { uri: string, label: string, created_at: i64 }),
  maxBytes: limits.objectMaxBytes,
  check(value, id, _publicRoot, each) {
    each(() => {
      const expected = tagId(value);
      if (id !== null && expected !== id) fail("id", `Invalid ID: expected ${expected}, found ${id}`, "id");
    });
    each(() => checkExtra(value.extra));
    each(() => {
      if (value.label !== foldLabel(value.label)) fail("format", `Tag '${value.label}' must be stored folded (trimmed, ASCII lowercase)`, "label");
      checkLabel(value.label);
    });
    // A tag is public, so a private target fails the root rule under any root
    each(() => checkReference("uri", value.uri, "", limits.referenceUriMaxLength, true, null));
    each(() => checkSafeInt(value.created_at, "created_at"));
  },
};

export function buildTag(owner: string | null, uri: string, label: string, each: Each = throwing) {
  if (owner !== null) checkPublicKey(owner);
  const value: Tag = { uri, label: foldLabel(label), created_at: nowMicros(), extra: new Map() };
  const id = tagId(value);
  return { id, path: socialPath("public", `tags/${id}.json`), value, body: validate(tag, value, id, true, each) };
}

export interface Bookmark extends Extra {
  /** Microseconds since the epoch. */
  created_at: bigint;
  /** Only on a bookmark whose target is too long for its id to carry. */
  target: string | null;
}

const TARGET = "bookmark target";
const MAX = limits.bookmarkTargetUriMaxBytes;

function canonicalTarget(target: string): string {
  const result = reference(target, "", limits.referenceUriMaxLength, true, null);
  return "canonical" in result ? result.canonical : fail("reference", `${TARGET} ${result.refusal}`, "target");
}

const checkTarget = (target: string) => checkReference(TARGET, target, "", limits.referenceUriMaxLength, true, null);

/** The id carries the target; one too long for a path segment goes by its hash. */
const idOf = (canonical: string) => (utf8Len(canonical) <= MAX ? base64url.encode(utf8(canonical)) : `~${hashText(canonical)}`);

function checkStoredTarget(target: string): void {
  checkTarget(target);
  if (utf8Len(target) <= MAX) fail("conflict", `a target of ${utf8Len(target)} bytes belongs in the primary bookmark form`, "target");
}

/** The target a stored bookmark names. The content is needed only for the `~` form. */
export function targetOf(id: string, content: Bookmark): string {
  if (id.startsWith("~")) {
    if (content.target === null) fail("conflict", "an overflow bookmark requires target in the content", "target");
    checkStoredTarget(content.target);
    if (id.slice(1) !== hashText(content.target)) fail("id", `bookmark filename does not hash its target: ${content.target}`, "id");
    return content.target;
  }
  if (content.target !== null) fail("conflict", "a primary bookmark carries its target in the filename, not in the content", "target");
  const bytes = base64url.decode(id);
  if (bytes === null) fail("format", `bookmark filename is not canonical base64url: ${id}`, "id");
  const target = utf8Text(bytes);
  if (target === null) fail("format", `bookmark filename is not UTF-8: ${id}`, "id");
  checkTarget(target);
  // Without the bound one target has a primary spelling and an overflow one
  if (bytes.length > MAX) fail("conflict", `a target over ${MAX} bytes belongs in the overflow bookmark form`, "target");
  return target;
}

export const bookmark: Model<Bookmark> = {
  codec: object<Bookmark>("PubkySocialBookmark", { created_at: i64, target: omitted(string) }),
  maxBytes: limits.objectMaxBytes,
  check(value, id, _publicRoot, each) {
    each(() => checkExtra(value.extra));
    each(() => checkSafeInt(value.created_at, "created_at"));
    each(() => {
      if (id !== null) targetOf(id, value);
      else if (value.target !== null) checkStoredTarget(value.target);
    });
  },
};

export function buildBookmark(owner: string, target: string) {
  checkPublicKey(owner);
  const canonical = canonicalTarget(target);
  const id = idOf(canonical);
  const value: Bookmark = { created_at: nowMicros(), target: id.startsWith("~") ? canonical : null, extra: new Map() };
  return { id, path: socialPath("private", `bookmarks/${id}.json`), value, body: validate(bookmark, value, id, false) };
}
