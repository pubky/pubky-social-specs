// Throughput of the transforms through the wasm, of the blob door and its hash, and of a whole
// runMigration over a synthetic account, with the time split between wasm, port and engine.
//
//   node --max-old-space-size=1536 qa/bench.mjs [--out file.json] [--dump inputs.json]
//
// `--dump` writes the per-kind inputs, so tests/qa_transform_bench.rs times the same objects
// natively and the wasm overhead reads as the difference.

import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { corpus } from "../migration.fixture.js";
import { runMigration } from "../dist/migration/index.js";
import { init, transforms } from "../dist/migration/wasm.js";

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

// The engine calls the wasm through `transforms`, so timing wrappers on it see every call
await init();
const wasmTime = { ms: 0, calls: 0, by: {} };
const real = { ...transforms };
for (const name of Object.keys(real)) {
  transforms[name] = (...a) => {
    const t0 = performance.now();
    try {
      return real[name](...a);
    } finally {
      const ms = performance.now() - t0;
      wasmTime.ms += ms;
      wasmTime.calls++;
      const by = (wasmTime.by[name] ??= { ms: 0, calls: 0 });
      by.ms += ms;
      by.calls++;
    }
  };
}
const { createMigration, migrate, migrateBlob, mediaId } = real;

const owner = corpus.owner;
const url = (path) => `pubky://${owner}/${path}`;
const encoder = new TextEncoder();
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const tsid = (micros) => {
  const bits = BigInt(micros).toString(2).padStart(64, "0") + "0";
  let out = "";
  for (let i = 0; i < 65; i += 5) out += CROCKFORD[parseInt(bits.slice(i, i + 5), 2)];
  return out;
};
const ZBASE32 = "ybndrfg8ejkmcpqxot1uwisza345h769";
/** A pubky id: 52 z-base32 characters, the last carrying one bit. */
const pubky = (i) => {
  let s = "";
  let x = i * 2654435761 + 12345;
  for (let j = 0; j < 51; j++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    s += ZBASE32[x % 32];
  }
  return s + (i % 2 ? "o" : "y");
};
/** The crate's hash id: half a blake3, Crockford, as a media path spells it. */
const hashId = (text) => mediaId(encoder.encode(text));
const json = (body) => encoder.encode(JSON.stringify(body));
const BASE = 1_760_000_000_000_000;

// ---- inputs, one generator per kind ----

const blobOf = (size, seed) => {
  const bytes = new Uint8Array(size);
  for (let j = 0; j < size; j += 4096) bytes[j] = (seed * 31 + j) & 0xff;
  bytes[0] = seed & 0xff;
  bytes[size - 1] = (seed >> 8) & 0xff;
  return bytes;
};
const fileFor = (i, hash, size) => [
  `pub/pubky.app/files/${tsid(BASE + 500_000_000 + i)}`,
  json({ name: `photo ${i}.png`, created_at: BASE, src: url(`pub/pubky.app/blobs/${hash}`), content_type: "image/png", size }),
];
const postRef = (i) => url(`pub/pubky.app/posts/${tsid(BASE + i)}`);
const KINDS = {
  profile: () => ["pub/pubky.app/profile.json", json({ name: "Bench User", bio: "Benchmarks the migration", image: null, links: [{ title: "site", url: "https://example.com/me" }], status: "busy" })],
  post: (i) => [`pub/pubky.app/posts/${tsid(BASE + i)}`, json({ content: `Post number ${i}, with a little text in it.`, kind: "short", parent: i % 3 ? null : postRef(i + 1), embed: null, attachments: null })],
  post_long: (i) => [`pub/pubky.app/posts/${tsid(BASE + i)}`, json({ content: `Title ${i}\n${"Lorem ipsum dolor sit amet. ".repeat(70)}`, kind: "long", parent: null, embed: null, attachments: null })],
  post_media: (i) => [`pub/pubky.app/posts/${tsid(BASE + i)}`, json({ content: `Look ${i}`, kind: "image", parent: null, embed: null, attachments: [url(`pub/pubky.app/files/${tsid(BASE + 500_000_000)}`)] })],
  tag: (i) => {
    const uri = postRef(i % 5000);
    const label = `tag${Math.floor(i / 5000)}x${i % 7}`;
    return [`pub/pubky.app/tags/${hashId(`${uri}:${label}`)}`, json({ uri, label, created_at: BASE + i })];
  },
  follow: (i) => [`pub/pubky.app/follows/${pubky(i)}`, json({ created_at: BASE + i })],
  mute: (i) => [`pub/pubky.app/mutes/${pubky(i + 100000)}`, json({ created_at: BASE + i })],
  bookmark: (i) => [`pub/pubky.app/bookmarks/${hashId(postRef(i))}`, json({ uri: postRef(i), created_at: BASE + i })],
  feed: (i) => {
    const feed = { tags: [`topic${i}`], reach: "all", layout: "columns", sort: "recent", content: null };
    return [`pub/pubky.app/feeds/${hashId(JSON.stringify(feed))}`, json({ feed, name: `Feed ${i}`, icon: "star", created_at: BASE + i })];
  },
  file: (i) => fileFor(i, hashId(`blob ${i}`), 1024),
  blob_1k: (i) => {
    const bytes = blobOf(1024, i);
    return [`pub/pubky.app/blobs/${mediaId(bytes)}`, bytes];
  },
};

