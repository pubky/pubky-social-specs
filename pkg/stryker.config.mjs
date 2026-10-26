// Mutation testing of the core: Stryker plants one change at a time in a copy of the package and
// counts the ones no test catches. The migrator has its own, over the engine's claim logic.
//
//   npx stryker run          (nightly in CI; the report lands in qa/out/stryker)

import fs from "node:fs";
import path from "node:path";

// The sandbox is a copy of pkg/ two levels under qa/out, so the tests find ../vectors through a link
const temp = "qa/out/stryker";
fs.mkdirSync(temp, { recursive: true });
if (!fs.existsSync(`${temp}/vectors`)) fs.symlinkSync(path.resolve("../vectors"), `${temp}/vectors`);

/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  mutate: ["src/ids.ts", "src/clock.ts", "src/canonicalize.ts", "src/deletion.ts", "src/lifecycle.ts"],
  // The mocha runner does not take mocha 12 yet, so each mutant runs the suites as a command,
  // the fastest killers first and stopping at the first failure
  testRunner: "command",
  commandRunner: {
    command: "FC_RUNS=30 NODE_OPTIONS=--max-old-space-size=1024 npx --no -- mocha --bail vectors.test.js edges.test.js test.js property.test.js",
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
