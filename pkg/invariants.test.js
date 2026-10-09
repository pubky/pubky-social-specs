// Invariants a consumer relies on that no single rule states: bytes a hostile prototype cannot
// change, a clock that never steps back, round trips that hold byte for byte, and one meaning
// for each URL.

import assert from "assert";
import * as specs from "./dist/index.js";
import { setClock } from "./dist/testing.js";
import { OTTO, RIO, T0, caught, refuses, text, utf8 } from "./core.fixture.js";

const { buildFile, buildFollow, buildPost, buildUser, decodeObject, encodeObject, planPublish } = specs;

// One of everything a builder writes or a reader accepts, as bytes
function corpus() {
  const user = buildUser(OTTO, { name: 'Ann "the" \\ \n\t\u0001', bio: "é😀" });
  const post = buildPost(OTTO, { content: 'quote " back \\ nl \n tab \t ctl \u0002', parent: `pubky://${RIO}/pub/social/v1/posts/0035QZPT4QG00` });
  const article = buildPost(OTTO, { kind: "article", title: 'T"', body: "b\\\n", slug: "a-b" });
  const decoded = decodeObject(post.url, post.body, "post");
  return [user.body, post.body, article.body, encodeObject(post.url, decoded)].map(text);
}

describe("invariants", () => {
  beforeEach(() => setClock(() => T0));
  after(() => setClock());

  it("a polluted Object.prototype changes no byte written and no value read", () => {
    const clean = corpus();
    const keys = [...Array.from({ length: 256 }, (_, i) => String.fromCharCode(i)), ...Array.from({ length: 256 }, (_, i) => String(i))];
    const added = keys.filter((key) => !(key in Object.prototype));
    try {
      for (const key of added) Object.prototype[key] = "POLLUTED";
      assert.deepStrictEqual(corpus(), clean);
      const bytes = utf8('{"content":"a\\"b\\\\c\\/d\\n","kind":"note","parent":null,"embed":null,"attachments":[]}');
      const read = decodeObject(`pubky://${OTTO}/pub/social/v1/posts/0035QZPT4QG00/0035QZPT4QG00.json`, bytes, "post");
      assert.strictEqual(read.content, 'a"b\\c/d\n');
    } finally {
      for (const key of added) delete Object.prototype[key];
    }
  });

  it("a known key seen twice is refused as it is read, before its colon", () => {
    // Found by the coverage-guided fuzzer: the reference judges the key before what follows it
    const url = `pubky://${OTTO}/pub/social/v1/tags/8Z8CWH8NVYQY39ZEBFGKQWWEKG.json`;
    refuses(() => decodeObject(url, utf8('{"uri":"a","uri"x}')), "Validation Error: duplicate field `uri`");
    refuses(() => decodeObject(url, utf8('{"x":1,"x"y}')), "Validation Error: expected `:`");
  });

  it("a builder reads the shape of every member before it judges a name", () => {
    // Found by the coverage-guided fuzzer: the reference reads the whole input first
    assert.throws(
      () => specs.buildFeed(OTTO, { reach: "all", layout: "griran", name: "n", icon: "a" }),
      (e) => e instanceof specs.ArgumentError && e.field === "input.sort",
    );
    assert.throws(
      () => buildPost(OTTO, { kind: "poll", content: "x", attachments: [{ uri: 1 }] }),
      (e) => e instanceof specs.ArgumentError && e.field === "input.attachments[0].uri",
    );
  });

  it("an encode never writes what a decode refuses, however deep an unknown member nests", () => {
    const url = `pubky://${OTTO}/pub/social/v1/posts/0035QZPT4QG00/0035QZPT4QG00.json`;
    const post = (n) => ({
      content: "x",
      kind: "note",
      parent: null,
      embed: null,
      lock: null,
      attachments: [{ uri: "https://a.example", alt: null, name: null, $unknown: `{"x":${"[".repeat(n)}${"]".repeat(n)}}` }],
    });
    assert.ok(decodeObject(url, encodeObject(url, post(124))));
    refuses(() => encodeObject(url, post(125)), "Validation Error: recursion limit exceeded");
  });

  it("every refusal of an edit's head names it", () => {
    for (const head of ["https://example.com/x", `pubky://${OTTO}/pub/social/v1/../x`]) assert.strictEqual(caught(() => specs.editPost(OTTO, head, {})).field, "headUri");
  });

  it("bytes in shared memory are copied before they are read", () => {
    const user = buildUser(OTTO, { name: "Ann" });
    const shared = new Uint8Array(new SharedArrayBuffer(user.body.length));
    shared.set(user.body);
    assert.strictEqual(decodeObject(user.url, shared, "user").name, "Ann");
    const file = buildFile(OTTO, { bytes: shared, type: "image/png" });
    shared[0] = 0;
    assert.strictEqual(file.id, buildFile(OTTO, { bytes: user.body, type: "image/png" }).id);
  });

  it("created_at never steps back between two reads of the wall clock", () => {
    setClock();
    let last = 0;
    for (let i = 0; i < 20_000; i++) {
      const at = buildFollow(OTTO, RIO).object.created_at;
      assert.ok(at >= last, `created_at stepped back from ${last} to ${at}`);
      last = at;
    }
  });

  it("a bare owner URL names a user, never a stored object", () => {
    const user = buildUser(OTTO, { name: "Ann" });
    for (const url of [`pubky://${OTTO}`, `pubky${OTTO}`]) {
      refuses(() => decodeObject(url, user.body), `Validation Error: a bare owner URL names a user, not a stored object: ${url}`);
      refuses(() => encodeObject(url, user.object), `Validation Error: a bare owner URL names a user, not a stored object: ${url}`);
    }
    // The short form of the profile's own path is the same object
    assert.strictEqual(decodeObject(`pubky${OTTO}/pub/social/v1/profile.json`, user.body, "user").name, "Ann");
  });

  it("a version is never older than its post nor past the future bound", () => {
    const post = buildPost(OTTO, { content: "x" });
    const at = (editId) => `pubky://${OTTO}/pub/social/v1/posts/${post.id}/${editId}.json`;
    const older = "0032SSN7Q4EVG";
    refuses(() => decodeObject(at(older), post.body), `Validation Error: version ${older} is older than the post id ${post.id}`);
    const ahead = "0036000000000"; // 2027, far past now + 2h
    const e = caught(() => decodeObject(at(ahead), post.body));
    assert.strictEqual(e.message, "Validation Error: Invalid ID, timestamp is too far in the future");
    assert.strictEqual(e.field, "editId");
  });

  it("publishing keeps the slug and writes the envelope as its kind writes it", () => {
    const media = buildFile(OTTO, { bytes: utf8("cover"), type: "image/png", root: "private" });
    const draft = buildPost(OTTO, { kind: "article", title: "T", body: "B", cover_image: media.url, root: "private", slug: "my-post" });
    const { slug } = specs.parseUri(draft.url);
    const plan = planPublish(OTTO, { id: draft.id, editId: draft.editId, post: draft.object, slug });
    assert.ok(plan.put.path.endsWith(`/${draft.editId}-my-post.json`), plan.put.path);
    assert.strictEqual(plan.put.object.content, draft.object.content.replace("/priv/social/v1/files/", "/pub/social/v1/files/"));
    refuses(() => planPublish(OTTO, { id: draft.id, editId: draft.editId, post: draft.object, slug: "Not A Slug" }), /slug must be/);
  });

  it("a list is refused by its count before any item is read", () => {
    const items = Array.from({ length: 101 }, () => ({ uri: "not a uri" }));
    refuses(() => buildPost(OTTO, { kind: "collection", name: "List", items }), "Validation Error: Collection cannot have more than 100 items");
    const attachments = Array.from({ length: 11 }, () => ({ uri: "not a uri" }));
    refuses(() => buildPost(OTTO, { content: "x", attachments }), "Validation Error: Too many attachments (max: 10)");
  });

  it("a caller's array past the input bound is refused before it is walked", () => {
    const attachments = new Array(1_000_000).fill({ uri: "https://x.y" });
    const start = performance.now();
    assert.throws(() => buildPost(OTTO, { content: "x", attachments }), TypeError);
    assert.ok(performance.now() - start < 50, "a million items were walked");
  });

  it("a name this version does not know is written back as it was read", () => {
    const url = `pubky://${OTTO}/pub/social/v1/posts/0035QZPT4QG00/0035QZPT4QG00.json`;
    const envelope = '{"name":"List","items":[],"layout":"carousel"}';
    const bytes = utf8(JSON.stringify({ content: envelope, kind: "collection", parent: null, embed: null, attachments: [] }));
    const post = decodeObject(url, bytes, "post");
    assert.deepStrictEqual(specs.decodeContent(post), { kind: "collection", content: { name: "List", description: null, items: [], cover_image: null, layout: "carousel" } });
    assert.strictEqual(text(encodeObject(url, post)), text(bytes));
  });

  it("a number in an unknown member reads back to itself over any number of rewrites", () => {
    const url = `pubky://${OTTO}/pub/social/v1/follows/${RIO}.json`;
    for (const n of ["2.2250738585072011e-308", "9007199254740993.5", "1.7976931348623157e308", "4.9e-324", "0.30000000000000004", "123456789012345678901234567890", "1e22"]) {
      let bytes = utf8(`{"created_at":${T0 * 1000},"x":${n}}`);
      const once = text(encodeObject(url, decodeObject(url, bytes, "follow")));
      for (let i = 0; i < 5; i++) bytes = encodeObject(url, decodeObject(url, bytes, "follow"));
      assert.strictEqual(text(bytes), once, n);
      assert.strictEqual(JSON.parse(once).x, Number(n), n);
    }
  });
});

