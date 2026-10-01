// Two migrations of one user at once, from a deleted 1.x tree: two CLIs, or a CLI and Chromium.
// Each run keeps its own record; the tree is dumped once both ended and verified against each
// record, and the homeserver's events say whether any 1.x path was written twice with other
// bytes or deleted.
//
//   node qa/twodevices.mjs --only <pk> --with cli|chromium --out <dir>

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { replicaUsers, resetV1 } from "../testnet.mjs";
import { dump, eventsOf, json, lastEventId, record, runCli, verify, writeAudit } from "./lib.mjs";

const { values: args } = parseArgs({
  options: { data: { type: "string", default: "data" }, only: { type: "string" }, with: { type: "string", default: "cli" }, out: { type: "string" } },
});
const here = path.dirname(fileURLToPath(import.meta.url));
const user = replicaUsers(args.data, [args.only])[0];
const deleted = await resetV1(user);
const since = lastEventId();
const dirA = path.join(args.out, "reports-a");
const dirB = path.join(args.out, "reports-b");
const actual = path.join(args.out, "actual");

const second = () => {
  if (args.with === "cli") return runCli(user).then((r) => (record(args.data, dirB, user, r), r));
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [path.join(here, "../browser.mjs"), "--data", args.data, "--only", user.pk, "--reports", dirB, "--no-dump"], { stdio: ["ignore", "pipe", "inherit"] });
    child.on("close", () => {
      const rec = JSON.parse(readFileSync(path.join(dirB, `${user.pk}.json`), "utf8"));
      resolve({ ms: Date.now() - t0, report: rec.report, browserMs: rec.ms });
    });
  });
};
const t0 = Date.now();
const [a, b] = await Promise.all([runCli(user).then((r) => (record(args.data, dirA, user, r), r)), second()]);
const wall = Date.now() - t0;
await dump(args.data, actual, user);
const audit = writeAudit(eventsOf(user.pk, since));
const vA = verify(args.data, { reports: dirA, actual, out: path.join(args.out, "verify-a"), users: [user], flags: ["--resumed"] });
const vB = verify(args.data, { reports: dirB, actual, out: path.join(args.out, "verify-b"), users: [user], flags: ["--resumed"] });
const brief = (r) => ({ status: r.report?.status, ms: r.ms, counts: Object.fromEntries(Object.entries(r.report?.counts ?? {}).filter(([, n]) => n > 0)) });
const writtenSum = (a.report?.counts?.written ?? 0) + (b.report?.counts?.written ?? 0);
const result = {
  user: user.pk.slice(0, 10),
  with: args.with,
  deletedBefore: deleted,
  wallMs: wall,
  a: brief(a),
  b: brief(b),
  audit,
  // Each object a run counts written put at least one 1.x path; two runs racing on one object both count it
  writtenSum,
  verify: {
    a: { mismatchedUsers: vA.summary.mismatched_users, kinds: vA.summary.mismatch_kinds, examples: vA.summary.mismatch_examples?.slice(0, 5) },
    b: { mismatchedUsers: vB.summary.mismatched_users, kinds: vB.summary.mismatch_kinds, examples: vB.summary.mismatch_examples?.slice(0, 5) },
  },
};
json(path.join(args.out, "result.json"), result);
console.log(JSON.stringify(result, null, 1));
