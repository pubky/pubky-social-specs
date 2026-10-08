import assert from "assert";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { decodeObject, listPrefix, limits, buildFile } from "./dist/index.js";
import { init, transforms } from "./dist/migration/wasm.js";

const { createMigration, migrate } = transforms;
import * as migration from "./dist/migration/index.js";
import { corpus, legacyTree, bytesOf } from "./migration.fixture.js";

const { transformRev, runMigration, MemoryPort, MigrationPortError, refusal, ENGINE_CAPS, MIGRATION_CAPS, bucketOf } = migration;
// The walk order, which the subpath keeps to itself
const BUCKETS = ["files", "blobs", "posts", "tags", "follows", "profile", "feeds", "bookmarks", "mutes"];

const require = createRequire(import.meta.url);
const owner = corpus.owner;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const url = (path) => `pubky://${owner}/${path}`;
const FLAG = url("priv/social/v1/_migrated.json");
const LEGACY = url("pub/pubky.app/");

const rows = new Map([...legacyTree()].map(([path, row]) => [path, { input: bytesOf(row), expected: row.expected }]));

const legacyPort = (options) => {
  const port = new MemoryPort(options);
  for (const [path, { input }] of rows) port.store.set(url(path), input);
  return port;
};

// What a run must report for the tree, from the vectors alone
const expectedCounts = () => {
  const counts = { written: 0 };
  for (const [path, { expected }] of rows) {
    if (expected.skip) counts[expected.skip] = (counts[expected.skip] ?? 0) + 1;
    else if (!path.startsWith("pub/pubky.app/files/")) counts.written++;
  }
  return counts;
};
// The notes on one 0.x path; the vectors' own skips carry notes too
const notesOf = (report, path) => report.notes.filter((n) => n.path === path).map((n) => n.message);
const nonZero = (counts) => Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0));

const v1Urls = (port) =>
  [...port.store.keys()].filter((u) => !u.startsWith(LEGACY) && u !== FLAG).sort();
const tree = (port) => new Map([...port.store].filter(([u]) => u !== FLAG));
const flagOf = (port) => JSON.parse(decoder.decode(port.store.get(FLAG)));
const puts = (port) => port.calls.filter((c) => c.op === "putJson" || c.op === "putBytes");
// Absent and null are the same member
const withoutNulls = (value) =>
  Array.isArray(value)
    ? value.map(withoutNulls)
    : value !== null && typeof value === "object" && !(value instanceof Uint8Array)
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([, v]) => v !== null && v !== undefined)
            .map(([k, v]) => [k, withoutNulls(v)]),
        )
      : value;
const noSleep = () => Promise.resolve();
// Another port over `port`'s store, with some calls answered its own way
const delegate = (port, overrides) => ({
  list: (prefix, cursor) => port.list(prefix, cursor),
  get: (target) => port.get(target),
  head: (target) => port.head(target),
  putJson: (target, object, options) => port.putJson(target, object, options),
  putBytes: (target, bytes, options) => port.putBytes(target, bytes, options),
  delete: (target) => port.delete(target),
  ...overrides,
});

