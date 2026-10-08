// Model-based fuzz of one owner's tree across the post lifecycle and the migration: fast-check
// draws a sequence of commands (build, edit, publish, unpublish, delete, migrate, rescan, a
// transform revision bump, clock steps, a second copy of the package, port faults), runs it
// over a MemoryPort holding the 0.x tree of the vectors, and after every step checks what a
// user expects of their data:
//
//   - deleted stays deleted: no 1.x copy of an object the user deleted comes back;
//   - nothing private under /pub/: a draft or an unpublished post has no public version, and
//     every object under /pub/ is one the public rules accept;
//   - every stored object decodes at its URL;
//   - no path is overwritten with other bytes, but the profile, which an edit replaces.
//
// A failure is shrunk to the shortest sequence that still fails and printed with its seed and
// path, which replay it exactly.
//
// One resurrection is counted apart, not failed: a deleted key coming back from a 0.x copy that
// is still there and that no finished run recorded. Nothing in this package can tell that copy
// from one never migrated: `deletionPaths` does not reach the 0.x copy of a bookmark or a feed,
// whose 0.x id the v1 id cannot name, a client may skip the 0.x listing of a post or a
// tag, and only a finished run writes the record. `--strict` fails on it too.
//
//   node --max-old-space-size=1536 qa/model.mjs [--runs 1000] [--seed N] [--path P] [--commands 30] [--verbose]

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import fc from "fast-check";
import { bytesOf, corpus, legacyTree } from "../migration.fixture.js";
import { stableKey } from "../dist/uri.js";
import { init, transforms } from "../dist/migration/wasm.js";
import { NOW_MS, OTHER, OWNER, flags, noSleep, sameBytes, xorshift } from "./lib.mjs";

const args = flags({
  runs: { type: "string", default: "1000" },
  seed: { type: "string" },
  path: { type: "string" },
  commands: { type: "string", default: "30" },
  verbose: { type: "boolean", default: false },
  strict: { type: "boolean", default: false },
});

// A second copy of the package, as a page that bundles it twice has: its own clock, its own
// mint guard, its own engine
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
// Inside the package, so the copy resolves the same dependencies
const outDir = fileURLToPath(new URL("out/", import.meta.url));
fs.mkdirSync(outDir, { recursive: true });
const copy = fs.mkdtempSync(path.join(outDir, "model-copy-"));
fs.cpSync(dist, copy, { recursive: true });
// Its own `#glue`, so the copy loads its own wasm and not the package's
fs.writeFileSync(path.join(copy, "package.json"), JSON.stringify({ type: "module", imports: { "#glue": { node: "./migration/glue.node.js", default: "./migration/glue.js" } } }));
process.on("exit", () => fs.rmSync(copy, { recursive: true, force: true }));
const load = async (base) => ({
  api: await import(pathToFileURL(path.join(base, "index.js"))),
  testing: await import(pathToFileURL(path.join(base, "testing.js"))),
  migration: await import(pathToFileURL(path.join(base, "migration/index.js"))),
});
const instances = [await load(dist), await load(copy)];
const [{ api, migration }] = instances;
const { MemoryPort, MigrationPortError, refusal } = migration;

const owner = corpus.owner;
const url = (p) => `pubky://${owner}${p}`;
const rel = (u) => u.slice(`pubky://${owner}`.length);
const LEGACY = url("/pub/pubky.app/");
const FLAG = url("/priv/social/v1/_migrated.json");
const PROFILE = url("/pub/social/v1/profile.json");
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const T0 = NOW_MS;
// Pubkys to follow and mute, both other than the owner
const OTHERS = [OTHER, OWNER];

/** The port the user's tree lives in, recording every write so an overwrite is seen. */
class Tree extends MemoryPort {
  constructor() {
    super();
    this.faults = null;
    this.overwrites = [];
    for (const [p, row] of legacyTree()) this.store.set(url(`/${p}`), bytesOf(row));
  }

