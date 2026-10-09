// The package as each runtime meets it: the core, the testing subpath and a migration of one
// 0.x object over a MemoryPort, through the built entries. Prints "ok" or throws.
//   node qa/smoke.mjs | deno run -A qa/smoke.mjs | bun qa/smoke.mjs; qa/browser.mjs runs it in Chromium

import { buildPost, decodeObject, parseUri, validatePost } from "../dist/index.js";
import { setClock } from "../dist/testing.js";
import { MemoryPort, runMigration } from "../dist/migration/index.js";

const owner = "8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto";
setClock(() => 1_790_000_000_000);
const post = buildPost(owner, { content: "hello" });
if (decodeObject(post.url, post.body, "post").content !== "hello") throw new Error("a post did not read back");
if (parseUri(post.url).id !== post.id) throw new Error("parseUri lost the id");
if (validatePost({ content: "" }).success) throw new Error("an empty post validated");
setClock();

const port = new MemoryPort();
port.store.set(`pubky://${owner}/pub/pubky.app/profile.json`, new TextEncoder().encode(JSON.stringify({ name: "Smoke", bio: null, image: null, links: null, status: null })));
const report = await runMigration({ owner, port });
if (report.status !== "done" || report.counts.written !== 1) throw new Error(`migration: ${JSON.stringify(report)}`);
const result = "ok";
globalThis.smokeResult = result;
console.log(result);
