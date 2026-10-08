// Seeds each target's corpus from the recorded vectors, so the fuzzer starts from every shape
// the reference was asked about. Run from pkg/qa/fuzz: node seed.mjs
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const vectors = new URL("../../../vectors/js/", import.meta.url);
const KINDS = ["posts/", "/priv/social/v1/posts/", "profile.json", "follows/", "mutes/", "tags/", "bookmarks/", "feeds/"];
const BUILDERS = { createPost: 0, createUser: 1, createFeed: 2 };
const bytesOf = (arg) => (arg.b !== undefined ? Buffer.from(arg.b, "base64") : Buffer.from(arg.j ?? arg.s ?? ""));
const seeds = { decode: [], uri: [], build: [] };
for (const file of readdirSync(vectors)) {
  for (const line of readFileSync(new URL(file, vectors), "utf8").split("\n")) {
    if (!line) continue;
    const { q } = JSON.parse(line);
    const [first, second] = q.args;
    if (q.op === "decode") {
      const url = first.s;
      const kind = url.includes("/priv/social/v1/posts/") ? 1 : KINDS.findIndex((k) => url.includes(k));
      if (kind >= 0) seeds.decode.push(Buffer.concat([Buffer.from([kind]), bytesOf(second)]));
    } else if (["parseUri", "canonicalPubky", "stableKey", "canonicalUniversal"].includes(q.op) && first?.s !== undefined) {
      seeds.uri.push(Buffer.from(first.s));
    } else if (q.op in BUILDERS && second?.j !== undefined) {
      seeds.build.push(Buffer.concat([Buffer.from([BUILDERS[q.op]]), Buffer.from(second.j)]));
    }
  }
}
for (const [target, list] of Object.entries(seeds)) {
  const dir = new URL(`corpus/${target}/`, import.meta.url);
  mkdirSync(dir, { recursive: true });
  for (const seed of list) writeFileSync(new URL(createHash("sha1").update(seed).digest("hex"), dir), seed);
  console.log(target, list.length, "seeds");
}
