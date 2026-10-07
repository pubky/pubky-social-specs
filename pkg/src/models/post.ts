// Posts: one envelope for every kind, a version per edit, and references that obey the root
// the version is stored under.

import { blake3 } from "@noble/hashes/blake3.js";
import { checkReference, type Schemes } from "../canonicalize.js";
import { mintFrom, nowMicros } from "../clock.js";
import { limits } from "../data.js";
import { fail, ValidationError } from "../errors.js";
import { checkPublicKey, timestampId, timestampIdMicros } from "../ids.js";
import { type Json, JsonError, readJson } from "../json/read.js";
import { closed, type Extra, list, open, option, string, variant } from "../json/schema.js";
import { compareKeys } from "../json/write.js";
import { codePointLen, frozenTrim, isAsciiControl } from "../text.js";
import { isSlug, type Root, socialPath } from "../uri.js";
import { checkExtra, type Model, parse, SIZES, validate } from "./common.js";
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

const skipped = { absent: () => null, skipNull: true };
const text = { codec: string };
const maybe = { codec: option(string), ...skipped };

const attachment = open<Attachment>("PubkySocialAttachment", { uri: text, alt: maybe, name: maybe });
const article = open<ArticleContent>("PubkySocialArticleContent", { title: text, body: text, cover_image: maybe });
const item = open<CollectionItem>("PubkySocialCollectionItem", { uri: text, note: maybe });
const collection = open<CollectionContent>("PubkySocialCollectionContent", {
  name: text,
  description: maybe,
  items: { codec: list(item), absent: () => [] },
  cover_image: maybe,
  layout: { codec: option(collectionLayout), ...skipped },
});

const encoder = new TextEncoder();
// 2024-10-01 UTC, before which no id was minted
const MIN_MICROS = 1_727_740_800_000_000n;
// An id may sit this far ahead of the reader's clock and still be valid
const MAX_FUTURE = 7_200_000_000n;
const I64_MAX = 0x7fff_ffff_ffff_ffffn;

/** A TimestampId in its canonical spelling and inside the time bounds. */
export function checkTimestampId(id: string): bigint {
  const micros = timestampIdMicros(id);
  if (micros < MIN_MICROS) fail("Invalid ID, timestamp must be on or after October 1st, 2024");
  const bound = nowMicros() + MAX_FUTURE;
  if (micros > (bound > I64_MAX ? I64_MAX : bound)) fail("Invalid ID, timestamp is too far in the future");
  return micros;
}

interface Reference {
  field: string;
  uri: string;
  schemes: Schemes;
  max: number;
}

// What the content of an article or a collection references. Content that does not parse
// references nothing here; its own rule refuses it after
function contentReferences(post: Post): Reference[] {
  const refs: Reference[] = [];
  if (post.kind !== "article" && post.kind !== "collection") return refs;
  let envelope: Json | undefined;
  try {
    envelope = readJson(post.content);
  } catch (e) {
    if (!(e instanceof JsonError)) throw e;
  }
  const cover = envelope instanceof Map ? envelope.get("cover_image") : undefined;
  if (typeof cover === "string") refs.push({ field: "cover_image", uri: cover, schemes: "pubky or web", max: limits.imageUrlMaxLength });
  if (post.kind === "collection") {
    try {
      parse(collection, post.content).items.forEach((entry, index) => {
        refs.push({ field: `items[${index}].uri`, uri: entry.uri, schemes: "", max: limits.referenceUriMaxLength });
      });
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e;
    }
  }
  return refs;
}

/** Every reference of a post through the one gate. With an owner the ownership rule runs too. */
export function checkReferences(post: Post, publicRoot: boolean, owner: string | null): void {
  const max = limits.referenceUriMaxLength;
  if (post.parent !== null) checkReference("parent", post.parent, "", max, publicRoot, owner);
  if (post.embed !== null) checkReference("embed", post.embed, "", max, publicRoot, owner);
  if (post.lock !== null) checkReference("lock", post.lock, "pubky", max, publicRoot, owner);
  post.attachments.forEach((a, index) => checkReference(`attachments[${index}].uri`, a.uri, "pubky or web", max, publicRoot, owner));
  for (const r of contentReferences(post)) checkReference(r.field, r.uri, r.schemes, r.max, publicRoot, owner);
}

const hasOtherControl = (s: string) => {
  for (let i = 0; i < s.length; i++) {
    const unit = s.charCodeAt(i);
    if (isAsciiControl(unit) && unit !== 0x09 && unit !== 0x0a && unit !== 0x0d) return true;
  }
  return false;
};

