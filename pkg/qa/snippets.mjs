// Every ```js block of the shipped docs runs as pasted. Each block is type-checked against the
// package's declarations and the real SDK's, then run in a process of its own; one preceded by
// `<!-- no-run: reason -->` is type-checked only. A block takes what it needs from
// docs/prelude.js, which stands in for a signed-in SDK session.
//
//   node qa/snippets.mjs   (after tsc -p .; in npm test)

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const out = path.join(pkg, "qa/out/snippets");
const DOCS = [
  "README.md",
  "MIGRATION.md",
  ...fs
    .readdirSync(path.join(pkg, "docs"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => `docs/${f}`),
];
const prelude = path.join(pkg, "docs/prelude.js");

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const blocks = [];
for (const doc of DOCS) {
  const lines = fs.readFileSync(path.join(pkg, doc), "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== "```js") continue;
    const end = lines.indexOf("```", i + 1);
    const marker = /^<!-- no-run: (.+) -->$/.exec(lines[i - 1] ?? "") ?? /^<!-- no-run: (.+) -->$/.exec(lines[i - 2] ?? "");
    const code = lines
      .slice(i + 1, end)
      .join("\n")
      .replace(/(["'])\.\/(?:docs\/)?prelude\.js\1/g, JSON.stringify(prelude));
    const name = `${doc.replace(/[/.]/g, "-")}-${i + 1}`;
    fs.writeFileSync(path.join(out, `${name}.mjs`), `${code}\nexport {};\n`);
    blocks.push({ doc, line: i + 1, name, runs: marker === null });
    i = end;
  }
}

// Plain JavaScript, checked as an editor checks it: a member that does not exist, a misspelled
// option or a name never defined fails here. The Node modules a block imports are declared as
// far as the blocks use them, since the package installs no Node types
fs.writeFileSync(
  path.join(out, "node.d.ts"),
  `declare module "node:test" { export function test(name: string, fn: () => unknown): Promise<void>; }
declare module "node:assert" { const assert: { deepStrictEqual(a: unknown, b: unknown): void; ok(v: unknown): void; strictEqual(a: unknown, b: unknown): void }; export default assert; }
declare module "node:fs/promises" { export function readFile(path: string): Promise<Uint8Array>; }
`,
);
fs.writeFileSync(
  path.join(out, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: { target: "es2022", lib: ["es2022", "dom"], module: "nodenext", allowJs: true, checkJs: true, noEmit: true, strict: true, noImplicitAny: false, skipLibCheck: true, types: [] },
    include: ["*.mjs", "node.d.ts"],
  }),
);
try {
  execFileSync(process.execPath, [path.join(pkg, "node_modules/typescript/bin/tsc"), "-p", out], { stdio: "pipe" });
} catch (e) {
  console.error(`a docs block does not type-check:\n${`${e.stdout}${e.stderr}`.replaceAll(`${out}/`, "")}`);
  process.exit(1);
}

const failed = [];
for (const block of blocks.filter((b) => b.runs)) {
  try {
    execFileSync(process.execPath, [path.join(out, `${block.name}.mjs`)], { stdio: "pipe", env: { ...process.env, NODE_ENV: "production" } });
  } catch (e) {
    failed.push(`${block.doc}:${block.line}: ${String(e.stderr).trim().split("\n").slice(0, 6).join("\n    ")}`);
  }
}
if (failed.length > 0) {
  console.error(`a docs block threw:\n  ${failed.join("\n  ")}`);
  process.exit(1);
}
fs.rmSync(out, { recursive: true, force: true });
const ran = blocks.filter((b) => b.runs).length;
console.log(`snippets: ${blocks.length} blocks in ${DOCS.length} docs type-checked, ${ran} ran, ${blocks.length - ran} marked no-run`);
