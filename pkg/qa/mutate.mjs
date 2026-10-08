// Mutation pass over the engine and the core: plants one bug at a time in a copy of the package
// under qa/out/mutant, recompiles the copy, and runs its Node tests, and for an engine bug a
// slice of the chaos harness. Stryker (`npm run mutation`) mutates the same files blindly; these
// are the bugs a reviewer would expect, each named.
// The sources are never written, so a crash or a Ctrl-C leaves no planted bug behind. A
// mutation nothing catches is a gap in the suite.
//
//   node qa/mutate.mjs [--seeds 150] [--only M3] [--out file.json]

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
// The copy keeps the tree's shape, so the tests find ../vectors as they do from pkg/
const work = path.join(source, "qa/out/mutant");
const pkg = path.join(work, "pkg");
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(path.join(pkg, "qa"), { recursive: true });
fs.symlinkSync(path.join(source, "../vectors"), path.join(work, "vectors"));
fs.symlinkSync(path.join(source, "node_modules"), path.join(pkg, "node_modules"));
for (const entry of [
  "src",
  "bin",
  "tsconfig.json",
  "package.json",
  "migration.fixture.js",
  "test.js",
  "vectors.test.js",
  "edges.test.js",
  "property.test.js",
  "transforms.test.js",
  "migration.test.js",
  "sdk-port.test.js",
  "cli.test.js",
  "qa/chaos.mjs",
  "qa/ops.mjs",
]) {
  fs.cpSync(path.join(source, entry), path.join(pkg, entry), { recursive: true });
}
// The wasm glue is the one part of dist that tsc does not write
fs.mkdirSync(path.join(pkg, "dist/migration"), { recursive: true });
fs.copyFileSync(path.join(source, "dist/migration/glue.js"), path.join(pkg, "dist/migration/glue.js"));
const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const seeds = Number(flag("--seeds", 150));

const MUTATIONS = [
  {
    id: "M1",
    what: "no re-check of the 0.x object after the PUTs (the race guard never deletes)",
    from: "const stillThere = await this.#attempt(() => this.#port.head(url));",
    to: "const stillThere: boolean | Failure = true;",
  },
  {
    id: "M2",
    what: "a walk with io_error writes the flag and ends done",
    from: 'if (this.#counts.io_error > 0) return this.#finish("incomplete");',
    to: "",
  },
  {
    id: "M3",
    what: "copies are PUT without ifAbsent",
    from: "this.#port.putBytes(write.meta.url, write.object.bytes, { ifAbsent: true })\n          : this.#port.putJson(write.meta.url, write.object, { ifAbsent: true }),",
    to: "this.#port.putBytes(write.meta.url, write.object.bytes)\n          : this.#port.putJson(write.meta.url, write.object),",
  },
  {
    id: "M4",
    what: "no write fence: a write outside the 1.x roots goes through",
    from: "if (!fenced(write.meta.url, this.#roots)) {",
    to: "if (false) {",
  },
  {
    id: "M5",
    what: "the File objects are walked after the posts",
    file: "src/migration/order.ts",
    from: 'const BUCKETS = [\n  "files",\n  "blobs",\n  "posts",',
    to: 'const BUCKETS = [\n  "blobs",\n  "posts",\n  "files",',
  },
  {
    id: "M6",
    what: "a copy someone else wrote first counts as made, so the race guard may delete it",
    from: '} else if (put.failed === "exists") {\n        // Written by someone else since the LIST: theirs stays, and it is not this run\'s to delete\n        claim.settle(true);',
    to: '} else if (put.failed === "exists") {\n        made.push(claim);',
  },
  {
    id: "M7",
    what: "a copy that did not land keeps its claim, so a second object folding to the key never writes it",
    from: "if (!landed && this.#claims.get(key) === claim) this.#claims.delete(key);",
    to: "",
  },
  {
    id: "M8",
    what: "only the first LIST page is read",
    from: "if (!page.next) return urls;",
    to: "if (page.urls.length >= 0 || !page.next) return urls;",
  },
  {
    id: "M9",
    what: "a network failure is not retried",
    from: "const NETWORK_RETRIES = 3;",
    to: "const NETWORK_RETRIES = 0;",
  },
  {
    id: "M10",
    what: "a File object that cannot be read counts io_error instead of stopping the run",
    from: 'if (bucket === "files") {\n        throw new Stop({ code: "IO_ERROR", message: `reading ${path}: ${got.message}` });\n      }',
    to: "",
  },
  {
    id: "M11",
    what: "a blob that was copied stays pending, so a paused run overstates the space it needs",
    from: 'if (bucket === "blobs" && outcome !== "io_error") this.#pendingBlobs.delete(keyOf(path));',
    to: "",
  },
  {
    id: "M12",
    what: "a race-guard DELETE that fails releases the claims of the copies still there",
    from: "made.forEach((m, j) => m.settle(j >= i));",
    to: "made.forEach((m) => m.settle(false));",
  },
  {
    id: "M13",
    what: "progress is reported before the object is counted done",
    from: "    const outcome = await this.#migrateOne(bucket, url, path);\n    this.#done++;",
    to: "    const outcome = await this.#migrateOne(bucket, url, path);\n    this.#emit(url);\n    this.#done++;",
  },
  {
    id: "M14",
    what: "no oversize check after the GET: an object over the cap from a port that ignores maxBytes reaches the hash or the wasm",
    from: 'if (bytes.length > max) return this.#count("oversize", path);',
    to: "",
  },
  {
    id: "M15",
    what: "a later walk copies again what an earlier run migrated, so a deleted object comes back",
    from: 'if (bucket !== "files" && this.#before.has(path)) return this.#count("already_present", path);',
    to: "",
  },
  {
    id: "M16",
    what: "the race guard deletes whatever is at the destination, another device's copy included",
    from: "const deleted = ours === true ? await this.#attempt(() => this.#port.delete(claim.write.meta.url)) : ours;",
    to: "const deleted = await this.#attempt(() => this.#port.delete(claim.write.meta.url));",
  },
  {
    id: "M17",
    what: "a clock any amount behind the last mint is a burst, never a correction",
    file: "src/clock.ts",
    from: "const ROLLBACK_TOLERANCE = 1_000_000n;",
    to: "const ROLLBACK_TOLERANCE = 1n << 62n;",
  },
  {
    id: "M18",
    what: "a mute delete names no path",
    file: "src/deletion.ts",
    from: 'return [socialPath("private", `mutes/${id}.json`)];',
    to: "return [];",
  },
  {
    id: "M19",
    what: "an id with its spare bits set is taken as canonical",
    file: "src/ids.ts",
    from: "if (CROCKFORD.indexOf(id[chars - 1] as string) & spare)",
    to: "if (CROCKFORD.indexOf(id[chars - 1] as string) & 0)",
  },
  {
    id: "M20",
    what: "a publish takes an editId older than its post",
    file: "src/lifecycle.ts",
    from: "if (compareBytes(editId, id) < 0) fail(`editId ${editId} predates the post id ${id}`);",
    to: "",
  },
  {
    id: "M21",
    what: "an external reference may spell a pubky or a web scheme",
    file: "src/canonicalize.ts",
    from: 'if (folded.startsWith("pubky") || folded === "http" || folded === "https") return null;',
    to: "",
  },
  {
    id: "M22",
    what: "buildUri spells any id",
    file: "src/uri.ts",
    from: "return named ? uri : fail(",
    to: "return true ? uri : fail(",
  },
  {
    id: "M23",
    what: "no input funnel: the caller's value is read where it lies, getters and all",
    file: "src/input.ts",
    from: "return copy(value, at, 0);",
    to: "return value;",
  },
];