function checkArticle(post: Post): void {
  if (codePointLen(post.content) > limits.articleContentMaxLength) fail(`Article content must be at most ${limits.articleContentMaxLength} code points`);
  const envelope = parse(article, post.content, "Article content must be a valid JSON envelope: ");
  checkExtra(envelope.extra);
  // Other controls escape to six characters and would break the bound on the content
  if (hasOtherControl(envelope.title) || hasOtherControl(envelope.body)) {
    fail("Article text must not contain control characters other than tab, newline and carriage return");
  }
  if (frozenTrim(envelope.title) === "") fail("Article title must contain non-whitespace characters");
  if (codePointLen(envelope.title) > limits.articleTitleMaxLength) fail(`Article title must be at most ${limits.articleTitleMaxLength} code points`);
  if (codePointLen(envelope.body) > limits.articleBodyMaxLength) fail(`Article body must be at most ${limits.articleBodyMaxLength} code points`);
}

function checkCollection(post: Post): void {
  if (post.parent !== null || post.embed !== null) fail("Collection posts cannot have parent or embed");
  if (post.attachments.length > 0) fail("Collection posts must not use post.attachments; items belong in the content envelope");
  if (codePointLen(post.content) > limits.collectionContentMaxLength) fail(`Collection content exceeds max length ${limits.collectionContentMaxLength}`);
  const envelope = parse(collection, post.content, "Collection content must be a valid JSON envelope: ");
  checkExtra(envelope.extra);
  if (frozenTrim(envelope.name) === "") fail("Collection name must contain non-whitespace characters");
  const length = codePointLen(envelope.name);
  if (length < limits.collectionNameMinLength || length > limits.collectionNameMaxLength) {
    fail(`Collection name must be ${limits.collectionNameMinLength}..=${limits.collectionNameMaxLength} characters`);
  }
  if (envelope.description !== null) {
    if (frozenTrim(envelope.description) === "") fail("Collection description must not be blank");
    if (codePointLen(envelope.description) > limits.collectionDescriptionMaxLength) fail(`Collection description exceeds ${limits.collectionDescriptionMaxLength} characters`);
  }
  if (envelope.items.length > limits.collectionItemsMaxCount) fail(`Collection cannot have more than ${limits.collectionItemsMaxCount} items`);
  envelope.items.forEach((entry, index) => {
    checkExtra(entry.extra);
    const max = limits.collectionItemNoteMaxLength;
    if (entry.note !== null && (frozenTrim(entry.note) === "" || codePointLen(entry.note) > max)) {
      fail(`items[${index}].note must be 1..=${max} code points and not blank`);
    }
  });
}

