// The objects as a caller holds them: plain data, the known members only, every one present
// (null when it has no value), integers as numbers. Members this version does not know travel
// in `$unknown`, as text to carry along untouched.

import type { CollectionLayout, FeedLayout, FeedReach, FeedSort, KnownCollectionLayout, KnownFeedLayout, KnownFeedReach, KnownFeedSort, KnownPostKind, PostKind } from "./models/kinds.js";
import type { ObjectKind, Resource, Root } from "./uri.js";

/** Bytes that `fetch`, `Blob` and the SDK take as they are. */
export type Bytes = Uint8Array<ArrayBuffer>;

interface Open {
  /** The members a newer writer added, as the text they were read with. Carry it along. */
  $unknown?: string;
}

export interface UserLink extends Open {
  title: string;
  url: string;
}

export interface User extends Open {
  name: string;
  bio: string | null;
  image: string | null;
  links: UserLink[] | null;
  status: string | null;
}

export interface Attachment extends Open {
  uri: string;
  alt: string | null;
  name: string | null;
}

export interface Post extends Open {
  /** Text for an untyped kind; for an article or a collection, the envelope `decodeContent` reads. */
  content: string;
  kind: PostKind;
  parent: string | null;
  embed: string | null;
  attachments: Attachment[];
  lock: string | null;
}

export interface ArticleContent extends Open {
  title: string;
  body: string;
  cover_image: string | null;
}

export interface CollectionItem extends Open {
  uri: string;
  note: string | null;
}

export interface CollectionContent extends Open {
  name: string;
  description: string | null;
  items: CollectionItem[];
  cover_image: string | null;
  layout: CollectionLayout | null;
}

export interface Tag extends Open {
  uri: string;
  label: string;
  /** Microseconds since the epoch. */
  created_at: number;
}

export interface Bookmark extends Open {
  /** Microseconds since the epoch. */
  created_at: number;
  /** Only on a bookmark whose target is too long for its id to carry. */
  target: string | null;
}

export interface Follow extends Open {
  /** Microseconds since the epoch. */
  created_at: number;
}

export interface Mute extends Open {
  /** Microseconds since the epoch. */
  created_at: number;
}

export interface FeedConfig extends Open {
  tags: string[] | null;
  domain_tags: string[] | null;
  reach: FeedReach;
  layout: FeedLayout;
  sort: FeedSort;
  content: PostKind | null;
}

export interface Feed extends Open {
  feed: FeedConfig;
  name: string;
  /** 1 to 50 of a-z, 0-9 and `-`: a name for the client's icon set, not an emoji. */
  icon: string | null;
  /** Microseconds since the epoch. */
  created_at: number;
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
  path: string;
  /** The full `pubky://` URL of the stored object. For a post it names this version: a reference to the post is `buildUri(owner, "post", id)`. */
  url: string;
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

export type NewFile = ({ bytes: Uint8Array } | { id: string }) & {
  /** The declared media type, which picks the extension and is never stored. */
  type: string;
  root?: Root | null;
};

export type ParsedUri = { owner: string; root: Root; path: string } & (
  | Exclude<Resource, { kind: "follow" | "mute" | "bookmark" | "tag" | "file" | "feed" }>
  | { kind: "follow" | "mute" | "tag" | "file" | "feed"; id: string }
  /** `target` when the id carries one: the long form keeps it in the stored object. */
  | { kind: "bookmark"; id: string; target?: string }
);

export type { ObjectKind, Root };
