# Testing

How this crate and its package are tested, from the unit suites to the migration campaigns, and
how to run each again. Every command runs from the repository root unless it says otherwise.

## The suites CI runs

| what | command | covers |
|---|---|---|
| Rust unit and integration tests | `cargo nextest run --features replay,surface` (or `cargo test` with the same features; `replay` adds the migrator and the two replay binaries, `surface` the oracle the npm package is checked against) | the models, the readers, the canonicalizers, the 0.x to 1.x transforms, the replay tooling, and that the recorded answers under `vectors/js` are the ones the crate gives now |
| the wasm build | `cargo clippy --target wasm32-unknown-unknown --features migrator -- -D warnings` | the migrator, the one part of the package that is this crate compiled to wasm, builds clean for its target; its behaviour is tested through the package |
| the npm package | `cd pkg && npm ci --ignore-scripts && npm run build && npm test` | the recorded vectors offline, the entry as a caller meets it (shapes, errors, the clock, unknown members), the edges the mutation pass found, properties, validators, the client over a fake session, the transforms over the semantic vectors, the migration engine over `MemoryPort`, the SDK adapter over a fake storage, the CLI, the data check, 25 runs of the model fuzz |
| from the sources | `cd pkg && npm run test:src` (Node 22.18 or later) | the same suites with no build step: `qa/from-src.mjs` resolves `dist/*.js` to `src/*.ts` and Node strips the types |
| coverage per module | `cd pkg && npm run coverage` | lines and branches of every module of `src` from the run on the sources, each against its floor in `qa/coverage.mjs`; 98.8% of lines and 95.6% of branches in all |
| lint, layering, format | `cd pkg && npm run tools && npm run lint && npm run deps && npm run format:check` | typescript-eslint strict-type-checked, the layers of `ARCHITECTURE.md` and no cycle (dependency-cruiser), prettier |
| the tarball | `npm pack`, then `npx publint --strict <tgz>`, `npx attw <tgz> --profile esm-only`, the file list against `pkg/api/files.txt` | what npm would serve, as a consumer resolves it |
| runtimes | `node qa/smoke.mjs`, `deno run --allow-read --allow-env qa/smoke.mjs`, `bun qa/smoke.mjs`, `node qa/browser.mjs` (Chromium through Playwright) | the core, the testing subpath and a migration of one object over `MemoryPort`, in each |
| Stryker | `cd pkg && npm run mutation` (nightly) | mutants of `ids`, `clock`, `canonicalize`, `deletion`, `lifecycle` and the engine's claims, each run against the suites; the floor is 96% |
| the package against the crate | `cargo build --release --features surface --bin surface_oracle`, then `cd pkg && npm run score -- --fuzz 50000` | every operation of the entry, on the recorded vectors and on fresh seeded cases: the same bytes, ids, paths and messages as the crate (see below) |
| types, size, hostile arguments | `cd pkg && npm run types && npm run size && node --expose-gc qa/boundary.mjs` | the declarations as a consumer compiles them, what an import costs a bundle, and that no argument makes a call hang, leak or throw anything but a `ValidationError` or a `TypeError` |
| live e2e | `cd pkg && npm run e2e` with a testnet homeserver up (see `.github/workflows/js-binding.yml`, job `e2e`) | `pubky-social-migrate` against `synonymsoft/homeserver-testnet` |
| lint and format | `cargo fmt --check`, `cargo clippy --all-targets --all-features -- -D warnings` | |
| properties | `cd pkg && npx mocha property.test.js` (in `npm test`; `FC_SEED` and `FC_RUNS` change the seed and the count) | what holds for every input the generators make: built objects decode to themselves and encode back to their bytes, `parseUri` and `buildUri` are inverses both ways, minting is strictly increasing under any clock inside the tolerance, a plan names each path once, publish then unpublish brings a version back |
| the model fuzz | `cd pkg && npm run model -- --runs 1000` (25 runs in `npm test`, 10000 nightly) | a seeded sequence of builds, edits, publishes, unpublishes, deletes, migrations with port faults, rescans, revision bumps, clock steps and a second copy of the package over one tree, checked after every step: deleted stays deleted, nothing private under `/pub/`, every object decodes, no path overwritten. A failure prints the shrunk sequence, its seed and its path; `--seed N --path P` replays it |

