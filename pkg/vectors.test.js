// The recorded vectors (vectors/js/<family>.jsonl): what the crate answered, replayed offline
// against the package, one test per family. `qa/score.mjs` replays the same rows and adds the
// fuzz against a live oracle.

import assert from "assert";
import fs from "node:fs";
import { ArgumentError, foldWebTarget, limits, validateTag, ValidationError } from "./dist/index.js";
import { answer } from "./qa/ops.mjs";

const dir = new URL("../vectors/js/", import.meta.url);
// Key order is no part of an answer
const canonical = (value) => JSON.stringify(value, (_, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v));

// The writer fold of a web reference (vectors/web_target.json), which the crate's
// tests/web_target_vectors.rs reads too
describe("the web target vectors", () => {
  const corpus = JSON.parse(fs.readFileSync(new URL("../vectors/web_target.json", import.meta.url), "utf8"));
  it("folds every input to its spelling, a fixed point the web gate keeps", () => {
    assert.ok(corpus.fold.length > 0);
    for (const row of corpus.fold) {
      assert.strictEqual(foldWebTarget(row.in), row.out, JSON.stringify(row));
      assert.strictEqual(foldWebTarget(row.out), row.out, JSON.stringify(row));
      assert.strictEqual(validateTag({ uri: row.out, label: "x" }).success, true, JSON.stringify(row));
    }
  });
  it("refuses every input that is no web reference", () => {
    assert.ok(corpus.refused.length > 0);
    for (const row of corpus.refused)
      assert.throws(
        () => foldWebTarget(row.in),
        (e) => e instanceof ValidationError && e.code === "reference" && e.field === "target",
        JSON.stringify(row),
      );
  });
  it("refuses an argument that is no string", () => {
    assert.throws(
      () => foldWebTarget(1),
      (e) => e instanceof ArgumentError && e.field === "target",
    );
  });
  it("can take a target at the length cap one code point past it, with the / of an empty path", () => {
    const atCap = `https://${"a".repeat(limits.referenceUriMaxLength - "https://".length)}`;
    assert.strictEqual(validateTag({ uri: atCap, label: "x" }).success, true);
    assert.strictEqual(foldWebTarget(atCap), `${atCap}/`);
    assert.strictEqual(validateTag({ uri: `${atCap}/`, label: "x" }).success, false);
  });
});

describe("the recorded vectors", () => {
  for (const name of fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()) {
    it(`answers every ${name.slice(0, -6)} request as the crate did`, () => {
      const rows = fs
        .readFileSync(new URL(name, dir), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      assert.ok(rows.length > 0);
      for (const { q, a } of rows) assert.strictEqual(canonical(answer(q)), canonical(a), JSON.stringify(q));
    });
  }
});
