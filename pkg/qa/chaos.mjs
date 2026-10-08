// Chaos harness for the migration engine: runMigration over a MemoryPort that fails, races and
// stalls by a seeded schedule, run again and again until it finishes, then checked against a
// fault-free run of the same tree.
//
//   node --max-old-space-size=1536 qa/chaos.mjs [--variant main|quota-rate|lost-response|any-kind|phantom-404]
//        [--seeds 1000] [--from 0] [--out file.json] [--no-minimize] [--seed N [--rate R] [--verbose] [--trace]]

import assert from "node:assert";
import { runMigration, MemoryPort, MigrationPortError, refusal, skipReasons } from "../dist/migration/index.js";
import { init, transforms } from "../dist/migration/wasm.js";
import { legacyTree, bytesOf, corpus } from "../migration.fixture.js";
import { flags, noSleep, sameBytes, timestampIdOf, writeOut, xorshift } from "./lib.mjs";

const { createMigration, migrate } = transforms;

const owner = corpus.owner;
const url = (path) => `pubky://${owner}/${path}`;
const rel = (u) => u.slice(`pubky://${owner}/`.length);
const LEGACY = url("pub/pubky.app/");
const FLAG = url("priv/social/v1/_migrated.json");
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const KNOWN_CODES = new Set(["ALREADY_RUNNING", "PRIV_UNSUPPORTED", "CAPS_MISSING", "QUOTA", "SESSION_EXPIRED", "IO_ERROR", "UNSUPPORTED_EPOCH", "ABORTED"]);
const RUN_TIMEOUT_MS = 60_000;
const MAX_RUNS = 30;

// ---- seeded randomness ----

