// Posts: one envelope for every kind, a version per edit, and references that obey the root
// the version is stored under.

import { blake3 } from "@noble/hashes/blake3.js";
import { checkReference } from "../canonicalize.js";
import { mintFrom, nowMicros } from "../clock.js";
import { limits } from "../data.js";
import { type Each, fail, member, throwing, ValidationError } from "../errors.js";
import { checkPublicKey, timestampId, timestampIdMicros } from "../ids.js";
import { type Json, JsonError, readJson } from "../json/read.js";
import { defaulted, type Extra, inputOf, list, object, omitted, option, rootOf, string } from "../json/schema.js";
import { codePointLen, compareBytes, frozenTrim, trimmedOrNull, utf8 } from "../text.js";
import { isSlug, type OwnerPath, type Root, socialPath } from "../path.js";
import { checkExtra, inputReads, type Model, parse, validate } from "./common.js";
import { collectionLayout, type CollectionLayout, collectionLayouts, isKnown, known, postKind, type PostKind, postKinds } from "./kinds.js";

export interface Attachment extends Extra {
  /** The media: a canonical `pubky`, `http` or `https` URI of at most 1024 code points, under the post's root rules. */
  uri: string;
  /** Text describing the media for a screen reader: at most 1000 code points; null for none. */
  alt: string | null;
  /** The file name shown, trimmed by the builder: 1 to 255 code points, not blank; null for none. */
  name: string | null;
}

export interface Post extends Extra {
  /** Text for an untyped kind; for an article or a collection, the envelope `decodeContent` reads. */
  content: string;
  /** What the post is, one of `postKinds`; it decides what `content` holds. */
  kind: PostKind;
  /** The post this one replies to: a versionless reference of at most 1024 code points; null for none. */
  parent: string | null;
  /** The post or URI this one quotes: a versionless reference of at most 1024 code points; null for none. */
  embed: string | null;
  /** At most 10 media references; empty for none. A collection carries none: its items are in its envelope. */
  attachments: Attachment[];
  /** A pubky reference to what gates the post (a payment or a membership), at most 1024 code points; null for none. Readers that do not honour it show the post as it is. */
  lock: string | null;
}

export interface ArticleContent extends Extra {
  /** The title, trimmed by the builder: 1 to 100 code points, not blank, no control character but tab, newline and carriage return. */
  title: string;
  /** The text, Markdown by convention: at most 50000 code points, no control character but tab, newline and carriage return. */
  body: string;
  /** A canonical `pubky`, `http` or `https` URI of an image, at most 300 code points; null for none. */
  cover_image: string | null;
}

export interface CollectionItem extends Extra {
  /** What is curated: a versionless reference of any scheme (a pubky URL, a web URL or another scheme), at most 1024 code points. */
  uri: string;
  /** The curator's note, trimmed by the builder: 1 to 1000 code points, not blank; null for none. */
  note: string | null;
}

