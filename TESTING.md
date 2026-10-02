# Testing

How this crate and its package are tested, from the unit suites to the migration campaigns, and
how to run each again. Every command runs from the repository root unless it says otherwise.

## The suites CI runs

| what | command | covers |
|---|---|---|
| Rust unit and integration tests | `cargo nextest run --features replay` (or `cargo test --features replay`; `replay` adds the migrator and the two replay binaries, whose tests only build with it) | the models, the readers, the canonicalizers, the 0.x to 1.x transforms, the semantic vectors in `vectors/`, and the replay's remap and verifier |
| wasm tests | `wasm-pack test --headless --firefox -- --features migrator` | the JS boundary as the browser build sees it |
| the npm package | `cd pkg && npm install && npm run build && npm test` | the typed surface (`tsc`), the entry's argument checks, the migration engine over `MemoryPort`, the SDK adapter over a fake storage, the CLI |
| live e2e | `cd pkg && npm run e2e` with a testnet homeserver up (see `.github/workflows/js-binding.yml`, job `e2e`) | `pubky-social-migrate` against `synonymsoft/homeserver-testnet` |
| lint and format | `cargo fmt --check`, `cargo clippy --all-targets --all-features -- -D warnings` | |

The semantic vectors (`vectors/semantic/v0_to_v1.json`) are shared by the Rust test
`tests/migrate_vectors.rs` and the package test `pkg/test.js`: a behaviour of the transforms
ships with a vector row, and both sides read the same file. The 0.x inputs in it are what the
frozen 0.x reader stores, pinned by the test in `tests/migrate_vectors.rs`.

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
| wasm boundary | `cd pkg && node --max-old-space-size=1536 qa/boundary.mjs` | every export with one argument slot replaced by a hostile value: a result or a `Validation Error`, never a trap or a hang, the instance still answering afterwards, linear memory growth per call |
| benchmarks | `cd pkg && node qa/bench.mjs --dump inputs.json`, then `QA_BENCH_INPUT=inputs.json cargo test --release --features migrator --test qa_transform_bench -- --nocapture` | throughput per kind through the wasm and natively, the blob door and hasher, a whole run with the time split between wasm, port and engine |
| mutation pass | `cd pkg && node qa/mutate.mjs [--seeds 150] [--only M3]` | plants one bug at a time in the engine, runs the package tests and a slice of the chaos harness, reports what nothing caught |

A chaos seed that breaks an invariant is minimized by the harness (`--seed N --verbose` replays
one); a fuzz failure prints its seed and case so `QA_FUZZ_SEED` reproduces it.

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

## Running anything here on a small machine

One `cargo` at a time across checkouts, each checkout with its own `CARGO_TARGET_DIR`. Node with
`--max-old-space-size=1536` for the harnesses. One browser at a time. The replica fits in 5 GB of
disk with the blob sample the crawl takes by default.
