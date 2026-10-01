// The CLI on a clock off by `--offset-ms`, through qa/clock-shim.cjs, over users whose 1.x tree
// is deleted first; each run is verified against the oracle, which runs on the true clock.
//
//   node qa/clock.mjs --offset-ms <ms> --only <pk>... --out <dir> [--data data] [--after-signin]
//                     [--no-reset] [--rescan]

import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { replicaUsers, resetV1 } from "../testnet.mjs";
import { dump, json, record, runCli, verify } from "./lib.mjs";

const { values: args } = parseArgs({
  options: {
    data: { type: "string", default: "data" },
    only: { type: "string", multiple: true },
    "offset-ms": { type: "string" },
    out: { type: "string" },
    "after-signin": { type: "boolean", default: false },
    scope: { type: "string" },
    reset: { type: "boolean", default: true },
    rescan: { type: "boolean", default: false },
  },
  allowNegative: true,
});
const shim = fileURLToPath(new URL("./clock-shim.cjs", import.meta.url));
const env = {
  NODE_OPTIONS: `--require ${shim}`,
  QA_CLOCK_OFFSET_MS: args["offset-ms"],
  ...(args["after-signin"] ? { QA_CLOCK_AFTER_SIGNIN: "1" } : {}),
  ...(args.scope ? { QA_CLOCK_SCOPE: args.scope } : {}),
};
const reports = path.join(args.out, "reports");
const actual = path.join(args.out, "actual");
const rows = [];
const users = replicaUsers(args.data, args.only);
for (const user of users) {
  if (args.reset) await resetV1(user);
  const r = await runCli(user, { env, rescan: args.rescan });
  record(args.data, reports, user, r, { rescan: args.rescan });
  if (r.report) await dump(args.data, actual, user);
  rows.push({
    user: user.pk.slice(0, 10),
    exit: r.exit,
    ms: r.ms,
    status: r.report?.status ?? null,
    counts: Object.fromEntries(Object.entries(r.report?.counts ?? {}).filter(([, n]) => n > 0)),
    skipped: r.report?.skipped,
    notes: r.report?.notes?.slice(0, 10),
    stderrTail: r.report ? undefined : r.stderr.split("\n").slice(-5),
  });
}
const v = verify(args.data, { reports, actual, out: path.join(args.out, "verify"), users, flags: args.rescan ? ["--resumed"] : [] });
const result = { offsetMs: Number(args["offset-ms"]), afterSignin: args["after-signin"], scope: args.scope ?? "process", rows, verify: { mismatchedUsers: v.summary.mismatched_users, kinds: v.summary.mismatch_kinds, examples: v.summary.mismatch_examples?.slice(0, 12) } };
json(path.join(args.out, "result.json"), result);
console.log(JSON.stringify(result, null, 1));
