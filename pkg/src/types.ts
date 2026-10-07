// The objects as a caller holds them: plain data, the known members only, every one present
// (null when it has no value), integers as numbers. Members this version does not know travel
// in `$unknown`, as text to carry along untouched.

import type * as feeds from "./models/feed.js";
import type * as graph from "./models/graph.js";
import type { KnownCollectionLayout, KnownFeedLayout, KnownFeedReach, KnownFeedSort, KnownPostKind } from "./models/kinds.js";
import type * as posts from "./models/post.js";
import type * as users from "./models/user.js";
import type { validMimeTypes } from "./data.js";
import type { ObjectKind, OwnerPath as PathText, Root } from "./uri.js";

/** Bytes that `fetch`, `Blob` and the SDK take as they are. */
export type Bytes = Uint8Array<ArrayBuffer>;

declare const brand: unique symbol;

/**
 * A string the package made or checked, tagged with what it names. The tag is a type only: at
 * run time a branded value is the string, and a plain string is taken wherever a brand is.
 */
export type Brand<S extends string, B extends string> = S & { readonly [brand]: B };

/**
 * A string argument: a plain one, or one branded `B`. A value branded as anything else is a
 * value of another kind passed by mistake, and does not compile.
 */
export type Given<B extends string, S extends string = string> = S & { readonly [brand]?: B };

/** A bare public key, 52 z-base32 characters, no `pubky://`: whose tree an object is in. */
export type Owner = Brand<string, "Owner">;

/** The id of a post, minted when it was created; every version of it shares it. */
export type PostId = Brand<string, "PostId">;

/** The id of one version of a post: its post id for the first version, a later one per edit. */
export type EditId = Brand<string, "EditId">;

/** The id of media: the hash of its bytes. */
export type MediaId = Brand<string, "MediaId">;

/**
 * The full URL of one stored object of kind `K`, `pubky://<owner>/...`: what `decodeObject`
 * reads at. For a post it names one version, so it is no reference to the post.
 */
export type PubkyUrl<K extends ObjectKind = ObjectKind> = Brand<`pubky://${string}`, `PubkyUrl.${K}`>;

/** An owner-relative path, `/pub/...` or `/priv/...`: what the SDK's storage calls and every plan take. */
export type OwnerPath = Brand<PathText, "OwnerPath">;

/** A reference to a post, `buildUri(owner, "post", id)`: versionless, so it names the post and not one version. */
export type PostRef = Brand<`pubky://${string}`, "PostRef">;

/** Where a reference may point: anything but one version of a post. */
export type Reference = Given<"PostRef" | `PubkyUrl.${Exclude<ObjectKind, "post">}`>;

/** A URL argument naming a stored object. */
export type UrlArg<K extends ObjectKind = ObjectKind> = Given<`PubkyUrl.${K}`, `pubky://${string}`>;

/** An owner-relative path argument. */
export type PathArg = Given<"OwnerPath", PathText>;


/** A media type the package maps to an extension; any other string is taken too, as `.bin`. */
export type MimeType = (typeof validMimeTypes)[number];

/**
 * A stored model as a caller holds it: the known members, integers as numbers, and the
 * unknown ones as `$unknown` text. Every public object type below is this of its model, so a
 * member added to a model reaches the type a caller sees.
 */
type Plain<T> = { [K in keyof T as K extends "extra" ? never : K]: T[K] extends bigint ? number : T[K] };

interface Open {
  /** The members a newer writer added, as the text they were read with. Carry it along. */
  $unknown?: string;
}

export interface UserLink extends Open, Plain<users.UserLink> {}

export interface User extends Open, Omit<Plain<users.User>, "links"> {
  links: UserLink[] | null;
}

export interface Attachment extends Open, Plain<posts.Attachment> {}

export interface Post extends Open, Omit<Plain<posts.Post>, "kind" | "attachments"> {
  /** A post of a kind this version does not know is refused on read, so never `"unknown"`. */
  kind: KnownPostKind;
  attachments: Attachment[];
}

export interface ArticleContent extends Open, Plain<posts.ArticleContent> {}

export interface CollectionItem extends Open, Plain<posts.CollectionItem> {}

export interface CollectionContent extends Open, Omit<Plain<posts.CollectionContent>, "items"> {
  items: CollectionItem[];
}

export interface Tag extends Open, Plain<graph.Tag> {}

export interface Bookmark extends Open, Plain<graph.Bookmark> {}

export interface Follow extends Open, Plain<graph.Edge> {}

export interface Mute extends Open, Plain<graph.Edge> {}

export interface FeedConfig extends Open, Omit<Plain<feeds.FeedConfig>, "reach" | "layout" | "sort"> {
  reach: KnownFeedReach;
  layout: KnownFeedLayout;
  sort: KnownFeedSort;
}

export interface Feed extends Open, Omit<Plain<feeds.Feed>, "feed"> {
  feed: FeedConfig;
}

export interface Stored {
  user: User;
  post: Post;
  follow: Follow;
  mute: Mute;
  bookmark: Bookmark;
  tag: Tag;
  feed: Feed;
}

/** What `decodeObject` gives: the kind the URI names and the object, or the bytes of media. */
export type Decoded = { [K in keyof Stored]: { kind: K; object: Stored[K] } }[keyof Stored] | { kind: "file"; bytes: Bytes };

