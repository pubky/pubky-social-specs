// Posts: one envelope for every kind, a version per edit, and references that obey the root
// the version is stored under.

import { blake3 } from "@noble/hashes/blake3.js";
import { checkReference } from "../canonicalize.js";
import { mintFrom, nowMicros } from "../clock.js";
import { limits } from "../data.js";
import { fail, misuse, ValidationError } from "../errors.js";
import { checkPublicKey, timestampId, timestampIdMicros } from "../ids.js";
import { type Json, JsonError, readJson } from "../json/read.js";
import { defaulted, type Extra, inputOf, list, object, omitted, option, string } from "../json/schema.js";
import { codePointLen, compareBytes, frozenTrim, trimmedOrNull, utf8 } from "../text.js";
import { isSlug, type Root, socialPath } from "../uri.js";
import { checkExtra, type Model, parse, validate } from "./common.js";
import { collectionLayout, type CollectionLayout, collectionLayouts, known, postKind, type PostKind, postKinds } from "./kinds.js";

export interface Attachment extends Extra {
  uri: string;
  alt: string | null;
  name: string | null;
}

export interface Post extends Extra {
  content: string;
  kind: PostKind;
  parent: string | null;
  embed: string | null;
  attachments: Attachment[];
  lock: string | null;
}

export interface ArticleContent extends Extra {
  title: string;
  body: string;
  cover_image: string | null;
}

export interface CollectionItem extends Extra {
  uri: string;
  note: string | null;
}

export interface CollectionContent extends Extra {
  name: string;
  description: string | null;
  items: CollectionItem[];
  cover_image: string | null;
  layout: CollectionLayout | null;
}

const attachment = object<Attachment>("PubkySocialAttachment", { uri: string, alt: omitted(string), name: omitted(string) });
export const article = object<ArticleContent>("PubkySocialArticleContent", { title: string, body: string, cover_image: omitted(string) });
const item = object<CollectionItem>("PubkySocialCollectionItem", { uri: string, note: omitted(string) });
export const collection = object<CollectionContent>("PubkySocialCollectionContent", {
  name: string,
  description: omitted(string),
  items: defaulted(list(item), () => []),
  cover_image: omitted(string),
  layout: omitted(collectionLayout),
});

// 2024-10-01 UTC, before which no id was minted
const MIN_MICROS = 1_727_740_800_000_000n;
// An id may sit this far ahead of the reader's clock and still be valid
const MAX_FUTURE = 7_200_000_000n;

/** A TimestampId in its canonical spelling and inside the time bounds. */
export function checkTimestampId(id: string): bigint {
  const micros = timestampIdMicros(id);
  if (micros < MIN_MICROS) fail("Invalid ID, timestamp must be on or after October 1st, 2024", "id");
  if (micros > nowMicros() + MAX_FUTURE) fail("Invalid ID, timestamp is too far in the future", "id");
  return micros;
}

/** Every reference of a post through the one gate. With an owner the ownership rule runs too. */
export function checkReferences(value: Post, publicRoot: boolean, owner: string | null): void {
  const max = limits.referenceUriMaxLength;
  if (value.parent !== null) checkReference("parent", value.parent, "", max, publicRoot, owner);
  if (value.embed !== null) checkReference("embed", value.embed, "", max, publicRoot, owner);
  if (value.lock !== null) checkReference("lock", value.lock, "pubky", max, publicRoot, owner);
  value.attachments.forEach((a, index) => checkReference(`attachments[${index}].uri`, a.uri, "pubky or web", max, publicRoot, owner));
  if (value.kind !== "article" && value.kind !== "collection") return;
  // Content that does not parse references nothing here; its own rule refuses it after
  let envelope: Json | undefined;
  try {
    envelope = readJson(value.content);
  } catch (e) {
    if (!(e instanceof JsonError)) throw e;
  }
  const cover = envelope instanceof Map ? envelope.get("cover_image") : undefined;
  if (typeof cover === "string") checkReference("cover_image", cover, "pubky or web", limits.imageUrlMaxLength, publicRoot, owner);
  if (value.kind !== "collection") return;
  let items: CollectionItem[] = [];
  try {
    items = parse(collection, value.content).items;
  } catch (e) {
    if (!(e instanceof ValidationError)) throw e;
  }
  items.forEach((entry, index) => checkReference(`items[${index}].uri`, entry.uri, "", max, publicRoot, owner));
}

