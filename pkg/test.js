// The package as a caller meets it. What every function answers for every input is the
// scoreboard's job (qa/score.mjs, against the reference); here are the things only JS has:
// the shapes of arguments and results, values no JSON holds, the clock, the errors.

import assert from "assert";
import vm from "node:vm";
import * as specs from "./dist/index.js";

const {
  ValidationError, setClock, limits, validMimeTypes, postKinds, feedReaches, feedLayouts, feedSorts, collectionLayouts,
  decodeObject, encodeObject, decodeContent, encodeContent,
  buildUser, buildPost, editPost, buildFeed, feedId, buildTag, buildBookmark, buildFollow, buildMute, buildFile, createMediaHasher,
  planPublish, planUnpublish, planDelete, deletionPaths, parseUri, buildUri, listPrefix,
} = specs;

const OTTO = "8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto";
const RIO = "dzswkfy7ek3bqnoc89jxuqqfbzhjrj6mi8qthgbxxcqkdugm3rio";
// 2026-09-22T16:53:20Z
const T0 = 1_790_000_000_000;
const text = (bytes) => new TextDecoder().decode(bytes);
const utf8 = (s) => new TextEncoder().encode(s);

// A rule of the data model: the reference's own message
const refuses = (fn, message) =>
  assert.throws(fn, (e) => {
    assert.ok(e instanceof ValidationError, `expected a ValidationError, got ${e}`);
    message instanceof RegExp ? assert.match(e.message, message) : assert.strictEqual(e.message, message);
    return true;
  });
// A bug in the caller: the package's own words
const misuse = (fn, pattern) => assert.throws(fn, (e) => e instanceof TypeError && !(e instanceof ValidationError) && pattern.test(e.message));

