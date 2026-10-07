# pubky-social-specs

The Pubky social data model for JavaScript and TypeScript: profiles, posts, tags, bookmarks, follows, mutes, feeds and media, as plain synchronous functions.

A builder gives you where an object goes and the exact bytes to PUT there. A decoder reads what a GET returns. Nothing is loaded first and nothing performs I/O, so the same calls work in a browser, in Node, in a worker and during server rendering.

The reference implementation is the Rust crate of the same name. This package is a native TypeScript implementation of it, checked against the crate on every operation: the same stored bytes, the same ids and paths, and the same message when an object is refused.

## Installation

```bash
npm install pubky-social-specs
```

ESM only, with types. Node 20.19 or later, Deno 2, Bun 1, and browsers from 2022 on (Safari 15.4). One dependency, [`@noble/hashes`](https://www.npmjs.com/package/@noble/hashes).

## Quick start

```js
import { buildPost, decodeObject } from "pubky-social-specs";

// Build: where the post goes and the bytes to send
const { url, path, body } = buildPost(owner, { content: "Hello" });
await session.storage.putBytes(path, body);

// Read: what a GET returned, checked against the id, the root and the author the URL names
const read = decodeObject(url, await session.storage.getBytes(path));
if (read.kind === "post") console.log(read.object.content);
```

`owner` is the z-base32 public key of the user writing. `body` is a `Uint8Array` that `fetch`, `Blob` and the Pubky SDK take as it is.

## The rules of the surface

1. **The package writes the bytes.** Never `JSON.stringify` an object yourself: unknown members have an order and numbers a spelling that only the package reproduces. Every builder returns `body`, and `encodeObject` gives the bytes of an object you edited.
2. **Unknown members are carried, not read.** A newer client may store members this version does not know. They come back in `$unknown`, as text; leave it on the object and it is written back untouched. A member that is neither known nor inside `$unknown` is an error, so a typo is never stored.
3. **Two kinds of error.** A value the data model refuses throws a `ValidationError`, whose message is the reference text and starts with `Validation Error: `. A value of the wrong JavaScript shape (a number where a string goes, a missing input member) throws a `TypeError` naming the argument: that is a bug in the calling code, and TypeScript catches most of them first.
4. **Stored objects are spelled as stored.** `created_at`, `cover_image`, `domain_tags`: the same names in an input, in a decoded object and on the wire. Every known member is present, `null` when it has no value. Integers are numbers.

## Builders

Every builder takes the owner first and returns a `Built<T>`:

```ts
interface Built<T> {
  id: string;     // what the path names: "" for the profile, the followee for a follow
  path: string;   // owner-relative, as the SDK's storage calls take it
  url: string;    // the full pubky:// URL
  object: T;      // the stored object, for your local state
  body: Uint8Array; // the bytes to PUT
}
```

```js
import { buildUser, buildPost, buildTag, buildBookmark, buildFollow, buildMute, buildFeed, buildFile, buildUri } from "pubky-social-specs";

buildUser(owner, { name: "Alice", bio: "Hi", links: [{ title: "Site", url: "https://example.com" }] });

buildPost(owner, { content: "A note", parent: buildUri(other, "post", postId) });
buildPost(owner, { kind: "article", title: "Title", body: "Markdown body", cover_image: imageUrl, slug: "title" });
buildPost(owner, { kind: "collection", name: "Reading list", items: [{ uri: postUrl, note: "start here" }], layout: "grid" });
buildPost(owner, { content: "A draft", root: "private" });

buildTag(owner, buildUri(other, "post", postId), "rust");
buildBookmark(owner, postUrl);
buildFollow(owner, other);
buildMute(owner, other);
buildFeed(owner, { name: "Rust", icon: "star", reach: "all", layout: "columns", sort: "recent", tags: ["rust"] });
```

A builder trims display text (a name, a title, a label) and folds a tag label to lowercase ASCII. References are stored as written and must already be canonical: `buildUri` gives canonical pubky URIs, and a web URL is canonical once trimmed. Absent and `null` mean the same in an input.

`buildPost` returns a `BuiltPost`, a `Built<Post>` with the `editId` of the version; for a new post it equals `id`. The input is told apart by `kind`, so a collection with a `parent` does not compile.

### Media

Media is content addressed: its id is the hash of its bytes, and the declared type only picks the extension of the path.

```js
const { url, path } = buildFile(owner, { bytes, type: file.type });
await session.storage.putBytes(path, bytes);
buildPost(owner, { content: "A photo", attachments: [{ uri: url, name: file.name, alt: "A cat" }] });
```

Hashing is plain JavaScript and synchronous, on the order of 10 to 20 MB a second. For a large file, hash in a worker and hand over the id:

```js
// in the worker
const hasher = createMediaHasher();
for await (const chunk of file.stream()) hasher.update(chunk);
postMessage(hasher.id());

// on the main thread
const { url } = buildFile(owner, { id, type: file.type });
```

`limits.maxFileSizeBytes` is the cap, and `validMimeTypes` is a hint list for a file picker.

## Reading and editing

`decodeObject(uri, bytes)` returns `{ kind, object }`, or `{ kind: "file", bytes }` for media. It refuses bytes that are not a valid object at that URI, with the reason.

To change a stored object, decode it, change it, and encode it. Whatever this version does not know stays in `$unknown` and is written back:

```js
const read = decodeObject(profileUrl, bytes);
if (read.kind !== "user") throw new Error("not a profile");
read.object.status = "On holiday";
await session.storage.putBytes(profilePath, encodeObject(profileUrl, read.object));
```

`encodeObject` also takes `{ kind, root? }` in place of a URI, for bytes that go somewhere the data model does not name; the object is then checked by every rule that needs no path.

A feed's id is derived from its filter, so an edited filter moves the feed: `feedId(feed)` gives the id to write it under.

### Articles and collections

The `content` of an article or a collection is itself JSON. Read and write it through the package, for the same reason as rule 1:

```js
const envelope = decodeContent(post);        // { kind: "article", content: { title, body, cover_image } }, or null for a note
post.content = encodeContent({ ...envelope.content, title: "A better title" });
```

## Posts: versions, drafts and the lifecycle

A post is a directory of versions, `posts/{id}/{editId}[-slug].json`, under the public root or the private one. The newest `editId` is the post as it reads now.

```js
// Edit: a new version above the head, under the head's root unless you say otherwise
const edited = editPost(headUrl, { ...post, content: "Fixed a typo" });

// Publish a private version: copy its private media first, then PUT the post
const plan = planPublish(owner, { id, editId, post });
for (const { from, to } of plan.copies) await copy(from, to);
await put(plan.put.path, plan.put.body);

// Unpublish: copy back what the private tree lacks, then delete the public versions
const { copies, deletes } = planUnpublish({ id, publicPaths, privateHead });

// Delete everywhere, in the order that never leaves a reader a dangling post
const { deletes, mediaGcCandidates } = planDelete(owner, { id, legacyPaths, copies, versions });
```

A plan performs no I/O. It returns owner-relative paths, in the order to run them. A reference to a post is versionless (`buildUri(author, "post", id)`), so it survives every edit.

## URIs

```js
buildUri(owner, "user");                 // pubky://<owner>/pub/social/v1/profile.json
buildUri(owner, "post", postId);         // the versionless reference
buildUri(owner, "file", `${hash}.png`);  // a file takes its full name
listPrefix(owner, "public");             // pubky://<owner>/pub/social/v1/ , for a LIST
listPrefix(owner, "legacy");             // the 0.x tree, pubky://<owner>/pub/pubky.app/

const parsed = parseUri(uri);
// { owner, root, path, kind: "post", id, editId?, slug? }
// { owner, root, path, kind: "bookmark", id, target? }   target when the id carries it
// kind is also "foreign", "unsupportedVersion" or "unknown": classifications, never errors
```

`parseUri` throws only for a string that is not a canonical pubky URI with a known root. It never reads the clock, so what a path names does not change with time.

## Deleting

`deletionPaths({ kind, id, listings? })` gives every stored copy of one object across both epochs and both roots, legacy first, as owner-relative paths:

```js
deletionPaths({ kind: "follow", id: followee });
deletionPaths({ kind: "file", id: hash, listings: [...v1Paths, { path: v0FilePath, src }] });
```

Only a post, a file and a tag take `listings`, the copies you found by LIST; each is checked to belong to the object, and one that does not is an error naming it.

## Limits and names

```js
import { limits, postKinds, feedReaches, feedLayouts, feedSorts, collectionLayouts } from "pubky-social-specs";

limits.postNoteContentMaxLength; // 2000
z.enum(feedReaches);             // the name tuples work as a schema's enum
```

Lengths are in Unicode code points unless the name says bytes. A stored name this version does not know reads as `"unknown"`, so `PostKind` has that member and `KnownPostKind`, what a builder takes, does not.

## Testing your code

The package is pure and synchronous, so tests can call it for real. `setClock` fixes the clock, which fixes every id and `created_at`:

```js
import { setClock, buildFollow, decodeObject } from "pubky-social-specs";

beforeEach(() => setClock(() => 1_790_000_000_000)); // milliseconds, as Date.now()
afterAll(() => setClock());

const { url, body } = buildFollow(me, them);
expect(decodeObject(url, body)).toEqual({ kind: "follow", object: { created_at: 1_790_000_000_000_000 } });
```

Ids only go up within one process, so two posts built in the same instant get different ids; `setClock` starts that guard over.

## What to know

- `decodeObject` pulls in every model, about 19 kB gzipped. `buildUri` alone is under 2 kB, and the whole entry about 26 kB.
- The id guard is per copy of the package. Two copies in one page mint independently, so a library that wraps this one should declare it a peer dependency.
- An edit through `$unknown` writes the bytes a Rust client writes for the same edit. The one thing a caller can still get wrong is to drop `$unknown` when copying an object field by field.

## Migration

The package carries the whole 0.x to 1.x migration: the transforms and the engine that walks a tree with them, published as `pubky-social-specs/migration`. The transforms are the reference crate compiled to wasm, because they read 0.x objects through its frozen reader; this subpath is the only part of the package that loads a wasm, and it does so on the first `runMigration`. The engine uses no browser or Node global, so the same code runs in pubky-app, in a standalone web tool, and under Node for a CLI or a server run. Under Node, `pubky-social-specs/migration/pubky-sdk` is the port over a pubky SDK session and `pubky-social-migrate` runs the whole migration from a terminal (see [Running it from Node](#running-it-from-node)).

```js
import { runMigration } from "pubky-social-specs/migration";

const report = await runMigration({
  owner,
  port, // your adapter over the homeserver client, below
  caps: session.capabilities, // optional, a string or a list of scopes
  lock: (name, fn) => navigator.locks.request(name, { ifAvailable: true }, fn), // optional
  onProgress: (event) => progress.set(event),
  signal: controller.signal,
});
```

`runMigration` loads the wasm itself. It resolves with a report in every case; only a programming error (an owner that is not a pubky, an unknown `mode`, a fault inside the package) rejects.

What a run does, in order:

1. With `caps` given, checks that the session covers `ENGINE_CAPS`, before any request, and aborts with `CAPS_MISSING` otherwise, the scopes to ask for in `error.caps`. A session that holds only the 0.x scope hears about its caps first. The engine never prompts.
2. Probes the private root by a HEAD of `priv/social/v1/_migrated.json`. A homeserver without `/priv/`, where the HEAD throws `unsupported`, aborts the run with `PRIV_UNSUPPORTED` and a message saying so: the private types and the flag live there. Any other failure of the probe aborts with `IO_ERROR`. When the flag records a `transform_rev` equal to or above `transformRev`, the run returns `already_migrated` without listing anything, unless `rescan: true`.
3. Lists `pub/social/v1/` and `priv/social/v1/` and keys every path by the object it names, whatever the epoch. That set is the journal: a key present in either root is never written again, so a post unpublished to a draft is not copied back to the public root, and an edit made after an earlier run survives. Media is the exception: it counts as present by its exact URL, since a private copy, or one under another extension, does not serve the public references the run writes. So every blob is read and migrated, and the write it gives is what gets checked.
4. Lists `pub/pubky.app/` and walks it by type: the File objects first, since the run reads them to rewrite media references, then blobs, posts, tags, follows, the profile, feeds, bookmarks and mutes. `settings.json`, `last_read` and anything else no 1.x type takes count as `not_migrated` without a read. A File object that cannot be read stops the run with `IO_ERROR`: every blob and post after it depends on it, and would be copied with a wrong extension or media URL that no later run rewrites. A File that reads but that the 0.x reader refuses is only its own skip: it names nothing, so references through it stay as written and a blob only it named migrates as `bin`. The same holds for a File the owner deletes between two runs: copies made before point at `files/{hash}.{ext}`, copies made after at `.bin`, and neither run rewrites the other's. The 0.x reader bounds a TimestampId by the clock, at most two hours ahead, so an object refused for a future id on one run is accepted by a later `rescan` (a finished run's flag stops a plain rerun from walking). A File refused that way has already sent its blob to `bin` and left the references through it as written; the rescan adds the copy under its extension and rewrites neither.
5. For each object whose key is not present: GET, transform, PUT every write whose key is still not present, with `ifAbsent`, then a HEAD of the 0.x object. If the owner deleted it meanwhile, or the HEAD fails, the copies just written are deleted (`deleted_mid_run`, or `io_error` for a copy the next run makes again). A GET that answers 404 is read the same way: the port contract says gone, so a front end that answers 404 for an object it still holds loses that object until a `rescan`. If that cleanup DELETE itself fails, the copy stays: the next run lists the 0.x tree without its source and never revisits it, so an object deleted during its own copy comes back in 1.x. That is a known gap, not an accepted case: it is tracked in [#194](https://github.com/pubky/pubky-social-specs/issues/194), with the lost PUT answer below. A destination someone else wrote since the LIST stays as it is and counts `already_present`; the run deletes only what it wrote. Two objects are in flight at a time, and an object whose write folds to a key the other is writing waits for it, and writes itself if that copy did not land. A blob over `validationLimits.maxFileSizeBytes` skips as `oversize` first. Below the cap a blob still never enters the wasm, since a wasm memory grows to fit what is copied into it and never shrinks: one 100 MB blob handed to `migrate` held that memory for the rest of the run. The engine hashes the bytes it read 4 MiB at a time through the hasher, asks `migrateBlob` where they go, and PUTs that same array; the hash naming the destination is its read-back. Under Node, migrating one 100 MB blob through `MemoryPort` peaked at 748 MB RSS when the bytes went through `migrate` and peaks at 352 MB now, most of it the port's own copies of the blob. Those numbers are Node's; the browser target, a peak RSS under 500 MB for the owner of a 100 MB blob, is measured by the replay harness.
6. Writes the flag `{migrated_at, transform_rev, skipped}`: microseconds, `transformRev`, and the 0.x paths that did not land, by outcome. A walk with any `io_error` writes no flag and ends `incomplete`, so the next run walks again.

The run never modifies the 0.x tree: it writes and deletes only under `pub/social/v1/` and `priv/social/v1/`, and a write the package gives anywhere else rejects the run as a fault before any PUT. `mode: "dry"` reads and counts exactly as a run does and makes no PUT, re-check or DELETE, the flag included. An interrupted run leaves nothing to clean up: run it again and it resumes from what the 1.x tree already holds.

The report is `{status, mode, done, total, counts, dropped, droppedValues, skipped, notes, error?}`:

- `status` is `done`, `already_migrated`, `incomplete` (the walk ended but some objects hit `io_error`; run again), `paused` or `aborted`.
- `counts` has one number per outcome: every `skipReasons` entry, `written`, `already_present`, `deleted_mid_run`, `io_error` and `put_rejected`. A File object that reads counts in `done` only: it writes nothing and feeds the run.
- `skipped` maps each outcome but `written` and `already_present` to its 0.x paths, the same object the flag stores; `notes` carries the detail for some of them, such as the status of a refused PUT.
- `dropped` and `droppedValues` report the values the 1.x rules refused inside an object that still migrated (`profile_image`, `profile_link[i]`), so the host can tell the user.
- `error` is `{code, message, needBytes?, caps?}`. `QUOTA` pauses the run with `needBytes`, the sizes the File objects declare for the blobs the walk has not yet copied or found present; free space or raise the quota, then run again. `needBytes` is left out when no blob is pending. `SESSION_EXPIRED`, `IO_ERROR` (a LIST, a File object or the flag failed), `ALREADY_RUNNING`, `UNSUPPORTED_EPOCH` and `ABORTED` (the signal fired) abort it.

`onProgress` gets `{phase, kind?, done, total, counts, dropped, current?, error?}` after every object and at every phase change; `phase` is `probe`, `listing`, `migrating`, `flag`, `done`, `incomplete`, `paused` or `aborted`, and `kind` names the type being walked.

Three constants go with it. `ENGINE_CAPS`, `/pub/social/v1/:rw,/priv/social/v1/:rw`, is what the engine writes and all it checks `caps` for; reading and listing the 0.x tree is anonymous. `MIGRATION_CAPS` is the full grant a migrating pubky-app holds, `ENGINE_CAPS` plus `/priv/app.pubky/v1/:rw,/pub/pubky.app/:rw`: the app's own private namespace, and the 0.x tree, which deleting a migrated object later still reaches. The engine never checks it; it is what the app asks for when it upgrades a session. `transformRev` (from the package entry, and from `pubky-social-specs/migrationData` without the wasm) is the revision of the transforms; it goes up when a transform changes what it writes. A tree recorded under a lower one is walked again, which picks up the objects an earlier revision skipped; a walk never rewrites a destination that exists.

The engine migrates to `social/v1/` and nowhere else, and refuses to run (`UNSUPPORTED_EPOCH`) in a build whose list prefix names another epoch. With one 0.x epoch and one transform step, the source is always `pub/pubky.app/`; discovering the epochs present and sourcing each object from the highest one is the follow-up the next epoch brings.

### The port

All I/O goes through the port, and every URL is a full `pubky://` URL:

```ts
interface MigrationPort {
  list(prefixUrl: string, cursor?: string): Promise<{ urls: string[]; next?: string }>;
  get(url: string): Promise<Uint8Array | null>;
  head(url: string): Promise<boolean>;
  putJson(url: string, object: unknown, options?: { ifAbsent?: boolean }): Promise<void>;
  putBytes(url: string, bytes: Uint8Array, options?: { ifAbsent?: boolean }): Promise<void>;
  delete(url: string): Promise<void>;
}
```

A LIST is deep and ascending: every URL under the prefix, spelled as the prefix is, after `cursor` when given, with `next` the cursor of the following page and absent on the last; a prefix with nothing under it is an empty page. A LIST answering another spelling stops the run with `IO_ERROR`. A missing object is `null` from `get` and `false` from `head`. The engine passes `ifAbsent: true` on every PUT of a copy: the adapter writes only when nothing is at the URL, and throws `exists` when something is. Where the homeserver has no create-only PUT, that is a HEAD before the PUT, as `sdkPort` does below. Every failure is a thrown `MigrationPortError(kind, message?, status?)`, and the engine branches on `kind`:

| homeserver answer | `kind` | what the run does |
|---|---|---|
| 507 | `quota` | pauses |
| 429 | `rate_limited` | waits 1 s, doubling up to 60 s, and calls again |
| 401, and a 403 other than the one below | `unauthorized` | aborts |
| 404 | `not_found` | a GET counts `deleted_mid_run`; a DELETE ignores it |
| 412 on an `ifAbsent` PUT | `exists` | counts `already_present` |
| 403 naming only `/pub/`, "Writing to directories other than '/pub/' is forbidden", from a homeserver older than `/priv/` | `unsupported` | aborts on the probe |
| no answer at all, or a 5xx other than 507 | `network` | retries three times, then counts `io_error`, and the run ends `incomplete` |
| any other 4xx, 413 included | `rejected`, with `status` | on a PUT counts `put_rejected`; on a GET or HEAD counts `io_error` |

`rejected` is a definitive refusal and lands in the flag like a skip. A server that failed is not refusing: a 5xx must reach the engine as `network`, so the object counts `io_error`, the run ends `incomplete` without a flag, and the next run writes it. `refusal(status, message?)` builds the error for a status as this table maps it; an adapter throws what it returns, and has to decide `unsupported` itself, since only the text of the refusal says the root is missing. A `/priv/` read on a session without the scope is a 401 or a 403, `unauthorized`, and never an absent object: a port that answered it with `null` or `false` would make a refused flag read as a missing one.

Anything else a port throws counts as `network`, a call that never got an answer. `MemoryPort` implements the port over a `Map` for tests: `new MemoryPort({ privSupported, intercept, pageSize })`, where `privSupported: false` plays a homeserver without `/priv/`, refusing every `/priv/` call with that 403, `intercept(op, url)` runs before every call to fail it or to change `store` under the run, and `pageSize` shortens LIST pages.

The retries wait through `sleep(ms, signal)`, a timer that ends early when `signal` aborts unless the host passes its own.

What the host implements: the adapter from its homeserver client to the port, the lock (without one the run is unlocked; in a browser, `navigator.locks` keeps it to one tab), and the UI over `onProgress` and the report. The rest of the migration is the app's too: the capability upgrade when a run returns `CAPS_MISSING`, importing its own `settings.json` and `last_read` into its private namespace, and keeping the last progress snapshot so it can show where an interrupted run stopped.

### Running it from Node

`pubky-social-specs/migration/pubky-sdk` is the port over a session of the pubky SDK, [`@synonymdev/pubky`](https://www.npmjs.com/package/@synonymdev/pubky) `>=0.11 <1`, whose session storage has the same calls and answers across that range. Install that SDK next to this package to use the adapter or the CLI. The package does not declare it as a dependency, so a host pinned to another SDK line still installs the package; the engine never loads the SDK.

```js
import { Pubky, Keypair } from "@synonymdev/pubky";
import { runMigration } from "pubky-social-specs/migration";
import { sdkPort } from "pubky-social-specs/migration/pubky-sdk";

const keypair = Keypair.fromRecoveryFile(recoveryFileBytes, passphrase);
const session = await new Pubky().signer(keypair).signin("my-app");
const report = await runMigration({
  owner: session.info.publicKey.z32(),
  port: sdkPort(session),
  caps: session.info.capabilities,
});
```

`sdkPort(session, { pageSize, deadlineMs })` works in the session owner's tree only: a URL of another pubky, or a LIST prefix that is not a directory, throws `rejected` before any request. A LIST asks for 1000 URLs a page (`pageSize` lowers it) and gives the last URL of any page that has one as `next`, so only an empty page ends the walk, even where a server or a proxy answers fewer URLs than asked. Every read whose cost does not grow with a body (LIST, HEAD, the GET of an object) has a deadline, 60 s unless `deadlineMs` says otherwise: an answer that never comes counts as `network`, so the engine's retry and `io_error` paths take over instead of waiting on a silent socket (Node's own bound is 300 s, a browser's `fetch` has none). A blob's GET grows with its size, and a write stays pending until the SDK settles it: the SDK takes no signal, so a write abandoned at a deadline could still land after a later run cleaned up behind it. A cancellable SDK call is what would let writes have a deadline too. A directory the homeserver does not have is an empty page. An SDK error with a status, its `data.statusCode`, goes through `refusal()` and maps as the table above does, with two additions: a 410 is `not_found`, as the SDK's own `exists` reads it, and a 403 from a homeserver older than `/priv/` refusing the root itself ("Writing to directories other than '/pub/' is forbidden") is `unsupported`. An error with no status maps by its name: `AuthenticationError` is `unauthorized`; `InvalidInput`, `ClientStateError` and `InternalError` are `rejected`; a `RequestError` or anything that is not an SDK error is `network`. A HEAD answer has no body to tell those 403s apart, so a refused HEAD is asked again as a GET, whose body is dropped unread.

`ifAbsent` is check-then-write here. The homeserver ignores `If-None-Match` on a PUT, so the adapter sends a HEAD and then the PUT, and a write another device lands between the two is overwritten. The window is one round trip; within one run the engine never writes a key twice. A PUT whose answer is lost is retried as a HEAD and the PUT, and that HEAD finds the run's own copy, which then counts `already_present`: the race guard does not take it for the run's own, so if the owner deletes the 0.x object in that moment, the copy stays. That case is accepted. The homeserver has WebDAV `LOCK` since 0.13, and `LOCK`, HEAD, PUT with the lock token, `UNLOCK` is a create-only write; the SDK has no call for `LOCK`, so the adapter cannot send one.

The package also ships the CLI `pubky-social-migrate`:

```bash
read -rs PUBKY_PASSPHRASE && export PUBKY_PASSPHRASE
npx -p pubky-social-specs -p @synonymdev/pubky@^0.14 pubky-social-migrate --recovery ./account.pkarr
```

Name both packages to `npx`: a bare `npx pubky-social-migrate` would fetch whatever package holds that name. `read -rs` keeps the passphrase off the screen and out of the shell history. The CLI signs in from the recovery file with the client id `pubky-social-migrate`, taking the passphrase from an environment variable (`--passphrase-env VAR`, `PUBKY_PASSPHRASE` by default) and never from the arguments, where the process list shows it. It refuses an SDK outside `>=0.11 <1`. A failed sign-in gets a hint that fits: a PoP timestamp refusal points at this device's clock, a record that did not resolve at the network, and a refusal of the route at a homeserver older than `/priv/`, since grant sign-in shipped with it. The run holds a root grant; the CLI signs out when the run ends, and the first Ctrl-C or a SIGTERM stops the run after the objects in flight so that sign-out is reached, best effort: a supervisor that kills the process during that wait leaves the grant active until it is revoked from Ring. It signs out when the run ends, so the session's root grant does not outlive the run. It prints a progress line to stderr at every phase and pass and every 50 objects, then the report, as JSON with `--json`. `--dry-run` writes nothing, `--rescan` walks a tree an earlier run finished, and `--testnet [host]` points it at a pubky testnet (`localhost` by default). The first Ctrl-C stops the run after the objects in flight. It exits 0 when the tree is done or already migrated, 2 when the run ended `incomplete` or `paused` and should run again, 3 when it aborted, and 1 on a usage or unexpected error.

### Live test

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

### What a skip means

An object the walk leaves behind is counted under one of `skipReasons`, which the subpath exports with `transformRev`. An object is skipped when the frozen 0.x reader refuses it: `malformed` when the JSON parser cannot read the bytes, `shape` when the reader cannot read them into its model, `invalid` when its rules refuse the object, as they do a stored id they do not accept or a `[DELETED]` post. What migrates is what the reader stored, so a profile named `[DELETED]` becomes the `anonymous` the reader made of it. `not_migrated` is a path with no 1.x counterpart, such as `last_read`, or another owner's path. A blob that skips leaves the references already rewritten to it dangling, so count every skip and report it.

## Reading 0.x data

The frozen 0.x reader is Rust only. This package exposes the 1.x surface and the migration; a JS consumer that has to read un-migrated data as such goes through a Rust service.

## Specification

The 1.x design is in [`docs/rfc-v1-social-specs.md`](https://github.com/pubky/pubky-social-specs/blob/main/docs/rfc-v1-social-specs.md). The legacy 0.x layout is in [`docs/SPEC_V0.md`](https://github.com/pubky/pubky-social-specs/blob/main/docs/SPEC_V0.md), for reading un-migrated data.

## Building from source

The package builds from `pkg/src` with `tsc`. The wasm of the migrator also needs Rust, the `wasm32-unknown-unknown` target and [`wasm-pack`](https://rustwasm.github.io/wasm-pack/).

```bash
cd pkg
npm install
npm run build      # tsc, then the migrator's wasm, into dist/
npm test
npm run types      # the declarations, compiled as a consumer compiles them
npm run size       # bundle size, tree-shaking and cold start
```

How the package is checked against the crate is in [`TESTING.md`](https://github.com/pubky/pubky-social-specs/blob/main/TESTING.md). Releases are cut from a git tag, and a build that is not on npm yet can be installed from an `npm pack` tarball; both are described in [Releasing](https://github.com/pubky/pubky-social-specs#releasing).

## License

MIT
