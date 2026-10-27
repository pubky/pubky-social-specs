// Posts: one envelope for every kind, a version per edit, and references that obey the root
// the version is stored under.

import { blake3 } from "@noble/hashes/blake3.js";
import { canonicalPubky, checkReference } from "../canonicalize.js";
import { mintFrom, nowMicros } from "../clock.js";
import { limits } from "../data.js";
import { type Each, fail, member, throwing, ValidationError } from "../errors.js";
import { checkPublicKey, timestampId, timestampIdMicros } from "../ids.js";
import { type Json, JsonError, readJson } from "../json/read.js";
import { type Codec, defaulted, type Extra, inputOf, inputReads, list, object, omitted, option, rootOf, string } from "../json/schema.js";
import { codePointLen, compareBytes, frozenTrim, trimmedOrNull, utf8, utf8Len } from "../text.js";
import { isSlug, type OwnerPath, parsePath, type Root, socialPath, splitPubky } from "../path.js";
import { checkExtra, checkSize, type Model, parse, validate } from "./common.js";
import * as events from "./events.js";
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

/** Every reference of a post through the one gate. With an owner the ownership rule and the kinds' owner rules run too. */
export function checkReferences(value: Post, publicRoot: boolean, owner: string | null, each: Each = throwing): void {
  const max = limits.referenceUriMaxLength;
  const { parent, embed, lock } = value;
  if (parent !== null) each(() => checkReference("parent", parent, "", max, publicRoot, owner));
  if (embed !== null) each(() => checkReference("embed", embed, "", max, publicRoot, owner));
  if (lock !== null) each(() => checkReference("lock", lock, "pubky", max, publicRoot, owner));
  value.attachments.forEach((a, index) => each(() => checkReference(`attachments[${index}].uri`, a.uri, "pubky or web", max, publicRoot, owner)));
  for (const ref of contentRefs(value)) each(() => checkReference(ref.field, ref.uri, ref.schemes, ref.max, publicRoot, owner));
  if (owner !== null) {
    const envelope = typedEnvelope(value);
    if (envelope?.kind === "event") events.checkEventOwner(envelope.parsed, owner, each);
  }
}

/** The kinds whose `content` is an envelope, each with its codec and how a refusal of it opens. */
const ENVELOPES = {
  article: { codec: article, prefix: "Article content must be a valid JSON envelope: " },
  collection: { codec: collection, prefix: "Collection content must be a valid JSON envelope: " },
  event: { codec: events.event, prefix: "Event content must be a valid JSON envelope: " },
  rsvp: { codec: events.rsvp, prefix: "Rsvp content must be a valid JSON envelope: " },
  availability: { codec: events.availability, prefix: "Availability content must be a valid JSON envelope: " },
  rating: { codec: events.rating, prefix: "Rating content must be a valid JSON envelope: " },
} as const;

type EnvelopeKind = keyof typeof ENVELOPES;
/** The envelope of each typed kind, as its codec reads it. */
export type Envelopes = {
  article: ArticleContent;
  collection: CollectionContent;
  event: events.EventContent;
  rsvp: events.RsvpContent;
  availability: events.AvailabilityContent;
  rating: events.RatingContent;
};
const isEnvelopeKind = (kind: string): kind is EnvelopeKind => Object.hasOwn(ENVELOPES, kind);

/** The codec of a typed kind's envelope, for the entry's content functions. */
export const envelopeCodec = <K extends EnvelopeKind>(kind: K): Codec<Envelopes[K]> => ENVELOPES[kind].codec as Codec<Envelopes[K]>;
export const envelopePrefix = (kind: EnvelopeKind): string => ENVELOPES[kind].prefix;
export { isEnvelopeKind };