describe("helpers", () => {
  beforeEach(() => setClock(() => T0));
  after(() => setClock());

  it("an edit goes only into the owner's own tree", () => {
    const theirs = buildPost(RIO, { content: "x" });
    const e = caught(() => specs.editPost(OTTO, theirs.url, theirs.object));
    assert.deepStrictEqual([e.code, e.field], ["path", "headUri"]);
    assert.strictEqual(specs.editPost(RIO, theirs.url, { ...theirs.object, content: "y" }).id, theirs.id);
  });

  it("isPubkyUrl guards a URL from elsewhere without throwing", () => {
    const post = buildPost(OTTO, { content: "x" });
    assert.strictEqual(specs.isPubkyUrl(post.url), true);
    for (const value of [post.path, `pubky://${OTTO}`, specs.buildUri(OTTO, "post", post.id), specs.listPrefix(OTTO, "public"), `pubky${OTTO}/pub/social/v1/profile.json`, 7, null]) {
      assert.strictEqual(specs.isPubkyUrl(value), false, String(value));
    }
  });

  it("a post id gives its time, and timestamps convert to and from a Date in microseconds", () => {
    const post = buildPost(OTTO, { content: "x" });
    assert.strictEqual(specs.idMicros(post.id), T0 * 1000);
    assert.strictEqual(specs.microsToDate(specs.idMicros(post.id)).getTime(), T0);
    assert.strictEqual(specs.dateToMicros(new Date(T0)), T0 * 1000);
    assert.strictEqual(specs.dateToMicros(T0), T0 * 1000);
    assert.strictEqual(specs.microsToDate(buildFollow(OTTO, RIO).object.created_at).getTime(), T0);
  });

  it("parseOwnerPath takes a path beneath a root, never the root alone", () => {
    for (const root of ["/pub", "/priv", "/pub/", "/"]) assert.strictEqual(caught(() => specs.parseOwnerPath(root)).code, "path", root);
    assert.strictEqual(specs.parseOwnerPath("/pub/social/v1/profile.json"), "/pub/social/v1/profile.json");
  });

  it("idMicros refuses an id whose time is past the safe integer range", () => {
    const e = caught(() => specs.idMicros("FZZZZZZZZZZZY"));
    assert.deepStrictEqual([e.code, e.field], ["id", "id"]);
    assert.strictEqual(specs.idMicros(buildPost(OTTO, { content: "x" }).id), T0 * 1000);
  });

  it("dateToMicros keeps a fraction of a millisecond, to the nearest microsecond", () => {
    assert.strictEqual(specs.dateToMicros(1.5), 1500);
    assert.strictEqual(specs.dateToMicros(1.005), 1005);
    assert.strictEqual(specs.dateToMicros(-1.5), -1500);
  });

  it("memoryHomeserver reads are copies, so changing one changes nothing stored", async () => {
    const { memoryHomeserver } = await import("./dist/testing.js");
    const { owner, session, publicStorage } = memoryHomeserver();
    await session.storage.putBytes("/pub/x", new Uint8Array([1, 2]));
    (await session.storage.getBytes("/pub/x"))[0] = 9;
    (await publicStorage.getBytes(`pubky://${owner}/pub/x`))[0] = 9;
    assert.deepStrictEqual([...(await session.storage.getBytes("/pub/x"))], [1, 2]);
  });

  it("dateToMicros refuses a date whose microseconds are no safe integer", () => {
    assert.strictEqual(specs.dateToMicros(new Date("2255-01-01T00:00:00Z")), Date.UTC(2255, 0, 1) * 1000);
    assert.throws(
      () => specs.dateToMicros(new Date("3000-01-01T00:00:00Z")),
      (e) => e instanceof specs.ArgumentError && e.field === "date",
    );
  });

  it("tryDecodeObject returns the refusal of bad bytes and still throws on a bad argument", () => {
    const url = `pubky://${OTTO}/pub/social/v1/profile.json`;
    const bad = specs.tryDecodeObject(url, utf8("{"), "user");
    assert.deepStrictEqual([bad.ok, bad.error.code], [false, "json"]);
    const good = specs.tryDecodeObject(url, buildUser(OTTO, { name: "Ann" }).body, "user");
    assert.deepStrictEqual([good.ok, good.value.name], [true, "Ann"]);
    assert.throws(() => specs.tryDecodeObject(url, "{}"), TypeError);
  });
});

