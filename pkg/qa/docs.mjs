// Writes docs/reference.md from the built package: the limits with their values, the media types
// with their extensions, every stored object member by member, and the error codes. The text is
// the declarations' own JSDoc, so the reference and an editor's hover cannot disagree; a bound a
// member's doc states has to be a value of `limits`, so neither can drift from the data model.
//
//   node qa/docs.mjs [--check]   (after tsc -p .)

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The compiler API: TypeScript 7 ships none, so the tools' TypeScript 6 reads the declarations
const ts = createRequire(new URL("../tools/package.json", import.meta.url))("typescript");
const pkg = fileURLToPath(new URL("..", import.meta.url));
const file = path.join(pkg, "docs/reference.md");
const check = process.argv.includes("--check");

const { limits, validMimeTypes, MIME_TO_EXT } = await import(pathToFileURL(path.join(pkg, "dist/data.js")));
const entry = path.join(pkg, "dist/index.d.ts");
const program = ts.createProgram([entry], {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2022,
  strict: true,
  noEmit: true,
  types: [],
});
const checker = program.getTypeChecker();
const exported = new Map(checker.getExportsOfModule(checker.getSymbolAtLocation(program.getSourceFile(entry))).map((s) => [s.name, s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s]));
const doc = (symbol) => ts.displayPartsToString(symbol.getDocumentationComment(checker)).replace(/\s+/g, " ").trim();
const cell = (text) => text.replaceAll("|", "\\|");

const unitOf = (name) => (name.endsWith("Bytes") ? "bytes" : name.endsWith("Count") ? "items" : name.endsWith("Length") ? "code points" : "");
const limitsType = checker.getTypeOfSymbolAtLocation(exported.get("limits"), exported.get("limits").valueDeclaration);
const limitRows = checker.getPropertiesOfType(limitsType).map((p) => {
  const value = limits[p.name];
  const shown = Array.isArray(value) ? value.map((v) => `\`${JSON.stringify(v)}\``).join(" ") : String(value);
  const text = doc(p).replace(/, in [a-z ]+: \d+\.$/, ".");
  return `| \`${p.name}\` | ${shown} | ${unitOf(p.name)} | ${cell(text)} |`;
});

const mapped = new Map(MIME_TO_EXT);
const mimeRows = [...new Set([...validMimeTypes, ...mapped.keys()])].sort().map((type) => `| \`${type}\` | \`.${mapped.get(type) ?? "bin"}\` |`);

