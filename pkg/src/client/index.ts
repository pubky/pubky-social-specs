// pubky-social-specs/client: the glue every app writes, over a signed-in SDK session. Build,
// PUT the exact bytes, LIST, pick the newest version, GET, decode. Only the public entry is
// used, so the core stays I/O free; all I/O goes through the session (and, for other users'
// trees, the SDK's public storage). A stored object that does not decode comes back as a value,
// never as a throw: other people's data can be anything.

import {
  ArgumentError,
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
  feedPaths,
  listPrefix,
  parseOwner,
  parsePostId,
  parsePubkyUrl,
  parseUri,
  toPath,
  ValidationError,
} from "../index.js";
import type { SdkPublicStorage, SdkSession } from "../session.js";
import type * as T from "../types.js";

/** One stored object read: decoded, or why it could not be. */
export type Read<O, K extends T.ObjectKind = T.ObjectKind> =
  | {
      /** The object decoded. */
      ok: true;
      /** Where it was read. */
      url: T.PubkyUrl<K>;
      /** The same place, owner-relative. */
      path: T.OwnerPath;
      /** The decoded object. */
      object: O;
    }
  | {
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
 * What a delete could not reach. A session granted only the 1.x tree is refused under
 * `/pub/pubky.app/`, and a 0.x tag on another user's file cannot be told from its copy when
 * that file cannot be read. A 0.x copy of the object may still be there, and an indexer that
 * reads 0.x would bring the object back from it. Empty when nothing was left.
 */
export interface Removed {
  /** The 0.x paths left: each may still hold a copy. */
  legacyRefused: T.OwnerPath[];
}

const PAGE = 1000;
// A post id another copy of the package minted first: build again, which mints the next one
const MINT_ATTEMPTS = 5;

const statusOf = (error: unknown): unknown => (error as { data?: { statusCode?: unknown } } | null)?.data?.statusCode;
const isNotFound = (error: unknown): boolean => statusOf(error) === 404;
// What a session without a grant for a path is told
const isRefused = (error: unknown): boolean => statusOf(error) === 401 || statusOf(error) === 403;

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
const decoded = <O, K extends T.ObjectKind>(url: string, kind: K, decode: () => O): Read<O, K> => {
  try {
    const object = decode();
    return { ok: true, url: parsePubkyUrl(url, kind), path: toPath(url), object };
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
  const roots = {
    public: pathOf(owner, listPrefix(owner, "public")),
    private: pathOf(owner, listPrefix(owner, "private")),
    legacy: pathOf(owner, listPrefix(owner, "legacy")),
  };
  const own = { list: (path: string, cursor: string | null) => storage.list(path, cursor, false, pageSize, false), get: (path: string) => storage.getBytes(path) };
  const others = (): SdkPublicStorage => {
    const pub = options.publicStorage;
    if (pub === undefined) throw new TypeError("pubky-social-specs/client: reading another user's tree needs options.publicStorage, the SDK's pubky.publicStorage");
    return pub;
  };
  const reader = (author: string) => {
    if (author === owner) return own;
    const pub = others();
    return { list: (path: string, cursor: string | null) => pub.list(`pubky://${author}${path}`, cursor, false, pageSize, false), get: (path: string) => pub.getBytes(`pubky://${author}${path}`) };
  };

  /** The post version a listed URL names, or null for any other file a tree may hold. */
  const versionOf = (url: string): { id: string; editId: string } | null => {
    let at: T.ParsedUri;
    try {
      at = parseUri(url);
    } catch (e) {
      if (e instanceof ValidationError) return null;
      throw e;
    }
    return at.kind === "post" && at.editId !== undefined ? { id: at.id, editId: at.editId } : null;
  };
  const isVersion = (url: string): boolean => versionOf(url) !== null;

  /** Every URL under `prefix` (owner-relative, ending in `/`) of `author`'s tree, a page at a time. */
  async function* listed(author: string, prefix: string): AsyncGenerator<string> {
    const read = reader(author);
    const under = `pubky://${author}${prefix}`;
    let cursor: string | null = null;
    for (;;) {
      // A page is a server's answer, whatever the session's types say
      const answer: unknown = await orMissing(read.list(prefix, cursor), null);
      if (answer === null) return;
      if (!Array.isArray(answer)) throw new Error(`pubky-social-specs/client: listing ${prefix} of ${author} returned no list`);
      // A homeserver answers for one tree: a URL outside it would pass its bytes off as another user's
      const stray = answer.findIndex((url) => typeof url !== "string" || !url.startsWith(under));
      if (stray !== -1) throw new Error(`pubky-social-specs/client: listing ${prefix} of ${author} returned ${String(answer[stray])}, outside it`);
      const page = answer as string[];
      yield* page;
      // A server or a proxy may cap the page below the size asked, so only an empty page ends the walk
      const last = page.at(-1);
      if (last === undefined) return;
      if (last === cursor) throw new Error(`pubky-social-specs/client: listing ${prefix} of ${author}: the cursor ${cursor} does not advance`);
      cursor = last;
    }
  }

  async function readAt<K extends keyof T.Stored>(author: string, url: string, kind: K): Promise<Read<T.Stored[K], K> | null> {
    const path = pathOf(author, url);
    const bytes = await orMissing(reader(author).get(path), null);
    return bytes === null ? null : decoded<T.Stored[K], K>(url, kind, () => decodeObject(url as T.UrlArg, bytes, kind));
  }

  async function* readAll<K extends keyof T.Stored>(author: string, prefix: string, kind: K): AsyncGenerator<Read<T.Stored[K], K>> {
    for await (const url of listed(author, prefix)) {
      const read = await readAt(author, url, kind);
      if (read !== null) yield read;
    }
  }

  const stored = async <B extends { path: string; body: Uint8Array }>(built: B): Promise<B> => {
    await storage.putBytes(built.path, built.body);
    return built;
  };
  // A 0.x copy goes first, so a reindex cannot bring the object back from it. A session granted
  // only the 1.x tree, as an app should ask, may not touch it: the 1.x copies still go
  // The probe for a 0.x copy, which such a session may be refused too: no copy it can delete
  const legacyExists = async (path: string, refused: string[]): Promise<boolean> => {
    try {
      return await storage.exists(path);
    } catch (error) {
      if (!isRefused(error)) throw error;
      refused.push(path);
      return false;
    }
  };
  // Answers the 0.x paths the session was refused, in `refused` and whatever a probe added to it
  const remove = async (paths: readonly string[], refused: string[] = []): Promise<Removed> => {
    for (const path of paths) {
      try {
        await orMissing(storage.delete(path), undefined);
      } catch (error) {
        if (!(path.startsWith(roots.legacy) && isRefused(error))) throw error;
        refused.push(path);
      }
    }
    return { legacyRefused: refused as T.OwnerPath[] };
  };

  // The one place a post's directory is spelled from what a caller gave: checked first, so no
  // id or root can point a LIST anywhere else
  // `root` is unknown here: a JS caller may pass anything, whatever the signature says
  const versionsOf = (author: string, id: string, root: unknown) => {
    if (typeof root !== "string") throw new ArgumentError("root", "pubky-social-specs: root must be a string");
    if (root !== "public" && root !== "private") throw new ValidationError("unknown_name", `unknown variant \`${root}\`, expected \`public\` or \`private\``, "root");
    // What a server answers for someone else's private tree is its own business: never asked
    if (root === "private" && author !== owner) throw new TypeError("pubky-social-specs/client: a private root is read by its owner only");
    return listed(author, `${roots[root]}posts/${parsePostId(id)}/`);
  };

  /** The newest version of post `id` of `author` under `root`, read, or null when it has none. */
  async function newest(author: string, id: string, root: T.Root): Promise<Read<T.Post, "post"> | null> {
    let head: { editId: string; url: string } | null = null;
    for await (const url of versionsOf(author, id, root)) {
      const at = versionOf(url);
      if (at !== null && at.id === id && (head === null || at.editId > head.editId)) head = { editId: at.editId, url };
    }
    return head === null ? null : readAt(author, head.url, "post");
  }

  /** Every version of the owner's post `id`, public then private. */
  async function* ownVersions(id: string): AsyncGenerator<string> {
    yield* versionsOf(owner, id, "public");
    yield* versionsOf(owner, id, "private");
  }

  /** A post id is taken by a version of it in either root, by this copy of the package or another. */
  const taken = async (id: string) => {
    for await (const _ of ownVersions(id)) return true;
    return false;
  };
  /** The version of the post that already carries an edit id, in either root, or null. */
  const editTaken = async (id: string, editId: string): Promise<string | null> => {
    for await (const url of ownVersions(id)) if (versionOf(url)?.editId === editId) return url;
    return null;
  };

  // A 0.x tag is named by a hash of what it holds, which a v1 id does not give back, so the
  // copies of a tag are found by reading the 0.x tags. A path names its bytes: each is read once
  const legacyTags = new Map<string, T.Listing | null>();
  const jsonAt = async (bytes: Promise<Uint8Array>): Promise<Record<string, unknown> | null> => {
    const stored = await orMissing(bytes, null);
    if (stored === null) return null;
    try {
      const value: unknown = JSON.parse(new TextDecoder().decode(stored));
      return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  // Read loosely: deletionPaths checks the path against what was read before anything is deleted
  // Answers undefined, to ask again later, for a tag on a file of another user that cannot be read now
  const legacyTag = async (path: string): Promise<T.Listing | null | undefined> => {
    const tag = await jsonAt(storage.getBytes(path));
    if (tag === null || typeof tag.uri !== "string" || typeof tag.label !== "string") return null;
    const { uri, label } = tag;
    if (!(uri.startsWith("pubky") && uri.includes(`${roots.legacy}files/`))) return { path, uri, label };
    // A tag on a 0.x File object is respelled for v1 from what that object says of its bytes
    const mine = `pubky://${owner}`;
    let file: Record<string, unknown> | null;
    if (uri.startsWith(`${mine}/`)) file = await jsonAt(storage.getBytes(uri.slice(mine.length)));
    else {
      try {
        file = await jsonAt(others().getBytes(uri));
      } catch {
        return undefined;
      }
    }
    return typeof file?.src === "string" && typeof file.content_type === "string" ? { path, uri, label, src: file.src, contentType: file.content_type } : { path, uri, label };
  };
  /** The 0.x tags that are copies of tag `id`. What could not be read, a tag or the whole tree, goes in `refused`. */
  const legacyCopies = async (id: string, refused: string[]): Promise<T.Listing[]> => {
    const prefix = `${roots.legacy}tags/`;
    const copies: T.Listing[] = [];
    try {
      for await (const url of listed(owner, prefix)) {
        const path = pathOf(owner, url);
        let listing = legacyTags.get(path);
        if (listing === undefined) {
          listing = await legacyTag(path);
          if (listing === undefined) {
            // Which v1 tag it copies is unknown without that file, so it may be this one
            refused.push(path);
            continue;
          }
          legacyTags.set(path, listing);
        }
        if (listing === null) continue;
        try {
          deletionPaths({ kind: "tag", id, listings: [listing] });
          copies.push(listing);
        } catch (error) {
          if (!(error instanceof ValidationError)) throw error;
        }
      }
    } catch (error) {
      if (!isRefused(error)) throw error;
      refused.push(prefix);
    }
    return copies;
  };

  return {
    /** The session's own key, bare: whose tree the writes go to. */
    owner,

    /** Posts: create, read the head, edit, list an author's posts, delete. */
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
      /** A new version of the post read as `head`, PUT where `editPost` puts it. An edit id already used in either root is minted again, above the version that holds it. */
      async edit(head: { url: T.UrlArg<"post"> }, post: T.Post, editOptions?: { root?: T.Root | null; slug?: string | null }): Promise<T.BuiltPost> {
        let from: string = head.url;
        let options = editOptions;
        for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt++) {
          const built = editPost(owner, from, post, options);
          const clash = await editTaken(built.id, built.editId);
          if (clash === null) return stored(built);
          // The version found is newer than the head given, so the next id is minted above it,
          // into the root the first try chose
          from = clash;
          options = { ...editOptions, root: parseUri(built.url).root };
        }
        throw new Error(`pubky-social-specs/client: ${MINT_ATTEMPTS} edit ids in a row were taken`);
      },
      /** The newest public version of every post of `author`; one that does not decode is a value with its error. */
      async *list(author: T.Given<"Owner">): AsyncGenerator<Read<T.Post, "post">> {
        const key = parseOwner(author);
        const ids = new Set<string>();
        const prefix = `${roots.public}posts/`;
        // Someone else's tree may hold any file under posts/; only a post version names a post
        for await (const url of listed(key, prefix)) {
          const at = versionOf(url);
          if (at !== null) ids.add(at.id);
        }
        for (const id of ids) {
          const read = await newest(key, id, "public");
          if (read !== null) yield read;
        }
      },
      /**
       * Deletes every version of an own post in both roots, newest last, and its 0.x copy first
       * when there is one. A session not granted the 0.x tree cannot reach that copy: the 1.x
       * versions still go and the path comes back in `legacyRefused`.
       */
      async delete(id: T.Given<"PostId">): Promise<Removed> {
        // Only the post's versions are the post: another file in its directory is no copy of it
        const listings: string[] = [];
        for await (const url of ownVersions(id)) if (isVersion(url)) listings.push(pathOf(owner, url));
        // A migrated post keeps its 0.x copy, which a reindex would read back as the post
        const legacy = `${roots.legacy}posts/${parsePostId(id)}`;
        const refused: string[] = [];
        if (await legacyExists(legacy, refused)) listings.push(legacy);
        return remove(deletionPaths({ kind: "post", id, listings }), refused);
      },
    },

    /** The owner's profile: get anyone's, set or update the owner's. */
    profile: {
      get: (author: T.Given<"Owner"> = owner) => readAt(parseOwner(author), buildUri(author, "user"), "user"),
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

    /** The owner's follows: add, remove, list. */
    follows: {
      async add(followee: T.Given<"Owner">): Promise<T.Built<T.Follow, T.Owner, "follow">> {
        return stored(buildFollow(owner, followee));
      },
      remove: (followee: T.Given<"Owner">) => remove(deletionPaths({ kind: "follow", id: followee })),
      list: (author: T.Given<"Owner"> = owner) => readAll(parseOwner(author), `${roots.public}follows/`, "follow"),
    },

    /**
     * The owner's mutes, private: add, remove, list. `remove` deletes the 0.x copy first; a
     * session not granted the 0.x tree leaves that copy, still deletes the 1.x one and names
     * the path in `legacyRefused`.
     */
    mutes: {
      async add(mutee: T.Given<"Owner">): Promise<T.Built<T.Mute, T.Owner, "mute">> {
        return stored(buildMute(owner, mutee));
      },
      remove: (mutee: T.Given<"Owner">) => remove(deletionPaths({ kind: "mute", id: mutee })),
      list: () => readAll(owner, `${roots.private}mutes/`, "mute"),
    },

    /**
     * The owner's tags: add, remove, list. `add` reads the tag's address first: a tag already
     * there, which another app may have added to, is kept as it is and returned. `remove`
     * deletes the tag's 0.x copies first. Their names do not follow from the id, so it lists
     * the 0.x tags and reads each one once per client: the first removal costs a GET per 0.x
     * tag the owner has, and one per tagged 0.x file, which for another user's file needs
     * `options.publicStorage`. A 0.x tag whose file cannot be read is left and named in
     * `legacyRefused`, as is the directory for a session not granted the 0.x tree: the 1.x
     * tag is deleted either way.
     */
    tags: {
      async add(uri: T.Reference, label: string): Promise<T.Built<T.Tag>> {
        const built = buildTag(owner, uri, label);
        // One tag address is shared by every app of the owner's: a tag already there keeps what
        // the others wrote into it, and only bytes that are no tag are written over
        const there = await orMissing(storage.getBytes(built.path), null);
        if (there === null) return stored(built);
        const read = decoded<T.Tag, "tag">(built.url, "tag", () => decodeObject(built.url, there, "tag"));
        return read.ok ? { ...built, object: read.object, body: new Uint8Array(there) } : stored(built);
      },
      remove: async (id: string): Promise<Removed> => {
        const refused: string[] = [];
        const listings = await legacyCopies(id, refused);
        return remove(deletionPaths({ kind: "tag", id, listings }), refused);
      },
      list: (author: T.Given<"Owner"> = owner) => readAll(parseOwner(author), `${roots.public}tags/`, "tag"),
    },

    /** The owner's bookmarks, private: add, remove, list. */
    bookmarks: {
      async add(target: T.Reference): Promise<T.Built<T.Bookmark>> {
        return stored(buildBookmark(owner, target));
      },
      remove: (id: string) => remove(deletionPaths({ kind: "bookmark", id })),
      list: () => readAll(owner, `${roots.private}bookmarks/`, "bookmark"),
    },

    /** The owner's saved feeds, private: add, remove, list, and publish or unpublish one. */
    feeds: {
      async add(input: T.NewFeed): Promise<T.Built<T.Feed>> {
        return stored(buildFeed(owner, input));
      },
      remove: (id: string) => remove(deletionPaths({ kind: "feed", id })),
      /** Copies the feed to its public address, over whatever is there, and answers that address. */
      async publish(id: string): Promise<T.OwnerPath> {
        const at = feedPaths(id);
        await storage.putBytes(at.public, await storage.getBytes(at.private));
        return at.public;
      },
      /** Deletes the public copy; the feed stays where its owner reads it. */
      unpublish: (id: string) => remove([feedPaths(id).public]),
      list: () => readAll(owner, `${roots.private}feeds/`, "feed"),
    },

    /** Media: upload bytes and read them back by URL. */
    files: {
      /** PUTs media where its hash names it, public unless `root` says otherwise. */
      async upload(bytes: Uint8Array, type: T.MimeType | (string & {}), root: T.Root = "public"): Promise<T.BuiltFile> {
        // One copy, hashed and sent: the caller's view may change while the PUT is in flight.
        // encodeObject refuses a value that is no bytes, which the copy would coerce
        const copy = new Uint8Array(encodeObject({ kind: "file", root }, bytes));
        const built = buildFile(owner, { bytes: copy, type, root });
        await storage.putBytes(built.path, copy);
        return built;
      },
      /** The bytes of media at `url`, checked against the hash that names them; null when absent. */
      async get(url: T.UrlArg<"file">): Promise<Read<T.Bytes, "file"> | null> {
        const parsed = parseUri(url);
        const bytes = await orMissing(reader(parsed.owner).get(parsed.path), null);
        return bytes === null ? null : decoded<T.Bytes, "file">(url, "file", () => decodeObject(url, bytes, "file"));
      },
    },
  };
}

/** What `createSocialClient` gives. */
export type SocialClient = ReturnType<typeof createSocialClient>;
export type { SdkPublicStorage, SdkSession as SocialSession } from "../session.js";
