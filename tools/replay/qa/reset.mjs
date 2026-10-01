// Deletes the 1.x tree of each user named, four users at a time.
//
//   node qa/reset.mjs [--data data] --only <pk>...

import { parseArgs } from "node:util";
import { pool, replicaUsers, resetV1 } from "../testnet.mjs";

const { values: args } = parseArgs({ options: { data: { type: "string", default: "data" }, only: { type: "string", multiple: true } } });
const users = replicaUsers(args.data, args.only);
let deleted = 0;
const t0 = Date.now();
await pool(users, 4, async (u) => (deleted += await resetV1(u)));
console.log(JSON.stringify({ users: users.length, deleted, seconds: Math.round((Date.now() - t0) / 1000) }));
