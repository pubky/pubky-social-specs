// What the QA cases share: the CLI run as run.mjs runs it but with the knobs a case needs (a
// SIGKILL, an environment, another testnet host), the record shape run.mjs writes so
// replay_verify reads it, and the event rows of one user from the homeserver's database.

import { spawn, execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOST, atomicWrite, dumpTree, keypairOf, seedEpoch } from "../testnet.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(here, "../../..");
export const CLI = path.join(REPO, "pkg/bin/migrate.js");
const VERIFY = path.join(REPO, "target/debug/replay_verify");
const PASSPHRASE = "replay";

let recoveryDir;
const recoveryFile = (user) => {
  recoveryDir ??= mkdtempSync(path.join(tmpdir(), "qa-recovery-"));
  const file = path.join(recoveryDir, `${user.pk}.pkarr`);
  writeFileSync(file, keypairOf(user.secret).createRecoveryFile(PASSPHRASE), { mode: 0o600 });
  return file;
};
process.on("exit", () => recoveryDir && rmSync(recoveryDir, { recursive: true, force: true }));

/**
 * Starts the CLI for `user`. Resolves `{exit, signal, ms, stdout, stderr, report, lines}` when it
 * ends; `child` is there to kill it. `onLine` sees every stderr line as it comes.
 */
export const startCli = (user, { host = HOST, env = {}, rescan = false, onLine } = {}) => {
  const argv = [CLI, "--recovery", recoveryFile(user), "--passphrase-env", "REPLAY_PASSPHRASE", "--testnet", host, "--json"];
  if (rescan) argv.push("--rescan");
  const t0 = Date.now();
  const child = spawn(process.execPath, argv, { env: { ...process.env, ...env, REPLAY_PASSPHRASE: PASSPHRASE } });
  let stdout = "";
  let stderr = "";
  let partial = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => {
    stderr += c;
    partial += c;
    const lines = partial.split("\n");
    partial = lines.pop();
    if (onLine) for (const line of lines) onLine(line, Date.now() - t0);
  });
  const done = new Promise((resolve) =>
    child.on("close", (exit, signal) => {
      let report = null;
      try {
        report = JSON.parse(stdout);
      } catch {
        // killed, or failed before a report
      }
      resolve({ exit, signal, ms: Date.now() - t0, stdout, stderr, report });
    }),
  );
  return { child, done };
};

export const runCli = async (user, options) => {
  for (let attempt = 0; ; attempt++) {
    const result = await startCli(user, options).done;
    // The testnet's relay sometimes answers the homeserver record without its endpoint
    if (result.report || attempt >= 2 || !result.stderr.startsWith("Sign-in failed:")) return result;
  }
};

/** Writes a record replay_verify reads, in run.mjs's shape. */
export const record = (dataDir, reportsDir, user, result, extra = {}) => {
  mkdirSync(reportsDir, { recursive: true });
  const rec = {
    pk: user.pk,
    seedEpoch: seedEpoch(dataDir),
    mode: "run",
    rescan: false,
    exit: result.exit,
    signal: result.signal,
    ms: result.ms,
    report: result.report,
    ...extra,
  };
  atomicWrite(path.join(reportsDir, `${user.pk}.json`), JSON.stringify(rec, null, 1));
  return rec;
};

export const dump = (dataDir, actualDir, user) => dumpTree(user, path.join(actualDir, `${user.pk}.ndjson`), seedEpoch(dataDir));

/** replay_verify over `users`, its summary, and its exit status. */
export const verify = (dataDir, { reports, actual, out, users = [], flags = [] }) => {
  const argv = ["--data", dataDir, "--reports", reports, "--out", out, ...(actual ? ["--actual", actual] : []), ...users.flatMap((u) => ["--only", u.pk]), ...flags];
  const run = spawnSync(VERIFY, argv, { encoding: "utf8", maxBuffer: 1 << 28 });
  if (run.status !== 0 && run.status !== 1) throw new Error(`replay_verify exited ${run.status}: ${run.stderr.slice(-2000)}`);
  const summary = JSON.parse(run.stdout);
  return { status: run.status, summary };
};

const psql = (q) => execFileSync("docker", ["exec", "replay-pg", "psql", "-U", "postgres", "-h", "127.0.0.1", "-p", "55432", "-tAF", "\t", "-c", q], { encoding: "utf8", maxBuffer: 1 << 28 }).trim();

/** The highest event id now, to read only what a case adds after it. */
export const lastEventId = () => Number(psql("select coalesce(max(id), 0) from events"));

/** Every event of `pk` after `since`: `{id, type, path, hash}`, oldest first. */
export const eventsOf = (pk, since = 0) => {
  const out = psql(`select e.id, e.type, e.path, encode(e.content_hash, 'hex') from events e join users u on u.id = e."user" where u.public_key = '${pk}' and e.id > ${since} order by e.id`);
  return out ? out.split("\n").map((l) => { const [id, type, p, hash] = l.split("\t"); return { id: Number(id), type, path: p, hash }; }) : [];
};

/**
 * What the events say of a migration: 1.x paths written more than once, those of them whose
 * bytes differ (the flag excepted, its time differs by design), and deletes of 1.x paths.
 */
export const writeAudit = (events) => {
  const v1 = events.filter((e) => /^\/(pub|priv)\/social\/v1\//.test(e.path));
  const puts = new Map();
  for (const e of v1.filter((e) => e.type === "PUT")) puts.set(e.path, [...(puts.get(e.path) ?? []), e.hash]);
  const rewritten = [...puts].filter(([, hashes]) => hashes.length > 1);
  const differing = rewritten.filter(([p, hashes]) => !p.endsWith("/_migrated.json") && new Set(hashes).size > 1);
  return {
    v1Puts: v1.filter((e) => e.type === "PUT").length,
    v1Paths: puts.size,
    rewritten: rewritten.length,
    rewrittenNonFlag: rewritten.filter(([p]) => !p.endsWith("/_migrated.json")).length,
    differing: differing.length,
    differingExamples: differing.slice(0, 5).map(([p]) => p),
    v1Deletes: v1.filter((e) => e.type === "DEL").length,
    v0Writes: events.filter((e) => e.path.startsWith("/pub/pubky.app/")).length,
  };
};

export const json = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 1));
};

export const stats = (values) => {
  const s = [...values].sort((a, b) => a - b);
  const p = (q) => (s.length ? s[Math.min(s.length - 1, Math.ceil((q / 100) * s.length) - 1)] : 0);
  return { n: s.length, p50: p(50), p90: p(90), p99: p(99), max: s.at(-1) ?? 0, sum: s.reduce((a, b) => a + b, 0) };
};
