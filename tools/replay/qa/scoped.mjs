// One user migrated through a session that holds only ENGINE_CAPS, minted through the grant
// auth flow over the testnet's HTTP relay and approved by the user's own signer, instead of the
// CLI's root sign-in.
//
//   node qa/scoped.mjs --only <pk> --out <dir> [--caps <caps>] [--rescan]

import path from "node:path";
import { parseArgs } from "node:util";
import { AuthFlowKind } from "@synonymdev/pubky";
import { ENGINE_CAPS, runMigration } from "../../../pkg/migration/index.js";
import { sdkPort } from "../../../pkg/migration/adapters/pubky-sdk.js";
import { HOST, keypairOf, pubky, replicaUsers } from "../testnet.mjs";
import { dump, json, record, verify } from "./lib.mjs";

const { values: args } = parseArgs({
  options: { data: { type: "string", default: "data" }, only: { type: "string" }, out: { type: "string" }, caps: { type: "string" }, relay: { type: "string", default: `http://${HOST}:15412/inbox/` }, rescan: { type: "boolean", default: false } },
});
const user = replicaUsers(args.data, [args.only])[0];
const caps = args.caps ?? ENGINE_CAPS;
const client = pubky();
const t0 = Date.now();
const flow = await client.startGrantAuthFlow(caps, AuthFlowKind.signin(), { clientId: "qa-scoped", relay: args.relay });
const url = typeof flow.authorizationUrl === "function" ? flow.authorizationUrl() : flow.authorizationUrl;
const approving = client.signer(keypairOf(user.secret)).approveAuthRequest(url);
const [session] = await Promise.all([flow.awaitApproval(), approving]);
const granted = session.info.capabilities;
const authMs = Date.now() - t0;
let report;
const t1 = Date.now();
try {
  report = await runMigration({ owner: session.info.publicKey.z32(), port: sdkPort(session), caps: granted, rescan: args.rescan });
} finally {
  await session.signout().catch(() => {});
}
const ms = Date.now() - t1;
const reports = path.join(args.out, "reports");
const actual = path.join(args.out, "actual");
record(args.data, reports, user, { exit: null, signal: null, ms, report });
let v = null;
if (report.status === "done" || report.status === "already_migrated") {
  await dump(args.data, actual, user);
  v = verify(args.data, { reports, actual, out: path.join(args.out, "verify"), users: [user], flags: ["--resumed"] }).summary;
}
const result = {
  user: user.pk.slice(0, 10),
  requested: caps,
  granted,
  authMs,
  ms,
  status: report.status,
  error: report.error ?? null,
  counts: Object.fromEntries(Object.entries(report.counts).filter(([, n]) => n > 0)),
  verify: v && { mismatchedUsers: v.mismatched_users, kinds: v.mismatch_kinds, examples: v.mismatch_examples?.slice(0, 5) },
};
json(path.join(args.out, "result.json"), result);
console.log(JSON.stringify(result, null, 1));