const pick = (rand, items) => items[Math.floor(rand() * items.length)];
const int = (rand, lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

// ---- the tree ----

const baseRows = new Map([...legacyTree()].map(([path, row]) => [path, bytesOf(row)]));

/** The vectors' tree plus 2 to 5 blobs of 1 KB to 2 MB, each with its File object and a post. */
const buildTree = (seed) => {
  const rand = xorshift(seed * 7919 + 1);
  const tree = new Map(baseRows);
  const n = int(rand, 2, 5);
  const types = ["image/png", "image/jpeg", "application/pdf", "video/mp4", "text/plain"];
  for (let i = 0; i < n; i++) {
    // Log-uniform between 1 KB and 2 MB, so most seeds stay cheap
    const size = Math.round(1024 * Math.pow(2048, rand()));
    const bytes = new Uint8Array(size);
    for (let j = 0; j < size; j += 4096) bytes[j] = Math.floor(rand() * 256);
    bytes[0] = seed & 0xff;
    bytes[size - 1] = i;
    const type = pick(rand, types);
    const hash = transforms.mediaId(bytes);
    const micros = 1_740_000_000_000_000 + seed * 1_000_000 + i * 10;
    const fileId = timestampIdOf(micros);
    const postId = timestampIdOf(micros + 1);
    tree.set(`pub/pubky.app/blobs/${hash}`, bytes);
    tree.set(`pub/pubky.app/files/${fileId}`, encoder.encode(JSON.stringify({ name: `chaos ${i}.bin`, created_at: micros, src: url(`pub/pubky.app/blobs/${hash}`), content_type: type, size })));
    tree.set(
      `pub/pubky.app/posts/${postId}`,
      encoder.encode(JSON.stringify({ content: `chaos media ${i}`, kind: "image", parent: null, embed: null, attachments: [url(`pub/pubky.app/files/${fileId}`)] })),
    );
  }
  return tree;
};

/** Every write each 0.x path gives, from the transforms alone: path -> [{url, bytes}] or a skip. */
const expectedWrites = (tree) => {
  const run = createMigration(owner);
  const out = new Map();
  const files = [...tree].filter(([p]) => p.startsWith("pub/pubky.app/files/"));
  for (const [path, bytes] of files) {
    try {
      migrate(run, path, bytes);
    } catch {}
  }
  for (const [path, bytes] of tree) {
    if (path.startsWith("pub/pubky.app/files/")) continue;
    try {
      const result = migrate(run, path, bytes);
      out.set(
        path,
        "skip" in result
          ? { skip: result.skip }
          : {
              writes: result.writes.map((w) => ({
                url: w.meta.url,
                bytes: w.kind === "file" ? w.object.bytes : encoder.encode(JSON.stringify(w.object)),
              })),
            },
      );
    } catch {
      out.set(path, { skip: "invalid" });
    }
  }
  run.free();
  return out;
};

const portOf = (tree, options) => {
  const port = new MemoryPort(options);
  for (const [path, bytes] of tree) port.store.set(url(path), bytes);
  return port;
};

const v1Of = (store) => new Map([...store].filter(([u]) => !u.startsWith(LEGACY) && u !== FLAG));
const legacyOf = (store) => new Map([...store].filter(([u]) => u.startsWith(LEGACY)));

/** Same bytes for media, same meaning for JSON. */
const sameObject = (u, a, b) => {
  if (u.includes("/files/")) return sameBytes(a, b);
  try {
    assert.deepStrictEqual(JSON.parse(decoder.decode(a)), JSON.parse(decoder.decode(b)));
    return true;
  } catch {
    return false;
  }
};

// ---- the chaos port ----

const PROFILES = {
  // Faults a homeserver or the network between can give for the call that gets them
  main: {
    network: 4,
    outage: 1,
    rate_limited: 2,
    hang: 1,
    truncate: 2,
    reorder: 2,
    delete_source: 1,
    concurrent_writer: 1,
    delete_during_copy: 1,
    quota: 0.3,
    rejected: 1,
    unauthorized: 0.15,
    lost_response: 2,
    not_found_delete: 1,
  },
  "quota-rate": { quota: 1, rate_limited: 6 },
  "lost-response": { lost_response: 1 },
  // Any kind on any call, statuses included, whether or not a homeserver would answer it there
  "any-kind": { any: 1, hang: 0.2, truncate: 0.5, reorder: 0.5 },
  // A GET answering 404 for an object that is still there
  "phantom-404": { phantom_404: 1, network: 2 },
};

// [base, span] of the share of calls that fail, drawn per seed: each profile at rates its
// runs still finish under
const RATES = {
  main: [0.01, 0.11],
  "quota-rate": [0.02, 0.2],
  "lost-response": [0.05, 0.4],
  "any-kind": [0.01, 0.05],
  "phantom-404": [0.02, 0.1],
};

const ANY_KINDS = [
  ["quota", 507],
  ["rate_limited", 429],
  ["unauthorized", 401],
  ["unauthorized", 403],
  ["not_found", 404],
  ["exists", 412],
  ["unsupported", 403],
  ["network", 500],
  ["network", undefined],
  ["rejected", 400],
  ["rejected", 413],
];

/** Which faults apply to which call. */
const applies = (fault, op, u) => {
  const legacy = u.startsWith(LEGACY);
  const isPut = op === "putJson" || op === "putBytes";
  switch (fault) {
    case "truncate":
    case "reorder":
      return op === "list";
    case "delete_source":
      // A non-File 0.x object, deleted by its owner just before the run reads or re-checks it
      return (op === "get" || op === "head") && legacy && !u.startsWith(url("pub/pubky.app/files/"));
    case "phantom_404":
      return op === "get" && legacy && !u.startsWith(url("pub/pubky.app/files/"));
    case "delete_during_copy":
    case "concurrent_writer":
    case "quota":
    case "rejected":
    case "lost_response":
      return isPut && u !== FLAG;
    case "not_found_delete":
      return op === "delete";
    default:
      return true;
  }
};

const THEIRS = encoder.encode(JSON.stringify({ written: "elsewhere" }));

class ChaosPort {
  /**
   * `schedule`: a Map of call key to fault, replayed exactly (for minimizing); otherwise the
   * seed draws one per call and `trace` records what it drew.
   */
  constructor(store, { seed, profile, rate, schedule, sourcesOfUrl }) {
    this.sourcesOfUrl = sourcesOfUrl ?? new Map();
    this.inner = new MemoryPort();
    this.inner.store = store;
    this.store = store;
    this.rand = xorshift(seed);
    this.profile = profile;
    this.rate = rate;
    this.schedule = schedule;
    this.trace = [];
    this.seen = new Map();
    this.outages = new Map();
    this.writes = new Map(); // url -> bytes ever written by the engine
    this.harnessWritten = new Set();
    this.deleted = new Set();
    this.violations = [];
    this.phantom = new Set();
    // 0.x paths deleted at their re-check in this run, and copies whose PUT lost its answer
    this.deletedAtRecheck = new Set();
    this.lostAnswers = new Set();
    this.deleteAttempts = new Set();
    // Copies the race guard read back before deleting, to delete only its own
    this.cleanupReads = new Set();
    this.orphans = [];
  }

  #key(op, u) {
    const k = `${op} ${u}`;
    const n = (this.seen.get(k) ?? 0) + 1;
    this.seen.set(k, n);
    return `${k} #${n}`;
  }

  #draw(op, u) {
    const entries = Object.entries(this.profile).filter(([f]) => applies(f, op, u));
    if (entries.length === 0 || this.rand() >= this.rate) return null;
    const total = entries.reduce((s, [, w]) => s + w, 0);
    let r = this.rand() * total;
    for (const [fault, w] of entries) {
      r -= w;
      if (r < 0) {
        if (fault === "hang") return { fault, ms: int(this.rand, 10, 200) };
        if (fault === "outage") return { fault, calls: int(this.rand, 1, 6) };
        if (fault === "any") {
          const [kind, status] = pick(this.rand, ANY_KINDS);
          return { fault, kind, status };
        }
        if (fault === "network") return { fault, status: pick(this.rand, [500, 502, 503, undefined]) };
        if (fault === "rejected") return { fault, status: pick(this.rand, [400, 413, 409]) };
        if (fault === "lost_response") return { fault, kind: pick(this.rand, ["network", "network", "network", "rate_limited"]) };
        return { fault };
      }
    }
    return null;
  }

  async #enter(op, u) {
    const key = this.#key(op, u);
    let fault;
    if (this.schedule) fault = this.schedule.get(key) ?? null;
    else {
      fault = this.#draw(op, u);
      if (this.outages.get(u) > 0) {
        this.outages.set(u, this.outages.get(u) - 1);
        fault = { fault: "network", status: 503, outage: true };
      }
    }
    if (fault) this.trace.push({ key, ...fault });
    if (!fault) return null;
    switch (fault.fault) {
      case "hang":
        await new Promise((r) => setTimeout(r, fault.ms));
        return null;
      case "outage":
        if (!this.schedule) this.outages.set(u, fault.calls);
        throw new TypeError("fetch failed");
      case "network":
        throw fault.status === undefined ? new TypeError("fetch failed") : refusal(fault.status, `server error ${fault.status}`);
      case "rate_limited":
        throw new MigrationPortError("rate_limited", "Too Many Requests", 429);
      case "quota":
        throw new MigrationPortError("quota", "Insufficient Storage", 507);
      case "unauthorized":
        throw new MigrationPortError("unauthorized", "Unauthorized", 401);
      case "rejected":
        throw refusal(fault.status, `refused ${fault.status}`);
      case "any":
        throw new MigrationPortError(fault.kind, `${fault.kind} injected`, fault.status);
      case "delete_source":
        if (this.store.delete(u)) {
          this.deleted.add(rel(u));
          if (op === "head") this.deletedAtRecheck.add(rel(u));
        }
        return null;
      case "phantom_404":
        this.phantom.add(rel(u));
        return { phantom: true };
      case "concurrent_writer":
        if (!this.store.has(u)) {
          this.store.set(u, THEIRS);
          this.harnessWritten.add(u);
        }
        return null;
      case "not_found_delete":
        // Someone else deleted it a moment before
        this.store.delete(u);
        throw new MigrationPortError("not_found", "Not Found", 404);
      default:
        return fault; // list shaping and lost responses act after the call
    }
  }

  #recordWrite(u, bytes) {
    if (u === FLAG) return;
    if (u.startsWith(LEGACY)) this.violations.push({ invariant: "legacy-untouched", detail: `PUT ${u}` });
    const before = this.writes.get(u);
    if (before && !sameBytes(before, bytes)) {
      this.violations.push({ invariant: "create-only", detail: `${u} written twice with different bytes` });
    }
    this.writes.set(u, bytes);
  }

  async list(prefix, cursor) {
    const shape = await this.#enter("list", prefix);
    const page = await this.inner.list(prefix, cursor);
    if (shape?.fault === "truncate" && page.urls.length > 1) {
      // A server or proxy that answers fewer than asked, with the cursor of what it answered
      const keep = Math.max(1, Math.floor(page.urls.length / 2));
      const urls = page.urls.slice(0, keep);
      return { urls, next: urls[urls.length - 1] };
    }
    if (shape?.fault === "reorder") {
      const urls = [...page.urls].reverse();
      return page.next ? { urls, next: page.next } : { urls };
    }
    return page;
  }

  async get(u) {
    if (!u.startsWith(LEGACY) && u !== FLAG) this.cleanupReads.add(u);
    const r = await this.#enter("get", u);
    if (r?.phantom) return null;
    return this.inner.get(u);
  }

  async head(u) {
    await this.#enter("head", u);
    return this.inner.head(u);
  }

  async #put(op, u, bytes, call) {
    const r = await this.#enter(op, u);
    if (u.startsWith(LEGACY)) this.violations.push({ invariant: "legacy-untouched", detail: `${op} ${u}` });
    const had = this.store.has(u);
    await call();
    if (!had || u === FLAG) this.#recordWrite(u, bytes);
    if (r?.fault === "delete_during_copy") {
      // The owner deletes the 0.x object while its copy is being written
      for (const path of this.sourcesOfUrl.get(u) ?? []) {
        if (path.startsWith("pub/pubky.app/files/") || !this.store.delete(url(path))) continue;
        this.deleted.add(path);
        this.deletedAtRecheck.add(path);
      }
    }
    if (r?.fault === "lost_response") {
      this.lostAnswers.add(u);
      // The write landed; the answer did not
      if (r.kind === "rate_limited") throw new MigrationPortError("rate_limited", "Too Many Requests", 429);
      throw new TypeError("fetch failed");
    }
  }

  putJson(u, object, options) {
    const bytes = encoder.encode(JSON.stringify(object));
    return this.#put("putJson", u, bytes, () => this.inner.putJson(u, object, options));
  }

  putBytes(u, bytes, options) {
    return this.#put("putBytes", u, bytes.slice(), () => this.inner.putBytes(u, bytes, options));
  }

  async delete(u) {
    this.deleteAttempts.add(u);
    await this.#enter("delete", u);
    if (u.startsWith(LEGACY)) this.violations.push({ invariant: "legacy-untouched", detail: `DELETE ${u}` });
    return this.inner.delete(u);
  }
}

