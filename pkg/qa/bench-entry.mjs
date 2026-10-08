// Throughput of the native entry: what one call costs, per operation.
//
//   node qa/bench-entry.mjs [--out file.json]

import * as api from "../dist/index.js";
import { setClock } from "../dist/testing.js";
import { NOW_MS, OTHER, OWNER, flags, writeOut } from "./lib.mjs";

const args = flags({ out: { type: "string" } });
setClock(() => NOW_MS);

const note = api.buildPost(OWNER, { content: "A note of ordinary length, with a reference.", parent: api.buildUri(OTHER, "post", "0034A0X7NJ52G") });
const article = api.buildPost(OWNER, { kind: "article", title: "A title", body: "word ".repeat(2000), cover_image: "https://example.com/c.png" });
const user = api.buildUser(OWNER, { name: "Alice", bio: "bio", links: [{ title: "Site", url: "https://example.com" }] });
const megabyte = new Uint8Array(1 << 20).fill(7);

const CASES = {
  "buildUri (post)": () => api.buildUri(OTHER, "post", "0034A0X7NJ52G"),
  "parseUri (post version)": () => api.parseUri(note.url),
  "buildPost (note)": () => api.buildPost(OWNER, { content: "A note of ordinary length, with a reference.", parent: api.buildUri(OTHER, "post", "0034A0X7NJ52G") }),
  "buildPost (10 kB article)": () => api.buildPost(OWNER, { kind: "article", title: "A title", body: article.object.content }),
  buildUser: () => api.buildUser(OWNER, { name: "Alice", bio: "bio", links: [{ title: "Site", url: "https://example.com" }] }),
  buildTag: () => api.buildTag(OWNER, note.url.replace(/\/[^/]+$/, ""), "rust"),
  buildFollow: () => api.buildFollow(OWNER, OTHER),
  "decodeObject (note)": () => api.decodeObject(note.url, note.body),
  "decodeObject (10 kB article)": () => api.decodeObject(article.url, article.body),
  "decodeObject (profile)": () => api.decodeObject(user.url, user.body),
  "encodeObject (note)": () => api.encodeObject(note.url, note.object),
  "editPost (note)": () => api.editPost(OWNER, note.url, note.object),
  "buildFile (1 MB)": () => api.buildFile(OWNER, { bytes: megabyte, type: "image/png" }),
};

const results = {};
for (const [name, run] of Object.entries(CASES)) {
  for (let i = 0; i < 200; i++) run();
  let calls = 0;
  const started = performance.now();
  while (performance.now() - started < 400) {
    for (let i = 0; i < 20; i++) run();
    calls += 20;
  }
  const micros = ((performance.now() - started) * 1000) / calls;
  results[name] = { usPerCall: +micros.toFixed(1), perSecond: Math.round(1e6 / micros) };
  console.log(`${name.padEnd(30)} ${micros.toFixed(1).padStart(9)} us  ${String(Math.round(1e6 / micros)).padStart(8)} /s`);
}
writeOut(args.out, results);