  #record(u, bytes) {
    const before = this.store.get(u);
    if (before !== undefined && !sameBytes(before, bytes) && u !== FLAG && u !== PROFILE) this.overwrites.push(rel(u));
  }

  async putJson(u, object, options) {
    await this.#fault("putJson", u);
    this.#record(u, encoder.encode(JSON.stringify(object)));
    await super.putJson(u, object, options);
    await this.#lost("putJson", u);
  }

  async putBytes(u, bytes, options) {
    await this.#fault("putBytes", u);
    this.#record(u, bytes);
    await super.putBytes(u, bytes, options);
    await this.#lost("putBytes", u);
  }

  async list(u, cursor) {
    await this.#fault("list", u);
    return super.list(u, cursor);
  }

  async get(u, options) {
    await this.#fault("get", u);
    return super.get(u, options);
  }

  async head(u) {
    await this.#fault("head", u);
    return super.head(u);
  }

  async delete(u) {
    await this.#fault("delete", u);
    return super.delete(u);
  }

  // Faults are drawn only while a migration runs; the client's own calls go through
  async #fault(op, u) {
    const f = this.faults;
    if (f === null || f.rand() >= f.rate) return;
    const kind = f.kinds[Math.floor(f.rand() * f.kinds.length)];
    if (kind === "lost_response") return void (f.lose = op.startsWith("put") ? u : null);
    if (kind === "network") throw new TypeError("fetch failed");
    if (kind === "server") throw refusal(503, "server error");
    if (kind === "rate_limited") throw new MigrationPortError("rate_limited", "Too Many Requests", 429);
    if (kind === "quota" && op.startsWith("put")) throw new MigrationPortError("quota", "Insufficient Storage", 507);
    if (kind === "unauthorized") throw new MigrationPortError("unauthorized", "Unauthorized", 401);
  }

  // The write landed and its answer did not
  async #lost(op, u) {
    if (this.faults?.lose === u) {
      this.faults.lose = null;
      throw new TypeError(`fetch failed after ${op}`);
    }
  }

  /** Owner-relative paths stored under `prefix`, the client's LIST. */
  paths(prefix) {
    return [...this.store.keys()]
      .filter((u) => u.startsWith(url(prefix)))
      .map(rel)
      .sort();
  }
}

/**
 * What the user expects: the keys they deleted, the posts that must have no public version,
 * and the posts they made, to pick from. The 1.x tree itself is read from the port, since
 * migrated objects get their ids from the 0.x tree.
 */
const freshModel = () => ({ deleted: new Set(), privatePosts: new Set(), clock: T0, latest: T0, transformBumps: 0, steps: [] });

// ---- the client: what an app does with the package's plans, against the port ----

/**
 * PUT a new object, minting again when its place is taken: another copy of the package under
 * the same clock mints the same id, and a post id is taken by a version in either root.
 */
const taken = (tree, built) => {
  const parsed = api.parseUri(built.url);
  if (parsed.kind !== "post") return tree.store.has(built.url);
  return tree.paths(`/pub/social/v1/posts/${parsed.id}/`).length + tree.paths(`/priv/social/v1/posts/${parsed.id}/`).length > 0;
};

const create = async (tree, build) => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const built = build();
    if (taken(tree, built)) continue;
    await tree.putBytes(built.url, built.body);
    return built;
  }
  throw new Error("five mints in a row landed on taken paths");
};

/** The newest version of a post under `root`, read and decoded. */
const headOf = (tree, id, root) => {
  const dir = `/${root === "public" ? "pub" : "priv"}/social/v1/posts/${id}/`;
  const versions = tree.paths(dir).filter((p) => p.endsWith(".json"));
  const newest = versions
    .map((p) => ({ p, editId: api.parseUri(url(p)).editId }))
    .sort((a, b) => (a.editId < b.editId ? -1 : 1))
    .at(-1);
  if (newest === undefined) return null;
  return { path: newest.p, url: url(newest.p), object: api.decodeObject(url(newest.p), tree.store.get(url(newest.p)), "post") };
};

const postIds = (tree) => [...new Set([...tree.paths("/pub/social/v1/posts/"), ...tree.paths("/priv/social/v1/posts/")].map((p) => p.split("/")[5]))].sort();