// eslint-disable-next-line no-control-regex
const OTHER_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const hasOtherControl = (s: string) => OTHER_CONTROL.test(s);
function checkArticle(post: Post): void {
  if (codePointLen(post.content) > limits.articleContentMaxLength) fail(`Article content must be at most ${limits.articleContentMaxLength} code points`, "content");
  const envelope = parse(article, post.content, "Article content must be a valid JSON envelope: ");
  checkExtra(envelope.extra);
  // Other controls escape to six characters and would break the bound on the content
  if (hasOtherControl(envelope.title) || hasOtherControl(envelope.body)) {
    fail("Article text must not contain control characters other than tab, newline and carriage return", hasOtherControl(envelope.title) ? "title" : "body");
  }
  if (frozenTrim(envelope.title) === "") fail("Article title must contain non-whitespace characters", "title");
  if (codePointLen(envelope.title) > limits.articleTitleMaxLength) fail(`Article title must be at most ${limits.articleTitleMaxLength} code points`, "title");
  if (codePointLen(envelope.body) > limits.articleBodyMaxLength) fail(`Article body must be at most ${limits.articleBodyMaxLength} code points`, "body");
}

function checkCollection(post: Post): void {
  if (post.parent !== null || post.embed !== null) fail("Collection posts cannot have parent or embed", post.parent !== null ? "parent" : "embed");
  if (post.attachments.length > 0) fail("Collection posts must not use post.attachments; items belong in the content envelope", "attachments");
  if (codePointLen(post.content) > limits.collectionContentMaxLength) fail(`Collection content exceeds max length ${limits.collectionContentMaxLength}`, "content");
  const envelope = parse(collection, post.content, "Collection content must be a valid JSON envelope: ");
  checkExtra(envelope.extra);
  if (frozenTrim(envelope.name) === "") fail("Collection name must contain non-whitespace characters", "name");
  const length = codePointLen(envelope.name);
  if (length < limits.collectionNameMinLength || length > limits.collectionNameMaxLength) {
    fail(`Collection name must be ${limits.collectionNameMinLength}..=${limits.collectionNameMaxLength} characters`, "name");
  }
  if (envelope.description !== null) {
    if (frozenTrim(envelope.description) === "") fail("Collection description must not be blank", "description");
    if (codePointLen(envelope.description) > limits.collectionDescriptionMaxLength) fail(`Collection description exceeds ${limits.collectionDescriptionMaxLength} characters`, "description");
  }
  if (envelope.items.length > limits.collectionItemsMaxCount) fail(`Collection cannot have more than ${limits.collectionItemsMaxCount} items`, "items");
  envelope.items.forEach((entry, index) => {
    checkExtra(entry.extra);
    const max = limits.collectionItemNoteMaxLength;
    if (entry.note !== null && (frozenTrim(entry.note) === "" || codePointLen(entry.note) > max)) {
      fail(`items[${index}].note must be 1..=${max} code points and not blank`, `items[${index}].note`);
    }
  });
}

