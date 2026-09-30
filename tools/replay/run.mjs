// Migrates every replica user on the testnet with the `pubky-social-migrate` CLI, as a user
// would run it: from a recovery file, N users at a time.
//
//   node run.mjs [--data data] [--only <pk>]... [--parallel 4] [--mode run|dry] [--rescan]
//                [--reports data/reports] [--no-dump] [--force] [--kill-after <s>]
//
// Writes `<reports>/<pk>.json` (the CLI's `--json` report with its exit code and wall time) and
// `<reports>/summary.json`. After a `run` it dumps the user's whole tree, both roots, to
// `data/actual/<pk>.ndjson` through a session of its own: a first line naming the seed, then a
// line per object with its size and blake3, and the text of every 1.x object but media, which
// is what `replay_verify` reads. Records and dumps carry the seed's epoch, and one of another
// seed counts as absent. A user whose report is final is skipped unless `--force`.
// `--kill-after` sends the CLI a SIGTERM after that many seconds, to interrupt it mid-run.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { HOST, atomicWrite, dumpTree, keypairOf, replicaUsers, pool, seedEpoch, summarizeReports, tally } from "./testnet.mjs";

const { values: args } = parseArgs({
  options: {
    data: { type: "string", default: "data" },
    only: { type: "string", multiple: true },
    parallel: { type: "string", default: "4" },
    mode: { type: "string", default: "run" },
    rescan: { type: "boolean", default: false },
    reports: { type: "string" },
    dump: { type: "boolean", default: true },
    force: { type: "boolean", default: false },
    "kill-after": { type: "string" },
  },
  allowNegative: true,
});
if (args.mode !== "run" && args.mode !== "dry") throw new Error(`--mode is run or dry, not ${args.mode}`);

const CLI = fileURLToPath(new URL("../../pkg/bin/migrate.js", import.meta.url));
const PASSPHRASE = "replay";
const ATTEMPTS = 3;
// The testnet's pkarr relay has answered the homeserver's record without an HTTPS endpoint;
// that sign-in failure is the testnet's, and a user would just run again
const SIGN_IN_FAILED = "Sign-in failed:";
const FINAL = new Set(["done", "already_migrated"]);
const reportsDir = args.reports ?? path.join(args.data, "reports");
const actualDir = path.join(args.data, "actual");
const killAfter = args["kill-after"] === undefined ? undefined : Number(args["kill-after"]) * 1000;
const epoch = seedEpoch(args.data);
if (epoch === null) throw new Error(`no seed epoch in ${args.data}/seed-state.json: seed first`);

const dumpEpoch = (pk) => {
  const file = path.join(actualDir, `${pk}.ndjson`);
  if (!existsSync(file)) return null;
  const first = readFileSync(file, "utf8").split("\n", 1)[0];
  return JSON.parse(first).seed_epoch ?? null;
};

const cli = (recovery) =>
  new Promise((resolve) => {
    const argv = [CLI, "--recovery", recovery, "--passphrase-env", "REPLAY_PASSPHRASE", "--testnet", HOST, "--json"];
    if (args.mode === "dry") argv.push("--dry-run");
    if (args.rescan) argv.push("--rescan");
    const child = spawn(process.execPath, argv, { env: { ...process.env, REPLAY_PASSPHRASE: PASSPHRASE } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = killAfter === undefined ? undefined : setTimeout(() => child.kill("SIGTERM"), killAfter);
    child.on("close", (exit, signal) => {
      clearTimeout(timer);
      resolve({ exit, signal, stdout, stderr });
    });
  });

const results = [];
const migrateUser = async (user, recoveryDir) => {
  const file = path.join(reportsDir, `${user.pk}.json`);
  if (!args.force && killAfter === undefined && existsSync(file)) {
    const previous = JSON.parse(readFileSync(file, "utf8"));
    const dumped = !args.dump || args.mode === "dry" || dumpEpoch(user.pk) === epoch;
    if (previous.seedEpoch === epoch && FINAL.has(previous.report?.status) && dumped) return;
  }
  const recovery = path.join(recoveryDir, `${user.pk}.pkarr`);
  writeFileSync(recovery, keypairOf(user.secret).createRecoveryFile(PASSPHRASE));
  const failures = [];
  let run;
  let report = null;
  let ms;
  for (let attempt = 0; attempt < ATTEMPTS && report === null; attempt++) {
    const t0 = Date.now();
    run = await cli(recovery);
    ms = Date.now() - t0;
    try {
      report = JSON.parse(run.stdout);
    } catch {
      if (run.signal || !run.stderr.startsWith(SIGN_IN_FAILED)) break;
      failures.push(run.stderr.split("\n").slice(-4).join("\n"));
    }
  }
  const result = {
    pk: user.pk,
    seedEpoch: epoch,
    mode: args.mode,
    rescan: args.rescan,
    exit: run.exit,
    signal: run.signal,
    ms,
    report,
    ...(failures.length ? { failures } : {}),
    ...(report ? {} : { stderr: run.stderr.split("\n").slice(-15).join("\n") }),
  };
  if (args.dump && args.mode === "run" && report) {
    const t1 = Date.now();
    result.dumped = await dumpTree(user, path.join(actualDir, `${user.pk}.ndjson`), epoch);
    result.dumpMs = Date.now() - t1;
  }
  atomicWrite(file, JSON.stringify(result, null, 1));
  results.push(result);
  if (results.length % 25 === 0) console.error(`${results.length} users, ${Math.round((Date.now() - started) / 1000)} s`);
};

const started = Date.now();
mkdirSync(reportsDir, { recursive: true });
const users = replicaUsers(args.data, args.only);
const recoveryDir = mkdtempSync(path.join(tmpdir(), "replay-recovery-"));
try {
  await pool(users, Number(args.parallel), (user) => migrateUser(user, recoveryDir));
} finally {
  rmSync(recoveryDir, { recursive: true, force: true });
}

const session = {
  startedAt: new Date(started).toISOString(),
  wallSeconds: Math.round((Date.now() - started) / 100) / 10,
  mode: args.mode,
  rescan: args.rescan,
  parallel: Number(args.parallel),
  users: results.length,
  ...tally(results),
};
const summary = summarizeReports(reportsDir, epoch, session);
atomicWrite(path.join(reportsDir, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
if (results.some((r) => !FINAL.has(r.report?.status))) process.exitCode = 2;