const v1Objects = (tree) => [...tree.paths("/pub/social/v1/"), ...tree.paths("/priv/social/v1/")].filter((p) => url(p) !== FLAG);

const runPlanCopies = async (tree, copies) => {
  for (const { from, to } of copies) {
    const bytes = tree.store.get(url(from));
    if (bytes !== undefined && !tree.store.has(url(to))) await tree.putBytes(url(to), bytes);
  }
};

const runDeletes = async (tree, deletes) => {
  for (const p of deletes) if (tree.store.has(url(p))) await tree.delete(url(p));
};

const keyOf = (p) => {
  const parsed = api.parseUri(url(p));
  if (parsed.kind === "user") return "profile";
  return "id" in parsed ? `${parsed.kind}s/${parsed.id}` : null;
};

// ---- the invariants ----

const known = new Map();
// What the runs did, so a generator that stopped reaching a step shows
const stats = new Map();
const count = (what) => stats.set(what, (stats.get(what) ?? 0) + 1);

// The 1.x keys each 0.x object of the tree becomes, from the transforms alone: a tag's 1.x id
// is not its 0.x one
await init();
const keysOfLegacy = (() => {
  const run = transforms.createMigration(owner);
  const rows = [...legacyTree()].map(([p, row]) => [p, bytesOf(row)]);
  const out = new Map();
  for (const [p, bytes] of [...rows.filter(([p]) => p.includes("/files/")), ...rows.filter(([p]) => !p.includes("/files/"))]) {
    try {
      const result = transforms.migrate(run, url(`/${p}`), bytes);
      if ("writes" in result)
        out.set(
          `/${p}`,
          result.writes.map((w) => keyOf(w.meta.path)),
        );
    } catch {}
  }
  run.free();
  return out;
})();

/** The 0.x paths the flag records as migrated. */
const recordOf = (tree) => {
  try {
    return JSON.parse(decoder.decode(tree.store.get(FLAG))).migrated ?? [];
  } catch {
    return [];
  }
};

/** The 0.x path of `key` still stored that no finished run had recorded before this step, if any. */
const unrecordedLegacy = (tree, key, recorded) => {
  return tree.paths("/pub/pubky.app/").find((p) => {
    const k = stableKey(p);
    const becomes = keysOfLegacy.get(p) ?? (k !== null && "key" in k ? [k.key] : []);
    return becomes.includes(key) && !recorded.includes(p.slice(1));
  });
};

function check(model, tree) {
  const problems = [];
  for (const p of v1Objects(tree)) {
    const key = keyOf(p);
    if (key !== null && model.deleted.has(key)) {
      const legacy = unrecordedLegacy(tree, key, model.recordBefore);
      if (legacy === undefined || args.strict) problems.push(`deleted ${key} is back at ${p}`);
      else {
        const why = /^(bookmarks|feeds)\//.test(key) ? "deletionPaths does not reach its 0.x copy" : "the client left its 0.x copy";
        known.set(why, (known.get(why) ?? 0) + 1);
        // Counted once: the user deletes it again
        model.deleted.delete(key);
      }
    }
    const parsed = api.parseUri(url(p));
    if (parsed.kind === "post" && parsed.root === "public" && model.privatePosts.has(parsed.id)) problems.push(`private post ${parsed.id} has a public version ${p}`);
    try {
      api.decodeObject(url(p), tree.store.get(url(p)));
    } catch (e) {
      problems.push(`${p} does not decode: ${e.message}`);
    }
  }
  for (const p of tree.overwrites) problems.push(`${p} was overwritten with other bytes`);
  tree.overwrites.length = 0;
  assert.deepStrictEqual(problems, [], `after ${model.steps.join(" > ")}`);
}

// ---- the commands ----

const pick = (items, i) => (items.length === 0 ? undefined : items[i % items.length]);
const instanceOf = (i) => instances[i];

/** A step that cannot apply to the tree as it is leaves it alone. */
class Step {
  check() {
    return true;
  }

  async run(model, tree) {
    model.steps.push(this.toString());
    model.recordBefore = recordOf(tree);
    const before = tree.calls.length;
    await this.apply(model, tree);
    if (tree.calls.length > before) count(this.constructor.name);
    check(model, tree);
  }
}