export const post: Model<Post> = {
  codec: object<Post>("PostEnvelope", {
    content: string,
    kind: postKind,
    parent: option(string),
    embed: option(string),
    attachments: defaulted(list(attachment), () => []),
    lock: omitted(string),
  }),
  maxBytes: limits.postMaxBytes,
  check(value, id, publicRoot) {
    if (id !== null) checkTimestampId(id);
    checkExtra(value.extra);
    // "unknown" is what a newer kind reads as: readable, never valid to write
    if (value.kind === "unknown") fail("post kind is unknown", "kind");
    checkReferences(value, publicRoot, null);
    if (value.attachments.length > limits.postAttachmentsMaxCount) fail(`Too many attachments (max: ${limits.postAttachmentsMaxCount})`, "attachments");
    value.attachments.forEach((a, index) => {
      checkExtra(a.extra);
      if (a.alt !== null && codePointLen(a.alt) > limits.attachmentAltMaxLength) {
        fail(`attachments[${index}].alt must be at most ${limits.attachmentAltMaxLength} code points`, `attachments[${index}].alt`);
      }
      const max = limits.attachmentNameMaxLength;
      if (a.name !== null && (frozenTrim(a.name) === "" || codePointLen(a.name) > max)) {
        fail(`attachments[${index}].name must be 1..=${max} code points and not blank`, `attachments[${index}].name`);
      }
    });
    if (value.kind === "collection") return checkCollection(value);
    if (value.kind === "article") return checkArticle(value);
    if (frozenTrim(value.content) === "" && value.embed === null && value.attachments.length === 0) {
      fail("Post must have content, an embed, or attachments", "content");
    }
    if (codePointLen(value.content) > limits.postNoteContentMaxLength) {
      fail(`content must be at most ${limits.postNoteContentMaxLength} code points for kind ${value.kind}`, "content");
    }
  },
};

export interface Minted {
  id: string;
  editId: string;
  path: string;
  value: Post;
  body: string;
}

// Where one version goes, after every rule a stored version has to pass
function mint(value: Post, id: string, editId: string, root: Root, owner: string, slug: string | null): Minted {
  if (slug !== null && !isSlug(slug)) fail(`slug must be 1..=${limits.postSlugMaxLength} chars of a-z, 0-9 and -: ${slug}`, "slug");
  const publicRoot = root === "public";
  const body = validate(post, value, id, publicRoot);
  // The editId is a TimestampId too, so the validity bound applies to it
  checkTimestampId(editId);
  // The ownership rule, which the plain rules have no author for
  checkReferences(value, publicRoot, owner);
  return { id, editId, path: socialPath(root, `posts/${id}/${editId}${slug === null ? "" : `-${slug}`}.json`), value, body };
}

/** A new post: the id is minted first, so a refused post still moves the mint. */
function create(value: Post, root: Root, owner: string, slug: string | null): Minted {
  const id = timestampId(mintFrom(nowMicros()));
  return mint(value, id, id, root, owner, slug);
}

// How far above a head a salted successor may land
const SPREAD = 60_000_000n;

/**
 * An edit of post `id`: an editId strictly above `head`. When the clock is not past the head,
 * as when a faster clock made it, the bytes being written pick the distance, so only identical
 * edits share a path.
 */
export function editPost(owner: string, value: Post, id: string, head: string, root: Root, slug: string | null): Minted {
  timestampIdMicros(id);
  if (compareBytes(head, id) < 0) fail(`head ${head} is older than the post id ${id}`);
  const hasher = blake3.create();
  hasher.update(utf8(head));
  hasher.update(utf8(post.codec.write(value)));
  const salt = new DataView(hasher.digest().buffer).getBigUint64(0, true);
  const floor = checkTimestampId(head);
  const now = nowMicros();
  let minted: bigint;
  if (now > floor) minted = mintFrom(now);
  else {
    const room = now + MAX_FUTURE - floor - 1n;
    if (room <= 0n) fail("the current version leaves no room for a newer id");
    // Past the guard: the salt tells successors apart, and a guard moved ahead of the clock
    // would make the next new post read the clock as corrected and reuse an id
    minted = floor + 1n + (salt % (room < SPREAD ? room : SPREAD));
  }
  return mint(value, id, timestampId(minted), root, owner, slug);
}

