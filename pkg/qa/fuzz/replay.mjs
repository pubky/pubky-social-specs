// The fuzzer's corpus, asked of the reference and of the package: coverage-guided inputs, held to
// the same answers the differential fuzz holds generated ones to. Exits 1 on any difference and
// writes them to qa/failures/fuzz-<target>.json. Run from pkg/ with the oracle built:
//
//   node --max-old-space-size=1536 qa/fuzz/replay.mjs

import fs from "node:fs";
import { Reader } from "../../dist/json/read.js";
import { answer } from "../ops.mjs";
import { ask } from "../oracle.mjs";

const OWNER = "8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto";
const ID = "0035QZPT4QG00";
// The instant the targets' ids were minted at, so a time bound reads them as the fuzzer did
const NOW = 1_790_000_000_000_000;
// The targets' URLs, in their order
const URLS = [
  `pubky://${OWNER}/pub/social/v1/posts/${ID}/${ID}.json`,
  `pubky://${OWNER}/priv/social/v1/posts/${ID}/${ID}-a-slug.json`,
  `pubky://${OWNER}/pub/social/v1/profile.json`,
  `pubky://${OWNER}/pub/social/v1/follows/dzswkfy7ek3bqnoc89jxuqqfbzhjrj6mi8qthgbxxcqkdugm3rio.json`,
  `pubky://${OWNER}/priv/social/v1/mutes/dzswkfy7ek3bqnoc89jxuqqfbzhjrj6mi8qthgbxxcqkdugm3rio.json`,
  `pubky://${OWNER}/pub/social/v1/tags/8Z8CWH8NVYQY39ZEBFGKQWWEKG.json`,
  `pubky://${OWNER}/priv/social/v1/bookmarks/~8Z8CWH8NVYQY39ZEBFGKQWWEKG.json`,
  `pubky://${OWNER}/priv/social/v1/feeds/8Z8CWH8NVYQY39ZEBFGKQWWEKG.json`,
];
const BUILDERS = ["createPost", "createUser", "createFeed"];
const decoder = new TextDecoder("utf-8", { fatal: true });
const request = (op, ...args) => ({ op, args, now: NOW, last: 0 });
const text = (bytes) => {
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
};

// Each corpus file as the request the target made of it, or null when the target made none
const TARGETS = {
  decode: (data) => (data.length === 0 ? null : request("decode", { s: URLS[data[0] % URLS.length] }, { b: Buffer.from(data.subarray(1)).toString("base64") })),
  uri: (data) => {
    const s = text(data);
    return s === null ? null : request("parseUri", { s });
  },
  build: (data) => {
    const builder = BUILDERS[data[0] % 5];
    const j = data.length > 0 ? text(data.subarray(1)) : null;
    if (builder === undefined || j === null) return null;
    try {
      JSON.parse(j);
      // The package takes a JS object, which holds no key twice; such text is no input of it
      return hasDuplicateKey(j) ? null : request(builder, { s: OWNER }, { j });
    } catch {
      return null;
    }
  },
};

/** Whether JSON text names a key twice in one object, which no JS object can hold. */
function hasDuplicateKey(json) {
  const r = new Reader(new TextEncoder().encode(json));
  let duplicate = false;
  const walk = () => {
    const b = r.peekToken();
    if (b === 0x7b) {
      const seen = new Set();
      r.object((key) => {
        duplicate ||= seen.has(key);
        seen.add(key);
        return walk;
      });
    } else if (b === 0x5b) r.array(walk);
    else r.value();
  };
  walk();
  return duplicate;
}

const canonical = (value) => JSON.stringify(value, (_, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v));
let clean = true;
for (const [target, make] of Object.entries(TARGETS)) {
  const dir = new URL(`corpus/${target}/`, import.meta.url);
  if (!fs.existsSync(dir)) continue;
  const asked = fs
    .readdirSync(dir)
    .map((name) => make(new Uint8Array(fs.readFileSync(new URL(name, dir)))))
    .filter((q) => q !== null);
  const reference = await ask(asked);
  const wrong = [];
  asked.forEach((q, i) => {
    // A request the reference cannot read is no answer to compare
    if (reference[i].err?.startsWith("surface:")) return;
    let got;
    try {
      got = answer(q);
    } catch (e) {
      // A caller's value of the wrong shape: the reference refuses it as JSON, the package as an
      // argument, and both refusing is the agreement
      if (e?.name === "ArgumentError" && reference[i].err !== undefined) return;
      got = { threw: `${e?.name}: ${e?.message}` };
    }
    if (canonical(got) !== canonical(reference[i])) wrong.push({ q, want: reference[i], got });
  });
  console.log(`${wrong.length ? "FAIL" : "ok  "} ${target.padEnd(7)} ${asked.length} inputs, ${wrong.length} answered differently`);
  if (wrong.length) {
    clean = false;
    fs.mkdirSync(new URL("../failures/", import.meta.url), { recursive: true });
    fs.writeFileSync(new URL(`../failures/fuzz-${target}.json`, import.meta.url), JSON.stringify(wrong.slice(0, 50), null, 1));
  }
}
process.exit(clean ? 0 : 1);
