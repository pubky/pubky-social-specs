// The CLI over a bad network: toxiproxy between it and the homeserver, which advertises the
// proxy's port in its record so every client goes through it.
//
//   node qa/badnet.mjs setup | teardown
//   node qa/badnet.mjs case --name <n> --only <pk> --toxics '<json array>' --out <dir> [--watchdog <s>]

import { execFileSync } from "node:child_process";
import path from "node:path";
import { parseArgs } from "node:util";
import { config, keypairOf, pubky, replicaUsers, resetV1, restart, writeConfig } from "../testnet.mjs";
import { dump, eventsOf, json, lastEventId, record, runCli, startCli, verify, writeAudit } from "./lib.mjs";

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    data: { type: "string", default: "data" },
    name: { type: "string" },
    only: { type: "string" },
    toxics: { type: "string", default: "[]" },
    out: { type: "string" },
    watchdog: { type: "string", default: "1200" },
  },
});
const API = "http://127.0.0.1:8474";
const PORT = 16286;
const api = async (method, route, body) => {
  const r = await fetch(`${API}${route}`, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
  if (!r.ok && r.status !== 404) throw new Error(`toxiproxy ${method} ${route}: ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json().catch(() => null);
};
const clearToxics = async () => {
  const proxy = await api("GET", "/proxies/hs");
  for (const t of proxy?.toxics ?? []) await api("DELETE", `/proxies/hs/toxics/${t.name}`);
};
const probe = async (user) => {
  const t0 = Date.now();
  const session = await pubky().signer(keypairOf(user.secret)).signin("qa-probe");
  await session.storage.list("/pub/", null, false, 1, false).catch(() => {});
  await session.signout().catch(() => {});
  return Date.now() - t0;
};

const [command] = positionals;
if (command === "setup") {
  execFileSync("docker", ["rm", "-f", "qa-toxi"], { stdio: "ignore" });
  execFileSync("docker", ["run", "-d", "--name", "qa-toxi", "--network", "host", "ghcr.io/shopify/toxiproxy:2.12.0"]);
  for (let i = 0; i < 30; i++) {
    if (await fetch(`${API}/version`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await api("POST", "/proxies", { name: "hs", listen: `127.0.0.1:${PORT}`, upstream: "127.0.0.1:6286" });
  writeConfig(config().replace('icann_domain = "localhost"', `icann_domain = "localhost"\npublic_icann_http_port = ${PORT}`));
  await restart(args.data);
  const user = replicaUsers(args.data)[0];
  const plain = await probe(user);
  await api("POST", "/proxies/hs/toxics", { name: "probe", type: "latency", stream: "downstream", attributes: { latency: 1000 } });
  const slowed = await probe(user);
  await clearToxics();
  console.log(JSON.stringify({ plainMs: plain, with1sLatencyMs: slowed, routed: slowed - plain > 1500 }));
} else if (command === "teardown") {
  writeConfig(config());
  await restart(args.data);
  execFileSync("docker", ["rm", "-f", "qa-toxi"], { stdio: "ignore" });
  console.log("teardown done");
} else if (command === "case") {
  const user = replicaUsers(args.data, [args.only])[0];
  await clearToxics();
  const deleted = await resetV1(user);
  const since = lastEventId();
  for (const toxic of JSON.parse(args.toxics)) await api("POST", "/proxies/hs/toxics", toxic);
  let last = null;
  let lines = 0;
  const run = startCli(user, { onLine: (line) => { lines++; if (/: \d+\/\d+$/.test(line)) last = line; } });
  let watchdog = null;
  const timer = setTimeout(() => {
    watchdog = last;
    run.child.kill("SIGINT");
    setTimeout(() => run.child.kill("SIGKILL"), 120_000).unref();
  }, Number(args.watchdog) * 1000);
  const first = await run.done;
  clearTimeout(timer);
  await clearToxics();
  const reruns = [];
  let final = first;
  while (!["done", "already_migrated"].includes(final.report?.status) && reruns.length < 3) {
    final = await runCli(user);
    reruns.push({ status: final.report?.status ?? null, exit: final.exit, ms: final.ms });
  }
  const reports = path.join(args.out, "reports");
  const actual = path.join(args.out, "actual");
  record(args.data, reports, user, final);
  await dump(args.data, actual, user);
  const audit = writeAudit(eventsOf(user.pk, since));
  const v = verify(args.data, { reports, actual, out: path.join(args.out, "verify"), users: [user], flags: ["--resumed"] });
  const nz = (c) => Object.fromEntries(Object.entries(c ?? {}).filter(([, n]) => n > 0));
  const notes = first.report?.notes ?? [];
  const result = {
    name: args.name,
    user: user.pk.slice(0, 10),
    toxics: JSON.parse(args.toxics),
    deletedBefore: deleted,
    first: {
      exit: first.exit,
      signal: first.signal,
      ms: first.ms,
      status: first.report?.status ?? null,
      error: first.report?.error ?? null,
      counts: nz(first.report?.counts),
      noteKinds: [...new Set(notes.map((n) => n.message.slice(0, 120)))].slice(0, 8),
      watchdogFiredAt: watchdog,
      progressLines: lines,
      stderrTail: first.report ? undefined : first.stderr.split("\n").slice(-8),
    },
    reruns,
    audit,
    verify: { mismatchedUsers: v.summary.mismatched_users, kinds: v.summary.mismatch_kinds, examples: v.summary.mismatch_examples?.slice(0, 5) },
  };
  json(path.join(args.out, "result.json"), result);
  console.log(JSON.stringify(result, null, 1));
} else throw new Error("setup, teardown or case");
