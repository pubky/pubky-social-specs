// Follows, mutes, tags and bookmarks: one small object each, named by what it points at.

import { decode, encode } from "../base64url.js";
import { checkReference, reference } from "../canonicalize.js";
import { nowMicros } from "../clock.js";
import { limits } from "../data.js";
import { fail } from "../errors.js";
import { checkPublicKey, hashId } from "../ids.js";
import { type Extra, i64, open, option, string } from "../json/schema.js";
import { asciiFold, codePointLen, frozenTrim, hasFrozenWhitespace, utf8Len } from "../text.js";
import { socialPath } from "../uri.js";
import { checkExtra, checkSafeInt, type Model, SIZES, validate } from "./common.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const hashOf = (text: string) => hashId(encoder.encode(text));

export interface Edge extends Extra {
  created_at: bigint;
}

function edge(name: string): Model<Edge> {
  return {
    codec: open<Edge>(name, { created_at: { codec: i64 } }),
    maxBytes: SIZES.object,
    check(value, id) {
      if (id !== null) checkPublicKey(id);
      checkExtra(value.extra);
      checkSafeInt(value.created_at);
    },
  };
}

export const follow = edge("PubkySocialFollow");
export const mute = edge("PubkySocialMute");

function buildEdge(model: Model<Edge>, root: "public" | "private", segment: string, owner: string, target: string) {
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
  created_at: bigint;
}

/** A label as it is stored: trimmed and ASCII-lowercased. Only a builder folds. */
export const foldLabel = (label: string) => asciiFold(frozenTrim(label));

export function checkLabel(label: string): void {
  const length = codePointLen(label);
  if (length > limits.tagLabelMaxLength) fail(`Tag '${label}' exceeds maximum length of ${limits.tagLabelMaxLength} characters`);
  if (length < limits.tagLabelMinLength) fail(`Tag '${label}' is shorter than minimum length of ${limits.tagLabelMinLength} character`);
  if (hasFrozenWhitespace(label)) fail(`Tag '${label}' contains whitespace characters`);
  for (const c of label) if ((limits.tagInvalidChars as readonly string[]).includes(c)) fail(`Tag '${label}' contains invalid character: ${c}`);
}

const tagId = (value: Tag) => hashOf(`${value.uri}:${value.label}`);

export const tag: Model<Tag> = {
  codec: open<Tag>("PubkySocialTag", { uri: { codec: string }, label: { codec: string }, created_at: { codec: i64 } }),
  maxBytes: SIZES.object,
  check(value, id) {
    if (id !== null) {
      const expected = tagId(value);
      if (expected !== id) fail(`Invalid ID: expected ${expected}, found ${id}`);
    }
    checkExtra(value.extra);
    if (value.label !== foldLabel(value.label)) fail(`Tag '${value.label}' must be stored folded (trimmed, ASCII lowercase)`);
    checkLabel(value.label);
    // A tag is public, so a private target fails the root rule under any root
    checkReference("uri", value.uri, "", limits.referenceUriMaxLength, true, null);
    checkSafeInt(value.created_at);
  },
};

export function buildTag(owner: string, uri: string, label: string) {
  checkPublicKey(owner);
  const value: Tag = { uri, label: foldLabel(label), created_at: nowMicros(), extra: new Map() };
  const id = tagId(value);
  return { id, path: socialPath("public", `tags/${id}.json`), value, body: validate(tag, value, id, true) };
}

export interface Bookmark extends Extra {
  created_at: bigint;
  target: string | null;
}

const TARGET = "bookmark target";
const MAX = limits.bookmarkTargetUriMaxBytes;

function canonicalTarget(target: string): string {
  const result = reference(target, "", limits.referenceUriMaxLength, true, null);
  return "canonical" in result ? result.canonical : fail(`${TARGET} ${result.refusal}`);
}

const checkTarget = (target: string) => checkReference(TARGET, target, "", limits.referenceUriMaxLength, true, null);

/** The filename carries the target; one too long for a path segment goes by its hash. */
const idOf = (canonical: string) => (utf8Len(canonical) <= MAX ? encode(encoder.encode(canonical)) : `~${hashOf(canonical)}`);

/** The id `target` is bookmarked under, without building an object. */
export const bookmarkId = (target: string) => idOf(canonicalTarget(target));

function checkStoredTarget(target: string): void {
  checkTarget(target);
  if (utf8Len(target) <= MAX) fail(`a target of ${utf8Len(target)} bytes belongs in the primary bookmark form`);
}

/** The target a stored bookmark names. The content is needed only for the `~` form. */
export function targetOf(id: string, content: Bookmark): string {
  if (id.startsWith("~")) {
    if (content.target === null) fail("an overflow bookmark requires target in the content");
    checkStoredTarget(content.target);
    if (id.slice(1) !== hashOf(content.target)) fail(`bookmark filename does not hash its target: ${content.target}`);
    return content.target;
  }
  if (content.target !== null) fail("a primary bookmark carries its target in the filename, not in the content");
  const bytes = decode(id);
  if (bytes === null) fail(`bookmark filename is not canonical base64url: ${id}`);
  let target: string;
  try {
    target = decoder.decode(bytes);
  } catch {
    return fail(`bookmark filename is not UTF-8: ${id}`);
  }
  checkTarget(target);
  // Without the bound one target has a primary spelling and an overflow one
  if (bytes.length > MAX) fail(`a target over ${MAX} bytes belongs in the overflow bookmark form`);
  return target;
}

export const bookmark: Model<Bookmark> = {
  codec: open<Bookmark>("PubkySocialBookmark", {
    created_at: { codec: i64 },
    target: { codec: option(string), absent: () => null, skipNull: true },
  }),
  maxBytes: SIZES.object,
  check(value, id) {
    checkExtra(value.extra);
    checkSafeInt(value.created_at);
    if (id !== null) targetOf(id, value);
    else if (value.target !== null) checkStoredTarget(value.target);
  },
};

export function buildBookmark(owner: string, target: string) {
  checkPublicKey(owner);
  const canonical = canonicalTarget(target);
  const id = idOf(canonical);
  const value: Bookmark = { created_at: nowMicros(), target: id.startsWith("~") ? canonical : null, extra: new Map() };
  return { id, path: socialPath("private", `bookmarks/${id}.json`), value, body: validate(bookmark, value, id, false) };
}