The semantic vectors (`vectors/semantic/v0_to_v1.json`) are shared by the Rust test
`tests/migrate_vectors.rs` and the package test `pkg/transforms.test.js`: a behaviour of the
transforms ships with a vector row, and both sides read the same file. The 0.x inputs in it are
what the frozen 0.x reader stores, pinned by the test in `tests/migrate_vectors.rs`.

## The package against the crate

The npm package implements the 1.x surface natively in TypeScript, so nothing but a check keeps
it equal to the crate. The check has one reference and three uses of it.

The reference is the surface oracle: `src/surface.rs` behind the `surface` feature, and the
binary `surface_oracle` over it. It answers each operation of the package (`decode`,
`createPost`, `planPublish`, ...) as the crate answers it, one JSON request per line in, one
answer out. A request carries its own clock and its own mint guard, so an answer depends on the
request alone and a recorded request replays to the same answer.

- **Recorded vectors** (`vectors/js/<family>.jsonl`): 400 requests per family with the oracle's
  answers, read by both sides. `tests/surface_vectors.rs` fails when the crate no longer gives
  them, and the scoreboard fails when the package does not. Regenerate with
  `cd pkg && node qa/score.mjs --record` after a deliberate change of behaviour.
- **Differential fuzz** (`pkg/qa/score.mjs`): seeded generators (`pkg/qa/gen.mjs`) make fresh
  requests per family, the oracle answers them, and the package has to answer the same: stored
  bytes compared as bytes, a refusal by its message. `--family post --fuzz 1000000 --seed 3`
  runs one family long; `--stats` prints how often each operation was accepted, since a family
  that only ever refuses proves little. A mismatch is written to `pkg/qa/failures/<family>.json`
  with the request, both answers, and nothing else needed to replay it.
- **The round trip**: inside the `decode` operation the scoreboard also reads the bytes through
  the public `decodeObject`, writes the object back through `encodeObject`, and requires the
  bytes the reader produced. That is what holds a JS edit to the bytes a Rust edit writes,
  unknown members and number spellings included.

What the oracle cannot check is what only JS has: argument shapes, values no JSON holds, the
`$unknown` text, the error classes. Those are `pkg/test.js` and `pkg/qa/boundary.mjs`.

The tables the package carries (the limits, the MIME map, the set of characters Rust escapes
when an error quotes text) are generated from the oracle into `pkg/src/data.ts` by
`node qa/data.mjs`; `--check` fails when the file is stale, as it is after a toolchain bump moves
the Unicode tables.

`pkg/api/*.d.ts` are the declarations of every entry as last agreed. `npm run api` diffs them
against the build, so a signature never changes by accident; copy the built file over its
counterpart when the change is meant. What to do with a mismatch against a vector is in
`pkg/CONTRIBUTING.md`.

## Stryker's surviving mutants

The last run scored 97.46%: 828 mutants killed, 16 timed out, 22 alive. The ones alive are ones
no input can tell apart from the code, each checked by hand: `colon <= 0` against `< 0` in `canonicalExternal` (the scheme check refuses an empty
scheme anyway); the `?? ""` and the final unknown-kind refusal in `deletion.ts` (unreachable past
the guard before them); the optional chains in `lifecycle.ts`'s media check (every caller
matched the owner's media prefix first), the `ValidationError` filter
around `checkSafeNumbers` (it throws nothing else), the public-root flags of the publish's final
checks (every private reference was refused before them) and the root tie-break of the delete
order (V8's stable sort gives the same order); in the engine, `keyOf` on a path with no key and
`claimKey` for a non-media write (no write reaches them), the claims released again in the
`finally` that releases them anyway, the read-back's `not_found` branch (the cleanup treats a
`not_found` DELETE the same way), the `null` and parse-failure answers of the read-back (both
already mean "not ours") and the identity check before a claim is dropped (a claim is settled
once). The JSON report of the last run lists them with their positions.