const out = { node: process.version, kinds: {}, blobs: [], engine: null };

// ---- 1. migrate() per kind ----

const N = 1000;
const dump = {};
for (const [kind, make] of Object.entries(KINDS)) {
  const inputs = Array.from({ length: N }, (_, i) => make(i));
  dump[kind] = inputs.map(([path, bytes]) => [path, Buffer.from(bytes).toString("base64")]);
  const run = createMigration(owner);
  const [filePath, fileBytes] = fileFor(0, hashId("blob 0"), 1024);
  migrate(run, filePath, fileBytes);
  let skipped = 0;
  for (const [path, bytes] of inputs.slice(0, 100)) migrate(run, path, bytes); // warm
  const t0 = performance.now();
  for (const [path, bytes] of inputs) {
    const r = migrate(run, path, bytes);
    if ("skip" in r) skipped++;
  }
  const ms = performance.now() - t0;
  run.free();
  const bytes = inputs.reduce((s, [, b]) => s + b.length, 0);
  out.kinds[kind] = { n: N, ms: +ms.toFixed(2), perSec: Math.round(N / (ms / 1000)), usPer: +((ms * 1000) / N).toFixed(1), avgBytes: Math.round(bytes / N), skipped };
}
if (flag("--dump")) fs.writeFileSync(flag("--dump"), JSON.stringify({ owner, file: fileFor(0, hashId("blob 0"), 1024).map((x, i) => (i ? Buffer.from(x).toString("base64") : x)), kinds: dump }));

// ---- 2. the blob door ----

const HASH_CHUNK = 4 * 1024 * 1024;
const hashOf = (bytes) => {
  return mediaId(bytes);
};
for (const size of [1024, 1 << 20, 16 << 20, 50 << 20]) {
  const bytes = new Uint8Array(randomBytes(size));
  const reps = size <= 1 << 20 ? 50 : 3;
  const run = createMigration(owner);
  const hash = hashOf(bytes);
  const path = `pub/pubky.app/blobs/${hash}`;
  migrate(run, ...fileFor(0, hash, size));
  let t0 = performance.now();
  for (let r = 0; r < reps; r++) {
    const id = hashOf(bytes);
    const res = migrateBlob(run, path, bytes.length, id);
    if ("skip" in res) throw new Error(`blob door skipped ${res.skip}`);
  }
  const doorMs = (performance.now() - t0) / reps;
  // The same bytes through migrate(), which copies them into the wasm
  let viaMigrateMs = null;
  if (size <= 16 << 20) {
    t0 = performance.now();
    for (let r = 0; r < reps; r++) migrate(run, path, bytes);
    viaMigrateMs = +((performance.now() - t0) / reps).toFixed(2);
  }
  run.free();
  out.blobs.push({ bytes: size, doorMs: +doorMs.toFixed(2), doorMBps: Math.round(size / 1e6 / (doorMs / 1000)), viaMigrateMs, rssMb: Math.round(process.memoryUsage().rss / 1e6) });
}

// ---- 3. runMigration over a synthetic account ----

