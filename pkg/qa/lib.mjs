// What the harnesses share: their flags, their output file, the seeded randomness of the port
// faults, the keys, clock and ids their inputs are made of, and how an answer is compared.

import fs from "node:fs";
import { parseArgs } from "node:util";
import { timestampId } from "../dist/ids.js";

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
