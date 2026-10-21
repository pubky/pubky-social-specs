# Architecture

`pubky-social-specs` is the Pubky social data model as plain synchronous functions. The Rust
crate in the repository root is the reference: this package is a native TypeScript port of its
1.x surface, kept equal to it by a check, plus the crate's 0.x to 1.x migration compiled to wasm.

## Layers

A module imports only from its own layer or the ones below. `npm run deps` (dependency-cruiser,
configured in `tools/dependency-cruiser.cjs`) fails the build on an import that goes up, on a cycle,
and on a core module that reaches `migration/`.

```
 entries     index  testing  types  validate  client/        migration/index  adapters/pubky-sdk
               |                                 | (index only)       |              |
 operations  objects  lifecycle  deletion        |            engine  memory  port  order
               |                                 |              |
 models      models/{user,post,events,maps,time,geo,graph,feed,file,kinds,label,common}   wasm.ts --> glue.js
               |                                                 (the only door to the wasm)
 places      path  canonicalize  uri
               |
 json        json/read  json/write  json/schema
               |
 foundation  data  errors  text  radix  base64url  bytes  ids  clock  mime  input  session  dev  caps
```

- **foundation**: the reference's text rules (lengths in code points or UTF-8 bytes, a whitespace
  set frozen at Unicode 15.1), the id spellings, the clock and its mint guard, the byte reads
  through the intrinsic getters, `input.ts`, the one place a caller's value is read, the part
  of an SDK session the client and the adapter call (`session.ts`), the development warning
  (`dev.ts`), and the capability strings an app asks a session for (`caps.ts`).
- **json**: a reader that refuses what serde_json refuses, with its message, at the same point of
  the text; the writer; and the codecs that read a model from text and from a caller.
- **places**: what a path names (`path.ts`), the URI canonicalizers, and the URI parser and
  builders. No `URL` anywhere (see `docs/decisions/0002-no-url-parser.md`).
- **models**: each stored object's codec, size cap and rules, in the reference's order. `post.ts`
  dispatches on the kind; the 1.1 envelopes live in `events.ts` (event, rsvp, availability,
  rating) and `maps.ts` (route), over `time.ts` (the JSCalendar value rules) and `geo.ts` (the
  two Maps conventions).
- **operations**: reading and writing an object at a URI, the lifecycle plans, deletion paths.
- **entries**: the public surface. `index.ts` copies every argument through `input.ts`, checks
  its JavaScript shape, and hands plain data down; `validate.ts` runs the builders' rules and
  collects every issue. `client/` is I/O over an SDK session and uses the public entry only (and
  the types of `session.ts`), so the core stays I/O free and tree-shakes the same.

Two entries read a caller's value past `input.ts`, because a copy cannot carry it: `hashMedia`
calls the `stream()` or `arrayBuffer()` of a `Blob`, and `dateToMicros` calls `getTime()` of a
`Date`. Each checks what the call gave back before using it.

The entry also holds what the JavaScript API adds over the reference and so has no rule below
it to call: `editPost` takes the head as a URL and defaults `root` to the head's, `parseUri`
adds a file's `filename` and a bookmark's `target`, and the `parseX` functions name the
argument in a refusal. The crate keeps the same shaping in `src/surface.rs`, the entry's twin.

`migration/` may import any core module; nothing in the core imports `migration/`, and only
`migration/wasm.ts` imports the wasm glue.

### Who decides a 0.x path

Three places read a 0.x path, each for its own question. The wasm (the crate's frozen reader
and transforms) decides what an object becomes: its writes, its skip reason. `legacy.ts`, in
the core, gives the engine the key two copies of one object share (`stableKey`,
`legacyMediaKey`), which the `uri` family of the differential fuzz holds equal to the crate.
`migration/order.ts` only sorts a listing into passes by the first segment under
`/pub/pubky.app/`; a path it sorts wrong is migrated in a later pass, never differently. The
engine spells every write URL itself and stops the run when the wasm's differs.

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
engine's I/O. It words a refusal of its own only where the crate has no answer: a value only
JavaScript can hold (a lone surrogate, an integer past 2^53, an id time `idMicros` cannot
return exactly) and the checks of functions with no crate twin, such as `editPost`'s head or
`toPath`. Those are still `ValidationError`s, since the class follows the type of the value: a
value of the wrong type is an `ArgumentError`, a string or number of the right one that is
refused is a `ValidationError`, whoever words it. The recorded vectors and the differential fuzz hold the two equal; the root
`TESTING.md` describes both. A behaviour of the reference (a message, an id rule, a path)
changes in the crate first, then here, then the vectors are re-recorded, as `CONTRIBUTING.md`
says.

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
(`MemoryPort` for tests, `sdkPort(session)` over the pubky SDK), and the engine and the adapter
refuse any URL outside the session owner's 1.x roots or tree. The client subpath takes the same
SDK session: it writes only what a builder placed in the owner's tree, and reads another user's
tree through the SDK's `publicStorage`.
