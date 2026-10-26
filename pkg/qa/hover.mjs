// Every export of every entry of either package, and every member of an exported object type, carries the doc an
// editor shows on hover; a number member's doc names its unit. Reads the built declarations
// with the TypeScript checker, as an editor does.
//
//   node qa/hover.mjs [--list]   (after tsc -p .)
//
// Exits 1 and names each export or member that hovers empty.

import path from "node:path";
import { ENTRIES, MIGRATOR, MIGRATOR_ENTRIES, PKG, declarations, flags } from "./lib.mjs";

const dists = [path.join(PKG, "dist"), path.join(MIGRATOR, "dist")];
const modules = [
  ...Object.entries(ENTRIES).map(([entry, module]) => [entry, path.join(dists[0], `${module}.d.ts`)]),
  ...Object.entries(MIGRATOR_ENTRIES).map(([entry, module]) => [`migrator${entry.slice(1)}`, path.join(dists[1], `${module}.d.ts`)]),
];
const UNIT =
  /\b(code points?|bytes?|items?|milliseconds?|microseconds?|seconds?|ms|µs|steps?|attempts?|members?|urls?|entries|objects?|count|index|revision|status|HTTP|people|units|days|years|metres|degrees|digits|half stars|stars|occurrences|periods|places|links|blocks|rules?|waypoints|dates|id)\b/i;

const { ts, program, checker } = declarations(modules.map(([, file]) => file));
const ours = (symbol) => (symbol.declarations ?? []).some((d) => dists.some((dist) => d.getSourceFile().fileName.startsWith(dist)));
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

for (const [entry, file] of modules) {
  const source = program.getSourceFile(file);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  for (let symbol of checker.getExportsOfModule(moduleSymbol)) {
    const name = `${entry === "." ? "" : `${entry.replace(/^\.\//, "")}:`}${symbol.name}`;
    if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    checked++;
    if (docOf(symbol) === "") empty.push(name);
    const declaration = symbol.declarations?.[0];
    if (!declaration) continue;
    if (symbol.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias | ts.SymbolFlags.Class)) members(checker.getDeclaredTypeOfSymbol(symbol), name, 0);
    else if (symbol.flags & ts.SymbolFlags.Variable) members(checker.getTypeOfSymbolAtLocation(symbol, declaration), name, 0);
  }
}

if (flags({ list: { type: "boolean", default: false } }).list) for (const key of [...seen].filter((k) => typeof k === "string").sort()) console.log(key);
if (empty.length > 0) console.error(`hover is empty for ${empty.length}:\n  ${empty.join("\n  ")}`);
if (unitless.length > 0) console.error(`a number with no unit in its doc, ${unitless.length}:\n  ${unitless.join("\n  ")}`);
if (empty.length + unitless.length > 0) process.exit(1);
console.log(`hover: ${checked} exports and members, every one documented, every number with its unit`);
