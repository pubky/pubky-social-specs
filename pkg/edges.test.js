// Edges of the core no recorded vector reaches: the mutation pass (Stryker over ids, clock,
// canonicalize, deletion, lifecycle) showed a change of each of these went unnoticed.

import assert from "assert";
import * as specs from "./dist/index.js";
import { execFileSync } from "node:child_process";
import { fakeOwner, sampleFeed, samplePost, sampleUser, setClock } from "./dist/testing.js";
import { canonicalExternal, canonicalPubky, canonicalUniversal, reference } from "./dist/canonicalize.js";
import { hashText } from "./dist/ids.js";

const { ValidationError, limits, buildFile, buildPost, buildTag, buildUri, deletionPaths, parseOwner, planDelete, planPublish, planUnpublish, parseUri } = specs;

const OTTO = "8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto";
const RIO = "dzswkfy7ek3bqnoc89jxuqqfbzhjrj6mi8qthgbxxcqkdugm3rio";
const T0 = 1_790_000_000_000;
const LEGACY = "/pub/pubky.app/";
const utf8 = (s) => new TextEncoder().encode(s);

const refuses = (fn, message) =>
  assert.throws(fn, (e) => {
    assert.ok(e instanceof ValidationError, `expected a ValidationError, got ${e}`);
    message instanceof RegExp ? assert.match(e.message, message) : assert.strictEqual(e.message, message);
    return true;
  });
const misuse = (fn, pattern) => assert.throws(fn, (e) => e instanceof TypeError && !(e instanceof ValidationError) && pattern.test(e.message));

