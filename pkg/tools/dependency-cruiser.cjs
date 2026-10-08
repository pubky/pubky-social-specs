// The layering of src (ARCHITECTURE.md): a module imports only from its own layer or the ones
// below, the core never reaches migration/, and only migration/wasm.ts reaches the wasm glue.
//   cd pkg && npm run deps

const layer = {
  foundation: "^src/(data|errors|text|radix|base64url|bytes|ids|clock|mime|input)\\.ts$",
  json: "^src/json/",
  places: "^src/(path|canonicalize|uri)\\.ts$",
  models: "^src/models/",
  operations: "^src/(objects|lifecycle|deletion)\\.ts$",
  entries: "^src/(index|testing|types|validate)\\.ts$",
};
const above = (name) => {
  const order = Object.keys(layer);
  return order.slice(order.indexOf(name) + 1).map((l) => layer[l]).join("|");
};

module.exports = {
  forbidden: [
    { name: "no-cycle", severity: "error", from: {}, to: { circular: true } },
    ...["foundation", "json", "places", "models", "operations"].map((name) => ({
      name: `${name}-imports-up`,
      comment: `the ${name} layer imports only itself and the layers below it`,
      severity: "error",
      from: { path: layer[name] },
      to: { path: above(name) },
    })),
    {
      name: "core-imports-migration",
      comment: "migration/ may import the core, never the reverse",
      severity: "error",
      from: { path: "^src/", pathNot: "^src/(migration|client)/" },
      to: { path: "^src/(migration|client)/" },
    },
    {
      name: "glue-outside-wasm",
      comment: "only migration/wasm.ts loads the wasm",
      severity: "error",
      from: { pathNot: "^src/migration/wasm\\.ts$" },
      to: { path: "^src/migration/glue" },
    },
    {
      name: "client-past-the-entry",
      comment: "the client is I/O over the public entry, so the core stays I/O free",
      severity: "error",
      from: { path: "^src/client/" },
      to: { path: "^src/", pathNot: "^src/(client/|index\\.ts$|types\\.ts$)" },
    },
    {
      name: "migration-past-the-core",
      comment: "the migration reaches no entry: it would load the whole surface",
      severity: "error",
      from: { path: "^src/migration/" },
      to: { path: layer.entries },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    exclude: { path: "\\.d\\.ts$" },
  },
};