/** The raw content cap of each 1.1 kind and how its refusal names the kind. The 1.0 kinds keep the order 1.0 shipped. */
const CONTENT_CAPS = {
  event: ["Event", limits.eventContentMaxLength],
  rsvp: ["Rsvp", limits.rsvpContentMaxLength],
  availability: ["Availability", limits.availabilityContentMaxLength],
  rating: ["Rating", limits.ratingContentMaxLength],
} as const;

/** The refusal of a 1.1 kind's content over its raw cap, checked on the string before it is parsed; null within it. */
/** Whether `kind` is a 1.1 kind, whose caps run before its references at the planner too; a 1.0 kind keeps the order 1.0 shipped. */
export const hasEarlyBounds = (kind: string): boolean => Object.hasOwn(CONTENT_CAPS, kind);

function contentCapRefusal(value: Post): ValidationError | null {
  const { kind, content } = value;
  if (!Object.hasOwn(CONTENT_CAPS, kind)) return null;
  const [name, cap] = CONTENT_CAPS[kind as keyof typeof CONTENT_CAPS];
  return codePointLen(content) > cap ? new ValidationError("length", `${name} content must be at most ${cap} code points`, "content", cap) : null;
}

function checkContentCap(value: Post): void {
  const refusal = contentCapRefusal(value);
  if (refusal !== null) throw refusal;
}

/** What the envelope of a typed kind reads as: its cover, and the envelope or why it does not parse. */
interface Envelope {
  kind: string;
  content: string;
  cover: string | null;
  parsed: Envelopes[EnvelopeKind] | ValidationError;
}

// One read per post: the references, the caps and the kind's own rules all look at it
const envelopes = new WeakMap<Post, Envelope>();

function envelopeOf(value: Post): Envelope | null {
  const { kind, content } = value;
  if (!isEnvelopeKind(kind)) return null;
  const cached = envelopes.get(value);
  if (cached !== undefined && cached.kind === kind && cached.content === content) return cached;
  // An article's or a collection's cover is read from any object, so a cover beside a member of
  // the wrong type still counts
  let cover: Json | undefined;
  if (kind === "article" || kind === "collection") {
    try {
      const json = readJson(content);
      cover = json instanceof Map ? json.get("cover_image") : undefined;
    } catch (e) {
      if (!(e instanceof JsonError)) throw e;
    }
  }
  // Content over its kind's raw cap is never parsed: the cap is its refusal
  let parsed: Envelope["parsed"] | null = contentCapRefusal(value);
  try {
    parsed ??= parse(ENVELOPES[kind].codec as Codec<Envelopes[EnvelopeKind]>, content, ENVELOPES[kind].prefix, "content");
  } catch (e) {
    if (!(e instanceof ValidationError)) throw e;
    parsed = e;
  }
  const envelope = { kind, content, cover: typeof cover === "string" ? cover : null, parsed };
  envelopes.set(value, envelope);
  return envelope;
}

type Typed = { [K in EnvelopeKind]: { kind: K; parsed: Envelopes[K] } }[EnvelopeKind];

/** The envelope of a typed kind when it parsed, with its kind; null for an untyped kind or one that did not parse. */
function typedEnvelope(value: Post): Typed | null {
  const envelope = envelopeOf(value);
  if (envelope === null || envelope.parsed instanceof ValidationError) return null;
  return { kind: envelope.kind, parsed: envelope.parsed } as Typed;
}

/** The envelope of a typed kind as its kind reads it, or the refusal. */
function strictEnvelope(value: Post): Envelopes[EnvelopeKind] {
  const { parsed } = envelopeOf(value) as Envelope;
  if (parsed instanceof ValidationError) throw parsed;
  return parsed;
}

/**
 * The references inside the envelope of an article or a collection: its cover, and a
 * collection's item URIs. Content that does not parse references nothing here; its own rule
 * refuses it after. The lifecycle planners read these two positions by name.
 */
export function envelopeRefs(value: Post): { cover: string | null; items: string[] } {
  const envelope = envelopeOf(value);
  if (envelope === null) return { cover: null, items: [] };
  const items = value.kind === "collection" && !(envelope.parsed instanceof ValidationError) ? (envelope.parsed as CollectionContent).items.map((entry) => entry.uri) : [];
  return { cover: envelope.cover, items };
}

