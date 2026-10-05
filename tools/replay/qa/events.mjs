// Walks the homeserver's public event feed (`/events/`) to its end and checks, per user, what
// an indexer reading it sees of a migration: the 1.x writes in the engine's pass order, the
// profile last among the public ones, no private path, no delete of a 1.x object.
//
//   node qa/events.mjs [--data data] [--out data/qa/case2_wire_order.json] [--since <cursor>]

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { HOST, replicaUsers } from "../testnet.mjs";

const { values: args } = parseArgs({
  options: {
    data: { type: "string", default: "data" },
    out: { type: "string", default: "data/qa/case2_wire_order.json" },
    since: { type: "string" },
  },
});

// The public 1.x kinds by the pass that writes them; the private ones follow the profile
const PASS = { files: 1, posts: 2, tags: 3, follows: 4, "profile.json": 5, feeds: 6, bookmarks: 7, mutes: 8 };
const passOf = (path) => {
  const m = /^\/(?:pub|priv)\/social\/v1\/([^/]+)/.exec(path);
  return m ? PASS[m[1]] ?? 99 : null;
};

const users = new Set(replicaUsers(args.data).map((u) => u.pk));
const perUser = new Map();
const totals = { lines: 0, pages: 0, put: 0, del: 0, privLines: 0, v1Put: 0, v1Del: 0, otherUsers: 0 };
const privExamples = [];
let cursor = args.since ?? null;
const t0 = Date.now();
for (;;) {
  const url = `http://${HOST}:6286/events/?limit=1000${cursor ? `&cursor=${cursor}` : ""}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status} ${await response.text()}`);
  const lines = (await response.text()).split("\n").filter(Boolean);
  totals.pages++;
  let next = null;
  let events = 0;
  for (const line of lines) {
    if (line.startsWith("cursor: ")) {
      next = line.slice(8).trim();
      continue;
    }
    events++;
    totals.lines++;
    const [type, uri] = line.split(" ");
    const m = /^pubky:\/\/([^/]+)(\/.*)$/.exec(uri);
    const [pk, path] = [m[1], m[2]];
    if (type === "PUT") totals.put++;
    else totals.del++;
    if (path.startsWith("/priv/")) {
      totals.privLines++;
      if (privExamples.length < 10) privExamples.push(line);
    }
    if (!users.has(pk)) {
      totals.otherUsers++;
      continue;
    }
    const pass = passOf(path);
    if (pass === null) continue;
    if (type === "PUT") totals.v1Put++;
    else totals.v1Del++;
    let u = perUser.get(pk);
    if (!u) perUser.set(pk, (u = { seq: [], dels: [] }));
    if (type === "PUT") u.seq.push({ pass, path });
    else u.dels.push(path);
  }
  if (events === 0 || next === null || next === cursor) break;
  cursor = next;
}

const violations = { orderInversions: [], profileNotLast: [], deletes: [] };
let withProfile = 0;
for (const [pk, u] of perUser) {
  // The first migration of a user: its first write of each path, in feed order
  const seen = new Set();
  const first = u.seq.filter((e) => (seen.has(e.path) ? false : seen.add(e.path)));
  for (let i = 1; i < first.length; i++) {
    if (first[i].pass < first[i - 1].pass) {
      violations.orderInversions.push({ user: pk.slice(0, 10), before: first[i - 1].path, after: first[i].path });
      break;
    }
  }
  const pub = first.filter((e) => e.path.startsWith("/pub/"));
  if (pub.some((e) => e.path === "/pub/social/v1/profile.json")) {
    withProfile++;
    if (pub.at(-1).path !== "/pub/social/v1/profile.json") violations.profileNotLast.push({ user: pk.slice(0, 10), last: pub.at(-1).path });
  }
  if (u.dels.length) violations.deletes.push({ user: pk.slice(0, 10), count: u.dels.length, first: u.dels[0] });
}

// The database the feed is served from, for what the feed leaves out
const psql = (q) => execFileSync("docker", ["exec", "replay-pg", "psql", "-U", "postgres", "-h", "127.0.0.1", "-p", "55432", "-tAc", q], { encoding: "utf8" }).trim();
const db = {
  events: Number(psql("select count(*) from events")),
  privEvents: Number(psql("select count(*) from events where path like '/priv/%'")),
  v1PubPut: Number(psql("select count(*) from events where type='PUT' and path like '/pub/social/v1/%'")),
  v1Del: Number(psql("select count(*) from events where type='DEL' and path like '/%/social/v1/%'")),
};

const result = {
  at: new Date().toISOString(),
  seconds: Math.round((Date.now() - t0) / 100) / 10,
  totals,
  db,
  usersWithV1Events: perUser.size,
  usersWithProfile: withProfile,
  violations: {
    orderInversions: violations.orderInversions.length,
    profileNotLast: violations.profileNotLast.length,
    deletes: violations.deletes.length,
    examples: { orderInversions: violations.orderInversions.slice(0, 10), profileNotLast: violations.profileNotLast.slice(0, 10), deletes: violations.deletes.slice(0, 10) },
  },
  privExamples,
};
writeFileSync(args.out, JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
