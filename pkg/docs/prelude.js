// What the code blocks of these docs share: two example keys and an in-memory stand-in for a
// signed-in session of @synonymdev/pubky, so every block runs as pasted with no homeserver.
// In an app, `session` comes from the SDK's sign-in and `publicStorage` is
// `pubky.publicStorage`; the calls below have the names, arguments and answers of SDK 0.14,
// a missing directory or file included (a RequestError with `data.statusCode` 404).

/** The signed-in user: a bare z-base32 key, 52 characters, no `pubky://`. */
export const owner = "8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto";
/** Another user, to follow, reply to and read. */
export const friend = "dzswkfy7ek3bqnoc89jxuqqfbzhjrj6mi8qthgbxxcqkdugm3rio";

// Every stored file of every user, by full `pubky://` URL
const files = new Map();

const notFound = (url) => Object.assign(new Error(`404 Not Found: ${url}`), { name: "RequestError", data: { statusCode: 404 } });

/**
 * @param {string} prefix
 * @param {string | null | undefined} cursor
 * @param {boolean | undefined} reverse
 * @param {number | null | undefined} limit
 * @returns {string[]}
 */
function listed(prefix, cursor, reverse, limit) {
  if (!prefix.endsWith("/")) throw Object.assign(new Error(`a LIST path ends with /: ${prefix}`), { name: "InvalidInput" });
  const urls = [...files.keys()].filter((url) => url.startsWith(prefix)).sort();
  if (urls.length === 0) throw notFound(prefix);
  if (reverse) urls.reverse();
  const after = cursor ? urls.findIndex((url) => url === cursor) + 1 : 0;
  return urls.slice(after, after + (limit ?? 1000));
}

/** @param {string} key */
function storageOf(key) {
  /** @param {string} path */
  const url = (path) => `pubky://${key}${path}`;
  /** @param {string} path */
  const getBytes = async (path) => {
    const bytes = files.get(url(path));
    if (bytes === undefined) throw notFound(url(path));
    return bytes;
  };
  return {
    putBytes: async (path, bytes) => void files.set(url(path), new Uint8Array(bytes)),
    putJson: async (path, body) => void files.set(url(path), new TextEncoder().encode(JSON.stringify(body))),
    getBytes,
    get: async (path) => {
      const bytes = await getBytes(path);
      return new Response(bytes, { headers: { "content-length": String(bytes.length) } });
    },
    exists: async (path) => files.has(url(path)),
    delete: async (path) => void files.delete(url(path)),
    /** @type {(path: string, cursor?: string | null, reverse?: boolean, limit?: number | null) => Promise<string[]>} */
    list: async (path, cursor, reverse, limit) => listed(url(path), cursor, reverse, limit),
  };
}

/** @typedef {import("pubky-social-specs/migration/pubky-sdk").SdkSession & { info: { capabilities: string[] } }} Session */

/**
 * A signed-in session of `owner`, as the SDK's `Session`: `info` and `storage`.
 * @type {Session}
 */
export const session = {
  info: { publicKey: { z32: () => owner }, capabilities: ["/pub/social/v1/:rw", "/priv/social/v1/:rw"] },
  storage: storageOf(owner),
};

/**
 * A session of `friend`, so a block can put something in another user's tree.
 * @type {Session}
 */
export const friendSession = {
  info: { publicKey: { z32: () => friend }, capabilities: ["/pub/social/v1/:rw", "/priv/social/v1/:rw"] },
  storage: storageOf(friend),
};

/** Anyone's public tree by `pubky://` address, as the SDK's `pubky.publicStorage`. */
export const publicStorage = {
  /** @type {(address: string, cursor?: string | null, reverse?: boolean, limit?: number | null) => Promise<string[]>} */
  list: async (address, cursor, reverse, limit) => listed(address, cursor, reverse, limit),
  /** @param {string} address */
  getBytes: async (address) => {
    const bytes = files.get(address);
    if (bytes === undefined || !address.includes("/pub/")) throw notFound(address);
    return bytes;
  },
};
