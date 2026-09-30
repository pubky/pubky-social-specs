// Seeds the replica onto a testnet homeserver: every replica key signs up, and every object of
// `data/replica/<pk>/` is PUT at its path, byte for byte.
//
//   node seed.mjs [--data data] [--only <pk>]... [--no-docker] [--no-resume]
//
// Starts Postgres and the testnet in Docker unless `--no-docker`, where it expects them up.
// Every object goes up with `putBytes`, JSON included: `putJson` would store the SDK's own
// serialization, and the replay is about the bytes production holds, key order, escapes and
// the objects that do not parse included. A rerun resumes from `seed-state.json`: a user seeded
// whole is skipped, a user cut short is listed and only what is missing is PUT. At the end every
// user's tree is listed and compared with the replica's; a path on one side only is reported.
// `seed-state.json` carries the seed's epoch; `--no-resume` starts a new one.

import { readFileSync, existsSync, writeFileSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { up, pubky, homeserver, keypairOf, replicaUsers, walk, listAll, pool, slots, retrying, statusOf } from "./testnet.mjs";

const { values: args } = parseArgs({
  options: {
    data: { type: "string", default: "data" },
    only: { type: "string", multiple: true },
    docker: { type: "boolean", default: true },
    resume: { type: "boolean", default: true },
  },
  allowNegative: true,
});

const USERS_IN_PARALLEL = 4;
const REQUESTS_IN_FLIGHT = 8;
const CLIENT_ID = "pubky-social-replay";

const statePath = path.join(args.data, "seed-state.json");
const state = args.resume && existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { users: {} };
// Names this seed, so reports and dumps of another one are never taken for this one's
state.epoch ??= new Date().toISOString();
let saving = Promise.resolve();
const saveState = () => {
  saving = saving.then(() => {
    writeFileSync(`${statePath}.tmp`, JSON.stringify(state, null, 1));
    renameSync(`${statePath}.tmp`, statePath);
  });
  return saving;
};

const slot = slots(REQUESTS_IN_FLIGHT);
const started = Date.now();
const totals = { users: 0, objects: 0, bytes: 0, put: 0, putBytes: 0, refused: [], differences: [] };

const seedUser = async ({ pk, secret }) => {
  const dir = path.join(args.data, "replica", pk);
  const paths = walk(dir);
  const entry = (state.users[pk] ??= { signedUp: false, complete: false });
  const signer = pubky().signer(keypairOf(secret));
  if (!entry.signedUp) {
    try {
      await retrying(() => signer.signup(homeserver(), null));
    } catch (error) {
      // A signup whose answer was lost left the account behind
      if (statusOf(error) !== 409) throw error;
    }
    entry.signedUp = true;
    await saveState();
  }
  const session = await retrying(() => signer.signin(CLIENT_ID));
  try {
    let present = new Set();
    if (!entry.complete && entry.started) present = new Set((await listAll(session.storage, "/pub/")).paths);
    entry.started = true;
    const t0 = Date.now();
    let bytes = 0;
    if (!entry.complete) {
      await Promise.all(
        paths
          .filter((p) => !present.has(p))
          .map((p) =>
            slot(async () => {
              const body = readFileSync(path.join(dir, p));
              try {
                await retrying(() => session.storage.putBytes(`/${p}`, body));
                totals.put++;
                totals.putBytes += body.length;
                bytes += body.length;
              } catch (error) {
                // A refusal is a finding of its own; the tree check below reports it too
                if (statusOf(error) === undefined || statusOf(error) >= 500) throw error;
                totals.refused.push({ pk, path: p, status: statusOf(error), message: error.message });
              }
            }),
          ),
      );
    }
    const listed = await listAll(session.storage, "/pub/");
    const onServer = new Set(listed.paths);
    const inReplica = new Set(paths);
    const missing = paths.filter((p) => !onServer.has(p));
    const extra = listed.paths.filter((p) => !inReplica.has(p));
    if (missing.length || extra.length) totals.differences.push({ pk, missing, extra });
    Object.assign(entry, { complete: missing.length === 0 && extra.length === 0, objects: paths.length, ms: entry.ms ?? Date.now() - t0 });
    totals.users++;
    totals.objects += paths.length;
    totals.bytes += paths.reduce((sum, p) => sum + statSync(path.join(dir, p)).size, 0);
    await saveState();
    if (totals.users % 50 === 0) console.error(`${totals.users} users, ${totals.put} objects put, ${Math.round((Date.now() - started) / 1000)} s`);
  } finally {
    await session.signout().catch(() => {});
  }
};

await saveState();
if (args.docker) await up(args.data);
const users = replicaUsers(args.data, args.only);
console.error(`seeding ${users.length} users`);
await pool(users, USERS_IN_PARALLEL, seedUser);
await saveState();

const report = {
  users: totals.users,
  objects: totals.objects,
  bytes: totals.bytes,
  put: { objects: totals.put, bytes: totals.putBytes },
  seconds: Math.round((Date.now() - started) / 100) / 10,
  refused: totals.refused,
  differences: totals.differences,
};
writeFileSync(path.join(args.data, "seed-report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, refused: report.refused.length, differences: report.differences.length }, null, 2));
if (report.refused.length || report.differences.length) process.exitCode = 2;
