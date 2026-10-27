// What the package costs a bundle and a cold start. Each probe is one import a real caller
// writes, bundled and minified by esbuild; the gate is on the gzipped size, and on what a
// small import must not drag in.
//
//   node qa/size.mjs

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { OWNER } from "./lib.mjs";

const at = (file) => new URL(file.startsWith("migrator/") ? `../../migrator/dist/${file.slice("migrator/".length)}` : `../dist/${file}`, import.meta.url).pathname;
const entry = at("index.js");
/** `names` imported from `file` and kept, bundled and minified as a caller's bundler would. */
const bundled = async (file, names, define = {}) => {
  const { outputFiles } = await build({
    stdin: { contents: `import ${names} from ${JSON.stringify(file)}; globalThis.keep = [${names.replace(/[{}* ]|as /g, "")}];`, resolveDir: "." },
    bundle: true,
    minify: true,
    format: "esm",
    write: false,
    logLevel: "silent",
    define,
  });
  return outputFiles[0].text;
};

const PROBES = [
  // [entry, what is imported, gzipped budget in bytes, what must not be in the bundle]. The
  // 1.1 kinds add about 5 to 7 KB to the entries that carry the post rules
  ["index.js", "{ buildUri }", 3_600, ["Too many attachments", "WebAssembly"]],
  ["index.js", "{ parseUri }", 17_000, ["Too many attachments", "WebAssembly"]],
  ["index.js", "{ limits }", 1_000, ["blake3", "WebAssembly"]],
  ["index.js", "{ buildPost }", 23_000, ["WebAssembly"]],
  ["index.js", "{ decodeObject }", 26_500, ["WebAssembly"]],
  ["index.js", "{ validatePost }", 23_500, ["WebAssembly"]],
  ["index.js", "* as all", 38_000, ["WebAssembly"]],
  ["testing.js", "{ setClock }", 1_000, ["WebAssembly", "Too many attachments"]],
  ["testing.js", "* as all", 29_000, ["WebAssembly"]],
  ["client/index.js", "{ createSocialClient }", 35_500, ["WebAssembly"]],
  // pubky-social-migrator: its engine, the wasm of the crate built with the migrator feature (the
  // 0.x transforms and the 1.x reader every migrated object goes through, the 1.1 kinds included)
  // and the public entry of the core it calls, bundled in
  ["migrator/index.js", "* as all", 389_000, []],
  ["migrator/adapters/pubky-sdk.js", "* as all", 5_000, ["WebAssembly"]],
];

let failed = false;
for (const [file, names, budget, absent] of PROBES) {
  const code = await bundled(at(file), names);
  const gzipped = gzipSync(code).length;
  const dragged = absent.filter((marker) => code.includes(marker));
  const ok = gzipped <= budget && dragged.length === 0;
  failed ||= !ok;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${file.padEnd(32)} import ${names.padEnd(18)} ${String(code.length).padStart(7)} B min  ${String(gzipped).padStart(6)} B gzip  (budget ${budget})${dragged.length ? `  drags in: ${dragged.join(", ")}` : ""}`,
  );
}

// A production build drops the development warnings, code and text
const production = await bundled(entry, "{ decodeObject, encodeObject, editPost }", { "process.env.NODE_ENV": '"production"' });
const kept = production.includes("$unknown members the object was read with");
failed ||= kept;
console.log(`${kept ? "FAIL" : "ok  "} a production build drops the development warning`);

// A cold process: load the entry, build one post. No init, so this is the whole start
const cold = `const t=performance.now();const m=await import(${JSON.stringify(entry)});const l=performance.now();m.buildPost(${JSON.stringify(OWNER)},{content:"hi"});console.log((l-t).toFixed(1),(performance.now()-l).toFixed(2))`;
const runs = Array.from({ length: 9 }, () => execFileSync(process.execPath, ["--input-type=module", "-e", cold]).toString().trim().split(" ").map(Number));
const load = Math.min(...runs.map((r) => r[0]));
const first = Math.min(...runs.map((r) => r[1]));
const startOk = load < 250 && first < 5;
failed ||= !startOk;
console.log(`${startOk ? "ok  " : "FAIL"} cold start: load ${load} ms (budget 250, unbundled files off disk), first call ${first} ms (budget 5)`);
process.exit(failed ? 1 : 0);