describe("migration engine", () => {
  before(async () => {
    await init();
  });

  describe("MemoryPort", () => {
    it("lists deep and ascending, a page of 1000 after the cursor, an empty prefix as nothing", async () => {
      const port = new MemoryPort();
      for (let i = 2499; i >= 0; i--) {
        port.store.set(url(`pub/x/${String(i).padStart(4, "0")}`), new Uint8Array());
      }
      port.store.set(url("pub/y"), new Uint8Array());
      const first = await port.list(url("pub/x/"));
      assert.strictEqual(first.urls.length, 1000);
      assert.strictEqual(first.urls[0], url("pub/x/0000"));
      assert.strictEqual(first.next, url("pub/x/0999"));
      const second = await port.list(url("pub/x/"), first.next);
      assert.strictEqual(second.urls[0], url("pub/x/1000"));
      const last = await port.list(url("pub/x/"), (await port.list(url("pub/x/"), second.next)).urls[0]);
      assert.strictEqual(last.urls.length, 499);
      assert.strictEqual(last.next, undefined);
      assert.deepStrictEqual(await port.list(""), { urls: [] });
      assert.deepStrictEqual(await port.list(url("pub/z/")), { urls: [] });
    });

    it("gets null for a missing object, throws not_found deleting one, unsupported under /priv/ when off", async () => {
      const port = new MemoryPort({ privSupported: false });
      assert.strictEqual(await port.get(url("pub/a")), null);
      assert.strictEqual(await port.head(url("pub/a")), false);
      await assert.rejects(port.delete(url("pub/a")), (e) => e instanceof MigrationPortError && e.kind === "not_found" && e.status === 404);
      await assert.rejects(port.head(url("priv/social/v1/_migrated.json")), { kind: "unsupported", status: 403 });
      await assert.rejects(port.putJson(url("priv/social/v1/x"), {}), { kind: "unsupported" });
      await port.putJson(url("pub/a"), { b: 1 });
      assert.deepStrictEqual(JSON.parse(decoder.decode(await port.get(url("pub/a")))), { b: 1 });
    });
  });

  describe("bucketOf", () => {
    it("names the pass of every 0.x type, by path or URL, and rest for what no pass takes", () => {
      const cases = [
        ["pub/pubky.app/files/0033000000002", "files"],
        ["pub/pubky.app/blobs/AKSZ57W2RFKHV1EHK007FQQ8TW", "blobs"],
        ["pub/pubky.app/posts/0034A0X7NJ52C", "posts"],
        ["pub/pubky.app/tags/8Z8CWH8NVYQY39ZEBFGKQWWEKG", "tags"],
        ["pub/pubky.app/follows/pxnu33x7jtpx9ar1ytsi4yxbp6a5o36gwhffs8zoxmbuptici1jy", "follows"],
        ["pub/pubky.app/profile.json", "profile"],
        ["pub/pubky.app/feeds/8Z8CWH8NVYQY39ZEBFGKQWWEKG", "feeds"],
        ["pub/pubky.app/bookmarks/8Z8CWH8NVYQY39ZEBFGKQWWEKG", "bookmarks"],
        ["pub/pubky.app/mutes/pxnu33x7jtpx9ar1ytsi4yxbp6a5o36gwhffs8zoxmbuptici1jy", "mutes"],
        ["pub/pubky.app/settings.json", "rest"],
        ["pub/pubky.app/last_read", "rest"],
        ["pub/pubky.app/profile/x", "rest"],
        ["pub/pubky.app/unknown/x", "rest"],
        ["pub/pubky.app/posts/", "rest"],
        ["pub/social/v1/posts/0034A0X7NJ52C/0034A0X7NJ52C.json", "rest"],
        ["priv/social/v1/_migrated.json", "rest"],
        ["pub/pubky.appx/posts/0034A0X7NJ52C", "rest"],
        ["", "rest"],
      ];
      for (const [path, bucket] of cases) {
        assert.strictEqual(bucketOf(path), bucket, path);
        assert.strictEqual(bucketOf(`/${path}`), bucket, `/${path}`);
        assert.strictEqual(bucketOf(url(path)), bucket, url(path));
      }
      assert.strictEqual(bucketOf(`pubky://${owner}`), "rest");
      assert.deepStrictEqual(new Set(cases.map(([, b]) => b)), new Set([...BUCKETS, "rest"]));
    });

    it("counts a tree the way a run walks it", async () => {
      const port = legacyPort();
      const counts = {};
      for (const u of port.store.keys()) counts[bucketOf(u)] = (counts[bucketOf(u)] ?? 0) + 1;
      const walked = {};
      let last;
      await runMigration({
        owner,
        port,
        onProgress: (e) => {
          if (e.phase !== "migrating") return;
          const key = e.pass ?? "rest";
          if (e.done !== last) walked[key] = (walked[key] ?? 0) + 1;
          last = e.done;
        },
      });
      assert.deepStrictEqual(walked, counts);
    });
  });

  describe("runMigration", () => {
    it("migrates the tree: every write where the vectors put it, reading back, the 0.x tree untouched", async () => {
      const port = legacyPort();
      const events = [];
      const report = await runMigration({ owner, port, onProgress: (e) => events.push(e) });

      assert.strictEqual(report.status, "done");
      assert.strictEqual(report.mode, "run");
      assert.strictEqual(report.total, rows.size);
      assert.strictEqual(report.done, rows.size);
      assert.deepStrictEqual(nonZero(report.counts), expectedCounts());
      const dropped = Object.fromEntries(
        [...rows].filter(([, { expected }]) => expected.dropped?.length).map(([path, { expected }]) => [path, expected.dropped]),
      );
      assert.deepStrictEqual(report.droppedValues, dropped);
      assert.strictEqual(report.dropped, Object.values(dropped).flat().length);

      const expectedWrites = new Map();
      for (const { expected } of rows.values()) {
        for (const write of expected.writes ?? []) expectedWrites.set(url(write.path), write);
      }
      assert.deepStrictEqual(v1Urls(port), [...expectedWrites.keys()].sort());
      for (const [written, expected] of expectedWrites) {
        const { kind, object, bytes } = decodeObject(written, port.store.get(written));
        if (kind === "file") {
          assert.deepStrictEqual(bytes, encoder.encode(expected.raw), written);
          continue;
        }
        // The vectors spell an article or collection envelope parsed
        const read = typeof expected.body.content === "object" ? { ...object, content: JSON.parse(object.content) } : object;
        assert.deepStrictEqual(withoutNulls(read), withoutNulls(expected.body), written);
      }
      for (const [path, { input }] of rows) assert.deepStrictEqual(port.store.get(url(path)), input, path);

      const flag = flagOf(port);
      assert.strictEqual(flag.transform_rev, transformRev);
      assert.ok(Math.abs(flag.migrated_at - Date.now() * 1000) < 60e6, "microseconds, now");
      assert.deepStrictEqual(flag.skipped, report.skipped);
      assert.strictEqual(FLAG, `${listPrefix(owner, "private")}_migrated.json`);

      const phases = [...new Set(events.map((e) => e.phase))];
      assert.deepStrictEqual(phases, ["probe", "listing", "migrating", "flag", "done"]);
      assert.deepStrictEqual(
        [...new Set(events.filter((e) => e.pass).map((e) => e.pass))],
        BUCKETS.filter((b) => b !== "profile" || rows.has("pub/pubky.app/profile.json")),
      );
      assert.strictEqual(events.at(-1).done, events.at(-1).total);
    });

    it("counts settings.json and last_read as not_migrated, without reading them", async () => {
      const port = legacyPort();
      const report = await runMigration({ owner, port });
      assert.deepStrictEqual(report.skipped.not_migrated.sort(), ["pub/pubky.app/last_read", "pub/pubky.app/settings.json"]);
      assert.ok(!port.calls.some((c) => c.op === "get" && c.url === url("pub/pubky.app/settings.json")));
    });

    it("a rescan writes nothing but the flag, and the flag short-circuits the next run", async () => {
      const port = legacyPort();
      const first = await runMigration({ owner, port });
      const migrated = new Map(tree(port));

      port.calls.length = 0;
      const second = await runMigration({ owner, port, rescan: true });
      assert.strictEqual(second.status, "done");
      assert.deepStrictEqual(puts(port).map((c) => c.url), [FLAG]);
      assert.ok(!port.calls.some((c) => c.op === "delete"));
      assert.strictEqual(second.counts.written, 0);
      assert.strictEqual(second.counts.already_present, first.counts.written);
      assert.deepStrictEqual(second.skipped, first.skipped);
      assert.deepStrictEqual(tree(port), migrated);

      port.calls.length = 0;
      const third = await runMigration({ owner, port });
      assert.strictEqual(third.status, "already_migrated");
      assert.deepStrictEqual(third.skipped, first.skipped);
      assert.deepStrictEqual(port.calls.map((c) => c.op), ["head", "get"]);
    });

    it("a flag from an older transform revision is walked again", async () => {
      const port = legacyPort();
      await runMigration({ owner, port });
      await port.putJson(FLAG, { migrated_at: 1, transform_rev: transformRev - 1, skipped: {} });
      const report = await runMigration({ owner, port });
      assert.strictEqual(report.status, "done");
      assert.strictEqual(flagOf(port).transform_rev, transformRev);
    });

    it("an interrupted run resumes to the same tree as one that ran through", async () => {
      const whole = legacyPort();
      await runMigration({ owner, port: whole });

      const port = legacyPort();
      const controller = new AbortController();
      const stopped = await runMigration({
        owner,
        port,
        signal: controller.signal,
        onProgress: (e) => e.phase === "migrating" && e.done >= 12 && controller.abort(),
      });
      assert.strictEqual(stopped.status, "aborted");
      assert.strictEqual(stopped.error.code, "ABORTED");
      assert.ok(stopped.done < stopped.total);
      assert.ok(!port.store.has(FLAG), "an interrupted run writes no flag");

      const resumed = await runMigration({ owner, port });
      assert.strictEqual(resumed.status, "done");
      assert.deepStrictEqual(tree(port), tree(whole));
      const { migrated_at: _a, ...flag } = flagOf(port);
      const { migrated_at: _b, ...wholeFlag } = flagOf(whole);
      assert.deepStrictEqual(flag, wholeFlag);
    });

    it("a 1.x edit made between runs survives a rescan", async () => {
      const port = legacyPort();
      await runMigration({ owner, port });
      const profile = url("pub/social/v1/profile.json");
      const tag = v1Urls(port).find((u) => u.includes("/pub/social/v1/tags/"));
      const edited = new Map([
        [profile, encoder.encode(JSON.stringify({ ...decodeObject(profile, port.store.get(profile)).object, name: "Edited" }))],
        [tag, encoder.encode(JSON.stringify({ ...decodeObject(tag, port.store.get(tag)).object, ext: { kept: true } }))],
      ]);
      for (const [u, bytes] of edited) port.store.set(u, bytes);

      await runMigration({ owner, port, rescan: true });
      for (const [u, bytes] of edited) assert.deepStrictEqual(port.store.get(u), bytes, u);
    });

    it("a 0.x object deleted during its copy takes the copy with it", async () => {
      const follow = url(`pub/pubky.app/follows/${corpus.vectors.find((v) => v.name.startsWith("follow:")).input.path.split("/").pop()}`);
      const post = url("pub/pubky.app/posts/0034A0X7NJ52E");
      let port;
      port = legacyPort({
        intercept: (op, target) => {
          // One is deleted between its GET and the re-check, one before its GET
          if ((op === "head" && target === follow) || (op === "get" && target === post)) port.store.delete(target);
        },
      });
      const report = await runMigration({ owner, port });
      assert.deepStrictEqual(report.skipped.deleted_mid_run.sort(), [post, follow].map((u) => u.slice(`pubky://${owner}/`.length)).sort());
      assert.ok(!v1Urls(port).some((u) => u.includes("/follows/") || u.includes("0034A0X7NJ52E")));
      assert.ok(port.calls.some((c) => c.op === "delete" && c.url.includes("/pub/social/v1/follows/")));
      assert.ok(!port.calls.some((c) => c.op === "delete" && c.url.startsWith(LEGACY)), "the run deletes no 0.x object");
    });

    it("a post present only under priv/ is not copied public", async () => {
      const port = legacyPort();
      const draft = url("priv/social/v1/posts/0034A0X7NJ52C/0034A0X7NJ52G.json");
      const bytes = encoder.encode(JSON.stringify({ content: "draft", kind: "note", attachments: [] }));
      port.store.set(draft, bytes);
      const report = await runMigration({ owner, port });
      assert.strictEqual(report.counts.already_present, 1);
      assert.ok(!v1Urls(port).some((u) => u.includes("/pub/social/v1/posts/0034A0X7NJ52C/")));
      assert.deepStrictEqual(port.store.get(draft), bytes);
    });

    it("a homeserver without /priv/ aborts with the message, before listing", async () => {
      const port = legacyPort({ privSupported: false });
      const report = await runMigration({ owner, port });
      assert.strictEqual(report.status, "aborted");
      assert.strictEqual(report.error.code, "PRIV_UNSUPPORTED");
      assert.match(report.error.message, /private storage \(\/priv\/\)/);
      assert.deepStrictEqual(port.calls.map((c) => c.op), ["head"]);
    });

    it("a flag probe the homeserver fails is IO_ERROR, not a missing /priv/", async () => {
      const port = legacyPort({
        intercept: (op, target) => {
          if (op === "head" && target === FLAG) throw refusal(500, "Internal Server Error");
        },
      });
      const report = await runMigration({ owner, port, sleep: noSleep });
      assert.strictEqual(report.status, "aborted");
      assert.strictEqual(report.error.code, "IO_ERROR");
      assert.match(report.error.message, /^probing _migrated\.json: Internal Server Error/);
    });

    it("dry mode reads and counts as a run does, and writes, re-checks and deletes nothing", async () => {
      const real = await runMigration({ owner, port: legacyPort() });
      const port = legacyPort();
      const report = await runMigration({ owner, port, mode: "dry" });
      assert.strictEqual(report.status, "done");
      assert.strictEqual(report.mode, "dry");
      assert.deepStrictEqual(report.counts, real.counts);
      assert.deepStrictEqual(report.skipped, real.skipped);
      assert.deepStrictEqual(port.calls.filter((c) => !["list", "get"].includes(c.op)), [{ op: "head", url: FLAG }]);
      assert.deepStrictEqual(v1Urls(port), []);
      assert.ok(!port.store.has(FLAG));
    });

    it("a full homeserver pauses with the space the media still needs, and a later run finishes", async () => {
      let full = true;
      const port = legacyPort({
        intercept: (op) => {
          if (full && op === "putBytes") throw new MigrationPortError("quota", "Insufficient Storage", 507);
        },
      });
      const paused = await runMigration({ owner, port });
      assert.strictEqual(paused.status, "paused");
      assert.strictEqual(paused.error.message, "The homeserver is out of space for this account.");
      assert.strictEqual(paused.error.code, "QUOTA");
      // Three blobs of 20, 19 and 17 bytes by their File objects, and an orphan no File sizes
      assert.strictEqual(paused.error.needBytes, 56);
      assert.ok(!port.store.has(FLAG));

      full = false;
      const resumed = await runMigration({ owner, port });
      assert.strictEqual(resumed.status, "done");
      const whole = legacyPort();
      await runMigration({ owner, port: whole });
      assert.deepStrictEqual(tree(port), tree(whole));
    });

    it("needBytes counts a blob that failed to copy, and is left out when no blob is pending", async () => {
      const blob = url("pub/pubky.app/blobs/AKSZ57W2RFKHV1EHK007FQQ8TW");
      const full = (op) => {
        if (op === "putJson") throw new MigrationPortError("quota", undefined, 507);
      };
      const failing = legacyPort({
        intercept: (op, target) => {
          if (op === "get" && target === blob) throw new TypeError("fetch failed");
          full(op);
        },
      });
      const paused = await runMigration({ owner, port: failing, sleep: noSleep });
      assert.strictEqual(paused.status, "paused");
      assert.strictEqual(paused.error.needBytes, 20);

      const done = await runMigration({ owner, port: legacyPort({ intercept: full }) });
      assert.strictEqual(done.status, "paused");
      assert.ok(!("needBytes" in done.error));
    });

    it("a rate limit backs off from one second, doubling to a minute, and goes on", async () => {
      const profile = url("pub/social/v1/profile.json");
      let limited = 8;
      const port = legacyPort({
        intercept: (op, target) => {
          if (op === "putJson" && target === profile && limited-- > 0) throw new MigrationPortError("rate_limited", undefined, 429);
        },
      });
      const sleeps = [];
      const signal = new AbortController().signal;
      const report = await runMigration({
        owner,
        port,
        signal,
        sleep: async (ms, given) => {
          assert.strictEqual(given, signal, "a custom sleep gets the signal, to cut the wait short");
          sleeps.push(ms);
        },
      });
      assert.deepStrictEqual(sleeps, [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
      assert.strictEqual(report.status, "done");
      assert.ok(port.store.has(profile));
    });

    it("a network failure is retried three times, then counts io_error: no flag, and the next run retries it", async () => {
      const follow = [...rows.keys()].find((p) => p.includes("/follows/"));
      let down = true;
      const port = legacyPort({
        intercept: (op, target) => {
          if (down && op === "get" && target === url(follow)) throw new TypeError("fetch failed");
        },
      });
      const sleeps = [];
      const report = await runMigration({ owner, port, sleep: async (ms) => void sleeps.push(ms) });
      assert.strictEqual(report.status, "incomplete");
      assert.strictEqual(report.done, report.total);
      assert.deepStrictEqual(sleeps, [1000, 2000, 4000]);
      assert.strictEqual(port.calls.filter((c) => c.op === "get" && c.url === url(follow)).length, 4);
      assert.deepStrictEqual(report.skipped.io_error, [follow]);
      assert.deepStrictEqual(notesOf(report, follow), ["fetch failed"]);
      assert.ok(!port.store.has(FLAG), "an incomplete walk is not recorded");

      down = false;
      port.calls.length = 0;
      const next = await runMigration({ owner, port });
      assert.strictEqual(next.status, "done");
      assert.strictEqual(next.counts.written, 1);
      assert.ok(port.calls.some((c) => c.op === "get" && c.url === url(follow)));
      assert.ok(port.store.has(FLAG));
    });

    it("a File object that cannot be read stops the run before any blob is copied", async () => {
      const file = url("pub/pubky.app/files/0033000000000");
      const port = legacyPort({
        intercept: (op, target) => {
          if (op === "get" && target === file) throw new MigrationPortError("rejected", "Forbidden", 403);
        },
      });
      const report = await runMigration({ owner, port });
      assert.strictEqual(report.status, "aborted");
      assert.strictEqual(report.error.code, "IO_ERROR");
      assert.ok(!port.calls.some((c) => c.op === "putBytes" || c.op === "putJson"));
      assert.ok(!port.store.has(FLAG));
    });

    it("a File object the 0.x reader refuses is only its own skip", async () => {
      const port = legacyPort();
      port.store.set(url("pub/pubky.app/files/003300000000A"), encoder.encode("{"));
      // Valid but for an id from before October 2024
      port.store.set(url("pub/pubky.app/files/0030VNRG44G00"), bytesOf(corpus.files[0]));
      const report = await runMigration({ owner, port });
      assert.strictEqual(report.status, "done");
      assert.strictEqual(report.counts.malformed, (expectedCounts().malformed ?? 0) + 1);
      assert.strictEqual(report.counts.invalid, expectedCounts().invalid + 1);
      assert.ok(report.skipped.malformed.includes("pub/pubky.app/files/003300000000A"));
      assert.ok(report.skipped.invalid.includes("pub/pubky.app/files/0030VNRG44G00"));
      // The 0.x reader's refusal lands in the notes
      const old = report.notes.find((n) => n.path === "pub/pubky.app/files/0030VNRG44G00");
      assert.match(old.message, /timestamp must be after October 1st, 2024/);
    });

    it("a GET that answers not_found counts deleted_mid_run", async () => {
      const follow = [...rows.keys()].find((p) => p.includes("/follows/"));
      const port = legacyPort({
        intercept: (op, target) => {
          if (op === "get" && target === url(follow)) throw new MigrationPortError("not_found", undefined, 404);
        },
      });
      const report = await runMigration({ owner, port });
      assert.strictEqual(report.status, "done");
      assert.deepStrictEqual(report.skipped.deleted_mid_run, [follow]);
    });

    it("a re-check that fails deletes the copy, counts io_error, and the next run copies again", async () => {
      const follow = [...rows.keys()].find((p) => p.includes("/follows/"));
      let down = true;
      const port = legacyPort({
        intercept: (op, target) => {
          if (down && op === "head" && target === url(follow)) throw new TypeError("fetch failed");
        },
      });
      const report = await runMigration({ owner, port, sleep: noSleep });
      assert.strictEqual(report.status, "incomplete");
      assert.deepStrictEqual(report.skipped.io_error, [follow]);
      assert.ok(!v1Urls(port).some((u) => u.includes("/follows/")), "the unchecked copy is gone");
      down = false;
      assert.strictEqual((await runMigration({ owner, port })).status, "done");
      assert.ok(v1Urls(port).some((u) => u.includes("/follows/")));
    });

    it("a DELETE that fails in the race guard counts io_error and leaves no flag", async () => {
      const follow = [...rows.keys()].find((p) => p.includes("/follows/"));
      let port;
      port = legacyPort({
        intercept: (op, target) => {
          if (op === "head" && target === url(follow)) port.store.delete(target);
          if (op === "delete") throw new TypeError("fetch failed");
        },
      });
      const report = await runMigration({ owner, port, sleep: noSleep });
      assert.strictEqual(report.status, "incomplete");
      assert.deepStrictEqual(report.skipped.io_error, [follow]);
      assert.match(notesOf(report, follow)[0], /^deleting /);
      assert.ok(!port.store.has(FLAG));
    });

    it("a destination written between the LIST and the PUT is not clobbered, nor deleted by the race guard", async () => {
      const profile = url("pub/social/v1/profile.json");
      const theirs = encoder.encode(JSON.stringify({ name: "Written elsewhere" }));
      let port;
      port = legacyPort({
        intercept: (op, target) => {
          if (op === "putJson" && target === profile) port.store.set(profile, theirs);
          // The source goes too: what the run did not write is still not its to delete
          if (op === "head" && target === url("pub/pubky.app/profile.json")) port.store.delete(target);
        },
      });
      const report = await runMigration({ owner, port });
      assert.strictEqual(report.status, "done");
      assert.deepStrictEqual(port.store.get(profile), theirs);
      assert.ok(report.counts.already_present >= 1);
      assert.ok(!(report.skipped.deleted_mid_run ?? []).includes("pub/pubky.app/profile.json"));
      assert.ok(!port.calls.some((c) => c.op === "delete" && c.url === profile));
    });

    it("two 0.x tags folding to one 1.x tag: when the first copy is undone, the second lands", async () => {
      // A File reference and a blob reference to the same media, under one label
      const { input } = corpus.vectors.find((v) => v.name.startsWith("tag: a media target"));
      const media = input.body.uri;
      const blob = `pubky://${owner}/pub/pubky.app/blobs/AKSZ57W2RFKHV1EHK007FQQ8TW`;
      // The 0.x id of the blob reference under that label, which the walk meets first
      const first = url("pub/pubky.app/tags/3NKHYKFZZV3S3VKPBN7JFTNVSW");
      const second = url(input.path);
      let port;
      port = new MemoryPort({
        intercept: (op, target) => {
          if (op === "head" && target === first) port.store.delete(first);
        },
      });
      const file = corpus.files.find((f) => media.endsWith(`/files/${f.tsid}`));
      port.store.set(url(`pub/pubky.app/files/${file.tsid}`), bytesOf(file));
      port.store.set(first, encoder.encode(JSON.stringify({ ...input.body, uri: blob })));
      port.store.set(second, bytesOf(input));
      const report = await runMigration({ owner, port });
      assert.strictEqual(report.status, "done");
      assert.strictEqual(report.counts.deleted_mid_run, 1);
      assert.strictEqual(report.counts.written, 1);
      assert.strictEqual(v1Urls(port).filter((u) => u.includes("/pub/social/v1/tags/")).length, 1);
    });

    it("media present only under priv/ still gets its public copy", async () => {
      const port = legacyPort();
      const blob = [...rows].find(([p]) => p.endsWith("AKSZ57W2RFKHV1EHK007FQQ8TW"))[1].input;
      port.store.set(url("priv/social/v1/files/AKSZ57W2RFKHV1EHK007FQQ8TW.png"), blob);
      const report = await runMigration({ owner, port });
      assert.strictEqual(report.status, "done");
      assert.deepStrictEqual(port.store.get(url("pub/social/v1/files/AKSZ57W2RFKHV1EHK007FQQ8TW.png")), blob);
    });

    it("media under another extension is not the copy the references name", async () => {
      const port = legacyPort();
      const blob = rows.get("pub/pubky.app/blobs/AKSZ57W2RFKHV1EHK007FQQ8TW").input;
      const jpg = url("pub/social/v1/files/AKSZ57W2RFKHV1EHK007FQQ8TW.jpg");
      const other = encoder.encode("jpeg-bytes");
      port.store.set(jpg, other);
      const report = await runMigration({ owner, port });
      assert.strictEqual(report.status, "done");
      assert.deepStrictEqual(port.store.get(jpg), other);
      const post = decodeObject(url("pub/social/v1/posts/0034A0X7NJ52J/0034A0X7NJ52J.json"), port.store.get(url("pub/social/v1/posts/0034A0X7NJ52J/0034A0X7NJ52J.json"))).object;
      const png = post.attachments[0].uri;
      assert.strictEqual(png, url("pub/social/v1/files/AKSZ57W2RFKHV1EHK007FQQ8TW.png"));
      assert.deepStrictEqual(port.store.get(png), blob);
    });

    it("media present at its exact URL counts already_present and is not written", async () => {
      const port = legacyPort();
      const png = url("pub/social/v1/files/AKSZ57W2RFKHV1EHK007FQQ8TW.png");
      port.store.set(png, rows.get("pub/pubky.app/blobs/AKSZ57W2RFKHV1EHK007FQQ8TW").input);
      const report = await runMigration({ owner, port });
      assert.strictEqual(report.status, "done");
      assert.strictEqual(report.counts.already_present, 1);
      assert.strictEqual(report.counts.written, expectedCounts().written - 1);
      assert.ok(!puts(port).some((c) => c.url === png));
    });

    it("a blob over the cap skips as oversize without reaching the wasm", async () => {
      const blob = url("pub/pubky.app/blobs/VJAHM32NETJ12EWAAM11BQVX78");
      const port = legacyPort();
      // Zero-filled, so the pages are only reserved; nothing reads them
      const huge = new Uint8Array(limits.maxFileSizeBytes + 1);
      const sized = delegate(port, {
        get: async (target) => (target === blob ? huge : port.get(target)),
      });
      const report = await runMigration({ owner, port: sized });
      assert.deepStrictEqual(report.skipped.oversize, ["pub/pubky.app/blobs/VJAHM32NETJ12EWAAM11BQVX78"]);
      assert.ok(!v1Urls(port).some((u) => u.includes("VJAHM32NETJ12EWAAM11BQVX78")));
    });

    it("a port whose GET gives no Uint8Array rejects the run as a fault, and records nothing", async () => {
      const follow = url([...rows.keys()].find((p) => p.includes("/follows/")));
      const blob = url("pub/pubky.app/blobs/VJAHM32NETJ12EWAAM11BQVX78");
      for (const [target, odd] of [[follow, [1, 2]], [follow, "{}"], [blob, "orphan bytes"], [blob, new ArrayBuffer(4)]]) {
        const port = legacyPort();
        const faulty = delegate(port, { get: async (u) => (u === target ? odd : port.get(u)) });
        await assert.rejects(runMigration({ owner, port: faulty }), (e) => e instanceof TypeError && /gave no Uint8Array|must be a Uint8Array/.test(e.message));
        assert.ok(!port.store.has(FLAG), "a fault is never frozen into the flag");
      }
    });

    it("a fault inside a transform rejects with the error it threw, not a copy of its message", async () => {
      const real = transforms.migrate;
      const boom = new RangeError("boom");
      transforms.migrate = () => {
        throw boom;
      };
      try {
        await assert.rejects(runMigration({ owner, port: legacyPort() }), (e) => e === boom);
      } finally {
        transforms.migrate = real;
      }
    });

    it("walks a destination and a 0.x tree over many LIST pages", async () => {
      const whole = legacyPort();
      await runMigration({ owner, port: whole });
      const port = legacyPort({ pageSize: 2 });
      await runMigration({ owner, port });
      assert.deepStrictEqual(tree(port), tree(whole));
      assert.ok(port.calls.filter((c) => c.op === "list").length > rows.size / 2);
      const again = await runMigration({ owner, port, rescan: true });
      assert.strictEqual(again.counts.written, 0);
    });

    it("stops when a LIST answers URLs spelled another way", async () => {
      const port = legacyPort();
      const relative = delegate(port, {
        list: async (prefix, cursor) => {
          const page = await port.list(prefix, cursor);
          return { ...page, urls: page.urls.map((u) => u.slice(`pubky://${owner}`.length)) };
        },
      });
      const report = await runMigration({ owner, port: relative });
      assert.strictEqual(report.status, "aborted");
      assert.strictEqual(report.error.code, "IO_ERROR");
      assert.match(report.error.message, /returned \/pub\/pubky\.app\//);
    });

    it("a LIST whose cursor repeats, or answers empty pages without end, aborts instead of spinning", async () => {
      let lists = 0;
      const port = legacyPort();
      const cycling = delegate(port, {
        list: async (_prefix, cursor) => {
          lists++;
          return { urls: [], next: cursor === "a" ? "b" : "a" };
        },
      });
      const report = await runMigration({ owner, port: cycling });
      assert.strictEqual(report.status, "aborted");
      assert.strictEqual(report.error.code, "IO_ERROR");
      assert.match(report.error.message, /does not advance/);
      assert.strictEqual(lists, 3, "a, b, then a again");
      assert.ok(!v1Urls(port).some((u) => u.endsWith("_migrated.json")));
      let n = 0;
      const endless = delegate(port, { list: async () => ({ urls: [], next: `c${n++}` }) });
      const report2 = await runMigration({ owner, port: endless });
      assert.strictEqual(report2.error.code, "IO_ERROR");
      assert.ok(n < 200, `${n} LIST calls`);
      // Opaque cursors that do not sort are fine as long as they move
      const opaque = delegate(port, {
        list: async (prefix, cursor) => {
          const page = await port.list(prefix, cursor === undefined ? undefined : cursor.slice(2));
          return page.next ? { urls: page.urls, next: `9:${page.next}` } : page;
        },
      });
      assert.strictEqual((await runMigration({ owner, port: opaque, rescan: true })).status, "done");
    });

    it("keeps at most two objects in flight", async () => {
      let active = 0;
      let most = 0;
      const port = legacyPort({
        intercept: async (op) => {
          if (op === "list") return;
          active++;
          most = Math.max(most, active);
          await new Promise((r) => setTimeout(r, 1));
          active--;
        },
      });
      await runMigration({ owner, port });
      assert.strictEqual(most, 2);
    });

    it("two unlocked runs at once converge on the tree one run writes", async () => {
      const whole = legacyPort();
      await runMigration({ owner, port: whole });
      const port = legacyPort();
      const [a, b] = await Promise.all([runMigration({ owner, port }), runMigration({ owner, port })]);
      assert.strictEqual(a.status, "done");
      assert.strictEqual(b.status, "done");
      assert.deepStrictEqual(tree(port), tree(whole));
      assert.strictEqual(a.counts.written + b.counts.written, (await runMigration({ owner, port: legacyPort() })).counts.written);
    });

    it("a refused PUT counts put_rejected with the refusal, and the run goes on", async () => {
      const port = legacyPort({
        intercept: (op, target) => {
          if (op === "putJson" && target.includes("/pub/social/v1/follows/")) throw refusal(400);
        },
      });
      const report = await runMigration({ owner, port });
      assert.strictEqual(report.status, "done");
      assert.strictEqual(report.counts.put_rejected, 1);
      assert.match(notesOf(report, report.skipped.put_rejected[0])[0], /rejected \(400\)/);
      assert.ok(!v1Urls(port).some((u) => u.includes("/follows/")));
    });

    it("a 500 on a PUT is not a refusal: the run ends incomplete and the next one, without rescan, writes it", async () => {
      const profile = url("pub/social/v1/profile.json");
      let failing = true;
      const port = legacyPort({
        intercept: (op, target) => {
          if (failing && op === "putJson" && target === profile) throw refusal(500, "Internal Server Error");
        },
      });
      const report = await runMigration({ owner, port, sleep: noSleep });
      assert.strictEqual(report.status, "incomplete");
      assert.strictEqual(report.counts.put_rejected, 0);
      assert.deepStrictEqual(report.skipped.io_error, ["pub/pubky.app/profile.json"]);
      assert.ok(!port.store.has(profile));
      assert.ok(!port.store.has(FLAG), "no completion marker over a missing object");

      failing = false;
      const next = await runMigration({ owner, port });
      assert.strictEqual(next.status, "done");
      assert.strictEqual(next.counts.written, 1);
      assert.ok(port.store.has(profile));
      assert.ok(port.store.has(FLAG));
    });

    it("refusal maps a homeserver status to the kind the run branches on", () => {
      const kinds = [
        [507, "quota"],
        [429, "rate_limited"],
        [401, "unauthorized"],
        [403, "unauthorized"],
        [404, "not_found"],
        [412, "exists"],
        [500, "network"],
        [502, "network"],
        [503, "network"],
        [400, "rejected"],
        [413, "rejected"],
      ];
      for (const [status, kind] of kinds) {
        const error = refusal(status);
        assert.ok(error instanceof MigrationPortError);
        assert.deepStrictEqual([error.kind, error.status], [kind, status], String(status));
      }
    });

    it("a lost session aborts", async () => {
      const port = legacyPort({
        intercept: (op) => {
          if (op === "putBytes") throw new MigrationPortError("unauthorized", undefined, 401);
        },
      });
      const report = await runMigration({ owner, port });
      assert.strictEqual(report.status, "aborted");
      assert.strictEqual(report.error.code, "SESSION_EXPIRED");
      assert.ok(!port.store.has(FLAG));
    });

    it("caps that miss a scope the engine writes abort before any request; the two 1.x roots are enough", async () => {
      assert.strictEqual(ENGINE_CAPS, "/pub/social/v1/:rw,/priv/social/v1/:rw");
      assert.strictEqual(MIGRATION_CAPS, "/pub/social/v1/:rw,/priv/social/v1/:rw,/priv/app.pubky/v1/:rw,/pub/pubky.app/:rw");
      // A 0.x-only session on a homeserver without /priv/ hears about its caps, not the server
      const port = legacyPort({ privSupported: false });
      const report = await runMigration({ owner, port, caps: "/pub/pubky.app/:rw,/pub/social/v1/:rw" });
      assert.strictEqual(report.status, "aborted");
      assert.strictEqual(report.error.code, "CAPS_MISSING");
      assert.strictEqual(report.error.caps, ENGINE_CAPS);
      assert.deepStrictEqual(port.calls, []);
      assert.strictEqual((await runMigration({ owner, port: legacyPort(), caps: ["/pub/social/v1/:rw", "/priv/social/v1/:rw"] })).status, "done");
      // Read-only scopes do not cover a write
      assert.strictEqual((await runMigration({ owner, port, caps: MIGRATION_CAPS.replaceAll(":rw", ":r") })).error.code, "CAPS_MISSING");

      assert.strictEqual((await runMigration({ owner, port: legacyPort(), caps: ENGINE_CAPS })).status, "done");
      assert.strictEqual((await runMigration({ owner, port: legacyPort(), caps: MIGRATION_CAPS })).status, "done");
      assert.strictEqual((await runMigration({ owner, port: legacyPort(), caps: "/:rw" })).status, "done");
    });

    it("runs under the lock it is given, and refuses when another holder has it", async () => {
      const names = [];
      const held = await runMigration({
        owner,
        port: legacyPort(),
        lock: (name, fn) => {
          names.push(name);
          return fn(null);
        },
      });
      assert.strictEqual(held.status, "aborted");
      assert.strictEqual(held.error.code, "ALREADY_RUNNING");
      const free = await runMigration({ owner, port: legacyPort(), lock: (_name, fn) => fn({ name: "lock" }) });
      assert.strictEqual(free.status, "done");
      assert.deepStrictEqual(names, [`pubky-social-specs:migration:${owner}`]);
    });

    it("refuses a write outside the 1.x roots before any PUT, as a fault in the package", async () => {
      const real = { migrate: transforms.migrate, migrateBlob: transforms.migrateBlob };
      // A transform that sends each copy over its own 0.x source
      const astray = (source, result) => {
        for (const write of result.writes ?? []) write.meta = { ...write.meta, url: source };
        return result;
      };
      transforms.migrate = (handle, source, bytes) => astray(source, real.migrate(handle, source, bytes));
      transforms.migrateBlob = (handle, source, size, hash) => astray(source, real.migrateBlob(handle, source, size, hash));
      try {
        const port = legacyPort();
        const before = new Map(port.store);
        await assert.rejects(runMigration({ owner, port }), /a write to pubky:\/\/\w+\/pub\/pubky\.app\/.*, outside pubky:\/\/\w+\/pub\/social\/v1\/ and pubky:\/\/\w+\/priv\/social\/v1\//);
        assert.ok(!port.calls.some((c) => ["putJson", "putBytes", "delete"].includes(c.op)));
        assert.deepStrictEqual(port.store, before);
      } finally {
        Object.assign(transforms, real);
      }
    });

    it("an object deleted after its copy stays deleted through a revision bump and a rescan", async () => {
      const port = legacyPort();
      await runMigration({ owner, port });
      // The deletes leave the 0.x copies of these kinds in place
      const deleted = v1Urls(port).filter((u) => /\/(mutes|bookmarks|feeds)\//.test(u));
      assert.ok(deleted.some((u) => u.includes("/mutes/")) && deleted.some((u) => u.includes("/bookmarks/")) && deleted.some((u) => u.includes("/feeds/")));
      for (const u of deleted) port.store.delete(u);
      const flag = flagOf(port);
      assert.ok(flag.migrated.some((p) => p.includes("/mutes/")));
      await port.putJson(FLAG, { ...flag, transform_rev: transformRev - 1 });
      const bumped = await runMigration({ owner, port });
      assert.strictEqual(bumped.status, "done");
      assert.strictEqual(bumped.counts.written, 0);
      const rescanned = await runMigration({ owner, port, rescan: true });
      assert.strictEqual(rescanned.counts.written, 0);
      for (const u of deleted) assert.ok(!port.store.has(u), `${u} came back`);
      // What an earlier run skipped is still walked again
      assert.deepStrictEqual(rescanned.skipped, (await runMigration({ owner, port: legacyPort() })).skipped);
    });

    it("a flag it cannot read is a flag of revision 0, and the run still resolves", async () => {
      for (const flag of [
        { transform_rev: 1e9, skipped: { invalid: 5 } },
        { transform_rev: 1e9, skipped: { invalid: [1] } },
        { transform_rev: 1e9, skipped: { nonsense: [] } },
        { transform_rev: 1e9, skipped: [] },
        { transform_rev: 1e9, skipped: {}, migrated: "all" },
        [1],
        "text",
      ]) {
        const port = legacyPort();
        port.store.set(FLAG, encoder.encode(JSON.stringify(flag)));
        const report = await runMigration({ owner, port });
        assert.strictEqual(report.status, "done", JSON.stringify(flag));
        assert.strictEqual(flagOf(port).transform_rev, transformRev);
      }
      // An inherited member is no member of the flag
      Object.prototype.skipped = { invalid: 5 };
      try {
        const port = legacyPort();
        port.store.set(FLAG, encoder.encode(JSON.stringify({ transform_rev: 1e9 })));
        assert.strictEqual((await runMigration({ owner, port })).status, "already_migrated");
      } finally {
        delete Object.prototype.skipped;
      }
    });

    it("a 0.x object over the largest a client writes skips as oversize before the wasm sees it", async () => {
      const post = [...rows.keys()].find((p) => p.startsWith("pub/pubky.app/posts/"));
      const huge = new Uint8Array(6 * limits.postMaxBytes + 1).fill(32);
      huge[0] = 0x7b;
      huge[huge.length - 1] = 0x7d;
      const real = transforms.migrate;
      const seen = [];
      transforms.migrate = (handle, path, bytes) => (seen.push(path), real(handle, path, bytes));
      try {
        // A port that bounds its GET, and one that ignores the bound
        for (const bounded of [true, false]) {
          const port = legacyPort();
          port.store.set(url(post), huge);
          const loose = delegate(port, { get: (u) => port.get(u) });
          seen.length = 0;
          const report = await runMigration({ owner, port: bounded ? port : loose });
          assert.deepStrictEqual(report.skipped.oversize, [post]);
          assert.ok(!seen.includes(url(post)));
        }
      } finally {
        transforms.migrate = real;
      }
    });

    it("asks the port for at most the cap, and a port that stops reading there counts oversize", async () => {
      const blob = url("pub/pubky.app/blobs/VJAHM32NETJ12EWAAM11BQVX78");
      const asked = new Map();
      const port = legacyPort();
      const watched = delegate(port, {
        get: async (u, options) => {
          asked.set(u, options?.maxBytes);
          if (u === blob) throw new MigrationPortError("too_large");
          return port.get(u, options);
        },
      });
      const report = await runMigration({ owner, port: watched });
      assert.deepStrictEqual(report.skipped.oversize, ["pub/pubky.app/blobs/VJAHM32NETJ12EWAAM11BQVX78"]);
      assert.strictEqual(asked.get(blob), limits.maxFileSizeBytes);
      assert.strictEqual(asked.get(url([...rows.keys()].find((p) => p.includes("/posts/")))), 6 * limits.postMaxBytes);
      await port.putBytes(blob, new Uint8Array(11));
      await assert.rejects(port.get(blob, { maxBytes: 10 }), { kind: "too_large" });
      assert.strictEqual((await port.get(blob, { maxBytes: 11 })).length, 11);
    });

    it("refuses a write whose URL holds a dot segment, before any PUT", async () => {
      const real = transforms.migrate;
      transforms.migrate = (handle, source, bytes) => {
        const result = real(handle, source, bytes);
        for (const write of result.writes ?? []) write.meta = { ...write.meta, url: url("pub/social/v1/../../pubky.app/profile.json") };
        return result;
      };
      try {
        const port = legacyPort();
        const profile = port.store.get(url("pub/pubky.app/profile.json"));
        await assert.rejects(runMigration({ owner, port }), /a write to .*\/pub\/social\/v1\/\.\.\/\.\.\/pubky\.app\/profile\.json, outside/);
        assert.ok(!port.calls.some((c) => c.url.includes("/../")));
        assert.deepStrictEqual(port.store.get(url("pub/pubky.app/profile.json")), profile);
      } finally {
        transforms.migrate = real;
      }
    });

    it("the race guard deletes only the copy this run wrote, never another device's", async () => {
      const follow = url([...rows.keys()].find((p) => p.includes("/follows/")));
      const theirs = encoder.encode('{"created_at":1730000000000001}');
      let port;
      let destination;
      port = legacyPort({
        intercept: (op, target) => {
          if (op === "putJson" && target.includes("/pub/social/v1/follows/")) destination = target;
          // The source goes, and another device writes the destination, between the PUT and the re-check
          if (op === "head" && target === follow) {
            port.store.delete(follow);
            port.store.set(destination, theirs);
          }
        },
      });
      const report = await runMigration({ owner, port });
      assert.ok(report.skipped.deleted_mid_run.includes(follow.slice(`pubky://${owner}/`.length)));
      assert.deepStrictEqual(port.store.get(destination), theirs);
      assert.ok(!port.calls.some((c) => c.op === "delete" && c.url === destination));
    });

    // The race guard's read-back, each way it can answer: the source goes at its re-check, so
    // the copy has to go too, unless what is stored there now is not this run's
    const raceAt = (follow, onReadBack) => {
      let port;
      let destination;
      port = legacyPort({
        intercept: (op, target) => {
          if (op === "putJson" && target.includes("/pub/social/v1/follows/")) destination = target;
          if (op === "head" && target === url(follow)) port.store.delete(target);
          if (op === "get" && target === destination) onReadBack(port, destination);
        },
      });
      return { port, destination: () => destination };
    };
    const follow = () => [...rows.keys()].find((p) => p.includes("/follows/"));

    it("a read-back that fails leaves the copy, counts io_error, and writes no flag", async () => {
      const { port, destination } = raceAt(follow(), () => {
        throw new TypeError("fetch failed");
      });
      const report = await runMigration({ owner, port, sleep: noSleep });
      assert.strictEqual(report.status, "incomplete");
      assert.deepStrictEqual(report.skipped.io_error, [follow()]);
      assert.match(notesOf(report, follow())[0], /^deleting .*fetch failed/);
      assert.ok(port.store.has(destination()), "a copy the run cannot read back is not deleted");
      assert.ok(!port.calls.some((c) => c.op === "delete"));
    });

    it("a read-back that finds nothing, or bytes that are not JSON, deletes nothing", async () => {
      for (const onReadBack of [(port, at) => port.store.delete(at), (port, at) => port.store.set(at, encoder.encode("{not json"))]) {
        const { port } = raceAt(follow(), onReadBack);
        const report = await runMigration({ owner, port });
        assert.deepStrictEqual(report.skipped.deleted_mid_run, [follow()]);
        assert.ok(!port.calls.some((c) => c.op === "delete"));
      }
    });

    it("a blob copy is deleted only while it holds the bytes this run wrote", async () => {
      const blob = [...rows.keys()].find((p) => p.includes("/blobs/"));
      for (const theirs of [false, true]) {
        let port;
        let destination;
        // A blob's copy is named by its hash, the last segment of its 0.x path
        const hash = blob.split("/").at(-1);
        port = legacyPort({
          intercept: (op, target) => {
            if (op === "putBytes" && target.includes(`/files/${hash}.`)) destination = target;
            if (op === "head" && target === url(blob)) port.store.delete(target);
            if (theirs && op === "get" && target === destination) port.store.set(destination, encoder.encode("other bytes"));
          },
        });
        const report = await runMigration({ owner, port });
        assert.ok(report.skipped.deleted_mid_run.includes(blob));
        assert.strictEqual(port.store.has(destination), theirs, theirs ? "another device's bytes stay" : "our copy goes");
      }
    });

    describe("an object that becomes two writes", () => {
      // The transforms give one write per object today; the claims are written for several
      const real = transforms.migrate;
      const twice = (paths) => (run, v0, bytes) => {
        const result = real(run, v0, bytes);
        if (!("writes" in result) || !v0.includes("/follows/")) return result;
        const [write] = result.writes;
        return { ...result, writes: paths.map((path) => ({ ...write, meta: { ...write.meta, path, url: url(path.slice(1)) } })) };
      };
      const A = `/pub/social/v1/follows/${owner}.json`;
      const B = `/priv/social/v1/mutes/${owner}.json`;
      afterEach(() => {
        transforms.migrate = real;
      });

      it("writes both, and one found written elsewhere is theirs: no delete when the source goes", async () => {
        transforms.migrate = twice([A, B]);
        let port;
        port = legacyPort({
          intercept: (op, target) => {
            if (op === "putJson" && target === url(B.slice(1))) port.store.set(target, encoder.encode('{"created_at":1}'));
            if (op === "head" && target === url(follow())) port.store.delete(target);
          },
        });
        const report = await runMigration({ owner, port });
        assert.deepStrictEqual(report.skipped.deleted_mid_run, [follow()]);
        assert.ok(!port.store.has(url(A.slice(1))), "the copy this run made goes with its source");
        assert.deepStrictEqual(decoder.decode(port.store.get(url(B.slice(1)))), '{"created_at":1}');
      });

      it("a refused second PUT counts put_rejected and keeps the first copy", async () => {
        transforms.migrate = twice([A, B]);
        const port = legacyPort({
          intercept: (op, target) => {
            if (op === "putJson" && target === url(B.slice(1))) throw refusal(400, "refused");
          },
        });
        const report = await runMigration({ owner, port });
        assert.deepStrictEqual(report.skipped.put_rejected, [follow()]);
        assert.ok(port.store.has(url(A.slice(1))));
      });

      it("a cleanup DELETE that fails on the second copy leaves it claimed, and the first released", async () => {
        transforms.migrate = twice([A, B]);
        let port;
        port = legacyPort({
          intercept: (op, target) => {
            if (op === "head" && target === url(follow())) port.store.delete(target);
            if (op === "delete" && target === url(B.slice(1))) throw refusal(400, "refused");
          },
        });
        const report = await runMigration({ owner, port, sleep: noSleep });
        assert.deepStrictEqual(report.skipped.io_error, [follow()]);
        assert.ok(!port.store.has(url(A.slice(1))));
        assert.ok(port.store.has(url(B.slice(1))));
      });
    });

    describe("objects folding to one key", () => {
      // Every 0.x tag of the tree made to write one 1.x tag, as two spellings of a target do
      const real = transforms.migrate;
      const T = "/pub/social/v1/tags/0000000000000000000000000G.json";
      const B = `/priv/social/v1/mutes/${owner}.json`;
      const fold = (extra = () => []) => {
        transforms.migrate = (run, v0, bytes) => {
          const result = real(run, v0, bytes);
          if (!v0.includes("/tags/") || !("writes" in result)) return result;
          const [write] = result.writes;
          const at = (path) => ({ ...write, meta: { ...write.meta, path, url: url(path.slice(1)) } });
          return { ...result, writes: [at(T), ...extra(v0).map(at)] };
        };
      };
      const putsTo = (port, path) => port.calls.filter((c) => c.op.startsWith("put") && c.url === url(path.slice(1))).length;
      const tags = [...rows.keys()].filter((p) => p.includes("/tags/") && "writes" in rows.get(p).expected);
      afterEach(() => {
        transforms.migrate = real;
      });

      it("one object copies, every other finds it present, and nothing is PUT twice", async () => {
        fold();
        const port = legacyPort();
        const report = await runMigration({ owner, port });
        assert.strictEqual(putsTo(port, T), 1);
        assert.ok(report.counts.already_present >= tags.length - 1);
      });

      it("a copy found written elsewhere counts as present for every object after it", async () => {
        fold();
        let port;
        port = legacyPort({
          intercept: (op, target) => {
            if (op === "putJson" && target === url(T.slice(1))) port.store.set(target, encoder.encode('{"theirs":1}'));
          },
        });
        await runMigration({ owner, port });
        assert.strictEqual(putsTo(port, T), 1);
        assert.deepStrictEqual(decoder.decode(port.store.get(url(T.slice(1)))), '{"theirs":1}');
      });

      it("a refused copy leaves the key to the next object, which copies it", async () => {
        fold();
        let refused = false;
        const port = legacyPort({
          intercept: (op, target) => {
            if (op === "putJson" && target === url(T.slice(1)) && !refused) {
              refused = true;
              throw refusal(400, "refused");
            }
          },
        });
        const report = await runMigration({ owner, port });
        assert.strictEqual(putsTo(port, T), 2);
        assert.strictEqual(report.counts.put_rejected, 1);
        assert.ok(port.store.has(url(T.slice(1))));
      });

      it("a copy that landed beside a refused one stays claimed", async () => {
        const first = tags[0];
        fold((v0) => (v0.endsWith(first) ? [B] : []));
        const port = legacyPort({
          intercept: (op, target) => {
            if (op === "putJson" && target === url(B.slice(1))) throw refusal(400, "refused");
          },
        });
        await runMigration({ owner, port });
        assert.strictEqual(putsTo(port, T), 1);
      });

      // The source of the first object to reach its re-check goes, so its copies are undone
      const firstRecheckDeletes = (port) => {
        let done = false;
        return (op, target) => {
          if (!done && op === "head" && target.startsWith(url("pub/pubky.app/tags/"))) {
            done = true;
            port.store.delete(target);
          }
        };
      };

      it("a cleanup that deletes the first copy and fails on the second releases only the first", async () => {
        fold(() => [B]);
        let port;
        let recheck;
        port = legacyPort({
          intercept: (op, target) => {
            recheck(op, target);
            if (op === "delete" && target === url(B.slice(1))) throw refusal(400, "refused");
          },
        });
        recheck = firstRecheckDeletes(port);
        await runMigration({ owner, port, sleep: noSleep });
        // The first copy went with its source and a later object made it again; the second stayed claimed
        assert.strictEqual(putsTo(port, T), 2);
        assert.strictEqual(putsTo(port, B), 1);
        assert.ok(port.store.has(url(T.slice(1))) && port.store.has(url(B.slice(1))));
      });

      it("a copy deleted with its source frees the key for the next object", async () => {
        fold();
        let port;
        let recheck;
        port = legacyPort({ intercept: (op, target) => recheck(op, target) });
        recheck = firstRecheckDeletes(port);
        await runMigration({ owner, port });
        assert.strictEqual(putsTo(port, T), 2);
        assert.ok(port.store.has(url(T.slice(1))));
      });
    });

    it("a read-back or a cleanup DELETE answering not_found is a copy already gone", async () => {
      for (const failing of ["get", "delete"]) {
        let port;
        let destination;
        port = legacyPort({
          intercept: (op, target) => {
            if (op === "putJson" && target.includes("/pub/social/v1/follows/")) destination = target;
            if (op === "head" && target === url(follow())) port.store.delete(target);
            if (op === failing && target === destination) {
              port.store.delete(target);
              throw new MigrationPortError("not_found", "gone", 404);
            }
          },
        });
        const report = await runMigration({ owner, port });
        assert.deepStrictEqual(report.skipped.deleted_mid_run, [follow()], failing);
        assert.strictEqual(report.counts.io_error, 0, failing);
      }
    });

    it("a blob whose read-back finds nothing deletes nothing", async () => {
      const blob = [...rows.keys()].find((p) => p.includes("/blobs/"));
      const hash = blob.split("/").at(-1);
      let port;
      port = legacyPort({
        intercept: (op, target) => {
          if (op === "head" && target === url(blob)) port.store.delete(target);
          if (op === "get" && target.includes(`/files/${hash}.`)) port.store.delete(target);
        },
      });
      const report = await runMigration({ owner, port });
      assert.ok(report.skipped.deleted_mid_run.includes(blob));
      assert.ok(!port.calls.some((c) => c.op === "delete"));
    });

    it("caps split over several scopes cover what one scope would", async () => {
      const split = ["/pub/social/v1/:r", "/pub/social/v1/:w", "/priv/social/v1/:r,/priv/social/v1/:w"];
      assert.strictEqual((await runMigration({ owner, port: legacyPort(), caps: split })).status, "done");
      const report = await runMigration({ owner, port: legacyPort(), caps: ["/pub/social/v1/:r", "/priv/social/v1/:rw"] });
      assert.strictEqual(report.error?.code, "CAPS_MISSING");
    });

    it("refuses a mode it does not know", async () => {
      await assert.rejects(runMigration({ owner, port: legacyPort(), mode: "Dry" }), /mode must be "run" or "dry"/);
    });

    it("a blob never enters the wasm: a 20 MB one lands where migrate() puts it, and migrate() never sees a blob", async () => {
      const real = transforms.migrate;
      const seen = [];
      transforms.migrate = (handle, path, bytes) => {
        seen.push(path);
        return real(handle, path, bytes);
      };

      const big = new Uint8Array(randomBytes(20 * 1024 * 1024));
      const hash = transforms.mediaId(big);
      const blobPath = `pub/pubky.app/blobs/${hash}`;
      const filePath = "pub/pubky.app/files/0033000000010";
      const file = encoder.encode(
        JSON.stringify({ name: "big.png", created_at: 1727740800000000, src: url(blobPath), content_type: "image/png", size: big.length }),
      );
      const port = legacyPort();
      port.store.set(url(filePath), file);
      port.store.set(url(blobPath), big);
      const report = await runMigration({ owner, port }).finally(() => (transforms.migrate = real));

      assert.strictEqual(report.status, "done");
      assert.deepStrictEqual(nonZero(report.counts), { ...expectedCounts(), written: expectedCounts().written + 1 });
      assert.ok(seen.length > 0 && seen.every((p) => !p.includes("/pub/pubky.app/blobs/")), "migrate() saw a blob");
      // Where the transform puts the bytes it is handed
      const run = createMigration(owner);
      migrate(run, filePath, file);
      const [write] = migrate(run, blobPath, big).writes;
      run.free();
      assert.strictEqual(write.meta.url, url(`pub/social/v1/files/${hash}.png`));
      assert.deepStrictEqual(port.store.get(write.meta.url), big);
      // The vector tree around it migrates as it does alone
      const alone = legacyPort();
      await runMigration({ owner, port: alone });
      const rest = tree(port);
      [filePath, blobPath].forEach((p) => rest.delete(url(p)));
      rest.delete(write.meta.url);
      assert.deepStrictEqual(rest, tree(alone));
    });

  });
});
