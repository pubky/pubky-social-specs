# Replay

The migration is tested on hand-built vectors and small synthetic trees. Before any real user
migrates, it has to run over what production holds. The replay copies every user's public v0
tree from production, gives each user a fresh key, seeds the copy onto a testnet homeserver and
migrates it there, so real data meets the migration without touching a real account.

This directory holds the tooling. Nothing it produces is committed: `data/` is ignored.

## Privacy

Only public data is read: `pub/pubky.app/` is readable by anyone, so the crawl uses anonymous
LIST and GET and never a session. Production is never written to.

The replica carries no production key. `replay_remap` derives each user's replica key from a
secret salt and the production key, and rewrites the references between users under that map.
That is key remapping, not anonymity: the salt stops anyone from deriving a replica key from a
production key, but the profiles, posts, tags and references are copied as written, so whoever
holds the replica can match its content against public production data and name the user. The
corpus and the replica are private material and are handled as such: they stay on the machine
that ran the replay or go to a private bucket, never to a public place or a workflow artifact.
The salt is read from the environment only (`REPLAY_SALT`, or the variable `--salt-env` names);
no tool reads or writes it anywhere else, so keep it where your other secrets live. `map.json`
(replica key to production key) and `keys.json` (the replica secrets) are written readable by
their owner only (mode 0600); `map.json` never leaves the machine. What the verifier needs
from the crawl, each replica user's blobs and whether they were fetched, the remap writes under
replica keys to `inventory.json`, so neither `map.json` nor the production-keyed
`manifest.json` is needed past the remap. The remap report counts the posts that name someone.

## Disk budget

Everything the replay keeps on one machine (corpus, replica, the testnet's database and file
store) stays under 5 GB, and `data/` under 1.5 GB. The JSON is small, about 110k objects, but
one file each: on a 4 KiB block filesystem that is roughly 450 MB for the corpus and as much for
the replica. Blobs are the bulk of production (about 8 GB), so the crawl fetches a sample of them
only, bounded by `--blob-budget-bytes`. The replica hard-links every file whose bytes the remap
keeps, blobs included, instead of copying it.

## Running it

```bash
cd tools/replay
npm install

# 1. The user list, with each user's homeserver, from nexus-scout
node users.mjs                        # data/users.json

# 2. Every JSON object of every user; blobs are listed, not fetched
node crawl.mjs --blob-budget-bytes 0

# 3. The blob sample, chosen from the File objects crawled in step 2
node crawl.mjs --blob-budget-bytes 500000000

# 4. The replica under fresh keys, from the repository root
cd ../..
export REPLAY_SALT=...                # keep it; the replica keys derive from it
cargo run --features replay --bin replay_remap -- \
  --corpus tools/replay/data/corpus --out tools/replay/data --salt-env REPLAY_SALT
```

The two Rust bins build behind the `replay` feature, which adds the key derivation to
`migrator`; the package's `migrator` alone does not pull the crypto crate. Their tests run with
`cargo nextest run --features replay -E 'binary(replay_verify) | binary(replay_remap)'`.

`crawl.mjs` takes `--users <file>`, `--out <dir>` (default `data`), `--only <pk>` (repeatable)
and `--no-resume`. A rerun resumes from the manifest: a user whose tree was copied whole is not
listed again, and an object already on disk is not fetched again. It keeps at most 4 users and 8
requests in flight, and backs off exponentially on 429, 5xx and transport errors. Every file is
written to a temporary name and renamed into place, since the replica hard-links corpus files and
a write in place would change both. It ends with `data/crawl-report.json`: coverage, object and
blob counts, and the first errors.

