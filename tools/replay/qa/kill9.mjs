// SIGKILL the CLI at random points of one user's run, then let a run finish, and audit what
// the homeserver took: the user's 1.x tree is deleted first, each kill lands at a random point
// within 0 to 80 percent of the time the rest of the run is expected to take, and the rerun
// must converge to the tree replay_verify expects with no 1.x path written twice with other bytes.
//
//   node qa/kill9.mjs --only <pk> --expected-ms <ms> [--kills 10] [--seed 1] --out <dir>

import path from "node:path";
import { parseArgs } from "node:util";
import { replicaUsers, resetV1 } from "../testnet.mjs";
import { dump, eventsOf, json, lastEventId, record, startCli, runCli, verify, writeAudit } from "./lib.mjs";

const { values: args } = parseArgs({
  options: {
    data: { type: "string", default: "data" },
    only: { type: "string" },
    "expected-ms": { type: "string" },
    kills: { type: "string", default: "10" },
    seed: { type: "string", default: "1" },
    out: { type: "string" },
    "no-reset": { type: "boolean", default: false },
  },
});
const user = replicaUsers(args.data, [args.only])[0];
const expected = Number(args["expected-ms"]);
let state = Number(args.seed) >>> 0;
// mulberry32, so a run's delays can be drawn again
const random = () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const t0 = Date.now();
const deleted = args["no-reset"] ? 0 : await resetV1(user);
const since = lastEventId();
const kills = [];
let remaining = 1;
for (let i = 0; i < Number(args.kills); i++) {
  const delay = Math.round(random() * 0.8 * expected * remaining);
  let last = null;
  const run = startCli(user, { onLine: (line) => { if (/^(migrating|listing|probe|flag)/.test(line)) last = line; } });
  const timer = setTimeout(() => run.child.kill("SIGKILL"), delay);
  const result = await run.done;
  clearTimeout(timer);
  const m = /: (\d+)\/(\d+)$/.exec(last ?? "");
  if (m && Number(m[2]) > 0) remaining = Math.max(0.05, 1 - Number(m[1]) / Number(m[2]));
  kills.push({ delayMs: delay, ranMs: result.ms, signal: result.signal, exit: result.exit, lastLine: last, status: result.report?.status ?? null, ioError: result.report?.counts?.io_error ?? null });
  console.error(`kill ${i + 1}: after ${delay} ms, ${result.signal ?? `exit ${result.exit}`}, last "${last}"`);
}
const final = await runCli(user);
const reports = path.join(args.out, "reports");
const actual = path.join(args.out, "actual");
record(args.data, reports, user, final);
await dump(args.data, actual, user);
const audit = writeAudit(eventsOf(user.pk, since));
const v = verify(args.data, { reports, actual, out: path.join(args.out, "verify"), users: [user], flags: ["--resumed"] });
const result = {
  user: user.pk.slice(0, 10),
  expectedMs: expected,
  deletedBefore: deleted,
  kills,
  final: { status: final.report?.status, exit: final.exit, ms: final.ms, counts: Object.fromEntries(Object.entries(final.report?.counts ?? {}).filter(([, n]) => n > 0)) },
  audit,
  verify: { mismatchedUsers: v.summary.mismatched_users, kinds: v.summary.mismatch_kinds, examples: v.summary.mismatch_examples?.slice(0, 5) },
  seconds: Math.round((Date.now() - t0) / 1000),
};
json(path.join(args.out, "result.json"), result);
console.log(JSON.stringify(result, null, 1));
