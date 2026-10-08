// Turns the wasm-bindgen glue of the migrator into the modules the package ships: an ES module
// that loads nothing at import time, in two builds. dist/migration/glue.js carries the wasm
// inside it, so it works in a browser, a worker, Deno and Bun with no fetch and no file read;
// dist/migration/glue.node.js reads dist/migration/glue.wasm, which Node does faster. The
// package's `#glue` import picks one by the `node` condition.
//
// wasm-bindgen's nodejs target reads and instantiates the wasm synchronously as the module is
// evaluated. The tail of the generated file is replaced by an async `__wbg_init()`, and the
// CommonJS exports by ES ones.

import { createHash } from "node:crypto";
import { copyFile, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../pkg");
const name = "pubky_social_specs";
const built = path.join(pkg, "nodejs");
const out = path.join(pkg, "dist/migration");

const glue = await readFile(path.join(built, `${name}.js`), "utf8");

// The generated tail: read the bytes, compile, instantiate, start. Fail loudly if a
// wasm-bindgen upgrade changes it, rather than ship a glue that loads at import time.
const tail =
  /\nconst wasmPath = `\$\{__dirname\}\/\w+_bg\.wasm`;\nconst wasmBytes = require\('fs'\)\.readFileSync\(wasmPath\);\nconst wasmModule = new WebAssembly\.Module\(wasmBytes\);\nlet wasm = new WebAssembly\.Instance\(wasmModule, __wbg_get_imports\(\)\)\.exports;\nwasm\.__wbindgen_start\(\);\n?$/;
if (!tail.test(glue)) {
  throw new Error("patch.mjs: the wasm-bindgen glue tail changed; update the loader patch");
}

const wasm = await readFile(path.join(built, `${name}_bg.wasm`));
const base64 = wasm.toString("base64");
// Checked by migration/wasm.ts before the bytes are compiled: a glue whose bytes were changed
// after the build, or cut short, never runs
const sha256 = createHash("sha256").update(wasm).digest("hex");
// The tail becomes an async start over bytes the caller checked; where the bytes come from is
// the one difference between the two builds
const loader = `
let wasm;
/** Compiles and starts \`bytes\`, the ones \`__wbg_bytes\` gave once their digest was checked. */
async function __wbg_init(bytes) {
  const { instance } = await WebAssembly.instantiate(bytes, __wbg_get_imports());
  wasm = instance.exports;
  wasm.__wbindgen_start();
}
const __wbg_sha256 = ${JSON.stringify(sha256)};
`;
const common = glue.replace(/^exports\.(\w+) = (\w+);$/gm, "export { $2 as $1 };").replace(tail, () => loader);

// Browsers, workers, Deno, Bun and bundlers: the wasm inside the module, no fetch and no file read
const embedded =
  common +
  `
/** The embedded wasm, decoded. */
function __wbg_bytes() {
  return __toBinary(${JSON.stringify(base64)});
}
function __toBinary(base64) {
  const table = new Uint8Array(128);
  for (let i = 0; i < 64; i++) table[i < 26 ? i + 65 : i < 52 ? i + 71 : i < 62 ? i - 4 : i * 4 - 205] = i;
  const n = base64.length;
  const bytes = new Uint8Array(((n - (base64[n - 1] == "=") - (base64[n - 2] == "=")) * 3) / 4 | 0);
  for (let i = 0, j = 0; i < n; ) {
    const c0 = table[base64.charCodeAt(i++)], c1 = table[base64.charCodeAt(i++)];
    const c2 = table[base64.charCodeAt(i++)], c3 = table[base64.charCodeAt(i++)];
    bytes[j++] = (c0 << 2) | (c1 >> 4);
    bytes[j++] = (c1 << 4) | (c2 >> 2);
    bytes[j++] = (c2 << 6) | c3;
  }
  return bytes;
}
export { __wbg_bytes, __wbg_init, __wbg_sha256 };
`;

// Node: the wasm read from the file beside the module, which skips decoding a megabyte of base64
const fromFile =
  `import { readFileSync } from "node:fs";\n` +
  common +
  `
/** The wasm beside this module. */
function __wbg_bytes() {
  return new Uint8Array(readFileSync(new URL("./glue.wasm", import.meta.url)));
}
export { __wbg_bytes, __wbg_init, __wbg_sha256 };
`;
for (const [file, text] of [["glue.js", embedded], ["glue.node.js", fromFile]]) {
  if (/\bexports\.|\brequire\(|\bmodule\.exports\b/.test(text)) throw new Error(`patch.mjs: CommonJS left in ${file}`);
}

await writeFile(path.join(out, "glue.js"), embedded);
await writeFile(path.join(out, "glue.node.js"), fromFile);
await copyFile(path.join(built, `${name}_bg.wasm`), path.join(out, "glue.wasm"));

// tsc does not carry a hand-written declaration over to the output
await copyFile(path.join(pkg, "src/migration/glue.d.ts"), path.join(out, "glue.d.ts"));
await rm(built, { recursive: true });
