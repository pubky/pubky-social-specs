// Line and branch coverage of src per module, from the suites run on the sources, against a
// floor per module. The floors are what the suites reach today, rounded down: a drop fails.
//   npm run coverage   (writes qa/out/coverage, prints the table)

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const out = `${pkg}qa/out/coverage`;
const suites = [
  "vectors.test.js",
  "edges.test.js",
  "test.js",
  "property.test.js",
  "validate.test.js",
  "transforms.test.js",
  "migration.test.js",
  "sdk-port.test.js",
  "client.test.js",
  "cli.test.js",
].filter((f) => fs.existsSync(`${pkg}${f}`));
const run = spawnSync(
  process.execPath,
  [
    `${pkg}node_modules/c8/bin/c8.js`,
    "--reporter=json-summary",
    "--reporter=text",
    `--reports-dir=${out}`,
    "--include=src/**",
    "--exclude=src/**/*.d.ts",
    process.execPath,
    "--import",
    "./qa/from-src.mjs",
    "node_modules/mocha/bin/mocha.js",
    ...suites,
  ],
  { cwd: pkg, stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, FC_RUNS: process.env.FC_RUNS ?? "50" } },
);
if (run.status !== 0) process.exit(run.status ?? 1);

// [lines, branches] per module, by path prefix under src; the first match applies. Each is
// what the suites reach, rounded down to the point below
const FLOORS = [
  ["src/models/", [96, 90]],
  ["src/json/", [98, 94]],
  ["src/client/", [95, 90]],
  ["src/migration/engine.ts", [95, 93]],
  ["src/migration/wasm.ts", [96, 87]],
  ["src/migration/", [99, 97]],
  ["src/objects.ts", [98, 88]],
  // The branch for a host with no process never runs under Node
  ["src/dev.ts", [100, 88]],
  ["src/", [98, 90]],
];
const summary = JSON.parse(fs.readFileSync(`${out}/coverage-summary.json`, "utf8"));
const low = [];
for (const [file, cover] of Object.entries(summary)) {
  if (file === "total") continue;
  const rel = file.slice(pkg.length);
  const [lines, branches] = FLOORS.find(([prefix]) => rel.startsWith(prefix))[1];
  if (cover.lines.pct < lines || cover.branches.pct < branches) low.push(`${rel}: lines ${cover.lines.pct}% (floor ${lines}), branches ${cover.branches.pct}% (floor ${branches})`);
}
if (low.length > 0) {
  console.error(`under the floor:\n  ${low.join("\n  ")}`);
  process.exit(1);
}
console.log(`coverage: every module at or above its floor (total lines ${summary.total.lines.pct}%, branches ${summary.total.branches.pct}%)`);
