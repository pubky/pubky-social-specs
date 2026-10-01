// Mutation pass over the engine: plants one bug at a time in migration/engine.ts, recompiles
// the engine, runs the package's Node tests and a slice of the chaos harness, and puts the
// source back. A mutation nothing catches is a gap in the suite.
//
//   node qa/mutate.mjs [--seeds 150] [--only M3] [--out file.json]

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkg = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const enginePath = path.join(pkg, "migration/engine.ts");
const original = fs.readFileSync(enginePath, "utf8");
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
    from: "if (!this.#roots.some((root) => write.meta.url.startsWith(root))) {",
    to: "if (false) {",
  },
  {
    id: "M5",
    what: "the File objects are walked after the posts",
    file: "migration/order.ts",
    from: 'const BUCKETS = [\n  "files",\n  "blobs",\n  "posts",',
    to: 'const BUCKETS = [\n  "blobs",\n  "posts",\n  "files",',
  },
  {
    id: "M6",
    what: "a copy someone else wrote first counts as made, so the race guard may delete it",
    from: "} else if (put.failed === \"exists\") {\n        // Written by someone else since the LIST: theirs stays, and it is not this run's to delete\n        claim.settle(true);",
    to: "} else if (put.failed === \"exists\") {\n        made.push(claim);",
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
    from: "if (!page.next || page.next === cursor) return urls;",
    to: "if (page.urls.length >= 0) return urls;",
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
    from: "if (bucket === \"files\") {\n        throw new Stop({ code: \"IO_ERROR\", message: `reading ${path}: ${bytes.message}` });\n      }",
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
    what: "no oversize check before hashing: a blob over the cap is hashed whole before the wasm refuses it",
    from: 'if (bucket === "blobs" && bytes.length > validationLimits.maxFileSizeBytes) {\n      return this.#count("oversize", path);\n    }',
    to: "",
  },
];

const run = (cmd, argv, timeoutMs) => {
  const r = spawnSync(cmd, argv, { cwd: pkg, encoding: "utf8", timeout: timeoutMs, env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=1536" } });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, timedOut: r.error?.code === "ETIMEDOUT" };
};
const build = () => {
  execFileSync("npx", ["--no", "--", "tsc", "-p", "migration"], { cwd: pkg, stdio: "pipe" });
  execFileSync("node", ["../src/bin/patch.mjs", "migration"], { cwd: pkg, stdio: "pipe" });
};
const tests = () => {
  const r = run("npx", ["--no", "--", "mocha", "test.js", "migration.test.js", "sdk-port.test.js", "cli.test.js"], 600_000);
  const failing = [...r.out.matchAll(/^\s+\d+\) (.+)$/gm)].map((m) => m[1].trim());
  const passing = Number(/(\d+) passing/.exec(r.out)?.[1] ?? 0);
  return { status: r.status, passing, failing: [...new Set(failing)].slice(0, 12), timedOut: r.timedOut };
};
const chaos = () => {
  const r = run("node", ["--max-old-space-size=1536", "qa/chaos.mjs", "--seeds", String(seeds), "--no-minimize"], 1_200_000);
  const m = /"violations": (\d+)/.exec(r.out.slice(r.out.lastIndexOf("{\n \"variant\"")));
  const invariants = [...new Set([...r.out.matchAll(/first ([\w-]+):/g)].map((x) => x[1]))];
  return { status: r.status, violatingSeeds: m ? Number(m[1]) : null, invariants, crashed: r.status !== 0 ? r.out.slice(-400) : undefined };
};

const results = [];
const only = flag("--only")?.split(",");
const files = new Map();
try {
  for (const mutation of MUTATIONS.filter((m) => !only || only.includes(m.id))) {
    const file = path.join(pkg, mutation.file ?? "migration/engine.ts");
    const source = files.get(file) ?? fs.readFileSync(file, "utf8");
    files.set(file, source);
    if (!source.includes(mutation.from)) throw new Error(`${mutation.id}: the pattern is not in ${file}`);
    fs.writeFileSync(file, source.replace(mutation.from, mutation.to));
    let entry;
    try {
      build();
      const t = tests();
      const c = chaos();
      entry = { id: mutation.id, what: mutation.what, tests: t, chaos: c, caughtByTests: t.status !== 0, caughtByChaos: c.status !== 0 || c.violatingSeeds > 0 };
    } catch (e) {
      entry = { id: mutation.id, what: mutation.what, buildError: `${e.stdout ?? ""}${e.stderr ?? ""}${e.message}`.slice(0, 600) };
    } finally {
      fs.writeFileSync(file, source);
    }
    results.push(entry);
    console.log(JSON.stringify(entry));
  }
} finally {
  for (const [file, source] of files) fs.writeFileSync(file, source);
  build();
}
if (fs.readFileSync(enginePath, "utf8") !== original) throw new Error("engine.ts was not restored");
if (flag("--out")) fs.writeFileSync(flag("--out"), JSON.stringify(results, null, 1));
