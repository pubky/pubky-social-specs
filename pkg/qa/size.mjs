// What the package costs a bundle and a cold start. Each probe is one import a real caller
// writes, bundled and minified by esbuild; the gate is on the gzipped size, and on what a
// small import must not drag in.
//
//   node qa/size.mjs

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";

const entry = new URL("../dist/index.js", import.meta.url).pathname;

const PROBES = [
  // [what is imported, gzipped budget in bytes, what must not be in the bundle]
  ["{ buildUri }", 3_000, ["Too many attachments", "WebAssembly"]],
  ["{ parseUri }", 17_000, ["Too many attachments", "WebAssembly"]],
  ["{ limits }", 1_000, ["blake3", "WebAssembly"]],
  ["{ buildPost }", 20_000, ["WebAssembly"]],
  ["{ decodeObject }", 22_000, ["WebAssembly"]],
  ["* as all", 30_000, ["WebAssembly"]],
];

let failed = false;
for (const [names, budget, absent] of PROBES) {
  const { outputFiles } = await build({
    stdin: { contents: `import ${names} from ${JSON.stringify(entry)}; globalThis.keep = ${names.replace(/[{}* ]|as /g, "")};`, resolveDir: "." },
    bundle: true,
    minify: true,
    format: "esm",
    write: false,
    logLevel: "silent",
  });
  const code = outputFiles[0].text;
  const gzipped = gzipSync(code).length;
  const dragged = absent.filter((marker) => code.includes(marker));
  const ok = gzipped <= budget && dragged.length === 0;
  failed ||= !ok;
  console.log(`${ok ? "ok  " : "FAIL"} import ${names.padEnd(18)} ${String(code.length).padStart(7)} B min  ${String(gzipped).padStart(6)} B gzip  (budget ${budget})${dragged.length ? `  drags in: ${dragged.join(", ")}` : ""}`);
}

// A cold process: load the entry, build one post. No init, so this is the whole start
const cold = `const t=performance.now();const m=await import(${JSON.stringify(entry)});const l=performance.now();m.buildPost("8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo",{content:"hi"});console.log((l-t).toFixed(1),(performance.now()-l).toFixed(2))`;
const runs = Array.from({ length: 9 }, () => execFileSync(process.execPath, ["--input-type=module", "-e", cold]).toString().trim().split(" ").map(Number));
const load = Math.min(...runs.map((r) => r[0]));
const first = Math.min(...runs.map((r) => r[1]));
const startOk = load < 250 && first < 5;
failed ||= !startOk;
console.log(`${startOk ? "ok  " : "FAIL"} cold start: load ${load} ms (budget 250, unbundled files off disk), first call ${first} ms (budget 5)`);
process.exit(failed ? 1 : 0);
