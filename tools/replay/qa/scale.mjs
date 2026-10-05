// The synthetic boundary users through the CLI one at a time, with the CLI's peak resident set
// (VmHWM, polled) and its pace per pass from the progress lines, then replay_verify over them.
//
//   node qa/scale.mjs [--data data/qa/synth] [--only <pk>]... --out <dir>

import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { replicaUsers } from "../testnet.mjs";
import { dump, json, record, startCli, verify } from "./lib.mjs";

const { values: args } = parseArgs({ options: { data: { type: "string", default: "data/qa/synth" }, only: { type: "string", multiple: true }, out: { type: "string" } } });
const names = Object.fromEntries(Object.entries(JSON.parse(readFileSync(path.join(args.data, "users.json"), "utf8"))).map(([n, pk]) => [pk, n]));
const users = replicaUsers(args.data, args.only).sort((a, b) => (names[a.pk] === "posts50k") - (names[b.pk] === "posts50k"));
const reports = path.join(args.out, "reports");
const actual = path.join(args.out, "actual");
const rows = [];
for (const user of users) {
  const marks = [];
  const run = startCli(user, { onLine: (line, ms) => { const m = /^(\w+(?: \w+)?): (\d+)\/(\d+)$/.exec(line); if (m) marks.push({ ms, step: m[1], done: Number(m[2]) }); } });
  let peak = 0;
  const hwm = () => {
    try {
      peak = Math.max(peak, Number(/VmHWM:\s+(\d+) kB/.exec(readFileSync(`/proc/${run.child.pid}/status`, "utf8"))[1]) * 1024);
    } catch {
      // gone
    }
  };
  const sampler = setInterval(hwm, 500);
  const result = await run.done;
  clearInterval(sampler);
  record(args.data, reports, user, result, { peakRss: peak });
  const t1 = Date.now();
  if (result.report) await dump(args.data, actual, user);
  // Objects per second over consecutive windows of the migrating passes, to see a slowdown at scale
  const migrating = marks.filter((m) => m.step.startsWith("migrating"));
  const windows = [];
  for (let i = 0, j = 0; i < migrating.length; i = j) {
    j = i + 1;
    while (j < migrating.length && migrating[j].done - migrating[i].done < 5000) j++;
    if (j < migrating.length) windows.push({ from: migrating[i].done, to: migrating[j].done, perSecond: Math.round(((migrating[j].done - migrating[i].done) / (migrating[j].ms - migrating[i].ms)) * 10000) / 10 });
  }
  const firstMigrating = migrating[0]?.ms ?? null;
  rows.push({
    name: names[user.pk],
    user: user.pk.slice(0, 10),
    status: result.report?.status ?? null,
    exit: result.exit,
    ms: result.ms,
    msBeforeFirstObject: firstMigrating,
    peakRssMB: Math.round(peak / 1e6),
    reportBytes: result.stdout.length,
    counts: Object.fromEntries(Object.entries(result.report?.counts ?? {}).filter(([, n]) => n > 0)),
    dumpMs: Date.now() - t1,
    windows,
  });
  console.error(JSON.stringify(rows.at(-1)));
  json(path.join(args.out, "rows.json"), rows);
}
const v = verify(args.data, { reports, actual, out: path.join(args.out, "verify"), users });
const result = { rows, verify: { users: v.summary.users, mismatchedUsers: v.summary.mismatched_users, kinds: v.summary.mismatch_kinds, examples: v.summary.mismatch_examples?.slice(0, 5), listPagesDerived: v.summary.list_pages_derived, skips: v.summary.skip_histogram } };
json(path.join(args.out, "result.json"), result);
console.log(JSON.stringify(result, null, 1));