The model fuzz counts one resurrection apart instead of failing on it: a deleted key coming back
from a 0.x copy that is still stored and that no finished run had recorded. `deletionPaths` does
not reach the 0.x copy of a mute, a bookmark or a feed (the crate defines it so), a client may
skip the 0.x listing of a post or a tag, and only a finished run writes the record of what it
copied, so nothing in the package can tell such a copy from one never migrated. `--strict` fails
on those too.

## The replay: a copy of production on a testnet

`tools/replay/` migrates a crawled copy of production (JSON of every user, a sample of the blobs
under a disk budget) on a local testnet homeserver under fresh keys, then verifies every user's
1.x tree against an independent Rust oracle (`src/bin/replay_verify.rs`, behind the `replay`
feature). `tools/replay/README.md` is the manual: privacy rules, the disk budget, the crawl, the
remap, seed, run, verify, the browser path through Playwright, the browser replay workflow
(`.github/workflows/replay.yml`, on demand from `v1`, nightly once the file is on the default
branch), and the results of each campaign.

## The QA campaign of 2026-10-01

Two lanes, one morning, on a production replica of 849 users and 114k objects. The numbers and
the findings live with the campaign; this is how to run each piece again.

### Lane A: operational cases on the replica (`tools/replay/qa/`)

Each script is one case over the running testnet; `lib.mjs` holds what they share (the CLI as
`run.mjs` runs it, with the knobs a case needs). Run them from `tools/replay` after `seed.mjs`
and a first `run.mjs`.

| script | case |
|---|---|
| `runstats.mjs` | per-user time distribution of a Node pass, the slowest users, throughput |
| `events.mjs` | walks the homeserver's public event feed and checks, per user, that `profile.json` is the last public 1.x write, that no `/priv/` line appears, and that the passes never invert |
| `browser-drive.mjs`, `cdp-run.mjs` | one user through the harness page in Chromium: network throttling (`--throttle slow3g`), reload and tab close mid-run; `cdp-run.mjs` drives raw CDP because Playwright dies on a 100 MB request body |
| `reset.mjs`, `twodevices.mjs` | delete a user's 1.x tree, then two migrations at once (two CLIs, or a CLI and Chromium) |
| `kill9.mjs`, `restart.mjs` | SIGKILL the CLI at random points, or restart the homeserver under it, then a run to the end and an audit of the tree |
| `badnet.mjs` | the CLI through toxiproxy (latency, resets, bandwidth, stalls, cut connections) |
| `clock.mjs`, `clock-shim.cjs`, `clockuser.mjs` | the CLI on a clock off by `--offset-ms`, over a user whose TimestampIds sit around the moment it is written |
| `synth.mjs`, `scale.mjs` | synthetic users at exactly 1000, 1001 and 2000 objects, 1500 blobs, and 50k posts, through the CLI with its peak resident set |
| `scoped.mjs` | one user through a session holding only `ENGINE_CAPS`, minted through the grant flow |
| `oldhs.mjs` | a homeserver older than `/priv/`: the run must end `PRIV_UNSUPPORTED` |
| `liveedit.mjs` | a 1.x edit and a new 1.x tag after the migration, then a `--rescan` that must keep both |

The harness page (`tools/replay/browser/harness.js`) times every port call and the engine's
own time between them, and `browser.mjs` writes both into each user's report.

### Lane B: fault injection, fuzz, boundary, bench (no Docker)