/**
 * Every reference position inside the envelope, in the reference's order, as the gate takes
 * them: an article's or a collection's cover and items, an event's locations, links and master,
 * an availability's `for`. Content that does not parse references nothing.
 */
export function contentRefs(value: Post): events.ContentRef[] {
  const typed = typedEnvelope(value);
  const { cover, items } = envelopeRefs(value);
  const refs: events.ContentRef[] = [];
  if (cover !== null) refs.push({ field: "cover_image", uri: cover, schemes: "pubky or web", max: limits.imageUrlMaxLength });
  items.forEach((uri, index) => refs.push({ field: `items[${index}].uri`, uri, schemes: "", max: limits.referenceUriMaxLength }));
  if (typed === null) return refs;
  // One at a time, never spread into an argument list: a list is as long as the caller made it
  const inner = typed.kind === "event" ? events.eventRefs(typed.parsed) : typed.kind === "availability" ? events.availabilityRefs(typed.parsed) : [];
  for (const ref of inner) refs.push(ref);
  return refs;
}

/** The non-media references of a version: parent, embed, lock, and every envelope position but the cover. */
export function otherRefs(value: Post): string[] {
  return [value.parent, value.embed, value.lock]
    .filter((uri): uri is string => uri !== null)
    .concat(
      contentRefs(value)
        .filter((ref) => ref.field !== "cover_image")
        .map((ref) => ref.uri),
    );
}

/**
 * The content of an article or a collection with `cover` as its cover, written as the kind
 * writes it so only the cover changes; null when the content does not parse as that envelope.
 */
export function withCover(value: Post, cover: string): string | null {
  const parsed = envelopeOf(value)?.parsed;
  if (parsed === undefined || parsed instanceof ValidationError) return null;
  return value.kind === "article" ? article.write({ ...(parsed as ArticleContent), cover_image: cover }) : collection.write({ ...(parsed as CollectionContent), cover_image: cover });
}

// An attachment's name or an item's note: absent, or 1 to `max` code points and not blank
function checkShortText(text: string | null, field: string, max: number): void {
  if (text !== null && (frozenTrim(text) === "" || codePointLen(text) > max)) fail("length", `${field} must be 1 to ${max} code points and not blank`, field, max);
}

const OTHER_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

function checkArticle(post: Post, each: Each): void {
  each(() => {
    if (codePointLen(post.content) > limits.articleContentMaxLength)
      fail("length", `Article content must be at most ${limits.articleContentMaxLength} code points`, "content", limits.articleContentMaxLength);
  });
  // The rules below read the envelope, so they run only once it parsed
  each(() => {
    const envelope = strictEnvelope(post) as ArticleContent;
    each(() => checkExtra(envelope.extra));
    // Other controls escape to six characters and would break the bound on the content
    each(() => {
      const field = OTHER_CONTROL.test(envelope.title) ? "title" : OTHER_CONTROL.test(envelope.body) ? "body" : null;
      if (field !== null) fail("format", "Article text must not contain control characters other than tab, newline and carriage return", field);
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
    const envelope = strictEnvelope(post) as CollectionContent;
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
      each(() => checkShortText(entry.note, `items[${index}].note`, limits.collectionItemNoteMaxLength));
    });
  });
}

function checkAttachmentCount(value: Post): void {
  if (value.attachments.length > limits.postAttachmentsMaxCount) fail("count", `Too many attachments (max: ${limits.postAttachmentsMaxCount})`, "attachments", limits.postAttachmentsMaxCount);
}

