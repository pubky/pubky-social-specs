import { ValidationError } from "../index.js";
import type { SdkPublicStorage, SdkSession } from "../session.js";
import type * as T from "../types.js";
/** One stored object read: decoded, or why it could not be. */
export type Read<O, K extends T.ObjectKind = T.ObjectKind> = {
    /** The object decoded. */
    ok: true;
    /** Where it was read. */
    url: T.PubkyUrl<K>;
    /** The same place, owner-relative. */
    path: T.OwnerPath;
    /** The decoded object. */
    object: O;
} | {
    /** The bytes are no valid object there: other people's data can be anything. */
    ok: false;
    /** Where it was read. */
    url: string;
    /** Why, with its `code` and `field`. */
    error: ValidationError;
};
/** What `createSocialClient` takes besides the session. */
export interface ClientOptions {
    /** `pubky.publicStorage` of the SDK, for reading other users' trees. Without it only the owner's own tree is read. */
    publicStorage?: SdkPublicStorage;
    /** URLs per LIST page, 1000 at most. */
    pageSize?: number;
}
/**
 * A social client for the owner of `session`.
 *
 * @example
 * ```ts
 * import { createSocialClient } from "pubky-social-specs/client";
 * declare const session: import("pubky-social-specs/client").SocialSession;
 * const social = createSocialClient(session);
 * const post = await social.posts.create({ content: "Hello" });
 * const head = await social.posts.head(social.owner, post.id);
 * if (head?.ok) await social.posts.edit(head, { ...head.object, content: "Hello, edited" });
 * ```
 */
export declare function createSocialClient(session: SdkSession, options?: ClientOptions): {
    /** The session's own key, bare: whose tree the writes go to. */
    owner: T.Owner;
    /** Posts: create, read the head, edit, list an author's posts, delete. */
    posts: {
        /** Builds a post and PUTs it. An id already used in either root is minted again. */
        create<const I extends T.NewPost>(input: I & T.CheckedPost<I>): Promise<T.BuiltPost>;
        /** The newest public version of a post, or of a draft with `root: "private"` (the owner's only). */
        head: (author: T.Given<"Owner">, id: T.Given<"PostId">, root?: T.Root) => Promise<Read<T.Post, "post"> | null>;
        /** A new version of the post read as `head`, PUT where `editPost` puts it. */
        edit(head: {
            url: T.UrlArg<"post">;
        }, post: T.Post, editOptions?: {
            root?: T.Root | null;
            slug?: string | null;
        }): Promise<T.BuiltPost>;
        /** The newest public version of every post of `author`; one that does not decode is a value with its error. */
        list(author: T.Given<"Owner">): AsyncGenerator<Read<T.Post, "post">>;
        /** Deletes every version of an own post in both roots, newest last, and its 0.x copy first when there is one. */
        delete(id: T.Given<"PostId">): Promise<void>;
    };
    /** The owner's profile: get anyone's, set or update the owner's. */
    profile: {
        get: (author?: T.Given<"Owner">) => Promise<Read<T.User, "user"> | null>;
        /** Writes a fresh profile from `input`. To keep members another client added, `update` a read one. */
        set(input: T.NewUser): Promise<T.Built<T.User>>;
        /** Writes back a profile read with `get` and changed, its unknown members kept. */
        update(user: T.User): Promise<void>;
    };
    /** The owner's follows: add, remove, list. */
    follows: {
        add(followee: T.Given<"Owner">): Promise<T.Built<T.Follow, T.Owner, "follow">>;
        remove: (followee: T.Given<"Owner">) => Promise<void>;
        list: (author?: T.Given<"Owner">) => AsyncGenerator<Read<T.Follow, "follow">, any, any>;
    };
    /**
     * The owner's mutes, private: add, remove, list. `remove` deletes the 0.x copy first; a
     * session not granted the 0.x tree leaves that copy and still deletes the 1.x one.
     */
    mutes: {
        add(mutee: T.Given<"Owner">): Promise<T.Built<T.Mute, T.Owner, "mute">>;
        remove: (mutee: T.Given<"Owner">) => Promise<void>;
        list: () => AsyncGenerator<Read<T.Mute, "mute">, any, any>;
    };
    /**
     * The owner's tags: add, remove, list. `add` reads the tag's address first: a tag already
     * there, which another app may have added to, is kept as it is and returned.
     */
    tags: {
        add(uri: T.Reference, label: string): Promise<T.Built<T.Tag>>;
        remove: (id: string) => Promise<void>;
        list: (author?: T.Given<"Owner">) => AsyncGenerator<Read<T.Tag, "tag">, any, any>;
    };
    /** The owner's bookmarks, private: add, remove, list. */
    bookmarks: {
        add(target: T.Reference): Promise<T.Built<T.Bookmark>>;
        remove: (id: string) => Promise<void>;
        list: () => AsyncGenerator<Read<T.Bookmark, "bookmark">, any, any>;
    };
    /** The owner's saved feeds, private: add, remove, list. */
    feeds: {
        add(input: T.NewFeed): Promise<T.Built<T.Feed>>;
        remove: (id: string) => Promise<void>;
        list: () => AsyncGenerator<Read<T.Feed, "feed">, any, any>;
    };
    /** Media: upload bytes and read them back by URL. */
    files: {
        /** PUTs media where its hash names it, public unless `root` says otherwise. */
        upload(bytes: Uint8Array, type: T.MimeType | (string & {}), root?: T.Root): Promise<T.BuiltFile>;
        /** The bytes of media at `url`, checked against the hash that names them; null when absent. */
        get(url: T.UrlArg<"file">): Promise<Read<T.Bytes, "file"> | null>;
    };
};
/** What `createSocialClient` gives. */
export type SocialClient = ReturnType<typeof createSocialClient>;
export type { SdkPublicStorage, SdkSession as SocialSession } from "../session.js";
//# sourceMappingURL=index.d.ts.map