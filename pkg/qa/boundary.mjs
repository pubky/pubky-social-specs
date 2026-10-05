// Hostile arguments at the wasm boundary: every export of the package entry and of the
// migration subpath, one argument slot at a time replaced by a value no caller should pass.
// Each call must return, or throw an Error whose message starts with "Validation Error:";
// never a wasm trap, never a hang, and the instance must still answer a known call the same
// way afterwards.
//
//   node --max-old-space-size=1536 qa/boundary.mjs [--out file.json]

import vm from "node:vm";
import fs from "node:fs";
import { createRequire } from "node:module";

// Keep the instance, so its memory can be sampled
const instantiate = WebAssembly.instantiate;
let instance;
WebAssembly.instantiate = async (...args) => {
  const result = await instantiate.apply(WebAssembly, args);
  instance ??= result.instance ?? result;
  return result;
};

const api = await import("../index.js");
const migration = await import("../migration/index.js");
const require = createRequire(import.meta.url);
const cjs = require("../index.cjs");
const { corpus } = await import("../migration.fixture.js");

await api.init();
await cjs.init();
const memory = () => instance?.exports?.memory?.buffer?.byteLength ?? 0;

const owner = corpus.owner;
const other = "pxnu33x7jtpx9ar1ytsi4yxbp6a5o36gwhffs8zoxmbuptici1jy";
const encoder = new TextEncoder();

// ---- known good calls ----

const post = api.createPost(owner, { content: "hello" });
const version = api.createVersion(owner, post.object, { root: "private", slug: "draft" });
const publish = api.planPublish(owner, version.id, version.editId, post.object);
const edit = api.editVersion(owner, post.object, { id: version.id, head: version.editId, root: "private" });
const feed = api.createFeed(owner, { reach: "all", layout: "columns", sort: "recent", name: "Feed", icon: "star" });
const postRef = api.postUriBuilder(owner, post.meta.id);
const fileBytes = new Uint8Array([1, 2, 3, 4, 5]);
const file = api.createFile(owner, fileBytes, "image/png");
const bookmark = api.createBookmark(owner, `pubky://${other}/pub/social/v1/profile.json`);
const vectorPost = corpus.vectors.find((v) => v.input.path.startsWith("pub/pubky.app/posts/") && v.expected.writes?.length);
const vectorBytes = encoder.encode("raw" in vectorPost.input ? vectorPost.input.raw : JSON.stringify(vectorPost.input.body));

const sanity = () => {
  const run = api.createMigration(owner);
  try {
    const out = JSON.stringify(api.migrate(run, vectorPost.input.path, vectorBytes));
    api.validate(post.meta.url, post.object);
    const h = api.hasherNew();
    api.hasherUpdate(h, fileBytes);
    return `${out}|${api.hasherFinish(h)}|${api.parseUri(post.meta.url).resource.id}`;
  } finally {
    run.free();
  }
};
const expected = sanity();

const freshRun = () => api.createMigration(owner);
const freshHasher = () => api.hasherNew();

