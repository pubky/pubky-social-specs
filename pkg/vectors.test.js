// The recorded vectors (vectors/js/<family>.jsonl): what the crate answered, replayed offline
// against the package, one test per family. `qa/score.mjs` replays the same rows and adds the
// fuzz against a live oracle.

import assert from "assert";
import fs from "node:fs";
import { answer } from "./qa/ops.mjs";

const dir = new URL("../vectors/js/", import.meta.url);
// Key order is no part of an answer
const canonical = (value) => JSON.stringify(value, (_, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v));

describe("the recorded vectors", () => {
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()) {
    it(`answers every ${name.slice(0, -6)} request as the crate did`, () => {
      const rows = fs.readFileSync(new URL(name, dir), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
      assert.ok(rows.length > 0);
      for (const { q, a } of rows) assert.strictEqual(canonical(answer(q)), canonical(a), JSON.stringify(q));
    });
  }
});
