// The transforms on their own, over the semantic vectors the Rust tests read too
// (vectors/semantic/v0_to_v1.json): a behaviour of the transforms ships with a vector row.

import assert from "assert";
import { createRequire } from "node:module";
import { buildUri, decodeObject, encodeObject, feedId, limits as validationLimits } from "./dist/index.js";

const fileUriBuilder = (owner, filename) => buildUri(owner, "file", filename);
import { skipReasons } from "./dist/migration/index.js";
import { init, transforms } from "./dist/migration/wasm.js";
import * as glue from "./dist/migration/glue.js";

const { createMigration, migrate, migrateBlob, mediaId } = transforms;
const { Migration } = glue;
const require = createRequire(import.meta.url);
const RIO = "dzswkfy7ek3bqnoc89jxuqqfbzhjrj6mi8qthgbxxcqkdugm3rio";

function rejects(fn, check) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof Error, `expected an Error, got ${typeof err}: ${err}`);
    if (typeof check === "string") assert.strictEqual(err.message, check);
    else if (check instanceof RegExp) assert.match(err.message, check);
    return true;
  });
}

// What a homeserver GET returns for a built object
const stored = (object) => new TextEncoder().encode(JSON.stringify(object));

before(() => init());

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
        // What the transform wrote is an object the native reader takes, and writes back the same
        const body = kind === "file" ? object.bytes : stored(object);
        const read = decodeObject(meta.url, body);
        assert.strictEqual(read.kind, kind, name);
        assert.deepStrictEqual(encodeObject(meta.url, kind === "file" ? read.bytes : read.object), body, name);
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
    const hashOf = mediaId;
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

