// The client subpath over a fake SDK session: what it PUTs, what it reads back, and how a stored
// object that does not decode comes back.

import assert from "assert";
import { createSocialClient } from "./dist/client/index.js";
import { ArgumentError, buildFile, buildPost, editPost } from "./dist/index.js";
import { setClock } from "./dist/testing.js";
import { OTTO, RIO, T0, text } from "./core.fixture.js";
import { answered, fakeHomeserver } from "./sdk.fixture.js";

const encoder = new TextEncoder();

// A homeserver, and a client of OTTO on it
const ottoClient = (options) => {
  const hs = fakeHomeserver();
  return { hs, social: createSocialClient(hs.session(OTTO), options) };
};

const all = async (iterable) => {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
};

describe("pubky-social-specs/client", () => {
  beforeEach(() => setClock(() => T0));
  after(() => setClock());

  it("creates a post by PUTting the builder's exact bytes, and reads it back as the head", async () => {
    const { hs, social } = ottoClient();
    const post = await social.posts.create({ content: "Hello" });
    assert.deepStrictEqual(hs.store.get(post.url), post.body);
    const head = await social.posts.head(OTTO, post.id);
    assert.ok(head.ok);
    assert.strictEqual(head.object.content, "Hello");
  });

  it("an edit is a new version of the same post, and the head reads it", async () => {
    const { social } = ottoClient();
    const post = await social.posts.create({ content: "Hello" });
    setClock(() => T0 + 1);
    const head = await social.posts.head(OTTO, post.id);
    const edit = await social.posts.edit(head, { ...head.object, content: "Hello, edited" });
    assert.ok(edit.editId > post.editId && edit.id === post.id);
    assert.strictEqual((await social.posts.head(OTTO, post.id)).object.content, "Hello, edited");
  });

  it("the head skips what a LIST of the post gives that is no version of it", async () => {
    const { hs, social } = ottoClient();
    const post = await social.posts.create({ content: "Hello" });
    for (const leaf of ["a b", "notes.txt"]) hs.store.set(`pubky://${OTTO}/pub/social/v1/posts/${post.id}/${leaf}`, encoder.encode("{}"));
    assert.strictEqual((await social.posts.head(OTTO, post.id)).object.content, "Hello");
  });

  it("a LIST the homeserver fails is thrown, never read as an empty tree", async () => {
    const session = fakeHomeserver().session(OTTO);
    session.storage.list = async () => {
      throw answered(500, "Internal Server Error");
    };
    await assert.rejects(all(createSocialClient(session).posts.list(OTTO)), (e) => e.data.statusCode === 500);
  });

  it("walks past a server that caps the page lower, and refuses a cursor that does not advance", async () => {
    const hs = fakeHomeserver();
    const session = hs.session(OTTO);
    const social = createSocialClient(session);
    for (let i = 0; i < 3; i++) {
      setClock(() => T0 + i);
      await social.posts.create({ content: `post ${i}` });
    }
    // A proxy that answers one URL a page, whatever the limit asked
    const list = session.storage.list;
    session.storage.list = async (...args) => (await list(...args)).slice(0, 1);
    assert.strictEqual((await all(social.posts.list(OTTO))).length, 3);
    // A server that ignores the cursor answers the same page forever
    session.storage.list = async (path, _cursor, ...rest) => list(path, null, ...rest);
    await assert.rejects(all(social.posts.list(OTTO)), /does not advance/);
  });

  it("the head of a post with no version is null", async () => {
    assert.strictEqual(await ottoClient().social.posts.head(OTTO, "0034A0X7NJ52C"), null);
  });

  it("mints again when another copy of the package took the id, in either root", async () => {
    const { hs, social } = ottoClient();
    const theirs = buildPost(OTTO, { content: "draft", root: "private" });
    hs.store.set(theirs.url, theirs.body);
    setClock(() => T0);
    const post = await social.posts.create({ content: "mine" });
    assert.notStrictEqual(post.id, theirs.id);
    assert.strictEqual(text(hs.store.get(theirs.url)), text(theirs.body), "the draft is untouched");
  });

  it("lists every post's newest version, a page at a time, an unreadable one as a value", async () => {
    const { hs, social } = ottoClient({ pageSize: 2 });
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

  it("mints an edit again when another copy of the package took the edit id, in either root", async () => {
    const { hs, social } = ottoClient();
    const post = await social.posts.create({ content: "x" });
    setClock(() => T0 + 1);
    const theirs = editPost(OTTO, post.url, { ...post.object, content: "theirs" }, { root: "private" });
    hs.store.set(theirs.url, theirs.body);
    setClock(() => T0 + 1);
    const edit = await social.posts.edit({ url: post.url }, { ...post.object, content: "mine" });
    assert.ok(edit.editId > theirs.editId);
    assert.strictEqual(text(hs.store.get(theirs.url)), text(theirs.body), "their version is untouched");
  });

  it("mints an edit above the version that took its id when the clock is not past the head", async () => {
    const { hs, social } = ottoClient();
    const post = await social.posts.create({ content: "x" });
    // The clock stands still, so the bytes pick the id and a second try from the same head picks it again
    const theirs = editPost(OTTO, post.url, { ...post.object, content: "same" }, { root: "private" });
    hs.store.set(theirs.url, theirs.body);
    const edit = await social.posts.edit({ url: post.url }, { ...post.object, content: "same" });
    assert.ok(edit.editId > theirs.editId);
    assert.ok(edit.path.startsWith("/pub/"), "the root is the given head's, not the taken version's");
    assert.deepStrictEqual(hs.store.get(edit.url), edit.body);
  });

  it("removes a tag with its 0.x copies, found by reading the 0.x tags once", async () => {
    const hs = fakeHomeserver();
    const session = hs.session(OTTO);
    const social = createSocialClient(session);
    const legacy = (id) => `pubky://${OTTO}/pub/pubky.app/tags/${id}`;
    const json = (value) => encoder.encode(JSON.stringify(value));
    // A 0.x tag id is the hash of its uri and label, the hash media goes by
    const idOf = (uri, label) => buildFile(OTTO, { bytes: encoder.encode(`${uri}:${label}`), type: "" }).id;

    const tag = await social.tags.add("https://example.com/a", "rust");
    // A 0.x tag of the same target and label: its 0.x id spells the same input
    const copy = legacy(idOf(tag.object.uri, "rust"));
    hs.store.set(copy, json({ uri: tag.object.uri, label: "rust", created_at: 1 }));
    // A tag on a 0.x File object is the v1 tag on the media that object names
    const hash = buildFile(OTTO, { bytes: encoder.encode("png"), type: "image/png" }).id;
    const file = `pubky://${OTTO}/pub/pubky.app/files/0034A0X7NJ52C`;
    hs.store.set(file, json({ src: `pubky://${OTTO}/pub/pubky.app/blobs/${hash}`, content_type: "image/png" }));
    const onMedia = await social.tags.add(`pubky://${OTTO}/pub/social/v1/files/${hash}.png`, "rust");
    const onFile = legacy(idOf(file, "rust"));
    hs.store.set(onFile, json({ uri: file, label: "rust", created_at: 1 }));
    // Another tag, and bytes that are no tag, stay
    const other = legacy(idOf("https://example.com/b", "rust"));
    hs.store.set(other, json({ uri: "https://example.com/b", label: "rust", created_at: 1 }));
    hs.store.set(legacy("junk"), encoder.encode("{"));

    assert.deepStrictEqual(await social.tags.remove(tag.id), { legacyRefused: [] });
    assert.ok(!hs.store.has(copy) && !hs.store.has(tag.url));
    const gets = () => session.storage.calls.filter(([op]) => op === "getBytes").length;
    const reads = gets();
    assert.deepStrictEqual(await social.tags.remove(onMedia.id), { legacyRefused: [] });
    assert.ok(!hs.store.has(onFile) && !hs.store.has(onMedia.url));
    assert.strictEqual(gets(), reads, "a 0.x tag is read once");
    assert.deepStrictEqual([...hs.store.keys()].sort(), [file, legacy("junk"), other].sort());
  });

  it("deletes a post oldest version first, one DELETE after the other, and stops where one fails", async () => {
    const hs = fakeHomeserver();
    const session = hs.session(OTTO);
    const social = createSocialClient(session);
    const post = await social.posts.create({ content: "x" });
    setClock(() => T0 + 1);
    const draft = await social.posts.edit({ url: post.url }, { ...post.object, content: "y" }, { root: "private" });
    setClock(() => T0 + 2);
    const last = await social.posts.edit({ url: post.url }, { ...post.object, content: "z" });
    const storage = session.storage;
    const deletes = () => storage.calls.filter(([op]) => op === "delete").map(([, path]) => path);
    // The second DELETE fails: the first is done, the third is never sent
    const remove = storage.delete;
    storage.delete = async (path) => {
      if (path === draft.path) throw (storage.calls.push(["delete", path]), answered(500));
      return remove(path);
    };
    await assert.rejects(social.posts.delete(post.id), (e) => e.data.statusCode === 500);
    assert.deepStrictEqual(deletes(), [post.path, draft.path]);
    assert.ok(hs.store.has(last.url) && !hs.store.has(post.url));
    // Run again, it goes on from what is left
    storage.delete = remove;
    storage.calls.length = 0;
    assert.deepStrictEqual(await social.posts.delete(post.id), { legacyRefused: [] });
    assert.deepStrictEqual(deletes(), [draft.path, last.path]);
  });

  it("deletes every version of a post in both roots", async () => {
    const { hs, social } = ottoClient();
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
    const hs = fakeHomeserver();
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
    const { hs, social } = ottoClient();
    hs.store.set(`pubky://${OTTO}/pub/social/v1/profile.json`, encoder.encode('{"name":"Otto","bio":null,"image":null,"links":null,"status":null,"pronouns":"he"}'));
    const read = await social.profile.get();
    await social.profile.update({ ...read.object, bio: "new" });
    assert.strictEqual(text(hs.store.get(`pubky://${OTTO}/pub/social/v1/profile.json`)), '{"name":"Otto","bio":"new","image":null,"links":null,"status":null,"pronouns":"he"}');
  });

  it("adds, lists and removes follows, mutes, tags, bookmarks and feeds", async () => {
    const { hs, social } = ottoClient();
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
    const { hs, social } = ottoClient();
    const bytes = encoder.encode("png bytes");
    const file = await social.files.upload(bytes, "image/png");
    assert.deepStrictEqual((await social.files.get(file.url)).object, bytes);
    hs.store.set(file.url, encoder.encode("other bytes"));
    const tampered = await social.files.get(file.url);
    assert.ok(!tampered.ok && /Invalid ID/.test(tampered.error.message));
    hs.store.delete(file.url);
    assert.strictEqual(await social.files.get(file.url), null);
  });

  it("refuses a page size the homeserver cannot serve", () => {
    for (const pageSize of [0, 1001, 1.5]) assert.throws(() => createSocialClient(fakeHomeserver().session(OTTO), { pageSize }), RangeError);
  });
});

describe("the client over memoryHomeserver", () => {
  it("unmutes with a session not granted the 0.x tree: the 1.x mute still goes", async () => {
    const { memoryHomeserver } = await import("./dist/testing.js");
    const { friend, owner, session } = memoryHomeserver();
    const social = createSocialClient(session);
    const mute = await social.mutes.add(friend);
    await session.storage.putBytes(`/pub/pubky.app/mutes/${friend}`, new Uint8Array([1]));
    const remove = session.storage.delete;
    session.storage.delete = async (path) => {
      if (path.startsWith("/pub/pubky.app/")) throw Object.assign(new Error("403"), { data: { statusCode: 403 } });
      return remove(path);
    };
    assert.deepStrictEqual(await social.mutes.remove(friend), { legacyRefused: [`/pub/pubky.app/mutes/${friend}`] });
    assert.strictEqual(await session.storage.exists(mute.path), false);
    void owner;
  });

  it("removes a tag with a session refused the 0.x tree: the 1.x tag goes and the directory is named", async () => {
    const { memoryHomeserver } = await import("./dist/testing.js");
    const { session } = memoryHomeserver();
    const social = createSocialClient(session);
    const tag = await social.tags.add("https://example.com/a", "rust");
    const list = session.storage.list;
    session.storage.list = async (path, ...rest) => {
      if (path.startsWith("/pub/pubky.app/")) throw Object.assign(new Error("403"), { data: { statusCode: 403 } });
      return list(path, ...rest);
    };
    assert.deepStrictEqual(await social.tags.remove(tag.id), { legacyRefused: ["/pub/pubky.app/tags/"] });
    assert.strictEqual(await session.storage.exists(tag.path), false);
  });

  it("deletes a post with a session refused the 0.x tree, probe included: the 1.x versions still go", async () => {
    const { memoryHomeserver } = await import("./dist/testing.js");
    const { session } = memoryHomeserver();
    const social = createSocialClient(session);
    const post = await social.posts.create({ content: "hello" });
    const refuse =
      (call) =>
      async (path, ...rest) => {
        if (path.startsWith("/pub/pubky.app/")) throw Object.assign(new Error("403"), { data: { statusCode: 403 } });
        return call(path, ...rest);
      };
    session.storage.exists = refuse(session.storage.exists);
    session.storage.delete = refuse(session.storage.delete);
    // The copy it could not look for is named: it may still be there
    assert.deepStrictEqual(await social.posts.delete(post.id), { legacyRefused: [`/pub/pubky.app/posts/${post.id}`] });
    assert.strictEqual(await session.storage.exists(post.path), false);
  });

  it("uploads only bytes: a number or an array is refused, never coerced", async () => {
    const { memoryHomeserver } = await import("./dist/testing.js");
    const { session } = memoryHomeserver();
    const social = createSocialClient(session);
    for (const value of [4, [1, 2]]) await assert.rejects(social.files.upload(value, "image/png"), (e) => e instanceof ArgumentError);
    assert.strictEqual(text(await session.storage.getBytes((await social.files.upload(new Uint8Array([104, 105]), "text/plain")).path)), "hi");
  });

  it("adds a tag without writing over one already at its address", async () => {
    const { memoryHomeserver } = await import("./dist/testing.js");
    const { session } = memoryHomeserver();
    const social = createSocialClient(session);
    const first = await social.tags.add("https://example.com/a", "rust");
    // Another app of the owner's added a member to the same tag
    const theirs = new TextEncoder().encode(text(first.body).replace(/}$/, ',"by":"other"}'));
    await session.storage.putBytes(first.path, theirs);
    const again = await social.tags.add("https://example.com/a", "rust");
    assert.strictEqual(text(await session.storage.getBytes(first.path)), text(theirs));
    assert.strictEqual(text(again.body), text(theirs));
  });

  it("deletes a migrated post's 0.x copy with its versions", async () => {
    const { memoryHomeserver } = await import("./dist/testing.js");
    const { session } = memoryHomeserver();
    const social = createSocialClient(session);
    const post = await social.posts.create({ content: "migrated" });
    await session.storage.putBytes(`/pub/pubky.app/posts/${post.id}`, new Uint8Array([1]));
    assert.deepStrictEqual(await social.posts.delete(post.id), { legacyRefused: [] });
    assert.strictEqual(await session.storage.exists(`/pub/pubky.app/posts/${post.id}`), false);
    assert.strictEqual(await session.storage.exists(post.path), false);
  });

  it("refuses a LIST answer outside the tree it asked about", async () => {
    const { memoryHomeserver } = await import("./dist/testing.js");
    const { friend, friendSession, owner, publicStorage, session } = memoryHomeserver();
    const post = await createSocialClient(friendSession).posts.create({ content: "mine" });
    // The friend's homeserver passes its bytes off under the owner's tree
    const list = publicStorage.list;
    publicStorage.list = async (address, ...rest) => (await list(address, ...rest)).map((url) => url.replace(friend, owner));
    const social = createSocialClient(session, { publicStorage });
    await assert.rejects(social.posts.head(friend, post.id), /outside it/);
  });

  it("deletes a post's versions with another file in its directory", async () => {
    const { memoryHomeserver } = await import("./dist/testing.js");
    const { session } = memoryHomeserver();
    const social = createSocialClient(session);
    const post = await social.posts.create({ content: "gone" });
    await session.storage.putBytes(`/pub/social/v1/posts/${post.id}/notes.txt`, new Uint8Array([1]));
    await social.posts.delete(post.id);
    assert.strictEqual(await session.storage.exists(post.path), false);
  });

  it("pages past a cursor that was deleted since it was handed out", async () => {
    const { memoryHomeserver } = await import("./dist/testing.js");
    const { session } = memoryHomeserver();
    for (const name of ["a", "b", "c", "d"]) await session.storage.putBytes(`/pub/x/${name}`, new Uint8Array([1]));
    const [first, second] = await session.storage.list("/pub/x/", null, false, 2);
    await session.storage.delete(second.slice(second.indexOf("/pub/")));
    assert.deepStrictEqual(
      (await session.storage.list("/pub/x/", second, false, 2)).map((u) => u.slice(-1)),
      ["c", "d"],
    );
    assert.deepStrictEqual(
      (await session.storage.list("/pub/x/", second, true)).map((u) => u.slice(-1)),
      ["a"],
    );
    void first;
  });

  it("lists another user's posts past any file in posts/ that names no post", async () => {
    const { memoryHomeserver } = await import("./dist/testing.js");
    const { friend, friendSession, publicStorage, session } = memoryHomeserver();
    await createSocialClient(friendSession).posts.create({ content: "kept" });
    await friendSession.storage.putBytes("/pub/social/v1/posts/not-an-id/x.json", new Uint8Array([1]));
    await friendSession.storage.putBytes("/pub/social/v1/posts/README", new Uint8Array([1]));
    const read = [];
    for await (const post of createSocialClient(session, { publicStorage }).posts.list(friend)) if (post.ok) read.push(post.object.content);
    assert.deepStrictEqual(read, ["kept"]);
  });

  it("uploads the very bytes it hashed, whatever happens to the caller's view after", async () => {
    const { memoryHomeserver } = await import("./dist/testing.js");
    const { owner, session } = memoryHomeserver();
    const sent = [];
    const put = session.storage.putBytes;
    session.storage.putBytes = (path, bytes) => (sent.push(bytes), put(path, bytes));
    const bytes = new Uint8Array([1, 2, 3]);
    const file = await createSocialClient(session).files.upload(bytes, "image/png");
    bytes[0] = 9;
    assert.notStrictEqual(sent[0], bytes);
    assert.deepStrictEqual([...sent[0]], [1, 2, 3]);
    assert.strictEqual(file.url.startsWith(`pubky://${owner}/pub/social/v1/files/`), true);
  });

  it("refuses a LIST answer that is no list of URLs", async () => {
    const { memoryHomeserver } = await import("./dist/testing.js");
    const { owner, session } = memoryHomeserver();
    const social = createSocialClient(session);
    const post = await social.posts.create({ content: "mine" });
    for (const [answer, message] of [
      [[7], /returned 7, outside it/],
      [[undefined], /returned undefined, outside it/],
      ["pubky://", /returned no list/],
    ]) {
      const list = session.storage.list;
      session.storage.list = async () => answer;
      await assert.rejects(social.posts.head(owner, post.id), message);
      session.storage.list = list;
    }
  });

  it("never asks a server for someone else's private tree", async () => {
    const { memoryHomeserver } = await import("./dist/testing.js");
    const { friend, publicStorage, session } = memoryHomeserver();
    const asked = [];
    const list = publicStorage.list;
    publicStorage.list = (address, ...rest) => (asked.push(address), list(address, ...rest));
    const social = createSocialClient(session, { publicStorage });
    await assert.rejects(social.posts.head(friend, "0034A0X7NJ52C", "private"), /read by its owner only/);
    assert.deepStrictEqual(asked, []);
  });

  it("checks a post id and a root before a LIST names a directory with them", async () => {
    const { memoryHomeserver } = await import("./dist/testing.js");
    const { ValidationError } = await import("./dist/index.js");
    const { owner, session } = memoryHomeserver();
    const listed = [];
    const list = session.storage.list;
    session.storage.list = (path, ...rest) => (listed.push(path), list(path, ...rest));
    const social = createSocialClient(session);
    for (const call of [() => social.posts.head(owner, "../../priv"), () => social.posts.delete("0034A0X7NJ52C/.."), () => social.posts.head(owner, "0034A0X7NJ52C", "elsewhere")]) {
      await assert.rejects(call(), (e) => e instanceof ValidationError);
    }
    assert.deepStrictEqual(listed, []);
  });

  it("reads another user's tree through public storage, addressed as the SDK takes it", async () => {
    const { memoryHomeserver } = await import("./dist/testing.js");
    const { createSocialClient } = await import("./dist/client/index.js");
    const { friend, friendSession, publicStorage, session } = memoryHomeserver();
    const theirs = createSocialClient(friendSession);
    await theirs.posts.create({ content: "from a friend" });
    const mine = createSocialClient(session, { publicStorage });
    const read = [];
    for await (const post of mine.posts.list(friend)) if (post.ok) read.push(post.object.content);
    assert.deepStrictEqual(read, ["from a friend"]);
  });
});
