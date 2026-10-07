// Hostile arguments: every export of the entry, one argument slot at a time replaced by a
// value no caller should pass. Each call must return, or throw a ValidationError or a
// TypeError, promptly, and leave the package answering a known call as before. The one other
// thing allowed out is an error the hostile value itself raised (a getter, a proxy trap).
//
//   node --expose-gc --max-old-space-size=1536 qa/boundary.mjs [--out file.json]

import fs from "node:fs";
import vm from "node:vm";
import * as api from "../dist/index.js";
import { setClock } from "../dist/testing.js";

const OWNER = "8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo";
const OTHER = "pxnu33x7jtpx9ar1ytsi4yxbp6a5o36gwhffs8zoxmbuptici1jy";
setClock(() => 1_790_000_000_000);

class Mine extends Error {}
const mine = () => {
  throw new Mine("the value's own");
};

const detached = new Uint8Array(8);
structuredClone(detached.buffer, { transfer: [detached.buffer] });
class Liar extends Uint8Array {
  get length() {
    return 1 << 30;
  }
}
const cyclic = { name: "Alice" };
cyclic.self = cyclic;
cyclic.links = [cyclic];
const deep = JSON.parse("[".repeat(5000) + "]".repeat(5000));
const sparse = [];
sparse.length = 2 ** 32 - 1;

const hostile = () => [
  undefined, null, true, false, 0, -0, 1, -1, 1.5, NaN, Infinity, 2 ** 53, 1e308, 10n, Symbol("s"), Symbol.iterator,
  "", " ", "x", "\ud800", "a\udc00b", "__proto__", "constructor", "\u0000", "x".repeat(1 << 20), " ".repeat(3_000_000) + "x", "x" + " ".repeat(3_000_000) + "x",
  "[".repeat(200_000), `{"a":`.repeat(100_000), "pubky://" + OWNER + "/" + "a/".repeat(100_000),
  () => {}, mine, class {}, new Date(0), new Date(NaN), /x/g, new Error("e"), new Map([["name", "Alice"]]), new Set([1]), new WeakMap(), Promise.resolve(1),
  [], [undefined], [null], [[]], sparse, deep, Array(1000).fill("x"), Array(200_000).fill({ uri: "x" }), new Array(5).fill(cyclic),
  {}, cyclic, Object.create(null), Object.create({ name: "inherited", content: "inherited" }),
  { toJSON: () => ({ name: "Alice" }) }, { toJSON: mine }, { get name() { return mine(); } }, { get content() { return mine(); } },
  { __proto__: null, name: "Alice" }, JSON.parse('{"__proto__":{"name":"x"},"name":"Alice"}'),
  { name: { toString: () => "Alice" } }, { length: 3, 0: "a", 1: "b", 2: "c" }, { kind: "post" }, { kind: "__proto__" }, { kind: "file", root: "x" },
  { $unknown: "{" }, { $unknown: "[".repeat(100_000) }, { $unknown: '{"a":1e999}' }, { $unknown: 1 }, { name: "Alice", $unknown: '{"name":1}' },
  new Proxy({}, { get: mine }), new Proxy({}, { ownKeys: mine }), new Proxy({}, { has: mine }), new Proxy([], { get: mine }), new Proxy({ name: "Alice" }, {}),
  new Uint8Array(0), new Uint8Array([1, 2, 3]), new Uint8Array(1 << 20), new Uint16Array(4), new Float64Array(2), new DataView(new ArrayBuffer(4)), new ArrayBuffer(4),
  detached, new Liar(4), vm.runInNewContext("new Uint8Array([1,2,3])"), vm.runInNewContext("({ name: 'Alice' })"), vm.runInNewContext("['a']"), Buffer.from("abc"),
  globalThis, api, Object.prototype, Array.prototype,
];

// ---- a known good call of every export ----

const post = api.buildPost(OWNER, { content: "hello", root: "private", slug: "draft" });
const user = api.buildUser(OWNER, { name: "Alice" });
const feed = api.buildFeed(OWNER, { name: "Feed", icon: "star", reach: "all", layout: "columns", sort: "recent" });
const article = api.buildPost(OWNER, { kind: "article", title: "T", body: "B" });
const file = new Uint8Array([1, 2, 3, 4, 5]);
const fileAt = api.buildFile(OWNER, { bytes: file, type: "image/png" });
const hash = fileAt.id;

