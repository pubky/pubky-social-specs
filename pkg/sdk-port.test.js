import assert from "assert";
import { createRequire } from "node:module";
import { init } from "./index.js";
import { runMigration, MemoryPort } from "./migration/index.js";
import { sdkPort } from "./migration/adapters/pubky-sdk.js";
import { corpus, legacyTree, bytesOf } from "./migration.fixture.js";

const require = createRequire(import.meta.url);
const owner = corpus.owner;
const url = (path) => `pubky://${owner}/${path}`;
const encoder = new TextEncoder();

// What the SDK throws for a refused request: a RequestError carrying the status and the body
const answered = (status, body = "") =>
  Object.assign(new Error(`Request failed: Server responded with an error: ${status} - ${body}`), {
    name: "RequestError",
    data: { statusCode: status },
  });
// What the SDK throws before or without an HTTP answer
const named = (name, message) => Object.assign(new Error(message), { name });
const PRE_PRIV = "Writing to directories other than '/pub/' is forbidden";
const BOTH_ROOTS = "Writing to directories other than '/pub/' and '/priv/' is forbidden";

// `session.storage` over a map of URLs, answering as the SDK does (the `pubky.d.ts` of
// `@synonymdev/pubky` 0.11.0 and 0.14.0 declare the same calls): a LIST of a directory with
// nothing under it, a GET or a DELETE of a missing file throw 404, `exists` gives false
const fakeStorage = (store = new Map()) => {
  const calls = [];
  const full = (path) => `pubky://${owner}${path}`;
  const record = (op, ...args) => calls.push([op, ...args]);
  return {
    store,
    calls,
    async list(path, cursor, reverse, limit, shallow) {
      record("list", path, cursor, reverse, limit, shallow);
      const under = [...store.keys()].filter((u) => u.startsWith(full(path))).sort();
      if (under.length === 0) throw answered(404, "Directory Not Found");
      return under.filter((u) => cursor === null || u > cursor).slice(0, limit);
    },
    async getBytes(path) {
      record("getBytes", path);
      const bytes = store.get(full(path));
      if (bytes === undefined) throw answered(404, "Not Found");
      return bytes.slice();
    },
    async exists(path) {
      record("exists", path);
      return store.has(full(path));
    },
    async putJson(path, body) {
      record("putJson", path);
      store.set(full(path), encoder.encode(JSON.stringify(body)));
    },
    async putBytes(path, bytes) {
      record("putBytes", path);
      store.set(full(path), bytes.slice());
    },
    async delete(path) {
      record("delete", path);
      if (!store.delete(full(path))) throw answered(404, "Not Found");
    },
  };
};
const sessionOver = (storage, z32 = owner) => ({ info: { publicKey: { z32: () => z32 } }, storage });
// A storage whose every call throws `error`
const failing = (error) =>
  Object.fromEntries(
    ["list", "getBytes", "exists", "putJson", "putBytes", "delete"].map((op) => [op, async () => { throw error; }]),
  );

