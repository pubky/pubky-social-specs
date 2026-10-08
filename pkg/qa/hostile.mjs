// Hostile input against a time budget: each shape an attacker can store, at 64 to 512 KB, must
// decode (or be refused) within a per-byte budget and grow no faster than linearly. Run from
// pkg/ after a build:
//
//   node --expose-gc --max-old-space-size=1536 qa/hostile.mjs [--verbose]
//
// Exits 1 when a shape is over budget or superlinear.

import { decodeObject, parseUri } from "../dist/index.js";

const OWNER = "8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto";
const POST = `pubky://${OWNER}/pub/social/v1/posts/0035QZPT4QG00/0035QZPT4QG00.json`;
// Linear time is the guarantee; the ceiling makes the largest object, 512 KB, decode within half
// a second whatever its shape. The deepest shape, 120 nested arrays repeated, sits nearest it:
// JSON.parse itself spends about 90 ns a byte there allocating the containers
const NS_PER_BYTE = 1000;
// From the smallest input to the largest, eight times as long, time may grow at most this much:
// linear is 8, quadratic 64, and the slack absorbs a collection landing in one run
const MAX_GROWTH = 16;
const SIZES = [64, 128, 256, 512].map((k) => k * 1024);
const verbose = process.argv.includes("--verbose");

const fill = (unit, bytes) => unit.repeat(Math.max(1, Math.floor(bytes / unit.length)));
// A post whose unknown member `x` holds `json`; the post cap is 512 KB, so the largest size is
// refused by the cap before it is parsed, which is a shape of its own
const post = (json) => `{"content":"c","kind":"note","parent":null,"embed":null,"attachments":[],"x":${json}}`;
const SHAPES = {
  "nested arrays at the depth limit": (n) => post(fill("[".repeat(120) + "]".repeat(120) + ",", n).replace(/,$/, "").replace(/^/, "[") + "]"),
  "many keys": (n) => post(`{${Array.from({ length: Math.floor(n / 12) }, (_, i) => `"k${i}":${i}`).join(",")}}`),
  "one long digit run": (n) => post(`1${"0".repeat(n)}.5`),
  "many floats": (n) => post(`[${fill("1.7976931348623157e308,", n)}0]`),
  "escapes": (n) => post(`"${fill("\\u00e9\\n\\\"", n)}"`),
  "surrogate pairs": (n) => post(`"${fill("\\ud83d\\ude00", n)}"`),
  "the error path quoting a long string": (n) => `{"content":"c","kind":"${fill("̀", n / 2)}","parent":null,"embed":null,"attachments":[]}`,
  "a type error quoting a long string": (n) => `{"content":["${fill("é", n / 2)}"],"kind":"note","parent":null,"embed":null,"attachments":[]}`,
  "deep objects": (n) => post(fill(`{"a":`.repeat(100) + "1" + "}".repeat(100), n).replace(/\}\{/g, "},{").replace(/^/, "[") + "]"),
};

const encoder = new TextEncoder();
const collect = globalThis.gc ?? (() => {});
const time = (fn) => {
  const runs = [];
  fn();
  for (let i = 0; i < 7; i++) {
    collect();
    const start = performance.now();
    fn();
    runs.push(performance.now() - start);
  }
  return runs.sort((a, b) => a - b)[3];
};
const attempt = (bytes) => () => {
  try {
    decodeObject(POST, bytes);
  } catch (e) {
    if (e?.name !== "ValidationError") throw e;
  }
};

let failed = false;
// The largest input is refused by the cap before it is read, so growth is judged up to the last
// input that was read, against the first, scaled to their sizes
const grows = (rows) => {
  const read = rows.filter((row) => row.ms > 0.5);
  if (read.length < 2) return false;
  const [first, last] = [read[0], read[read.length - 1]];
  // Below a couple of milliseconds a run is mostly timer and collector noise
  return last.ms / Math.max(first.ms, 2) > (MAX_GROWTH * last.size) / (8 * first.size);
};
const report = (name, ms, bytes) => {
  const nsPerByte = (ms * 1e6) / bytes;
  return { ms, nsPerByte, over: nsPerByte > NS_PER_BYTE };
};

for (const [name, make] of Object.entries(SHAPES)) {
  const rows = SIZES.map((size) => {
    const bytes = encoder.encode(make(size));
    return { size: bytes.length, ...report(name, time(attempt(bytes)), bytes.length) };
  });
  const superlinear = grows(rows);
  const over = rows.some((row) => row.over);
  failed ||= over || superlinear;
  const worst = Math.max(...rows.map((row) => row.nsPerByte));
  console.log(`${over || superlinear ? "FAIL" : "ok  "} ${name.padEnd(40)} worst ${worst.toFixed(0).padStart(4)} ns/byte${superlinear ? ", superlinear" : ""}`);
  if (verbose) for (const row of rows) console.log(`       ${String(row.size).padStart(7)} B  ${row.ms.toFixed(2).padStart(8)} ms`);
}

// The URI parser on any string: linear, and refused without quoting more than it read
for (const [name, text] of [
  ["parseUri, a long path", (n) => `pubky://${OWNER}/pub/social/v1/${fill("a/", n)}x`],
  ["parseUri, a long garbage string", (n) => fill("%zz?#", n)],
]) {
  const rows = SIZES.map((size) => {
    const uri = text(size);
    return { size, ms: time(() => {
      try {
        parseUri(uri);
      } catch (e) {
        if (e?.name !== "ValidationError") throw e;
      }
    }) };
  });
  const worst = Math.max(...rows.map((row) => (row.ms * 1e6) / row.size));
  const over = worst > NS_PER_BYTE;
  const superlinear = grows(rows);
  failed ||= over || superlinear;
  console.log(`${over || superlinear ? "FAIL" : "ok  "} ${name.padEnd(40)} worst ${worst.toFixed(0).padStart(4)} ns/byte${superlinear ? ", superlinear" : ""}`);
}

process.exit(failed ? 1 : 0);