const OBJECTS = ["User", "UserLink", "Post", "Attachment", "ArticleContent", "CollectionContent", "CollectionItem", "Tag", "Bookmark", "Follow", "Mute", "Feed", "FeedConfig"];
const limitValues = new Set(Object.values(limits).filter((v) => typeof v === "number"));
const claims = [];
const objectSections = OBJECTS.map((name) => {
  const symbol = exported.get(name);
  const type = checker.getDeclaredTypeOfSymbol(symbol);
  // `$unknown` last: it is what is left once the known members are read
  const properties = checker.getPropertiesOfType(type);
  const rows = [...properties.filter((p) => p.name !== "$unknown"), ...properties.filter((p) => p.name === "$unknown")].map((p) => {
    const t = checker.getTypeOfSymbolAtLocation(p, p.valueDeclaration ?? p.declarations[0]);
    const nullable = t.isUnion() && t.types.some((u) => u.flags & ts.TypeFlags.Null) ? "yes" : "";
    const spelled = checker.typeToString(checker.getNonNullableType(t), undefined, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope);
    const text = doc(p);
    // Every bound a doc states is a limit of the model; "0.x" and "1.x" are epochs, "0-9" a range
    for (const [, n] of text
      .replace(/`[^`]*`/g, "")
      .replace(/\b\d+\.x\b/g, "")
      .replace(/0-9/g, "")
      .matchAll(/\b(\d+)\b/g)) {
      if (!limitValues.has(Number(n)) && n !== "1") claims.push(`${name}.${p.name}: ${n} is no value of limits`);
    }
    const optional = p.flags & ts.SymbolFlags.Optional ? " (optional)" : "";
    return `| \`${p.name}\`${optional} | \`${cell(spelled)}\` | ${nullable} | ${cell(text)} |`;
  });
  return `### ${name}\n\n${doc(symbol)}\n\n| member | type | null | meaning |\n|---|---|---|---|\n${rows.join("\n")}`;
});
// The builder inputs state bounds too, and have no table of their own
for (const name of ["NewUser", "NewAttachment", "NewNote", "NewArticle", "NewCollection", "NewFeed"]) {
  const type = checker.getDeclaredTypeOfSymbol(exported.get(name));
  for (const p of checker.getPropertiesOfType(type)) {
    for (const [, n] of doc(p)
      .replace(/`[^`]*`/g, "")
      .replace(/0-9/g, "")
      .matchAll(/\b(\d+)\b/g)) {
      if (!limitValues.has(Number(n)) && n !== "1") claims.push(`${name}.${p.name}: ${n} is no value of limits`);
    }
  }
}
if (claims.length > 0) {
  console.error(`a member's doc states a bound the data model does not have:\n  ${claims.join("\n  ")}`);
  process.exit(1);
}

// The codes and their meaning, from the doc of `ErrorCode` itself
const errorDoc = ts.displayPartsToString(exported.get("ErrorCode").getDocumentationComment(checker));
const codeRows = [...errorDoc.matchAll(/^- `(\w+)`: (.+?)(?=\n- |\n*$)/gms)].map(([, code, text]) => `| \`${code}\` | ${cell(text.replace(/\s+/g, " ").trim().replace(/[;.]$/, ""))} |`);
const union = checker.getDeclaredTypeOfSymbol(exported.get("ErrorCode"));
const codes = union.types.map((t) => t.value).sort();
const listed = codeRows.map((row) => /^\| `(\w+)`/.exec(row)[1]).sort();
if (JSON.stringify(codes) !== JSON.stringify(listed)) {
  console.error(`ErrorCode's doc lists ${listed.join(", ")}, its type ${codes.join(", ")}`);
  process.exit(1);
}

const text = `# Reference

Generated from the package by \`qa/docs.mjs\`; \`npm run docs:check\` fails when it is stale. Every
text below is the doc an editor shows on hover.

## Limits

\`limits\`, exported from the package. A builder, a validator and \`decodeObject\` refuse past each
one with a \`ValidationError\` whose \`code\` is \`length\`, \`count\` or \`size\` and whose \`limit\` is
the value here. A length counts Unicode code points, not UTF-16 units and not bytes.

| name | value | unit | what it bounds |
|---|---|---|---|
${limitRows.join("\n")}

## Media types

The declared type of a file picks the extension of its path and is never stored. A type is
matched on its essence: the text before any \`;\`, ASCII-lowercased. Any type not below, an empty
one included, gets \`.bin\`.

| type | extension |
|---|---|
${mimeRows.join("\n")}

## Stored objects

Each object as \`decodeObject\` gives it and \`encodeObject\` takes it. Every known member is
present, \`null\` when it has no value, and \`$unknown\` carries members a newer writer added, as
text. Integers are numbers; \`created_at\` is microseconds since the epoch.

${objectSections.join("\n\n")}

## Error codes

The \`code\` of a \`ValidationError\`. The message text may change between releases; the code of a
rule does not.

| code | the rule |
|---|---|
${codeRows.join("\n")}
`;

if (check) {
  if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== text) {
    console.error("docs/reference.md is stale: run node qa/docs.mjs");
    process.exit(1);
  }
  console.log("docs: reference.md matches the package");
} else {
  fs.writeFileSync(file, text);
  console.log(`docs: wrote docs/reference.md (${limitRows.length} limits, ${mimeRows.length} media types, ${OBJECTS.length} objects, ${codeRows.length} codes)`);
}