describe("the testing entry and the 0.x keys", () => {
  it("memoryHomeserver answers as the SDK: a streamed GET, pages after a cursor, and 404 for nothing", async () => {
    const { memoryHomeserver } = await import("./dist/testing.js");
    const { owner, session, publicStorage, sessionOf } = memoryHomeserver();
    const a = buildPost(owner, { content: "a" });
    await session.storage.putBytes(a.path, a.body);
    await session.storage.putJson("/pub/social/v1/x.json", { n: 1 });
    const got = await session.storage.get(a.path);
    assert.strictEqual(got.headers.get("Content-Length"), String(a.body.length));
    assert.strictEqual(got.headers.get("etag"), null);
    const reader = got.body.getReader();
    const first = await reader.read();
    assert.deepStrictEqual([first.done, (await reader.read()).done], [false, true]);
    await reader.cancel();
    assert.strictEqual(text(new Uint8Array(await got.arrayBuffer())), text(a.body));
    const all = await session.storage.list("/pub/social/v1/");
    assert.deepStrictEqual(await session.storage.list("/pub/social/v1/", all[0], false, 1), [all[1]]);
    assert.deepStrictEqual(await session.storage.list("/pub/social/v1/", null, true), [...all].reverse());
    await assert.rejects(session.storage.list("/pub/social/v1"), (e) => e.name === "InvalidInput");
    await assert.rejects(session.storage.getBytes("/pub/none"), (e) => e.data.statusCode === 404);
    assert.strictEqual(await session.storage.exists(a.path), true);
    await session.storage.delete(a.path);
    assert.strictEqual(await session.storage.exists(a.path), false);
    // Anyone reads the public root, by either address form the SDK takes, and nothing private
    assert.deepStrictEqual(await publicStorage.list(`pubky${owner}/pub/social/v1/`), [`pubky://${owner}/pub/social/v1/x.json`]);
    await assert.rejects(publicStorage.getBytes(`pubky://${owner}/priv/social/v1/x.json`), (e) => e.data.statusCode === 404);
    await assert.rejects(publicStorage.getBytes(`${owner}/pub/social/v1/x.json`), (e) => e.name === "InvalidInput");
    assert.strictEqual(sessionOf(RIO).info.publicKey.z32(), RIO);
  });

  it("a 0.x path keys as the 0.x reader read it", async () => {
    const { stableKey } = await import("./dist/legacy.js");
    assert.deepStrictEqual(stableKey("/pub/pubky.app/profile.json"), { key: "profile" });
    assert.deepStrictEqual(stableKey("pub/pubky.app/settings.json"), { key: "settings" });
    assert.strictEqual(stableKey("/pub/pubky.app/elsewhere"), null);
    assert.strictEqual(stableKey("/pub/pubky.app/polls/x"), null);
    assert.strictEqual(stableKey("/pub/pubky.app/tags/.json"), null);
  });

  it("the millisecond warning looks only at an object's created_at", async () => {
    const dev = await import("./dist/dev.js");
    const warned = [];
    const warn = console.warn;
    console.warn = (m) => warned.push(m);
    try {
      dev.warnIfMilliseconds(null, "x");
      dev.warnIfMilliseconds("text", "x");
      dev.warnIfMilliseconds({ created_at: "1" }, "x");
      dev.warnIfMilliseconds({ created_at: T0 * 1000 }, "x");
      dev.warnIfMilliseconds({ created_at: T0 }, "x");
    } finally {
      console.warn = warn;
    }
    assert.strictEqual(warned.length, 1);
  });
});
