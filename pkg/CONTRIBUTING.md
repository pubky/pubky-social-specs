# Contributing

Read `ARCHITECTURE.md` first: the layers, the parity boundary and the generated files.

## Building

Everything but the migration builds with Node alone:

```sh
cd pkg
npm ci --ignore-scripts
npx tsc -p .          # src -> dist, the whole core and the engine's TypeScript
npm test
```

The migrator's wasm and its three loaders, `dist/migration/glue.js`, `glue.node.js`,
`glue.workerd.js`, `glue.wasm` and `glue.d.ts`, are the files tsc does not write. Without
cargo, take them from a published build of the same version, or from the `dist` artifact of the
`js-native` workflow:

```sh
npm pack pubky-social-specs@<version> && tar -xzf pubky-social-specs-<version>.tgz 'package/dist/migration/glue*'
cp package/dist/migration/glue* dist/migration/
```

With the Rust toolchain, `npm run build` builds everything; it wipes `dist` first. Never run
`wasm-pack build --out-dir pkg` by hand: it overwrites `package.json`. A release `dist` is built
only in CI, from the pinned toolchain, and a job rebuilds it from the tag and compares.

## The checks

`npm test` runs the suites, the data check, the examples and a short model fuzz. Every other
check, what it covers and how to run it on a small machine is in the root `TESTING.md`; before
a pull request, also run `npm run types`, `npm run api`, `npm run lint`, `npm run deps`,
`npm run format:check` and `npm run coverage`.

The docs are checked like code. `npm run docs:snippets` type-checks every `js` block of the
README, `MIGRATION.md` and `docs/`, and runs each against the in-memory homeserver of `pubky-social-specs/testing`; `npm run docs:check`
fails when `docs/reference.md` differs from what `qa/docs.mjs` generates from the package; and
`npm run docs:hover` fails on any export or member whose editor hover is empty, or a number
whose doc names no unit. A changed limit, member or error code is a regenerated reference:
`node qa/docs.mjs`.

The lint toolchain lives in `tools/` with its own lockfile: typescript-eslint, dependency-cruiser
and TypeDoc need the TypeScript compiler API, which TypeScript 7, the compiler of the build, does
not ship, so they run on TypeScript 6.0. Install it once with `npm run tools`; it needs Node 22 or
later.

## The reference and the vectors

The crate decides ids, paths, canonical bytes and refusal messages. The package answers as the
crate does, word for word, and `vectors.test.js` holds it to that.

- **Never reword a message the crate produces**, even a clumsy one: a refusal is compared byte
  for byte with the crate's. A message only JavaScript produces (a `TypeError`, a check of a
  JavaScript shape) is the package's own.
- **A finding goes into the package, never into a vector.** A vector is the crate's answer; a
  mismatch means the package is wrong, or the crate has to change first.
- **Re-recording is legitimate only after a deliberate change of the crate's behaviour**, in the
  same series as that change:

  ```sh
  cargo build --release --features surface --bin surface_oracle
  cd pkg && node qa/score.mjs --record     # rewrites vectors/js/*.jsonl
  cargo test --features surface --test surface_vectors
  node qa/data.mjs                         # when a constant moved
  ```

  Review the vector diff: every changed row should be explained by the crate change.
- A change of the stored format (paths, bytes, the migration flag) is a crate change and a
  migration question first. Write it up before touching code.

### Keeping a fork in step

A fork of the package needs no Rust to know it still answers as the reference: `npm run
conformance` replays every recorded vector (`vectors/js/*.jsonl`, inputs with the crate's
answers, refusals and their text included) against the built package. `dist/reference.json`
names what a build was checked against: the crate's version and commit, the toolchain, the
`serde_json` version whose float spelling and messages the package follows, and the digest of
the vectors. A fork that changes behaviour on purpose changes the crate first, re-records, and
its digest moves with it. The fuzz corpus in `qa/fuzz/corpus` is a second set of inputs to ask
both, with `qa/fuzz/replay.mjs` and the oracle.

## Style

Prettier formats (`.prettierrc.json`); comments say why, never what, and cite no issue numbers.
No em dashes or en dashes in text. Commit subjects are conventional (`fix:`, `feat:`,
`test(qa):`, `docs:`), with a body only when the change is not obvious from the subject.
