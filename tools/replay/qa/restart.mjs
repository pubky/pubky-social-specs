// The homeserver restarted under a running CLI: the run has to end with a report, not crash,
// and a rerun has to converge.
//
//   node qa/restart.mjs --only <pk> --after-ms <ms> --out <dir> [--stop-ms <ms>]
//
// `--stop-ms` keeps the homeserver stopped that long before starting it again, beyond the
// engine's network retries.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { parseArgs } from "node:util";
import { replicaUsers, resetV1, restart, up } from "../testnet.mjs";
import { dump, eventsOf, json, lastEventId, record, runCli, startCli, verify, writeAudit } from "./lib.mjs";

const { values: args } = parseArgs({
  options: { data: { type: "string", default: "data" }, only: { type: "string" }, "after-ms": { type: "string" }, "stop-ms": { type: "string" }, out: { type: "string" } },
});
const user = replicaUsers(args.data, [args.only])[0];
const deleted = await resetV1(user);
const since = lastEventId();
let last = null;
const run = startCli(user, { onLine: (line) => { if (/: \d+\/\d+$/.test(line)) last = line; } });
await new Promise((r) => setTimeout(r, Number(args["after-ms"])));
const atRestart = last;
const r0 = Date.now();
if (args["stop-ms"]) {
  execFileSync("docker", ["stop", "replay-testnet"]);
  await new Promise((r) => setTimeout(r, Number(args["stop-ms"])));
  await up(args.data);
} else await restart(args.data);
const restartMs = Date.now() - r0;
const first = await run.done;
const notes = first.report?.notes ?? [];
const rerun = await runCli(user);
const reports = path.join(args.out, "reports");
const actual = path.join(args.out, "actual");
record(args.data, reports, user, rerun);
await dump(args.data, actual, user);
const audit = writeAudit(eventsOf(user.pk, since));
const v = verify(args.data, { reports, actual, out: path.join(args.out, "verify"), users: [user], flags: ["--resumed"] });
const nz = (c) => Object.fromEntries(Object.entries(c ?? {}).filter(([, n]) => n > 0));
const result = {
  user: user.pk.slice(0, 10),
  deletedBefore: deleted,
  restartAfterMs: Number(args["after-ms"]),
  stoppedMs: args["stop-ms"] ? Number(args["stop-ms"]) : null,
  restartTookMs: restartMs,
  progressAtRestart: atRestart,
  first: { exit: first.exit, signal: first.signal, ms: first.ms, status: first.report?.status ?? null, error: first.report?.error ?? null, counts: nz(first.report?.counts), noteKinds: [...new Set(notes.map((n) => n.message.slice(0, 120)))].slice(0, 10), stderrTail: first.report ? undefined : first.stderr.split("\n").slice(-8) },
  rerun: { exit: rerun.exit, ms: rerun.ms, status: rerun.report?.status, counts: nz(rerun.report?.counts) },
  audit,
  verify: { mismatchedUsers: v.summary.mismatched_users, kinds: v.summary.mismatch_kinds, examples: v.summary.mismatch_examples?.slice(0, 5) },
};
json(path.join(args.out, "result.json"), result);
console.log(JSON.stringify(result, null, 1));