// The raw content cap of a 1.1 kind, then the lists the gate reads: before any reference is
// read, and the cap before the envelope is parsed
function checkListCaps(value: Post, each: Each): void {
  each(() => checkContentCap(value));
  each(() => {
    if (envelopeRefs(value).items.length > limits.collectionItemsMaxCount)
      fail("count", `Collection cannot have more than ${limits.collectionItemsMaxCount} items`, "items", limits.collectionItemsMaxCount);
  });
  const typed = typedEnvelope(value);
  if (typed?.kind === "event") events.checkEventCounts(typed.parsed, each);
}

/**
 * The bounds a planner checks before it reads a reference of a 1.1 kind: the byte cap on the written form,
 * the attachment count, a 1.1 kind's raw content cap and the list caps. Validation runs the same
 * checks in its own order; a planner reads references before it validates, so it runs these
 * first, and an oversized version is refused before any list inside it is walked.
 */
export function checkBounds(value: Post): void {
  checkSize(utf8Len(post.codec.write(value)), limits.postMaxBytes);
  checkAttachmentCount(value);
  checkListCaps(value, throwing);
}

// A social post, as the gate leaves it: canonical, and a version is the gate's refusal
function isPostReference(uri: string): boolean {
  const split = splitPubky(canonicalPubky(uri) ?? "");
  return split !== null && parsePath(split.path)?.kind === "post";
}

