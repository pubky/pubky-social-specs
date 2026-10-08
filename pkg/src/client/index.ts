// pubky-social-specs/client: the glue every app writes, over a signed-in SDK session. Build,
// PUT the exact bytes, LIST, pick the newest version, GET, decode. Only the public entry is
// used, so the core stays I/O free; all I/O goes through the session (and, for other users'
// trees, the SDK's public storage). A stored object that does not decode comes back as a value,
// never as a throw: other people's data can be anything.

import {
  buildBookmark,
  buildFeed,
  buildFile,
  buildFollow,
  buildMute,
  buildPost,
  buildTag,
  buildUri,
  buildUser,
  decodeObject,
  deletionPaths,
  editPost,
  encodeObject,
  listPrefix,
  parseOwner,
  parseUri,
  ValidationError,
} from "../index.js";
import type { SdkPublicStorage, SdkSession } from "../session.js";
import type * as T from "../types.js";

/** One stored object read: decoded, or why it could not be. */
export type Read<O, K extends T.ObjectKind = T.ObjectKind> = { ok: true; url: T.PubkyUrl<K>; path: T.OwnerPath; object: O } | { ok: false; url: string; error: ValidationError };

export interface ClientOptions {
  /** `pubky.publicStorage` of the SDK, for reading other users' trees. Without it only the owner's own tree is read. */
  publicStorage?: SdkPublicStorage;
  /** URLs per LIST page, 1000 at most. */
  pageSize?: number;
}

const PAGE = 1000;
// A post id another copy of the package minted first: build again, which mints the next one
const MINT_ATTEMPTS = 5;

const isNotFound = (error: unknown): boolean => (error as { data?: { statusCode?: unknown } } | null)?.data?.statusCode === 404;

// `missing` where the homeserver has nothing; any other failure goes on
const orMissing = async <R, M>(call: Promise<R>, missing: M): Promise<R | M> => {
  try {
    return await call;
  } catch (error) {
    if (isNotFound(error)) return missing;
    throw error;
  }
};

