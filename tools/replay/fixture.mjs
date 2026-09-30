// A replica of two users whose trees are the semantic vectors' 0.x tree (38 objects), for when
// no corpus is at hand: CI runs the replay's browser path over it every night.
//
//   node fixture.mjs [--out data]
//
// Writes what the remap would: `replica/<pk>/<path>`, `keys.json`, and an empty `map.json` and
// `manifest.json`, since no user comes from production. Keys derive from a fixed label, so the
// same replica comes out every time.

import { blake3 } from "@noble/hashes/blake3.js";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { Keypair } from "@synonymdev/pubky";
import { legacyTree, bytesOf } from "../../pkg/migration.fixture.js";

const USERS = 2;
const { values: args } = parseArgs({ options: { out: { type: "string", default: "data" } } });
if (existsSync(path.join(args.out, "replica"))) throw new Error(`${args.out}/replica exists: a fixture never overwrites a corpus`);

const keys = {};
for (let i = 0; i < USERS; i++) {
  const secret = blake3(new TextEncoder().encode(`replay-fixture:${i}`));
  const pk = Keypair.fromSecret(secret).publicKey.z32();
  keys[pk] = Buffer.from(secret).toString("hex");
  for (const [p, row] of legacyTree(pk)) {
    const file = path.join(args.out, "replica", pk, p);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytesOf(row));
  }
}
writeFileSync(path.join(args.out, "keys.json"), JSON.stringify(keys, null, 1), { mode: 0o600 });
writeFileSync(path.join(args.out, "map.json"), "{}\n");
writeFileSync(path.join(args.out, "manifest.json"), JSON.stringify({ users: {} }) + "\n");
console.log(`${USERS} users written to ${args.out}/replica`);