// The envelope rules of the 1.1 kinds: what the envelope may combine with, its cap, then its
// members once it parsed, in the reference's order
function checkTyped(post: Post, kind: "event" | "rsvp" | "availability" | "rating", each: Each): void {
  const [name, cap] = CONTENT_CAPS[kind];
  each(() => {
    switch (kind) {
      case "event":
        if (post.parent !== null || post.embed !== null) fail("conflict", "Event posts cannot have parent or embed", post.parent !== null ? "parent" : "embed");
        break;
      case "rsvp":
        if (post.parent === null) fail("conflict", "Rsvp posts must have a parent, the event they answer", "parent");
        if (!isPostReference(post.parent)) fail("reference", `Rsvp parent must be a social post URI, the Pubky event it answers: ${post.parent}`, "parent");
        if (post.embed !== null || post.attachments.length > 0) fail("conflict", "Rsvp posts cannot have embed or attachments", post.embed !== null ? "embed" : "attachments");
        break;
      case "availability":
        if (post.parent !== null || post.embed !== null || post.attachments.length > 0)
          fail("conflict", "Availability posts cannot have parent, embed or attachments", post.parent !== null ? "parent" : post.embed !== null ? "embed" : "attachments");
        break;
      case "rating":
        if (post.parent === null) fail("conflict", "Rating posts must have a parent, the thing they rate", "parent");
        if (post.embed !== null) fail("conflict", "Rating posts cannot have embed", "embed");
        break;
    }
  });
  each(() => {
    if (codePointLen(post.content) > cap) fail("length", `${name} content must be at most ${cap} code points`, "content", cap);
  });
  // The rules below read the envelope, so they run only once it parsed
  each(() => {
    const envelope = strictEnvelope(post);
    switch (kind) {
      case "event":
        events.checkEvent(envelope as events.EventContent, each);
        break;
      case "rsvp":
        events.checkRsvp(envelope as events.RsvpContent, each);
        break;
      case "availability":
        events.checkAvailability(envelope as events.AvailabilityContent, each);
        break;
      case "rating":
        events.checkRating(envelope as events.RatingContent, each);
        break;
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
  check(value, id, publicRoot, each) {
    if (id !== null) each(() => void checkTimestampId(id));
    each(() => checkExtra(value.extra));
    // A kind a newer writer used defines what the post is, so this version refuses it
    each(() => {
      if (!isKnown(postKinds, value.kind)) fail("unknown_name", "post kind is unknown", "kind");
    });
    // A list is bounded before any of its items is read, and a 1.1 envelope before it is parsed
    each(() => checkAttachmentCount(value));
    checkListCaps(value, each);
    checkReferences(value, publicRoot, null, each);
    value.attachments.forEach((a, index) => {
      each(() => checkExtra(a.extra, `attachments[${index}].`));
      each(() => {
        if (a.alt !== null && codePointLen(a.alt) > limits.attachmentAltMaxLength) {
          fail("length", `attachments[${index}].alt must be at most ${limits.attachmentAltMaxLength} code points`, `attachments[${index}].alt`, limits.attachmentAltMaxLength);
        }
      });
      each(() => checkShortText(a.name, `attachments[${index}].name`, limits.attachmentNameMaxLength));
    });
    if (value.kind === "collection") {
      checkCollection(value, each);
      return;
    }
    if (value.kind === "article") {
      checkArticle(value, each);
      return;
    }
    const { kind } = value;
    if (kind === "event" || kind === "rsvp" || kind === "availability" || kind === "rating") {
      // Known by the test above; the open string type of a stored kind does not narrow by itself
      checkTyped(value, kind as "event" | "rsvp" | "availability" | "rating", each);
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

/** A slug, when given: what a version filename may carry after its editId. */
export function checkSlug(slug: string | null): void {
  if (slug !== null && !isSlug(slug)) fail("format", `slug must be 1 to ${limits.postSlugMaxLength} chars of a-z, 0-9 and -: ${slug}`, "slug");
}

/** Where version `editId` of post `id` is stored under `root`. */
export const versionPath = (root: Root, id: string, editId: string, slug: string | null): OwnerPath => socialPath(root, `posts/${id}/${editId}${slug === null ? "" : `-${slug}`}.json`);

// Where one version goes, after every rule a stored version has to pass
function mint(value: Post, id: string, editId: string, root: Root, owner: string | null, slug: string | null, each: Each = throwing): Minted {
  each(() => checkSlug(slug));
  const publicRoot = root === "public";
  const body = validate(post, value, id, publicRoot, each);
  // The editId is a TimestampId too, so the validity bound applies to it
  each(() => void checkTimestampId(editId, "editId"));
  // The ownership rule, which the plain rules have no author for
  if (owner !== null) checkReferences(value, publicRoot, owner, each);
  return { id, editId, path: versionPath(root, id, editId, slug), value, body };
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
  if (kind === "event") {
    const i = inputOf(input, "input", ["kind", ...events.EVENT_MEMBERS, "attachments", "lock", "root", "slug"], each);
    const envelope = events.eventFromInput(i, each);
    const thread = threaded(i);
    const { root, slug } = placement(i);
    return create({ content: events.event.write(envelope), kind, parent: null, embed: null, attachments: thread.attachments, lock: thread.lock, extra: new Map() }, root, slug);
  }
  if (kind === "rsvp") {
    const i = inputOf(input, "input", ["kind", "parent", "status", "recurrenceId", "guests", "note", "root", "slug"], each);
    const envelope = events.rsvpFromInput(i, each);
    const parent = str(i.parent, "input.parent");
    const { root, slug } = placement(i);
    return create({ content: events.rsvp.write(envelope), kind, parent, embed: null, attachments: [], lock: null, extra: new Map() }, root, slug);
  }
  if (kind === "availability") {
    const i = inputOf(input, "input", ["kind", ...events.AVAILABILITY_MEMBERS, "root", "slug"], each);
    const envelope = events.availabilityFromInput(i, each);
    const { root, slug } = placement(i);
    return create({ content: events.availability.write(envelope), kind, parent: null, embed: null, attachments: [], lock: null, extra: new Map() }, root, slug);
  }
  if (kind === "rating") {
    const i = inputOf(input, "input", ["kind", "parent", "rating", "text", "attachments", "root", "slug"], each);
    const envelope = events.ratingFromInput(i, each);
    const parent = str(i.parent, "input.parent");
    const thread = threaded(i);
    const { root, slug } = placement(i);
    return create({ content: events.rating.write(envelope), kind, parent, embed: null, attachments: thread.attachments, lock: null, extra: new Map() }, root, slug);
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