// Each export with the arguments of one call that succeeds; a function gives fresh ones
const CALLS = {
  parseUri: () => [post.meta.url],
  stableId: () => ["pub/pubky.app/posts/0033SSE3B1FQ0"],
  resolveDeref: () => ["0033000000002", `pubky://${owner}/pub/pubky.app/blobs/AKSZ57W2RFKHV1EHK007FQQ8TW`],
  readObject: () => [post.meta.url, encoder.encode(JSON.stringify(post.object))],
  validate: () => [post.meta.url, post.object],
  createUser: () => [owner, { name: "Alice", bio: "x" }],
  createPost: () => [owner, { content: "hi" }],
  createArticlePost: () => [owner, { title: "t", body: "b" }],
  createCollectionPost: () => [owner, { name: "c" }],
  createVersion: () => [owner, post.object, { root: "private", slug: "x" }],
  editVersion: () => [owner, post.object, { id: version.id, head: version.editId, root: "private" }],
  planPublish: () => [owner, version.id, version.editId, post.object],
  planUnpublish: () => [version.id, [publish.destPath], [], edit.path],
  planDelete: () => [owner, version.id, [], [{ root: "private", path: version.path }, { root: "public", path: publish.destPath }], [post.object]],
  createFeed: () => [owner, { reach: "all", layout: "columns", sort: "recent", name: "n", icon: "star" }],
  feedId: () => [feed.object],
  feedPaths: () => [feed.meta.id],
  feedLifecycle: () => [feed.meta.id],
  createTag: () => [owner, postRef, "label"],
  createBookmark: () => [owner, postRef],
  bookmarkFilename: () => [postRef],
  bookmarkTarget: () => [bookmark.meta.id, null],
  createFollow: () => [owner, other],
  createMute: () => [owner, other],
  createFile: () => [owner, fileBytes, "image/png"],
  hasherNew: () => [],
  hasherUpdate: () => [freshHasher(), fileBytes],
  hasherFinish: () => [freshHasher()],
  mimeToExt: () => ["image/png"],
  essence: () => ["image/png"],
  deletionPaths: () => [{ kind: "post", id: post.meta.id, listings: [] }],
  listPrefix: () => [owner, "public"],
  legacyListPrefix: () => [owner],
  userUriBuilder: () => [owner],
  postUriBuilder: () => [owner, post.meta.id],
  followUriBuilder: () => [owner, other],
  muteUriBuilder: () => [owner, other],
  bookmarkUriBuilder: () => [owner, bookmark.meta.id],
  tagUriBuilder: () => [owner, "8Z8CWH8NVYQY39ZEBFGKQWWEKG"],
  fileUriBuilder: () => [owner, file.meta.path.split("/").pop()],
  feedUriBuilder: () => [owner, feed.meta.id],
  createMigration: () => [owner],
  migrate: () => [freshRun(), vectorPost.input.path, vectorBytes],
  migrateBlob: () => [freshRun(), `pub/pubky.app/blobs/${file.meta.id}`, fileBytes.length, file.meta.id],
};
const exported = Object.entries(api).filter(([, v]) => typeof v === "function" && !/^[A-Z]/.test(v.name || "") && v !== api.init);
const missing = exported.map(([n]) => n).filter((n) => !(n in CALLS) && n !== "init");
if (missing.length) throw new Error(`no known call for ${missing.join(", ")}`);
for (const [name, args] of Object.entries(CALLS)) {
  try {
    api[name](...args());
  } catch (e) {
    throw new Error(`the known good call of ${name} fails: ${e.message}`);
  }
}

// ---- hostile values ----

const deep = (depth, leaf) => {
  let v = leaf;
  for (let i = 0; i < depth; i++) v = { a: v };
  return v;
};
const deepArray = (depth) => {
  let v = [];
  for (let i = 0; i < depth; i++) v = [v];
  return v;
};
const realm = vm.runInNewContext(`({
  object: { name: "x", content: "y" },
  array: ["a", "b"],
  bytes: new Uint8Array([1, 2, 3]),
  string: new String("x"),
})`);
const detached = () => {
  const buffer = new ArrayBuffer(16);
  const view = new Uint8Array(buffer);
  structuredClone(buffer, { transfer: [buffer] });
  return view;
};
const lyingBytes = () => {
  class Liar extends Uint8Array {
    get length() {
      return 1 << 24;
    }
  }
  return new Liar(4);
};
const throwingProxy = (target) =>
  new Proxy(target, {
    get(t, k) {
      if (k === Symbol.toPrimitive || k === "toJSON" || typeof k === "string") throw new Error("trap get");
      return Reflect.get(t, k);
    },
    ownKeys() {
      throw new Error("trap ownKeys");
    },
    getOwnPropertyDescriptor() {
      throw new Error("trap gOPD");
    },
  });
/** An array of strings for the type check, and something else when the glue reads it. */
const shapeShifter = () => {
  let reads = 0;
  return new Proxy(["a", "b"], {
    get(t, k, r) {
      if (k === "0" || k === "1") return ++reads > 4 ? { not: "a string" } : t[k];
      return Reflect.get(t, k, r);
    },
  });
};
const forged = (Class, ptr) => Object.assign(Object.create(Class.prototype), { __wbg_ptr: ptr });
const freedPtr = (make) => {
  const handle = make();
  const ptr = handle.__wbg_ptr;
  handle.free();
  return ptr;
};

