// What the harnesses share: their flags, their output file, the seeded randomness of the port
// faults, the keys, clock and ids their inputs are made of, how an answer is compared, and the
// package's entries, scratch directories and compilers.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { timestampId } from "../dist/ids.js";

/** The package directory, with its trailing slash. */
export const PKG = fileURLToPath(new URL("..", import.meta.url));

/** Each subpath the package exports, and its module under dist. */
export const ENTRIES = { ".": "index", "./testing": "testing", "./migration": "migration/index", "./migration/pubky-sdk": "migration/adapters/pubky-sdk", "./client": "client/index" };

export const OWNER = "8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo";
export const OTHER = "pxnu33x7jtpx9ar1ytsi4yxbp6a5o36gwhffs8zoxmbuptici1jy";
// 2026-09-22 in milliseconds, inside every time bound
export const NOW_MS = 1_790_000_000_000;

// The unit suites, as mocha globs them; package.json spells the same pattern
export const SUITES = "{test,*.test}.js";

/** The flags of a harness, in `node:util` parseArgs form. A flag it does not know is refused. */
export const flags = (options) => parseArgs({ options }).values;

/** Writes `value` to `file` as JSON, when a file was asked for. */
export const writeOut = (file, value) => {
  if (file) fs.writeFileSync(file, JSON.stringify(value, null, 1));
};

/** An empty `qa/out/<name>`, for what a check writes and removes once it passes. */
export const scratch = (name) => {
  const dir = path.join(PKG, "qa/out", name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

/** The package's TypeScript over the project in `dir`: what it printed, or "" when it passed. */
export const tsc = (dir) => {
  try {
    execFileSync(process.execPath, [path.join(PKG, "node_modules/typescript/bin/tsc"), "-p", dir], { stdio: "pipe" });
    return "";
  } catch (e) {
    return `${e.stdout}${e.stderr}`;
  }
};

/**
 * The built declarations `files` and their checker, as an editor reads them. Through the compiler
 * API, which TypeScript 7 does not ship, so the tools' TypeScript 6 reads them.
 */
export const declarations = (files) => {
  const ts = createRequire(path.join(PKG, "tools/package.json"))("typescript");
  const program = ts.createProgram(files, {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    strict: true,
    noEmit: true,
    types: [],
  });
  return { ts, program, checker: program.getTypeChecker() };
};

/** Uniform draws in [0, 1) from a 32-bit seed, past the first few that track the seed closely. */
export const xorshift = (seed) => {
  let s = (seed ^ 0x9e3779b9) >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
  for (let i = 0; i < 8; i++) next();
  return next;
};

/** The TimestampId of `micros`, which 0.x and 1.x spell alike. */
export const timestampIdOf = (micros) => timestampId(BigInt(micros));

// Key order is no part of an answer
export const canonical = (value) => JSON.stringify(value, (_, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v));

export const sameBytes = (a, b) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(b);

// The engine backs off between retries; a harness has no reason to wait
export const noSleep = () => Promise.resolve();