// ---- one seed ----

const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error("run timeout")), ms).unref());

const checkProgress = (events, report, filesListed) => {
  const problems = [];
  const last = events.at(-1);
  if (!last) return ["no progress event"];
  if (JSON.stringify(last.counts) !== JSON.stringify(report.counts)) problems.push("last event counts differ from the report");
  if (last.done !== report.done || last.total !== report.total) problems.push("last event done/total differ from the report");
  let prev = null;
  for (const e of events) {
    if (prev) {
      for (const k of Object.keys(e.counts)) if (e.counts[k] < prev.counts[k]) problems.push(`count ${k} went down`);
      if (e.done < prev.done) problems.push("done went down");
    }
    prev = e;
  }
  const sum = Object.values(report.counts).reduce((a, b) => a + b, 0);
  if (sum > report.done || report.done - sum > filesListed) problems.push(`counts sum ${sum} vs done ${report.done}`);
  if (report.status === "done" && report.done !== report.total) problems.push("done run with done != total");
  const skippedTotal = Object.values(report.skipped).reduce((a, l) => a + l.length, 0);
  const nonWritten = sum - report.counts.written - report.counts.already_present;
  if (report.status !== "already_migrated" && skippedTotal !== nonWritten) problems.push(`skipped lists ${skippedTotal} vs counts ${nonWritten}`);
  return [...new Set(problems)];
};

