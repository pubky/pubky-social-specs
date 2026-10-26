# Architecture

`pubky-social-migrator` copies one owner's 0.x tree (`/pub/pubky.app/`) into the 1.x layout of
`pubky-social-specs`. The transforms are the Rust crate in the repository root compiled to wasm,
since they read 0.x objects through its frozen reader, whose URL and MIME parsing no JS engine
reproduces. Everything around them is TypeScript.

## Modules

```
 index  adapters/pubky-sdk  bin/migrate.js
   |           |
 engine  memory  port  order  path  bytes  data
   |
 wasm.ts --> glue.js   (the only door to the wasm)
```

- `engine.ts` walks the tree in passes, calls a transform per object, writes its results through
  the port, records the flag. `memory.ts` is an in-memory port for tests; `port.ts` the contract.
- `wasm.ts` checks every argument before it reaches the glue: a value of another type in a string
  slot would read memory it does not own, and whatever is copied into linear memory stays
  allocated for the rest of the run.
- `adapters/pubky-sdk.ts` is the port over a session of `@synonymdev/pubky`; `bin/migrate.js` is
  the CLI over it.
- `data.ts` is generated: the skip reasons and the transform revision, from the crate.

## The core

The migrator imports `pubky-social-specs` through its public entry and nothing else, at exactly
the version it is released with: `buildUri` and `parseUri` spell every write URL, `toPath` is the
check behind the write fence and the adapter (`path.ts`), and the limits, `listPrefix`,
`ValidationError` and the session grants come from there too. `bytes.ts` is the one helper it
keeps for itself: the byte views the glue needs, read through the intrinsic getters.

## Who decides a 0.x path

Two places read a 0.x path, each for its own question. The wasm (the crate's frozen reader and
transforms) decides what an object becomes, its writes or its skip reason, and the key two copies
of one object share (`stableKey`, `legacyMediaKey`), which the engine claims writes by.
`order.ts` only sorts a listing into passes by the first segment under `/pub/pubky.app/`; a path
it sorts wrong is migrated in a later pass, never differently. The engine spells every write URL
itself and stops the run when the wasm's differs.

## Generated files

| file | made by | from |
|---|---|---|
| `src/data.ts` | `node pkg/qa/data.mjs` (`--check` in the core's `npm test`) | the crate's skip reasons and transform revision, through the oracle |
| `dist/glue.js` | `npm run build` (`src/bin/bundle_specs_npm.rs`, then `src/bin/patch.mjs`) | wasm-bindgen's output for the `migrator` feature, the wasm embedded as base64 with its SHA-256 checked before it is compiled |
| `api/*.d.ts` | copied from `dist` when an API change is meant | the declarations as last agreed; `npm run api` diffs them |

`src/glue.d.ts` is hand-written: the declarations of the glue's few exports.

## I/O

The engine reaches storage only through a `MigrationPort` (`MemoryPort` for tests,
`sdkPort(session)` over the pubky SDK), and the engine and the adapter refuse any URL outside the
session owner's 1.x roots or tree.
