// A user edits a migrated post and adds a 1.x tag after the migration, then the migration is
// rescanned: the edit and the tag must survive, nothing may be written but the flag, and
// nothing deleted.
//
//   node qa/liveedit.mjs --only <pk> --out <dir>

import path from "node:path";
import { parseArgs } from "node:util";
import { init, createTag, editVersion, readObject, validate } from "../../../pkg/index.js";
import { keypairOf, listAll, pubky, replicaUsers } from "../testnet.mjs";
import { dump, eventsOf, json, lastEventId, record, runCli, verify, writeAudit } from "./lib.mjs";

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
const since = lastEventId();
const run = await runCli(user, { rescan: true });
const after = await pubky().signer(keypairOf(user.secret)).signin("qa-live-edit");
const survived = [];
try {
  for (const w of written) {
    const bytes = await after.storage.getBytes(`/${w.path}`).catch(() => null);
    survived.push({ path: w.path, same: bytes !== null && new TextDecoder().decode(bytes) === w.bytes });
  }
} finally {
  await after.signout().catch(() => {});
}
const events = eventsOf(user.pk, since);
const reports = path.join(args.out, "reports");
const actual = path.join(args.out, "actual");
record(args.data, reports, user, run, { rescan: true });
await dump(args.data, actual, user);
const v = verify(args.data, { reports, actual, out: path.join(args.out, "verify"), users: [user], flags: ["--resumed"] });
const result = {
  user: user.pk.slice(0, 10),
  userWrites: written.map((w) => w.path),
  rescan: { status: run.report?.status, exit: run.exit, ms: run.ms, counts: Object.fromEntries(Object.entries(run.report?.counts ?? {}).filter(([, n]) => n > 0)) },
  survived,
  eventsDuringRescan: events.map((e) => `${e.type} ${e.path}`),
  audit: writeAudit(events),
  verify: { mismatchedUsers: v.summary.mismatched_users, kinds: v.summary.mismatch_kinds, examples: v.summary.mismatch_examples?.slice(0, 8) },
};
json(path.join(args.out, "result.json"), result);
console.log(JSON.stringify(result, null, 1));
