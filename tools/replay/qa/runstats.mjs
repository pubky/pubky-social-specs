// The numbers of a Node pass over the replica: per-user time distribution, the slowest users
// with their object counts and blob bytes, and the throughput over the pass's wall time.
//
//   node qa/runstats.mjs [--data data] [--reports data/reports] [--out <file>]

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { seedEpoch, walk } from "../testnet.mjs";
import { json, stats } from "./lib.mjs";

const { values: args } = parseArgs({ options: { data: { type: "string", default: "data" }, reports: { type: "string" }, out: { type: "string" } } });
const reportsDir = args.reports ?? path.join(args.data, "reports");
const epoch = seedEpoch(args.data);
const records = readdirSync(reportsDir)
  .filter((f) => f.endsWith(".json") && f !== "summary.json")
  .map((f) => JSON.parse(readFileSync(path.join(reportsDir, f), "utf8")))
  .filter((r) => r.seedEpoch === epoch);
const summary = JSON.parse(readFileSync(path.join(reportsDir, "summary.json"), "utf8"));
const sizes = (pk) => {
  const root = path.join(args.data, "replica", pk);
  let bytes = 0;
  let blobBytes = 0;
  for (const p of walk(root)) {
    const s = statSync(path.join(root, p)).size;
    bytes += s;
    if (p.startsWith("pub/pubky.app/blobs/")) blobBytes += s;
  }
  return { bytes, blobBytes };
};
let objects = 0;
let bytes = 0;
const rows = records.map((r) => {
  const s = sizes(r.pk);
  objects += r.report?.total ?? 0;
  bytes += s.bytes;
  return { user: r.pk.slice(0, 10), ms: r.ms, objects: r.report?.total, written: r.report?.counts?.written, status: r.report?.status, ...s };
});
const wall = summary.wallSeconds;
const result = {
  users: records.length,
  status: summary.status,
  wallSeconds: wall,
  sessions: summary.sessions?.map((s) => ({ wallSeconds: s.wallSeconds, users: s.users })),
  perUserMs: stats(records.map((r) => r.ms)),
  slowest: rows.sort((a, b) => b.ms - a.ms).slice(0, 5),
  objects,
  v0Bytes: bytes,
  throughput: { objectsPerSecond: Math.round((objects / wall) * 10) / 10, bytesPerSecond: Math.round(bytes / wall) },
  counts: Object.fromEntries(Object.entries(summary.counts ?? {}).filter(([, n]) => n > 0)),
};
if (args.out) json(args.out, result);
console.log(JSON.stringify(result, null, 1));
