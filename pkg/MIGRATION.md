# Migrating 0.x data to 1.x

`pubky-social-specs/migration` carries the whole 0.x to 1.x migration: the transforms and the engine that walks a tree with them. The transforms are the reference crate compiled to wasm, because they read 0.x objects through its frozen reader; this subpath is the only part of the package that loads a wasm, and it does so on the first `runMigration`. The engine uses no browser or Node global, so the same code runs in pubky-app, in a standalone web tool, and under Node for a CLI or a server run. Under Node, `pubky-social-specs/migration/pubky-sdk` is the port over a pubky SDK session and `pubky-social-migrate` runs the whole migration from a terminal (see [Running it from Node](#running-it-from-node)).

```js
import { runMigration } from "pubky-social-specs/migration";
import { sdkPort } from "pubky-social-specs/migration/pubky-sdk";
import { owner, session } from "./docs/prelude.js"; // your SDK session

const controller = new AbortController();
const report = await runMigration({
  owner,
  port: sdkPort(session), // or your own adapter over the homeserver client, below
  caps: session.info.capabilities, // optional, a string or a list of scopes
  // optional: one run per owner across a browser's tabs
  lock: globalThis.navigator?.locks ? (name, fn) => navigator.locks.request(name, { ifAvailable: true }, fn) : undefined,
  onProgress: (event) => console.log(event.phase, event.done, event.total),
  signal: controller.signal,
});
console.log(report.status); // done: an empty 0.x tree migrates at once
```

`runMigration` loads the wasm itself. It resolves with a report in every case, an unreadable flag included. Only a programming error rejects: an owner that is not a pubky, an unknown `mode`, a port that answers a GET with something other than a `Uint8Array`, a fault inside the package. The error it rejects with is the one that was thrown.

## What a run does

1. With `caps` given, it checks that the session covers `ENGINE_CAPS` before any request, and aborts with `CAPS_MISSING` otherwise, the scopes to ask for in `error.caps`. Read and write may be granted in one scope or in two. The engine never prompts.
2. It probes the private root by a HEAD of `priv/social/v1/_migrated.json`. A homeserver without `/priv/`, where the HEAD throws `unsupported`, aborts the run with `PRIV_UNSUPPORTED`: the private types and the flag live there. Any other failure of the probe aborts with `IO_ERROR`. When the flag records a `transform_rev` equal to or above `transformRev`, the run returns `already_migrated` without listing anything, unless `rescan: true`. A flag whose members are not what a run writes reads as revision 0, so the tree is walked again.
3. It lists `pub/social/v1/` and `priv/social/v1/` and keys every path by the object it names, whatever the epoch. That set is the journal: a key present in either root is never written again, so a post unpublished to a draft is not copied back to the public root, and an edit made after an earlier run survives. Media is the exception. It counts as present by its exact URL, since a private copy, or one under another extension, does not serve the public references the run writes.
4. It lists `pub/pubky.app/` and walks it by type: the File objects first, since the run reads them to rewrite media references, then blobs, posts, tags, follows, the profile, feeds, bookmarks and mutes. `settings.json`, `last_read` and anything else no 1.x type takes count as `not_migrated` without a read.
5. Each object goes through its own step, below.
6. It writes the flag `{migrated_at, transform_rev, skipped, migrated}`: microseconds, `transformRev`, the 0.x paths that did not land by outcome, and the 0.x paths that did or were already present. A walk with any `io_error` writes no flag and ends `incomplete`, so the next run walks again.

### One object

An object a finished run listed under `migrated` is not copied again. Its 1.x copy may be missing because its owner deleted it, and a delete leaves the 0.x copy of a bookmark or a feed in place, so a rescan or a new `transformRev` must not bring it back. It counts `already_present`. What an earlier run skipped is walked again.

An object whose key is present counts `already_present` too. Any other is read with a GET bounded by `maxBytes`: the file cap for a blob, and for a JSON object six times the largest 1.x object, since a byte of the 1.x form is at most a six-byte escape in the 0.x one. An object over its bound skips as `oversize` before the wasm sees it, whether the port stopped reading (`too_large`) or returned the bytes.

The run then transforms the object and PUTs every write whose key is still not present, with `ifAbsent`, then sends a HEAD of the 0.x object. If the owner deleted it meanwhile, or the HEAD fails, the copies just written are deleted (`deleted_mid_run`, or `io_error` for a copy the next run makes again). Before each of those DELETEs the run reads the destination back and deletes it only when it still holds what the run wrote; a copy another device wrote there in the meantime stays.

A GET that answers 404 is read the same way: the port contract says gone, so a front end that answers 404 for an object it still holds loses that object until a `rescan`. If the cleanup DELETE itself fails, the copy stays: the next run lists the 0.x tree without its source and never revisits it, so an object deleted during its own copy comes back in 1.x. That is a known gap, with the lost PUT answer below.

A destination someone else wrote since the LIST stays as it is and counts `already_present`; the run deletes only what it wrote. Two objects are in flight at a time, and an object whose write folds to a key the other is writing waits for it, and writes itself if that copy did not land.

A File object that cannot be read stops the run with `IO_ERROR`: every blob and post after it depends on it, and would be copied with a wrong extension or media URL that no later run rewrites. A File that reads but that the 0.x reader refuses is only its own skip: it names nothing, so references through it stay as written and a blob only it named migrates as `bin`. The same holds for a File the owner deletes between two runs: copies made before point at `files/{hash}.{ext}`, copies made after at `.bin`, and neither run rewrites the other's. The 0.x reader bounds a TimestampId by the clock, at most two hours ahead, so an object refused for a future id on one run is accepted by a later `rescan`. A File refused that way has already sent its blob to `bin` and left the references through it as written; the rescan adds the copy under its extension and rewrites neither.

### Blobs and memory

A blob never enters the wasm, since a wasm memory grows to fit what is copied into it and never shrinks: one 100 MB blob handed to `migrate` held that memory for the rest of the run. The engine hashes the bytes it read 4 MiB at a time through the hasher, asks `migrateBlob` where they go, and PUTs that same array; the hash naming the destination is its read-back. Under Node, migrating one 100 MB blob through `MemoryPort` peaked at 748 MB RSS when the bytes went through `migrate`, and peaks at 352 MB now, most of it the port's own copies of the blob. The browser target, a peak RSS under 500 MB for the owner of a 100 MB blob, is measured by the replay harness.

### What the run never does

The run never modifies the 0.x tree. It writes and deletes only under `pub/social/v1/` and `priv/social/v1/`, every segment after the root canonical, and a write the package gives anywhere else rejects the run as a fault before any PUT. The engine spells each write's URL itself from the write's kind and id (and, for media, the extension), and a transform that names any other URL rejects the run the same way. The fence and the SDK adapter run one shared check of every URL. A LIST past about a million objects aborts with `IO_ERROR` rather than hold them all, and a flag over 64 MiB reads as no flag. `mode: "dry"` reads and counts exactly as a run does and makes no PUT, re-check or DELETE, the flag included. An interrupted run leaves nothing to clean up: run it again and it resumes from what the 1.x tree already holds.

## The report

The report is `{status, mode, done, total, counts, dropped, droppedValues, skipped, notes, error?}`:

- `status` is `done`, `already_migrated`, `incomplete` (the walk ended but some objects hit `io_error`; run again), `paused` or `aborted`.
- `counts` has one number per outcome: every `skipReasons` entry, `written`, `already_present`, `deleted_mid_run`, `io_error` and `put_rejected`. A File object that reads counts in `done` only: it writes nothing and feeds the run.
- `skipped` maps each outcome but `written` and `already_present` to its 0.x paths, the same object the flag stores; `notes` carries the detail for some of them, such as the status of a refused PUT.
- `dropped` and `droppedValues` report the values the 1.x rules refused inside an object that still migrated (`profile_image`, `profile_link[i]`), so the host can tell the user.
- `error` is `{code, message, needBytes?, caps?}`. `QUOTA` pauses the run with `needBytes`, the sizes the File objects declare for the blobs the walk has not yet copied or found present; free space or raise the quota, then run again. `needBytes` is left out when no blob is pending. `SESSION_EXPIRED`, `IO_ERROR` (a LIST, a File object or the flag failed), `ALREADY_RUNNING`, `UNSUPPORTED_EPOCH` and `ABORTED` (the signal fired) abort it.

`onProgress` gets `{phase, pass?, done, total, counts, dropped, current?, error?}` after every object and at every phase change. `phase` is `probe`, `listing`, `migrating`, `flag`, `done`, `incomplete`, `paused` or `aborted`, and `pass` names the 0.x directory being walked. `bucketOf(pathOrUrl)` gives the pass of one stored object, so an app can count a LIST by pass to preview a migration without running it.

### What a skip means

An object the walk leaves behind is counted under one of `skipReasons`. An object is skipped when the frozen 0.x reader refuses it: `malformed` when the JSON parser cannot read the bytes, `shape` when the reader cannot read them into its model, `invalid` when its rules refuse the object, as they do a stored id they do not accept or a `[DELETED]` post. What migrates is what the reader stored, so a profile named `[DELETED]` becomes the `anonymous` the reader made of it. `not_migrated` is a path with no 1.x counterpart, such as `last_read`, or another owner's path. `oversize` is an object over its bound. A blob that skips leaves the references already rewritten to it dangling, so count every skip and report it.

## Constants

`ENGINE_CAPS`, `/pub/social/v1/:rw,/priv/social/v1/:rw`, is what the engine writes and all it checks `caps` for; reading and listing the 0.x tree is anonymous. `MIGRATION_CAPS` is the full grant a migrating pubky-app holds, `ENGINE_CAPS` plus `/priv/app.pubky/v1/:rw,/pub/pubky.app/:rw`: the app's own private namespace, and the 0.x tree, which deleting a migrated object later still reaches. The engine never checks it; it is what the app asks for when it upgrades a session. `transformRev` is the revision of the transforms, and goes up when a transform changes what it writes. A tree recorded under a lower one is walked again, which picks up the objects an earlier revision skipped; a walk never rewrites a destination that exists, and never copies again what an earlier run migrated.

The engine migrates to `social/v1/` and nowhere else, and refuses to run (`UNSUPPORTED_EPOCH`) in a build whose list prefix names another epoch. With one 0.x epoch and one transform step, the source is always `pub/pubky.app/`; discovering the epochs present and sourcing each object from the highest one is the follow-up the next epoch brings.

## The port

All I/O goes through the port, and every URL is a full `pubky://` URL:

```ts
interface MigrationPort {
  list(prefixUrl: string, cursor?: string): Promise<{ urls: string[]; next?: string }>;
  get(url: string, options?: { maxBytes?: number }): Promise<Uint8Array | null>;
  head(url: string): Promise<boolean>;
  putJson(url: string, object: unknown, options?: { ifAbsent?: boolean }): Promise<void>;
  putBytes(url: string, bytes: Uint8Array, options?: { ifAbsent?: boolean }): Promise<void>;
  delete(url: string): Promise<void>;
}
```

A LIST is deep and ascending: every URL under the prefix, spelled as the prefix is, after `cursor` when given, with `next` the cursor of the following page and absent on the last; a prefix with nothing under it is an empty page. A LIST answering another spelling stops the run with `IO_ERROR`. A missing object is `null` from `get` and `false` from `head`. With `maxBytes`, a port that can tell an object is larger throws `too_large` instead of reading the rest; one that cannot may return the bytes, which the engine then skips all the same. The engine passes `ifAbsent: true` on every PUT of a copy: the adapter writes only when nothing is at the URL, and throws `exists` when something is. Where the homeserver has no create-only PUT, that is a HEAD before the PUT, as `sdkPort` does below. Every failure is a thrown `MigrationPortError(kind, message?, status?)`, and the engine branches on `kind`:

| homeserver answer | `kind` | what the run does |
|---|---|---|
| 507 | `quota` | pauses |
| 429 | `rate_limited` | waits 1 s, doubling up to 60 s, and calls again |
| 401, and a 403 other than the one below | `unauthorized` | aborts |
| 404 | `not_found` | a GET counts `deleted_mid_run`; a DELETE ignores it |
| 412 on an `ifAbsent` PUT | `exists` | counts `already_present` |
| a body over `maxBytes` | `too_large` | counts `oversize` |
| 403 naming only `/pub/`, "Writing to directories other than '/pub/' is forbidden", from a homeserver older than `/priv/` | `unsupported` | aborts on the probe |
| no answer at all, or a 5xx other than 507 | `network` | retries three times, then counts `io_error`, and the run ends `incomplete` |
| any other 4xx, 413 included | `rejected`, with `status` | on a PUT counts `put_rejected`; on a GET or HEAD counts `io_error` |

`rejected` is a definitive refusal and lands in the flag like a skip. Before recording it the engine reads the URL back: a retry can be refused after an earlier try landed and lost its answer, and when the read-back finds this run's bytes the object counts `written`. A server that failed is not refusing: a 5xx must reach the engine as `network`, so the object counts `io_error`, the run ends `incomplete` without a flag, and the next run writes it. `refusal(status, message?)` builds the error for a status as this table maps it; an adapter throws what it returns, and has to decide `unsupported` itself, since only the text of the refusal says the root is missing. A `/priv/` read on a session without the scope is a 401 or a 403, `unauthorized`, and never an absent object: a port that answered it with `null` or `false` would make a refused flag read as a missing one.

Anything else a port throws counts as `network`, a call that never got an answer. `MigrationPortError` is recognised by `instanceof` across two installed copies of the package, so an adapter built against another copy is understood. A `get` that resolves with something other than bytes is a fault of the port, and rejects the run.

`MemoryPort` implements the port over a `Map` for tests: `new MemoryPort({ privSupported, intercept, pageSize })`, where `privSupported: false` plays a homeserver without `/priv/`, refusing every `/priv/` call with that 403, `intercept(op, url)` runs before every call to fail it or to change `store` under the run, and `pageSize` shortens LIST pages. It honours `maxBytes`.

The retries wait through `sleep(ms, signal)`, a timer that ends early when `signal` aborts unless the host passes its own.

What the host implements: the adapter from its homeserver client to the port, the lock (without one the run is unlocked; in a browser, `navigator.locks` keeps it to one tab), and the UI over `onProgress` and the report. The rest of the migration is the app's too: the capability upgrade when a run returns `CAPS_MISSING`, importing its own `settings.json` and `last_read` into its private namespace, and keeping the last progress snapshot so it can show where an interrupted run stopped.

## Running it from Node

`pubky-social-specs/migration/pubky-sdk` is the port over a session of the pubky SDK, [`@synonymdev/pubky`](https://www.npmjs.com/package/@synonymdev/pubky) `>=0.11 <1`, whose session storage has the same calls and answers across that range. Install that SDK next to this package to use the adapter or the CLI. The package does not declare it as a dependency, so a host pinned to another SDK line still installs the package, and the engine never loads it. The adapter declares the part of a session it calls (`SdkSession`), so its types compile without the SDK installed.

<!-- no-run: needs a homeserver and a recovery file -->
```js
import { readFile } from "node:fs/promises";
import { Pubky, Keypair } from "@synonymdev/pubky";
import { runMigration } from "pubky-social-specs/migration";
import { sdkPort } from "pubky-social-specs/migration/pubky-sdk";

const passphrase = "the passphrase of the recovery file";
const keypair = Keypair.fromRecoveryFile(await readFile("alice.pkarr"), passphrase);
const session = await new Pubky().signer(keypair).signin("my-app");
const report = await runMigration({
  owner: session.info.publicKey.z32(),
  port: sdkPort(session),
  caps: session.info.capabilities,
});
```

`sdkPort(session, { pageSize, deadlineMs })` works in the session owner's tree only: a URL of another pubky, a path with a dot segment or another unclean one, or a LIST prefix that is not a directory throws `rejected` before any request. A LIST asks for 1000 URLs a page (`pageSize` lowers it) and gives the last URL of any page that has one as `next`, so only an empty page ends the walk, even where a server or a proxy answers fewer URLs than asked. A directory the homeserver does not have is an empty page. A GET with `maxBytes` streams the body and stops once it runs past the bound, whatever length the server declared.

Every read whose cost does not grow with a body (LIST, HEAD, the GET of an object) has a deadline, 60 s unless `deadlineMs` says otherwise: an answer that never comes counts as `network`, so the engine's retry and `io_error` paths take over instead of waiting on a silent socket (Node's own bound is 300 s, a browser's `fetch` has none). A blob's GET grows with its size, and a write stays pending until the SDK settles it: the SDK takes no signal, so a write abandoned at a deadline could still land after a later run cleaned up behind it.

An SDK error with a status, its `data.statusCode`, goes through `refusal()` and maps as the table above does, with two additions: a 410 is `not_found`, as the SDK's own `exists` reads it, and a 403 from a homeserver older than `/priv/` refusing the root itself ("Writing to directories other than '/pub/' is forbidden") is `unsupported`. An error with no status maps by its name: `AuthenticationError` is `unauthorized`; `InvalidInput`, `ClientStateError` and `InternalError` are `rejected`; a `RequestError` or anything that is not an SDK error is `network`. A HEAD answer has no body to tell those 403s apart, so a refused HEAD is asked again as a GET, whose body is dropped unread.

`ifAbsent` is check-then-write here. The homeserver ignores `If-None-Match` on a PUT, so the adapter sends a HEAD and then the PUT, and a write another device lands between the two is overwritten. The window is one round trip; within one run the engine never writes a key twice, and its race guard never deletes what another device wrote. A PUT whose answer is lost is retried as a HEAD and the PUT, and that HEAD finds the run's own copy, which then counts `already_present`: the race guard does not take it for the run's own, so if the owner deletes the 0.x object in that moment, the copy stays. That case is accepted. The homeserver has WebDAV `LOCK` since 0.13, and `LOCK`, HEAD, PUT with the lock token, `UNLOCK` is a create-only write; the SDK has no call for `LOCK`, so the adapter cannot send one.

### The CLI

```bash
chmod 600 ./account.pkarr
npx -p pubky-social-specs -p @synonymdev/pubky@^0.14 pubky-social-migrate --recovery ./account.pkarr
```

Name both packages to `npx`: a bare `npx pubky-social-migrate` would fetch whatever package holds that name. The CLI asks the passphrase on the terminal with echo off. For a script with no terminal it reads an environment variable instead (`--passphrase-env VAR`, `PUBKY_PASSPHRASE` by default; `read -rs PUBKY_PASSPHRASE && export PUBKY_PASSPHRASE`, then `unset` it after) and removes it from its own environment as soon as it has read it; it never takes the passphrase from the arguments, where the process list shows them. It refuses a recovery file that its group or other users can read, zeroes the bytes of the file and of a typed passphrase once the key is read, and frees the key after sign-in. It refuses an SDK outside `>=0.11 <1`.

It signs in from the recovery file with the client id `pubky-social-migrate`. A failed sign-in gets a hint that fits: a PoP timestamp refusal points at this device's clock, a record that did not resolve at the network, and a refusal of the route at a homeserver older than `/priv/`, since grant sign-in shipped with it.

The run holds a root grant, so the CLI signs out when the run ends, and on an error thrown outside the run before the process exits. The first Ctrl-C, a SIGTERM or a closed terminal (SIGHUP) stops the run after the objects in flight so that sign-out is reached, best effort: a supervisor that kills the process during that wait leaves the grant active until it is revoked from Ring.

It prints a progress line to stderr at every phase and pass and every 50 objects, then the report, as JSON with `--json`. What the homeserver sent (paths, the flag's contents, error messages) is printed with every control character escaped, so none reaches the terminal as one. `--dry-run` writes nothing, `--rescan` walks a tree an earlier run finished, and `--testnet [host]` points it at a pubky testnet (`localhost` by default). It exits 0 when the tree is done or already migrated, 2 when the run ended `incomplete` or `paused` and should run again, 3 when it aborted, and 1 on a usage or unexpected error.

## Live test

`npm run e2e` runs the migration against a pubky testnet; `npm test` does not. It signs up a fresh account on the testnet homeserver, writes the 0.x tree of the semantic vectors through the SDK, and migrates it with `sdkPort`. Then it checks the report against a `MemoryPort` run over the same bytes, reads every write back from the server through `decodeObject`, expects a second run to return `already_migrated` and the 0.x tree to be byte for byte unchanged, and runs the CLI from a recovery file. The testnet listens on fixed ports at `PUBKY_TESTNET_HOST`, `localhost` by default. With Docker:

```bash
docker run -d --name pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:18-alpine
until docker exec pg pg_isready -U postgres; do sleep 1; done
docker run -d --name testnet --network host \
  -e TEST_PUBKY_CONNECTION_STRING=postgres://postgres:postgres@localhost:5432/postgres \
  synonymsoft/homeserver-testnet:v0.14.0
# ready once the pkarr relay serves the homeserver's record
until curl -sf -o /dev/null http://localhost:15411/8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo; do sleep 1; done
cd pkg && npm run build && npm run e2e
docker rm -f pg testnet
```

CI runs it in the `e2e` job of the JS binding workflow.

## Exports

From `pubky-social-specs/migration`: `runMigration`, `MemoryPort`, `MigrationPortError`, `refusal`, `bucketOf`, `ENGINE_CAPS`, `MIGRATION_CAPS`, `skipReasons`, `transformRev`, and the types `MigrationPort`, `GetOptions`, `PutOptions`, `PortErrorKind`, `MemoryPortOptions`, `PortOp`, `RunOptions`, `MigrationLock`, `AbortSignalLike`, `MigrationReport`, `MigrationError`, `ErrorCode`, `ProgressEvent`, `Phase`, `Bucket`, `Counts`, `Outcome`, `SkipReason`, `Dropped`.

From `pubky-social-specs/migration/pubky-sdk`: `sdkPort`, and the types `SdkPortOptions`, `SdkSession`, `SdkResponse`.
