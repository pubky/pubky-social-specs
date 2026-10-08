// Properties that span calls: each one states what holds for every input the generators can
// make, not for a recorded case. A failure prints the seed and the shrunk counterexample.
//
//   FC_SEED=<n> FC_RUNS=<n> npx mocha property.test.js
// npm test runs a fixed seed; the nightly workflow runs a random one with more runs.

import assert from "assert";
import fc from "fast-check";
import {
  buildFeed,
  buildFile,
  buildFollow,
  buildMute,
  buildBookmark,
  buildPost,
  buildTag,
  buildUri,
  buildUser,
  decodeObject,
  deletionPaths,
  editPost,
  encodeObject,
  parseOwnerPath,
  parseUri,
  planDelete,
  planPublish,
  planUnpublish,
  ValidationError,
} from "./dist/index.js";
import { setClock } from "./dist/testing.js";
import { T0, text } from "./core.fixture.js";

const SEED = Number(process.env.FC_SEED ?? 20261008);
const RUNS = Number(process.env.FC_RUNS ?? 200);
fc.configureGlobal({ seed: SEED, numRuns: RUNS });

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ZBASE32 = "ybndrfg8ejkmcpqxot1uwisza345h769";

const chars = (alphabet, length) => fc.array(fc.constantFrom(...alphabet), { minLength: length, maxLength: length }).map((a) => a.join(""));
// The spare bits of the last character are zero in the one canonical spelling
const owner = fc.tuple(chars(ZBASE32, 51), fc.constantFrom("y", "o")).map(([a, b]) => a + b);
const timestampId = fc.tuple(chars(CROCKFORD, 12), fc.constantFrom(...CROCKFORD.split("").filter((_, i) => (i & 1) === 0))).map(([a, b]) => a + b);
const hashId = fc.tuple(chars(CROCKFORD, 25), fc.constantFrom(...CROCKFORD.split("").filter((_, i) => (i & 3) === 0))).map(([a, b]) => a + b);
const word = fc.string({ unit: "grapheme", minLength: 1, maxLength: 40 });
const web = fc.webUrl({ withQueryParameters: true, withFragments: true });

/** The value of `fn`, or null when the data model refuses it: a property is about accepted input. */
const accepted = (fn) => {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ValidationError) return null;
    throw e;
  }
};

const newUser = fc.record(
  {
    name: word,
    bio: fc.option(word),
    image: fc.option(web),
    links: fc.option(fc.array(fc.record({ title: word, url: web }), { maxLength: 4 })),
    status: fc.option(word),
  },
  { requiredKeys: ["name"] },
);
const threaded = { parent: fc.option(web), embed: fc.option(web), attachments: fc.option(fc.array(fc.record({ uri: web, alt: fc.option(word), name: fc.option(word) }), { maxLength: 3 })) };
const newPost = fc.oneof(
  fc.record({ kind: fc.constantFrom("note", "image", "video", "link", "file"), content: word, ...threaded, root: fc.constantFrom("public", "private") }, { requiredKeys: ["content"] }),
  fc.record({ kind: fc.constant("article"), title: word, body: fc.string({ maxLength: 200 }), cover_image: fc.option(web), ...threaded }, { requiredKeys: ["kind", "title", "body"] }),
  fc.record(
    { kind: fc.constant("collection"), name: word, description: fc.option(word), items: fc.option(fc.array(fc.record({ uri: web, note: fc.option(word) }), { maxLength: 4 })) },
    { requiredKeys: ["kind", "name"] },
  ),
);
const label = fc.stringMatching(/^[a-z0-9_-]{1,20}$/);
const newFeed = fc.record(
  {
    name: word,
    icon: fc.stringMatching(/^[a-z0-9-]{1,50}$/),
    reach: fc.constantFrom("following", "followers", "friends", "all", "wot", "me"),
    layout: fc.constantFrom("columns", "wide", "visual", "list"),
    sort: fc.constantFrom("recent", "popularity"),
    content: fc.option(fc.constantFrom("note", "article", "image")),
    tags: fc.option(fc.array(label, { minLength: 1, maxLength: 5 })),
  },
  { requiredKeys: ["name", "icon", "reach", "layout", "sort"] },
);
// Members a newer writer added, as the text a reader carries them in. No fractions: the
// reference reads a float the way serde_json does by default, which can land one unit in the
// last place away from the double its own writer spelled, so a float is not a fixed point of
// a write then a read, in the crate or here. The parity of that read is the scoreboard's.
const member = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: "small" },
    fc.constant(null),
    fc.boolean(),
    fc.integer(),
    fc.string({ maxLength: 10 }),
    fc.array(tie("value"), { maxLength: 3 }),
    fc.dictionary(fc.string({ maxLength: 5 }), tie("value"), { maxKeys: 3 }),
  ),
})).value;
const unknownMembers = fc.option(
  fc.dictionary(fc.stringMatching(/^x_[a-z]{1,8}$/), member, { maxKeys: 3 }).map((members) => JSON.stringify(members)),
  { nil: undefined },
);