const HUGE = "a".repeat(10 * 1024 * 1024);
const HOSTILE = [
  ["undefined", () => undefined],
  ["null", () => null],
  ["empty string", () => ""],
  ["NUL string", () => "\u0000"],
  ["10 MB string", () => HUGE],
  ["10 MB owner-prefixed", () => `${owner}/${HUGE}`],
  ["lone high surrogate", () => "a\uD800b"],
  ["lone low surrogate", () => "\uDFFF"],
  ["String object", () => new String("x")],
  ["other-realm String", () => realm.string],
  ["number -1", () => -1],
  ["NaN", () => NaN],
  ["Infinity", () => Infinity],
  ["-0", () => -0],
  ["1.5", () => 1.5],
  ["2^53", () => 2 ** 53],
  ["2^64", () => 2 ** 64],
  ["BigInt", () => 10n],
  ["Symbol", () => Symbol("s")],
  ["function", () => () => 1],
  ["Date", () => new Date(0)],
  ["Map", () => new Map([["a", 1]])],
  ["Promise", () => Promise.resolve(1)],
  ["empty object", () => ({})],
  ["object with BigInt member", () => ({ content: 1n })],
  ["object with Symbol member", () => ({ content: Symbol("x") })],
  ["object with lone surrogate", () => ({ content: "\uD800", name: "\uD800" })],
  ["object with 10 MB member", () => ({ content: HUGE, name: HUGE, title: "t", body: HUGE })],
  ["object depth 10k", () => deep(10_000, "x")],
  ["array depth 10k", () => deepArray(10_000)],
  ["__proto__ member", () => JSON.parse('{"__proto__": {"content": "x"}, "content": "y"}')],
  ["constructor member", () => ({ constructor: { prototype: { polluted: true } }, content: "y" })],
  ["null prototype object", () => Object.assign(Object.create(null), { content: "x", name: "Alice" })],
  ["other-realm object", () => realm.object],
  ["toJSON that throws", () => ({ toJSON() { throw new Error("toJSON says no"); } })],
  ["toJSON returning a string", () => ({ toJSON: () => "x" })],
  ["self-referencing object", () => { const o = { a: 1 }; o.self = o; return o; }],
  ["Proxy with throwing traps", () => throwingProxy({ content: "x" })],
  ["Proxy over an array, throwing", () => throwingProxy(["a"])],
  ["getter that throws", () => Object.defineProperty({}, "content", { enumerable: true, get() { throw new Error("getter"); } })],
  ["sparse array", () => [, , "x"]], // eslint-disable-line no-sparse-arrays
  ["holey array 1e6", () => new Array(1e6)],
  ["array of 1e5 strings", () => Array.from({ length: 1e5 }, (_, i) => `s${i}`)],
  ["array with a number", () => ["a", 1]],
  ["other-realm array", () => realm.array],
  ["shape-shifting array", shapeShifter],
  ["Uint8Array odd subarray", () => new Uint8Array(new ArrayBuffer(64), 3, 7)],
  ["Uint8Array empty", () => new Uint8Array(0)],
  ["Uint8Array 10 MB", () => new Uint8Array(10 * 1024 * 1024)],
  ["Uint8ClampedArray", () => new Uint8ClampedArray([1, 2])],
  ["Int8Array", () => new Int8Array([1, -2])],
  ["Uint16Array", () => new Uint16Array([1, 2])],
  ["DataView", () => new DataView(new ArrayBuffer(4))],
  ["ArrayBuffer", () => new ArrayBuffer(4)],
  ["Buffer", () => Buffer.from("abc")],
  ["detached Uint8Array", detached],
  ["Uint8Array with a lying length", lyingBytes],
  ["other-realm Uint8Array", () => realm.bytes],
  ["Proxy over a Uint8Array", () => new Proxy(new Uint8Array([1, 2]), {})],
  ["plain array of bytes", () => [1, 2, 3]],
  ["freed Migration", () => { const m = api.createMigration(owner); m.free(); return m; }],
  ["CommonJS Migration", () => cjs.createMigration(owner)],
  ["Hasher in a Migration slot", () => api.hasherNew()],
  ["finished Hasher", () => { const h = api.hasherNew(); api.hasherFinish(h); return h; }],
  ["CommonJS Hasher", () => cjs.hasherNew()],
  ["forged Migration, wild pointer", () => forged(api.Migration, 0x7ff0)],
  ["forged Hasher, wild pointer", () => forged(api.Hasher, 0x7ff0)],
  ["forged Migration, freed pointer", () => forged(api.Migration, freedPtr(() => api.createMigration(owner)))],
  ["forged Hasher, freed pointer", () => forged(api.Hasher, freedPtr(() => api.hasherNew()))],
];

