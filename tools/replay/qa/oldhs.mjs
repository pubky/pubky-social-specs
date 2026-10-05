// Against a homeserver older than /priv/: a fresh account with two v0 objects, then the CLI,
// then the engine over a cookie session, which such a homeserver still signs in.
//
//   node qa/oldhs.mjs --out <file>

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { Keypair } from "@synonymdev/pubky";
import { runMigration } from "../../../pkg/migration/index.js";
import { sdkPort } from "../../../pkg/migration/adapters/pubky-sdk.js";
import { homeserver, pubky } from "../testnet.mjs";
import { json, runCli } from "./lib.mjs";

const { values: args } = parseArgs({ options: { out: { type: "string" } } });
const keypair = Keypair.random();
const secret = Buffer.from(keypair.secret()).toString("hex");
const user = { pk: keypair.publicKey.z32(), secret };
const out = { user: user.pk.slice(0, 10) };
const signer = pubky().signer(keypair);
try {
  out.signup = await signer.signupCookie(homeserver(), null).then(() => "ok", (e) => `${e.name}: ${e.message}`);
} catch (e) {
  out.signup = `${e.name}: ${e.message}`;
}
let cookie = null;
try {
  cookie = await signer.signinCookie();
  await cookie.storage.putJson("/pub/pubky.app/profile.json", { name: "old hs", bio: null, image: null, links: null, status: null });
  await cookie.storage.putJson("/pub/pubky.app/posts/0034A0X7NJ52A", { content: "hello", kind: "short", parent: null, embed: null, attachments: null });
  out.v0Written = 2;
} catch (e) {
  out.cookieSignin = `${e.name}: ${e.message}`;
}
const cli = await runCli(user);
out.cli = { exit: cli.exit, status: cli.report?.status ?? null, error: cli.report?.error ?? null, stderr: cli.stderr.split("\n").filter(Boolean).slice(-3) };
if (cookie) {
  const report = await runMigration({ owner: user.pk, port: sdkPort(cookie) });
  out.engineOverCookie = { status: report.status, error: report.error ?? null, counts: Object.fromEntries(Object.entries(report.counts).filter(([, n]) => n > 0)) };
}
json(args.out, out);
console.log(JSON.stringify(out, null, 1));
process.exit(0);
