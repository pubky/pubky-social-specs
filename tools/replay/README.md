# Replay

The migration is tested on hand-built vectors and small synthetic trees. Before any real user
migrates, it has to run over what production holds. The replay copies every user's public v0
tree from production, gives each user a fresh key, seeds the copy onto a testnet homeserver and
migrates it there, so real data meets the migration without touching a real account.

This directory holds the tooling. Nothing it produces is committed: `data/` is ignored.

## Privacy

Only public data is read: `pub/pubky.app/` is readable by anyone, so the crawl uses anonymous
LIST and GET and never a session. Production is never written to.

The replica does not carry production keys. `replay_remap` derives each user's replica key from
a secret salt and the production key, and rewrites the references between users under that map,
so a third party without the salt cannot link a replica key back to its user. The salt is read
from the environment only (`REPLAY_SALT`, or the variable `--salt-env` names); no tool reads or
writes it anywhere else, so keep it where your other secrets live. The corpus, the replica,
`map.json` and `keys.json` stay on the machine that ran the replay, and the remap writes the two
key files readable by their owner only (mode 0600). Text is copied as written, so a post that
mentions someone still names them; the remap report counts those.

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

The remap builds behind the `replay` feature, which adds the key derivation to `migrator`; the
package's `migrator` alone does not pull the crypto crate. Its tests run with
`cargo nextest run --features replay -E 'binary(replay_remap)'`.

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

## Next

- Seed: start a testnet homeserver, sign every replica key up, PUT the replica tree and check by
  LIST that it equals the manifest.
- Run and verify: migrate every user from Node, then check the result against an independent
  run of the transforms over the same tree: every expected path present and equal, no
  unexpected path, the skips named and counted, the v0 tree untouched, a second run a no-op.
- Browser harness: the same migration in Chromium and Firefox through Playwright, which must
  give the same result as Node for the same user.
- Nightly: a CI workflow over a cached subset of the corpus, and the checklist the full replay
  has to pass before the migration is switched on.