// ---- running them ----

const classify = (error) => {
  if (error instanceof WebAssembly.RuntimeError) return "trap";
  if (!(error instanceof Error)) return "non-Error";
  if (error.message.startsWith("Validation Error:")) return "validation";
  return "other";
};

const progress = fs.openSync("/tmp/claude-1000/-home-crypt-pubky-everything-dump/cb0562ab-f913-4786-b301-ef2e07e84f6e/scratchpad/boundary.progress", "w");
const results = { calls: 0, returned: 0, validation: 0, other: [], trap: [], nonError: [], broken: [], slow: [], memory: [] };
let peak = memory();
const baselineMemory = peak;
const otherKey = new Map();

const record = (name, slot, label, outcome, error, ms) => {
  results.calls++;
  if (ms > 2000) results.slow.push({ name, slot, label, ms: Math.round(ms) });
  if (outcome === "returned") return void results.returned++;
  if (outcome === "validation") return void results.validation++;
  const message = String(error?.message ?? error).slice(0, 160);
  const entry = { name, slot, label, type: error?.constructor?.name ?? typeof error, message };
  if (outcome === "trap") results.trap.push(entry);
  else if (outcome === "non-Error") results.nonError.push(entry);
  else {
    // One row per function, label and message
    const key = `${name}|${label}|${entry.type}|${message.replace(/\d+/g, "N")}`;
    if (!otherKey.has(key)) {
      otherKey.set(key, entry);
      results.other.push(entry);
    }
  }
};

const call = (name, args, slot, label) => {
  fs.writeSync(progress, `${name} slot ${slot} ${label}\n`);
  const t0 = performance.now();
  let outcome = "returned";
  let error;
  try {
    const out = api[name](...args);
    if (out instanceof Promise) outcome = "returned-promise";
  } catch (e) {
    error = e;
    outcome = classify(e);
  }
  record(name, slot, label, outcome, error, performance.now() - t0);
  let after;
  try {
    after = sanity();
  } catch (e) {
    after = `threw ${e?.message}`;
  }
  if (after !== expected) {
    results.broken.push({ name, slot, label, after: String(after).slice(0, 200) });
    return false;
  }
  const now = memory();
  if (now > peak) {
    results.memory.push({ name, slot, label, bytes: now });
    peak = now;
  }
  return true;
};

const started = performance.now();
outer: for (const [name, make] of Object.entries(CALLS)) {
  const arity = make().length;
  for (let slot = 0; slot < Math.max(arity, 1); slot++) {
    for (const [label, value] of HOSTILE) {
      const args = make();
      args[slot] = value();
      if (!call(name, args, slot, label)) break outer;
    }
  }
  // One argument too many, and every slot hostile at once
  if (!call(name, [...make(), "extra"], arity, "extra argument")) break;
  for (const [label, value] of HOSTILE.filter(([l]) => !/10 MB|1e6|1e5/.test(l))) {
    if (!call(name, make().map(() => value()), -1, `${label} in every slot`)) break outer;
  }
}

// ---- the migration subpath ----

