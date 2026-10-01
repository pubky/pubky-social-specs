// A user whose TimestampIds sit around the moment it is written: posts from 90 minutes ago to 6
// hours ahead, and a File and its blob an hour ahead that a post two hours old attaches. Run
// right before the clock case, since "now" moves.
//
//   node qa/clockuser.mjs [--out data/qa/clock]

import { blake3 } from "@noble/hashes/blake3.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { Keypair } from "@synonymdev/pubky";

const { values: args } = parseArgs({ options: { out: { type: "string", default: "data/qa/clock" } } });
rmSync(path.join(args.out, "replica"), { recursive: true, force: true });
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const crockford = (bytes) => {
  let bits = 0, value = 0, out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
};
const tsid = (micros) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, BigInt(micros)); return crockford(b); };
const enc = new TextEncoder();
const secret = blake3(enc.encode("qa-clock"));
const pk = Keypair.fromSecret(secret).publicKey.z32();
const now = Date.now() * 1000;
const H = 3_600_000_000;
const files = {};
const put = (p, text) => {
  const file = path.join(args.out, "replica", pk, "pub/pubky.app", p);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof text === "string" ? enc.encode(text) : text);
  files[p] = typeof text === "string" ? text.length : text.length;
};
const offsets = { "-90m": -1.5 * H, "-30m": -0.5 * H, "+1h": H, "+3h": 3 * H, "+4h": 4 * H, "+6h": 6 * H };
const ids = {};
for (const [label, off] of Object.entries(offsets)) {
  ids[label] = tsid(now + off);
  put(`posts/${ids[label]}`, JSON.stringify({ content: `post at ${label}`, kind: "short", parent: null, embed: null, attachments: null }));
}
const blob = enc.encode("qa clock blob");
const blobId = crockford(blake3(blob).slice(0, 16));
put(`blobs/${blobId}`, blob);
const fileId = tsid(now + H + 1);
put(`files/${fileId}`, JSON.stringify({ name: "clock.png", created_at: now + H, src: `pubky://${pk}/pub/pubky.app/blobs/${blobId}`, content_type: "image/png", size: blob.length }));
const attaching = tsid(now - 2 * H);
put(`posts/${attaching}`, JSON.stringify({ content: "attaches the +1h file", kind: "image", parent: null, embed: null, attachments: [`pubky://${pk}/pub/pubky.app/files/${fileId}`] }));
put("profile.json", JSON.stringify({ name: "clock", bio: null, image: null, links: null, status: null }));
writeFileSync(path.join(args.out, "keys.json"), JSON.stringify({ [pk]: Buffer.from(secret).toString("hex") }), { mode: 0o600 });
writeFileSync(path.join(args.out, "map.json"), "{}\n", { mode: 0o600 });
writeFileSync(path.join(args.out, "manifest.json"), JSON.stringify({ users: {} }) + "\n");
writeFileSync(path.join(args.out, "ids.json"), JSON.stringify({ pk: pk.slice(0, 10), generatedAt: new Date(now / 1000).toISOString(), posts: ids, file: fileId, attaching }, null, 1));
console.log(JSON.stringify({ pk: pk.slice(0, 10), ids, file: fileId, attaching }));