export const post: Model<Post> = {
  codec: open<Post>("PostEnvelope", {
    content: text,
    kind: { codec: postKind },
    parent: { codec: option(string) },
    embed: { codec: option(string) },
    attachments: { codec: list(attachment), absent: () => [] },
    lock: maybe,
  }),
  maxBytes: SIZES.post,
  check(value, id, publicRoot) {
    if (id !== null) checkTimestampId(id);
    checkExtra(value.extra);
    // "unknown" is what a newer kind reads as: readable, never valid to write
    if (value.kind === "unknown") fail("post kind is unknown");
    checkReferences(value, publicRoot, null);
    if (value.attachments.length > limits.postAttachmentsMaxCount) fail(`Too many attachments (max: ${limits.postAttachmentsMaxCount})`);
    value.attachments.forEach((a, index) => {
      checkExtra(a.extra);
      if (a.alt !== null && codePointLen(a.alt) > limits.attachmentAltMaxLength) {
        fail(`attachments[${index}].alt must be at most ${limits.attachmentAltMaxLength} code points`);
      }
      const max = limits.attachmentNameMaxLength;
      if (a.name !== null && (frozenTrim(a.name) === "" || codePointLen(a.name) > max)) {
        fail(`attachments[${index}].name must be 1..=${max} code points and not blank`);
      }
    });
    if (value.kind === "collection") return checkCollection(value);
    if (value.kind === "article") return checkArticle(value);
    if (frozenTrim(value.content) === "" && value.embed === null && value.attachments.length === 0) {
      fail("Post must have content, an embed, or attachments");
    }
    if (codePointLen(value.content) > limits.postNoteContentMaxLength) {
      fail(`content must be at most ${limits.postNoteContentMaxLength} code points for kind ${value.kind}`);
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

const versionPath = (root: Root, id: string, editId: string, slug: string | null) =>
  socialPath(root, `posts/${id}/${editId}${slug === null ? "" : `-${slug}`}.json`);

// Where one version goes, after every rule a stored version has to pass
function mint(value: Post, id: string, editId: string, root: Root, owner: string, slug: string | null): Minted {
  if (slug !== null && !isSlug(slug)) fail(`slug must be 1..=${limits.postSlugMaxLength} chars of a-z, 0-9 and -: ${slug}`);
  const publicRoot = root === "public";
  const body = validate(post, value, id, publicRoot);
  // The editId is a TimestampId too, so the validity bound applies to it
  checkTimestampId(editId);
  // The ownership rule, which the plain rules have no author for
  checkReferences(value, publicRoot, owner);
  return { id, editId, path: versionPath(root, id, editId, slug), value, body };
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
  if (compareKeys(head, id) < 0) fail(`head ${head} is older than the post id ${id}`);
  const hasher = blake3.create();
  hasher.update(encoder.encode(head));
  hasher.update(encoder.encode(post.codec.write(value)));
  const salt = new DataView(hasher.digest().buffer).getBigUint64(0, true);
  const floor = checkTimestampId(head);
  const now = nowMicros();
  let minted: bigint;
  if (now > floor) minted = mintFrom(now);
  else {
    const room = now + MAX_FUTURE - floor - 1n;
    if (room <= 0n) fail("the current version leaves no room for a newer id");
    minted = mintFrom(floor + 1n + (salt % (room < SPREAD ? room : SPREAD)));
  }
  return mint(value, id, timestampId(minted), root, owner, slug);
}

const none = { absent: () => null };
const optional = { codec: option(string), ...none };
const rootCodec = { codec: option(variant<Root>(["public", "private"])), ...none };
const attachments = {
  codec: option(list(closed<{ uri: string; alt: string | null; name: string | null }>("AttachmentInput", { uri: text, alt: optional, name: optional }))),
  ...none,
};

type Placement = { root: Root | null; slug: string | null };
type AttachmentInputs = { uri: string; alt: string | null; name: string | null }[] | null;

// Read on its own first, so the members of one kind are unknown members of another
const probe = open<{ kind: string | null } & Extra>("KindProbe", { kind: optional });

const noteInput = closed<{ content: string; kind: string | null; parent: string | null; embed: string | null; attachments: AttachmentInputs; lock: string | null } & Placement>("NoteInput", {
  content: text, kind: optional, parent: optional, embed: optional, attachments, lock: optional, root: rootCodec, slug: optional,
});

const articleInput = closed<{ title: string; body: string; coverImage: string | null; parent: string | null; embed: string | null; attachments: AttachmentInputs; lock: string | null } & Placement>("ArticleInput", {
  kind: text, title: text, body: text, coverImage: optional, parent: optional, embed: optional, attachments, lock: optional, root: rootCodec, slug: optional,
});

const collectionInput = closed<{ name: string; description: string | null; items: { uri: string; note: string | null }[] | null; coverImage: string | null; layout: string | null } & Placement>("CollectionInput", {
  kind: text,
  name: text,
  description: optional,
  items: { codec: option(list(closed<{ uri: string; note: string | null }>("ItemInput", { uri: text, note: optional }))), ...none },
  coverImage: optional,
  layout: optional,
  root: rootCodec,
  slug: optional,
});

const trimmedOrNull = (value: string | null) => (value === null ? null : frozenTrim(value) || null);
const attached = (inputs: AttachmentInputs): Attachment[] =>
  (inputs ?? []).map((a) => ({ uri: a.uri, alt: a.alt, name: a.name === null ? null : frozenTrim(a.name), extra: new Map() }));

/** A new post from the JSON text of its input. The builder trims text and writes the envelope. */
export function buildPost(owner: string, inputJson: string): Minted {
  checkPublicKey(owner);
  const { kind } = parse(probe, inputJson);
  const extra = new Map<string, Json>();
  if (kind === "article") {
    const i = parse(articleInput, inputJson);
    const content = article.write({ title: frozenTrim(i.title), body: i.body, cover_image: i.coverImage, extra });
    const value: Post = { content: frozenTrim(content), kind: "article", parent: i.parent, embed: i.embed, attachments: attached(i.attachments), lock: i.lock, extra };
    return create(value, i.root ?? "public", owner, i.slug);
  }
  if (kind === "collection") {
    const i = parse(collectionInput, inputJson);
    const layout = i.layout === null ? null : known(collectionLayouts, "collection layout", i.layout);
    const items = (i.items ?? []).map((entry) => ({ uri: entry.uri, note: trimmedOrNull(entry.note), extra: new Map() }));
    const content = collection.write({ name: frozenTrim(i.name), description: trimmedOrNull(i.description), items, cover_image: i.coverImage, layout, extra });
    const value: Post = { content: frozenTrim(content), kind: "collection", parent: null, embed: null, attachments: [], lock: null, extra };
    return create(value, i.root ?? "public", owner, i.slug);
  }
  const i = parse(noteInput, inputJson);
  const value: Post = {
    content: frozenTrim(i.content),
    kind: i.kind === null ? "note" : known(postKinds, "content kind", i.kind),
    parent: i.parent,
    embed: i.embed,
    attachments: attached(i.attachments),
    lock: i.lock,
    extra,
  };
  return create(value, i.root ?? "public", owner, i.slug);
}

const editAt = closed<{ id: string; head: string } & Placement>("EditAt", { id: text, head: text, root: rootCodec, slug: optional });

/** An edit from the JSON text of the post as it now reads and of where it stands. */
export function buildEdit(owner: string, postJson: string, atJson: string): Minted {
  checkPublicKey(owner);
  const value = parse(post.codec, postJson);
  const at = parse(editAt, atJson);
  return editPost(owner, value, at.id, at.head, at.root ?? "public", at.slug);
}