Coverage of the 2026-09-30 crawl: 870 users on nexus, 849 with data, 15 empty, 6 unreachable
(their pkarr record had no HTTPS endpoint, or their homeserver's tunnel was down) and 1 partial
(a tag listed but gone by the time it was fetched). The manifest marks the last two kinds
`complete: false`; the remap copies a partial user as far as it was copied and lists it under
`incomplete_users`, and an unreachable one has no directory to copy.

## What it writes

`data/corpus/<pk>/<path>`: every object under `pub/pubky.app/`, byte for byte as the homeserver
served it, at its owner-relative path.

`data/manifest.json`, per user:

- `hs`: the homeserver nexus indexed the user on
- `complete`: the tree was listed to the end and every object fetched
- `objects`: path to `size` and `sha256`, plus `json: false` for bytes that do not parse as JSON
- `files`: every File object's declared `size`, `content_type`, `src`, and the `blob` it names
  when that blob is the owner's
- `blobs`: every listed blob, with the size and type its File declares and whether its bytes
  were `fetched`. A fetched blob carries its `size`, `sha256` and a `status`: `ok`, or
  `hash_mismatch` when the bytes do not hash to the id in their path
- `errors`: what failed, by path

The blob sample is chosen from the candidates in key and hash order, so the same manifest always
gives the same sample. It holds, for every content type, the smallest, the median and the largest blob;
the largest blob overall; a spread of the heaviest user's blobs, capped at 150 MB; and one blob
each from other users until at least 20 users are covered. A blob no File names has no declared
size or type and is left out.

`data/replica/<new pk>/<path>`: the same tree under the new key. The references to other users
are rewritten (post `parent`, `embed.uri`, `attachments`, `lock`, the items and cover of a
collection's content, the cover of an article's content, a tag's or bookmark's `uri`, a File's
`src`, a profile's `image`); a
follow or mute is renamed after the new key; a tag or bookmark whose target changed takes the
id derived from the new target the way its old id was, so the 0.x reader accepts it exactly when
it accepted the original. Every other byte is kept, key order and
escapes included. A reference to a user outside the corpus is left as it is.

`data/map.json` (production key to replica key), `data/keys.json` (replica key to its secret,
hex) and `data/remap_report.json`:

- `by_resource`: objects per v0 resource kind, `unknown` for paths the 0.x reader does not know
- `references_rewritten`, `references_external` (to users outside the corpus),
  `references_escaped` (a key JSON-escaped in the source, left as it is)
- `ids_rederived` and `ids_kept` (an id that matched no derivation in production, kept, so
  the object stays as invalid as it was), `renamed`
- `reader_rejects`: the objects the frozen 0.x reader refuses in the corpus, by kind, each with
  its path and error
- `verdict_changed`: objects the 0.x reader judges differently after the remap; must be empty
- `residual_prod_pks`: production keys still present in the replica's bytes, in text and in
  paths the 0.x reader does not know
- `unknown_paths`: the paths other apps keep under `pub/pubky.app/`, ids folded to `*`
- `envelope_noncanonical`: collection or article envelopes whose escaping would change if
  written again, left as they are
- `incomplete_users`: production keys the manifest marks `complete: false`

No article in the 2026-09-30 corpus carries a `cover_image` (140 articles), so the article cover
rewrite changes nothing in that replica.

## Seed, run and verify

The replica runs on a pubky testnet (`synonymsoft/homeserver-testnet:v0.14.0`) in `persist`
mode, so its file store sits on disk in the `replay-hs` Docker volume and survives a restart,
with Postgres in `replay-pg`. The in-memory default would hold every blob in RAM. A restart
loses the testnet's DHT and pkarr relay, and with them every user's record, so every start
publishes again the record of each user the seed signed up; `--from <step>` works after one. The
CLI needs the package built: `cd pkg && npm install && npm run build`.

```bash
cd tools/replay

# Everything below in one go, resumable per step (--from <step>, --to <step>); --down removes
# the containers and volumes once every check passed
node replay.mjs

# Or step by step
node seed.mjs                         # data/seed-report.json, data/seed-state.json
node run.mjs                          # data/reports/<pk>.json, data/actual/<pk>.ndjson
cd ../.. && cargo run --features replay --bin replay_verify -- --data tools/replay/data

# The numbers again, from the reports on disk
node replay.mjs --from metrics --no-docker
```

`seed.mjs` starts Postgres and the testnet (or expects them up with `--no-docker`), waits for
the homeserver's record on the pkarr relay, signs every replica key up and PUTs its tree with
`putBytes`, JSON included, so the testnet holds production's bytes exactly: `putJson` would
store the SDK's serialization, with sorted keys and without the objects that do not parse. It
keeps 4 users and 8 requests in flight, resumes from `seed-state.json`, and at the end lists
every user's tree and reports any path on one side only, and every PUT the homeserver refused.
`seed-state.json` names the seed with an epoch; `--no-resume` starts a new one.

`run.mjs` migrates each user with `pubky-social-migrate --testnet localhost --json`, from a
recovery file it writes to a temporary directory, 4 users at a time (`--parallel`). `--only`,
`--mode dry|run`, `--rescan`, `--reports <dir>` and `--force` (run a user whose report is
already final) shape a pass, and `--kill-after <s>` interrupts the CLI with a SIGTERM. After a
run it dumps the user's two roots through its own session into `data/actual/<pk>.ndjson`: a
first line naming the seed, then size and blake3 of every object, and the text of every 1.x
object but media. Every record and dump carries the seed's epoch, and one of another seed counts
as absent, so a reseed never verifies against stale data. A CLI whose output starts with
`Sign-in failed:` runs again, up to three times: the testnet's pkarr relay has answered the
homeserver's record without an HTTPS endpoint. Any other failure before a report is kept in the
user's record and fails the pass. `<reports>/summary.json` keeps every session that added to the
pass, so a pass that resumed reports the wall time of all its sessions.

`replay_verify` is the oracle. It never reads the engine: it replays the engine's walk over the
replica tree on disk with `MigrationCtx` and the transforms (File objects first, then the passes
in order, a write whose key an earlier object claimed counting `already_present`, anything no
pass takes `not_migrated`), and checks the dump and the report against it:

- every expected 1.x object is on the testnet, JSON equal by meaning (an absent member equals a
  `null` one), media equal by hash; of two objects folding onto one key, either may have landed
- every 1.x object on the testnet reads through the 1.x reader (`PubkySocialObject::from_uri`)
- no 1.x object the oracle does not expect, and nothing outside the v0 tree and the 1.x roots
- `_migrated.json` present, `transform_rev` 1, its `skipped` equal to the oracle's
- the report: every count, skipped path and dropped value equal, `done` equal to `total`. With
  `--resumed`, for a run that found an earlier run's copies (the kill, quota and rescan cases),
  only `written` plus `already_present` is fixed
- the v0 tree byte for byte as the replica holds it

The oracle runs the crate's own transforms, so 0 mismatches proves what the engine adds around
them: the walk and its order, the writes it makes and the ones it must not, the bookkeeping of
the report and the flag, and the untouched v0 tree. It says nothing on whether a transform
turns a v0 object into the right 1.x object; the semantic vectors check that, and so does a
reading by hand of sampled pairs: `--sample <n>` writes n v0 objects per pass beside the 1.x
objects they became to `data/verify/sample/`, chosen by a hash of owner and path.

It writes `data/verify/<pk>.json` and `data/verify/summary.json` with the skip histogram and
findings in both directions against the frozen 0.x reader:

- `skipped_though_real`: every `invalid`, `malformed`, `shape` and `unsafe_integer` skip, which
  real data should not produce, grouped by what the 0.x reader says of the object
- `migrated_though_refused`: every object the transforms took (a File read into the run, or an
  object that gave writes) although the 0.x reader refuses it, grouped the same way

and the media references left dangling, split into `not_sampled` (production holds the blob,
the crawl did not fetch it) and `absent_in_production` (production lists no such blob for the
owner). `list_pages_derived` counts the LIST pages of a first run, since the CLI does not count
them: per user, the 0.x root in pages of 1000 plus the empty page that ends it, and one empty
page for each 1.x root, `ceil(objects / 1000) + 1 + 2`.

`replay.mjs` then migrates a sample again in a browser (see [Browser path](#browser-path)),
runs every user again (all `already_migrated`, and the homeserver's event count unchanged),
rescans 10 users (only the flags are written), and the operational cases on
three users each, each user's 1.x tree deleted first:

- kill: SIGTERM after 40% of the user's first run, then a rerun to `done`, then verify
- quota: the admin API sets the user's storage quota to its v0 tree plus about 1 MB, the run
  must pause with `QUOTA`, and `needBytes` must equal the size the Files declare for the
  owner's blobs not on the testnet at the pause (dumped then); after the quota is lifted the
  run resumes to `done`
- rate limit: the homeserver restarts with PUT limited to 30 a minute per user (burst 5), a
  probe checks it answers 429, and the run must still end `done` through the engine's backoff

The numbers land in `data/metrics.json`, rebuilt by the last step from the reports on disk.

### The first full replay (2026-09-30)

One machine, 9 GB of RAM and a spinning disk, the testnet and Postgres in Docker, 4 users at a
time. The homeserver fsyncs every write, so writes ran at about 40 a second throughout.

| step | result |
|---|---|
| seed | 849 users, 114,214 objects, 348 MB, 55 min, nothing refused, every tree equal to the replica |
| run | 849 users `done` in 59 min over two sessions (3,561.7 s, then 1.8 s for the one user whose sign-in failed); per user p50 1.8 s, p90 13 s, max 14 min |
| heaviest user | 9,111 objects in 846 s, about 11 objects a second with the engine's two in flight |
| largest blob | the 100 MB blob's owner, 38 objects, 16 s |
| verify | 849 of 849 users equal to the oracle, report counts exact, every 1.x object read back, no mismatch of any kind |
| second run | 849 `already_migrated`, 0 writes on the homeserver, 4.7 min |
| rescan | 10 users `done`, 0 objects written, 10 writes (the flags), verify passes |
| kill | 3 users of 2,944 to 3,837 objects killed after 90 to 158 s, rerun to `done` (1,068 to 1,282 written, the rest found present), verify passes |
| quota | 3 users of 6.7 to 42.5 MB paused with `QUOTA` and `done` once the quota was lifted, verify passes; `needBytes` was the size of the blob the walk had not reached (6,676,469, 14,238,086 and 42,311,682 bytes). This run predates the dump at the pause, so the equality was read from the LIST order, not checked |
| rate limit | a probe met a 429 after the burst; 3 users of about 100 objects took 220 s instead of 7 to 10, all `done`, verify passes |

The run read 333 MB of v0 objects and wrote 331 MB of 1.x objects, over 3,460 LIST pages
(derived). Skips: 1,669 `not_migrated` (`settings.json`, `last_read` and other apps' paths),
102 `invalid`, 9 `shape`, 8 `malformed`; no `tombstone`, `empty_title`, `unknown_post_kind` or
`unsafe_integer`. 4,696 media references in 464 users dangle: 4,679 to blobs production holds and
the crawl did not sample (it fetched 28 of about 5,000), 17 to blobs production never listed.

Skipped though real, 119: every one is an object the frozen 0.x reader refuses too, except two
probe posts whose `parent` names a host that is not a key
(`pubky://global848185000.../posts/DRILLGLOBAL84`), which the 0.x reader never checked. The rest:
tag labels with `,` or `:` (`pubky:annotation`, `bitcoin,`), post ids outside the timestamp range
or not Crockford, tags whose target spells the host `pubky<key>` or `test`, feeds with more than
5 tags or a `cards` layout, `attachments` stored as the string `"[]"`, posts without `content`
or that do not parse, a tag stored as a JSON string, and two blobs stored under `files/`.

Migrated though refused, 56, as the transforms stood on 2026-09-30: 36 File objects the run read
for their blob and name although their id is before October 2024, too long or not Crockford;
16 tags and 2 bookmarks whose id is not the one their target derives (the remap keeps such ids,
so they stay as invalid as they were in production); one collection whose first item is not a
canonical post URI; one profile with an empty image, which migrates without it. A transform that
skips what the 0.x reader refuses turns these into skips, and this group into zero.

Disk at the end, by `du -s`: `data/` 1.3 GB; the two volumes 0.9 GB by Docker's count, taken
before they were removed.

## Browser path

The Node pass proves the engine and the SDK's Node build. A web app runs something else: the
package's ESM build and its wasm loaded by a page, the SDK's browser build over the browser's
`fetch` and CORS, Web Locks for the lock, and a tab's memory for the largest blobs. The browser
path runs exactly that, in Chromium and in Firefox through Playwright.

`browser/harness.html` loads the package's `dist/index.js`, the migration subpath and its SDK adapter from the
built package, and `@synonymdev/pubky`'s browser build from `node_modules`, through an import
map; `browser/serve.mjs` serves them on `127.0.0.1`, a secure context without TLS, so
`navigator.locks` is there. `window.replay.run({secretHex, testnetHost, mode, rescan})` signs in
with `Keypair.fromSecret` and `signin("pubky-social-migrate")`, runs `runMigration` over
`sdkPort(session)` with the session's capabilities and `lock` over
`navigator.locks.request(name, {ifAvailable: true}, fn)`, pushes every progress event to
`window.replay.progress`, signs out, and resolves with the report, the timings and the memory
peaks: `performance.memory.usedJSHeapSize` sampled every 200 ms (Chromium only; it counts
ArrayBuffers, so a blob in flight shows), and the final size of each wasm's linear memory, which
never shrinks.

`browser.mjs` drives it, one browser at a time and a fresh one per user:

```bash
cd tools/replay
npm install
PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium      # into node_modules

node browser.mjs --sample 2                   # data/reports-chromium/, data/actual-chromium/
node browser.mjs --only <pk> --browser firefox
```

The secret reaches the page through `page.evaluate`, never in a URL. It writes
`<reports>/<pk>.json` in `run.mjs`'s record shape plus the browser, timings and memory, with
Chromium's renderer peak resident set (`VmHWM`) beside the heap, and dumps the tree after the
run with the same code `run.mjs` uses, into `data/actual-<browser>/`. An error some code in the
page logs or throws fails the user. Chromium also logs each 4xx answer as a console error, with
the resource as its location; the migration expects those (a HEAD before each write answers 404),
so only errors located in the page's own scripts count.

`--sample <n>` takes a deterministic sample of the replica: the user with the most objects, the
lightest other user past one LIST page (1000 objects), the owner of the largest blob, and n
more spread evenly in key order.

`replay.mjs`'s `browser` step checks, per browser, with the Node run already done:

1. the sample migrated again in the browser, as from a second device: every user
   `already_migrated`, and the homeserver's event count unchanged
2. each sample user's 1.x tree deleted, then migrated from nothing in the browser
3. `replay_verify --reports data/reports-<browser> --actual data/actual-<browser>` against the
   oracle, and with `--compare-reports data/reports --compare-actual data/actual` against the
   Node run of the same user: the same report (status, counts, `dropped` and its values,
   `skipped`, `notes`, compared as sets where order is the walk's) and the same tree, byte for
   byte, but the flag's `migrated_at`

`node replay.mjs --sample 2 --to browser` replays the sample alone: seed, Node run, verify, then
the browser step.

### The first browser run (2026-09-30)

Chromium 153 (Playwright's headless shell) on the same machine, over a fresh replica of the
sample alone (`replay.mjs --sample 2 --to browser`), one browser at a time:

| user | objects | Node | Chromium | JS heap peak | renderer peak |
|---|---|---|---|---|---|
| heaviest | 9,111 | 628 s | 733 s | 121 MB | 658 MB |
| past one LIST page | 1,071 | 78 s | 86 s | 17 MB | 173 MB |
| largest blob (100 MB) | 38 | 7 s | renderer killed after 10 s | | 1.53 GB at the kill |
| two small users | 3 and 2 | 3 s | 1 s | 13 MB | 129 MB |

The second device check passed for all five (`already_migrated`, 0 writes). The four users that
finished verify against the oracle and equal the Node run: the same report and the same tree
byte for byte but the flag's time. The writes are bound by the homeserver's fsync, as in Node.

The largest blob's owner did not finish here. With one 100 MB blob in flight the renderer grew
to 1.5 to 1.6 GB, of which the package's wasm memory held 302 MB, the SDK's 102 MB and the JS
heap about 311 MB at the last sample; this machine's `earlyoom` killed it when free memory fell
to its 8% floor. The Node CLI peaks at 1.09 GB on the same user. So a blob costs about three
copies of itself inside the package's wasm besides the JS and SDK copies, and a wasm memory never
shrinks, so the tab keeps that size for the rest of the run.

### The nightly job

`.github/workflows/replay.yml` (`replay-browser`, nightly and on demand) builds the package,
installs Chromium and Firefox, and runs `replay.mjs --sample 2 --to browser` in both browsers,
the testnet and its Postgres in Docker as here. With the secret `REPLAY_CORPUS_URL` set, it
restores the corpus from that URL, a tarball of `replica/`, `keys.json` and `inventory.json`:
the replica trees, the secrets the seed and the migration sign in with, and the blob inventory
under replica keys. Neither `map.json` nor `manifest.json` goes in it. That has to be a presigned
URL into a private bucket: the replica is production content under other keys and `keys.json`
is credentials, and a workflow artifact is readable by anyone who can read the repository. Without it, `fixture.mjs` writes two users whose tree is the semantic vectors' 0.x
tree (38 objects each), so the browser path runs every night regardless. GitHub registers an `on: schedule` only from the workflow file on the default branch, `main`; while this file lives on `v1` only `workflow_dispatch` runs it, by hand, and the nightly starts once it reaches `main`.

## Next

- The corpus in a private bucket for the nightly job, and the checklist the full replay has to
  pass before the migration is switched on.
- The largest blob in a browser: the tab's memory for one 100 MB blob, and a run of that user
  where the memory allows it (the nightly job with the corpus).