describe("edges", () => {
  beforeEach(() => setClock(() => T0));
  after(() => setClock());

  describe("ids and the clock", () => {
    it("refuses a key with a character outside z-base32 anywhere, not only at its end", () => {
      refuses(() => parseOwner(`l${OTTO.slice(1)}`), "Validation Error: invalid public key encoding");
      refuses(() => parseOwner(`${OTTO.slice(0, 20)}v${OTTO.slice(21)}`), "Validation Error: invalid public key encoding");
    });

    it("the default clock reads the wall clock to the millisecond, the microseconds inside it", () => {
      setClock();
      const before = Date.now();
      const { id } = buildPost(OTTO, { content: "now" });
      const after = Date.now();
      let micros = 0n;
      for (const c of id) micros = (micros << 5n) | BigInt("0123456789ABCDEFGHJKMNPQRSTVWXYZ".indexOf(c));
      micros >>= 1n;
      assert.ok(micros >= BigInt(before) * 1000n && micros < BigInt(after + 1) * 1000n, `${micros} outside ${before}..${after} ms`);
    });
  });

  describe("canonical references", () => {
    it("reads the SDK's short pubky form as the full one", () => {
      assert.strictEqual(canonicalPubky(`pubky${OTTO}/pub/x`), `pubky://${OTTO}/pub/x`);
      assert.strictEqual(canonicalPubky(`pubky${OTTO}`), `pubky://${OTTO}`);
      // Only `pubky` opens the short form, not any five characters
      assert.strictEqual(canonicalPubky(`xxxxx${OTTO}/pub/x`), null);
    });

    it("an external reference has a whole scheme before its colon and something after it", () => {
      assert.strictEqual(canonicalExternal("MAILTO:a@b"), "mailto:a@b");
      for (const raw of [":x", "x:", "ab!c:x", "1ab:x", "Pubky:x", "HTTPS:x"]) assert.strictEqual(canonicalExternal(raw), null, raw);
    });

    it("the length cap holds at its exact bound", () => {
      const max = limits.referenceUriMaxLength;
      const at = (n) => `https://e.com/${"a".repeat(n - "https://e.com/".length)}`;
      assert.strictEqual(canonicalUniversal(at(max)), at(max));
      assert.strictEqual(canonicalUniversal(at(max + 1)), null);
    });

    it("the root, ownership and versionless rules of a pubky reference", () => {
      assert.match(reference(`pubky://${OTTO}/priv`, "", 1000, true, null).refusal, /^must not reference a private object/);
      assert.match(reference(`pubky://${RIO}/priv/social/v1/files/x`, "", 1000, false, OTTO).refusal, /of another user/);
      assert.deepStrictEqual(reference(`pubky://${OTTO}/priv/social/v1/files/x`, "", 1000, false, OTTO), { canonical: `pubky://${OTTO}/priv/social/v1/files/x` });
      const post = buildPost(OTTO, { content: "x" });
      assert.match(reference(post.url, "", 1000, true, null).refusal, /^must be versionless/);
      // A root the parser does not know names nothing, which is no refusal here
      assert.deepStrictEqual(reference(`pubky://${OTTO}/elsewhere/x`, "", 1000, true, null), { canonical: `pubky://${OTTO}/elsewhere/x` });
    });
  });

  describe("reading", () => {
    const url = `pubky://${OTTO}/pub/social/v1/posts/0035QZPT4QG00/0035QZPT4QG00.json`;
    const post = (kind) => utf8(`{"content":"x","kind":${kind},"parent":null,"embed":null,"attachments":[]}`);

    it("reads a kind in serde's one-member object form, and refuses it as serde does", () => {
      assert.strictEqual(specs.decodeObject(url, post('{"image":null}'), "post").kind, "image");
      // The crate's answers, from its surface oracle
      const refusals = [
        ['{"note":1}', "invalid type: integer `1`, expected unit"],
        ["{1}", "invalid type: integer `1`, expected variant identifier"],
        ['{"note" null}', "expected `:`"],
        ['{"note":null,', "expected value"],
        ['{"note"', "expected `:`"],
        ["{", "expected value"],
        ['{"zzz":null}', "post kind is unknown"],
        ['{"note":nul}', "expected ident"],
      ];
      for (const [kind, reason] of refusals) refuses(() => specs.decodeObject(url, post(kind)), `Validation Error: ${reason}`);
    });

    it("takes back as $unknown only the text of an object", () => {
      const read = specs.decodeObject(url, post('"note"'), "post");
      for (const $unknown of ["{", "[1]", "1", '{"content":"x"}']) misuse(() => specs.encodeObject(url, { ...read, $unknown }), /post\.\$unknown must be/);
    });
  });

  describe("the testing subpath", () => {
    it("gives well-formed owners, the same for the same n, and fixtures that decode", () => {
      assert.strictEqual(fakeOwner(3), fakeOwner(3));
      assert.notStrictEqual(fakeOwner(3), fakeOwner(4));
      for (let n = 0; n < 50; n++) assert.strictEqual(parseOwner(fakeOwner(n)), fakeOwner(n));
      assert.throws(() => fakeOwner(-1), TypeError);
      const post = samplePost({ kind: "link", content: "https://example.com" }, RIO);
      assert.strictEqual(specs.decodeObject(post.url, post.body, "post").kind, "link");
      assert.strictEqual(sampleUser().object.name, "Sample User");
      assert.deepStrictEqual(sampleFeed({ tags: ["Rust"] }).object.feed.tags, ["rust"]);
    });
  });

  describe("the development warning", () => {
    const url = `pubky://${OTTO}/pub/social/v1/posts/0035QZPT4QG00/0035QZPT4QG00.json`;
    const stored = utf8('{"content":"x","kind":"note","parent":null,"embed":null,"attachments":[],"x_new":1}');
    const warnings = (fn) => {
      const original = console.warn;
      const seen = [];
      console.warn = (message) => seen.push(message);
      try {
        fn();
      } finally {
        console.warn = original;
      }
      return seen;
    };

    it("names an object written back without the members it was read with, and stays quiet otherwise", () => {
      const read = specs.decodeObject(url, stored, "post");
      assert.deepStrictEqual(
        warnings(() => specs.encodeObject(url, { ...read, content: "kept" })),
        [],
      );
      const { content, kind, parent, embed, attachments, lock } = read;
      const [warning] = warnings(() => specs.encodeObject(url, { content, kind, parent, embed, attachments, lock }));
      assert.match(warning, /encodeObject for .* carries 0 of the 1 \$unknown members/);
      assert.strictEqual(warnings(() => specs.editPost(url, { content, kind, parent, embed, attachments, lock })).length, 1);
    });

    it("is silent in production", () => {
      const script = `import * as s from "./dist/index.js"; const u = ${JSON.stringify(url)}; const r = s.decodeObject(u, new TextEncoder().encode(${JSON.stringify(new TextDecoder().decode(stored))}), "post"); console.warn = () => { throw new Error("warned"); }; const { $unknown, ...rest } = r; s.encodeObject(u, rest); console.log("quiet");`;
      const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, NODE_ENV: "production" } }).toString();
      assert.strictEqual(out.trim(), "quiet");
    });
  });

  describe("deletion paths of a 0.x tag", () => {
    const legacyTag = (uri, label) => ({ path: `${LEGACY}tags/${hashText(`${uri}:${label}`)}`, uri, label });
    const idFor = (target, label) => hashText(`${target}:${label}`);

    it("respells each 0.x target as its 1.x tag does, and proves the copy by both ids", () => {
      const post = "0034A0X7NJ52C";
      const cases = [
        [`pubky://${RIO}/pub/pubky.app/posts/${post}`, `pubky://${RIO}/pub/social/v1/posts/${post}`],
        [`pubky://${RIO}/pub/pubky.app/profile.json`, `pubky://${RIO}/pub/social/v1/profile.json`],
        [`pubky://${RIO}/pub/pubky.app/follows/${OTTO}`, `pubky://${RIO}/pub/social/v1/follows/${OTTO}.json`],
        ["https://example.com/a", "https://example.com/a"],
        ["http://example.com/a", "http://example.com/a"],
      ];
      for (const [uri, target] of cases) {
        const listing = legacyTag(uri, "Rust");
        const id = idFor(target, "rust");
        assert.deepStrictEqual(deletionPaths({ kind: "tag", id, listings: [{ ...listing, src: null, contentType: null }] }), [listing.path, `/pub/social/v1/tags/${id}.json`], uri);
      }
    });

    it("a 0.x tag on a file needs its File's src and type, which name the 1.x media", () => {
      const hash = buildFile(OTTO, { bytes: utf8("img"), type: "image/png" }).id;
      const uri = `pubky://${OTTO}/pub/pubky.app/files/0034A0X7NJ52C`;
      const listing = legacyTag(uri, "pic");
      const id = idFor(`pubky://${OTTO}/pub/social/v1/files/${hash}.png`, "pic");
      const src = `pubky://${OTTO}/pub/pubky.app/blobs/${hash}`;
      assert.deepStrictEqual(deletionPaths({ kind: "tag", id, listings: [{ ...listing, src, contentType: "image/png" }] }).at(0), listing.path);
      refuses(() => deletionPaths({ kind: "tag", id, listings: [listing] }), "Validation Error: a legacy tag on a file needs its File src and content_type");
      refuses(() => deletionPaths({ kind: "tag", id, listings: [{ ...listing, contentType: "image/png" }] }), "Validation Error: a legacy tag on a file needs its File src and content_type");
      refuses(() => deletionPaths({ kind: "tag", id, listings: [{ ...listing, src }] }), "Validation Error: a legacy tag on a file needs its File src and content_type");
      refuses(() => deletionPaths({ kind: "tag", id, listings: [{ ...listing, src: "https://x/y", contentType: "image/png" }] }), "Validation Error: not a legacy blob src: https://x/y");
    });

    it("refuses a 0.x target 1.x cannot spell, each with its reason", () => {
      const id = idFor("https://example.com/a", "x");
      const cases = [
        ["ftp://example.com", "not a tag target v1 spells: ftp://example.com"],
        ["https://exa mple.com", "not a canonical web uri: https://exa mple.com"],
        ["pubkynot-a-key", "not a pubky uri: pubkynot-a-key"],
        [`pubky://${RIO}`, `not a stored object: pubky://${RIO}`],
        [`pubky://${RIO}/pub/elsewhere/x`, `not a stored object: pubky://${RIO}/pub/elsewhere/x`],
      ];
      for (const [uri, reason] of cases) refuses(() => deletionPaths({ kind: "tag", id, listings: [legacyTag(uri, "x")] }), `Validation Error: ${reason}`);
      refuses(() => deletionPaths({ kind: "tag", id, listings: [legacyTag("https://example.com/b", "x")] }), /^Validation Error: legacy tag \S+ is not a copy of tag/);
    });

    it("names the member of a listing that has the wrong shape", () => {
      const id = idFor("https://example.com/a", "x");
      const ok = { path: "/p", uri: "u", label: "l" };
      for (const member of ["path", "uri", "label", "src", "contentType"]) {
        misuse(() => deletionPaths({ kind: "tag", id, listings: [{ ...ok, [member]: 1 }] }), new RegExp(`listings\\[0\\]\\.${member} must be a string`));
      }
      misuse(() => deletionPaths({ kind: "nope", id }), /target\.kind must be an object kind|kind must be an object kind/);
    });
  });

  describe("deletion paths of media", () => {
    const hash = () => buildFile(OTTO, { bytes: utf8("bytes"), type: "image/png" }).id;

    it("takes a 0.x File object only under files/, with a TimestampId and a src naming these bytes", () => {
      const h = hash();
      const src = `pubky://${OTTO}/pub/pubky.app/blobs/${h}`;
      const good = { path: `${LEGACY}files/0034A0X7NJ52C`, src };
      assert.deepStrictEqual(deletionPaths({ kind: "file", id: h, listings: [good] }).slice(0, 2), [good.path, `${LEGACY}blobs/${h}`]);
      for (const bad of [
        { ...good, path: `${LEGACY}posts/0034A0X7NJ52C` },
        { ...good, path: `${LEGACY}files/nope` },
        { ...good, src: `${src}x` },
      ]) {
        refuses(() => deletionPaths({ kind: "file", id: h, listings: [bad] }), /^Validation Error: not a stored copy of file/);
      }
      refuses(() => deletionPaths({ kind: "file", id: h, listings: [{ path: "/x", uri: "u", label: "l" }] }), /^Validation Error: not a stored copy of file/);
      // A tag's listing is refused even at the path of a copy of the file
      refuses(() => deletionPaths({ kind: "file", id: h, listings: [{ path: `/pub/social/v1/files/${h}.png`, uri: "u", label: "l" }] }), /^Validation Error: not a stored copy of file/);
      refuses(() => deletionPaths({ kind: "file", id: h, listings: [`/pub/social/v1/files/${h.slice(0, -1)}A.png`] }), /^Validation Error: not a stored copy of file/);
      refuses(() => deletionPaths({ kind: "file", id: h, listings: ["/pub/elsewhere/x.png"] }), /^Validation Error: not a stored copy of file/);
    });
  });

  describe("the lifecycle", () => {
    const privateMedia = () => buildFile(OTTO, { bytes: utf8("cover"), type: "image/png", root: "private" });

    it("a private reference in a media position that is no media is refused by name", () => {
      const cases = [
        [`pubky://${OTTO}/priv`, "is not media"],
        [`pubky://${OTTO}/priv/social/v1/feeds/x.json`, "is not media"],
        [`pubky://${OTTO}/priv/social/v1/files/x.png`, "is not a media object"],
      ];
      for (const [uri, reason] of cases) {
        const draft = buildPost(OTTO, { kind: "image", content: "c", root: "private", attachments: [{ uri }] });
        refuses(() => planPublish(OTTO, { id: draft.id, editId: draft.editId, post: draft.object }), `Validation Error: cannot publish: a private reference in a media position ${reason}: ${uri}`);
      }
    });

    it("an article's or a collection's private cover is copied and respelled public", () => {
      const media = privateMedia();
      const publicUrl = media.url.replace("/priv/", "/pub/");
      for (const input of [
        { kind: "article", title: "T", body: "B", cover_image: media.url, root: "private" },
        { kind: "collection", name: "C", cover_image: media.url, root: "private" },
      ]) {
        const draft = buildPost(OTTO, input);
        const plan = planPublish(OTTO, { id: draft.id, editId: draft.editId, post: draft.object });
        assert.deepStrictEqual(plan.copies, [{ from: media.path, to: media.path.replace("/priv/", "/pub/") }]);
        assert.strictEqual(specs.decodeContent(plan.put.object).content.cover_image, publicUrl);
        assert.ok(!new TextDecoder().decode(plan.put.body).includes("/priv/"));
      }
    });

    it("unpublishing copies back only the public versions newer than the private head", () => {
      const ids = [0, 1, 2, 3].map((ms) => (setClock(() => T0 + ms), buildPost(OTTO, { content: "x" }).id));
      const [id, mid, late, last] = ids;
      const pub = (e) => `/pub/social/v1/posts/${id}/${e}.json`;
      const priv = (e) => `/priv/social/v1/posts/${id}/${e}.json`;
      const plan = planUnpublish({ id, publicPaths: [pub(late), pub(id), pub(last), pub(mid)], privateHead: priv(mid) });
      assert.deepStrictEqual(plan.copies, [
        { from: pub(late), to: priv(late) },
        { from: pub(last), to: priv(last) },
      ]);
      assert.deepStrictEqual(plan.deletes, [pub(id), pub(mid), pub(late), pub(last)]);
      assert.deepStrictEqual(planUnpublish({ id, publicPaths: [pub(mid), pub(last)] }).copies, [{ from: pub(last), to: priv(last) }]);
    });

    it("refuses to publish an envelope whose unknown members hold a number past 2^53", () => {
      const media = privateMedia();
      const draft = buildPost(OTTO, { kind: "article", title: "T", body: "B", cover_image: media.url, root: "private" });
      const content = `${draft.object.content.slice(0, -1)},"x":1152921504606846976}`;
      refuses(
        () => planPublish(OTTO, { id: draft.id, editId: draft.editId, post: { ...draft.object, content } }),
        "Validation Error: cannot publish: integer 1152921504606846976 outside the JSON-safe range",
      );
    });

    it("a delete takes each version public before private", () => {
      const post = buildPost(OTTO, { content: "x" });
      const pub = `/pub/social/v1/posts/${post.id}/${post.id}.json`;
      const priv = `/priv/social/v1/posts/${post.id}/${post.id}.json`;
      assert.deepStrictEqual(
        planDelete(OTTO, {
          id: post.id,
          copies: [
            { root: "private", path: priv },
            { root: "public", path: pub },
          ],
        }).deletes,
        [pub, priv],
      );
      setClock(() => T0 + 1);
      const edit = specs.editPost(post.url, post.object).editId;
      const at = (root, e) => `/${root}/social/v1/posts/${post.id}/${e}.json`;
      const copies = [
        ["priv", edit],
        ["pub", edit],
        ["priv", post.id],
        ["pub", post.id],
      ].map(([r, e]) => ({ root: r === "pub" ? "public" : "private", path: at(r, e) }));
      assert.deepStrictEqual(planDelete(OTTO, { id: post.id, copies }).deletes, [at("pub", post.id), at("priv", post.id), at("pub", edit), at("priv", edit)]);
      assert.strictEqual(parseUri(`pubky://${OTTO}${pub}`).kind, "post");
      assert.strictEqual(buildUri(OTTO, "post", post.id), `pubky://${OTTO}/pub/social/v1/posts/${post.id}`);
      void buildTag;
    });
  });
});