// Other people's data can be anything, so a refusal of the rules is a value
const decoded = <O, K extends T.ObjectKind>(url: string, path: string, decode: () => O): Read<O, K> => {
  try {
    return { ok: true, url: url as T.PubkyUrl<K>, path: path as T.OwnerPath, object: decode() };
  } catch (error) {
    if (error instanceof ValidationError) return { ok: false, url, error };
    throw error;
  }
};

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
export function createSocialClient(session: SdkSession, options: ClientOptions = {}) {
  const owner = parseOwner(session.info.publicKey.z32());
  const storage = session.storage;
  const pageSize = options.pageSize ?? PAGE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > PAGE) throw new RangeError(`createSocialClient: pageSize must be an integer from 1 to ${PAGE}, not ${pageSize}`);

  const pathOf = (author: string, url: string): string => url.slice(`pubky://${author}`.length);
  // The 1.x roots, owner-relative, as the core spells them
  const roots = { public: pathOf(owner, listPrefix(owner, "public")), private: pathOf(owner, listPrefix(owner, "private")) };
  const own = { list: (path: string, cursor: string | null) => storage.list(path, cursor, false, pageSize, false), get: (path: string) => storage.getBytes(path) };
  const reader = (author: string) => {
    if (author === owner) return own;
    const pub = options.publicStorage;
    if (pub === undefined) throw new TypeError("pubky-social-specs/client: reading another user's tree needs options.publicStorage, the SDK's pubky.publicStorage");
    return { list: (path: string, cursor: string | null) => pub.list(`${author}${path}`, cursor, false, pageSize, false), get: (path: string) => pub.getBytes(`${author}${path}`) };
  };

  /** Every URL under `prefix` (owner-relative, ending in `/`) of `author`'s tree, a page at a time. */
  async function* listed(author: string, prefix: string): AsyncGenerator<string> {
    const read = reader(author);
    let cursor: string | null = null;
    for (;;) {
      const page: string[] | null = await orMissing(read.list(prefix, cursor), null);
      if (page === null) return;
      yield* page;
      // A server or a proxy may cap the page below the size asked, so only an empty page ends the walk
      const last = page.at(-1);
      if (last === undefined) return;
      if (last === cursor) throw new Error(`pubky-social-specs/client: listing ${prefix} of ${author}: the cursor ${cursor} does not advance`);
      cursor = last;
    }
  }

  async function readAt<O, K extends T.ObjectKind = T.ObjectKind>(author: string, url: string, kind: keyof T.Stored): Promise<Read<O, K> | null> {
    const path = pathOf(author, url);
    const bytes = await orMissing(reader(author).get(path), null);
    return bytes === null ? null : decoded<O, K>(url, path, () => decodeObject(url as T.UrlArg, bytes, kind) as O);
  }

  async function* readAll<O>(author: string, prefix: string, kind: keyof T.Stored): AsyncGenerator<Read<O>> {
    for await (const url of listed(author, prefix)) {
      const read = await readAt<O>(author, url, kind);
      if (read !== null) yield read;
    }
  }

  const stored = async <B extends { path: string; body: Uint8Array }>(built: B): Promise<B> => {
    await storage.putBytes(built.path, built.body);
    return built;
  };
  const remove = async (paths: readonly string[]) => {
    for (const path of paths) await orMissing(storage.delete(path), undefined);
  };

  /** The newest version of post `id` of `author` under `root`, read, or null when it has none. */
  async function newest(author: string, id: string, root: T.Root): Promise<Read<T.Post, "post"> | null> {
    let head: { editId: string; url: string } | null = null;
    for await (const url of listed(author, `${roots[root]}posts/${id}/`)) {
      let parsed: T.ParsedUri;
      try {
        parsed = parseUri(url);
      } catch (error) {
        if (error instanceof ValidationError) continue;
        throw error;
      }
      if (parsed.kind === "post" && parsed.editId !== undefined && (head === null || parsed.editId > head.editId)) head = { editId: parsed.editId, url };
    }
    return head === null ? null : readAt<T.Post, "post">(author, head.url, "post");
  }

  /** A post id is taken by a version of it in either root, by this copy of the package or another. */
  const taken = async (id: string) => {
    for (const root of [roots.public, roots.private]) for await (const _ of listed(owner, `${root}posts/${id}/`)) return true;
    return false;
  };

  return {
    owner,

    posts: {
      /** Builds a post and PUTs it. An id already used in either root is minted again. */
      async create<const I extends T.NewPost>(input: I & T.CheckedPost<I>): Promise<T.BuiltPost> {
        for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt++) {
          // The reference check ran on this method's own signature
          const built = buildPost(owner, input as never);
          if (await taken(built.id)) continue;
          return stored(built);
        }
        throw new Error(`pubky-social-specs/client: ${MINT_ATTEMPTS} post ids in a row were taken`);
      },
      /** The newest public version of a post, or of a draft with `root: "private"` (the owner's only). */
      head: (author: T.Given<"Owner">, id: T.Given<"PostId">, root: T.Root = "public") => newest(parseOwner(author), id, root),
      /** A new version of the post read as `head`, PUT where `editPost` puts it. */
      async edit(head: { url: T.UrlArg<"post"> }, post: T.Post, editOptions?: { root?: T.Root | null; slug?: string | null }): Promise<T.BuiltPost> {
        return stored(editPost(head.url, post, editOptions));
      },
      /** The newest public version of every post of `author`; one that does not decode is a value with its error. */
      async *list(author: T.Given<"Owner">): AsyncGenerator<Read<T.Post, "post">> {
        const key = parseOwner(author);
        const ids = new Set<string>();
        const prefix = `${roots.public}posts/`;
        for await (const url of listed(key, prefix)) {
          const id = pathOf(key, url).slice(prefix.length).split("/")[0];
          if (id !== undefined && id !== "") ids.add(id);
        }
        for (const id of ids) {
          const read = await newest(key, id, "public");
          if (read !== null) yield read;
        }
      },
      /** Deletes every version of an own post in both roots, newest last. */
      async delete(id: T.Given<"PostId">): Promise<void> {
        const listings: string[] = [];
        for (const root of [roots.public, roots.private]) for await (const url of listed(owner, `${root}posts/${id}/`)) listings.push(pathOf(owner, url));
        await remove(deletionPaths({ kind: "post", id, listings: listings as T.PathArg[] }));
      },
    },

    profile: {
      get: (author: T.Given<"Owner"> = owner) => readAt<T.User>(parseOwner(author), buildUri(author, "user"), "user"),
      /** Writes a fresh profile from `input`. To keep members another client added, `update` a read one. */
      async set(input: T.NewUser): Promise<T.Built<T.User>> {
        return stored(buildUser(owner, input));
      },
      /** Writes back a profile read with `get` and changed, its unknown members kept. */
      async update(user: T.User): Promise<void> {
        const url = buildUri(owner, "user");
        await storage.putBytes(pathOf(owner, url), encodeObject(url, user));
      },
    },

    follows: {
      async add(followee: T.Given<"Owner">): Promise<T.Built<T.Follow, T.Owner>> {
        return stored(buildFollow(owner, followee));
      },
      remove: (followee: T.Given<"Owner">) => remove(deletionPaths({ kind: "follow", id: followee })),
      list: (author: T.Given<"Owner"> = owner) => readAll<T.Follow>(parseOwner(author), `${roots.public}follows/`, "follow"),
    },

    mutes: {
      async add(mutee: T.Given<"Owner">): Promise<T.Built<T.Mute, T.Owner>> {
        return stored(buildMute(owner, mutee));
      },
      remove: (mutee: T.Given<"Owner">) => remove(deletionPaths({ kind: "mute", id: mutee })),
      list: () => readAll<T.Mute>(owner, `${roots.private}mutes/`, "mute"),
    },

    tags: {
      async add(uri: T.Reference, label: string): Promise<T.Built<T.Tag>> {
        return stored(buildTag(owner, uri, label));
      },
      remove: (id: string) => remove(deletionPaths({ kind: "tag", id })),
      list: (author: T.Given<"Owner"> = owner) => readAll<T.Tag>(parseOwner(author), `${roots.public}tags/`, "tag"),
    },

    bookmarks: {
      async add(target: T.Reference): Promise<T.Built<T.Bookmark>> {
        return stored(buildBookmark(owner, target));
      },
      remove: (id: string) => remove(deletionPaths({ kind: "bookmark", id })),
      list: () => readAll<T.Bookmark>(owner, `${roots.private}bookmarks/`, "bookmark"),
    },

    feeds: {
      async add(input: T.NewFeed): Promise<T.Built<T.Feed>> {
        return stored(buildFeed(owner, input));
      },
      remove: (id: string) => remove(deletionPaths({ kind: "feed", id })),
      list: () => readAll<T.Feed>(owner, `${roots.private}feeds/`, "feed"),
    },

    files: {
      /** PUTs media where its hash names it, public unless `root` says otherwise. */
      async upload(bytes: Uint8Array, type: T.MimeType | (string & {}), root: T.Root = "public"): Promise<T.BuiltFile> {
        const built = buildFile(owner, { bytes, type, root });
        await storage.putBytes(built.path, bytes);
        return built;
      },
      /** The bytes of media at `url`, checked against the hash that names them; null when absent. */
      async get(url: T.UrlArg<"file">): Promise<Read<T.Bytes, "file"> | null> {
        const parsed = parseUri(url);
        const bytes = await orMissing(reader(parsed.owner).get(parsed.path), null);
        return bytes === null ? null : decoded<T.Bytes, "file">(url, parsed.path, () => decodeObject(url, bytes, "file"));
      },
    },
  };
}

/** What `createSocialClient` gives. */
export type SocialClient = ReturnType<typeof createSocialClient>;
export type { SdkPublicStorage, SdkSession as SocialSession } from "../session.js";