describe("pubky SDK port", () => {
  before(async () => {
    await init();
  });

  it("maps every refusal to the kind the engine branches on, with its status", async () => {
    const table = [
      [answered(507, "Insufficient Storage"), "quota", 507],
      [answered(429, "Too Many Requests"), "rate_limited", 429],
      [answered(401, "No authenticated session found"), "unauthorized", 401],
      [answered(403, "wrong tenant"), "unauthorized", 403],
      [answered(403, BOTH_ROOTS), "unauthorized", 403],
      [answered(403, PRE_PRIV), "unsupported", 403],
      [answered(404, "Not Found"), "not_found", 404],
      [answered(410, "Gone"), "not_found", 410],
      [answered(413, "Payload Too Large"), "rejected", 413],
      [answered(409, "File/folder path collision"), "rejected", 409],
      [answered(400, "Target path must be a file"), "rejected", 400],
      [answered(500, "Internal Server Error"), "network", 500],
      [answered(502, "Bad Gateway"), "network", 502],
      [answered(503, "Service Unavailable"), "network", 503],
      [answered(599), "network", 599],
      [answered(405, "Method Not Allowed"), "rejected", 405],
      [answered(412, "Precondition Failed"), "exists", 412],
      [named("RequestError", "Request failed: error sending request"), "network", undefined],
      [named("AuthenticationError", "grant expired"), "unauthorized", undefined],
      [named("InvalidInput", "pubky:// URLs are not supported"), "rejected", undefined],
      [named("ClientStateError", "session freed"), "rejected", undefined],
      [named("InternalError", "unexpected"), "rejected", undefined],
      [named("PkarrError", "no packet"), "network", undefined],
      [new TypeError("fetch failed"), "network", undefined],
      ["not even an Error", "network", undefined],
    ];
    for (const [error, kind, status] of table) {
      const port = sdkPort(sessionOver(failing(error)));
      for (const call of [
        () => port.putJson(url("pub/social/v1/a"), {}),
        () => port.putBytes(url("pub/social/v1/a"), new Uint8Array()),
        () => port.delete(url("pub/social/v1/a")),
      ]) {
        await assert.rejects(call(), (e) => {
          assert.strictEqual(e.name, "MigrationPortError");
          assert.strictEqual(e.kind, kind, error.message);
          assert.strictEqual(e.status, status);
          assert.strictEqual(e.message, error.message ?? error);
          return true;
        });
      }
    }
  });

  it("gets bytes, null for a 404 or a 410, and throws any other refusal", async () => {
    const storage = fakeStorage(new Map([[url("pub/pubky.app/a"), encoder.encode("x")]]));
    const port = sdkPort(sessionOver(storage));
    assert.deepStrictEqual(await port.get(url("pub/pubky.app/a")), encoder.encode("x"));
    assert.strictEqual(await port.get(url("pub/pubky.app/b")), null);
    assert.deepStrictEqual(storage.calls, [["getBytes", "/pub/pubky.app/a"], ["getBytes", "/pub/pubky.app/b"]]);
    assert.strictEqual(await sdkPort(sessionOver(failing(answered(410)))).get(url("pub/a")), null);
    await assert.rejects(sdkPort(sessionOver(failing(answered(401)))).get(url("pub/a")), { kind: "unauthorized" });
  });

  it("heads through exists; a refused HEAD reads its reason from a GET left unread, which tells a server without /priv/", async () => {
    const storage = fakeStorage(new Map([[url("pub/a"), new Uint8Array()]]));
    const port = sdkPort(sessionOver(storage));
    assert.strictEqual(await port.head(url("pub/a")), true);
    assert.strictEqual(await port.head(url("priv/social/v1/_migrated.json")), false);
    assert.deepStrictEqual(storage.calls, [["exists", "/pub/a"], ["exists", "/priv/social/v1/_migrated.json"]]);

    // A HEAD answer has no body, so its 403 alone cannot say why
    const headless = (get) =>
      sessionOver({
        exists: async () => { throw answered(403); },
        get,
        getBytes: async () => assert.fail("the retry downloads the object"),
      });
    const flag = url("priv/social/v1/_migrated.json");
    await assert.rejects(sdkPort(headless(async () => { throw answered(403, PRE_PRIV); })).head(flag), { kind: "unsupported", status: 403 });
    await assert.rejects(sdkPort(headless(async () => { throw answered(403, "missing capability"); })).head(flag), { kind: "unauthorized" });
    assert.strictEqual(await sdkPort(headless(async () => { throw answered(404); })).head(flag), false);
    let cancelled = 0;
    const response = { body: { cancel: async () => { cancelled++; } } };
    assert.strictEqual(await sdkPort(headless(async () => response)).head(flag), true);
    assert.strictEqual(cancelled, 1);
    assert.strictEqual(await sdkPort(headless(async () => ({ body: null }))).head(flag), true);
    await assert.rejects(sdkPort(sessionOver(failing(answered(401)))).head(flag), { kind: "unauthorized", status: 401 });
  });

  it("lists by the owner-relative directory: 404 is an empty page, and only an empty page ends the walk", async () => {
    const store = new Map();
    for (let i = 0; i < 5; i++) store.set(url(`pub/pubky.app/posts/${i}`), new Uint8Array());
    const storage = fakeStorage(store);
    const port = sdkPort(sessionOver(storage), { pageSize: 2 });
    const prefix = url("pub/pubky.app/");

    const first = await port.list(prefix);
    assert.deepStrictEqual(first, { urls: [url("pub/pubky.app/posts/0"), url("pub/pubky.app/posts/1")], next: url("pub/pubky.app/posts/1") });
    const second = await port.list(prefix, first.next);
    assert.deepStrictEqual(second.urls, [url("pub/pubky.app/posts/2"), url("pub/pubky.app/posts/3")]);
    const short = await port.list(prefix, second.next);
    assert.deepStrictEqual(short, { urls: [url("pub/pubky.app/posts/4")], next: url("pub/pubky.app/posts/4") });
    assert.deepStrictEqual(await port.list(prefix, short.next), { urls: [] });
    assert.deepStrictEqual(storage.calls[0], ["list", "/pub/pubky.app/", null, false, 2, false]);
    assert.deepStrictEqual(storage.calls[1], ["list", "/pub/pubky.app/", first.next, false, 2, false]);

    assert.deepStrictEqual(await port.list(url("pub/social/v1/")), { urls: [] });
    const whole = fakeStorage(store);
    assert.strictEqual((await sdkPort(sessionOver(whole)).list(prefix)).urls.length, 5);
    assert.strictEqual(whole.calls[0][4], 1000);
    await assert.rejects(sdkPort(sessionOver(failing(answered(429)))).list(prefix), { kind: "rate_limited" });
  });

  it("walks a directory whose size is a multiple of the page to its end, and past a server that caps the page lower", async () => {
    const store = new Map();
    for (let i = 0; i < 4; i++) store.set(url(`pub/pubky.app/posts/${i}`), new Uint8Array());
    const walk = async (storage, pageSize) => {
      const port = sdkPort(sessionOver(storage), { pageSize });
      const pages = [];
      let cursor;
      do {
        const page = await port.list(url("pub/pubky.app/"), cursor);
        pages.push(page.urls.length);
        cursor = page.next;
      } while (cursor);
      return pages;
    };
    assert.deepStrictEqual(await walk(fakeStorage(store), 2), [2, 2, 0]);
    // A proxy that answers one URL a page, whatever the limit asked
    const capped = fakeStorage(store);
    const list = capped.list;
    capped.list = async (...args) => (await list(...args)).slice(0, 1);
    assert.deepStrictEqual(await walk(capped, 1000), [1, 1, 1, 1, 0]);
  });

  it("refuses a URL outside the session owner's tree, or a LIST prefix that is not a directory, before any request", async () => {
    const storage = fakeStorage();
    const port = sdkPort(sessionOver(storage));
    const other = "pubky://pxnu33x7jtpx9ar1ytsi4yxbp6a5o36gwhffs8zoxmbuptici1jy/pub/pubky.app/posts/0034A0X7NJ52A";
    for (const call of [
      () => port.get(other),
      () => port.head(other),
      () => port.putJson(other, {}),
      () => port.putBytes(other, new Uint8Array()),
      () => port.delete(other),
      () => port.list("pubky://pxnu33x7jtpx9ar1ytsi4yxbp6a5o36gwhffs8zoxmbuptici1jy/pub/"),
      () => port.get(url("dav/x")),
      () => port.list(url("pub/pubky.app")),
    ]) {
      await assert.rejects(call(), { name: "MigrationPortError", kind: "rejected" });
    }
    assert.deepStrictEqual(storage.calls, []);
  });

  it("ifAbsent is a HEAD then the PUT, and throws exists without writing when something is there", async () => {
    const storage = fakeStorage(new Map([[url("pub/social/v1/a"), encoder.encode("{}")]]));
    const port = sdkPort(sessionOver(storage));
    await assert.rejects(port.putJson(url("pub/social/v1/a"), { b: 1 }, { ifAbsent: true }), { kind: "exists", status: undefined });
    await assert.rejects(port.putBytes(url("pub/social/v1/a"), new Uint8Array([1]), { ifAbsent: true }), { kind: "exists" });
    assert.deepStrictEqual(storage.store.get(url("pub/social/v1/a")), encoder.encode("{}"));
    await port.putBytes(url("pub/social/v1/b"), new Uint8Array([1]), { ifAbsent: true });
    await port.putJson(url("pub/social/v1/a"), { b: 1 });
    assert.deepStrictEqual(storage.calls.map(([op]) => op), ["exists", "exists", "exists", "putBytes", "putJson"]);
    assert.deepStrictEqual(storage.store.get(url("pub/social/v1/a")), encoder.encode('{"b":1}'));
  });

  it("a call that never answers counts network once the deadline passes, and the run goes on", async () => {
    const storage = fakeStorage();
    const stalled = { ...storage, getBytes: () => new Promise(() => {}) };
    const port = sdkPort(sessionOver(stalled), { deadlineMs: 20 });
    await assert.rejects(port.get(url("pub/pubky.app/profile.json")), (e) => e.kind === "network" && /20 ms/.test(e.message));
    // The deadline is per call: a quick one after a stalled one answers
    assert.strictEqual(await port.head(url("pub/pubky.app/nothing")), false);
    // A blob's GET grows with its size and a write must settle, so none of them has the deadline
    const later = (value) => () => new Promise((r) => setTimeout(() => r(value), 60));
    const slow = { ...storage, getBytes: later(new Uint8Array([1])), putBytes: later(), putJson: later(), delete: later() };
    const patient = sdkPort(sessionOver(slow), { deadlineMs: 20 });
    assert.deepStrictEqual(await patient.get(url("pub/pubky.app/blobs/VJAHM32NETJ12EWAAM11BQVX78")), new Uint8Array([1]));
    await patient.putBytes(url("pub/social/v1/files/VJAHM32NETJ12EWAAM11BQVX78.bin"), new Uint8Array([1]));
    await patient.putJson(url("pub/social/v1/follows/x.json"), {});
    await patient.delete(url("pub/social/v1/follows/x.json"));
    await assert.rejects(patient.get(url("pub/pubky.app/profile.json")), (e) => e.kind === "network");
    for (const deadlineMs of [0, -1, NaN, Infinity]) {
      assert.throws(() => sdkPort(sessionOver(storage), { deadlineMs }), RangeError);
    }
  });

  it("takes a page size from 1 to 1000", () => {
    for (const pageSize of [0, 1001, 2.5, NaN]) {
      assert.throws(() => sdkPort(sessionOver(fakeStorage()), { pageSize }), RangeError);
    }
  });

  it("runs the vector tree to the report and the tree a MemoryPort run gives, over many LIST pages", async () => {
    const memory = new MemoryPort();
    const storage = fakeStorage();
    for (const [path, row] of legacyTree()) {
      memory.store.set(url(path), bytesOf(row));
      storage.store.set(url(path), bytesOf(row));
    }
    const expected = await runMigration({ owner, port: memory });
    const report = await runMigration({ owner, port: sdkPort(sessionOver(storage), { pageSize: 3 }) });
    assert.strictEqual(report.status, "done");
    assert.ok(report.counts.written > 0);
    for (const key of ["status", "done", "total", "counts", "dropped", "droppedValues", "skipped"]) {
      assert.deepStrictEqual(report[key], expected[key], key);
    }
    const FLAG = url("priv/social/v1/_migrated.json");
    const withoutFlag = (store) => [...store].filter(([u]) => u !== FLAG).sort(([a], [b]) => (a < b ? -1 : 1));
    assert.deepStrictEqual(withoutFlag(storage.store), withoutFlag(memory.store));
    assert.ok(storage.calls.filter(([op]) => op === "list").length > legacyTree().size / 3);
    assert.strictEqual((await runMigration({ owner, port: sdkPort(sessionOver(storage)) })).status, "already_migrated");
  });

  it("under require() from Node, the CommonJS twin is the same adapter", async () => {
    const cjs = require("./migration/adapters/pubky-sdk.cjs");
    assert.deepStrictEqual(Object.keys(cjs), ["sdkPort"]);
    await assert.rejects(cjs.sdkPort(sessionOver(failing(answered(507)))).putJson(url("pub/social/v1/a"), {}), {
      name: "MigrationPortError",
      kind: "quota",
    });
  });
});