export interface CollectionContent extends Extra {
  /** The collection's name, trimmed by the builder: 1 to 100 code points, not blank. */
  name: string;
  /** What it gathers, trimmed by the builder: at most 500 code points, not blank; null for none. */
  description: string | null;
  /** At most 100 items, in the curator's order; empty for none. */
  items: CollectionItem[];
  /** A canonical `pubky`, `http` or `https` URI of an image, at most 300 code points; null for none. */
  cover_image: string | null;
  /** How the creator would show it, one of `collectionLayouts`, or a newer writer's name kept as written; null for the reader's choice. */
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
export function checkTimestampId(id: string, field = "id"): bigint {
  const micros = timestampIdMicros(id, field);
  if (micros < MIN_MICROS) fail("id", "Invalid ID, timestamp must be on or after October 1st, 2024", field);
  if (micros > nowMicros() + MAX_FUTURE) fail("id", "Invalid ID, timestamp is too far in the future", field);
  return micros;
}

/** The version a path names: a TimestampId of its own, never older than the post. */
export function checkVersion(id: string, editId: string): void {
  checkTimestampId(editId, "editId");
  if (compareBytes(editId, id) < 0) fail("id", `version ${editId} is older than the post id ${id}`, "editId");
}

/** Every reference of a post through the one gate. With an owner the ownership rule runs too. */
export function checkReferences(value: Post, publicRoot: boolean, owner: string | null, each: Each = throwing): void {
  const max = limits.referenceUriMaxLength;
  const { parent, embed, lock } = value;
  if (parent !== null) each(() => checkReference("parent", parent, "", max, publicRoot, owner));
  if (embed !== null) each(() => checkReference("embed", embed, "", max, publicRoot, owner));
  if (lock !== null) each(() => checkReference("lock", lock, "pubky", max, publicRoot, owner));
  value.attachments.forEach((a, index) => each(() => checkReference(`attachments[${index}].uri`, a.uri, "pubky or web", max, publicRoot, owner)));
  const { cover, items } = envelopeRefs(value);
  if (cover !== null) each(() => checkReference("cover_image", cover, "pubky or web", limits.imageUrlMaxLength, publicRoot, owner));
  items.forEach((uri, index) => each(() => checkReference(`items[${index}].uri`, uri, "", max, publicRoot, owner)));
}

/** What the envelope of an article or a collection reads as: its cover, and the envelope or why it does not parse. */
interface Envelope {
  kind: string;
  content: string;
  cover: string | null;
  parsed: ArticleContent | CollectionContent | ValidationError;
}

const ENVELOPE_PREFIX = { article: "Article content must be a valid JSON envelope: ", collection: "Collection content must be a valid JSON envelope: " } as const;

// One read per post: the references, the caps and the kind's own rules all look at it
const envelopes = new WeakMap<Post, Envelope>();

function envelopeOf(value: Post): Envelope | null {
  const { kind, content } = value;
  if (kind !== "article" && kind !== "collection") return null;
  const known = envelopes.get(value);
  if (known !== undefined && known.kind === kind && known.content === content) return known;
  // The cover is read from any object, so a cover beside a member of the wrong type still counts
  let json: Json | undefined;
  try {
    json = readJson(content);
  } catch (e) {
    if (!(e instanceof JsonError)) throw e;
  }
  const member = json instanceof Map ? json.get("cover_image") : undefined;
  let parsed: Envelope["parsed"];
  try {
    parsed = kind === "article" ? parse(article, content, ENVELOPE_PREFIX.article, "content") : parse(collection, content, ENVELOPE_PREFIX.collection, "content");
  } catch (e) {
    if (!(e instanceof ValidationError)) throw e;
    parsed = e;
  }
  const envelope = { kind, content, cover: typeof member === "string" ? member : null, parsed };
  envelopes.set(value, envelope);
  return envelope;
}

/** The envelope of an article or a collection as its kind reads it, or the refusal. */
function strictEnvelope<K extends "article" | "collection">(value: Post & { kind: K }): K extends "article" ? ArticleContent : CollectionContent {
  const { parsed } = envelopeOf(value) as Envelope;
  if (parsed instanceof ValidationError) throw parsed;
  return parsed as K extends "article" ? ArticleContent : CollectionContent;
}

/**
 * The references inside the envelope of an article or a collection: its cover, and a
 * collection's item URIs. Content that does not parse references nothing here; its own rule
 * refuses it after.
 */
export function envelopeRefs(value: Post): { cover: string | null; items: string[] } {
  const envelope = envelopeOf(value);
  if (envelope === null) return { cover: null, items: [] };
  const items = value.kind === "collection" && !(envelope.parsed instanceof ValidationError) ? (envelope.parsed as CollectionContent).items.map((entry) => entry.uri) : [];
  return { cover: envelope.cover, items };
}

/**
 * The content of an article or a collection with `cover` as its cover, written as the kind
 * writes it so only the cover changes; null when the content does not parse as that envelope.
 */
export function withCover(value: Post, cover: string): string | null {
  const envelope = envelopeOf(value);
  if (envelope === null || envelope.parsed instanceof ValidationError) return null;
  return value.kind === "article" ? article.write({ ...(envelope.parsed as ArticleContent), cover_image: cover }) : collection.write({ ...(envelope.parsed as CollectionContent), cover_image: cover });
}

const OTHER_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const hasOtherControl = (s: string) => OTHER_CONTROL.test(s);
function checkArticle(post: Post, each: Each): void {
  each(() => {
    if (codePointLen(post.content) > limits.articleContentMaxLength)
      fail("length", `Article content must be at most ${limits.articleContentMaxLength} code points`, "content", limits.articleContentMaxLength);
  });
  // The rules below read the envelope, so they run only once it parsed
  each(() => {
    const envelope = strictEnvelope(post as Post & { kind: "article" });
    each(() => checkExtra(envelope.extra));
    // Other controls escape to six characters and would break the bound on the content
    each(() => {
      if (hasOtherControl(envelope.title) || hasOtherControl(envelope.body)) {
        fail("format", "Article text must not contain control characters other than tab, newline and carriage return", hasOtherControl(envelope.title) ? "title" : "body");
      }
    });
    each(() => {
      if (frozenTrim(envelope.title) === "") fail("blank", "Article title must contain non-whitespace characters", "title");
      if (codePointLen(envelope.title) > limits.articleTitleMaxLength)
        fail("length", `Article title must be at most ${limits.articleTitleMaxLength} code points`, "title", limits.articleTitleMaxLength);
    });
    each(() => {
      if (codePointLen(envelope.body) > limits.articleBodyMaxLength) fail("length", `Article body must be at most ${limits.articleBodyMaxLength} code points`, "body", limits.articleBodyMaxLength);
    });
  });
}

function checkCollection(post: Post, each: Each): void {
  each(() => {
    if (post.parent !== null || post.embed !== null) fail("conflict", "Collection posts cannot have parent or embed", post.parent !== null ? "parent" : "embed");
  });
  each(() => {
    if (post.attachments.length > 0) fail("conflict", "Collection posts must not use post.attachments; items belong in the content envelope", "attachments");
  });
  each(() => {
    if (codePointLen(post.content) > limits.collectionContentMaxLength)
      fail("length", `Collection content exceeds max length ${limits.collectionContentMaxLength}`, "content", limits.collectionContentMaxLength);
  });
  // The rules below read the envelope, so they run only once it parsed
  each(() => {
    const envelope = strictEnvelope(post as Post & { kind: "collection" });
    each(() => checkExtra(envelope.extra));
    each(() => {
      if (frozenTrim(envelope.name) === "") fail("blank", "Collection name must contain non-whitespace characters", "name");
      const length = codePointLen(envelope.name);
      if (length < limits.collectionNameMinLength || length > limits.collectionNameMaxLength) {
        fail(
          "length",
          `Collection name must be ${limits.collectionNameMinLength} to ${limits.collectionNameMaxLength} characters`,
          "name",
          length < limits.collectionNameMinLength ? limits.collectionNameMinLength : limits.collectionNameMaxLength,
        );
      }
    });
    each(() => {
      if (envelope.description === null) return;
      if (frozenTrim(envelope.description) === "") fail("blank", "Collection description must not be blank", "description");
      if (codePointLen(envelope.description) > limits.collectionDescriptionMaxLength)
        fail("length", `Collection description exceeds ${limits.collectionDescriptionMaxLength} characters`, "description", limits.collectionDescriptionMaxLength);
    });
    envelope.items.forEach((entry, index) => {
      each(() => checkExtra(entry.extra, `items[${index}].`));
      each(() => {
        const max = limits.collectionItemNoteMaxLength;
        if (entry.note !== null && (frozenTrim(entry.note) === "" || codePointLen(entry.note) > max)) {
          fail("length", `items[${index}].note must be 1 to ${max} code points and not blank`, `items[${index}].note`, max);
        }
      });
    });
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
  check(value, id, publicRoot, each) {
    if (id !== null) each(() => void checkTimestampId(id));
    each(() => checkExtra(value.extra));
    // A kind a newer writer used defines what the post is, so this version refuses it
    each(() => {
      if (!isKnown(postKinds, value.kind)) fail("unknown_name", "post kind is unknown", "kind");
    });
    // A list is bounded before any of its items is read
    each(() => {
      if (value.attachments.length > limits.postAttachmentsMaxCount) fail("count", `Too many attachments (max: ${limits.postAttachmentsMaxCount})`, "attachments", limits.postAttachmentsMaxCount);
    });
    each(() => {
      if (envelopeRefs(value).items.length > limits.collectionItemsMaxCount)
        fail("count", `Collection cannot have more than ${limits.collectionItemsMaxCount} items`, "items", limits.collectionItemsMaxCount);
    });
    checkReferences(value, publicRoot, null, each);
    value.attachments.forEach((a, index) => {
      each(() => checkExtra(a.extra, `attachments[${index}].`));
      each(() => {
        if (a.alt !== null && codePointLen(a.alt) > limits.attachmentAltMaxLength) {
          fail("length", `attachments[${index}].alt must be at most ${limits.attachmentAltMaxLength} code points`, `attachments[${index}].alt`, limits.attachmentAltMaxLength);
        }
      });
      each(() => {
        const max = limits.attachmentNameMaxLength;
        if (a.name !== null && (frozenTrim(a.name) === "" || codePointLen(a.name) > max)) {
          fail("length", `attachments[${index}].name must be 1 to ${max} code points and not blank`, `attachments[${index}].name`, max);
        }
      });
    });
    if (value.kind === "collection") {
      checkCollection(value, each);
      return;
    }
    if (value.kind === "article") {
      checkArticle(value, each);
      return;
    }
    each(() => {
      if (frozenTrim(value.content) === "" && value.embed === null && value.attachments.length === 0) {
        fail("blank", "Post must have content, an embed, or attachments", "content");
      }
    });
    each(() => {
      if (codePointLen(value.content) > limits.postNoteContentMaxLength) {
        fail("length", `content must be at most ${limits.postNoteContentMaxLength} code points for kind ${value.kind}`, "content", limits.postNoteContentMaxLength);
      }
    });
  },
};

export interface Minted {
  id: string;
  editId: string;
  path: OwnerPath;
  value: Post;
  body: string;
}

// Where one version goes, after every rule a stored version has to pass
function mint(value: Post, id: string, editId: string, root: Root, owner: string | null, slug: string | null, each: Each = throwing): Minted {
  each(() => {
    if (slug !== null && !isSlug(slug)) fail("format", `slug must be 1 to ${limits.postSlugMaxLength} chars of a-z, 0-9 and -: ${slug}`, "slug");
  });
  const publicRoot = root === "public";
  const body = validate(post, value, id, publicRoot, each);
  // The editId is a TimestampId too, so the validity bound applies to it
  each(() => void checkTimestampId(editId, "editId"));
  // The ownership rule, which the plain rules have no author for
  if (owner !== null) checkReferences(value, publicRoot, owner, each);
  return { id, editId, path: socialPath(root, `posts/${id}/${editId}${slug === null ? "" : `-${slug}`}.json`), value, body };
}

/** The id of a new post: minted, so a refused post still moves the mint. */
const minted = (): string => timestampId(mintFrom(nowMicros()));

/** The id a validator checks a new post under: the clock's, which leaves the mint alone. */
export const unminted = (): string => timestampId(nowMicros());

// How far above a head a salted successor may land
const SPREAD = 60_000_000n;

/**
 * An edit of post `id`: an editId strictly above `head`. When the clock is not past the head,
 * as when a faster clock made it, the bytes being written pick the distance, so only identical
 * edits share a path.
 */
export function editPost(owner: string, value: Post, id: string, head: string, root: Root, slug: string | null): Minted {
  timestampIdMicros(id);
  if (compareBytes(head, id) < 0) fail("id", `head ${head} is older than the post id ${id}`, "head");
  const hasher = blake3.create();
  hasher.update(utf8(head));
  hasher.update(utf8(post.codec.write(value)));
  const digest = hasher.digest();
  const salt = new DataView(digest.buffer, digest.byteOffset, digest.byteLength).getBigUint64(0, true);
  const floor = checkTimestampId(head);
  const now = nowMicros();
  let minted: bigint;
  if (now > floor) minted = mintFrom(now);
  else {
    // A narrower spread than the whole would let two different edits share a path
    if (now + MAX_FUTURE - floor - 1n < SPREAD) fail("id", "the current version leaves no room for a newer id", "head");
    // Past the guard: the salt tells successors apart, and a guard moved ahead of the clock
    // would make the next new post read the clock as corrected and reuse an id
    minted = floor + 1n + (salt % SPREAD);
  }
  return mint(value, id, timestampId(minted), root, owner, slug);
}

/**
 * A new post. The builder trims the display text and writes the envelope of a typed kind. A
 * validator passes a collecting `each`, `unminted` and, when it has one, the owner.
 */
export function buildPost(owner: string | null, input: unknown, each: Each = throwing, newId: () => string = minted): Minted {
  if (owner !== null) checkPublicKey(owner);
  const { str, opt, items } = inputReads(each);
  const placement = (i: Record<string, unknown>): { root: Root; slug: string | null } => ({ root: member<Root>(each, () => rootOf(i.root, "input.root"), "public"), slug: opt(i.slug, "input.slug") });
  // What a post that can reply, quote and carry media takes, in the order a builder reads it
  const threaded = (i: Record<string, unknown>): Pick<Post, "parent" | "embed" | "attachments" | "lock"> => ({
    parent: opt(i.parent, "input.parent"),
    embed: opt(i.embed, "input.embed"),
    attachments:
      items(i.attachments, "input.attachments", (js, at): Attachment => {
        const a = inputOf(js, at, ["uri", "alt", "name"], each);
        const name = opt(a.name, `${at}.name`);
        return { uri: str(a.uri, `${at}.uri`), alt: opt(a.alt, `${at}.alt`), name: name === null ? null : frozenTrim(name), extra: new Map() };
      }) ?? [],
    lock: opt(i.lock, "input.lock"),
  });
  const create = (value: Post, root: Root, slug: string | null): Minted => {
    const id = newId();
    return mint(value, id, id, root, owner, slug, each);
  };

  const kind = typeof input === "object" && input !== null && Object.hasOwn(input, "kind") ? (input as { kind: unknown }).kind : undefined;
  if (kind === "article") {
    const i = inputOf(input, "input", ["kind", "title", "body", "cover_image", "parent", "embed", "attachments", "lock", "root", "slug"], each);
    const content = article.write({
      title: frozenTrim(str(i.title, "input.title")),
      body: str(i.body, "input.body"),
      cover_image: opt(i.cover_image, "input.cover_image"),
      extra: new Map(),
    });
    const thread = threaded(i);
    const { root, slug } = placement(i);
    return create({ content, kind, ...thread, extra: new Map() }, root, slug);
  }
  if (kind === "collection") {
    const i = inputOf(input, "input", ["kind", "name", "description", "items", "cover_image", "layout", "root", "slug"], each);
    const name = frozenTrim(str(i.name, "input.name"));
    const description = trimmedOrNull(opt(i.description, "input.description"));
    const entries =
      items(i.items, "input.items", (js, at): CollectionItem => {
        const entry = inputOf(js, at, ["uri", "note"], each);
        return { uri: str(entry.uri, `${at}.uri`), note: trimmedOrNull(opt(entry.note, `${at}.note`)), extra: new Map() };
      }) ?? [];
    const cover = opt(i.cover_image, "input.cover_image");
    // Every member's shape before the layout's name is judged: the reference reads the whole input first
    const layoutName = opt(i.layout, "input.layout");
    const { root, slug } = placement(i);
    const layout = layoutName === null ? null : member<CollectionLayout | null>(each, () => known(collectionLayouts, "collection layout", layoutName, "layout"), null);
    const content = collection.write({ name, description, items: entries, cover_image: cover, layout, extra: new Map() });
    return create({ content, kind, parent: null, embed: null, attachments: [], lock: null, extra: new Map() }, root, slug);
  }
  const i = inputOf(input, "input", ["kind", "content", "parent", "embed", "attachments", "lock", "root", "slug"], each);
  const content = frozenTrim(str(i.content, "input.content"));
  const kindName = opt(i.kind, "input.kind");
  const thread = threaded(i);
  const { root, slug } = placement(i);
  // The kind's name is judged once every member's shape was read, as the reference reads the whole input first
  const typed = kindName === null ? "note" : member<PostKind>(each, () => known(postKinds, "content kind", kindName, "kind"), "note");
  return create({ content, kind: typed, ...thread, extra: new Map() }, root, slug);
}