/** The kind of a stored object type: a post's URL names a version, every other one the object. */
type KindOf<T> = T extends Post ? "post" : T extends User ? "user" : T extends Feed ? "feed" : T extends Tag ? "tag" : T extends Bookmark ? "bookmark" : "follow" | "mute";

/** A built object: where it goes, what it is, and the exact bytes to PUT there. */
export interface Built<T, Id extends string = string> {
  /** What the path names: empty for the profile, the followee for a follow. */
  id: Id;
  /** Owner-relative, as the SDK's storage calls take it. */
  path: OwnerPath;
  /** The full `pubky://` URL of the stored object. For a post it names this version: a reference to the post is `buildUri(owner, "post", id)`. */
  url: PubkyUrl<KindOf<T>>;
  /** The object as stored, every known member present. Keep it for local state; PUT `body`, not this. */
  object: T;
  body: Bytes;
}

export type BuiltPost = Built<Post, PostId> & {
  /** The id of this version; equal to `id` for a post never edited. */
  editId: EditId;
};

export interface NewUser {
  name: string;
  bio?: string | null;
  image?: string | null;
  links?: { title: string; url: string }[] | null;
  status?: string | null;
}

export interface NewAttachment {
  uri: string;
  alt?: string | null;
  name?: string | null;
}

interface Placement {
  /** Where the version is stored. A private draft may reference the owner's private media. */
  root?: Root | null;
  /** A readable tail for the version's path: 1 to 64 of a-z, 0-9 and `-`. */
  slug?: string | null;
}

interface Threaded {
  parent?: string | null;
  embed?: string | null;
  attachments?: NewAttachment[] | null;
  lock?: string | null;
}

/** A post of any kind but an article or a collection: `note` when `kind` is absent. */
export type NewNote = { kind?: Exclude<KnownPostKind, "article" | "collection"> | null; content: string } & Threaded & Placement;

export type NewArticle = { kind: "article"; title: string; body: string; cover_image?: string | null } & Threaded & Placement;

export type NewCollection = {
  kind: "collection";
  name: string;
  description?: string | null;
  items?: { uri: string; note?: string | null }[] | null;
  cover_image?: string | null;
  layout?: KnownCollectionLayout | null;
} & Placement;

export type NewPost = NewNote | NewArticle | NewCollection;

/** The version URL a reference member would hold, named where it is refused. */
type NoVersion<T> = T extends { readonly [brand]: "PubkyUrl.post" }
  ? { error: 'a reference names the post, buildUri(owner, "post", id), never the url of one version' }
  : T extends object
    ? { [K in keyof T]: NoVersion<T[K]> }
    : T;

type BranchOf<I> = I extends { kind: "article" } ? NewArticle : I extends { kind: "collection" } ? NewCollection : NewNote;

/**
 * A post input as `buildPost` checks it at compile time: the members of its kind only, and no
 * reference holding the URL of a post version.
 */
export type CheckedPost<I> = { [K in keyof I]: K extends keyof BranchOf<I> ? NoVersion<I[K]> : never };

export interface NewFeed {
  name: string;
  icon: string;
  reach: KnownFeedReach;
  layout: KnownFeedLayout;
  sort: KnownFeedSort;
  content?: KnownPostKind | null;
  tags?: string[] | null;
  domain_tags?: string[] | null;
}

export type NewFile = ({ bytes: Uint8Array | ArrayBuffer } | { id: string }) & {
  /** The declared media type, which picks the extension and is never stored. */
  type: MimeType | (string & {});
  root?: Root | null;
};

/** A `ReadableStream` of bytes, as far as `hashMedia` reads one. */
export interface ByteStream {
  getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; releaseLock(): void };
}

/** A `Blob` or a `File`, as far as `hashMedia` reads one. */
export interface BlobLike {
  stream(): ByteStream;
}

export type MediaSource = BlobLike | ByteStream;

/** Where media goes. There is no `body`: the bytes are the caller's, PUT as they are. */
export interface BuiltFile {
  /** The hash of the bytes. */
  id: MediaId;
  path: OwnerPath;
  url: PubkyUrl<"file">;
}

/** One copy a plan runs, `from` and `to` both owner-relative. */
export interface Copy {
  from: OwnerPath;
  to: OwnerPath;
}

/** A stored version of a post as a LIST found it. */
export interface StoredCopy {
  root: Root;
  path: PathArg;
}

/** A path as a LIST gave it, or a 0.x object with what proves it belongs to the target. */
export type Listing =
  | PathArg
  | { path: PathArg; src: string }
  | { path: PathArg; uri: string; label: string; src?: string | null; contentType?: string | null };

export type ParsedUri = { owner: Owner; root: Root; path: OwnerPath | "" } & (
  | { kind: "user" }
  | { kind: "post"; id: PostId; editId?: EditId; slug?: string }
  | { kind: "follow" | "mute"; id: Owner }
  | { kind: "tag" | "feed"; id: string }
  /** `id` is the hash; `filename` adds the extension, the name `buildUri` takes. */
  | { kind: "file"; id: MediaId; filename: string }
  /** `target` when the id carries one: the long form keeps it in the stored object. */
  | { kind: "bookmark"; id: string; target?: string }
  /** A path under a namespace other than this one, such as the 0.x `pubky.app`. */
  | { kind: "foreign"; namespace: string; version?: string; rest: string[] }
  /** A path under an epoch of this namespace this version does not read. */
  | { kind: "unsupportedVersion"; version: string }
  | { kind: "unknown" }
);

export type { ObjectKind, Root };
