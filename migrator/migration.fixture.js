// The 0.x tree of the semantic vectors, for the tests and the live run: every File, then each
// vector input at its path (several rows share a path; the first one is stored), and a
// settings.json. `owner` moves it into another pubky's tree.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const corpus = require("../vectors/semantic/v0_to_v1.json");
const encoder = new TextEncoder();

/**
 * Owner-relative path to `{raw}` (bytes as written) or `{body}` (a JSON object), each with the
 * `expected` migration of its vector.
 */
const legacyTree = (owner = corpus.owner) => {
  const move = (text) => text.replaceAll(corpus.owner, owner);
  const moved = (value) => JSON.parse(move(JSON.stringify(value)));
  const rows = new Map();
  const add = (path, input, expected) => {
    if (rows.has(path)) return;
    const stored = "raw" in input ? { raw: move(input.raw) } : { body: moved(input.body) };
    rows.set(path, { ...stored, expected: moved(expected) });
  };
  for (const file of corpus.files) add(`pub/pubky.app/files/${file.tsid}`, file, { writes: [] });
  for (const { input, expected } of corpus.vectors) add(input.path, input, expected);
  add("pub/pubky.app/settings.json", { body: { language: "en" } }, { skip: "not_migrated" });
  return rows;
};

const bytesOf = (row) => encoder.encode("raw" in row ? row.raw : JSON.stringify(row.body));

export { corpus, legacyTree, bytesOf };
