// The package as a caller meets it. What every function answers for every input is the
// scoreboard's job (qa/score.mjs, against the reference); here are the things only JS has:
// the shapes of arguments and results, values no JSON holds, the clock, the errors.

import assert from "assert";
import vm from "node:vm";
import * as specs from "./dist/index.js";
import { setClock } from "./dist/testing.js";
import { OTTO, RIO, T0, caught, misuse, refuses, text, utf8 } from "./core.fixture.js";

const {
  ValidationError,
  limits,
  validMimeTypes,
  postKinds,
  feedReaches,
  feedLayouts,
  feedSorts,
  collectionLayouts,
  decodeObject,
  encodeObject,
  decodeContent,
  encodeContent,
  buildUser,
  buildPost,
  editPost,
  buildFeed,
  feedId,
  feedPaths,
  buildTag,
  buildBookmark,
  buildFollow,
  buildMute,
  buildFile,
  createMediaHasher,
  planPublish,
  planUnpublish,
  planDelete,
  deletionPaths,
  parseUri,
  buildUri,
  listPrefix,
  toPath,
  hashMedia,
  toUrl,
  isOneOf,
  parsePubkyUrl,
  tryDecodeObject,
  ENGINE_CAPS,
  MIGRATION_CAPS,
} = specs;

describe("pubky-social-specs", () => {
  beforeEach(() => setClock(() => T0));
  after(() => setClock());

  describe("the entry", () => {
    it("exports exactly this, and nothing loads a wasm", () => {
      assert.deepStrictEqual(
        Object.keys(specs).sort(),
        [
          "ArgumentError",
          "ENGINE_CAPS",
          "MIGRATION_CAPS",
          "ValidationError",
          "buildBookmark",
          "buildFeed",
          "buildFile",
          "buildFollow",
          "buildMute",
          "buildPost",
          "buildTag",
          "buildUri",
          "buildUser",
          "attendancePolicies",
          "collectionLayouts",
          "createMediaHasher",
          "eventStatuses",
          "geoUri",
          "isGeoUri",
          "osmUrl",
          "parseOsmUrl",
          "recurrenceFrequencies",
          "rsvpStatuses",
          "weekdays",
          "dateToMicros",
          "decodeContent",
          "decodeObject",
          "deletionPaths",
          "editPost",
          "encodeContent",
          "encodeObject",
          "feedId",
          "feedLayouts",
          "feedPaths",
          "feedReaches",
          "feedSorts",
          "hashMedia",
          "idMicros",
          "isPubkyUrl",
          "limits",
          "listPrefix",
          "microsToDate",
          "parseEditId",
          "parseMediaId",
          "parseOwner",
          "parseOwnerPath",
          "parsePostId",
          "parsePostRef",
          "parsePubkyUrl",
          "parseUri",
          "planDelete",
          "planPublish",
          "planUnpublish",
          "postKinds",
          "toPath",
          "toUrl",
          "tryDecodeContent",
          "isOneOf",
          "tryDecodeObject",
          "validMimeTypes",
          "feedSchema",
          "postSchema",
          "tagSchema",
          "userSchema",
          "validateFeed",
          "validatePost",
          "validateTag",
          "validateUser",
        ].sort(),
      );
      assert.strictEqual(typeof WebAssembly.instantiate, "function");
    });

    it("works at once: no init, every call synchronous", () => {
      const built = buildPost(OTTO, { content: "hello" });
      assert.ok(!(built instanceof Promise));
      assert.strictEqual(text(built.body), '{"content":"hello","kind":"note","parent":null,"embed":null,"attachments":[]}');
    });

    it("the exported tables hold the reference's values, frozen", () => {
      assert.strictEqual(limits.postNoteContentMaxLength, 2000);
      assert.strictEqual(limits.maxFileSizeBytes, 100 * 1024 * 1024);
      assert.ok(validMimeTypes.includes("image/png"));
      assert.deepStrictEqual(postKinds, ["note", "article", "image", "video", "link", "file", "collection", "event", "rsvp", "availability", "rating"]);
      assert.ok(Object.isFrozen(limits) && Object.isFrozen(limits.tagInvalidChars) && Object.isFrozen(postKinds) && Object.isFrozen(validMimeTypes));
      assert.deepStrictEqual([feedReaches.length, feedLayouts.length, feedSorts.length, collectionLayouts.length], [6, 5, 2, 3]);
    });
  });

  describe("errors", () => {
    it("a rule refused is a ValidationError with the reference message", () => {
      refuses(() => buildUser(OTTO, { name: "ab" }), "Validation Error: name must be 3 to 50 code points");
      refuses(() => buildUser("nope", { name: "Alice" }), "Validation Error: the string is not 52 ASCII characters");
    });

    it("a wrong shape is a TypeError naming the argument, never a ValidationError", () => {
      misuse(() => buildUser(OTTO, { name: 1 }), /input\.name must be a string/);
      misuse(() => buildUser(OTTO, { name: "Alice", nmae: "typo" }), /input\.nmae must be one of name, bio/);
      misuse(() => buildUser(OTTO, null), /input must be an object/);
      misuse(() => buildUser(OTTO, ["Alice"]), /input must be an object/);
      misuse(() => buildUser(1, { name: "Alice" }), /owner must be a string/);
      // A string of the right type the model refuses is a rule, not a shape
      refuses(() => buildPost(OTTO, { content: "x", root: "priv" }), "Validation Error: unknown variant `priv`, expected `public` or `private`");
      misuse(() => buildPost(OTTO, { content: "x", attachments: [{ uri: 1 }] }), /input\.attachments\[0\]\.uri must be a string/);
      misuse(() => decodeObject(buildUri(OTTO, "user"), "{}"), /bytes must be a Uint8Array/);
      misuse(() => decodeObject(buildUri(OTTO, "user"), new DataView(new ArrayBuffer(2))), /bytes must be a Uint8Array/);
      refuses(() => listPrefix(OTTO, "pub"), "Validation Error: unknown variant `pub`, expected one of `public`, `private`, `legacy`");
      // A misspelled option is refused, not ignored
      const post = buildPost(OTTO, { content: "x" });
      misuse(() => editPost(OTTO, post.url, post.object, { rooot: "private" }), /options\.rooot must be one of root, slug/);
      misuse(() => editPost(OTTO, post.url, post.object, "private"), /options must be an object/);
      misuse(() => deletionPaths({ kind: "mute", id: RIO, listing: [] }), /target\.listing must be one of kind, id, listings/);
      misuse(() => planUnpublish({ id: post.id, publicPaths: [], privatHead: "x" }), /post\.privatHead must be one of/);
      misuse(() => encodeObject({ kind: "user", rot: "private" }, {}), /at\.rot must be one of kind, root/);
      misuse(() => buildFile(OTTO, { bytes: new Uint8Array(1), type: "image/png", name: "a.png" }), /input\.name must be one of bytes, id, type, root/);
      misuse(() => buildFile(OTTO, { type: "image/png" }), /input must be given either bytes or an id/);
      // A name outside the set in a read object is a newer writer's, kept as written; a
      // builder still refuses one
      const feed = buildFeed(OTTO, { name: "n", icon: "a", reach: "all", layout: "list", sort: "recent", content: "note" });
      assert.notStrictEqual(feedId({ ...feed.object, feed: { ...feed.object.feed, content: "podcast" } }), feed.id);
      assert.match(encodeContent({ name: "abc", description: null, items: [], cover_image: null, layout: "carousel" }), /"layout":"carousel"/);
      refuses(() => buildFeed(OTTO, { name: "n", icon: "a", reach: "all", layout: "list", sort: "recent", content: "vdeo" }), "Validation Error: Invalid content kind: vdeo");
      misuse(() => encodeContent({ body: "no title" }), /content must be an envelope of an article, a collection, an event/);
      misuse(() => setClock(T0), /nowMs must be a function/);
      setClock(() => T0 + 0.5);
      misuse(() => buildFollow(OTTO, RIO), /the clock given to setClock must be returning an integer of milliseconds/);
      refuses(() => buildUri(OTTO, "posts", "x"), /unknown variant `posts`, expected one of `user`, `post`/);
    });

    it("a refusal carries a stable code, and the bound a length or count broke", () => {
      const short = caught(() => buildUser(OTTO, { name: "ab" }));
      assert.deepStrictEqual([short.code, short.field, short.limit], ["length", "name", 3]);
      const long = caught(() => buildUser(OTTO, { name: "n".repeat(51) }));
      assert.deepStrictEqual([long.code, long.limit], ["length", 50]);
      const many = caught(() => buildPost(OTTO, { content: "x", attachments: Array.from({ length: 11 }, () => ({ uri: "https://a.example" })) }));
      assert.deepStrictEqual([many.code, many.field, many.limit], ["count", "attachments", 10]);
      assert.strictEqual(caught(() => buildPost(OTTO, { content: "x", parent: "not a uri" })).code, "reference");
      // An owner given as a URL gets the reference's answer for a key, under the argument's name
      const url = caught(() => buildUser("pubky://" + OTTO, { name: "Alice" }));
      assert.deepStrictEqual([url.message, url.code, url.field], ["Validation Error: the string is not 52 ASCII characters", "format", "owner"]);
      // A shape refusal names its member too
      const shape = caught(() => buildPost(OTTO, { content: "x", attachments: [{ uri: 1 }] }));
      assert.ok(shape instanceof specs.ArgumentError && shape instanceof TypeError);
      assert.strictEqual(shape.field, "input.attachments[0].uri");
      // A well-formedness refusal names its argument wherever it sits
      assert.strictEqual(caught(() => specs.planUnpublish({ id: "\ud800", publicPaths: [] })).field, "post.id");
    });

    it("a refusal carries the reference text as its reason, and the member or argument it is about", () => {
      const name = caught(() => buildUser(OTTO, { name: "ab" }));
      assert.strictEqual(name.reason, "name must be 3 to 50 code points");
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
      // The brand is an own member: one inherited from a prototype is no brand
      assert.ok(!(Object.create({ [Symbol.for("pubky-social-specs.ValidationError")]: true }) instanceof ValidationError));
      const e = caught(() => buildUser(OTTO, { name: "" }));
      assert.strictEqual(e.name, "ValidationError");
      assert.ok(e instanceof Error && e.stack.includes("buildUser"));
    });

    it("text holding a lone surrogate has no answer", () => {
      const lone = "Validation Error: text must be well-formed UTF-16";
      refuses(() => buildUser(OTTO, { name: "Al\ud800ice" }), lone);
      refuses(() => buildTag(OTTO, buildUri(RIO, "user"), "\udc00"), lone);
      refuses(() => parseUri("pubky://\ud83d"), lone);
      assert.strictEqual(caught(() => decodeContent({ kind: "article", content: '{"title":"\ud800","body":"b"}' })).code, "format");
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

    it("the default clock reads microseconds, so ids from two copies in one millisecond rarely meet", () => {
      setClock();
      const micros = Array.from({ length: 50 }, () => buildFollow(OTTO, RIO).object.created_at % 1000);
      assert.ok(new Set(micros).size > 1, "every created_at sat on a millisecond");
      const wall = Date.now() * 1000;
      assert.ok(Math.abs(buildFollow(OTTO, RIO).object.created_at - wall) < 5_000_000);
    });

    it("a post built after an edit in the same instant never takes an earlier post's id", () => {
      const ids = new Set();
      for (let i = 0; i < 200; i++) {
        const post = buildPost(OTTO, { content: `post ${i}` });
        editPost(OTTO, post.url, { ...post.object, content: `edited ${i}` });
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
      assert.strictEqual(long.id, "~Q20TTDQ4RNRNT1MS87XPGS9BDM");
      assert.strictEqual(text(long.body), `{"created_at":${T0 * 1000},"target":"https://example.com/${"p".repeat(200)}"}`);
      assert.strictEqual(parseUri(long.url).target, undefined);
      refuses(() => decodeObject(buildUri(OTTO, "bookmark", `~${"0".repeat(26)}`), long.body), `Validation Error: bookmark filename does not hash its target: ${long.object.target}`);
      assert.strictEqual(text(buildFollow(OTTO, RIO).body), `{"created_at":${T0 * 1000}}`);
      assert.strictEqual(buildFollow(OTTO, RIO).path, `/pub/social/v1/follows/${RIO}.json`);
      assert.strictEqual(buildMute(OTTO, RIO).path, `/priv/social/v1/mutes/${RIO}.json`);
      const badTarget = caught(() => buildBookmark(OTTO, "not a uri"));
      assert.deepStrictEqual([badTarget.constructor, badTarget.code, badTarget.field], [ValidationError, "reference", "target"]);
      const mutee = caught(() => buildMute(OTTO, "nope"));
      assert.deepStrictEqual([mutee.constructor, mutee.code, mutee.field], [ValidationError, "format", "mutee"]);
    });

    it("a feed is named by its filter, folded and sorted", () => {
      const built = buildFeed(OTTO, { name: " Tech ", icon: " Star ", reach: "all", layout: "columns", sort: "recent", tags: ["Rust", "go", "rust"] });
      assert.deepStrictEqual(built.object.feed.tags, ["go", "rust"]);
      assert.strictEqual(built.object.icon, "star");
      assert.strictEqual(built.path, `/priv/social/v1/feeds/${built.id}.json`);
      assert.strictEqual(feedId(built.object), built.id);
      assert.deepStrictEqual(feedPaths(built.id), { private: built.path, public: `/pub/social/v1/feeds/${built.id}.json` });
      refuses(() => feedPaths("_x"), /^Validation Error: Invalid ID/);
      misuse(() => feedPaths(1), /id must be a string/);
      assert.notStrictEqual(feedId({ ...built.object, feed: { ...built.object.feed, sort: "popularity" } }), built.id);
      refuses(() => buildFeed(OTTO, { name: "x", icon: "star", reach: "galaxy", layout: "columns", sort: "recent" }), "Validation Error: Invalid feed reach: galaxy");
      misuse(() => feedId({ ...built.object, feed: { ...built.object.feed, tags: [1] } }), /feed\.feed\.tags\[0\] must be a string/);
      // The ids the reference pins and gives
      const plain = { feed: { tags: null, reach: "all", layout: "list", sort: "popularity", content: null }, name: "Test Feed", icon: "rss", created_at: T0 * 1000 };
      assert.strictEqual(feedId(plain), "H91HYJTYNCGYA2EP13ZQTRVD5G");
      const rust = buildFeed(OTTO, { name: "Rust", icon: "crab", reach: "wot", layout: "columns", sort: "recent", tags: ["rust"], domain_tags: ["dev"] });
      assert.strictEqual(rust.id, "E7MXYTT187N9GPZFEM41AQ5JD8");
      const body = `{"feed":{"tags":["rust"],"domain_tags":["dev"],"reach":"wot","layout":"columns","sort":"recent","content":null},"name":"Rust","icon":"crab","created_at":${T0 * 1000}}`;
      assert.strictEqual(text(rust.body), body);
      assert.deepStrictEqual(decodeObject(rust.url, utf8(body)).object, {
        feed: { tags: ["rust"], domain_tags: ["dev"], reach: "wot", layout: "columns", sort: "recent", content: null },
        name: "Rust",
        icon: "crab",
        created_at: T0 * 1000,
      });
      assert.deepStrictEqual(
        [feedReaches, feedLayouts, feedSorts],
        [
          ["following", "followers", "friends", "all", "wot", "me"],
          ["columns", "wide", "visual", "list", "cards"],
          ["recent", "popularity"],
        ],
      );
    });

    it("media goes by the hash of its bytes, from the bytes or from an id hashed elsewhere", () => {
      const bytes = new Uint8Array(100_000).map((_, i) => i % 251);
      const file = buildFile(OTTO, { bytes, type: "image/png" });
      assert.strictEqual(file.url, `pubky://${OTTO}/pub/social/v1/files/${file.id}.png`);
      const hasher = createMediaHasher();
      for (let at = 0; at < bytes.length; at += 7001) hasher.update(bytes.subarray(at, at + 7001));
      assert.strictEqual(hasher.id(), file.id);
      // The id of no bytes, and an id read halfway with the feed going on
      assert.strictEqual(createMediaHasher().id(), "NW9MKEFNZ6GTD8209QN3DQ6994");
      const halfway = createMediaHasher();
      halfway.update(new Uint8Array([1]));
      assert.strictEqual(halfway.id(), buildFile(OTTO, { bytes: new Uint8Array([1]), type: "image/png" }).id);
      halfway.update(new Uint8Array([2]));
      assert.strictEqual(halfway.id(), "PZBQ010FF079VVZPQG1RNFN6DR");
      assert.deepStrictEqual(buildFile(OTTO, { id: hasher.id(), type: "IMAGE/PNG; q=1", root: "private" }).path, `/priv/social/v1/files/${file.id}.png`);
      assert.ok(buildFile(OTTO, { bytes, type: "application/x-unknown" }).path.endsWith(".bin"));
      // A type is folded and cut at its parameters, and its subtype may hold a +
      assert.ok(buildFile(OTTO, { bytes, type: "Image/SVG+XML; charset=utf-8" }).path.endsWith(".svg"));
      refuses(() => buildFile(OTTO, { bytes: new Uint8Array(0), type: "image/png" }), "Validation Error: File size cannot be zero");
      refuses(() => buildFile(OTTO, { id: "not-a-hash", type: "image/png" }), /Invalid ID length/);
      assert.deepStrictEqual(decodeObject(file.url, bytes), { kind: "file", bytes });
      const realm = vm.runInNewContext("new Uint8Array([1, 2, 3])");
      assert.deepStrictEqual([...encodeObject({ kind: "file" }, realm)], [1, 2, 3]);
      assert.strictEqual(buildFile(OTTO, { bytes: realm, type: "image/png" }).id, buildFile(OTTO, { bytes: new Uint8Array([1, 2, 3]), type: "image/png" }).id);
    });
    it("media is refused past the size cap, and under an id its bytes do not hash to", function () {
      // Hashing media at the cap takes seconds
      this.timeout(60_000);
      const over = new Uint8Array(limits.maxFileSizeBytes + 1);
      const { url } = buildFile(OTTO, { bytes: new Uint8Array([1, 2]), type: "image/png" });
      const tooBig = caught(() => buildFile(OTTO, { bytes: over, type: "image/png" }));
      assert.strictEqual(tooBig.message, "Validation Error: File size exceeds maximum limit of 100MB");
      assert.deepStrictEqual([tooBig.code, tooBig.limit], ["size", 104857600]);
      refuses(() => decodeObject(url, over), "Validation Error: File size exceeds maximum limit of 100MB");
      assert.strictEqual(buildFile(OTTO, { bytes: over.subarray(1), type: "image/png" }).path.endsWith(".png"), true);
      refuses(() => decodeObject(url, new Uint8Array([1, 3])), "Validation Error: Invalid ID: expected TAPHM2XSZQT4A2YRE58W12WSD0, found PZBQ010FF079VVZPQG1RNFN6DR");
    });

    it("media in a Node Buffer or a view into a larger buffer is read where the view says", () => {
      const pool = new Uint8Array(4096).map((_, i) => i * 7);
      const view = new Uint8Array(pool.buffer, 1000, 300);
      const buffer = Buffer.from(pool.buffer, 1000, 300);
      const plain = buildFile(OTTO, { bytes: view.slice(), type: "image/png" });
      assert.notStrictEqual(view.byteOffset, 0);
      assert.strictEqual(buildFile(OTTO, { bytes: view, type: "image/png" }).id, plain.id);
      assert.strictEqual(buildFile(OTTO, { bytes: buffer, type: "image/png" }).id, plain.id);
      assert.deepStrictEqual([...decodeObject(plain.url, buffer, "file")], [...view]);
      assert.deepStrictEqual([...decodeObject(plain.url, view, "file")], [...view]);
      assert.deepStrictEqual([...encodeObject(plain.url, buffer)], [...view]);
    });

    it("hashMedia gives the id buildFile gives, from a Blob or a stream, a chunk at a time", async () => {
      const bytes = new Uint8Array(3 * 65536 + 7).map((_, i) => i * 31);
      const { id } = buildFile(OTTO, { bytes, type: "image/png" });
      assert.strictEqual(await hashMedia(new Blob([bytes])), id);
      assert.strictEqual(await hashMedia(new Blob([bytes]).stream()), id);
      assert.strictEqual(await hashMedia(new Blob([])), "NW9MKEFNZ6GTD8209QN3DQ6994");
      await assert.rejects(hashMedia("bytes"), (e) => e instanceof TypeError && /source must be a Blob or a ReadableStream/.test(e.message));
      await assert.rejects(hashMedia(new Response("text").body.pipeThrough(new TextDecoderStream())), /a chunk of source must be a Uint8Array/);
    });

    it("hashMedia reads a Blob that cannot stream, as jsdom's cannot, whole", async () => {
      const bytes = utf8("a picture");
      const blob = { arrayBuffer: async () => bytes.slice().buffer };
      assert.strictEqual(await hashMedia(blob), buildFile(OTTO, { bytes, type: "image/png" }).id);
      await assert.rejects(hashMedia({ arrayBuffer: async () => "bytes" }), (e) => e instanceof TypeError && /source must be a Uint8Array or an ArrayBuffer/.test(e.message));
    });

    it("toUrl is toPath backwards, and isOneOf narrows to a table's names", () => {
      const post = buildPost(OTTO, { content: "x" });
      assert.strictEqual(toUrl(OTTO, post.path), post.url);
      assert.strictEqual(toPath(toUrl(OTTO, "/pub/pubky.app/tags/X")), "/pub/pubky.app/tags/X");
      assert.strictEqual(caught(() => toUrl(OTTO, post.url)).code, "path");
      assert.strictEqual(caught(() => toUrl("otto", post.path)).field, "owner");
      assert.deepStrictEqual([isOneOf(postKinds, "article"), isOneOf(postKinds, "podcast"), isOneOf(feedLayouts, "cards"), isOneOf(postKinds, 1)], [true, false, true, false]);
    });

    it("parsePubkyUrl with a kind refuses the URL of another one", () => {
      const post = buildPost(OTTO, { content: "x" });
      assert.strictEqual(parsePubkyUrl(post.url, "post"), post.url);
      const other = caught(() => parsePubkyUrl(post.url, "feed"));
      assert.deepStrictEqual([other.code, other.message], ["path", `Validation Error: ${post.url} names a post, not a feed`]);
      assert.strictEqual(caught(() => parsePubkyUrl(post.url, "nope")).code, "unknown_name");
    });

    it("the session grants are in the main entry", () => {
      assert.strictEqual(ENGINE_CAPS, "/pub/social/v1/:rw,/priv/social/v1/:rw");
      assert.strictEqual(MIGRATION_CAPS, `${ENGINE_CAPS},/priv/app.pubky/v1/:rw,/pub/pubky.app/:rw`);
    });
  });

  describe("reading and writing stored objects", () => {
    it("without a URL, bytes are read under the root given and by no rule that needs a path", () => {
      const post = buildPost(OTTO, { content: "x", root: "private", attachments: [{ uri: `pubky://${OTTO}/priv/social/v1/files/0000000000000000000000000G.png` }] });
      // A path names the author, and under another one the private media is someone else's
      assert.strictEqual(caught(() => decodeObject(toUrl(RIO, post.path), post.body)).code, "reference");
      assert.deepStrictEqual(decodeObject({ kind: "post", root: "private" }, post.body), post.object);
      assert.match(caught(() => decodeObject({ kind: "post" }, post.body)).message, /private/);
      const feed = buildFeed(OTTO, { name: "Rust", icon: "crab", reach: "all", layout: "cards", sort: "recent" });
      assert.deepStrictEqual(decodeObject({ kind: "feed" }, feed.body), feed.object);
      assert.deepStrictEqual(encodeObject({ kind: "feed" }, decodeObject({ kind: "feed" }, feed.body)), feed.body);
      assert.deepStrictEqual(decodeObject({ kind: "file" }, utf8("raw")), utf8("raw"));
      assert.deepStrictEqual(tryDecodeObject({ kind: "user" }, utf8("{}")).ok, false);
      assert.strictEqual(caught(() => decodeObject({ kind: "nope" }, post.body)).code, "unknown_name");
      misuse(() => decodeObject({ kind: "post", path: "x" }, post.body), /path/);
    });

    it("an envelope reads from a kind and a content alone", () => {
      const article = buildPost(OTTO, { kind: "article", title: "On pubky", body: "..." });
      assert.deepStrictEqual(decodeContent({ kind: "article", content: article.object.content }), decodeContent(article.object));
      assert.strictEqual(decodeContent({ kind: "note", content: "x" }), null);
    });

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

    it("without a URL, an object is checked under the root given and by no rule that needs a path", () => {
      const own = buildUri(OTTO, "post", "0034A0X7NJ52G");
      const reply = { content: "x", kind: "note", parent: own.replace("/pub/", "/priv/"), embed: null };
      refuses(() => encodeObject({ kind: "post" }, reply), /must not reference a private object/);
      assert.ok(encodeObject({ kind: "post", root: "private" }, reply).length > 0);
      // No filename to hash, no id to match, no path to name the author
      const tag = buildTag(OTTO, buildUri(RIO, "user"), "rust").object;
      assert.deepStrictEqual(encodeObject({ kind: "tag" }, { ...tag, label: "go" }), utf8(`{"uri":"${tag.uri}","label":"go","created_at":${tag.created_at}}`));
      const feed = buildFeed(OTTO, { name: "All", icon: "star", reach: "all", layout: "columns", sort: "recent" }).object;
      assert.ok(encodeObject({ kind: "feed", root: "public" }, { ...feed, feed: { ...feed.feed, sort: "popularity" } }).length > 0);
      const long = `https://example.com/${"p".repeat(200)}`;
      assert.ok(encodeObject({ kind: "bookmark" }, { created_at: T0 * 1000, target: long }).length > 0);
    });

    it("decodeObject with the kind expected gives the object, and refuses a URL naming another kind before reading", () => {
      const follow = buildFollow(OTTO, RIO);
      assert.deepStrictEqual(decodeObject(follow.url, follow.body, "follow"), follow.object);
      const media = buildFile(OTTO, { bytes: utf8("hi"), type: "image/png" });
      assert.deepStrictEqual(decodeObject(media.url, utf8("hi"), "file"), utf8("hi"));
      assert.throws(
        () => decodeObject(follow.url, new Uint8Array(), "post"),
        (e) => e instanceof ValidationError && e.field === "uri" && /names a follow, not a post/.test(e.reason),
      );
      refuses(() => decodeObject(follow.url, follow.body, "posts"), /unknown variant `posts`, expected one of `user`, `post`/);
    });

    it("a path passed where a URL goes is refused as no canonical URI, and toPath gives the path of a URL", () => {
      const follow = buildFollow(OTTO, RIO);
      const notAUri = `Validation Error: Not a canonical pubky URI: ${follow.path}`;
      refuses(() => decodeObject(follow.path, follow.body), notAUri);
      refuses(() => encodeObject(follow.path, follow.object), notAUri);
      refuses(() => editPost(OTTO, follow.path, buildPost(OTTO, { content: "x" }).object), notAUri);
      assert.strictEqual(toPath(follow.url), follow.path);
      assert.strictEqual(toPath(`pubky://${OTTO}/pub/pubky.app/follows/${RIO}`), `/pub/pubky.app/follows/${RIO}`);
      // Every kind, under each root it can be stored in
      const post = buildPost(OTTO, { content: "x" });
      const media = buildFile(OTTO, { bytes: utf8("x"), type: "image/png" });
      for (const built of [
        buildUser(OTTO, { name: "Alice" }),
        post,
        buildPost(OTTO, { content: "x", root: "private" }),
        buildMute(OTTO, RIO),
        buildBookmark(OTTO, post.url.replace(/\/[^/]+\.json$/, "")),
        buildTag(OTTO, buildUri(RIO, "user"), "rust"),
        media,
        buildFile(OTTO, { bytes: utf8("x"), type: "image/png", root: "private" }),
        buildFeed(OTTO, { name: "Rust", icon: "crab", reach: "all", layout: "columns", sort: "recent" }),
      ]) {
        assert.strictEqual(toPath(built.url), built.path, built.url);
      }
      refuses(() => toPath(`pubky://${OTTO}`), /not the URL of a stored object/);
      refuses(() => toPath(`pubky://${OTTO}/pub/../x`), /Not a canonical pubky URI/);
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

    it("caps the bytes as stored on a read and the written form on a write", () => {
      const url = buildUri(OTTO, "user");
      const padded = (head, size) => utf8(`${head},"pad":"${"p".repeat(size - head.length - 10)}"}`);
      const full = '{"name":"Alice","bio":null,"image":null,"links":null,"status":null';
      const { object } = decodeObject(url, padded(full, 65536));
      assert.strictEqual(encodeObject(url, object).length, 65536);
      refuses(() => decodeObject(url, padded(full, 65537)), "Validation Error: object exceeds 65536 bytes");
      // The reader fills in the absent bio, and the written form goes over the cap
      const short = decodeObject(url, padded('{"name":"Alice","image":null,"links":null,"status":null', 65536));
      assert.strictEqual(short.object.bio, null);
      refuses(() => encodeObject(url, short.object), "Validation Error: object exceeds 65536 bytes");
    });

    it("caps a feed's filter with its object, as stored on a read", () => {
      const feed = buildFeed(OTTO, { name: "All", icon: "star", reach: "all", layout: "list", sort: "recent" });
      // 50 KB as stored; the written form spells each number in three more bytes, past the cap
      const stored = utf8(text(feed.body).replace('"reach"', `"pad":[${Array(10_000).fill("1e-5").join(",")}],"reach"`));
      const read = decodeObject(feed.url, stored, "feed");
      refuses(() => encodeObject(feed.url, read), "Validation Error: object exceeds 65536 bytes");
    });

    it("keeps members a newer writer added to a link, and checks them", () => {
      const url = buildUri(OTTO, "user");
      const stored = '{"name":"Alice","bio":null,"image":null,"links":[{"title":"t","url":"https://a.b/","rel":"me"}],"status":null}';
      const { object } = decodeObject(url, utf8(stored));
      assert.strictEqual(object.links[0].$unknown, '{"rel":"me"}');
      assert.strictEqual(text(encodeObject(url, object)), stored);
      refuses(() => decodeObject(url, utf8(stored.replace('"rel":"me"', '"n":9007199254740992'))), "Validation Error: integer 9007199254740992 outside the JSON-safe range (in extra member n)");
      refuses(() => buildUser(`l${OTTO.slice(1)}`, { name: "Alice" }), "Validation Error: invalid public key encoding");
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
      refuses(read('{"name":"­é\\n"}'.replace('"­', '{"x":"­').replace('\\n"}', '\\n"}}')), "Validation Error: invalid type: map, expected a string");
      // The encoding is checked at the closing quote, before the string's type
      refuses(() => decodeObject(url, new Uint8Array([0x22, 0xff, 0x22])), "Validation Error: invalid unicode code point");
      refuses(() => decodeObject(url, Uint8Array.from([...utf8('{"name":"A'), 0xc3, ...utf8('l"}')])), "Validation Error: invalid unicode code point");
      refuses(() => decodeObject(buildUri(OTTO, "post", "0034A0X7NJ52G"), utf8("{}")), "Validation Error: a versionless post reference is never a stored object");
      refuses(() => decodeObject(`pubky://${OTTO}/pub/other.app/v1/x`, utf8("{}")), "Validation Error: a foreign namespace is not a social object");
    });

    it("an argument of the wrong type is an ArgumentError from every entry that reads one", () => {
      const calls = {
        buildTag: () => specs.buildTag(OTTO, 7, "label"),
        buildBookmark: () => specs.buildBookmark(OTTO, 7),
        buildFollow: () => specs.buildFollow(OTTO, 7),
        buildMute: () => specs.buildMute(7, RIO),
        planPublish: () => specs.planPublish(OTTO, 7),
        planUnpublish: () => specs.planUnpublish(OTTO, 7),
        planDelete: () => specs.planDelete(7),
        deletionPaths: () => specs.deletionPaths(7),
        decodeContent: () => specs.decodeContent({ kind: "article", content: 7 }),
        parseUri: () => specs.parseUri(7),
        buildUri: () => specs.buildUri(OTTO, "follow", 7),
        listPrefix: () => specs.listPrefix(7, "public"),
        toPath: () => specs.toPath(7),
        toUrl: () => specs.toUrl(OTTO, 7),
        idMicros: () => specs.idMicros(7),
        parseOwner: () => specs.parseOwner(7),
        parseEditId: () => specs.parseEditId(7),
        parsePostId: () => specs.parsePostId(7),
        parseMediaId: () => specs.parseMediaId(7),
        parsePubkyUrl: () => specs.parsePubkyUrl(7),
        parseOwnerPath: () => specs.parseOwnerPath(7),
        parsePostRef: () => specs.parsePostRef(7),
      };
      for (const [name, call] of Object.entries(calls)) assert.ok(caught(call) instanceof specs.ArgumentError, `${name}: ${caught(call)}`);
    });

    it("an integer is a number, and one a double cannot hold is refused before it is one", () => {
      const url = buildUri(OTTO, "follow", RIO);
      assert.strictEqual(decodeObject(url, utf8('{"created_at":9007199254740991}')).object.created_at, Number.MAX_SAFE_INTEGER);
      refuses(() => decodeObject(url, utf8('{"created_at":9007199254740992}')), "Validation Error: integer 9007199254740992 outside the JSON-safe range");
      // A fraction is a number, as the type asks: the refusal the stored text gets, not a misuse
      refuses(() => encodeObject(url, { created_at: 1.5 }), "Validation Error: invalid type: floating point `1.5`, expected i64");
      refuses(() => decodeObject(url, utf8('{"created_at":1.5}')), "Validation Error: invalid type: floating point `1.5`, expected i64");
      misuse(() => encodeObject(url, { created_at: Number.NaN }), /follow\.created_at must be an integer/);
      misuse(() => encodeObject(url, { created_at: 1n }), /follow\.created_at must be an integer/);
    });

    it("a polluted Object.prototype or Array.prototype never reaches a built or encoded object", () => {
      const polluted = {
        parent: "https://evil.example/",
        root: "private",
        embed: "https://evil.example/",
        lock: buildUri(RIO, "user"),
        slug: "x",
        $unknown: '{"evil":1}',
        kind: "article",
        title: "t",
        name: "n",
      };
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
    });

    it("values no JSON holds are refused as shapes: holes, getters that throw, cycles", () => {
      const url = buildUri(OTTO, "user");
      const base = buildUser(OTTO, { name: "Alice" }).object;
      const sparse = [];
      sparse[1] = { title: "t", url: "https://example.com" };
      misuse(() => encodeObject(url, { ...base, links: sparse }), /user\.links\[0\] must be an object/);
      const cyclic = { ...base };
      cyclic.links = [cyclic];
      misuse(() => encodeObject(url, cyclic), /object\.links\[0\] must be plain data, not a structure that contains itself/);
      let deep = { name: "x" };
      for (let i = 0; i < 40; i++) deep = { links: [deep] };
      misuse(() => encodeObject(url, deep), /must be plain data nested at most 32 deep/);
      const trap = {
        ...base,
        get bio() {
          throw new RangeError("mine");
        },
      };
      assert.throws(() => encodeObject(url, trap), RangeError);
      misuse(() => encodeObject(url, new Map()), /user\.name must be given/);
    });

    it("reads a caller's value once, before any rule: a getter or a Proxy cannot answer twice", () => {
      let reads = 0;
      const input = {
        get content() {
          return ++reads === 1 ? "first" : "x".repeat(5000);
        },
      };
      assert.strictEqual(text(buildPost(OTTO, input).body).includes('"first"'), true);
      assert.strictEqual(reads, 1);
      const traps = [];
      const proxy = new Proxy({ name: "Alice", bio: "b" }, { get: (t, k) => (traps.push(k), t[k]), ownKeys: (t) => (traps.push("ownKeys"), Reflect.ownKeys(t)) });
      buildUser(OTTO, proxy);
      assert.deepStrictEqual(traps, ["ownKeys", "name", "bio"]);
      // One object reached twice is read once
      let shared = 0;
      const attachment = {
        get uri() {
          shared++;
          return "https://example.com/a.png";
        },
      };
      buildPost(OTTO, { kind: "image", content: "c", attachments: [attachment, attachment] });
      assert.strictEqual(shared, 1);
    });

    it("brands where data enters, and refuses what is not that kind", () => {
      const built = buildPost(OTTO, { content: "hello" });
      assert.strictEqual(specs.parseOwner(OTTO), OTTO);
      assert.strictEqual(specs.parsePostId(built.id), built.id);
      assert.strictEqual(specs.parseEditId(built.editId), built.editId);
      assert.strictEqual(specs.parsePubkyUrl(`pubky${OTTO}${built.path}`), built.url);
      assert.strictEqual(specs.parseOwnerPath(built.path), built.path);
      assert.strictEqual(specs.parsePostRef(buildUri(OTTO, "post", built.id)), buildUri(OTTO, "post", built.id));
      const media = buildFile(OTTO, { bytes: utf8("hi"), type: "image/png" });
      assert.strictEqual(specs.parseMediaId(media.id), media.id);
      refuses(() => specs.parseOwner("nope"), /not 52 ASCII characters/);
      for (const [parse, value] of [
        [specs.parsePostId, media.id],
        [specs.parseEditId, media.id],
        [specs.parseEditId, built.editId.toLowerCase()],
        [specs.parseMediaId, built.id],
      ]) {
        const e = caught(() => parse(value));
        assert.deepStrictEqual([e.constructor, e.code], [ValidationError, "format"], `${parse.name}(${value})`);
      }
      misuse(() => specs.parseEditId(1), /editId must be a string/);
      refuses(() => specs.parsePubkyUrl(buildUri(OTTO, "post", built.id)), /not the URL of a stored object/);
      refuses(() => specs.parsePubkyUrl(`pubky://${OTTO}/pub/pubky.app/posts/x`), /not the URL of a stored object/);
      refuses(() => specs.parsePostRef(built.url), /not a reference to a post/);
      refuses(() => specs.parseOwnerPath(built.url), /not an owner-relative path/);
      refuses(() => specs.parseOwnerPath("/pub/social/../x"), /not an owner-relative path/);
      refuses(() => specs.parseOwnerPath("/etc/passwd"), /not an owner-relative path/);
      misuse(() => specs.parseOwner(1), /owner must be a string/);
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
    it("an edit refuses a head so far ahead that no newer id fits under the future bound", () => {
      setClock(() => T0 + 7_200_000 - 30_000);
      const ahead = buildPost(OTTO, { content: "x" });
      setClock(() => T0);
      const e = caught(() => editPost(OTTO, ahead.url, { ...ahead.object, content: "y" }));
      assert.ok(e instanceof ValidationError);
      assert.deepStrictEqual([e.message, e.code, e.field], ["Validation Error: the current version leaves no room for a newer id", "id", "head"]);
    });

    it("encodeObject checks the version its destination names, as decodeObject does", () => {
      const post = buildPost(OTTO, { content: "x" });
      const at = (id, editId) => `pubky://${OTTO}/pub/social/v1/posts/${id}/${editId}.json`;
      refuses(() => encodeObject(at("0034A0X7NJ52C", "0032FNCGXE3R0"), post.object), "Validation Error: version 0032FNCGXE3R0 is older than the post id 0034A0X7NJ52C");
      setClock(() => T0 + 3 * 3_600_000);
      const late = buildPost(OTTO, { content: "x" });
      setClock(() => T0);
      refuses(() => encodeObject(at(post.id, late.editId), post.object), "Validation Error: Invalid ID, timestamp is too far in the future");
      for (const uri of [at("0034A0X7NJ52C", "0032FNCGXE3R0"), at(post.id, late.editId)]) refuses(() => decodeObject(uri, post.body, "post"), /older than the post id|too far in the future/);
    });

    it("drafts privately, edits, publishes, unpublishes and deletes", () => {
      const media = buildFile(OTTO, { bytes: utf8("png"), type: "image/png", root: "private" });
      const draft = buildPost(OTTO, { content: "draft", attachments: [{ uri: media.url }], root: "private", slug: "first" });
      assert.strictEqual(draft.path, `/priv/social/v1/posts/${draft.id}/${draft.id}-first.json`);

      const edited = editPost(OTTO, draft.url, { ...draft.object, content: "better" });
      assert.strictEqual(edited.id, draft.id);
      assert.ok(edited.editId > draft.editId && edited.path.startsWith("/priv/"), "an edit stays under the head's root");
      assert.strictEqual(text(edited.body), text(draft.body).replace("draft", "better"));
      refuses(() => editPost(OTTO, draft.url, draft.object, { root: "public" }), /attachments\[0\]\.uri must not reference a private object/);
      assert.ok(editPost(OTTO, draft.url, { ...draft.object, attachments: [] }, { root: "public", slug: "x" }).path.endsWith("-x.json"));
      refuses(() => editPost(OTTO, buildUri(OTTO, "post", draft.id), draft.object), /not the URI of a stored post version/);

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
        copies: [
          { root: "private", path: edited.path },
          { root: "public", path: plan.put.path },
          { root: "private", path: draft.path },
        ],
        versions: [edited.object, plan.put.object],
      });
      assert.deepStrictEqual(gone.deletes, [`/pub/pubky.app/posts/${draft.id}`, draft.path, plan.put.path, edited.path]);
      assert.deepStrictEqual(gone.mediaGcCandidates, [media.path, media.path.replace("/priv/", "/pub/")].sort());
      refuses(() => planDelete(OTTO, { id: draft.id, legacyPaths: ["/pub/x"] }), `Validation Error: not a legacy path of post ${draft.id}: /pub/x`);
    });

    it("a head from a faster clock still gets a successor, the same one for the same edit", () => {
      const head = buildPost(OTTO, { content: "from the future" });
      setClock(() => T0 - 60_000);
      const a = editPost(OTTO, head.url, { ...head.object, content: "edit" });
      setClock(() => T0 - 60_000);
      const b = editPost(OTTO, head.url, { ...head.object, content: "edit" });
      assert.ok(a.editId > head.editId);
      assert.strictEqual(a.editId, b.editId);
      setClock(() => T0 - 60_000);
      assert.notStrictEqual(editPost(OTTO, head.url, { ...head.object, content: "another edit" }).editId, a.editId);
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
        assert.throws(
          () => buildUri(OTTO, kind, id),
          (e) => e instanceof ValidationError && e.field === "id",
          `${kind} ${id}`,
        );
      }
      // The reference's words: its emitter reparses the spelling, and holds a followee as a key
      refuses(() => buildUri(OTTO, "post", "not-an-id"), `Validation Error: value cannot be spelled canonically: pubky://${OTTO}/pub/social/v1/posts/not-an-id`);
      refuses(() => buildUri(OTTO, "follow", "nope"), "Validation Error: the string is not 52 ASCII characters");
      const media = buildFile(OTTO, { bytes: utf8("hello"), type: "image/png" });
      const parsed = parseUri(media.url);
      assert.strictEqual(parsed.filename, `${media.id}.png`);
      assert.strictEqual(buildUri(OTTO, "file", parsed.filename), media.url);
    });

    it("classifies what is no social object as a kind, never an error", () => {
      assert.deepStrictEqual(parseUri(`pubky://${OTTO}/pub/other.app/v2/a/b`), {
        owner: OTTO,
        root: "public",
        path: "/pub/other.app/v2/a/b",
        kind: "foreign",
        namespace: "other.app",
        version: "v2",
        rest: ["a", "b"],
      });
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
      assert.deepStrictEqual(deletionPaths({ kind: "mute", id: RIO, listings: null }), [`/pub/pubky.app/mutes/${RIO}`, `/priv/social/v1/mutes/${RIO}.json`]);
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
