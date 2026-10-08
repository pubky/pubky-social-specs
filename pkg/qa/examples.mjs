// Every value an entry exports has an `@example`, and every example compiles against the built
// declarations as a consumer's code does and runs. An example that declares what it cannot
// make (an SDK session) is compiled only.
//
//   node qa/examples.mjs   (after a build; in npm test)

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const out = path.join(pkg, "qa/out/examples");
const ENTRIES = { ".": "index", "./testing": "testing", "./migration": "migration/index", "./migration/pubky-sdk": "migration/adapters/pubky-sdk", "./client": "client/index" };

// name -> the example blocks of its declaration, from every declaration file of the build
const examples = new Map();
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".d.ts") ? [path.join(dir, e.name)] : []));
for (const file of walk(path.join(pkg, "dist"))) {
  const text = fs.readFileSync(file, "utf8");
  for (const [, doc, name] of text.matchAll(/\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*(?:export )?(?:declare )?(?:async )?(?:function|const|class) (\w+)/g)) {
    const blocks = [...doc.matchAll(/@example\s*\n\s*\*\s*```ts\n([\s\S]*?)\n\s*\*\s*```/g)].map((m) => m[1].replace(/^\s*\* ?/gm, ""));
    if (blocks.length > 0 && !examples.has(name)) examples.set(name, blocks);
  }
}

const missing = [];
const written = [];
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const [entry, module] of Object.entries(ENTRIES)) {
  const exported = Object.keys(await import(pathToFileURL(path.join(pkg, "dist", `${module}.js`))));
  for (const name of exported) {
    const blocks = examples.get(name);
    if (blocks === undefined) {
      missing.push(`${entry} ${name}`);
      continue;
    }
    blocks.forEach((code, i) => {
      const file = path.join(out, `${module.replaceAll("/", "-")}-${name}-${i}.ts`);
      // A module of its own, so top-level await and names never clash
      fs.writeFileSync(file, `${code}\nexport {};\n`);
      written.push({ file, runs: !/^declare /m.test(code) });
    });
  }
}
if (missing.length > 0) {
  console.error(`exports with no @example:\n  ${missing.join("\n  ")}`);
  process.exit(1);
}

fs.writeFileSync(
  path.join(out, "tsconfig.json"),
  JSON.stringify({ compilerOptions: { target: "es2022", lib: ["es2022", "dom"], module: "nodenext", strict: true, types: [], skipLibCheck: false, outDir: "js" }, include: ["*.ts"] }),
);
try {
  execFileSync(process.execPath, [path.join(pkg, "node_modules/typescript/bin/tsc"), "-p", out], { stdio: "pipe" });
} catch (e) {
  console.error(`an example does not compile:\n${e.stdout}${e.stderr}`);
  process.exit(1);
}

const failed = [];
const log = console.log;
console.log = () => {};
for (const { file, runs } of written) {
  if (!runs) continue;
  try {
    await import(pathToFileURL(path.join(out, "js", `${path.basename(file, ".ts")}.js`)));
  } catch (e) {
    failed.push(`${path.basename(file)}: ${e.message}`);
  }
}
console.log = log;
if (failed.length > 0) {
  console.error(`an example threw:\n  ${failed.join("\n  ")}`);
  process.exit(1);
}
console.log(`examples: ${written.length} compiled, ${written.filter((w) => w.runs).length} ran, every export of every entry has one`);
