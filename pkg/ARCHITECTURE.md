# Architecture

`pubky-social-specs` is the Pubky social data model as plain synchronous functions. The Rust
crate in the repository root is the reference: this package is a native TypeScript port of its
1.x surface, kept equal to it by a check, plus the crate's 0.x to 1.x migration compiled to wasm.

## Layers

A module imports only from its own layer or the ones below. `npm run deps` (dependency-cruiser,
configured in `tools/dependency-cruiser.cjs`) fails the build on an import that goes up, on a cycle,
and on a core module that reaches `migration/`.

```
 entries     index  testing  types            client/        migration/index  adapters/pubky-sdk
               |                                 | (index only)       |              |
 operations  objects  lifecycle  deletion        |            engine  memory  port  order
               |                                 |              |
 models      models/{user,post,graph,feed,file,kinds,label,common}            wasm.ts --> glue.js
               |                                                 (the only door to the wasm)
 places      path  canonicalize  uri
               |
 json        json/read  json/write  json/schema
               |
 foundation  data  errors  text  radix  base64url  bytes  ids  clock  mime  input
```

- **foundation**: the reference's text rules (lengths in code points or UTF-8 bytes, a whitespace
  set frozen at Unicode 15.1), the id spellings, the clock and its mint guard, the byte reads
  through the intrinsic getters, and `input.ts`, the one place a caller's value is read.
- **json**: a reader that refuses what serde_json refuses, with its message, at the same point of
  the text; the writer; and the codecs that read a model from text and from a caller.
- **places**: what a path names (`path.ts`), the URI canonicalizers, and the URI parser and
  builders. No `URL` anywhere (see `docs/decisions/0002-no-url-parser.md`).
- **models**: each stored object's codec, size cap and rules, in the reference's order.
- **operations**: reading and writing an object at a URI, the lifecycle plans, deletion paths.
- **entries**: the public surface. `index.ts` copies every argument through `input.ts`, checks
  its JavaScript shape, and hands plain data down. `client/` is I/O over an SDK session and uses
  the public entry only, so the core stays I/O free and tree-shakes the same.

`migration/` may import any core module; nothing in the core imports `migration/`, and only
`migration/wasm.ts` imports the wasm glue.

## Three spellings of a place

An owner (`Owner`, a bare z-base32 key), a URL (`PubkyUrl<K>`, `pubky://<owner>/...`, one
stored object; for a post one version), and a path (`OwnerPath`, `/pub/...` or `/priv/...`).
A reference to a post (`PostRef`) is a fourth: versionless, so it names the post. Each is a
branded type that costs nothing at run time; `parseOwner` and its siblings brand a string once
where it enters.

## The parity boundary

Everything the crate decides is decided the same way here: ids, paths, canonical bytes, and
the refusal messages, word for word. The package adds only what JavaScript needs: argument
shapes (`TypeError`), the `$unknown` text, branded types, the async helpers, the migration
engine's I/O. The check:

- `vectors/js/<family>.jsonl`: 400 recorded crate answers per family, replayed by
  `vectors.test.js` in `npm test` and by `tests/surface_vectors.rs` on the crate side.
- `qa/score.mjs --fuzz N`: fresh seeded requests answered by the crate's `surface_oracle` and by
  the package, compared byte for byte.

A behaviour of the reference (a message, an id rule, a path) changes in the crate first, then
here, then the vectors are re-recorded. `CONTRIBUTING.md` has the procedure.

## Generated files

| file | made by | from |
|---|---|---|
| `src/data.ts` | `node qa/data.mjs` (`--check` in `npm test`) | the crate's constants, through the oracle: limits, MIME map, skip reasons, transform revision, the characters Rust escapes |
| `dist/migration/glue.js` | `npm run build` (`src/bin/bundle_specs_npm.rs`, then `src/bin/patch.mjs`) | wasm-bindgen's output for the `migrator` feature, the wasm embedded as base64 with its SHA-256 checked before it is compiled |
| `api/*.d.ts` | copied from `dist` when an API change is meant | the declarations as last agreed; `npm run api` diffs them |
| `vectors/js/*.jsonl` | `node qa/score.mjs --record` | the oracle's answers at a fixed seed |

`src/migration/glue.d.ts` is hand-written: the declarations of the glue's few exports.

## I/O

The core performs none. The migration engine reaches storage only through a `MigrationPort`
(`MemoryPort` for tests, `sdkPort(session)` over the pubky SDK). The client subpath takes the
same SDK session. Both validate every URL they are given against the session owner's tree.
