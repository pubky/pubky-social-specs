// The scoreboard: per family, how many recorded vectors the package answers as the reference
// did, and how many of N fresh seeded cases it answers differently from the oracle. Exits 0
// only when every family is implemented and clean.
//
//   node qa/score.mjs [--fuzz 2000] [--seed 1] [--family text] [--record]
//
// --record writes the vectors (vectors/js/<family>.jsonl) from the oracle instead of scoring.

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { ask } from "./oracle.mjs";
import { answer } from "./ops.mjs";
import { families, rng } from "./gen.mjs";

const flag = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : process.argv[at + 1] ?? true;
};
const cases = Number(flag("fuzz", 2000));
const seed = Number(flag("seed", 1));
const only = flag("family");
const record = process.argv.includes("--record");
const vectorsDir = fileURLToPath(new URL("../../vectors/js/", import.meta.url));
const failuresDir = fileURLToPath(new URL("./failures/", import.meta.url));
// Recorded at a fixed seed, so a regenerated file differs only where an answer moved
const RECORDED = { seed: 20261007, cases: 400 };

// Key order is no part of an answer
const canonical = (value) =>
  JSON.stringify(value, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v,
  );

function requests(family, fromSeed, count) {
  const r = rng(fromSeed ^ [...family].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7));
  return Array.from({ length: count }, () => families[family](r));
}

function differing(asked, reference) {
  let missing = 0;
  const wrong = [];
  asked.forEach((q, i) => {
    const got = answer(q);
    if (got.missing) missing++;
    else if (canonical(got) !== canonical(reference[i])) wrong.push({ q, want: reference[i], got });
  });
  return { missing, wrong };
}

let clean = true;
for (const family of Object.keys(families)) {
  if (only && only !== family) continue;
  const file = `${vectorsDir}${family}.jsonl`;
  if (record) {
    const asked = requests(family, RECORDED.seed, RECORDED.cases);
    const reference = await ask(asked);
    fs.mkdirSync(vectorsDir, { recursive: true });
    fs.writeFileSync(file, asked.map((q, i) => JSON.stringify({ q, a: reference[i] })).join("\n") + "\n");
    console.log(`${family}: recorded ${asked.length}`);
    continue;
  }
  const rows = fs.existsSync(file)
    ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const vectors = differing(rows.map((row) => row.q), rows.map((row) => row.a));
  const asked = requests(family, seed, cases);
  const fuzz = differing(asked, await ask(asked));
  const wrong = [...vectors.wrong, ...fuzz.wrong];
  const missing = vectors.missing + fuzz.missing;
  if (wrong.length || missing || !rows.length) clean = false;
  if (wrong.length) {
    fs.mkdirSync(failuresDir, { recursive: true });
    fs.writeFileSync(`${failuresDir}${family}.json`, JSON.stringify(wrong.slice(0, 50), null, 1));
  } else fs.rmSync(`${failuresDir}${family}.json`, { force: true });
  console.log(
    `${family.padEnd(10)} vectors ${rows.length - vectors.wrong.length - vectors.missing}/${rows.length}` +
      `  fuzz ${fuzz.wrong.length} wrong of ${cases}  unimplemented ${missing}`,
  );
}
process.exit(clean ? 0 : 1);