const calls = {
  decodeObject: [user.url, user.body],
  encodeObject: [user.url, user.object],
  decodeContent: [article.object],
  encodeContent: [api.decodeContent(article.object).content],
  buildUser: [OWNER, { name: "Alice", bio: "bio", links: [{ title: "t", url: "https://example.com" }] }],
  buildPost: [OWNER, { content: "hello", attachments: [{ uri: "https://example.com/a.png", name: "a" }] }],
  editPost: [post.url, post.object, { slug: "edited" }],
  buildFeed: [OWNER, { name: "Feed", icon: "star", reach: "all", layout: "columns", sort: "recent", tags: ["rust"] }],
  feedId: [feed.object],
  buildTag: [OWNER, api.buildUri(OTHER, "user"), "friend"],
  buildBookmark: [OWNER, api.buildUri(OTHER, "user")],
  buildFollow: [OWNER, OTHER],
  buildMute: [OWNER, OTHER],
  buildFile: [OWNER, { bytes: file, type: "image/png", root: "private" }],
  createMediaHasher: [],
  planPublish: [OWNER, { id: post.id, editId: post.editId, post: post.object }],
  planUnpublish: [{ id: post.id, publicPaths: [`/pub/social/v1/posts/${post.id}/${post.editId}.json`], legacyPaths: [], privateHead: post.path }],
  planDelete: [OWNER, { id: post.id, legacyPaths: [], copies: [{ root: "private", path: post.path }], versions: [post.object] }],
  deletionPaths: [{ kind: "file", id: hash, listings: [`/pub/social/v1/files/${hash}.png`, { path: `/pub/pubky.app/files/${post.id}`, src: `pubky://${OWNER}/pub/pubky.app/blobs/${hash}` }] }],
  parseUri: [post.url],
  buildUri: [OWNER, "post", post.id],
  listPrefix: [OWNER, "public"],
  toPath: [post.url],
  hashMedia: [new Blob([file])],
  parseOwner: [OWNER],
  parsePostId: [post.id],
  parseEditId: [post.editId],
  parseMediaId: [hash],
  parsePubkyUrl: [post.url],
  parseOwnerPath: [post.path],
  parsePostRef: [api.buildUri(OWNER, "post", post.id)],
};

const functions = Object.keys(api).filter((name) => typeof api[name] === "function" && name !== "ValidationError");
const missing = functions.filter((name) => !(name in calls));
if (missing.length) throw new Error(`no known call for ${missing.join(", ")}`);

// Every argument, and every member one level into an object argument, is a slot
function* variants(args) {
  for (let i = 0; i <= args.length; i++) {
    for (const value of hostile()) yield [`arg ${i + 1}`, args.map((a, j) => (j === i ? value : a)).concat(i === args.length ? [value] : [])];
    const arg = args[i];
    if (typeof arg !== "object" || arg === null || ArrayBuffer.isView(arg)) continue;
    for (const key of [...Object.keys(arg), "extra", "$unknown"]) {
      for (const value of hostile()) yield [`arg ${i + 1}.${key}`, args.map((a, j) => (j === i ? { ...arg, [key]: value } : a))];
    }
  }
}

const sanity = () => JSON.stringify([api.buildUser(OWNER, { name: "Alice" }).object, api.parseUri(post.url), api.decodeObject(user.url, user.body)]);
const before = sanity();
const report = { calls: 0, returned: 0, validation: 0, type: 0, own: 0, slowest: { ms: 0 }, violations: [] };
globalThis.gc?.();
const heap = process.memoryUsage().heapUsed;

for (const name of functions) {
  for (const [slot, args] of variants(calls[name])) {
    report.calls++;
    const started = performance.now();
    try {
      // Awaited, so a rejection of an async export is judged as a throw is
      const result = await api[name](...args);
      if (name === "createMediaHasher") {
        // The object it returns takes arguments too
        try {
          result.update(args[0]);
          result.id();
        } catch (e) {
          if (!(e instanceof TypeError) && !(e instanceof Mine)) throw e;
        }
      }
      report.returned++;
    } catch (e) {
      if (e instanceof api.ValidationError) report.validation++;
      else if (e instanceof TypeError) report.type++;
      else if (e instanceof Mine) report.own++;
      else report.violations.push({ name, slot, error: String(e?.stack ?? e).slice(0, 300) });
    }
    const ms = performance.now() - started;
    if (ms > report.slowest.ms) report.slowest = { ms: Math.round(ms), name, slot };
    if (ms > 5000) report.violations.push({ name, slot, error: `took ${Math.round(ms)} ms` });
    setClock(() => 1_790_000_000_000);
  }
}

if (sanity() !== before) report.violations.push({ name: "sanity", error: "a known call answers differently after the run" });
globalThis.gc?.();
report.heapGrowthMb = Math.round((process.memoryUsage().heapUsed - heap) / 1048576);
// Nothing is kept between calls, so a run of hostile megabytes leaves the heap where it was
if (globalThis.gc && report.heapGrowthMb > 16) report.violations.push({ name: "heap", error: `grew ${report.heapGrowthMb} MB` });

const out = process.argv.indexOf("--out");
if (out >= 0) fs.writeFileSync(process.argv[out + 1], JSON.stringify(report, null, 1));
console.log(JSON.stringify({ ...report, violations: report.violations.slice(0, 12), violationCount: report.violations.length }, null, 1));
process.exit(report.violations.length ? 1 : 0);
