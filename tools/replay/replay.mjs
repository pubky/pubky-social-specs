// The whole replay on this machine: seed the replica, migrate every user, verify against the
// oracle, migrate a sample again in a browser, run everyone again, rescan a few, then the
// operational cases on three users each.
//
//   node replay.mjs [--data data] [--parallel 4] [--from <step>] [--to <step>] [--sample <n>]
//                   [--browser chromium|firefox]... [--no-docker] [--down]
//
// Steps: seed, run, verify, browser, second, rescan, kill, quota, rate, metrics. Every step is
// resumable on its own; `--from` and `--to` bound the steps run. `--sample <n>` replays only the
// sample `sampleUsers` picks, which the browser step takes in any case (n is 2 by default), in
// each `--browser` (chromium by default). The numbers land in `data/metrics.json`, and
// `--from metrics` rebuilds them from the reports on disk. `--down` removes the containers and
// their volumes once everything passed.

import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { admin, config, down, keypairOf, pubky, replicaUsers, resetV1, restart, sampleUsers, seedEpoch, summarizeReports, up, volumeBytes, walk, writeConfig } from "./testnet.mjs";

const STEPS = ["seed", "run", "verify", "browser", "second", "rescan", "kill", "quota", "rate", "metrics"];
const { values: args } = parseArgs({
  options: {
    data: { type: "string", default: "data" },
    parallel: { type: "string", default: "4" },
    from: { type: "string", default: "seed" },
    to: { type: "string", default: "metrics" },
    docker: { type: "boolean", default: true },
    down: { type: "boolean", default: false },
    sample: { type: "string" },
    browser: { type: "string", multiple: true, default: ["chromium"] },
  },
  allowNegative: true,
});
for (const bound of [args.from, args.to]) if (!STEPS.includes(bound)) throw new Error(`a step is one of ${STEPS.join(", ")}`);

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const data = path.resolve(args.data);
const metricsPath = path.join(data, "metrics.json");
const metrics = existsSync(metricsPath) ? JSON.parse(readFileSync(metricsPath, "utf8")) : {};
const save = () => writeFileSync(metricsPath, JSON.stringify(metrics, null, 2));
const json = (file) => JSON.parse(readFileSync(path.join(data, file), "utf8"));
const sample = () => sampleUsers(data, Number(args.sample ?? 2));
const users = () => (args.sample === undefined ? replicaUsers(data) : sample());
// Every user, or the sample alone
const population = () => (args.sample === undefined ? [] : users());
const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
  console.error(`${ok ? "ok  " : "FAIL"} ${message}`);
};