const STATUS_FOR = { QUOTA: "paused" };

/**
 * The tree after the last run, against a fault-free run of what is left of the 0.x tree.
 * Pushes what breaks onto the port's violations and returns the phantom 404s that lost a copy.
 */
const checkEndState = (tree, store, port, original, status) => {
  const violations = port.violations;
  // The 0.x tree is the original one less the objects the harness deleted
  const legacy = legacyOf(store);
  for (const [path, bytes] of tree) {
    const u = url(path);
    if (port.deleted.has(path)) {
      if (legacy.has(u)) violations.push({ invariant: "legacy-untouched", detail: `${path} deleted by the harness is back` });
      continue;
    }
    if (!legacy.has(u) || !sameBytes(legacy.get(u), bytes)) {
      violations.push({ invariant: "legacy-untouched", detail: `${path} changed or gone` });
    }
  }
  if (legacy.size !== tree.size - port.deleted.size) violations.push({ invariant: "legacy-untouched", detail: "extra 0.x objects" });

  const flag = JSON.parse(decoder.decode(store.get(FLAG)));
  const skipped = flag.skipped ?? {};
  if (skipped.io_error?.length) violations.push({ invariant: "no-flag-after-io_error", detail: "flag lists io_error" });

  const finalTree = new Map([...tree].filter(([p]) => !port.deleted.has(p)));
  const now = expectedWrites(finalTree);
  const allowed = new Map();
  for (const r of original.values()) for (const w of r.writes ?? []) allowed.set(w.url, w.bytes);
  for (const r of now.values()) for (const w of r.writes ?? []) allowed.set(w.url, w.bytes);

  // Nothing in the 1.x tree that a fault-free run would not write, or another writer put there
  const v1 = v1Of(store);
  for (const u of port.harnessWritten) {
    // What another writer put there stays as they wrote it
    if (!store.has(u) || !sameBytes(store.get(u), THEIRS)) {
      violations.push({ invariant: "theirs-untouched", detail: `${u} written elsewhere was overwritten or deleted` });
    }
  }
  for (const [u, bytes] of v1) {
    if (port.harnessWritten.has(u)) continue;
    if (!allowed.has(u)) violations.push({ invariant: "tree-subset", detail: `unexpected ${u}` });
    else if (!sameObject(u, bytes, allowed.get(u))) violations.push({ invariant: "tree-subset", detail: `different bytes at ${u}` });
  }
  // Every object still in the 0.x tree has its copy, unless the last run recorded why not
  const excused = new Set([...(skipped.put_rejected ?? []), ...(skipped.deleted_mid_run ?? [])]);
  for (const [path, r] of now) {
    if (!r.writes) continue;
    for (const w of r.writes) {
      if (v1.has(w.url) || port.harnessWritten.has(w.url)) continue;
      if (excused.has(path)) continue;
      violations.push({ invariant: "tree-complete", detail: `${path} has no copy at ${w.url}` });
    }
  }
  // The flag's lists say what happened to the 0.x tree it covers
  for (const reason of skipReasons) {
    const expected = [...now]
      .filter(([, r]) => r.skip === reason)
      .map(([p]) => p)
      .sort();
    const got = [...(skipped[reason] ?? [])].filter((p) => !excused.has(p)).sort();
    const expectedLeft = expected.filter((p) => !excused.has(p));
    if (status === "done" && JSON.stringify(got) !== JSON.stringify(expectedLeft)) {
      violations.push({ invariant: "flag-skipped-consistent", detail: `${reason}: flag ${JSON.stringify(got)} vs tree ${JSON.stringify(expectedLeft)}` });
    }
  }
  const sourcesOf = new Map();
  for (const [p, r] of now) for (const w of r.writes ?? []) sourcesOf.set(w.url, [...(sourcesOf.get(w.url) ?? []), p]);
  for (const path of skipped.put_rejected ?? []) {
    for (const w of now.get(path)?.writes ?? []) {
      // Another 0.x object folding to the same key may have landed it
      if (v1.has(w.url) && !port.harnessWritten.has(w.url) && sourcesOf.get(w.url).length === 1) {
        violations.push({ invariant: "flag-skipped-consistent", detail: `${path} is put_rejected but ${w.url} exists` });
      }
    }
  }
  for (const path of skipped.deleted_mid_run ?? []) {
    if (!port.deleted.has(path) && !port.phantom.has(path)) {
      violations.push({ invariant: "flag-skipped-consistent", detail: `${path} deleted_mid_run but never deleted` });
    }
  }
  return [...port.phantom].filter((p) => (now.get(p)?.writes ?? []).some((w) => !v1.has(w.url)));
};

