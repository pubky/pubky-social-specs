// The client subpath over a fake SDK session: what it PUTs, what it reads back, and how a stored
// object that does not decode comes back.

import assert from "assert";
import { createSocialClient } from "./dist/client/index.js";
import { buildPost, decodeObject } from "./dist/index.js";
import { setClock } from "./dist/testing.js";

const OTTO = "8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto";
const RIO = "dzswkfy7ek3bqnoc89jxuqqfbzhjrj6mi8qthgbxxcqkdugm3rio";
const T0 = 1_790_000_000_000;
const encoder = new TextEncoder();
const text = (bytes) => new TextDecoder().decode(bytes);
const notFound = () => Object.assign(new Error("Request failed: 404"), { name: "RequestError", data: { statusCode: 404 } });

// One homeserver for every key: `session.storage` takes owner-relative paths, the public
// storage `<key>/<path>` addresses, both answer a LIST with full URLs and a missing path with 404
const homeserver = () => {
  const store = new Map();
  const calls = [];
  const listing = (prefix, cursor, limit) => {
    const under = [...store.keys()].filter((u) => u.startsWith(prefix)).sort();
    if (under.length === 0) throw notFound();
    return under.filter((u) => cursor === null || u > cursor).slice(0, limit);
  };
  const read = (u) => {
    const bytes = store.get(u);
    if (bytes === undefined) throw notFound();
    return bytes.slice();
  };
  const session = (key) => ({
    info: { publicKey: { z32: () => key } },
    storage: {
      list: async (path, cursor, _r, limit) => (calls.push(["list", path]), listing(`pubky://${key}${path}`, cursor, limit)),
      getBytes: async (path) => read(`pubky://${key}${path}`),
      get: async (path) => new Response(read(`pubky://${key}${path}`)),
      exists: async (path) => store.has(`pubky://${key}${path}`),
      putJson: async (path, body) => void store.set(`pubky://${key}${path}`, encoder.encode(JSON.stringify(body))),
      putBytes: async (path, bytes) => (calls.push(["putBytes", path]), void store.set(`pubky://${key}${path}`, bytes.slice())),
      delete: async (path) => {
        if (!store.delete(`pubky://${key}${path}`)) throw notFound();
      },
    },
  });
  const publicStorage = {
    list: async (address, cursor, _r, limit) => listing(`pubky://${address}`, cursor, limit),
    getBytes: async (address) => read(`pubky://${address}`),
  };
  return { store, calls, session, publicStorage };
};

const all = async (iterable) => {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
};