describe("properties", function () {
  this.timeout(120_000);
  beforeEach(() => setClock(() => T0));
  after(() => setClock());

  describe("encode then decode", () => {
    const roundTrip = (built) => {
      const read = decodeObject(built.url, built.body);
      assert.deepStrictEqual(read.object, built.object);
      assert.strictEqual(text(encodeObject(built.url, read.object)), text(built.body));
    };

    it("every built object decodes at its url to itself and encodes back to its bytes", () => {
      fc.assert(
        fc.property(owner, newUser, (o, input) => {
          const built = accepted(() => buildUser(o, input));
          if (built) roundTrip(built);
        }),
      );
      fc.assert(
        fc.property(owner, newPost, (o, input) => {
          const built = accepted(() => buildPost(o, input));
          if (built) roundTrip(built);
        }),
      );
      fc.assert(
        fc.property(owner, newFeed, (o, input) => {
          const built = accepted(() => buildFeed(o, input));
          if (built) roundTrip(built);
        }),
      );
      fc.assert(
        fc.property(owner, owner, web, label, (o, other, uri, l) => {
          for (const built of [buildFollow(o, other), buildMute(o, other), accepted(() => buildTag(o, uri, l)), accepted(() => buildBookmark(o, uri))]) if (built) roundTrip(built);
        }),
      );
    });

    it("an object read with unknown members is a fixed point of encode then decode", () => {
      fc.assert(
        fc.property(owner, newPost, unknownMembers, (o, input, $unknown) => {
          const built = accepted(() => buildPost(o, input));
          if (!built) return;
          const object = $unknown === undefined ? built.object : { ...built.object, $unknown };
          const bytes = accepted(() => encodeObject(built.url, object));
          if (!bytes) return;
          const once = decodeObject(built.url, bytes, "post");
          const again = encodeObject(built.url, once);
          assert.strictEqual(text(again), text(bytes));
          assert.deepStrictEqual(decodeObject(built.url, again, "post"), once);
        }),
      );
    });

    it("media decodes to its own bytes at the url its hash names", () => {
      fc.assert(
        fc.property(owner, fc.uint8Array({ minLength: 1, maxLength: 512 }), fc.constantFrom("image/png", "image/jpeg", "video/mp4", "text/plain", ""), (o, bytes, type) => {
          const file = buildFile(o, { bytes, type });
          assert.deepStrictEqual(decodeObject(file.url, bytes, "file"), bytes);
          assert.strictEqual(parseUri(file.url).id, file.id);
        }),
      );
    });
  });

  describe("buildUri and parseUri", () => {
    const named = fc.oneof(
      fc.tuple(fc.constant("post"), timestampId),
      fc.tuple(fc.constantFrom("follow", "mute"), owner),
      fc.tuple(fc.constantFrom("tag", "feed"), hashId),
      fc.tuple(
        fc.constant("file"),
        fc.tuple(hashId, fc.constantFrom("png", "jpg", "mp4", "bin")).map(([h, e]) => `${h}.${e}`),
      ),
      fc.tuple(
        fc.constant("bookmark"),
        fc.oneof(
          hashId.map((h) => `~${h}`),
          web.map((u) => Buffer.from(u).toString("base64url")),
        ),
      ),
    );

    it("parseUri gives back the kind and the id buildUri was given", () => {
      fc.assert(
        fc.property(owner, named, (o, [kind, id]) => {
          const uri = buildUri(o, kind, id);
          const parsed = parseUri(uri);
          assert.strictEqual(parsed.kind, kind);
          assert.strictEqual(parsed.owner, o);
          assert.strictEqual(kind === "file" ? parsed.filename : parsed.id, id);
          if (kind === "post") assert.strictEqual(parsed.editId, undefined);
        }),
      );
      fc.assert(fc.property(owner, (o) => assert.strictEqual(parseUri(buildUri(o, "user")).kind, "user")));
    });

    it("buildUri spells only what parseUri reads back as that object: any other id throws", () => {
      const kinds = fc.constantFrom("post", "follow", "mute", "tag", "feed", "file", "bookmark");
      const anyId = fc.oneof(
        fc.string({ maxLength: 60 }),
        fc.string({ unit: "binary", maxLength: 30 }),
        named.map(([, id]) => id),
        fc.constantFrom("..", ".", "", "a/b", "x%2e", " id"),
      );
      fc.assert(
        fc.property(owner, kinds, anyId, (o, kind, id) => {
          const uri = accepted(() => buildUri(o, kind, id));
          if (uri === null) return;
          const parsed = parseUri(uri);
          assert.strictEqual(parsed.kind, kind);
          assert.strictEqual(kind === "file" ? parsed.filename : parsed.id, id);
        }),
      );
    });

    it("every URI parseUri names as an object is the one buildUri spells for it", () => {
      const tail = fc.oneof(
        timestampId.map((id) => `pub/social/v1/posts/${id}`),
        owner.map((k) => `pub/social/v1/follows/${k}.json`),
        owner.map((k) => `priv/social/v1/mutes/${k}.json`),
        hashId.map((h) => `pub/social/v1/tags/${h}.json`),
        hashId.map((h) => `priv/social/v1/feeds/${h}.json`),
        hashId.map((h) => `pub/social/v1/files/${h}.png`),
        fc.constant("pub/social/v1/profile.json"),
        fc.string({ maxLength: 40 }),
      );
      fc.assert(
        fc.property(owner, tail, (o, path) => {
          const parsed = accepted(() => parseUri(`pubky://${o}/${path}`));
          if (parsed === null || ["foreign", "unknown", "unsupportedVersion"].includes(parsed.kind) || (parsed.root === "public" && parsed.kind === "feed")) return;
          if (parsed.kind === "post" && parsed.editId !== undefined) return;
          const id = parsed.kind === "file" ? parsed.filename : parsed.id;
          assert.strictEqual(parsed.kind === "user" ? buildUri(o, "user") : buildUri(o, parsed.kind, id), `pubky://${o}/${path}`);
        }),
      );
    });
  });

  describe("ids", () => {
    // A step back of up to a second is a burst the guard runs ahead of; a larger one is a
    // corrected clock the reference follows, which is outside this property
    const steps = fc.array(fc.oneof(fc.integer({ min: 0, max: 5_000 }), fc.integer({ min: -1_000, max: 0 }), fc.constant(0)), { minLength: 2, maxLength: 60 });

    it("minting is strictly increasing under any clock within the window", () => {
      fc.assert(
        fc.property(owner, steps, (o, deltas) => {
          let now = T0;
          let latest = T0;
          setClock(() => now);
          const ids = [];
          for (const delta of deltas) {
            // Never more than the tolerance behind the latest reading, less the burst's lead
            now = Math.max(now + delta, latest - 999);
            latest = Math.max(latest, now);
            ids.push(buildPost(o, { content: "x" }).id);
          }
          for (let k = 1; k < ids.length; k++) assert.ok(ids[k - 1] < ids[k], `${ids[k - 1]} then ${ids[k]}`);
        }),
      );
    });

    it("a chain of edits is strictly increasing under any clock", () => {
      fc.assert(
        fc.property(owner, steps, (o, deltas) => {
          let now = T0;
          setClock(() => now);
          let head = buildPost(o, { content: "x" });
          for (const [k, delta] of deltas.entries()) {
            now = Math.max(T0 - 3_600_000, now + delta);
            const edit = accepted(() => editPost(head.url, { ...head.object, content: `v${k}` }));
            if (!edit) return;
            assert.ok(edit.editId > head.editId && edit.id === head.id, `${head.editId} then ${edit.editId}`);
            head = edit;
          }
        }),
      );
    });

    it("an edit is above its head whatever the clock says", () => {
      fc.assert(
        fc.property(owner, fc.integer({ min: -7_000_000, max: 7_000_000 }), (o, skew) => {
          const head = buildPost(o, { content: "x" });
          setClock(() => T0 + skew);
          const edit = accepted(() => editPost(head.url, { ...head.object, content: "y" }));
          if (edit) assert.ok(edit.editId > head.editId && edit.id === head.id);
        }),
      );
    });
  });

  describe("plans", () => {
    const once = (paths) => assert.strictEqual(new Set(paths).size, paths.length, `a path twice in ${paths.join(", ")}`);
    const versions = fc.uniqueArray(timestampId, { minLength: 1, maxLength: 6 });

    it("every path of a plan appears once and is a path of the owner's tree", () => {
      fc.assert(
        fc.property(owner, versions, fc.boolean(), (o, editIds, withHead) => {
          const id = [...editIds].sort()[0];
          const publicPaths = editIds.map((e) => `/pub/social/v1/posts/${id}/${e}.json`);
          const privateHead = withHead ? `/priv/social/v1/posts/${id}/${id}.json` : null;
          const legacyPaths = [`/pub/pubky.app/posts/${id}`];
          const unpublish = planUnpublish({ id, publicPaths, privateHead, legacyPaths });
          once(unpublish.deletes);
          once(unpublish.copies.map((c) => c.to));
          const copies = [...publicPaths.map((path) => ({ root: "public", path })), ...publicPaths.map((path) => ({ root: "private", path: path.replace("/pub/", "/priv/") }))];
          const del = planDelete(o, { id, legacyPaths, copies });
          once(del.deletes);
          assert.strictEqual(del.deletes.length, copies.length + 1);
          const listed = deletionPaths({ kind: "post", id, listings: [...copies.map((c) => c.path), ...legacyPaths] });
          once(listed);
          for (const path of [...unpublish.deletes, ...del.deletes, ...listed, ...unpublish.copies.flatMap((c) => [c.from, c.to])]) parseOwnerPath(path);
        }),
      );
    });

    it("a publish copies each private media once, and every copy lands in the public tree", () => {
      fc.assert(
        fc.property(owner, fc.array(fc.uint8Array({ minLength: 1, maxLength: 16 }), { minLength: 1, maxLength: 4 }), (o, blobs) => {
          const media = blobs.map((bytes) => buildFile(o, { bytes, type: "image/png", root: "private" }));
          const draft = buildPost(o, { kind: "image", content: "c", root: "private", attachments: [...media, ...media].map((m) => ({ uri: m.url })) });
          const plan = planPublish(o, { id: draft.id, editId: draft.editId, post: draft.object });
          once(plan.copies.map((c) => c.from));
          once(plan.copies.map((c) => c.to));
          assert.strictEqual(plan.copies.length, new Set(media.map((m) => m.id)).size);
          for (const copy of plan.copies) assert.ok(copy.from.startsWith("/priv/") && copy.to === copy.from.replace("/priv/", "/pub/"));
          for (const a of plan.put.object.attachments) assert.ok(a.uri.startsWith(`pubky://${o}/pub/`));
        }),
      );
    });

    it("publish then unpublish brings the version back to the private tree, as the public one reads", () => {
      fc.assert(
        fc.property(owner, newPost, fc.option(fc.stringMatching(/^[a-z0-9-]{1,20}$/), { nil: undefined }), (o, input, slug) => {
          const draft = accepted(() => buildPost(o, { ...input, root: "private", ...(slug === undefined || input.kind === "collection" ? {} : { slug }) }));
          if (!draft) return;
          const published = accepted(() => planPublish(o, { id: draft.id, editId: draft.editId, post: draft.object }));
          if (!published) return;
          const { put } = published;
          const back = planUnpublish({ id: draft.id, publicPaths: [put.path], privateHead: null });
          assert.deepStrictEqual(back.deletes, [put.path]);
          assert.deepStrictEqual(back.copies, [{ from: put.path, to: `/priv/social/v1/posts/${draft.id}/${draft.editId}.json` }]);
          // The bytes copied back are a valid version where they land
          const at = `pubky://${o}${back.copies[0].to}`;
          assert.deepStrictEqual(decodeObject(at, put.body, "post"), put.object);
          // A draft never published has nothing to bring back but its head
          assert.deepStrictEqual(planUnpublish({ id: draft.id, publicPaths: [], privateHead: draft.path.replace(/-[a-z0-9-]+\.json$/, ".json") }), { copies: [], deletes: [] });
        }),
      );
    });
  });
});