const runSeed = async (seed, { profile, rate, schedule, verbose }) => {
  const tree = buildTree(seed);
  const store = new Map();
  for (const [path, bytes] of tree) store.set(url(path), bytes);
  const original = expectedWrites(tree);
  const sourcesOfUrl = new Map();
  for (const [p, r] of original) for (const w of r.writes ?? []) sourcesOfUrl.set(w.url, [...(sourcesOfUrl.get(w.url) ?? []), p]);
  const port = new ChaosPort(store, { seed, profile, rate, schedule, sourcesOfUrl });
  const violations = port.violations;
  const runs = [];
  let finalReport;
  for (let i = 0; i < MAX_RUNS; i++) {
    const flagBefore = store.get(FLAG);
    const keysBefore = new Set(store.keys());
    port.deletedAtRecheck.clear();
    port.lostAnswers.clear();
    port.deleteAttempts.clear();
    port.cleanupReads.clear();
    const events = [];
    let report;
    try {
      report = await Promise.race([runMigration({ owner, port, sleep: noSleep, onProgress: (e) => events.push(e) }), timeout(RUN_TIMEOUT_MS)]);
    } catch (e) {
      violations.push({ invariant: "never-throws", run: i, detail: String(e?.stack ?? e).slice(0, 500) });
      break;
    }
    runs.push({ status: report.status, code: report.error?.code, written: report.counts.written, io_error: report.counts.io_error });
    if (report.error && !KNOWN_CODES.has(report.error.code)) violations.push({ invariant: "known-code", run: i, detail: report.error.code });
    if (report.error && report.status !== (STATUS_FOR[report.error.code] ?? "aborted")) {
      violations.push({ invariant: "status-matches-code", run: i, detail: `${report.status} with ${report.error.code}` });
    }
    // A source deleted at its re-check takes the copies this run made for it
    for (const path of port.deletedAtRecheck) {
      for (const w of original.get(path)?.writes ?? []) {
        if (!store.has(w.url) || keysBefore.has(w.url) || port.harnessWritten.has(w.url) || port.lostAnswers.has(w.url)) continue;
        const others = (sourcesOfUrl.get(w.url) ?? []).filter((p) => p !== path && store.has(url(p)));
        if (others.length > 0) continue;
        // A cleanup that failed, at its read-back or at its DELETE, leaves the copy, and no later
        // run lists its source again
        if (port.deleteAttempts.has(w.url) || port.cleanupReads.has(w.url)) port.orphans.push({ run: i, path, url: w.url });
        else violations.push({ invariant: "race-guard", run: i, detail: `${path} deleted at its re-check, ${w.url} stays` });
      }
    }
    const flagAfter = store.get(FLAG);
    const flagWritten = flagAfter !== flagBefore;
    if (flagWritten && report.status !== "done") violations.push({ invariant: "flag-only-after-done", run: i, detail: report.status });
    if (report.counts.io_error > 0 && (flagWritten || report.status === "done")) {
      violations.push({ invariant: "no-flag-after-io_error", run: i, detail: `${report.status}, flag written ${flagWritten}` });
    }
    if (report.status === "done" && !flagAfter) violations.push({ invariant: "done-writes-flag", run: i });
    const filesListed = [...store.keys()].filter((u) => u.startsWith(url("pub/pubky.app/files/"))).length;
    for (const p of checkProgress(events, report, filesListed)) violations.push({ invariant: "progress-adds-up", run: i, detail: p });
    if (verbose) console.log(`run ${i}`, report.status, report.error?.code ?? "", JSON.stringify(Object.fromEntries(Object.entries(report.counts).filter(([, n]) => n))));
    finalReport = report;
    if (report.status === "done" || report.status === "already_migrated") break;
  }

  // ---- the end state ----
  const done = finalReport && (finalReport.status === "done" || finalReport.status === "already_migrated");
  if (!done) {
    return { seed, runs, finished: false, violations, faults: port.trace.length, trace: port.trace };
  }
  const lost = checkEndState(tree, store, port, original, finalReport.status);
  return {
    seed,
    runs,
    finished: true,
    violations,
    faults: port.trace.length,
    deleted: port.deleted.size,
    phantomLost: lost,
    orphans: port.orphans,
    trace: port.trace,
  };
};

