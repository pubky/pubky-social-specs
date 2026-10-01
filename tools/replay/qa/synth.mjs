// Synthetic replica users at the boundaries the corpus does not reach: a tree of exactly 1000,
// 1001 and 2000 tags, 1500 tiny blobs with their File objects, and 50,000 posts. Written in the
// remap's layout to their own data directory, so seed, run and replay_verify take it as a replica.
//
//   node qa/synth.mjs [--out data/qa/synth]

import { blake3 } from "@noble/hashes/blake3.js";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { Keypair } from "@synonymdev/pubky";

const { values: args } = parseArgs({ options: { out: { type: "string", default: "data/qa/synth" } } });
if (existsSync(path.join(args.out, "replica"))) throw new Error(`${args.out}/replica exists`);

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const crockford = (bytes) => {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
};
const enc = new TextEncoder();
const hashId = (bytes) => crockford(blake3(bytes).slice(0, 16));
const tsid = (micros) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, BigInt(micros));
  return crockford(b);
};
// The derivations checked against the semantic vectors before anything is written
if (hashId(enc.encode("https://example.com/page:web")) !== "QKP95D1SNK2RB1YG19EQXB8G00") throw new Error("tag id derivation");
if (tsid(1727740800000000) !== "0033000000000") console.error(`note: tsid(2024-10-01) = ${tsid(1727740800000000)}`);

const BASE = Date.UTC(2025, 0, 1) * 1000;
const keys = {};
const users = {};
const user = (name, objects) => {
  const secret = blake3(enc.encode(`qa-synth:${name}`));
  const pk = Keypair.fromSecret(secret).publicKey.z32();
  keys[pk] = Buffer.from(secret).toString("hex");
  for (const [p, bytes] of objects(pk)) {
    const file = path.join(args.out, "replica", pk, "pub/pubky.app", p);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  }
  users[name] = pk;
};
const tags = (n) => function* () {
  for (let i = 0; i < n; i++) {
    const uri = `https://example.com/qa/${i}`;
    const label = "qa";
    yield [`tags/${hashId(enc.encode(`${uri}:${label}`))}`, enc.encode(JSON.stringify({ uri, label, created_at: BASE + i }))];
  }
};

user("tags1000", tags(1000));
user("tags1001", tags(1001));
user("tags2000", tags(2000));
user("blobs1500", function* (pk) {
  for (let i = 0; i < 1500; i++) {
    const bytes = enc.encode(`qa tiny blob ${i}`);
    const id = hashId(bytes);
    yield [`blobs/${id}`, bytes];
    const file = { name: `blob-${i}.png`, created_at: BASE + i, src: `pubky://${pk}/pub/pubky.app/blobs/${id}`, content_type: "image/png", size: bytes.length };
    yield [`files/${tsid(BASE + i)}`, enc.encode(JSON.stringify(file))];
  }
});
user("posts50k", function* () {
  for (let i = 0; i < 50_000; i++) {
    const post = { content: `qa post ${i}`, kind: "short", parent: null, embed: null, attachments: null };
    yield [`posts/${tsid(BASE + i * 1000)}`, enc.encode(JSON.stringify(post))];
  }
});

writeFileSync(path.join(args.out, "keys.json"), JSON.stringify(keys, null, 1), { mode: 0o600 });
writeFileSync(path.join(args.out, "map.json"), "{}\n", { mode: 0o600 });
writeFileSync(path.join(args.out, "manifest.json"), JSON.stringify({ users: {} }) + "\n");
// Names to replica keys, for the report; these keys are synthetic, not production's
writeFileSync(path.join(args.out, "users.json"), JSON.stringify(users, null, 1));
console.log(Object.entries(users).map(([n, pk]) => `${n} ${pk.slice(0, 10)}`).join("\n"));
