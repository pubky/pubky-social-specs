// A consumer of the packed tarball, compiled by the TypeScript versions on either side of the
// floor: 5.6 must refuse the import (the types would read as `any`), 5.7 and the latest must
// compile it under each resolution, with the strictest flags and no DOM lib. Run from pkg/
// after a build:
//
//   node qa/ts-floor.mjs

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const pkg = process.cwd();
const dir = mkdtempSync(path.join(tmpdir(), "ts-floor-"));
const run = (cmd, args, cwd = dir) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const tarball = path.join(dir, JSON.parse(run("npm", ["pack", "--json", "--pack-destination", dir], pkg))[0].filename);

writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
writeFileSync(
  path.join(dir, "a.ts"),
  `import { buildPost, hashMedia } from "pubky-social-specs";
import { runMigration } from "pubky-social-specs/migration";
import { sdkPort } from "pubky-social-specs/migration/pubky-sdk";
import { setClock } from "pubky-social-specs/testing";
buildPost("x", { content: "y" });
void [runMigration, sdkPort, hashMedia, setClock];
`,
);
run("npm", ["install", "--silent", "--no-audit", "--no-fund", tarball]);

const RESOLUTIONS = [
  ["nodenext", "nodenext"],
  ["esnext", "bundler"],
  ["commonjs", "node10"],
];
const compile = (version, module, resolution) => {
  run("npm", ["install", "--silent", "--no-audit", "--no-fund", `typescript@${version}`]);
  const flags = ["--noEmit", "--strict", "--target", "es2022", "--lib", "es2020", "--exactOptionalPropertyTypes", "--noUncheckedIndexedAccess", "--module", module, "--moduleResolution", resolution, "a.ts"];
  try {
    run("npx", ["tsc", ...flags]);
    return "";
  } catch (e) {
    return `${e.stdout}${e.stderr}`;
  }
};

let failed = false;
const expect = (label, ok, detail) => {
  failed ||= !ok;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `\n${detail}`}`);
};
for (const [module, resolution] of RESOLUTIONS) {
  const below = compile("5.6", module, resolution);
  expect(`TypeScript 5.6, ${resolution}: refused loudly`, below.includes("TS2305"), below);
  const floor = compile("5.7", module, resolution);
  expect(`TypeScript 5.7, ${resolution}: compiles`, floor === "", floor);
}
for (const [module, resolution] of RESOLUTIONS.slice(0, 2)) {
  const latest = compile("latest", module, resolution);
  expect(`TypeScript latest, ${resolution}: compiles`, latest === "", latest);
}
process.exit(failed ? 1 : 0);