describe("pubky-social-specs", () => {
  beforeEach(() => setClock(() => T0));
  after(() => setClock());

  describe("the entry", () => {
    it("exports exactly this, and nothing loads a wasm", () => {
      assert.deepStrictEqual(Object.keys(specs).sort(), [
        "ValidationError", "buildBookmark", "buildFeed", "buildFile", "buildFollow", "buildMute", "buildPost", "buildTag", "buildUri", "buildUser",
        "collectionLayouts", "createMediaHasher", "decodeContent", "decodeObject", "deletionPaths", "editPost", "encodeContent", "encodeObject",
        "feedId", "feedLayouts", "feedReaches", "feedSorts", "limits", "listPrefix", "parseUri", "planDelete", "planPublish", "planUnpublish",
        "postKinds", "setClock", "validMimeTypes",
      ]);
      assert.strictEqual(typeof WebAssembly.instantiate, "function");
    });

    it("works at once: no init, every call synchronous", () => {
      const built = buildPost(OTTO, { content: "hello" });
      assert.ok(!(built instanceof Promise));
      assert.strictEqual(text(built.body), '{"content":"hello","kind":"note","parent":null,"embed":null,"attachments":[]}');
    });

    it("the data is the reference's", () => {
      assert.strictEqual(limits.postNoteContentMaxLength, 2000);
      assert.strictEqual(limits.maxFileSizeBytes, 100 * 1024 * 1024);
      assert.ok(validMimeTypes.includes("image/png"));
      assert.deepStrictEqual(postKinds, ["note", "article", "image", "video", "link", "file", "collection"]);
      assert.ok(Object.isFrozen(limits) && Object.isFrozen(limits.tagInvalidChars) && Object.isFrozen(postKinds) && Object.isFrozen(validMimeTypes));
      assert.deepStrictEqual([feedReaches.length, feedLayouts.length, feedSorts.length, collectionLayouts.length], [6, 4, 2, 3]);
    });
  });

  describe("errors", () => {
    it("a rule refused is a ValidationError with the reference message", () => {
      refuses(() => buildUser(OTTO, { name: "ab" }), "Validation Error: Invalid name length");
      refuses(() => buildUser("nope", { name: "Alice" }), "Validation Error: the string is not 52 ASCII characters");
    });

    it("a wrong shape is a TypeError naming the argument, never a ValidationError", () => {
      misuse(() => buildUser(OTTO, { name: 1 }), /input\.name must be a string/);
      misuse(() => buildUser(OTTO, { name: "Alice", nmae: "typo" }), /input\.nmae must be one of name, bio/);
      misuse(() => buildUser(OTTO, null), /input must be an object/);
      misuse(() => buildUser(OTTO, ["Alice"]), /input must be an object/);
      misuse(() => buildUser(1, { name: "Alice" }), /owner must be a string/);
      misuse(() => buildPost(OTTO, { content: "x", root: "priv" }), /input\.root must be "public" or "private"/);
      misuse(() => buildPost(OTTO, { content: "x", attachments: [{ uri: 1 }] }), /input\.attachments\[0\]\.uri must be a string/);
      misuse(() => decodeObject(buildUri(OTTO, "user"), "{}"), /bytes must be a Uint8Array/);
      misuse(() => decodeObject(buildUri(OTTO, "user"), new DataView(new ArrayBuffer(2))), /bytes must be a Uint8Array/);
      misuse(() => listPrefix(OTTO, "pub"), /tree must be "public", "private" or "legacy"/);
      // A misspelled option is refused, not ignored
      const post = buildPost(OTTO, { content: "x" });
      misuse(() => editPost(post.url, post.object, { rooot: "private" }), /options\.rooot must be one of root, slug/);
      misuse(() => editPost(post.url, post.object, "private"), /options must be an object/);
      misuse(() => deletionPaths({ kind: "mute", id: RIO, listing: [] }), /target\.listing must be one of kind, id, listings/);
      misuse(() => planUnpublish({ id: post.id, publicPaths: [], privatHead: "x" }), /post\.privatHead must be one of/);
      misuse(() => encodeObject({ kind: "user", rot: "private" }, {}), /at\.rot must be one of kind, root/);
      misuse(() => buildFile(OTTO, { bytes: new Uint8Array(1), type: "image/png", name: "a.png" }), /input\.name must be one of bytes, id, type, root/);
      misuse(() => buildFile(OTTO, { type: "image/png" }), /input must be given either bytes or an id/);
      // A name outside the set is a typo, not a newer writer's value
      const feed = buildFeed(OTTO, { name: "n", icon: "a", reach: "all", layout: "list", sort: "recent", content: "note" });
      misuse(() => feedId({ ...feed.object, feed: { ...feed.object.feed, content: "vdeo" } }), /feed\.feed\.content must be one of note, article/);
      misuse(() => encodeContent({ name: "abc", description: null, items: [], cover_image: null, layout: "gird" }), /content\.layout must be one of grid, list, visual/);
      misuse(() => encodeContent({ body: "no title" }), /content must be an article envelope, with a title, or a collection envelope, with a name/);
      misuse(() => setClock(T0), /nowMs must be a function/);
      setClock(() => T0 + 0.5);
      misuse(() => buildFollow(OTTO, RIO), /the clock given to setClock must be returning an integer of milliseconds/);
      misuse(() => buildUri(OTTO, "posts", "x"), /kind must be an object kind/);
    });

    it("a refusal carries the reference text as its reason, and the member or argument it is about", () => {
      const caught = (fn) => {
        try {
          fn();
        } catch (e) {
          return e;
        }
        assert.fail("no refusal");
      };
      const name = caught(() => buildUser(OTTO, { name: "ab" }));
      assert.strictEqual(name.reason, "Invalid name length");
      assert.strictEqual(name.field, "name");
      assert.strictEqual(name.message, `Validation Error: ${name.reason}`);
      assert.strictEqual(caught(() => buildUser("nope", { name: "Alice" })).field, "owner");
      assert.strictEqual(caught(() => buildFollow(OTTO, "nope")).field, "followee");
      assert.strictEqual(caught(() => buildPost(OTTO, { content: "x", parent: "not a uri" })).field, "parent");
      assert.strictEqual(caught(() => buildPost(OTTO, { content: "x", attachments: [{ uri: "https://a.example", name: " " }] })).field, "attachments[0].name");
      assert.strictEqual(caught(() => buildPost(OTTO, { kind: "article", title: " ", body: "b" })).field, "title");
      assert.strictEqual(caught(() => buildTag(OTTO, buildUri(RIO, "user"), "a b")).field, "label");
      assert.strictEqual(caught(() => buildFeed(OTTO, { name: "n", icon: "A!", reach: "all", layout: "list", sort: "recent" })).field, "icon");
      // A refusal of the whole object names no field
      assert.strictEqual(caught(() => decodeObject(buildUri(OTTO, "user"), utf8("{"))).field, undefined);
    });

    it("byte inputs are read through the intrinsic getters: an ArrayBuffer is bytes, a lying view is not trusted", () => {
      const media = buildFile(OTTO, { bytes: utf8("hello"), type: "text/plain" });
      assert.deepStrictEqual(buildFile(OTTO, { bytes: utf8("hello").buffer, type: "text/plain" }), media);
      const follow = buildFollow(OTTO, RIO);
      assert.deepStrictEqual(decodeObject(follow.url, follow.body.slice().buffer), decodeObject(follow.url, follow.body));
      // A view over a larger buffer whose subclass reports the whole buffer
      class Liar extends Uint8Array {
        get byteLength() {
          return this.buffer.byteLength;
        }
        get byteOffset() {
          return 0;
        }
      }
      const padded = new Uint8Array(follow.body.length + 8).fill(0x20);
      padded.set(follow.body, 4);
      const liar = new Liar(padded.buffer, 4, follow.body.length);
      assert.deepStrictEqual(decodeObject(follow.url, liar), decodeObject(follow.url, follow.body));
      const detached = new Uint8Array(4);
      structuredClone(detached.buffer, { transfer: [detached.buffer] });
      misuse(() => decodeObject(follow.url, detached), /bytes must be a Uint8Array/);
      misuse(() => createMediaHasher().update(new Float32Array(2)), /chunk must be a Uint8Array/);
    });

    it("instanceof holds for an error of another copy of the package", () => {
      const other = Object.assign(new Error("Validation Error: x"), { [Symbol.for("pubky-social-specs.ValidationError")]: true });
      assert.ok(other instanceof ValidationError);
      assert.ok(!(new Error("x") instanceof ValidationError));
      assert.ok(!(null instanceof ValidationError));
      try {
        buildUser(OTTO, { name: "" });
      } catch (e) {
        assert.strictEqual(e.name, "ValidationError");
        assert.ok(e instanceof Error && e.stack.includes("buildUser"));
      }
    });

    it("text holding a lone surrogate has no answer", () => {
      const lone = "Validation Error: text must be well-formed UTF-16";
      refuses(() => buildUser(OTTO, { name: "Al\ud800ice" }), lone);
      refuses(() => buildTag(OTTO, buildUri(RIO, "user"), "\udc00"), lone);
      refuses(() => parseUri("pubky://\ud83d"), lone);
      assert.strictEqual(buildUser(OTTO, { name: "Al😀ce" }).object.name, "Al😀ce");
    });
  });

  describe("builders", () => {
    it("return where the object goes, the object, and the bytes to PUT", () => {
      const built = buildUser(OTTO, { name: " Alice ", bio: "  ", links: [{ title: " Site ", url: "https://example.com" }] });
      assert.deepStrictEqual(built, {
        id: "",
        path: "/pub/social/v1/profile.json",
        url: `pubky://${OTTO}/pub/social/v1/profile.json`,
        object: { name: "Alice", bio: null, image: null, links: [{ title: "Site", url: "https://example.com" }], status: null },
        body: utf8('{"name":"Alice","bio":null,"image":null,"links":[{"title":"Site","url":"https://example.com"}],"status":null}'),
      });
      assert.ok(built.body instanceof Uint8Array);
    });

    it("absent and null are the same in an input", () => {
      assert.deepStrictEqual(buildUser(OTTO, { name: "Alice", bio: null, image: undefined }).object, buildUser(OTTO, { name: "Alice" }).object);
      assert.deepStrictEqual(buildPost(OTTO, { content: "x", kind: null, parent: null, slug: null, root: null }).object, buildPost(OTTO, { content: "x" }).object);
    });

    it("the clock gives ids and timestamps, and ids only go up", () => {
      const a = buildPost(OTTO, { content: "a" });
      const b = buildPost(OTTO, { content: "b" });
      assert.strictEqual(a.id, "0035QZPT4QG00");
      assert.strictEqual(a.editId, a.id);
      assert.ok(b.id > a.id, "a second post in the same instant gets the next id");
      assert.strictEqual(buildFollow(OTTO, RIO).object.created_at, T0 * 1000);
      setClock(() => T0);
      assert.strictEqual(buildPost(OTTO, { content: "a" }).id, a.id, "setClock starts the guard over");
    });

    it("a post built after an edit in the same instant never takes an earlier post's id", () => {
      const ids = new Set();
      for (let i = 0; i < 200; i++) {
        const post = buildPost(OTTO, { content: `post ${i}` });
        editPost(post.url, { ...post.object, content: `edited ${i}` });
        ids.add(post.id);
      }
      assert.strictEqual(ids.size, 200);
    });

    it("a post is told apart by kind, and a typed kind gets its envelope written", () => {
      const article = buildPost(OTTO, { kind: "article", title: " Title ", body: "Body", cover_image: "https://example.com/c.png", slug: "my-title" });
      assert.strictEqual(article.path, `/pub/social/v1/posts/${article.id}/${article.id}-my-title.json`);
      assert.strictEqual(article.object.content, '{"title":"Title","body":"Body","cover_image":"https://example.com/c.png"}');
      const collection = buildPost(OTTO, { kind: "collection", name: "List", items: [{ uri: buildUri(RIO, "user"), note: " " }], layout: "grid", root: "private" });
      assert.ok(collection.path.startsWith("/priv/social/v1/posts/"));
      assert.deepStrictEqual(decodeContent(collection.object), {
        kind: "collection",
        content: { name: "List", description: null, items: [{ uri: buildUri(RIO, "user"), note: null }], cover_image: null, layout: "grid" },
      });
      misuse(() => buildPost(OTTO, { kind: "collection", name: "List", parent: buildUri(RIO, "user") }), /input\.parent must be one of kind, name/);
      refuses(() => buildPost(OTTO, { content: "x", kind: "podcast" }), "Validation Error: Invalid content kind: podcast");
      refuses(() => buildPost(OTTO, { content: "x", kind: "unknown" }), "Validation Error: Invalid content kind: unknown");
    });

    it("a tag, a bookmark, a follow and a mute are named by what they point at", () => {
      const target = buildUri(RIO, "post", "0034A0X7NJ52G");
      const tag = buildTag(OTTO, target, " Rust ");
      assert.strictEqual(tag.object.label, "rust");
      assert.strictEqual(tag.url, buildUri(OTTO, "tag", tag.id));
      const bookmark = buildBookmark(OTTO, target);
      assert.deepStrictEqual(bookmark.object, { created_at: T0 * 1000, target: null });
      assert.strictEqual(parseUri(bookmark.url).target, target);
      assert.strictEqual(buildBookmark(OTTO, target).id, bookmark.id, "the id of a bookmark is the id to delete it by");
      const long = buildBookmark(OTTO, `https://example.com/${"p".repeat(200)}`);
      assert.ok(long.id.startsWith("~") && long.object.target.length > 187);
      assert.strictEqual(parseUri(long.url).target, undefined);
      assert.strictEqual(buildFollow(OTTO, RIO).path, `/pub/social/v1/follows/${RIO}.json`);
      assert.strictEqual(buildMute(OTTO, RIO).path, `/priv/social/v1/mutes/${RIO}.json`);
    });

    it("a feed is named by its filter, folded and sorted", () => {
      const built = buildFeed(OTTO, { name: " Tech ", icon: " Star ", reach: "all", layout: "columns", sort: "recent", tags: ["Rust", "go", "rust"] });
      assert.deepStrictEqual(built.object.feed.tags, ["go", "rust"]);
      assert.strictEqual(built.object.icon, "star");
      assert.strictEqual(built.path, `/priv/social/v1/feeds/${built.id}.json`);
      assert.strictEqual(feedId(built.object), built.id);
      assert.notStrictEqual(feedId({ ...built.object, feed: { ...built.object.feed, sort: "popularity" } }), built.id);
      refuses(() => buildFeed(OTTO, { name: "x", icon: "star", reach: "galaxy", layout: "columns", sort: "recent" }), "Validation Error: Invalid feed reach: galaxy");
    });

    it("media goes by the hash of its bytes, from the bytes or from an id hashed elsewhere", () => {
      const bytes = new Uint8Array(100_000).map((_, i) => i % 251);
      const file = buildFile(OTTO, { bytes, type: "image/png" });
      assert.strictEqual(file.url, `pubky://${OTTO}/pub/social/v1/files/${file.id}.png`);
      const hasher = createMediaHasher();
      for (let at = 0; at < bytes.length; at += 7001) hasher.update(bytes.subarray(at, at + 7001));
      assert.strictEqual(hasher.id(), file.id);
      assert.deepStrictEqual(buildFile(OTTO, { id: hasher.id(), type: "IMAGE/PNG; q=1", root: "private" }).path, `/priv/social/v1/files/${file.id}.png`);
      assert.ok(buildFile(OTTO, { bytes, type: "application/x-unknown" }).path.endsWith(".bin"));
      refuses(() => buildFile(OTTO, { bytes: new Uint8Array(0), type: "image/png" }), "Validation Error: File size cannot be zero");
      refuses(() => buildFile(OTTO, { id: "not-a-hash", type: "image/png" }), /Invalid ID length/);
      assert.deepStrictEqual(decodeObject(file.url, bytes), { kind: "file", bytes });
      const realm = vm.runInNewContext("new Uint8Array([1, 2, 3])");
      assert.deepStrictEqual([...encodeObject({ kind: "file" }, realm)], [1, 2, 3]);
      assert.strictEqual(buildFile(OTTO, { bytes: realm, type: "image/png" }).id, buildFile(OTTO, { bytes: new Uint8Array([1, 2, 3]), type: "image/png" }).id);
    });
  });

  describe("reading and writing stored objects", () => {
    it("every kind a builder writes reads back as the object it returned", () => {
      const all = [
        ["user", buildUser(OTTO, { name: "Alice" })],
        ["post", buildPost(OTTO, { content: "hello" })],
        ["follow", buildFollow(OTTO, RIO)],
        ["mute", buildMute(OTTO, RIO)],
        ["bookmark", buildBookmark(OTTO, buildUri(RIO, "user"))],
        ["tag", buildTag(OTTO, buildUri(RIO, "user"), "friend")],
        ["feed", buildFeed(OTTO, { name: "All", icon: "star", reach: "all", layout: "columns", sort: "recent" })],
      ];
      for (const [kind, built] of all) {
        assert.deepStrictEqual(decodeObject(built.url, built.body), { kind, object: built.object }, kind);
        assert.deepStrictEqual(encodeObject(built.url, built.object), built.body, kind);
        assert.deepStrictEqual(encodeObject({ kind, root: parseUri(built.url).root }, built.object), built.body, kind);
      }
    });

    it("members a newer writer added travel in $unknown and are written back untouched", () => {
      const url = buildUri(OTTO, "user");
      const stored = '{"name":"Alice","bio":null,"image":null,"links":null,"status":null,"z":1.0,"a":{"y":[1e30,-0.0],"x":9007199254740991},"__proto__":{"p":1}}';
      const { object } = decodeObject(url, utf8(stored));
      assert.deepStrictEqual(Object.keys(object), ["name", "bio", "image", "links", "status", "$unknown"]);
      assert.strictEqual(object.$unknown, '{"__proto__":{"p":1},"a":{"x":9007199254740991,"y":[1e+30,-0.0]},"z":1.0}');
      assert.strictEqual(Object.getPrototypeOf(object), Object.prototype);
      object.name = "Alicia";
      // The same bytes a reader in any language writes: known members in order, the rest sorted
      assert.strictEqual(text(encodeObject(url, object)), stored.replace("Alice", "Alicia").replace(/,"z".*$/, `,${object.$unknown.slice(1)}`));
      const copy = structuredClone(object);
      assert.deepStrictEqual(encodeObject(url, JSON.parse(JSON.stringify(copy))), encodeObject(url, object));
    });

    it("refuses a member it does not know outside $unknown, and an $unknown that shadows a member", () => {
      const url = buildUri(OTTO, "user");
      const { object } = buildUser(OTTO, { name: "Alice" });
      misuse(() => encodeObject(url, { ...object, nmae: "x" }), /user\.nmae must be a member of the stored object/);
      misuse(() => encodeObject(url, { ...object, $unknown: {} }), /user\.\$unknown must be the text it was read with/);
      misuse(() => encodeObject(url, { ...object, $unknown: "[1]" }), /user\.\$unknown/);
      misuse(() => encodeObject(url, { ...object, $unknown: '{"name":"x"}' }), /user\.\$unknown must be without the known member name/);
      misuse(() => encodeObject(url, { ...object, $unknown: `{"a":0.${"0".repeat(300_000)}1` }), /user\.\$unknown/);
      refuses(() => encodeObject(url, { ...object, $unknown: '{"a":"\ud800"}' }), "Validation Error: text must be well-formed UTF-16");
      // Handing over the wrong thing says what the right thing is
      misuse(() => encodeObject(url, buildUser(OTTO, { name: "Alice" })), /user\.id must be a member of the stored object: pass the \.object/);
      misuse(() => encodeObject(url, buildUser(OTTO, { name: "Alice" }).body), /object must be the decoded user, not its bytes/);
      refuses(() => encodeObject(url, { ...object, $unknown: '{"n":9007199254740992}' }), "Validation Error: integer 9007199254740992 outside the JSON-safe range (in extra member n)");
    });

    it("reads bytes on the reference's terms: the first thing wrong in the text, in its words", () => {
      const url = buildUri(OTTO, "user");
      const read = (stored) => () => decodeObject(url, utf8(stored));
      refuses(read('{"name":"Alice"'), "Validation Error: EOF while parsing an object");
      refuses(read('{"name":1,"bio":'), "Validation Error: invalid type: integer `1`, expected a string");
      refuses(read('{"name":"a\\tb­","name":"x"}'), "Validation Error: duplicate field `name`");
      refuses(read('{"bio":"\\u00ad"}'), "Validation Error: missing field `name`");
      refuses(read('{"name":"­é\\n"}'.replace('"­', '{"x":"­').replace('\\n"}', '\\n"}}')), 'Validation Error: invalid type: map, expected a string');
      refuses(() => decodeObject(url, new Uint8Array([0x22, 0xff, 0x22])), /invalid type: string|invalid unicode code point/);
      refuses(() => decodeObject(buildUri(OTTO, "post", "0034A0X7NJ52G"), utf8("{}")), "Validation Error: a versionless post reference is never a stored object");
      refuses(() => decodeObject(`pubky://${OTTO}/pub/other.app/v1/x`, utf8("{}")), "Validation Error: a foreign namespace is not a social object");
    });

    it("an integer is a number, and one a double cannot hold is refused before it is one", () => {
      const url = buildUri(OTTO, "follow", RIO);
      assert.strictEqual(decodeObject(url, utf8('{"created_at":9007199254740991}')).object.created_at, Number.MAX_SAFE_INTEGER);
      refuses(() => decodeObject(url, utf8('{"created_at":9007199254740992}')), "Validation Error: integer 9007199254740992 outside the JSON-safe range");
      misuse(() => encodeObject(url, { created_at: 1.5 }), /follow\.created_at must be an integer/);
      misuse(() => encodeObject(url, { created_at: 1n }), /follow\.created_at must be an integer/);
    });

    it("a polluted Object.prototype or Array.prototype never reaches a built or encoded object", () => {
      const polluted = { parent: "https://evil.example/", root: "private", embed: "https://evil.example/", lock: buildUri(RIO, "user"), slug: "x", $unknown: '{"evil":1}', kind: "article", title: "t", name: "n" };
      const media = buildFile(OTTO, { bytes: utf8("hi"), type: "image/png" });
      Object.assign(Object.prototype, polluted);
      Array.prototype[0] = { uri: "https://evil.example/" };
      try {
        const post = buildPost(OTTO, { content: "x" });
        assert.strictEqual(post.object.kind, "note");
        assert.strictEqual(post.object.parent, null);
        assert.strictEqual(post.object.embed, null);
        assert.strictEqual(post.object.lock, null);
        assert.ok(!Object.hasOwn(post.object, "$unknown"));
        assert.ok(post.path.startsWith("/pub/") && !post.path.includes("-x.json"));
        const read = decodeObject(post.url, post.body);
        const { content, kind, attachments } = read.object;
        assert.deepStrictEqual(text(encodeObject(post.url, { content, kind, parent: null, embed: null, attachments, lock: null })), text(post.body));
        // A hole is absent, never the polluted entry at its index
        misuse(() => buildPost(OTTO, { content: "x", attachments: new Array(1) }), /input\.attachments\[0\] must be an object/);
        assert.strictEqual(buildFile(OTTO, { bytes: utf8("hi"), type: "image/png" }).path, media.path);
        assert.strictEqual(decodeContent({ content: "x", kind: "note" }), null);
      } finally {
        for (const key of Object.keys(polluted)) delete Object.prototype[key];
        delete Array.prototype[0];
      }
      assert.ok(!(Object.assign(Object.create({ [Symbol.for("pubky-social-specs.ValidationError")]: true })) instanceof ValidationError));
    });

    it("values no JSON holds are refused as shapes: holes, getters that throw, cycles", () => {
      const url = buildUri(OTTO, "user");
      const base = buildUser(OTTO, { name: "Alice" }).object;
      const sparse = [];
      sparse[1] = { title: "t", url: "https://example.com" };
      misuse(() => encodeObject(url, { ...base, links: sparse }), /user\.links\[0\] must be an object/);
      const cyclic = { ...base };
      cyclic.links = [cyclic];
      misuse(() => encodeObject(url, cyclic), /user\.links\[0\]\.name|user\.links\[0\]\.\w+ must be a member/);
      const trap = { ...base, get bio() { throw new RangeError("mine"); } };
      assert.throws(() => encodeObject(url, trap), RangeError);
      misuse(() => encodeObject(url, new Map()), /user\.name must be given/);
    });

    it("the envelope of an article is read and written by the package, unknown members kept", () => {
      const built = buildPost(OTTO, { kind: "article", title: "Title", body: "Body" });
      const post = { ...built.object, content: '{"toc":true,"title":"Title","body":"Body"}' };
      const read = decodeContent(post);
      assert.deepStrictEqual(read, { kind: "article", content: { title: "Title", body: "Body", cover_image: null, $unknown: '{"toc":true}' } });
      assert.strictEqual(encodeContent({ ...read.content, title: "New" }), '{"title":"New","body":"Body","toc":true}');
      assert.strictEqual(decodeContent(buildPost(OTTO, { content: "plain" }).object), null);
      refuses(() => decodeContent({ ...post, content: "{" }), "Validation Error: Article content must be a valid JSON envelope: EOF while parsing an object");
    });
  });

  describe("versions and the lifecycle", () => {
    it("drafts privately, edits, publishes, unpublishes and deletes", () => {
      const media = buildFile(OTTO, { bytes: utf8("png"), type: "image/png", root: "private" });
      const draft = buildPost(OTTO, { content: "draft", attachments: [{ uri: media.url }], root: "private", slug: "first" });
      assert.strictEqual(draft.path, `/priv/social/v1/posts/${draft.id}/${draft.id}-first.json`);

      const edited = editPost(draft.url, { ...draft.object, content: "better" });
      assert.strictEqual(edited.id, draft.id);
      assert.ok(edited.editId > draft.editId && edited.path.startsWith("/priv/"), "an edit stays under the head's root");
      assert.strictEqual(text(edited.body), text(draft.body).replace("draft", "better"));
      refuses(() => editPost(draft.url, draft.object, { root: "public" }), /attachments\[0\]\.uri must not reference a private object/);
      assert.ok(editPost(draft.url, { ...draft.object, attachments: [] }, { root: "public", slug: "x" }).path.endsWith("-x.json"));
      refuses(() => editPost(buildUri(OTTO, "post", draft.id), draft.object), /not the URI of a stored post version/);

      const plan = planPublish(OTTO, { id: draft.id, editId: edited.editId, post: edited.object });
      assert.deepStrictEqual(plan.copies, [{ from: media.path, to: media.path.replace("/priv/", "/pub/") }]);
      assert.strictEqual(plan.put.path, `/pub/social/v1/posts/${draft.id}/${edited.editId}.json`);
      assert.strictEqual(plan.put.object.attachments[0].uri, media.url.replace("/priv/", "/pub/"));
      assert.deepStrictEqual(decodeObject(plan.put.url, plan.put.body).object, plan.put.object);

      const un = planUnpublish({ id: draft.id, publicPaths: [plan.put.path], privateHead: draft.path });
      assert.deepStrictEqual(un, { copies: [{ from: plan.put.path, to: plan.put.path.replace("/pub/", "/priv/") }], deletes: [plan.put.path] });

      const gone = planDelete(OTTO, {
        id: draft.id,
        legacyPaths: [`/pub/pubky.app/posts/${draft.id}`],
        copies: [{ root: "private", path: edited.path }, { root: "public", path: plan.put.path }, { root: "private", path: draft.path }],
        versions: [edited.object, plan.put.object],
      });
      assert.deepStrictEqual(gone.deletes, [`/pub/pubky.app/posts/${draft.id}`, draft.path, plan.put.path, edited.path]);
      assert.deepStrictEqual(gone.mediaGcCandidates, [media.path, media.path.replace("/priv/", "/pub/")].sort());
    });

    it("a head from a faster clock still gets a successor, the same one for the same edit", () => {
      const head = buildPost(OTTO, { content: "from the future" });
      setClock(() => T0 - 60_000);
      const a = editPost(head.url, { ...head.object, content: "edit" });
      setClock(() => T0 - 60_000);
      const b = editPost(head.url, { ...head.object, content: "edit" });
      assert.ok(a.editId > head.editId);
      assert.strictEqual(a.editId, b.editId);
      setClock(() => T0 - 60_000);
      assert.notStrictEqual(editPost(head.url, { ...head.object, content: "another edit" }).editId, a.editId);
    });
  });

  describe("URIs and deletion", () => {
    it("buildUri spells what parseUri classifies as that kind", () => {
      const ids = { post: "0034A0X7NJ52G", follow: RIO, mute: RIO, bookmark: "aGk", tag: "0000000000000000000000000G", file: "0000000000000000000000000G.png", feed: "0000000000000000000000000G" };
      assert.deepStrictEqual(parseUri(buildUri(OTTO, "user")), { owner: OTTO, root: "public", path: "/pub/social/v1/profile.json", kind: "user" });
      for (const [kind, id] of Object.entries(ids)) {
        const parsed = parseUri(buildUri(OTTO, kind, id));
        assert.strictEqual(parsed.kind, kind);
        assert.strictEqual(parsed.id, kind === "file" ? id.slice(0, -4) : id);
        assert.strictEqual(parsed.owner, OTTO);
      }
      assert.strictEqual(parseUri(`pubky://${OTTO}/pub/social/v1/posts/0034A0X7NJ52G/0034A0X7NJ52J-a-slug.json`).slug, "a-slug");
      refuses(() => buildUri("nope", "user"), /not 52 ASCII/);
    });

    it("buildUri refuses an id its kind cannot have, and a file round trips through its filename", () => {
      for (const [kind, id] of [
        ["post", "../../priv/x"],
        ["post", "0034A0X7NJ52G/0034A0X7NJ52J"],
        ["post", "not-an-id"],
        ["feed", "a/b"],
        ["tag", "0000000000000000000000000g"],
        ["follow", "nope"],
        ["mute", `${RIO}/x`],
        ["bookmark", "a\r\nb"],
        ["file", "../../../../priv/app.pubky/v1/x"],
        ["file", "0000000000000000000000000G"],
        ["file", "0000000000000000000000000G.exe"],
      ]) {
        assert.throws(() => buildUri(OTTO, kind, id), (e) => e instanceof ValidationError && e.field === "id", `${kind} ${id}`);
      }
      const media = buildFile(OTTO, { bytes: utf8("hello"), type: "image/png" });
      const parsed = parseUri(media.url);
      assert.strictEqual(parsed.filename, `${media.id}.png`);
      assert.strictEqual(buildUri(OTTO, "file", parsed.filename), media.url);
    });

    it("classifies what is no social object as a kind, never an error", () => {
      assert.deepStrictEqual(parseUri(`pubky://${OTTO}/pub/other.app/v2/a/b`), { owner: OTTO, root: "public", path: "/pub/other.app/v2/a/b", kind: "foreign", namespace: "other.app", version: "v2", rest: ["a", "b"] });
      assert.strictEqual(parseUri(`pubky://${OTTO}/pub/social/v9/x`).kind, "unsupportedVersion");
      assert.strictEqual(parseUri(`pubky://${OTTO}/pub/social/v1/nope`).kind, "unknown");
      assert.strictEqual(parseUri(`pubky${OTTO}`).kind, "user");
      refuses(() => parseUri("https://example.com"), "Validation Error: Not a canonical pubky URI: https://example.com");
      refuses(() => parseUri(`pubky://${OTTO}/other/x`), /Unknown root in URI/);
    });

    it("listPrefix names the three trees of an owner", () => {
      assert.strictEqual(listPrefix(OTTO, "public"), `pubky://${OTTO}/pub/social/v1/`);
      assert.strictEqual(listPrefix(OTTO, "private"), `pubky://${OTTO}/priv/social/v1/`);
      assert.strictEqual(listPrefix(OTTO, "legacy"), `pubky://${OTTO}/pub/pubky.app/`);
    });

    it("deletionPaths spans both epochs and both roots, legacy first", () => {
      assert.deepStrictEqual(deletionPaths({ kind: "user", id: "" }), ["/pub/pubky.app/profile.json", "/pub/social/v1/profile.json"]);
      assert.deepStrictEqual(deletionPaths({ kind: "follow", id: RIO }), [`/pub/pubky.app/follows/${RIO}`, `/pub/social/v1/follows/${RIO}.json`]);
      assert.deepStrictEqual(deletionPaths({ kind: "mute", id: RIO, listings: null }), [`/priv/social/v1/mutes/${RIO}.json`]);
      const hash = "0000000000000000000000000G";
      assert.deepStrictEqual(
        deletionPaths({
          kind: "file",
          id: hash,
          listings: [`/priv/social/v1/files/${hash}.png`, { path: "/pub/pubky.app/files/0034A0X7NJ52G", src: `pubky://${OTTO}/pub/pubky.app/blobs/${hash}` }],
        }),
        ["/pub/pubky.app/files/0034A0X7NJ52G", `/pub/pubky.app/blobs/${hash}`, `/pub/social/v1/files/${hash}.png`, `/priv/social/v1/files/${hash}.png`],
      );
      refuses(() => deletionPaths({ kind: "mute", id: RIO, listings: ["/pub/x"] }), "Validation Error: a mute delete takes no listings, found /pub/x");
      misuse(() => deletionPaths({ kind: "file", id: hash, listings: [{ path: "/x" }] }), /listings\[0\]\.src must be a string/);
    });
  });
});