class BuildPost extends Step {
  constructor(inst, root, media, slug) {
    super();
    Object.assign(this, { inst, root, media, slug });
  }

  async apply(model, tree) {
    const { api: a } = instanceOf(this.inst);
    const attachments = [];
    if (this.media) {
      const bytes = encoder.encode(`media ${model.steps.length}`);
      const file = a.buildFile(owner, { bytes, type: "image/png", root: this.root });
      if (!tree.store.has(file.url)) await tree.putBytes(file.url, bytes);
      attachments.push({ uri: file.url });
    }
    const input = { kind: this.media ? "image" : "note", content: `post ${model.steps.length}`, attachments, root: this.root, ...(this.slug ? { slug: "draft" } : {}) };
    const built = await create(tree, () => a.buildPost(owner, input));
    if (this.root === "private") model.privatePosts.add(built.id);
    model.deleted.delete(`posts/${built.id}`);
  }

  toString() {
    return `buildPost(${this.inst}, ${this.root}${this.media ? ", media" : ""}${this.slug ? ", slug" : ""})`;
  }
}

class EditPost extends Step {
  constructor(inst, i) {
    super();
    Object.assign(this, { inst, i });
  }

  async apply(model, tree) {
    const id = pick(postIds(tree), this.i);
    if (id === undefined) return;
    const root = model.privatePosts.has(id) ? "private" : "public";
    const head = headOf(tree, id, root);
    if (head === null) return;
    const { api: a } = instanceOf(this.inst);
    let edit;
    try {
      edit = a.editPost(head.url, { ...head.object, content: `edit ${model.steps.length}` }, { root });
    } catch (e) {
      // A migrated 0.x post may carry what 1.x refuses on a write; a client shows it read-only
      if (e instanceof a.ValidationError) return;
      throw e;
    }
    if (!tree.store.has(edit.url)) await tree.putBytes(edit.url, edit.body);
  }

  toString() {
    return `editPost(${this.inst}, #${this.i})`;
  }
}

class Publish extends Step {
  constructor(i) {
    super();
    this.i = i;
  }

  async apply(model, tree) {
    const id = pick([...model.privatePosts].filter((p) => postIds(tree).includes(p)).sort(), this.i);
    if (id === undefined) return;
    const head = headOf(tree, id, "private");
    if (head === null) return;
    const plan = api.planPublish(owner, { id, editId: api.parseUri(head.url).editId, post: head.object });
    await runPlanCopies(tree, plan.copies);
    if (!tree.store.has(plan.put.url)) await tree.putBytes(plan.put.url, plan.put.body);
    model.privatePosts.delete(id);
  }

  toString() {
    return `publish(#${this.i})`;
  }
}

class Unpublish extends Step {
  constructor(i) {
    super();
    this.i = i;
  }

  async apply(model, tree) {
    const id = pick(
      postIds(tree).filter((p) => !model.privatePosts.has(p) && tree.paths(`/pub/social/v1/posts/${p}/`).length > 0),
      this.i,
    );
    if (id === undefined) return;
    const legacy = `/pub/pubky.app/posts/${id}`;
    const privateHead = headOf(tree, id, "private")?.path ?? null;
    let plan;
    try {
      plan = api.planUnpublish({ id, publicPaths: tree.paths(`/pub/social/v1/posts/${id}/`), legacyPaths: tree.store.has(url(legacy)) ? [legacy] : [], privateHead });
    } catch (e) {
      // A slugged draft head is the one shape the plan does not take back
      if (e instanceof api.ValidationError) return;
      throw e;
    }
    await runPlanCopies(tree, plan.copies);
    await runDeletes(tree, plan.deletes);
    model.privatePosts.add(id);
  }

  toString() {
    return `unpublish(#${this.i})`;
  }
}

class Delete extends Step {
  constructor(i, thorough) {
    super();
    Object.assign(this, { i, thorough });
  }