const maybe = option(string);
const placement = (i: Record<string, unknown>): { root: Root; slug: string | null } => {
  if (i.root !== undefined && i.root !== null && i.root !== "public" && i.root !== "private") misuse("input.root", '"public" or "private"');
  return { root: (i.root as Root | null | undefined) ?? "public", slug: maybe.parse(i.slug, "input.slug") };
};
const attachments = option(list({ ...attachment, parse: (js: unknown, at: string): Attachment => {
  const a = inputOf(js, at, ["uri", "alt", "name"]);
  const name = maybe.parse(a.name, `${at}.name`);
  return { uri: string.parse(a.uri, `${at}.uri`), alt: maybe.parse(a.alt, `${at}.alt`), name: name === null ? null : frozenTrim(name), extra: new Map() };
} }));
const items = option(list({ ...item, parse: (js: unknown, at: string): CollectionItem => {
  const entry = inputOf(js, at, ["uri", "note"]);
  return { uri: string.parse(entry.uri, `${at}.uri`), note: trimmedOrNull(maybe.parse(entry.note, `${at}.note`)), extra: new Map() };
} }));

/** A new post. The builder trims the display text and writes the envelope of a typed kind. */
export function buildPost(owner: string, input: unknown): Minted {
  checkPublicKey(owner);
  const kind = typeof input === "object" && input !== null && Object.hasOwn(input, "kind") ? (input as { kind: unknown }).kind : undefined;
  const extra = new Map<string, Json>();
  if (kind === "article") {
    const i = inputOf(input, "input", ["kind", "title", "body", "cover_image", "parent", "embed", "attachments", "lock", "root", "slug"]);
    const content = article.write({
      title: frozenTrim(string.parse(i.title, "input.title")),
      body: string.parse(i.body, "input.body"),
      cover_image: maybe.parse(i.cover_image, "input.cover_image"),
      extra,
    });
    const value: Post = {
      content,
      kind,
      parent: maybe.parse(i.parent, "input.parent"),
      embed: maybe.parse(i.embed, "input.embed"),
      attachments: attachments.parse(i.attachments, "input.attachments") ?? [],
      lock: maybe.parse(i.lock, "input.lock"),
      extra,
    };
    const { root, slug } = placement(i);
    return create(value, root, owner, slug);
  }
  if (kind === "collection") {
    const i = inputOf(input, "input", ["kind", "name", "description", "items", "cover_image", "layout", "root", "slug"]);
    const name = frozenTrim(string.parse(i.name, "input.name"));
    const description = trimmedOrNull(maybe.parse(i.description, "input.description"));
    const entries = items.parse(i.items, "input.items") ?? [];
    const cover = maybe.parse(i.cover_image, "input.cover_image");
    const layout: CollectionLayout | null = i.layout === null || i.layout === undefined ? null : known(collectionLayouts, "collection layout", i.layout, "layout");
    const content = collection.write({ name, description, items: entries, cover_image: cover, layout, extra });
    const value: Post = { content, kind, parent: null, embed: null, attachments: [], lock: null, extra };
    const { root, slug } = placement(i);
    return create(value, root, owner, slug);
  }
  const i = inputOf(input, "input", ["kind", "content", "parent", "embed", "attachments", "lock", "root", "slug"]);
  const content = frozenTrim(string.parse(i.content, "input.content"));
  const value: Post = {
    content,
    kind: i.kind === null || i.kind === undefined ? "note" : known(postKinds, "content kind", i.kind, "kind"),
    parent: maybe.parse(i.parent, "input.parent"),
    embed: maybe.parse(i.embed, "input.embed"),
    attachments: attachments.parse(i.attachments, "input.attachments") ?? [],
    lock: maybe.parse(i.lock, "input.lock"),
    extra,
  };
  const { root, slug } = placement(i);
  return create(value, root, owner, slug);
}