// ---- minimizing a failing seed ----

const fails = async (seed, options, schedule, invariant) => {
  const r = await runSeed(seed, { ...options, schedule });
  return r.violations.some((v) => v.invariant === invariant);
};

/** Drops faults from the trace while the same invariant still breaks: chunks, then one by one. */
const minimize = async (seed, options, trace, invariant) => {
  let faults = trace.map((t) => [t.key, t]);
  let chunk = Math.max(1, Math.floor(faults.length / 2));
  while (chunk >= 1) {
    let progressed = false;
    for (let at = 0; at < faults.length; at += chunk) {
      const fewer = [...faults.slice(0, at), ...faults.slice(at + chunk)];
      if (await fails(seed, options, new Map(fewer), invariant)) {
        faults = fewer;
        progressed = true;
        at -= chunk;
      }
    }
    if (!progressed) chunk = Math.floor(chunk / 2);
  }
  return faults.map(([, f]) => f);
};

// ---- main ----

const args = flags({
  variant: { type: "string", default: "main" },
  seeds: { type: "string", default: "1000" },
  from: { type: "string", default: "0" },
  out: { type: "string" },
  "no-minimize": { type: "boolean", default: false },
  seed: { type: "string" },
  rate: { type: "string" },
  verbose: { type: "boolean", default: false },
  trace: { type: "boolean", default: false },
});
const variant = args.variant;
const profile = PROFILES[variant];
if (!profile) throw new Error(`unknown variant ${variant}`);
/** The seed's own fault rate, so `--seed N` replays the rate the sweep ran it at. */
const rateOf = (seed) => {
  const [base, span] = RATES[variant];
  return base + xorshift(seed * 31 + 7)() * span;
};