  async apply(model, tree) {
    const target = pick(v1Objects(tree), this.i);
    if (target === undefined) return;
    const parsed = api.parseUri(url(target));
    const key = keyOf(target);
    let deletes;
    if (parsed.kind === "post") {
      const legacy = `/pub/pubky.app/posts/${parsed.id}`;
      const listings = [...tree.paths(`/pub/social/v1/posts/${parsed.id}/`), ...tree.paths(`/priv/social/v1/posts/${parsed.id}/`)];
      if (this.thorough && tree.store.has(url(legacy))) listings.push(legacy);
      deletes = api.deletionPaths({ kind: "post", id: parsed.id, listings });
    } else if (parsed.kind === "file") {
      const listings = [...tree.paths("/pub/social/v1/files/"), ...tree.paths("/priv/social/v1/files/")].filter((p) => p.includes(parsed.id));
      deletes = api.deletionPaths({ kind: "file", id: parsed.id, listings });
    } else if (parsed.kind === "tag") {
      const listings = [];
      if (this.thorough) {
        // A 0.x tag is a copy of this one when the plan takes it as one
        for (const p of tree.paths("/pub/pubky.app/tags/")) {
          let body;
          try {
            body = JSON.parse(decoder.decode(tree.store.get(url(p))));
          } catch {
            continue;
          }
          const listing = { path: p, uri: String(body.uri), label: String(body.label) };
          try {
            api.deletionPaths({ kind: "tag", id: parsed.id, listings: [listing] });
            listings.push(listing);
          } catch (e) {
            if (!(e instanceof api.ValidationError)) throw e;
          }
        }
      }
      deletes = api.deletionPaths({ kind: "tag", id: parsed.id, listings });
    } else if (parsed.kind === "user") {
      deletes = api.deletionPaths({ kind: "user", id: "" });
    } else {
      deletes = api.deletionPaths({ kind: parsed.kind, id: parsed.id });
    }
    await runDeletes(tree, deletes);
    if (key !== null) model.deleted.add(key);
    if (parsed.kind === "post") model.privatePosts.delete(parsed.id);
  }

  toString() {
    return `delete(#${this.i}${this.thorough ? ", with listings" : ""})`;
  }
}

class Graph extends Step {
  constructor(inst, kind, i) {
    super();
    Object.assign(this, { inst, kind, i });
  }

  async apply(model, tree) {
    const { api: a } = instanceOf(this.inst);
    const other = pick(OTHERS, this.i);
    const ids = postIds(tree).filter((id) => !model.privatePosts.has(id));
    const target = ids.length > 0 && this.i % 2 === 0 ? a.buildUri(owner, "post", pick(ids, this.i)) : `https://example.com/${this.i % 5}`;
    const build = {
      follow: () => a.buildFollow(owner, other),
      mute: () => a.buildMute(owner, other),
      tag: () => a.buildTag(owner, target, `label${this.i % 3}`),
      bookmark: () => a.buildBookmark(owner, target),
      feed: () => a.buildFeed(owner, { name: "Feed", icon: "star", reach: "all", layout: "columns", sort: "recent", tags: [`t${this.i % 4}`] }),
    }[this.kind];
    const built = build();
    // Following someone already followed writes nothing new
    if (tree.store.has(built.url)) return;
    await tree.putBytes(built.url, built.body);
    model.deleted.delete(keyOf(built.path));
  }

  toString() {
    return `${this.kind}(${this.inst}, #${this.i})`;
  }
}

class Migrate extends Step {
  constructor(inst, mode, rescan, faultSeed, rate, kinds) {
    super();
    Object.assign(this, { inst, mode, rescan, faultSeed, rate, kinds });
  }

  async apply(model, tree) {
    const { runMigration } = instanceOf(this.inst).migration;
    tree.faults = this.rate > 0 ? { rand: xorshift(this.faultSeed), rate: this.rate, kinds: this.kinds, lose: null } : null;
    try {
      const report = await runMigration({ owner, port: tree, mode: this.mode, rescan: this.rescan, sleep: noSleep });
      count(`migrate ${report.status}`);
    } finally {
      tree.faults = null;
    }
  }

