// The pubky SDK as the client and the migration adapter meet it, over a map of URLs. The calls
// and answers are the ones the `pubky.d.ts` of `@synonymdev/pubky` 0.11.0 and 0.14.0 declare: a
// LIST of a directory with nothing under it, a GET or a DELETE of a missing file throw 404,
// `exists` gives false.

const encoder = new TextEncoder();

// What the SDK throws for a refused request: a RequestError carrying the status and the body
export const answered = (status, body = "") =>
  Object.assign(new Error(`Request failed: Server responded with an error: ${status} - ${body}`), {
    name: "RequestError",
    data: { statusCode: status },
  });

// `session.storage` of `owner`, which takes owner-relative paths, every call recorded in `calls`
export const fakeStorage = (owner, store = new Map()) => {
  const calls = [];
  const full = (path) => `pubky://${owner}${path}`;
  const record = (op, ...args) => calls.push([op, ...args]);
  const read = (path) => {
    const bytes = store.get(full(path));
    if (bytes === undefined) throw answered(404, "Not Found");
    return bytes.slice();
  };
  return {
    store,
    calls,
    async list(path, cursor, reverse, limit, shallow) {
      record("list", path, cursor, reverse, limit, shallow);
      return listing(store, full(path), cursor, limit);
    },
    async getBytes(path) {
      record("getBytes", path);
      return read(path);
    },
    async get(path) {
      record("get", path);
      return new Response(read(path));
    },
    async exists(path) {
      record("exists", path);
      return store.has(full(path));
    },
    async putJson(path, body) {
      record("putJson", path);
      store.set(full(path), encoder.encode(JSON.stringify(body)));
    },
    async putBytes(path, bytes) {
      record("putBytes", path);
      store.set(full(path), bytes.slice());
    },
    async delete(path) {
      record("delete", path);
      if (!store.delete(full(path))) throw answered(404, "Not Found");
    },
  };
};

// A full URL per entry, after `cursor`, at most `limit`
const listing = (store, prefix, cursor, limit) => {
  const under = [...store.keys()].filter((u) => u.startsWith(prefix)).sort();
  if (under.length === 0) throw answered(404, "Directory Not Found");
  return under.filter((u) => cursor === null || u > cursor).slice(0, limit);
};

// A signed-in session of `owner` over `storage`
export const sessionOf = (owner, storage = fakeStorage(owner)) => ({ info: { publicKey: { z32: () => owner } }, storage });

// One homeserver for every key: a session per key, and `pubky.publicStorage`, which takes an
// address as the SDK does, `pubky://<key>/<path>` or `pubky<key>/<path>`, and nothing else
const addressed = (address) => {
  if (address.startsWith("pubky://")) return address;
  if (address.startsWith("pubky")) return `pubky://${address.slice(5)}`;
  throw Object.assign(new Error(`not a pubky address: ${address}`), { name: "InvalidInput" });
};
export const fakeHomeserver = () => {
  const store = new Map();
  const publicStorage = {
    list: async (address, cursor, _reverse, limit) => listing(store, addressed(address), cursor, limit),
    getBytes: async (address) => {
      const bytes = store.get(addressed(address));
      if (bytes === undefined) throw answered(404, "Not Found");
      return bytes.slice();
    },
  };
  return { store, session: (key) => sessionOf(key, fakeStorage(key, store)), publicStorage };
};