const runResults = [];
const settle = async (label, options, timeoutMs = 30_000) => {
  const t0 = performance.now();
  try {
    let timer;
    const report = await Promise.race([
      migration.runMigration(options),
      new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("hang")), timeoutMs))),
    ]).finally(() => clearTimeout(timer));
    runResults.push({ label, outcome: `resolved ${report.status}${report.error ? ` ${report.error.code}` : ""}`, ms: Math.round(performance.now() - t0) });
  } catch (e) {
    runResults.push({ label, outcome: `rejected ${e?.constructor?.name}: ${String(e?.message).slice(0, 160)}`, ms: Math.round(performance.now() - t0) });
  }
  const after = sanity();
  if (after !== expected) results.broken.push({ name: "runMigration", label, after: after.slice(0, 200) });
};
const memPort = () => new migration.MemoryPort();
await settle("owner 10 MB string", { owner: HUGE, port: memPort() });
await settle("owner lone surrogate", { owner: `${owner.slice(0, 51)}\uD800`, port: memPort() });
await settle("owner number", { owner: 1, port: memPort() });
await settle("no port", { owner });
await settle("port of throwing Proxies", { owner, port: throwingProxy({}) });
await settle("port whose calls never resolve", { owner, port: { head: () => new Promise(() => {}), list: () => new Promise(() => {}) } }, 3000);
await settle("port answering garbage", { owner, port: { head: async () => "yes", get: async () => 42, list: async () => ({ urls: "x" }), putJson: async () => {}, putBytes: async () => {}, delete: async () => {} } });
await settle("port LIST page of non-strings", { owner, port: { head: async () => false, list: async () => ({ urls: [1, {}, null] }) } });
// The LIST loop never yields to a timer, so the guard is a call budget, not a timeout
let cycleCalls = 0;
const budget = () => {
  if (++cycleCalls > 100_000) throw new migration.MigrationPortError("rejected", "call budget spent");
};
await settle("port LIST with a cycle cursor, 1e5 call budget", { owner, port: { head: async () => false, list: async (_p, c) => (budget(), { urls: [], next: c === "a" ? "b" : "a" }) } });
runResults.at(-1).listCalls = cycleCalls;
await settle("mode BigInt", { owner, port: memPort(), mode: 1n });
await settle("caps object", { owner, port: memPort(), caps: { toString: () => "/:rw" } });
await settle("caps 1e5 scopes", { owner, port: memPort(), caps: Array.from({ length: 1e5 }, (_, i) => `/p${i}/:rw`) });
await settle("onProgress that throws", { owner, port: memPort(), onProgress: () => { throw new Error("ui crashed"); } });
await settle("signal already aborted", { owner, port: memPort(), signal: AbortSignal.abort() });
await settle("lock that throws", { owner, port: memPort(), lock: () => { throw new Error("lock"); } });
await settle("sleep that never resolves", { owner, port: { head: async () => { throw new migration.MigrationPortError("rate_limited"); } }, sleep: () => new Promise(() => {}) }, 3000);
const subpath = [];
for (const [label, value] of HOSTILE.filter(([l]) => !/10 MB|1e6|1e5/.test(l))) {
  for (const [name, fn] of [["refusal", (v) => migration.refusal(v)], ["bucketOf", (v) => migration.bucketOf(v)], ["MigrationPortError", (v) => new migration.MigrationPortError(v)]]) {
    try {
      fn(value());
    } catch (e) {
      subpath.push({ name, label, type: e?.constructor?.name, message: String(e?.message).slice(0, 120) });
    }
  }
}

const summary = {
  ms: Math.round(performance.now() - started),
  functions: Object.keys(CALLS).length,
  hostileValues: HOSTILE.length,
  calls: results.calls,
  returned: results.returned,
  validationErrors: results.validation,
  otherErrors: results.other,
  traps: results.trap,
  nonErrors: results.nonError,
  instanceBroken: results.broken,
  slowCalls: results.slow,
  wasmMemory: { baseline: baselineMemory, peak, growth: results.memory },
  rssMb: Math.round(process.memoryUsage().rss / 1e6),
  runMigration: runResults,
  subpathThrows: subpath,
};
if (process.argv.includes("--out")) fs.writeFileSync(process.argv[process.argv.indexOf("--out") + 1], JSON.stringify(summary, null, 1));
console.log(JSON.stringify({ ...summary, otherErrors: summary.otherErrors.length, subpathThrows: subpath.length }, null, 1));