const run = (cmd, argv, timeoutMs) => {
  const r = spawnSync(cmd, argv, { cwd: pkg, encoding: "utf8", timeout: timeoutMs, env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=1536" } });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, timedOut: r.error?.code === "ETIMEDOUT" };
};
const build = () => {
  // A planted bug often leaves a helper unread, which is no reason to stop the pass
  execFileSync("npx", ["--no", "--", "tsc", "-p", ".", "--noUnusedLocals", "false", "--noUnusedParameters", "false"], { cwd: pkg, stdio: "pipe" });
};
const tests = () => {
  const r = run(
    "npx",
    ["--no", "--", "mocha", "vectors.test.js", "edges.test.js", "test.js", "property.test.js", "transforms.test.js", "migration.test.js", "sdk-port.test.js", "cli.test.js"],
    600_000,
  );
  const failing = [...r.out.matchAll(/^\s+\d+\) (.+)$/gm)].map((m) => m[1].trim());
  const passing = Number(/(\d+) passing/.exec(r.out)?.[1] ?? 0);
  return { status: r.status, passing, failing: [...new Set(failing)].slice(0, 12), timedOut: r.timedOut };
};
const chaos = () => {
  const r = run("node", ["--max-old-space-size=1536", "qa/chaos.mjs", "--seeds", String(seeds), "--no-minimize"], 1_200_000);
  const m = /"violations": (\d+)/.exec(r.out.slice(r.out.lastIndexOf('{\n "variant"')));
  const invariants = [...new Set([...r.out.matchAll(/first ([\w-]+):/g)].map((x) => x[1]))];
  return { status: r.status, violatingSeeds: m ? Number(m[1]) : null, invariants, crashed: r.status !== 0 ? r.out.slice(-400) : undefined };
};

const results = [];
const only = flag("--only")?.split(",");
for (const mutation of MUTATIONS.filter((m) => !only || only.includes(m.id))) {
  const file = path.join(pkg, mutation.file ?? "src/migration/engine.ts");
  const clean = fs.readFileSync(file, "utf8");
  if (!clean.includes(mutation.from)) throw new Error(`${mutation.id}: the pattern is not in ${file}`);
  fs.writeFileSync(file, clean.replace(mutation.from, mutation.to));
  let entry;
  try {
    build();
    const t = tests();
    // The chaos harness drives the engine; a bug in the core is the suites' to catch
    const c = mutation.file === undefined || mutation.file.startsWith("src/migration/") ? chaos() : null;
    entry = { id: mutation.id, what: mutation.what, tests: t, chaos: c, caughtByTests: t.status !== 0, caughtByChaos: c === null ? null : c.status !== 0 || c.violatingSeeds > 0 };
  } catch (e) {
    entry = { id: mutation.id, what: mutation.what, buildError: `${e.stdout ?? ""}${e.stderr ?? ""}${e.message}`.slice(0, 600) };
  } finally {
    fs.writeFileSync(file, clean);
  }
  results.push(entry);
  console.log(JSON.stringify(entry));
}
if (flag("--out")) fs.writeFileSync(flag("--out"), JSON.stringify(results, null, 1));
