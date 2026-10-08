// Every export of every entry, and every member of an exported object type, carries the doc an
// editor shows on hover; a number member's doc names its unit. Reads the built declarations
// with the TypeScript checker, as an editor does.
//
//   node qa/hover.mjs [--list]   (after tsc -p .)
//
// Exits 1 and names each export or member that hovers empty.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// The compiler API: TypeScript 7 ships none, so the tools' TypeScript 6 reads the declarations
const ts = createRequire(new URL("../tools/package.json", import.meta.url))("typescript");

const pkg = fileURLToPath(new URL("..", import.meta.url));
const dist = path.join(pkg, "dist");
const ENTRIES = { ".": "index", "./testing": "testing", "./migration": "migration/index", "./migration/pubky-sdk": "migration/adapters/pubky-sdk", "./client": "client/index" };
const UNIT = /\b(code points?|bytes?|items?|milliseconds?|microseconds?|seconds?|ms|µs|steps?|attempts?|members?|urls?|entries|objects?|count|index|revision|status|HTTP)\b/i;

const files = Object.values(ENTRIES).map((module) => path.join(dist, `${module}.d.ts`));
const program = ts.createProgram(files, { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2022, strict: true, noEmit: true, types: [] });
const checker = program.getTypeChecker();
const ours = (symbol) => (symbol.declarations ?? []).some((d) => d.getSourceFile().fileName.startsWith(dist));
const docOf = (symbol) => ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim();

const empty = [];
const unitless = [];
const seen = new Set();
let checked = 0;

function members(type, owner, depth) {
  if (depth > 1) return;
  const parts = type.isUnion() || type.isIntersection() ? type.types : [type];
  for (const part of parts) {
    if (part.flags & (ts.TypeFlags.Primitive | ts.TypeFlags.Literal)) continue;
    if (checker.isArrayType(part) || checker.isTupleType(part)) continue;
    for (const property of checker.getPropertiesOfType(part)) {
      if (!ours(property) || property.name.startsWith("__") || property.name.startsWith("#")) continue;
      const key = `${owner}.${property.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      checked++;
      const doc = docOf(property);
      if (doc === "") empty.push(key);
      const declaration = property.valueDeclaration ?? property.declarations?.[0];
      const propertyType = declaration ? checker.getTypeOfSymbolAtLocation(property, declaration) : null;
      const numeric = propertyType && (checker.getNonNullableType(propertyType).flags & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral)) !== 0;
      if (numeric && doc !== "" && !UNIT.test(doc)) unitless.push(key);
    }
  }
}

for (const [entry, module] of Object.entries(ENTRIES)) {
  const source = program.getSourceFile(path.join(dist, `${module}.d.ts`));
  const moduleSymbol = checker.getSymbolAtLocation(source);
  for (let symbol of checker.getExportsOfModule(moduleSymbol)) {
    const name = `${entry === "." ? "" : `${entry.slice(2)}:`}${symbol.name}`;
    if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    checked++;
    if (docOf(symbol) === "") empty.push(name);
    const declaration = symbol.declarations?.[0];
    if (!declaration) continue;
    if (symbol.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias)) members(checker.getDeclaredTypeOfSymbol(symbol), name, 0);
    else if (symbol.flags & ts.SymbolFlags.Class) members(checker.getDeclaredTypeOfSymbol(symbol), name, 0);
    else if (symbol.flags & ts.SymbolFlags.Variable) members(checker.getTypeOfSymbolAtLocation(symbol, declaration), name, 0);
  }
}

if (process.argv.includes("--list")) for (const key of [...seen].filter((k) => typeof k === "string").sort()) console.log(key);
if (empty.length > 0) console.error(`hover is empty for ${empty.length}:\n  ${empty.join("\n  ")}`);
if (unitless.length > 0) console.error(`a number with no unit in its doc, ${unitless.length}:\n  ${unitless.join("\n  ")}`);
if (empty.length + unitless.length > 0) process.exit(1);
console.log(`hover: ${checked} exports and members, every one documented, every number with its unit`);
