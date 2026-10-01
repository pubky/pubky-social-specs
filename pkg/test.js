import * as specs from "./index.js";
import { createRequire } from "node:module";
import assert from "assert";
import vm from "node:vm";

const {
  init,
  validationLimits,
  parseUri,
  stableId,
  resolveDeref,
  readObject,
  validate,
  createUser,
  createPost,
  createArticlePost,
  createCollectionPost,
  createVersion,
  editVersion,
  planPublish,
  planUnpublish,
  planDelete,
  createFeed,
  feedPaths,
  feedLifecycle,
  createTag,
  createBookmark,
  bookmarkFilename,
  bookmarkTarget,
  createFollow,
  createMute,
  createFile,
  Hasher,
  hasherNew,
  hasherUpdate,
  hasherFinish,
  mimeToExt,
  essence,
  mimeToExtTable,
  validMimeTypes,
  feedId,
  legacyListPrefix,
  skipReasons,
  transformRev,
  Migration,
  createMigration,
  migrate,
  migrateBlob,
  deletionPaths,
  listPrefix,
  userUriBuilder,
  postUriBuilder,
  followUriBuilder,
  muteUriBuilder,
  bookmarkUriBuilder,
  tagUriBuilder,
  fileUriBuilder,
  feedUriBuilder,
} = specs;

const require = createRequire(import.meta.url);
const { validationLimits: subpathLimits } = require("./validationLimits.cjs");
const mimeSubpath = require("./mimeTypes.cjs");
const validationLimitsJson = require("./validationLimits.json");

const OTTO = "8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto";
const RIO = "dzswkfy7ek3bqnoc89jxuqqfbzhjrj6mi8qthgbxxcqkdugm3rio";
const MALFORMED = "Validation Error: text must be well-formed UTF-16";

// Every rejection is an Error carrying the crate's message
function rejects(fn, check) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof Error, `expected an Error, got ${typeof err}: ${err}`);
    if (typeof check === "string") {
      assert.strictEqual(err.message, check);
    } else if (check instanceof RegExp) {
      assert.match(err.message, check);
    }
    return true;
  });
}

// What a homeserver GET returns for a built object
function stored(object) {
  return new TextEncoder().encode(JSON.stringify(object));
}

describe("before init()", () => {
  it("nothing runs at import: every function throws until init() resolves", () => {
    rejects(() => parseUri(`pubky://${OTTO}`), /await init\(\) before calling parseUri\(\)/);
    rejects(() => createUser(OTTO, { name: "Alice" }), /before calling createUser\(\)/);
    rejects(() => userUriBuilder(OTTO), /before calling userUriBuilder\(\)/);
  });

  it("validationLimits and the MIME tables are data, readable without the wasm", () => {
    assert.deepStrictEqual(validationLimits, validationLimitsJson);
    assert.strictEqual(mimeToExtTable["image/png"], "png");
    assert.ok(validMimeTypes.includes("image/png"));
  });

  it("skipReasons and transformRev are frozen data, the entry, the subpath and the JSON agreeing", () => {
    assert.ok(Object.isFrozen(skipReasons));
    const json = require("./migrationData.json");
    assert.deepStrictEqual([...skipReasons], json.skipReasons);
    assert.deepStrictEqual([...require("./migrationData.cjs").skipReasons], [...skipReasons]);
    assert.ok(Number.isSafeInteger(transformRev) && transformRev >= 1);
    assert.strictEqual(transformRev, json.transformRev);
    assert.strictEqual(require("./migrationData.cjs").transformRev, transformRev);
    for (const reason of ["malformed", "shape", "oversize", "invalid", "not_migrated"]) {
      assert.ok(skipReasons.includes(reason), reason);
    }
  });
});

