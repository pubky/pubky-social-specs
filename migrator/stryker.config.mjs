// Mutation testing of the engine's claim logic: Stryker plants one change at a time in a copy of
// the package and counts the ones no test catches. The core has its own.
//
//   npx stryker run          (nightly in CI; the report lands in qa/out/stryker)

import fs from "node:fs";
import path from "node:path";

// The sandbox is a copy of migrator/ two levels under qa/out, so the suites find ../pkg, its
// fixtures and the core it imports through a link
const temp = "qa/out/stryker";
fs.mkdirSync(temp, { recursive: true });
if (!fs.existsSync(`${temp}/pkg`)) fs.symlinkSync(path.resolve("../pkg"), `${temp}/pkg`);

/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  mutate: [
    // keyOf and claimKey; taking the claims in #migrateOne, then #copy, #holds, #landed and
    // #claim, leaving out #fence between them. Line ranges: move them with the code
    "src/engine.ts:157-167",
    "src/engine.ts:458-473",
    "src/engine.ts:491-606",
  ],
  // The mocha runner does not take mocha 12 yet, so each mutant runs the suites as a command,
  // the fastest killers first and stopping at the first failure
  testRunner: "command",
  commandRunner: {
    command: "FC_RUNS=30 NODE_OPTIONS=--max-old-space-size=1024 npx --no -- mocha --bail migration.test.js",
  },
  buildCommand: "npx tsc -p .",
  // Stryker rewrites the extends and references of this file through the TypeScript 5 API,
  // which TypeScript 7 does not ship; tsconfig.json has neither, so it is pointed at no file
  tsconfigFile: "no-tsconfig-to-rewrite.json",
  coverageAnalysis: "off",
  concurrency: 2,
  timeoutMS: 30_000,
  tempDirName: temp,
  ignorePatterns: ["qa/out", "qa/failures", "e2e", "api", "dist/*.map", "dist/**/*.map"],
  reporters: ["clear-text", "progress", "json"],
  jsonReporter: { fileName: `${temp}/report.json` },
  // The floor is the score the suites reach, less the mutants no input can tell apart; TESTING.md lists those
  thresholds: { high: 100, low: 95, break: 96 },
};