/** A port over a Map that does its work synchronously, so its CPU time can be measured apart. */
class BenchPort {
  store = new Map();
  ms = 0;
  calls = 0;
  #sorted = null;
  #time(fn) {
    const t0 = performance.now();
    try {
      return Promise.resolve(fn());
    } catch (e) {
      return Promise.reject(e);
    } finally {
      this.ms += performance.now() - t0;
      this.calls++;
    }
  }
  #err(kind, status) {
    return Object.assign(new Error(kind), { name: "MigrationPortError", kind, status });
  }
  list(prefix, cursor) {
    return this.#time(() => {
      this.#sorted ??= [...this.store.keys()].sort();
      const all = this.#sorted;
      // The first key after the cursor, or the first at or after the prefix
      let lo = 0;
      let hi = all.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const before = cursor !== undefined ? all[mid] <= cursor : all[mid] < prefix;
        if (before) lo = mid + 1;
        else hi = mid;
      }
      const urls = [];
      for (let i = lo; i < all.length && urls.length < 1000 && all[i].startsWith(prefix); i++) urls.push(all[i]);
      const more = urls.length === 1000 && all[lo + 1000]?.startsWith(prefix);
      return more ? { urls, next: urls[urls.length - 1] } : { urls };
    });
  }
  get(u) {
    return this.#time(() => this.store.get(u) ?? null);
  }
  head(u) {
    return this.#time(() => this.store.has(u));
  }
  #put(u, bytes, options) {
    if (options?.ifAbsent && this.store.has(u)) throw this.#err("exists", 412);
    if (!this.store.has(u)) this.#sorted = null;
    this.store.set(u, bytes);
  }
  putJson(u, object, options) {
    return this.#time(() => this.#put(u, encoder.encode(JSON.stringify(object)), options));
  }
  putBytes(u, bytes, options) {
    return this.#time(() => this.#put(u, bytes, options));
  }
  delete(u) {
    return this.#time(() => {
      if (!this.store.delete(u)) throw this.#err("not_found", 404);
      this.#sorted = null;
    });
  }
}

const account = new BenchPort();
const counts = { posts: 5000, tags: 15000, follows: 500, blobs: 50 };
for (let i = 0; i < counts.blobs; i++) {
  const bytes = blobOf(1 << 20, i + 7);
  const hash = mediaId(bytes);
  account.store.set(url(`pub/pubky.app/blobs/${hash}`), bytes);
  const [path, body] = fileFor(i, hash, bytes.length);
  account.store.set(url(path), body);
}
for (let i = 0; i < counts.posts; i++) {
  const [path, body] = i % 10 === 0 ? KINDS.post_media(i) : i % 25 === 1 ? KINDS.post_long(i) : KINDS.post(i);
  account.store.set(url(path), body);
}
for (let i = 0; i < counts.tags; i++) {
  const [path, body] = KINDS.tag(i);
  account.store.set(url(path), body);
}
for (let i = 0; i < counts.follows; i++) {
  const [path, body] = KINDS.follow(i);
  account.store.set(url(path), body);
}
account.store.set(...((([p, b]) => [url(p), b])(KINDS.profile())));
const objects = [...account.store.keys()].length;
const storedBytes = [...account.store.values()].reduce((s, b) => s + b.length, 0);

global.gc?.();
wasmTime.ms = 0;
wasmTime.calls = 0;
wasmTime.by = {};
let peakRss = process.memoryUsage().rss;
let events = 0;
const cpu0 = process.cpuUsage();
const t0 = performance.now();
const report = await runMigration({
  owner,
  port: account,
  onProgress: () => {
    if (++events % 200 === 0) peakRss = Math.max(peakRss, process.memoryUsage().rss);
  },
});
const totalMs = performance.now() - t0;
const cpu = process.cpuUsage(cpu0);
peakRss = Math.max(peakRss, process.memoryUsage().rss);
const engineMs = totalMs - wasmTime.ms - account.ms;
out.engine = {
  account: { ...counts, profile: 1, files: counts.blobs, objects, storedMB: +(storedBytes / 1e6).toFixed(1) },
  status: report.status,
  counts: Object.fromEntries(Object.entries(report.counts).filter(([, n]) => n)),
  totalMs: Math.round(totalMs),
  objectsPerSec: Math.round(objects / (totalMs / 1000)),
  MBps: +(storedBytes / 1e6 / (totalMs / 1000)).toFixed(1),
  wasm: {
    ms: Math.round(wasmTime.ms),
    share: +(wasmTime.ms / totalMs).toFixed(3),
    calls: wasmTime.calls,
    by: Object.fromEntries(Object.entries(wasmTime.by).map(([k, v]) => [k, { ms: Math.round(v.ms), calls: v.calls, usPer: +((v.ms * 1000) / v.calls).toFixed(1) }])),
  },
  port: { ms: Math.round(account.ms), share: +(account.ms / totalMs).toFixed(3), calls: account.calls },
  engine: { ms: Math.round(engineMs), share: +(engineMs / totalMs).toFixed(3) },
  cpu: { userMs: Math.round(cpu.user / 1000), systemMs: Math.round(cpu.system / 1000) },
  peakRssMb: Math.round(peakRss / 1e6),
};
if (report.status !== "done") throw new Error(`the synthetic run ended ${report.status}`);

if (flag("--out")) fs.writeFileSync(flag("--out"), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