  toString() {
    const faults = this.rate > 0 ? `, faults ${this.kinds.join("/")} at ${this.rate} seed ${this.faultSeed}` : "";
    return `migrate(${this.inst}, ${this.mode}${this.rescan ? ", rescan" : ""}${faults})`;
  }
}

/** A build that walks to a newer transform revision: the flag of every finished run reads as older. */
class BumpTransformRev extends Step {
  async apply(model, tree) {
    const bytes = tree.store.get(FLAG);
    if (bytes === undefined) return;
    const flag = JSON.parse(decoder.decode(bytes));
    flag.transform_rev = 0;
    tree.store.set(FLAG, encoder.encode(JSON.stringify(flag)));
    model.transformBumps++;
  }

  toString() {
    return "bumpTransformRev()";
  }
}

class Clock extends Step {
  constructor(deltaMs) {
    super();
    this.deltaMs = deltaMs;
  }

  async apply(model) {
    // A clock may step back, but never so far that an id it minted reads as from the future
    model.clock = Math.max(model.clock + this.deltaMs, model.latest - 3_600_000);
    model.latest = Math.max(model.latest, model.clock);
    const now = model.clock;
    for (const { testing } of instances) testing.setClock(() => now);
  }

  toString() {
    return `clock(${this.deltaMs > 0 ? "+" : ""}${this.deltaMs} ms)`;
  }
}

const inst = fc.constantFrom(0, 1);
const index = fc.nat({ max: 1000 });
const FAULT_KINDS = ["network", "server", "rate_limited", "lost_response", "quota", "unauthorized"];
const commands = [
  fc.tuple(inst, fc.constantFrom("public", "private"), fc.boolean(), fc.boolean()).map(([i, r, m, s]) => new BuildPost(i, r, m, s)),
  fc.tuple(inst, index).map(([i, n]) => new EditPost(i, n)),
  index.map((n) => new Publish(n)),
  index.map((n) => new Unpublish(n)),
  fc.tuple(index, fc.boolean()).map(([n, t]) => new Delete(n, t)),
  fc.tuple(inst, fc.constantFrom("follow", "mute", "tag", "bookmark", "feed"), index).map(([i, k, n]) => new Graph(i, k, n)),
  fc
    .tuple(inst, fc.constantFrom("run", "run", "dry"), fc.boolean(), fc.nat(), fc.oneof(fc.constant(0), fc.double({ min: 0.02, max: 0.3, noNaN: true })), fc.subarray(FAULT_KINDS, { minLength: 1 }))
    .map(([i, mode, rescan, seed, rate, kinds]) => new Migrate(i, mode, rescan, seed, rate, kinds)),
  fc.constant(new BumpTransformRev()),
  fc.oneof(fc.integer({ min: -2_000, max: 2_000 }), fc.integer({ min: -7_200_000, max: 7_200_000 })).map((ms) => new Clock(ms)),
];

const runs = Number(args.runs);
const seed = args.seed === undefined ? Date.now() ^ (Math.random() * 0x7fffffff) : Number(args.seed);
const started = Date.now();
let executed = 0;
const property = fc.asyncProperty(fc.commands(commands, { maxCommands: Number(args.commands), size: "max" }), async (cmds) => {
  executed++;
  for (const { testing } of instances) testing.setClock(() => T0);
  const setup = () => ({ model: freshModel(), real: new Tree() });
  await fc.asyncModelRun(setup, cmds);
});

const details = await fc.check(property, { numRuns: runs, seed, ...(args.path ? { path: args.path } : {}), verbose: args.verbose ? 1 : 0 });
for (const { testing } of instances) testing.setClock();
const summary = {
  runs: details.numRuns,
  executed,
  seed,
  ms: Date.now() - started,
  failed: details.failed,
  knownResurrections: Object.fromEntries(known),
  steps: Object.fromEntries([...stats].sort()),
};
if (details.failed) {
  summary.path = details.counterexamplePath;
  summary.counterexample = String(details.counterexample?.[0]);
  summary.error = String(details.errorInstance?.message ?? details.error)
    .split("\n")
    .slice(0, 12)
    .join("\n");
}
console.log(JSON.stringify(summary, null, 1));
process.exitCode = details.failed ? 1 : 0;