| harness | command | what it checks |
|---|---|---|
| chaos port | `cd pkg && node --max-old-space-size=1536 qa/chaos.mjs [--variant main\|quota-rate\|lost-response\|any-kind\|phantom-404] [--seeds 1000]` | `runMigration` over a `MemoryPort` that fails, races and stalls by a seeded schedule, run again until it finishes, then compared with a fault-free run: create-only writes, the 0.x tree untouched, the flag only after `done`, no hang, counts that add up |
| transform fuzz | `QA_FUZZ_CASES=10000 cargo test --release --features migrator --test qa_transform_fuzz -- --nocapture` (needs `CARGO_PROFILE_RELEASE_PANIC=unwind` for a release test build) | reader-shaped 0.x objects with hostile content: no panic, deterministic, every write reads back through the 1.x reader, every skip carries a published category and `invalid` a note |
| hostile arguments | `cd pkg && node --expose-gc --max-old-space-size=1536 qa/boundary.mjs` | every export of the entry with one argument slot, or one member of an object argument, replaced by a hostile value (proxies, cycles, lying typed arrays, megabyte strings, sparse arrays): a result, a `ValidationError` or a `TypeError`, promptly, with the heap back where it was |
| benchmarks | `cd pkg && node qa/bench.mjs --dump inputs.json`, then `QA_BENCH_INPUT=inputs.json cargo test --release --features migrator --test qa_transform_bench -- --nocapture` | throughput per kind through the wasm and natively, the blob door and hasher, a whole run with the time split between wasm, port and engine |
| mutation pass | `cd pkg && node qa/mutate.mjs [--seeds 150] [--only M3]` | plants one bug at a time in a copy of the package under `qa/out/mutant` (the sources are never written), runs the copy's tests and a slice of the chaos harness, reports what nothing caught |

A chaos seed that breaks an invariant is minimized by the harness (`--seed N --verbose` replays
one); a fuzz failure prints its seed and case so `QA_FUZZ_SEED` reproduces it.

Replaying a seed: `qa/chaos.mjs --seed N` runs at the fault rate the sweep drew for seed N, and
`--rate` overrides it. Until 2026-10-08 a single seed ran at a fixed 0.05, so a seed noted from an
older sweep may not fail the same way. Per-run lines print only with `--verbose`. The model fuzz
(`qa/model.mjs`) shares the chaos harness's warmed xorshift since the same day, so a `--seed` or
`--path` recorded before it draws other faults and replays a different run.

A chaos finding that looked like a scheduling artefact was a real gap. When the engine read the
0.x source through one more `await`, `main` seed 0 reported a post as `put_rejected` while its
1.x copy existed. Two faults on one object cause it, in any schedule: the first PUT lands
and its answer is lost, the retry is refused. The engine took the refusal as final, though the
copy from the first try was there, and the flag records `put_rejected` for good. The extra await
only moved which call drew those two faults; `migration.test.js` reproduces the order on the
unchanged scheduling. The engine now reads a refused PUT's URL back before recording the
refusal, and counts the object `written` when this run's bytes are there. A shipped SDK adapter
rarely meets the order, since its `ifAbsent` HEAD finds the copy and answers `exists`; a port
that refuses before checking existence does meet it.

### What the campaign established

849 of 849 replica users verified against the oracle with no reverse finding; a second run is a
no-op; the event feed shows `profile.json` last for every migrated user and no private line;
two devices, crashes, tab reloads, a homeserver restart, bad networks, clock skew, the LIST page
boundaries and a 50k-post user all converge and verify. 1000 chaos seeds on each of five fault
profiles converge with every invariant kept, apart from two edges the engine README states as
accepted. 360k fuzzed transforms raised no panic. Of 8888 hostile boundary calls none trapped.

The fixes it produced are in the engine (a LIST cursor that does not advance ends the walk), the
entry (typed arrays refused in object slots, JSON and string arguments capped before the wasm
copy, detached views refused), the adapter (a deadline on every call), the CLI (SIGTERM signs
out, sign-in hints) and the migrator (every refusal carries its note, an uppercase scheme folds
before dispatch). Two findings belong to other layers and are filed on `pubky/pubky-homeserver`:
the per-PUT collision check scans every entry of a user, and the SDK copies blob bodies through
its wasm.

## The native package campaign of 2026-10-07

The npm package moved from the crate compiled to wasm to a native TypeScript implementation,
with the wasm kept for the migrator alone. This is what holds the two equal, and how to run each
piece again.