const node = (script, ...argv) => {
  const t0 = Date.now();
  const run = spawnSync(process.execPath, [path.join(here, script), "--data", data, ...argv], { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", maxBuffer: 1 << 26 });
  if (run.status !== 0 && run.status !== 2) throw new Error(`${script} ${argv.join(" ")} exited ${run.status}`);
  return { ...JSON.parse(run.stdout), stepSeconds: Math.round((Date.now() - t0) / 1000) };
};
const run = (reports, ...argv) => node("run.mjs", "--parallel", args.parallel, "--reports", path.join(data, reports), ...argv);
const only = (list) => list.flatMap((u) => ["--only", u.pk]);
const browserPass = (name, reports, ...argv) => node("browser.mjs", "--browser", name, "--reports", path.join(data, reports), ...argv);
// What the last invocation of run.mjs did, out of the pass it adds to
const session = (summary) => summary.sessions.at(-1);
// A case's reports hold that case alone, so its wall time is not added to an earlier one's
const fresh = (...dirs) => dirs.forEach((dir) => rmSync(path.join(data, dir), { recursive: true, force: true }));

const verify = (reports, out, list = [], ...flags) => {
  const run = spawnSync(
    "cargo",
    ["run", "-q", "--features", "replay", "--bin", "replay_verify", "--", "--data", data, "--reports", path.join(data, reports), "--out", path.join(data, out), ...only(list), ...flags],
    { cwd: repo, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", maxBuffer: 1 << 26 },
  );
  if (run.status !== 0 && run.status !== 1) throw new Error(`replay_verify exited ${run.status}`);
  return JSON.parse(run.stdout);
};

// Every PUT and DELETE the homeserver takes is an event
const events = () =>
  Number(execFileSync("docker", ["exec", "replay-pg", "psql", "-U", "postgres", "-h", "127.0.0.1", "-p", "55432", "-tAc", "select count(*) from events"], { encoding: "utf8" }).trim());

/** Replica users by the first run's report: object count and wall time. */
const firstRun = () =>
  users().map((u) => {
    const r = JSON.parse(readFileSync(path.join(data, "reports", `${u.pk}.json`), "utf8"));
    const blobs = walk(path.join(data, "replica", u.pk, "pub/pubky.app/blobs"));
    const blobBytes = blobs.reduce((sum, b) => sum + statSync(path.join(data, "replica", u.pk, "pub/pubky.app/blobs", b)).size, 0);
    return { ...u, objects: r.report?.total ?? 0, ms: r.ms, blobBytes };
  });

const brief = (summary) => ({ users: summary.users, status: summary.status, wallSeconds: summary.wallSeconds, perUserMs: summary.perUserMs, counts: nonzero(summary.counts) });
const nonzero = (counts) => Object.fromEntries(Object.entries(counts ?? {}).filter(([, n]) => n > 0));
const verified = (summary) => ({ users: summary.users, mismatchedUsers: summary.mismatched_users, mismatchKinds: summary.mismatch_kinds, examples: summary.mismatch_examples.slice(0, 10) });

const steps = {
  async seed() {
    const argv = args.docker ? [] : ["--no-docker"];
    const seed = node("seed.mjs", ...argv, ...only(population()));
    metrics.seed = seed;
    check(seed.refused === 0 && seed.differences === 0, `seed: ${seed.users} users, ${seed.objects} objects, the testnet holds exactly the replica`);
  },
  async run() {
    const summary = run("reports", ...only(population()));
    metrics.run = summary;
    check(summary.status.done === summary.users, `run: ${summary.status.done ?? 0} of ${summary.users} users done`);
  },
  async verify() {
    const summary = verify("reports", "verify", population(), "--sample", "5");
    metrics.verify = summary;
    check(summary.mismatched_users === 0, `verify: ${summary.users - summary.mismatched_users} of ${summary.users} users match the oracle`);
  },
  // Per browser: the sample, which the run migrated, migrated again from the browser as from a
  // second device, which must find nothing to do; then each user's 1.x tree deleted and
  // migrated from nothing in the browser, verified, and compared with what Node left
  async browser() {
    const list = sample();
    metrics.browser = {};
    for (const name of args.browser) {
      fresh(`reports-${name}-second`);
      const before = events();
      const second = browserPass(name, `reports-${name}-second`, "--no-dump", ...only(list));
      const writes = events() - before;
      for (const u of list) await resetV1(u);
      fresh(`reports-${name}`, `actual-${name}`);
      const pass = browserPass(name, `reports-${name}`, "--actual", path.join(data, `actual-${name}`), ...only(list));
      const v = verify(`reports-${name}`, `verify-${name}`, list, "--actual", path.join(data, `actual-${name}`),
        "--compare-reports", path.join(data, "reports"), "--compare-actual", path.join(data, "actual"));
      const errors = session(pass).pageErrors.length + session(second).pageErrors.length;
      metrics.browser[name] = { second: { status: second.status, writes }, ...brief(pass), peaks: session(pass).peaks, pageErrors: errors, verify: verified(v) };
      check(second.status.already_migrated === list.length && writes === 0,
        `${name} second device: ${second.status.already_migrated ?? 0} of ${list.length} already_migrated, ${writes} writes`);
      check(pass.status.done === list.length && errors === 0 && v.mismatched_users === 0,
        `${name}: ${pass.status.done ?? 0} of ${list.length} done from nothing, ${errors} page errors, verify and the comparison with Node ${v.mismatched_users === 0 ? "pass" : "fail"}`);
    }
  },
  async second() {
    fresh("reports-second");
    const before = events();
    const summary = run("reports-second", "--force", "--no-dump");
    const writes = events() - before;
    metrics.second = { ...brief(summary), writes };
    check(summary.status.already_migrated === summary.users && writes === 0 && Object.values(nonzero(summary.counts)).length === 0,
      `second run: ${summary.status.already_migrated ?? 0} of ${summary.users} already_migrated, ${writes} writes`);
  },
  async rescan() {
    const ten = firstRun().sort((a, b) => b.objects - a.objects).filter((_, i) => i % 80 === 0).slice(0, 10);
    fresh("reports-rescan");
    const before = events();
    const summary = run("reports-rescan", "--force", "--rescan", ...only(ten));
    const writes = events() - before;
    // Every object is found present, so only the sum of written and already_present is fixed
    const v = verify("reports-rescan", "verify-rescan", ten, "--resumed");
    metrics.rescan = { ...brief(summary), writes, verify: verified(v) };
    check(summary.status.done === ten.length && (summary.counts.written ?? 0) === 0 && writes === ten.length && v.mismatched_users === 0,
      `rescan: ${summary.status.done ?? 0} of ${ten.length} done, ${summary.counts.written ?? 0} written, ${writes} writes (the flags)`);
  },
  async kill() {
    const three = firstRun().filter((u) => u.objects >= 800 && u.objects <= 4000).sort((a, b) => b.objects - a.objects).slice(0, 3);
    const cases = [];
    fresh("reports-kill-1", "reports-kill");
    for (const u of three) {
      await resetV1(u);
      const after = Math.max(2, Math.round((u.ms * 0.4) / 1000));
      const killed = session(run(`reports-kill-1`, "--force", "--no-dump", "--kill-after", String(after), ...only([u])));
      const resumed = session(run(`reports-kill`, "--force", ...only([u])));
      cases.push({ pk: u.pk, objects: u.objects, killedAfterSeconds: after, killed: killed.status, resumed: resumed.status, resumedCounts: nonzero(resumed.counts) });
    }
    const v = verify("reports-kill", "verify-kill", three, "--resumed");
    metrics.kill = { cases, verify: verified(v) };
    const interrupted = cases.every((c) => c.killed["killed:SIGTERM"] === 1 && c.resumed.done === 1 && (c.resumedCounts.already_present ?? 0) > 0);
    check(interrupted && v.mismatched_users === 0, `kill: ${cases.length} users killed mid-run, resumed to done, verify ${v.mismatched_users === 0 ? "passes" : "fails"}`);
  },
  async quota() {
    const three = firstRun().filter((u) => u.blobBytes >= 5_000_000 && u.blobBytes <= 60_000_000).sort((a, b) => a.objects - b.objects).slice(0, 3);
    const cases = [];
    fresh("reports-quota-1", "reports-quota");
    for (const u of three) {
      await resetV1(u);
      const v0 = walk(path.join(data, "replica", u.pk)).reduce((sum, p) => sum + statSync(path.join(data, "replica", u.pk, p)).size, 0);
      // Room for the v0 tree and about one MB more, whichever MB the homeserver counts in, and
      // less than the blobs need again as media
      const quotaMb = Math.ceil(v0 / 1e6) + 1;
      await admin("PATCH", `/users/${u.pk}/quota`, { storage_quota_mb: quotaMb });
      // Dumped at the pause, so the blobs still missing on the testnet are known
      const paused = session(run("reports-quota-1", "--force", ...only([u])));
      const report = JSON.parse(readFileSync(path.join(data, "reports-quota-1", `${u.pk}.json`), "utf8")).report;
      const pendingBytes = pendingBlobBytes(u);
      await admin("PATCH", `/users/${u.pk}/quota`, { storage_quota_mb: null });
      const resumed = session(run("reports-quota", "--force", ...only([u])));
      cases.push({ pk: u.pk, v0Bytes: v0, blobBytes: u.blobBytes, quotaMb, paused: paused.status, error: report?.error, pendingBytes, resumed: resumed.status });
    }
    const v = verify("reports-quota", "verify-quota", three, "--resumed");
    metrics.quota = { cases, verify: verified(v) };
    const ok = cases.length === 3 && cases.every((c) => c.paused.paused === 1 && c.error?.code === "QUOTA" && c.error.needBytes === c.pendingBytes && c.resumed.done === 1);
    check(ok && v.mismatched_users === 0, `quota: ${cases.filter((c) => c.paused.paused === 1).length} of ${cases.length} paused with needBytes equal to the declared size of the blobs not on the testnet, resumed to done after raising it`);
  },
  async rate() {
    const three = firstRun().filter((u) => u.objects >= 100 && u.objects <= 200).sort((a, b) => a.objects - b.objects).slice(0, 3);
    const limits = `
[[drive.rate_limits]]
path = "/**"
method = "PUT"
quota = "30r/m"
burst = 5
key = "user"
`;
    fresh("reports-rate");
    writeConfig(config(limits));
    await restart(data);
    try {
      for (const u of three) await resetV1(u);
      const probe = await probe429(three[0]);
      const summary = run("reports-rate", "--force", ...only(three));
      const v = verify("reports-rate", "verify-rate", three);
      const baseline = three.map((u) => u.ms);
      metrics.rate = { limit: "PUT 30 a minute per user, burst 5", probe, baselineMs: baseline, ...brief(summary), verify: verified(v) };
      check(probe.limited > 0 && summary.status.done === three.length && v.mismatched_users === 0,
        `rate limit: the probe met ${probe.limited} 429s, ${summary.status.done ?? 0} of ${three.length} done under it, verify ${v.mismatched_users === 0 ? "passes" : "fails"}`);
    } finally {
      writeConfig(config());
      await restart(data);
    }
  },
  // Rebuilt from the per-user reports and the verify summary, so it can be run again at any time
  async metrics() {
    metrics.run = summarizeReports(path.join(data, "reports"), seedEpoch(data));
    metrics.verify = json("verify/summary.json");
    const du = (p) => Number(execFileSync("du", ["-sk", p], { encoding: "utf8" }).split("\t")[0]) * 1024;
    const volumes = volumeBytes();
    // The volumes are gone once a replay ends with --down; their last measure stays
    const measured = Object.keys(volumes).length > 0;
    metrics.disk = { data: du(data), volumes: measured ? volumes : metrics.disk?.volumes, volumesMeasuredAt: measured ? new Date().toISOString() : metrics.disk?.volumesMeasuredAt };
    metrics.summary = summarize();
    console.log(JSON.stringify(metrics.summary, null, 2));
  },
};

/**
 * What a paused run owes `needBytes`: the size each File declares for the owner's blobs that
 * are not on the testnet, the last File in LIST order winning as it does in the run.
 */
const pendingBlobBytes = (u) => {
  const root = path.join(data, "replica", u.pk, "pub/pubky.app");
  const declared = new Map();
  for (const file of walk(path.join(root, "files"))) {
    try {
      const { src, size } = JSON.parse(readFileSync(path.join(root, "files", file), "utf8"));
      const hash = new RegExp(`^pubky://${u.pk}/pub/pubky\\.app/blobs/([^/]+)$`).exec(src?.trim() ?? "")?.[1];
      if (hash && Number.isSafeInteger(size) && size >= 0) declared.set(hash, size);
    } catch {
      // a File that does not parse declares nothing
    }
  }
  const dump = readFileSync(path.join(data, "actual", `${u.pk}.ndjson`), "utf8").split("\n").slice(1).filter(Boolean);
  const present = new Set(dump.map((line) => JSON.parse(line).path).filter((p) => p.startsWith("pub/social/v1/files/")).map((p) => p.slice("pub/social/v1/files/".length).split(".")[0]));
  return walk(path.join(root, "blobs")).filter((hash) => !present.has(hash)).reduce((sum, hash) => sum + (declared.get(hash) ?? 0), 0);
};

/** PUTs as fast as it can until the limiter answers, to show the limit holds before the run. */
const probe429 = async (u) => {
  const session = await pubky().signer(keypairOf(u.secret)).signin("pubky-social-replay");
  let limited = 0;
  let sent = 0;
  try {
    for (; sent < 20 && limited === 0; sent++) {
      try {
        await session.storage.putBytes("/pub/replay.probe/x", new Uint8Array([sent]));
      } catch (error) {
        if (error?.data?.statusCode === 429) limited++;
        else throw error;
      }
    }
    await session.storage.delete("/pub/replay.probe/x").catch(() => {});
  } finally {
    await session.signout().catch(() => {});
  }
  return { sent, limited };
};

// A resumed seed only lists, so the numbers are the report of the seed that PUT the objects
const seedReport = () => {
  const seed = existsSync(path.join(data, "seed-report.json")) ? json("seed-report.json") : metrics.seed;
  return seed && { users: seed.users, objects: seed.objects, bytes: seed.bytes, put: seed.put, seconds: seed.seconds, refused: seed.refused?.length ?? seed.refused, differences: seed.differences?.length ?? seed.differences };
};

const summarize = () => {
  const r = metrics.run ?? {};
  const v = metrics.verify ?? {};
  return {
    seed: seedReport(),
    run: {
      users: r.users,
      wallSeconds: r.wallSeconds,
      sessions: r.sessions?.map((s) => ({ wallSeconds: s.wallSeconds, users: s.users, status: s.status })),
      perUserMs: r.perUserMs,
      heaviest: r.heaviest,
      status: r.status,
      retried: r.retried,
    },
    listPagesDerived: v.list_pages_derived,
    bytesMoved: v.bytes,
    skipHistogram: v.skip_histogram,
    findings: Object.fromEntries(
      Object.entries(v.findings ?? {}).map(([direction, f]) => [direction, { count: f.count, groups: f.groups.map((g) => ({ group: g.group, count: g.count })) }]),
    ),
    danglingMedia: v.dangling_media,
    verify: v.users && { users: v.users, mismatchedUsers: v.mismatched_users },
    second: metrics.second && { status: metrics.second.status, writes: metrics.second.writes, wallSeconds: metrics.second.wallSeconds },
    rescan: metrics.rescan && { status: metrics.rescan.status, writes: metrics.rescan.writes, mismatchedUsers: metrics.rescan.verify.mismatchedUsers },
    kill: metrics.kill,
    quota: metrics.quota,
    rate: metrics.rate,
    browser: metrics.browser && Object.fromEntries(Object.entries(metrics.browser).map(([name, b]) => [name, { second: b.second, status: b.status, perUserMs: b.perUserMs, peaks: b.peaks, pageErrors: b.pageErrors, mismatchedUsers: b.verify.mismatchedUsers }])),
    disk: metrics.disk,
  };
};

const chosen = STEPS.slice(STEPS.indexOf(args.from), STEPS.indexOf(args.to) + 1);
const offline = ["seed", "verify", "metrics"];
if (args.docker && chosen.some((step) => !offline.includes(step))) await up(data);
for (const step of chosen) {
  console.error(`== ${step}`);
  const t0 = Date.now();
  await steps[step]();
  (metrics.stepSeconds ??= {})[step] = Math.round((Date.now() - t0) / 1000);
  save();
}
if (failures.length) {
  console.error(`${failures.length} checks failed:\n${failures.join("\n")}`);
  process.exitCode = 1;
} else if (args.down) {
  down();
}