describe("pubky-social-specs/client", () => {
  beforeEach(() => setClock(() => T0));
  after(() => setClock());

  it("creates a post by PUTting the builder's exact bytes, and reads the newest version back", async () => {
    const hs = homeserver();
    const social = createSocialClient(hs.session(OTTO));
    const post = await social.posts.create({ content: "Hello" });
    assert.deepStrictEqual(hs.store.get(post.url), post.body);
    setClock(() => T0 + 1);
    const head = await social.posts.head(OTTO, post.id);
    assert.ok(head.ok);
    assert.strictEqual(head.object.content, "Hello");
    const edit = await social.posts.edit(head, { ...head.object, content: "Hello, edited" });
    assert.ok(edit.editId > post.editId && edit.id === post.id);
    assert.strictEqual((await social.posts.head(OTTO, post.id)).object.content, "Hello, edited");
    assert.strictEqual(await social.posts.head(OTTO, "0034A0X7NJ52C"), null);
  });

  it("mints again when another copy of the package took the id, in either root", async () => {
    const hs = homeserver();
    const social = createSocialClient(hs.session(OTTO));
    const theirs = buildPost(OTTO, { content: "draft", root: "private" });
    hs.store.set(theirs.url, theirs.body);
    setClock(() => T0);
    const post = await social.posts.create({ content: "mine" });
    assert.notStrictEqual(post.id, theirs.id);
    assert.strictEqual(text(hs.store.get(theirs.url)), text(theirs.body), "the draft is untouched");
  });

  it("lists every post's newest version, a page at a time, an unreadable one as a value", async () => {
    const hs = homeserver();
    const social = createSocialClient(hs.session(OTTO), { pageSize: 2 });
    const posts = [];
    for (let i = 0; i < 3; i++) {
      setClock(() => T0 + i);
      posts.push(await social.posts.create({ content: `post ${i}` }));
    }
    hs.store.set(`pubky://${OTTO}/pub/social/v1/posts/0034A0X7NJ52C/0034A0X7NJ52C.json`, encoder.encode("{not json"));
    const listed = await all(social.posts.list(OTTO));
    assert.strictEqual(listed.length, 4);
    assert.deepStrictEqual(
      listed
        .filter((r) => r.ok)
        .map((r) => r.object.content)
        .sort(),
      ["post 0", "post 1", "post 2"],
    );
    const bad = listed.find((r) => !r.ok);
    assert.ok(bad.error.message.startsWith("Validation Error: "));
    assert.deepStrictEqual(await all(createSocialClient(hs.session(RIO)).posts.list(RIO)), []);
  });

  it("deletes every version of a post in both roots", async () => {
    const hs = homeserver();
    const social = createSocialClient(hs.session(OTTO));
    const post = await social.posts.create({ content: "x" });
    setClock(() => T0 + 1);
    await social.posts.edit({ url: post.url }, { ...post.object, content: "y" }, { root: "private" });
    await social.posts.delete(post.id);
    assert.deepStrictEqual(
      [...hs.store.keys()].filter((u) => u.includes(post.id)),
      [],
    );
  });

  it("reads another user's tree through the public storage, and only through it", async () => {
    const hs = homeserver();
    const rio = createSocialClient(hs.session(RIO));
    const post = await rio.posts.create({ content: "from rio" });
    await rio.profile.set({ name: "Rio" });
    await assert.rejects(createSocialClient(hs.session(OTTO)).posts.head(RIO, post.id), /needs options\.publicStorage/);
    const otto = createSocialClient(hs.session(OTTO), { publicStorage: hs.publicStorage });
    assert.strictEqual((await otto.posts.head(RIO, post.id)).object.content, "from rio");
    assert.strictEqual((await otto.profile.get(RIO)).object.name, "Rio");
    assert.strictEqual(await otto.profile.get(), null);
  });

  it("keeps a profile's unknown members through an update", async () => {
    const hs = homeserver();
    const social = createSocialClient(hs.session(OTTO));
    hs.store.set(`pubky://${OTTO}/pub/social/v1/profile.json`, encoder.encode('{"name":"Otto","bio":null,"image":null,"links":null,"status":null,"pronouns":"he"}'));
    const read = await social.profile.get();
    await social.profile.update({ ...read.object, bio: "new" });
    assert.strictEqual(text(hs.store.get(`pubky://${OTTO}/pub/social/v1/profile.json`)), '{"name":"Otto","bio":"new","image":null,"links":null,"status":null,"pronouns":"he"}');
  });

  it("adds, lists and removes follows, mutes, tags, bookmarks and feeds", async () => {
    const hs = homeserver();
    const social = createSocialClient(hs.session(OTTO));
    await social.follows.add(RIO);
    await social.mutes.add(RIO);
    const tag = await social.tags.add("https://example.com", "Rust");
    const bookmark = await social.bookmarks.add("https://example.com");
    const feed = await social.feeds.add({ name: "Feed", icon: "star", reach: "all", layout: "columns", sort: "recent" });
    const lists = await Promise.all([social.follows.list(), social.mutes.list(), social.tags.list(), social.bookmarks.list(), social.feeds.list()].map(all));
    assert.deepStrictEqual(
      lists.map((l) => l.length),
      [1, 1, 1, 1, 1],
    );
    assert.strictEqual(lists[2][0].object.label, "rust");
    await social.follows.remove(RIO);
    await social.mutes.remove(RIO);
    await social.tags.remove(tag.id);
    await social.bookmarks.remove(bookmark.id);
    await social.feeds.remove(feed.id);
    assert.deepStrictEqual([...hs.store.keys()], []);
    // Removing what is not there is no error
    await social.follows.remove(RIO);
  });

  it("uploads media where its hash names it, and checks the bytes it reads", async () => {
    const hs = homeserver();
    const social = createSocialClient(hs.session(OTTO));
    const bytes = encoder.encode("png bytes");
    const file = await social.files.upload(bytes, "image/png");
    assert.deepStrictEqual((await social.files.get(file.url)).object, bytes);
    hs.store.set(file.url, encoder.encode("other bytes"));
    const tampered = await social.files.get(file.url);
    assert.ok(!tampered.ok && /Invalid ID/.test(tampered.error.message));
    hs.store.delete(file.url);
    assert.strictEqual(await social.files.get(file.url), null);
    assert.deepStrictEqual(decodeObject(file.url, bytes, "file"), bytes);
  });

  it("refuses a page size the homeserver cannot serve", () => {
    for (const pageSize of [0, 1001, 1.5]) assert.throws(() => createSocialClient(homeserver().session(OTTO), { pageSize }), RangeError);
  });
});
