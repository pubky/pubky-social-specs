// Every user nexus knows, with the homeserver it indexed them on, for crawl.mjs.
//
//   node users.mjs [--out data/users.json] [--scout https://nexus-scout.pubky.app]

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    out: { type: "string", default: "data/users.json" },
    scout: { type: "string", default: "https://nexus-scout.pubky.app" },
  },
});

// nexus-scout caps a query at 100 rows
const PAGE = 100;

const query = async (cypher) => {
  const res = await fetch(`${args.scout}/v1/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cypher }),
  });
  if (!res.ok) throw new Error(`nexus-scout ${res.status}: ${await res.text()}`);
  return (await res.json()).results;
};

const [{ n: total }] = await query("MATCH (u:User) RETURN count(u) AS n");
const users = [];
for (let skip = 0; skip < total; skip += PAGE) {
  const rows = await query(
    "MATCH (u:User) OPTIONAL MATCH (u)-[:HOSTED_BY]->(h) " +
      `RETURN u.id AS id, h.id AS hs ORDER BY u.id SKIP ${skip} LIMIT ${PAGE}`,
  );
  for (const { id, hs } of rows) users.push({ id, hs: hs ?? null });
}
if (users.length !== total || new Set(users.map((u) => u.id)).size !== total) {
  throw new Error(`expected ${total} distinct users, paged ${users.length}`);
}

mkdirSync(path.dirname(args.out), { recursive: true });
writeFileSync(args.out, JSON.stringify(users, null, 1) + "\n");
const byHs = {};
for (const { hs } of users) byHs[hs] = (byHs[hs] ?? 0) + 1;
console.log(`${users.length} users written to ${args.out}`);
console.log(byHs);
