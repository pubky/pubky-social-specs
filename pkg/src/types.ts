// The objects as a caller holds them: plain data, the known members only, every one present
// (null when it has no value), integers as numbers. Members this version does not know travel
// in `$unknown`, as text to carry along untouched.

import type * as feeds from "./models/feed.js";
import type * as graph from "./models/graph.js";
import type { KnownCollectionLayout, KnownFeedLayout, KnownFeedReach, KnownFeedSort, KnownPostKind } from "./models/kinds.js";
import type * as posts from "./models/post.js";
import type * as users from "./models/user.js";
import type { validMimeTypes } from "./data.js";
import type { ObjectKind, OwnerPath, Resource, Root } from "./uri.js";

/** Bytes that `fetch`, `Blob` and the SDK take as they are. */
export type Bytes = Uint8Array<ArrayBuffer>;

/** The full URL of a stored object, `pubky://<owner>/...`: what `decodeObject` reads at. */
export type PubkyUrl = `pubky://${string}`;


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

/** A built object: where it goes, what it is, and the exact bytes to PUT there. */
export interface Built<T> {
  /** What the path names: empty for the profile, the followee for a follow. */
  id: string;
  /** Owner-relative, as the SDK's storage calls take it. */
  path: OwnerPath;
  /** The full `pubky://` URL of the stored object. For a post it names this version: a reference to the post is `buildUri(owner, "post", id)`. */
  url: PubkyUrl;
  /** The object as stored, every known member present. Keep it for local state; PUT `body`, not this. */
  object: T;
  body: Bytes;
}

export type BuiltPost = Built<Post> & {
  /** The id of this version; equal to `id` for a post never edited. */
  editId: string;
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

export type NewPost = (
  | ({ kind?: Exclude<KnownPostKind, "article" | "collection"> | null; content: string } & Threaded)
  | ({ kind: "article"; title: string; body: string; cover_image?: string | null } & Threaded)
  | {
      kind: "collection";
      name: string;
      description?: string | null;
      items?: { uri: string; note?: string | null }[] | null;
      cover_image?: string | null;
      layout?: KnownCollectionLayout | null;
    }
) &
  Placement;

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

/** Where media goes. There is no `body`: the bytes are the caller's, PUT as they are. */
export interface BuiltFile {
  /** The hash of the bytes. */
  id: string;
  path: OwnerPath;
  url: PubkyUrl;
}

/** One copy a plan runs, `from` and `to` both owner-relative. */
export interface Copy {
  from: OwnerPath;
  to: OwnerPath;
}

/** A stored version of a post as a LIST found it. */
export interface StoredCopy {
  root: Root;
  path: OwnerPath;
}

/** A path as a LIST gave it, or a 0.x object with what proves it belongs to the target. */
export type Listing =
  | OwnerPath
  | { path: OwnerPath; src: string }
  | { path: OwnerPath; uri: string; label: string; src?: string | null; contentType?: string | null };

export type ParsedUri = { owner: string; root: Root; path: OwnerPath | "" } & (
  | Exclude<Resource, { kind: "follow" | "mute" | "bookmark" | "tag" | "file" | "feed" }>
  | { kind: "follow" | "mute" | "tag" | "feed"; id: string }
  /** `id` is the hash; `filename` adds the extension, the name `buildUri` takes. */
  | { kind: "file"; id: string; filename: string }
  /** `target` when the id carries one: the long form keeps it in the stored object. */
  | { kind: "bookmark"; id: string; target?: string }
);

export type { ObjectKind, OwnerPath, Root };