describe("pubky-social-specs", () => {
  before(async () => {
    await init();
  });

  describe("init()", () => {
    it("is idempotent", async () => {
      const first = init();
      assert.strictEqual(init(), first, "a second call returns the same load");
      await first;
      assert.strictEqual(parseUri(userUriBuilder(OTTO)).resource.kind, "user");
    });

    it("the CommonJS entry exports the same surface, loaded by its own init()", async () => {
      const cjs = require("./index.cjs");
      assert.deepStrictEqual(Object.keys(cjs).sort(), Object.keys(specs).sort());
      rejects(() => cjs.userUriBuilder(OTTO), /await init\(\)/);
      await cjs.init();
      assert.strictEqual(cjs.userUriBuilder(OTTO), userUriBuilder(OTTO));
    });
  });

  describe("UTF-16 well-formedness at the entry", () => {
    const profile = `pubky://${OTTO}/pub/social/v1/profile.json`;

    it("rejects a lone surrogate in a string argument", () => {
      rejects(() => createTag(OTTO, profile, "\uD800"), MALFORMED);
      rejects(() => parseUri(`${profile}\uDC00`), MALFORMED);
    });

    it("an object carrying one is refused by the JSON parser, member names included", () => {
      // The exact text is the parser's; that it is refused is the contract
      rejects(() => createUser(OTTO, { name: "Al\uDC00ice" }), /^Validation Error: /);
      rejects(() => createUser(OTTO, { name: "Alice", links: [{ title: "\uD83D", url: "https://a.dev" }] }), /^Validation Error: /);
      rejects(() => validate(profile, { name: "Alice", "\uD83D": 1 }), /^Validation Error: /);
      rejects(() => planUnpublish("0032SSN7Q4EVG", ["\uD800"], []), MALFORMED);
    });

    it("accepts surrogate pairs", () => {
      const { object } = createUser(OTTO, { name: "🔥".repeat(50) });
      assert.strictEqual(object.name, "🔥".repeat(50));
    });

    it("the fallback loop agrees where String.prototype.isWellFormed is missing", () => {
      const original = Object.getOwnPropertyDescriptor(String.prototype, "isWellFormed");
      delete String.prototype.isWellFormed;
      try {
        for (const bad of ["a\uD800", "\uDC00b", "\uDC00\uD800", "\uD800\uD800"]) {
          rejects(() => createTag(OTTO, profile, bad), MALFORMED);
        }
        assert.strictEqual(createTag(OTTO, profile, "x🔥").object.label, "x🔥");
      } finally {
        if (original) Object.defineProperty(String.prototype, "isWellFormed", original);
      }
    });
  });

  describe("User", () => {
    it("creates a profile with meta naming the owner", () => {
      const { object, meta } = createUser(OTTO, {
        name: "Alice Smith",
        bio: "Software Developer",
        status: "active",
      });
      assert.strictEqual(meta.id, "", "the profile has no id");
      assert.strictEqual(meta.path, "/pub/social/v1/profile.json");
      assert.strictEqual(meta.url, userUriBuilder(OTTO));
      assert.strictEqual(Object.getPrototypeOf(object), Object.prototype, "a plain object, not a Map");
      assert.strictEqual(object.name, "Alice Smith");
      assert.strictEqual(object.bio, "Software Developer");
      assert.strictEqual(object.status, "active");
    });

    it("rejects a name too short", () => {
      rejects(() => createUser(OTTO, { name: "AB" }), /Invalid name length/);
    });

    it("rejects an input member it does not know, so a typo is never dropped silently", () => {
      rejects(() => createUser(OTTO, { name: "Alice", bios: "x" }), /^Validation Error: unknown field `bios`/);
    });

    it("rejects an owner that is not a pubky", () => {
      rejects(() => createUser("nope", { name: "Alice" }), /52 ASCII characters/);
    });

    it("stores image and link urls as written", () => {
      const image = `pubky://${OTTO}/pub/social/v1/files/0032SSN7Q4EVG`;
      const { object } = createUser(OTTO, {
        name: "Alice Smith",
        image,
        links: [{ title: "site", url: "https://example.com/a" }],
      });
      assert.strictEqual(object.image, image);
      assert.strictEqual(object.links[0].url, "https://example.com/a");
    });

    it("trims name, bio, status and link titles in the builder", () => {
      const { object } = createUser(OTTO, {
        name: "  Alice Smith  ",
        bio: "  Software Developer  ",
        links: [{ title: "  site  ", url: "https://example.com/a" }],
        status: "  active  ",
      });
      assert.strictEqual(object.name, "Alice Smith");
      assert.strictEqual(object.bio, "Software Developer");
      assert.strictEqual(object.status, "active");
      assert.strictEqual(object.links[0].title, "site");
    });

    it("drops a blank bio or status instead of storing an empty one", () => {
      const { object } = createUser(OTTO, { name: "Alice Smith", bio: "   ", status: "  " });
      assert.strictEqual(object.bio, null);
      assert.strictEqual(object.status, null);
    });

    it("reads a stored profile back as written", () => {
      const bytes = {
        name: "  Alice Smith  ",
        bio: "  Software Developer  ",
        links: [{ title: "  site  ", url: "https://example.com/a" }],
        status: "  active  ",
      };
      const { kind, object } = readObject(userUriBuilder(OTTO), stored(bytes));
      assert.strictEqual(kind, "user");
      assert.strictEqual(object.name, bytes.name, "padding is kept");
      assert.strictEqual(object.bio, bytes.bio);
      assert.strictEqual(object.status, bytes.status);
      assert.strictEqual(object.links[0].title, bytes.links[0].title);
    });

    it("rejects a padded image", () => {
      rejects(
        () => createUser(OTTO, { name: "Alice Smith", image: " https://x.com/a.png " }),
        "Validation Error: image must be a canonical pubky or web URI of at most 300 code points:  https://x.com/a.png ",
      );
    });

    it("rejects the short form image URI", () => {
      const short = `pubky${OTTO}/pub/social/v1/files/0032SSN7Q4EVG`;
      rejects(
        () => createUser(OTTO, { name: "Alice Smith", image: short }),
        `Validation Error: image must be spelled in canonical form: ${short}`,
      );
    });

    it("rejects an ipfs image", () => {
      rejects(
        () => createUser(OTTO, { name: "Alice Smith", image: "ipfs://x" }),
        "Validation Error: image must be a canonical pubky or web URI of at most 300 code points: ipfs://x",
      );
    });

    it("rejects a pubky link url", () => {
      const url = `pubky://${OTTO}/pub/social/v1/profile.json`;
      rejects(
        () => createUser(OTTO, { name: "Alice Smith", links: [{ title: "profile", url }] }),
        `Validation Error: links[0].url must be a canonical web URI of at most 300 code points: ${url}`,
      );
    });
  });

  describe("Post", () => {
    it("creates a note at posts/{id}/{id}.json", () => {
      const content = "Hello, Pubky world! This is my first post.";
      const { object, meta } = createPost(OTTO, { content });
      const chunks = meta.url.split("/");
      assert.strictEqual(chunks[2], OTTO);
      assert.strictEqual(chunks[6], "posts");
      assert.strictEqual(chunks[7], meta.id);
      assert.strictEqual(meta.path, `/pub/social/v1/posts/${meta.id}/${meta.id}.json`);
      assert.strictEqual(object.content, content);
      assert.strictEqual(object.kind, "note", "the kind defaults to note");
      assert.deepStrictEqual(object.attachments, [], "always an array on the wire");
    });

    it("carries a parent", () => {
      const parent = `pubky://${RIO}/pub/social/v1/posts/0033SSE3B1FQ0`;
      assert.strictEqual(postUriBuilder(RIO, "0033SSE3B1FQ0"), parent);
      const { object } = createPost(OTTO, { content: "A reply", parent });
      assert.strictEqual(object.parent, parent);
    });

    it("carries an embed", () => {
      const embed = `pubky://${RIO}/pub/social/v1/posts/0033SREKPC4N0`;
      assert.strictEqual(postUriBuilder(RIO, "0033SREKPC4N0"), embed);
      const { object } = createPost(OTTO, { content: "A repost", embed });
      assert.strictEqual(object.embed, embed);
    });

    it("trims content in the builder and reads a stored post back as written", () => {
      const { object, meta } = createPost(OTTO, { content: "  hello  " });
      assert.strictEqual(object.content, "hello", "content is trimmed");
      const stored = { content: "  hello  ", kind: "note", parent: null, embed: null, attachments: [] };
      assert.strictEqual(readObject(meta.url, new TextEncoder().encode(JSON.stringify(stored))).object.content, "  hello  ", "padding is kept on read");
    });

    it("carries attachment objects, the builder trimming the name", () => {
      const uri = `pubky://${OTTO}/pub/social/v1/files/0034A0X7NJ52G`;
      const { object } = createPost(OTTO, {
        content: "",
        kind: "image",
        attachments: [{ uri, alt: "a cat", name: "  cat.jpg  " }],
      });
      assert.deepStrictEqual(object.attachments, [{ uri, alt: "a cat", name: "cat.jpg" }]);
    });

    it("rejects an unknown kind by name", () => {
      rejects(() => createPost(OTTO, { content: "x", kind: "short" }), "Validation Error: Invalid content kind: short");
    });

    it("rejects too many attachments", () => {
      const attachments = Array.from({ length: validationLimits.postAttachmentsMaxCount + 1 }, () => ({
        uri: `pubky://${OTTO}/pub/social/v1/files/0034A0X7NJ52G`,
      }));
      rejects(() => createPost(OTTO, { content: "x", kind: "image", attachments }), /Too many attachments/);
    });

    describe("lock", () => {
      const lock = `pubky://${RIO}/pub/locks/0034A0X7NJ52G`;

      it("stores a pubky lock URL", () => {
        const { object } = createPost(OTTO, { content: "Visible preview for locked content", lock });
        assert.strictEqual(object.lock, lock);
      });

      it("leaves the lock out of an unlocked post", () => {
        const { object } = createPost(OTTO, { content: "Hello" });
        assert.ok(!("lock" in object), "absent, not null");
      });

      it("reads a stored post without lock or attachments as unlocked and empty", () => {
        const { meta } = createPost(OTTO, { content: "x" });
        const { object } = readObject(meta.url, stored({ content: "Hello World!", kind: "note", parent: null, embed: null }));
        assert.strictEqual(object.lock, undefined);
        assert.deepStrictEqual(object.attachments, []);
      });

      it("rejects a web or hostless lock URL", () => {
        for (const bad of ["https://locks.example.com/session/0034A0X7NJ52G", "pubky:lock-id"]) {
          rejects(() => createPost(OTTO, { content: "Preview", lock: bad }), /lock/);
        }
      });
    });

    describe("article", () => {
      it("writes the envelope into content and trims the title", () => {
        const cover = `pubky://${RIO}/pub/social/v1/files/0034A0X7NJ52G`;
        const { object, meta } = createArticlePost(OTTO, {
          title: "  On Pubky  ",
          body: "# Hello\n\nbody",
          coverImage: cover,
        });
        assert.ok(meta.id);
        assert.strictEqual(object.kind, "article");
        assert.deepStrictEqual(object.attachments, []);
        const envelope = JSON.parse(object.content);
        assert.strictEqual(envelope.title, "On Pubky");
        assert.strictEqual(envelope.body, "# Hello\n\nbody");
        assert.strictEqual(envelope.cover_image, cover);
      });

      it("takes parent, embed, attachments and lock", () => {
        const parent = `pubky://${RIO}/pub/social/v1/posts/0033SSE3B1FQ0`;
        const { object } = createArticlePost(OTTO, {
          title: "Reply article",
          body: "body",
          parent,
          embed: "https://example.com/source",
          attachments: [{ uri: `pubky://${RIO}/pub/social/v1/files/0034A0X7NJ52G`, alt: "alt", name: "a.jpg" }],
          lock: `pubky://${RIO}/pub/app.locks/0034A0X7NJ52G.json`,
        });
        assert.strictEqual(object.parent, parent);
        assert.strictEqual(object.embed, "https://example.com/source");
        assert.strictEqual(object.attachments.length, 1);
        assert.ok(object.lock);
      });

      it("rejects a blank title", () => {
        rejects(() => createArticlePost(OTTO, { title: "   ", body: "body" }), /title/);
      });
    });

    describe("collection", () => {
      const item = `pubky://${RIO}/pub/social/v1/posts/0033SREKPC4N0`;
      const cover = `pubky://${RIO}/pub/social/v1/files/0034A0X7NJ52G`;

      it("writes the envelope into content, items as {uri, note?}", () => {
        const { object, meta } = createCollectionPost(OTTO, {
          name: "Favorite posts",
          description: "Posts worth revisiting",
          items: [{ uri: item, note: "worth it" }],
          coverImage: cover,
          layout: "list",
        });
        assert.strictEqual(meta.path, `/pub/social/v1/posts/${meta.id}/${meta.id}.json`);
        assert.strictEqual(object.kind, "collection");
        assert.deepStrictEqual(object.attachments, [], "items never land in attachments");
        const envelope = JSON.parse(object.content);
        assert.strictEqual(envelope.name, "Favorite posts");
        assert.strictEqual(envelope.description, "Posts worth revisiting");
        assert.deepStrictEqual(envelope.items, [{ uri: item, note: "worth it" }]);
        assert.strictEqual(envelope.cover_image, cover);
        assert.strictEqual(envelope.layout, "list");
      });

      it("trims name, description and item notes in the builder", () => {
        const { object } = createCollectionPost(OTTO, {
          name: "  Favorite posts  ",
          description: "  the good ones  ",
          items: [{ uri: item, note: "  worth it  " }],
        });
        const envelope = JSON.parse(object.content);
        assert.strictEqual(envelope.name, "Favorite posts");
        assert.strictEqual(envelope.description, "the good ones");
        assert.strictEqual(envelope.items[0].note, "worth it");
      });

      it("drops a blank description or item note instead of storing an empty one", () => {
        const { object } = createCollectionPost(OTTO, {
          name: "Favorite posts",
          description: "   ",
          items: [{ uri: item, note: "   " }],
        });
        const envelope = JSON.parse(object.content);
        assert.ok(!("description" in envelope), `blank description is absent, got: ${object.content}`);
        assert.deepStrictEqual(envelope.items, [{ uri: item }]);
      });

      it("rejects too many items", () => {
        const items = Array.from({ length: validationLimits.collectionItemsMaxCount + 1 }, (_, i) => ({
          uri: `pubky://${RIO}/pub/social/v1/posts/${String(i).padStart(13, "0")}`,
        }));
        rejects(
          () => createCollectionPost(OTTO, { name: "Too many", items }),
          new RegExp(`${validationLimits.collectionItemsMaxCount} items`),
        );
      });
    });
  });

  describe("versions and the lifecycle planners", () => {
    it("drafts privately, publishes, edits, unpublishes and deletes", () => {
      const media = createFile(OTTO, new Uint8Array([1, 2]), "image/png", "private");
      assert.strictEqual(media.meta.path, "/priv/social/v1/files/PZBQ010FF079VVZPQG1RNFN6DR.png");
      const draft = {
        content: "draft",
        kind: "image",
        parent: null,
        embed: null,
        attachments: [{ uri: media.meta.url }],
      };
      // A private reference is refused under the public root, and builds as a private draft
      rejects(() => createPost(OTTO, draft), /private/);
      const built = createPost(OTTO, { ...draft, root: "private" });
      assert.strictEqual(built.meta.path, `/priv/social/v1/posts/${built.meta.id}/${built.meta.id}.json`);
      assert.strictEqual(built.object.attachments[0].uri, media.meta.url);

      const version = createVersion(OTTO, draft, { root: "private", slug: "my-draft" });
      assert.strictEqual(version.editId, version.id, "creation writes editId == id");
      assert.strictEqual(version.path, `/priv/social/v1/posts/${version.id}/${version.id}-my-draft.json`);
      assert.strictEqual(version.url, `pubky://${OTTO}${version.path}`);
      rejects(() => createVersion(OTTO, draft, { root: "private", slug: "Bad Slug" }), /slug/);
      // The public root when no root is given
      rejects(() => createVersion(OTTO, draft), /private/);

      const publish = planPublish(OTTO, version.id, version.editId, draft);
      assert.deepStrictEqual(publish.mediaCopies, [[media.meta.path, "/pub/social/v1/files/PZBQ010FF079VVZPQG1RNFN6DR.png"]]);
      assert.strictEqual(publish.destPath, `/pub/social/v1/posts/${version.id}/${version.id}.json`, "the public leaf has no slug");
      const published = publish.rewrittenPost;
      assert.strictEqual(published.attachments[0].uri, fileUriBuilder(OTTO, "PZBQ010FF079VVZPQG1RNFN6DR.png"));
      assert.strictEqual(published.content, "draft");

      const edit = editVersion(OTTO, draft, { id: version.id, head: version.editId, root: "private" });
      assert.strictEqual(edit.id, version.id);
      assert.ok(edit.editId > version.editId, "an edit sorts above the head");

      const unpublish = planUnpublish(version.id, [publish.destPath], [], edit.path);
      assert.deepStrictEqual(unpublish.copyBacks, [], "nothing public is newer than the private head");
      assert.deepStrictEqual(unpublish.deletes, [publish.destPath]);

      const copies = [
        { root: "private", path: edit.path },
        { root: "private", path: version.path },
        { root: "public", path: publish.destPath },
      ];
      const plan = planDelete(OTTO, version.id, [], copies, [draft]);
      assert.deepStrictEqual(plan.deletes, [publish.destPath, version.path, edit.path], "oldest first, pub before priv");
      assert.deepStrictEqual(plan.mediaGcCandidates, [
        "/priv/social/v1/files/PZBQ010FF079VVZPQG1RNFN6DR.png",
      ]);
      const listings = copies.map((c) => c.path);
      assert.deepStrictEqual(deletionPaths({ kind: "post", id: version.id, listings }), plan.deletes);
    });

    it("refuses a head older than the post", () => {
      const { object, meta } = createPost(OTTO, { content: "x" });
      rejects(
        () => editVersion(OTTO, object, { id: meta.id, head: "0032SSN7Q4EVG" }),
        /older than the post id/,
      );
    });
  });

  describe("readObject and validate", () => {
    it("round-trips every kind a builder writes, tagged by kind", () => {
      const built = [
        ["user", createUser(OTTO, { name: "Alice" })],
        ["post", createPost(OTTO, { content: "x" })],
        ["tag", createTag(OTTO, userUriBuilder(RIO), "friend")],
        ["follow", createFollow(OTTO, RIO)],
        ["mute", createMute(OTTO, RIO)],
        ["bookmark", createBookmark(OTTO, userUriBuilder(RIO))],
        ["feed", createFeed(OTTO, { reach: "all", layout: "columns", sort: "recent", name: "All", icon: "globe" })],
      ];
      for (const [kind, { object, meta }] of built) {
        const read = readObject(meta.url, stored(object));
        assert.strictEqual(read.kind, kind);
        assert.deepStrictEqual(read.object, JSON.parse(JSON.stringify(object)), kind);
        validate(meta.url, read.object);
      }
    });

    it("reads media back as {bytes}", () => {
      const { object, meta } = createFile(OTTO, new Uint8Array([1, 2]), "image/png");
      const read = readObject(meta.url, object.bytes);
      assert.strictEqual(read.kind, "file");
      assert.deepStrictEqual(Array.from(read.object.bytes), [1, 2]);
      validate(meta.url, read.object);
      rejects(() => validate(meta.url, { bytes: new Uint8Array([3]) }), /^Validation Error: Invalid ID/);
      rejects(() => validate(meta.url, { data: object.bytes }), /bytes: Uint8Array/);
    });

    it("keeps unknown members through read, edit, validate", () => {
      const url = userUriBuilder(OTTO);
      const { object } = readObject(url, stored({ name: "Alice", ext: { badge: { level: 1 } }, later: [1, 2] }));
      assert.deepStrictEqual(object.ext, { badge: { level: 1 } });
      assert.deepStrictEqual(object.later, [1, 2]);
      object.status = "editing";
      validate(url, object);
      object.name = "AB";
      rejects(() => validate(url, object), /Invalid name length/);
    });

    it("checks the id the URI names", () => {
      const a = createTag(OTTO, userUriBuilder(RIO), "a");
      const b = createTag(OTTO, userUriBuilder(RIO), "b");
      rejects(() => validate(b.meta.url, a.object), /^Validation Error: Invalid ID/);
      rejects(() => readObject(b.meta.url, stored(a.object)), /^Validation Error: Invalid ID/);
    });

    it("refuses what is no stored object", () => {
      rejects(() => readObject(postUriBuilder(OTTO, "0032SSN7Q4EVG"), stored({})), /versionless/);
      rejects(() => readObject("nope", stored({})), /^Validation Error: Not a canonical pubky URI/);
    });
  });

  describe("what crosses the boundary", () => {
    it("a stored __proto__ member stays an own member at every depth", () => {
      const url = userUriBuilder(OTTO);
      const json = '{"name":"Alice","__proto__":{"lock":"x"},"ext":{"__proto__":{"polluted":true}}}';
      const { object } = readObject(url, new TextEncoder().encode(json));
      assert.strictEqual(Object.getPrototypeOf(object), Object.prototype);
      assert.strictEqual(Object.getPrototypeOf(object.ext), Object.prototype);
      assert.ok(Object.hasOwn(object, "__proto__"));
      assert.ok(Object.hasOwn(object.ext, "__proto__"));
      assert.strictEqual(object.lock, undefined, "nothing is inherited from stored data");
      assert.strictEqual(object.ext.polluted, undefined);
      validate(url, object);
      const again = JSON.parse(JSON.stringify(object));
      assert.deepStrictEqual(Object.getOwnPropertyDescriptor(again, "__proto__").value, { lock: "x" });
      assert.deepStrictEqual(Object.getOwnPropertyDescriptor(again.ext, "__proto__").value, { polluted: true });
    });

    it("validate checks the bytes JSON.stringify would PUT", () => {
      const { object, meta } = createUser(OTTO, { name: "Alice" });
      const edited = { ...object, foo: 2 ** 53 };
      const message = "Validation Error: integer 9007199254740992 outside the JSON-safe range (in extra member foo)";
      rejects(() => validate(meta.url, edited), message);
      rejects(() => readObject(meta.url, stored(edited)), message);
      // toJSON decides the stored bytes, so it decides what is checked
      validate(meta.url, { toJSON: () => object });
    });

    it("a value of the wrong type never reaches the wasm", () => {
      rejects(() => parseUri(42), "Validation Error: parseUri() argument 1 must be a string");
      rejects(() => createUser(OTTO, "Alice"), "Validation Error: createUser() argument 2 must be an object");
      rejects(() => readObject(userUriBuilder(OTTO), [1, 2]), "Validation Error: readObject() argument 2 must be a Uint8Array");
      rejects(() => createTag(OTTO, userUriBuilder(OTTO)), "Validation Error: createTag() argument 3 must be a string");
      rejects(() => feedPaths("a", "b"), "Validation Error: feedPaths() takes at most 1 arguments");
      rejects(() => planUnpublish("0032SSN7Q4EVG", new Array(1), []), "Validation Error: planUnpublish() argument 2 must be an array of strings");
      rejects(() => readObject(userUriBuilder(OTTO), new DataView(new ArrayBuffer(2))), /must be a Uint8Array/);
      rejects(() => readObject(userUriBuilder(OTTO), new Uint16Array(2)), /must be a Uint8Array/);
      rejects(() => migrate({}, "pub/pubky.app/profile.json", stored({})), "Validation Error: migrate() argument 1 must be a Migration handle");
    });

    it("a view of a detached buffer, or an array that changes after the check, never reaches the wasm", () => {
      const buffer = new ArrayBuffer(4);
      const view = new Uint8Array(buffer);
      structuredClone(buffer, { transfer: [buffer] });
      rejects(() => readObject(userUriBuilder(OTTO), view), "Validation Error: readObject() argument 2 must be a Uint8Array");
      rejects(() => createFile(OTTO, view, "image/png"), "Validation Error: createFile() argument 2 must be a Uint8Array");
      let reads = 0;
      const shifting = new Proxy([postUriBuilder(OTTO, "0032SSN7Q4EVG")], {
        get: (target, key, receiver) => (key === "0" && ++reads > 1 ? 42 : Reflect.get(target, key, receiver)),
      });
      // The glue gets the checked copy: whatever the planner says, it says it as a Validation Error
      try {
        planUnpublish("0032SSN7Q4EVG", shifting, []);
      } catch (e) {
        assert.match(e.message, /^Validation Error:/);
      }
      const throwing = new Proxy([], {
        get: () => {
          throw new Error("trap");
        },
      });
      rejects(() => planUnpublish("0032SSN7Q4EVG", throwing, []), "Validation Error: planUnpublish() argument 2 must be an array of strings");
    });

    it("a byte view whose length lies never reaches the wasm", () => {
      class Lying extends Uint8Array {
        get length() {
          return 1 << 20;
        }
      }
      rejects(() => readObject(userUriBuilder(OTTO), new Lying(2)), "Validation Error: readObject() argument 2 must be a Uint8Array");
      rejects(() => createFile(OTTO, new Lying(2), "image/png"), "Validation Error: createFile() argument 2 must be a Uint8Array");
      const run = createMigration(OTTO);
      rejects(() => migrate(run, "pub/pubky.app/profile.json", new Lying(2)), "Validation Error: migrate() argument 3 must be a Uint8Array");
      run.free();
      // validate reads a media view by its own length: the lie is ignored, not trusted
      const { meta } = createFile(OTTO, new Uint8Array([1, 2]), "image/png");
      validate(meta.url, { bytes: new Lying([1, 2]) });
      rejects(() => validate(meta.url, { bytes: new Lying([1, 2, 3]) }), /Invalid ID/);
    });

    it("bytes from another realm pass", () => {
      const { object, meta } = createFile(OTTO, new Uint8Array([1, 2]), "image/png");
      const foreign = vm.runInNewContext("new Uint8Array([1, 2])");
      assert.ok(!(foreign instanceof Uint8Array));
      assert.strictEqual(readObject(meta.url, foreign).kind, "file");
      validate(meta.url, object);
      validate(meta.url, { bytes: foreign });
    });

    it("a cyclic object throws cleanly, a shared one passes", () => {
      const cyclic = { name: "Alice" };
      cyclic.self = cyclic;
      rejects(() => validate(userUriBuilder(OTTO), cyclic), "Validation Error: the value has no JSON form");
      const shared = { level: 1 };
      validate(userUriBuilder(OTTO), { name: "Alice", ext: { a: shared, b: shared } });
    });
  });

  describe("parseUri, stableId, resolveDeref", () => {
    it("classifies into {userId, visibility, resource, path}", () => {
      const uri = `pubky://${OTTO}/priv/social/v1/posts/0032SSN7Q4EVG/0034A0X7NJ52G-my-draft.json`;
      assert.deepStrictEqual(parseUri(uri), {
        userId: OTTO,
        visibility: "private",
        resource: { kind: "post", id: "0032SSN7Q4EVG", version: "0034A0X7NJ52G", label: "my-draft" },
        path: "/priv/social/v1/posts/0032SSN7Q4EVG/0034A0X7NJ52G-my-draft.json",
      });
      assert.deepStrictEqual(parseUri(postUriBuilder(RIO, "0033SSE3B1FQ0")).resource, { kind: "post", id: "0033SSE3B1FQ0" });
      assert.deepStrictEqual(parseUri(`pubky://${OTTO}`).resource, { kind: "user" });
      assert.strictEqual(parseUri(`pubky://${OTTO}`).path, "");
    });

    it("reports foreign, unsupported and unknown paths as kinds, never errors", () => {
      assert.deepStrictEqual(parseUri(`pubky://${OTTO}/pub/app.locks/v2/a/b`).resource, {
        kind: "foreign",
        namespace: "app.locks",
        version: "v2",
        rest: ["a", "b"],
      });
      assert.deepStrictEqual(parseUri(`pubky://${OTTO}/pub/social/v9/posts/0032SSN7Q4EVG`).resource, {
        kind: "unsupportedVersion",
        version: "v9",
      });
      assert.deepStrictEqual(parseUri(`pubky://${OTTO}/pub/social/v1/nothing`).resource, { kind: "unknown" });
      rejects(() => parseUri("https://example.com"), /^Validation Error: Not a canonical pubky URI/);
    });

    it("keys every epoch spelling of one object together", () => {
      assert.deepStrictEqual(stableId("pub/social/v1/posts/0032SSN7Q4EVG/0034A0X7NJ52G.json"), {
        kind: "key",
        key: "posts/0032SSN7Q4EVG",
      });
      assert.deepStrictEqual(stableId("/pub/pubky.app/posts/0032SSN7Q4EVG"), { kind: "key", key: "posts/0032SSN7Q4EVG" });
      assert.deepStrictEqual(stableId("pub/pubky.app/files/0032SSN7Q4EVG"), { kind: "needsDeref", tsid: "0032SSN7Q4EVG" });
      assert.strictEqual(stableId("pub/elsewhere/x"), null);
    });

    it("completes a legacy media key through the v0 File object's src", () => {
      const hash = "8Z8CWH8NVYQY39ZEBFGKQWWEKG";
      assert.strictEqual(resolveDeref("0032SSN7Q4EVG", `pubky://${OTTO}/pub/pubky.app/blobs/${hash}`), `files/${hash}`);
      assert.strictEqual(resolveDeref("0032SSN7Q4EVG", "https://example.com/x.png"), null);
    });
  });

  describe("Bookmark", () => {
    const target = `pubky://${RIO}/pub/social/v1/posts/0033SREKPC4N0`;

    it("puts the target in the filename", () => {
      const { object, meta } = createBookmark(OTTO, target);
      assert.strictEqual(bookmarkUriBuilder(OTTO, meta.id), meta.url);
      const chunks = meta.url.split("/");
      assert.strictEqual(chunks[3], "priv", "bookmarks live under the private root");
      assert.strictEqual(chunks[6], "bookmarks");
      assert.strictEqual(chunks[7], `${meta.id}.json`);
      assert.strictEqual(meta.id, Buffer.from(target).toString("base64url"));
      assert.strictEqual(bookmarkTarget(meta.id, object), target);
      assert.strictEqual(object.uri, undefined, "the content carries no uri");
      assert.strictEqual(object.target, undefined, "a primary bookmark carries no target");
      assert.strictEqual(typeof object.created_at, "number");
      // One target, one filename, so a second bookmark overwrites the first
      assert.strictEqual(createBookmark(OTTO, `pubky${RIO}/pub/social/v1/posts/0033SREKPC4N0`).meta.id, meta.id);
    });

    it("spells a long target in the overflow form", () => {
      const long = `https://example.com/${"a".repeat(168)}`;
      const { object, meta } = createBookmark(OTTO, long);
      assert.ok(meta.id.startsWith("~"), "a 188 byte target overflows");
      assert.strictEqual(object.target, long);
      assert.strictEqual(bookmarkTarget(meta.id, object), long);
    });

    it("reads a primary entry from its filename alone", () => {
      const { meta } = createBookmark(OTTO, target);
      assert.strictEqual(bookmarkTarget(meta.id), target);
      assert.strictEqual(bookmarkTarget(meta.id, null), target);
      const long = createBookmark(OTTO, `https://example.com/${"a".repeat(168)}`);
      rejects(() => bookmarkTarget(long.meta.id), /overflow bookmark requires target/);
    });

    it("reads stored JSON back, and names the filename without minting", () => {
      for (const t of [target, `https://example.com/${"a".repeat(168)}`]) {
        const { object, meta } = createBookmark(OTTO, t);
        assert.strictEqual(bookmarkTarget(meta.id, JSON.parse(JSON.stringify(object))), t);
        assert.strictEqual(bookmarkFilename(t), meta.id);
      }
    });

    it("rejects an invalid entry instead of guessing", () => {
      const { object, meta } = createBookmark(OTTO, target);
      rejects(() => bookmarkTarget(`${meta.id}=`, object), /base64url/);
      rejects(() => createBookmark(OTTO, "not a uri"));
    });
  });

  describe("Follow, Tag, Mute", () => {
    it("a follow is named by the followee", () => {
      const { object, meta } = createFollow(OTTO, RIO);
      assert.strictEqual(followUriBuilder(OTTO, RIO), meta.url);
      assert.strictEqual(meta.id, RIO);
      assert.strictEqual(meta.path, `/pub/social/v1/follows/${RIO}.json`);
      assert.strictEqual(typeof object.created_at, "number");
    });

    it("a tag is named by the hash of uri and label", () => {
      const uri = `pubky://${OTTO}/pub/social/v1/profile.json`;
      assert.strictEqual(userUriBuilder(OTTO), uri);
      const { object, meta } = createTag(OTTO, uri, "otto");
      assert.strictEqual(tagUriBuilder(OTTO, meta.id), meta.url);
      assert.strictEqual(meta.path, `/pub/social/v1/tags/${meta.id}.json`);
      assert.strictEqual(object.uri, uri);
      assert.strictEqual(object.label, "otto");
      assert.strictEqual(typeof object.created_at, "number");
    });

    it("a tag label rejects comma, colon and whitespace", () => {
      const uri = userUriBuilder(OTTO);
      rejects(() => createTag(OTTO, uri, "otto,rio"), "Validation Error: Tag 'otto,rio' contains invalid character: ,");
      rejects(() => createTag(OTTO, uri, "otto:rio"), "Validation Error: Tag 'otto:rio' contains invalid character: :");
      rejects(() => createTag(OTTO, uri, "otto rio"), "Validation Error: Tag 'otto rio' contains whitespace characters");
    });

    it("a mute lives under the private root", () => {
      const { object, meta } = createMute(OTTO, RIO);
      assert.strictEqual(muteUriBuilder(OTTO, RIO), meta.url);
      assert.strictEqual(meta.path, `/priv/social/v1/mutes/${RIO}.json`);
      assert.strictEqual(typeof object.created_at, "number");
    });
  });

  describe("File", () => {
    it("is the bytes, named by their hash and the mapped extension", () => {
      const bytes = Array.from({ length: 8 }, () => Math.floor(Math.random() * 256));
      const { object, meta } = createFile(OTTO, new Uint8Array(bytes), "application/pdf");
      assert.strictEqual(meta.path, `/pub/social/v1/files/${meta.id}.pdf`);
      assert.strictEqual(fileUriBuilder(OTTO, `${meta.id}.pdf`), meta.url);
      assert.ok(object.bytes instanceof Uint8Array);
      assert.deepStrictEqual(Array.from(object.bytes), bytes);
    });

    it("maps a type the table does not carry to .bin", () => {
      const { meta } = createFile(OTTO, new Uint8Array([1, 2]), "application/x-not-a-real-type");
      assert.strictEqual(meta.id, "PZBQ010FF079VVZPQG1RNFN6DR", "blake3 known answer for [1, 2]");
      assert.ok(meta.url.endsWith(`${meta.id}.bin`));
    });

    it("the hasher spells the id createFile gives, however the bytes are chunked", () => {
      const bytes = new Uint8Array(Array.from({ length: 1000 }, (_, i) => (i * 7) % 256));
      const { meta } = createFile(OTTO, bytes, "image/png");
      for (const cuts of [[], [3], [3, 500], [1, 2, 999]]) {
        const hasher = hasherNew();
        assert.ok(hasher instanceof Hasher);
        let at = 0;
        for (const cut of [...cuts, bytes.length]) {
          hasherUpdate(hasher, bytes.subarray(at, cut));
          at = cut;
        }
        assert.strictEqual(hasherFinish(hasher), meta.id, String(cuts));
      }
      const pair = hasherNew();
      hasherUpdate(pair, new Uint8Array([1]));
      hasherUpdate(pair, new Uint8Array([2]));
      assert.strictEqual(hasherFinish(pair), "PZBQ010FF079VVZPQG1RNFN6DR", "blake3 known answer for [1, 2]");
      // Finishing consumes the handle
      rejects(() => hasherUpdate(pair, new Uint8Array([3])), "Validation Error: hasherUpdate() argument 1 must be a Hasher handle");
      rejects(() => hasherFinish(pair), "Validation Error: hasherFinish() argument 1 must be a Hasher handle");
      rejects(() => hasherUpdate({}, bytes), "Validation Error: hasherUpdate() argument 1 must be a Hasher handle");
      rejects(() => hasherUpdate(hasherNew(), [1, 2]), "Validation Error: hasherUpdate() argument 2 must be a Uint8Array");
      rejects(() => hasherNew(1), "Validation Error: hasherNew() takes at most 0 arguments");
    });

    it("rejects empty bytes and an unknown root", () => {
      rejects(() => createFile(OTTO, new Uint8Array([]), "image/png"), /cannot be zero/);
      rejects(() => createFile(OTTO, new Uint8Array([1]), "image/png", "pub"), /^Validation Error: unknown variant `pub`/);
    });

    it("exposes the essence and the whole frozen map", () => {
      assert.strictEqual(essence("IMAGE/PNG; charset=x"), "image/png");
      assert.strictEqual(essence(" image/png"), null, "no trimming, a padded type is malformed");
      const table = mimeToExtTable;
      assert.ok(Object.isFrozen(table));
      assert.deepStrictEqual(mimeSubpath.mimeToExtTable, table);
      assert.strictEqual(table["image/svg+xml"], "svg");
      assert.strictEqual(Object.keys(table).length, 19, "the map has exactly 19 rows");
      for (const [mime, ext] of Object.entries(table)) {
        assert.strictEqual(mimeToExt(mime), ext);
      }
    });

    it("lists the picker hint types", () => {
      const types = validMimeTypes;
      assert.ok(Array.isArray(types));
      assert.ok(Object.isFrozen(types));
      assert.deepStrictEqual(mimeSubpath.validMimeTypes, types);
      for (const t of ["image/png", "image/jpeg", "image/gif", "image/webp", "video/mp4", "video/mpeg", "application/pdf", "application/json", "text/plain"]) {
        assert.ok(types.includes(t), t);
      }
      assert.ok(!types.includes("application/x-executable"));
      assert.ok(!types.includes("application/x-msdownload"));
      const { meta } = createFile(OTTO, new Uint8Array([1, 2]), types[0]);
      assert.strictEqual(meta.url.split("/").pop(), `${meta.id}.${mimeToExt(types[0])}`);
    });
  });

  describe("Feed", () => {
    it("lives at its private path and publishes by copy", () => {
      const { object, meta } = createFeed(OTTO, {
        tags: ["mountain", "hike"],
        reach: "all",
        layout: "columns",
        sort: "recent",
        content: "image",
        name: "nature",
        icon: "mountain",
      });
      assert.strictEqual(meta.url.split("/")[3], "priv");
      assert.strictEqual(feedUriBuilder(OTTO, meta.id), meta.url);

      const paths = feedPaths(meta.id);
      assert.strictEqual(paths.private, `/priv/social/v1/feeds/${meta.id}.json`);
      assert.strictEqual(paths.public, `/pub/social/v1/feeds/${meta.id}.json`);
      assert.strictEqual(paths.private, meta.path);

      const lifecycle = feedLifecycle(meta.id);
      assert.deepStrictEqual(lifecycle.publish, { from: paths.private, to: paths.public });
      assert.deepStrictEqual(lifecycle.unpublish, [paths.public]);
      assert.deepStrictEqual(lifecycle.delete, [paths.public, paths.private]);
      assert.deepStrictEqual(deletionPaths({ kind: "feed", id: meta.id }), lifecycle.delete);

      assert.deepStrictEqual(object.feed.tags, ["hike", "mountain"], "one filter, one spelling, one id");
      assert.strictEqual(object.feed.reach, "all");
      assert.strictEqual(object.feed.layout, "columns");
      assert.strictEqual(object.feed.sort, "recent");
      assert.strictEqual(object.feed.content, "image");
      assert.strictEqual(object.name, "nature");
      assert.strictEqual(object.icon, "mountain");
      assert.strictEqual(typeof object.created_at, "number");
    });

    it("feedId gives an edited feed the id createFeed gives its config", () => {
      const input = { tags: ["mountain", "hike"], reach: "all", layout: "columns", sort: "recent", name: "n", icon: "i" };
      const { object, meta } = createFeed(OTTO, input);
      const { object: read } = readObject(meta.url, stored({ ...object, ext: { kept: true } }));
      assert.strictEqual(feedId(read), meta.id);
      read.feed.tags = ["hike", "river"];
      assert.strictEqual(feedId(read), createFeed(OTTO, { ...input, tags: ["river", "hike"] }).meta.id);
      read.feed.tags = ["river", "hike"];
      rejects(() => feedId(read), /sorted/);
    });

    it("takes wot reach and domainTags", () => {
      const { object } = createFeed(OTTO, {
        tags: ["rust"],
        reach: "wot",
        layout: "columns",
        sort: "recent",
        content: "image",
        name: "WoT Feed",
        domainTags: ["synonym"],
        icon: "users",
      });
      assert.strictEqual(object.feed.reach, "wot");
      assert.deepStrictEqual(object.feed.domain_tags, ["synonym"]);
    });

    it("takes me reach with no filters", () => {
      const { object } = createFeed(OTTO, { reach: "me", layout: "list", sort: "popularity", name: "My Posts", icon: "user" });
      assert.strictEqual(object.feed.reach, "me");
      assert.strictEqual(object.feed.domain_tags, undefined);
      assert.strictEqual(object.feed.tags, null);
    });

    it("rejects icons outside a-z, 0-9 and -", () => {
      for (const icon of ["bad icon", "bad_icon"]) {
        rejects(() => createFeed(OTTO, { reach: "all", layout: "columns", sort: "recent", name: "Bad", icon }), /icon/);
      }
    });

    it("requires an icon and a known reach", () => {
      rejects(() => createFeed(OTTO, { reach: "all", layout: "columns", sort: "recent", name: "No icon" }), /^Validation Error: missing field `icon`/);
      rejects(() => createFeed(OTTO, { reach: "some", layout: "columns", sort: "recent", name: "x", icon: "x" }), "Validation Error: Invalid feed reach: some");
    });
  });

  describe("deletionPaths", () => {
    const hash = "8Z8CWH8NVYQY39ZEBFGKQWWEKG";

    it("spans every epoch and both roots for media", () => {
      assert.deepStrictEqual(
        deletionPaths({
          kind: "file",
          id: hash,
          listings: [
            `/priv/social/v1/files/${hash}.png`,
            { path: "/pub/pubky.app/files/0032SSN7Q4EVG", src: `pubky://${OTTO}/pub/pubky.app/blobs/${hash}` },
          ],
        }),
        [
          "/pub/pubky.app/files/0032SSN7Q4EVG",
          `/pub/pubky.app/blobs/${hash}`,
          `/pub/social/v1/files/${hash}.png`,
          `/priv/social/v1/files/${hash}.png`,
        ],
      );
    });

    it("takes the legacy copy of every public kind first", () => {
      assert.deepStrictEqual(deletionPaths({ kind: "user", id: "" }), [
        "/pub/pubky.app/profile.json",
        "/pub/social/v1/profile.json",
      ]);
      assert.deepStrictEqual(deletionPaths({ kind: "follow", id: RIO }), [
        `/pub/pubky.app/follows/${RIO}`,
        `/pub/social/v1/follows/${RIO}.json`,
      ]);
      // The 0.x tag id hashes the stored uri and label the way a v1 tag id does, so the v1
      // builder over the v0 spelling is the oracle for the legacy path
      const uri = `pubky://${RIO}/pub/pubky.app/profile.json`;
      const v0Id = createTag(OTTO, uri, "friend").meta.id;
      const entry = { path: `/pub/pubky.app/tags/${v0Id}`, uri, label: "friend" };
      const id = createTag(OTTO, userUriBuilder(RIO), "friend").meta.id;
      assert.deepStrictEqual(deletionPaths({ kind: "tag", id, listings: [entry] }), [
        entry.path,
        `/pub/social/v1/tags/${id}.json`,
      ]);
      // A v0 tag of another target is not a copy of this tag, valid as it is
      const otherId = createTag(OTTO, userUriBuilder(OTTO), "friend").meta.id;
      rejects(() => deletionPaths({ kind: "tag", id: otherId, listings: [entry] }), `Validation Error: legacy tag ${entry.path} is not a copy of tag ${otherId}`);
      rejects(() => deletionPaths({ kind: "tag", id, listings: [{ ...entry, label: "foe" }] }), /not a stored copy of tag/);
      rejects(() => deletionPaths({ kind: "tag", id, listings: [entry.path] }), /not a stored copy of tag/);
      // A tag on a v0 File object targets the v1 media file, which its src and content_type spell
      const fileUri = `pubky://${RIO}/pub/pubky.app/files/0032SSN7Q4EVG`;
      const onFile = {
        path: `/pub/pubky.app/tags/${createTag(OTTO, fileUri, "pic").meta.id}`,
        uri: fileUri,
        label: "pic",
        src: `pubky://${RIO}/pub/pubky.app/blobs/${hash}`,
        contentType: "image/png",
      };
      const fileTagId = createTag(OTTO, `pubky://${RIO}/pub/social/v1/files/${hash}.png`, "pic").meta.id;
      assert.deepStrictEqual(deletionPaths({ kind: "tag", id: fileTagId, listings: [onFile] }), [
        onFile.path,
        `/pub/social/v1/tags/${fileTagId}.json`,
      ]);
      rejects(() => deletionPaths({ kind: "tag", id: fileTagId, listings: [{ ...onFile, contentType: undefined }] }), /needs its File src and content_type/);
    });

    it("is the one private path for a mute", () => {
      assert.deepStrictEqual(deletionPaths({ kind: "mute", id: RIO }), [`/priv/social/v1/mutes/${RIO}.json`]);
      assert.deepStrictEqual(deletionPaths({ kind: "mute", id: RIO, listings: null }), [`/priv/social/v1/mutes/${RIO}.json`]);
      rejects(() => deletionPaths({ kind: "follow", id: RIO, listings: ["/pub/pubky.app/follows/x"] }), /takes no listings/);
      rejects(() => deletionPaths({ kind: "settings", id: "" }), /^Validation Error: unknown variant/);
    });

    it("names the listing it refuses", () => {
      const src = `pubky://${OTTO}/pub/pubky.app/blobs/${hash}`;
      const stray = `/pub/pubky.app/files/0032SSN7Q4EVG/../../../../priv/social/v1/mutes/${RIO}.json`;
      rejects(() => deletionPaths({ kind: "file", id: hash, listings: [{ path: stray, src }] }), `Validation Error: not a stored copy of file ${hash}: ${stray}`);
      // A v0 File object whose src names other bytes, or none, is not this file
      const other = { path: "/pub/pubky.app/files/0032SSN7Q4EVG", src: `pubky://${OTTO}/pub/pubky.app/blobs/PZBQ010FF079VVZPQG1RNFN6DR` };
      rejects(() => deletionPaths({ kind: "file", id: hash, listings: [other] }), /not a stored copy of file/);
      rejects(() => deletionPaths({ kind: "file", id: hash, listings: [other.path] }), /not a stored copy of file/);
    });
  });

  describe("prefixes and URI builders", () => {
    it("listPrefix spells both roots", () => {
      assert.strictEqual(listPrefix(OTTO, "public"), `pubky://${OTTO}/pub/social/v1/`);
      assert.strictEqual(listPrefix(OTTO, "private"), `pubky://${OTTO}/priv/social/v1/`);
      rejects(() => listPrefix(OTTO, "pub"), /^Validation Error: unknown variant/);
      rejects(() => listPrefix("nope", "public"), /52 ASCII characters/);
      assert.strictEqual(legacyListPrefix(OTTO), `pubky://${OTTO}/pub/pubky.app/`);
      rejects(() => legacyListPrefix("nope"), /^Validation Error: /);
    });

    it("every builder checks the owner key", () => {
      for (const build of [userUriBuilder, postUriBuilder, followUriBuilder, muteUriBuilder, bookmarkUriBuilder, tagUriBuilder, fileUriBuilder, feedUriBuilder]) {
        rejects(() => (build.length === 1 ? build("nope") : build("nope", "x")), /^Validation Error: /);
      }
    });

    it("every builder spells a URI the parser classifies as its kind", () => {
      const cases = [
        [userUriBuilder(OTTO), "user"],
        [postUriBuilder(OTTO, "0032SSN7Q4EVG"), "post"],
        [followUriBuilder(OTTO, RIO), "follow"],
        [muteUriBuilder(OTTO, RIO), "mute"],
        [bookmarkUriBuilder(OTTO, bookmarkFilename(userUriBuilder(RIO))), "bookmark"],
        [tagUriBuilder(OTTO, "8Z8CWH8NVYQY39ZEBFGKQWWEKG"), "tag"],
        [fileUriBuilder(OTTO, "8Z8CWH8NVYQY39ZEBFGKQWWEKG.png"), "file"],
        [feedUriBuilder(OTTO, "8Z8CWH8NVYQY39ZEBFGKQWWEKG"), "feed"],
      ];
      for (const [uri, kind] of cases) {
        assert.strictEqual(parseUri(uri).resource.kind, kind, uri);
      }
    });
  });

  describe("migration", () => {
    const corpus = require("../vectors/semantic/v0_to_v1.json");
    const owner = corpus.owner;
    const bytesOf = (input) => ("raw" in input ? new TextEncoder().encode(input.raw) : stored(input.body));
    // A vector row by the start of its name, as `migrate` takes it
    const vector = (prefix) => {
      const { input } = corpus.vectors.find((v) => v.name.startsWith(prefix));
      return [input.path, bytesOf(input)];
    };
    let run;

    before(() => {
      run = createMigration(owner);
      // The File objects first: they name the blobs and carry the names everything else references
      for (const file of corpus.files) {
        const result = migrate(run, `pub/pubky.app/files/${file.tsid}`, bytesOf(file));
        assert.deepStrictEqual(result, { writes: [], dropped: [] });
      }
    });
    after(() => run.free());

    it("every vector row migrates to its paths, or skips with a listed reason", () => {
      const seen = new Set();
      for (const { name, input, expected } of corpus.vectors) {
        const result = migrate(run, input.path, bytesOf(input));
        // The full URL a LIST returns is the same input
        assert.deepStrictEqual(migrate(run, `pubky://${owner}/${input.path}`, bytesOf(input)), result, name);
        if (expected.skip) {
          const { skip, note, ...rest } = result;
          assert.strictEqual(skip, expected.skip, name);
          assert.ok(note === undefined || typeof note === "string", name);
          assert.deepStrictEqual(rest, {}, name);
          assert.ok(skipReasons.includes(result.skip), name);
          seen.add(result.skip);
          continue;
        }
        assert.deepStrictEqual(
          result.writes.map((w) => w.meta.path),
          expected.writes.map((w) => `/${w.path}`),
          name,
        );
        assert.deepStrictEqual(result.dropped, expected.dropped ?? [], name);
        for (const { kind, object, meta } of result.writes) {
          assert.strictEqual(meta.url, `pubky://${owner}${meta.path}`, name);
          validate(meta.url, object);
          const body = kind === "file" ? object.bytes : stored(object);
          assert.deepStrictEqual(readObject(meta.url, body), { kind, object }, name);
        }
      }
      // oversize is a blob over 100 MB, no vector; the Rust tests reach it through transform
      const expected = skipReasons.filter((r) => r !== "oversize");
      assert.deepStrictEqual([...seen].sort(), [...expected].sort());
    });

    it("dereferences a post's media through the File objects, name included", () => {
      const [write] = migrate(run, ...vector("image post")).writes;
      assert.strictEqual(write.kind, "post");
      assert.strictEqual(write.meta.id, "0034A0X7NJ52J");
      assert.deepStrictEqual(write.object.attachments[0], {
        uri: fileUriBuilder(owner, "AKSZ57W2RFKHV1EHK007FQQ8TW.png"),
        name: "photo.png",
      });
      // A File the run never read stays as written: the legacy URI keeps resolving
      assert.strictEqual(write.object.attachments[3].uri, `pubky://${owner}/pub/pubky.app/files/0032SSN7Q4EVG`);
    });

    it("a blob becomes the media object, the extension from the lowest File naming it", () => {
      const [path, bytes] = vector("blob: same bytes");
      const [write] = migrate(run, path, bytes).writes;
      assert.strictEqual(write.kind, "file");
      assert.strictEqual(write.meta.path, "/pub/social/v1/files/AKSZ57W2RFKHV1EHK007FQQ8TW.png");
      assert.strictEqual(write.meta.id, "AKSZ57W2RFKHV1EHK007FQQ8TW");
      assert.deepStrictEqual(write.object.bytes, bytes);
    });

    it("migrateBlob gives the blob's destination from its size and hash, the write without its bytes", () => {
      const hashOf = (bytes) => {
        const hasher = hasherNew();
        hasherUpdate(hasher, bytes);
        return hasherFinish(hasher);
      };
      let blobs = 0;
      let refused = 0;
      for (const { name, input, expected } of corpus.vectors.filter((v) => v.kind === "blob")) {
        const bytes = bytesOf(input);
        const result = migrateBlob(run, input.path, bytes.length, hashOf(bytes));
        const byBytes = migrate(run, input.path, bytes);
        if ("skip" in expected) {
          // Both doors refuse the same way; the note is each door's own
          assert.strictEqual(result.skip, expected.skip, name);
          assert.strictEqual(byBytes.skip, expected.skip, name);
          refused++;
          continue;
        }
        assert.deepStrictEqual(result, { writes: byBytes.writes.map(({ kind, meta }) => ({ kind, meta })), dropped: [] }, name);
        assert.ok(!("object" in result.writes[0]), name);
        assert.deepStrictEqual(migrateBlob(run, `pubky://${owner}/${input.path}`, bytes.length, hashOf(bytes)), result, name);
        blobs++;
      }
      assert.ok(blobs >= 3 && refused >= 2);

      const [path, bytes] = vector("blob: same bytes");
      const hash = hashOf(bytes);
      assert.deepStrictEqual(migrateBlob(run, path, validationLimits.maxFileSizeBytes + 1, hash), { skip: "oversize" });
      const unhashed = { skip: "invalid", note: "blob bytes do not hash to the id in the path" };
      assert.deepStrictEqual(migrateBlob(run, path, bytes.length, hashOf(new Uint8Array([1]))), unhashed);
      assert.deepStrictEqual(migrateBlob(run, path, 0, hash), unhashed);
      assert.deepStrictEqual(migrateBlob(run, "pub/pubky.app/files/0033000000000", bytes.length, hash), { skip: "not_migrated" });
      rejects(() => migrateBlob(run, path, 1.5, hash), "Validation Error: migrateBlob() argument 3 must be a non-negative integer");
      rejects(() => migrateBlob(run, path, -1, hash), "Validation Error: migrateBlob() argument 3 must be a non-negative integer");
      rejects(() => migrateBlob(run, path, `${bytes.length}`, hash), "Validation Error: migrateBlob() argument 3 must be a non-negative integer");
    });

    it("a tag, a bookmark and a feed re-derive their ids; the bookmark and the feed go private", () => {
      const [tag] = migrate(run, ...vector("tag: a media target")).writes;
      assert.match(tag.meta.path, /^\/pub\/social\/v1\/tags\/[0-9A-Z]{26}\.json$/);
      assert.strictEqual(tag.object.uri, fileUriBuilder(owner, "AKSZ57W2RFKHV1EHK007FQQ8TW.png"));
      const [bookmark] = migrate(run, ...vector("bookmark: the rewritten")).writes;
      assert.ok(bookmark.meta.path.startsWith("/priv/social/v1/bookmarks/"), bookmark.meta.path);
      const [feed] = migrate(run, ...vector("feed: private")).writes;
      assert.ok(feed.meta.path.startsWith("/priv/social/v1/feeds/"), feed.meta.path);
      assert.strictEqual(feed.meta.id, feedId(feed.object));
    });

    it("reports what a profile dropped and still writes it", () => {
      const result = migrate(run, ...vector("profile: an image and a link"));
      assert.deepStrictEqual(result.dropped, ["profile_image", "profile_link[0]"]);
      assert.strictEqual(result.writes[0].object.image, null);
      assert.deepStrictEqual(result.writes[0].object.links, [{ title: "Web", url: "https://web.example/" }]);
    });

    it("what the 0.x reader stored migrates and what it refuses skips; nothing throws", () => {
      assert.strictEqual(migrate(run, ...vector("tombstone profile")).writes[0].object.name, "anonymous");
      assert.deepStrictEqual(migrate(run, ...vector("tombstone post")), {
        skip: "invalid",
        note: "Validation Error: Content cannot be the reserved keyword '[DELETED]'",
      });
      assert.deepStrictEqual(migrate(run, ...vector("unknown post kind")), { skip: "invalid", note: "Validation Error: post kind is unknown" });
      const follow = `pub/pubky.app/follows/${RIO}`;
      const bad = migrate(run, follow, new TextEncoder().encode("not json"));
      assert.strictEqual(bad.skip, "malformed");
      assert.match(bad.note, /expected ident/);
      const array = migrate(run, follow, new TextEncoder().encode("[1727740800000000]"));
      assert.strictEqual(array.writes[0].object.created_at, 1727740800000000);
      assert.deepStrictEqual(migrate(run, "pub/pubky.app/last_read", stored({})), { skip: "not_migrated" });
      // Another owner's tree is not this run's to migrate
      assert.deepStrictEqual(migrate(run, `pubky://${RIO}/pub/pubky.app/profile.json`, stored({ name: "Alice" })), { skip: "not_migrated" });
    });

    it("a handle from the other entry is refused before the wasm", async () => {
      const cjs = require("./index.cjs");
      await cjs.init();
      const foreign = cjs.createMigration(owner);
      assert.ok(foreign instanceof cjs.Migration && !(foreign instanceof Migration));
      rejects(() => migrate(foreign, "pub/pubky.app/profile.json", stored({ name: "Alice" })), "Validation Error: migrate() argument 1 must be a Migration handle");
      foreign.free();
    });

    it("a File the 0.x reader refuses skips, and its references stay as written", () => {
      const spare = createMigration(owner);
      assert.strictEqual(migrate(spare, "pub/pubky.app/files/0033000000000", stored({ name: 1 })).skip, "shape");
      const [write] = migrate(spare, ...vector("tag: a media target")).writes;
      assert.strictEqual(write.object.uri, `pubky://${owner}/pub/pubky.app/files/0033000000000`);
      spare.free();
    });

    it("a freed handle is refused, an owner that is not a pubky too", () => {
      rejects(() => createMigration("nope"), /52 ASCII characters/);
      const spent = createMigration(owner);
      spent.free();
      rejects(() => migrate(spent, "pub/pubky.app/profile.json", stored({ name: "Alice" })), "Validation Error: migrate() argument 1 must be a Migration handle");
      rejects(() => migrateBlob(spent, "pub/pubky.app/blobs/AKSZ57W2RFKHV1EHK007FQQ8TW", 1, "x"), "Validation Error: migrateBlob() argument 1 must be a Migration handle");
    });
  });

  describe("validation limits", () => {
    it("are frozen all the way down", () => {
      assert.ok(Object.isFrozen(validationLimits));
      assert.ok(Object.isFrozen(validationLimits.tagInvalidChars));
      assert.ok(Object.isFrozen(subpathLimits));
    });

    it("the entry, the subpath and the JSON agree", () => {
      assert.deepStrictEqual(validationLimits, validationLimitsJson);
      assert.deepStrictEqual(subpathLimits, validationLimitsJson);
      assert.strictEqual(validationLimits.userNameMinLength, 3);
      assert.ok(Array.isArray(validationLimits.tagInvalidChars));
    });

    it("the subpath has no copy getter left", () => {
      assert.strictEqual(require("./validationLimits.cjs").getValidationLimits, undefined);
    });
  });
});