await init();

if (args.seed !== undefined) {
  const seed = Number(args.seed);
  const r = await runSeed(seed, { profile, rate: Number(args.rate ?? rateOf(seed)), verbose: args.verbose });
  console.log(JSON.stringify({ ...r, trace: args.trace ? r.trace : r.trace.length }, null, 1));
  process.exit(0);
}

const count = (counts, key, n = 1) => (counts[key] = (counts[key] ?? 0) + n);
const seeds = Number(args.seeds);
const from = Number(args.from);
const started = performance.now();
let rateScale = 1;
const summary = {
  variant,
  seeds: 0,
  finished: 0,
  unfinished: [],
  runsHistogram: {},
  statuses: {},
  faultsInjected: 0,
  faultKinds: {},
  deletedSources: 0,
  phantomLost: 0,
  orphanedCopies: [],
  violations: [],
  rateScaleChanges: [],
  ms: 0,
};
for (let seed = from; seed < from + seeds; seed++) {
  const rate = rateOf(seed) * rateScale;
  const t0 = performance.now();
  const r = await runSeed(seed, { profile, rate });
  const ms = performance.now() - t0;
  if (ms > 20_000 && rateScale > 0.25) {
    rateScale /= 2;
    summary.rateScaleChanges.push({ seed, ms: Math.round(ms), rateScale });
  }
  const at = { seed, rate: +rate.toFixed(4) };
  summary.seeds++;
  summary.faultsInjected += r.faults;
  for (const t of r.trace) count(summary.faultKinds, t.fault);
  summary.deletedSources += r.deleted ?? 0;
  summary.phantomLost += r.phantomLost?.length ?? 0;
  for (const o of r.orphans ?? []) summary.orphanedCopies.push({ ...at, ...o });
  count(summary.runsHistogram, r.runs.length);
  for (const run of r.runs) count(summary.statuses, run.code ? `${run.status}:${run.code}` : run.status);
  if (r.finished) summary.finished++;
  else summary.unfinished.push({ ...at, last: r.runs.at(-1) });
  if (r.violations.length) {
    const invariant = r.violations[0].invariant;
    const entry = { ...at, violations: r.violations.slice(0, 10), faults: r.faults };
    if (!args["no-minimize"] && summary.violations.length < 20 && invariant !== "never-throws") {
      entry.minimalTrace = await minimize(seed, { profile, rate }, r.trace, invariant);
    }
    summary.violations.push(entry);
    console.log(`seed ${seed}: ${r.violations.length} violation(s), first ${invariant}: ${r.violations[0].detail ?? ""}`);
  }
  if (seed % 50 === 0) {
    const rss = Math.round(process.memoryUsage().rss / 1e6);
    console.log(`seed ${seed} ${Math.round((performance.now() - started) / 1000)}s rss ${rss} MB, ${summary.violations.length} failing`);
  }
}
summary.ms = Math.round(performance.now() - started);
summary.peakRssMb = Math.round(process.memoryUsage().rss / 1e6);
writeOut(args.out, summary);
console.log(JSON.stringify({ ...summary, violations: summary.violations.length, unfinished: summary.unfinished.length, orphanedCopies: summary.orphanedCopies.length }, null, 1));