| what | command | result |
|---|---|---|
| differential fuzz, one million cases a family | `cd pkg && for f in text ids canonical uri json user graph feed file post plan loose; do node --max-old-space-size=2048 qa/score.mjs --family $f --fuzz 1000000 --seed 20261007; done` | 12 families, 12 million cases, 0 mismatches; after the fixes below, post, plan, loose and feed again at seed 77, 0 mismatches |
| hostile arguments | `cd pkg && node --expose-gc qa/boundary.mjs` | 13,248 calls: a result, a `ValidationError` or a `TypeError` every time, the slowest 1.6 s, the heap 1 MB above where it started |
| chaos port, 1000 seeds a profile | `cd pkg && node qa/chaos.mjs --variant <profile> --seeds 1000` | `main`, `quota-rate`, `lost-response`, `phantom-404`: no violation. `any-kind`, a port that lies in any way: 147, the same seeds and the same invariants as the build before the move (compared on seeds 0 to 149) |
| mutation pass | `cd pkg && node qa/mutate.mjs` | 12 of 14 planted engine bugs caught. M12 and M14 pass as they did before the move: M12 is close to an equivalent mutant (the next object folding to the key PUTs, gets `exists` and counts as present), and with M14 the wasm still refuses an oversize blob, only after hashing it |
| the replay | `cd tools/replay && node replay.mjs --data <dir> --to verify` | 849 of 849 users done; the oracle finds no mismatched user and no object migrated though refused; counts equal to the wasm run (107,138 written, 157 invalid, 11 shape, 7 malformed, 1,669 not migrated) |
| the replay against the wasm run | every object of every tree compared with the dump kept from 2026-10-01, by size and hash | 222,201 objects, none differs; the 849 flags differ in `migrated_at` and in `transform_rev`, 1 then and 2 now |
| the replay in a browser | `node replay.mjs --data <dir> --from browser --to browser --sample 2` | four sample users migrated in Chromium by the page harness, the 9,111-object one among them, and two in Firefox, each verified by the oracle with no mismatch |
| the 100 MB blob in a browser | `node --experimental-websocket qa/cdp-run.mjs --only <pk> ...` (raw CDP: Playwright's pipe cannot carry a 100 MB request body) | done in 8.6 s and verified; the renderer peaked at 834 MB, with 5.6 MB in the package's wasm. On the wasm package the same user ended at 1.5 GB with 302 MB there |
| live e2e | `cd pkg && npm run e2e` against the testnet | 5 of 5 |
| size and start | `cd pkg && npm run size` | the whole entry 25.7 kB gzipped, `buildUri` alone 1.6 kB; first call 3.6 ms after a 115 ms load of unbundled files, no init |
| throughput | `cd pkg && node qa/bench-entry.mjs`, `node qa/bench.mjs` | a note built in 62 us, decoded in 70 us; the engine 3,067 objects a second over `MemoryPort`, as before; a blob hashed at about 280 MB a second in the wasm and about 17 in JS |

What the campaign found, all fixed:

- **In the crate too.** A post edited in the instant it was created got a salted successor id up
  to a minute ahead, which moved the mint guard ahead of the clock; the next new post then read
  the clock as corrected and took the first post's id, so its PUT would have overwritten the
  first post's first version. A salted successor now leaves the guard alone
  (`tests/surface_mint.rs`).
- A trim written as one regular expression was quadratic on a long inner run of whitespace.
- A hostile `$unknown` text leaked the reader's internal error; a sparse array of 2^32 entries
  was walked; an array where a kind goes reached string formatting; a typed array whose
  `length` lies reached the hash.
- A name outside a closed set, in an object a caller wrote, was stored as `"unknown"`. It is
  refused now; only a name a read gave is written back.
- An options bag with a misspelled member was accepted and the member ignored.

Two things are as the crate has them and are stated, not fixed: a stored name a version does not
know is written back as `"unknown"` by that version, in either language; and a public key that is
no key is refused without naming the argument.

## Running anything here on a small machine

One `cargo` at a time across checkouts, each checkout with its own `CARGO_TARGET_DIR`. Node with
`--max-old-space-size=1536` for the harnesses. One browser at a time. The replica fits in 5 GB of
disk with the blob sample the crawl takes by default.
