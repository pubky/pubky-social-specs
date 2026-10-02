// A user edits a migrated post and adds a 1.x tag after the migration, then the migration is
// rescanned: every byte of the tree after the edits must survive, nothing may be added but the
// flag, and the run must end done with nothing written. Exits 1 when any check fails.
//
//   node qa/liveedit.mjs --only <pk> --out <dir>

import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { init, createTag, editVersion, readObject, validate } from "../../../pkg/index.js";
import { keypairOf, listAll, pubky, replicaUsers } from "../testnet.mjs";
import { dump, eventsOf, json, lastEventId, record, runCli, writeAudit } from "./lib.mjs";

const { values: args } = parseArgs({ options: { data: { type: "string", default: "data" }, only: { type: "string" }, out: { type: "string" } } });
await init();
const user = replicaUsers(args.data, [args.only])[0];
const owner = user.pk;
const session = await pubky().signer(keypairOf(user.secret)).signin("qa-live-edit");
const written = [];
try {
  const { paths } = await listAll(session.storage, "/pub/social/v1/posts/");
  const first = paths.find((p) => /^pub\/social\/v1\/posts\/[^/]+\/[^/]+\.json$/.test(p));
  const postId = first.split("/")[4];
  const versions = paths.filter((p) => p.startsWith(`pub/social/v1/posts/${postId}/`)).map((p) => p.split("/")[5].replace(/\.json$/, "")).sort();
  const head = versions.at(-1);
  const url = `pubky://${owner}/pub/social/v1/posts/${postId}/${head}.json`;
  const { object: post } = readObject(url, await session.storage.getBytes(`/pub/social/v1/posts/${postId}/${head}.json`));
  post.content = `${post.content ?? ""} (edited after migration)`.trim();
  const next = editVersion(owner, post, { id: postId, head });
  validate(next.url, post);
  const postBytes = JSON.stringify(post);
  await session.storage.putBytes(`/${next.path}`, new TextEncoder().encode(postBytes));
  written.push({ path: next.path, bytes: postBytes });
  const tag = createTag(owner, `pubky://${owner}/pub/social/v1/posts/${postId}`, "qa-live");
  validate(tag.meta.url, tag.object);
  const tagBytes = JSON.stringify(tag.object);
  await session.storage.putBytes(`/${tag.meta.path}`, new TextEncoder().encode(tagBytes));
  written.push({ path: tag.meta.path, bytes: tagBytes });
} finally {
  await session.signout().catch(() => {});
}
// The tree after the user's edits is the baseline: the rescan must leave every byte of it in
// place and add nothing but the flag. The v0 oracle cannot judge v1 additions, so the baseline is
// the dump itself.
const FLAG = "priv/social/v1/_migrated.json";
const rows = (file) => Object.fromEntries(readFileSync(file, "utf8").trim().split("\n").slice(1).map((l) => JSON.parse(l)).map((r) => [r.path, `${r.size}:${r.blake3}`]));
const baselineDir = path.join(args.out, "baseline");
await dump(args.data, baselineDir, user);
const baseline = rows(path.join(baselineDir, `${user.pk}.ndjson`));
const since = lastEventId();
const run = await runCli(user, { rescan: true });
const events = eventsOf(user.pk, since);
const reports = path.join(args.out, "reports");
const actual = path.join(args.out, "actual");
record(args.data, reports, user, run, { rescan: true });
await dump(args.data, actual, user);
const after = rows(path.join(actual, `${user.pk}.ndjson`));
const changed = Object.keys(baseline).filter((p) => after[p] !== baseline[p] && p !== FLAG);
const added = Object.keys(after).filter((p) => !(p in baseline) && p !== FLAG);
const userWritesKept = written.every((w) => w.path in baseline && after[w.path] === baseline[w.path]);
const counts = Object.fromEntries(Object.entries(run.report?.counts ?? {}).filter(([, n]) => n > 0));
const checks = {
  rescanDone: run.report?.status === "done" && run.exit === 0,
  nothingWritten: (run.report?.counts?.written ?? 1) === 0,
  everyByteSurvived: changed.length === 0 && userWritesKept,
  onlyTheFlagAdded: added.length === 0 && FLAG in after,
  onlyTheFlagEvent: events.every((e) => e.type === "PUT" && e.path.endsWith(FLAG)),
};
const ok = Object.values(checks).every(Boolean);
const result = {
  user: user.pk.slice(0, 10),
  ok,
  checks,
  userWrites: written.map((w) => w.path),
  rescan: { status: run.report?.status, exit: run.exit, ms: run.ms, counts },
  baselineObjects: Object.keys(baseline).length,
  changed: changed.slice(0, 20),
  added: added.slice(0, 20),
  eventsDuringRescan: events.map((e) => `${e.type} ${e.path}`),
  audit: writeAudit(events),
};
json(path.join(args.out, "result.json"), result);
console.log(JSON.stringify(result, null, 1));
if (!ok) process.exit(1);
