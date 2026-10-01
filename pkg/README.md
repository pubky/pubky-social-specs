# pubky-social-specs

[![npm version](https://img.shields.io/npm/v/pubky-social-specs)](https://www.npmjs.com/package/pubky-social-specs)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

JavaScript and TypeScript bindings for Pubky social data models, compiled from the canonical Rust crate to WebAssembly.

Every export is a plain function over plain objects. Nothing runs when the package is imported: `await init()` once, and every call after that is synchronous. The ESM (`import`) and CommonJS (`require`) entries each hold their own wasm instance, so each needs its own `init()`.

## Why Use This Package Instead of Manual JSONs?

- **Validation Consistency**: the same validation rules as [Pubky indexers](https://github.com/pubky/pubky-nexus), from the same code. Builders trim and fold what you pass them; readers take stored objects exactly as written and reject what breaks a rule, never rewriting it.
- **Ids, Paths and URLs**: generated the way every other client generates them.
- **Unknown members kept**: an object read and written back keeps the members this version does not know.
- **Typed**: `types.d.ts` declares every object and every function.

## Installation

```bash
npm install pubky-social-specs
```

## Quick Start

```js
import { init, createUser, createPost } from "pubky-social-specs";

await init(); // loads the wasm; every other export throws until it resolves

const owner = "8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto";

const user = createUser(owner, { name: "Alice", bio: "Building on Pubky" });
console.log(user.meta.url); // pubky://.../pub/social/v1/profile.json
// PUT JSON.stringify(user.object) at user.meta.url with your pubky client

const post = createPost(owner, { content: "Hello, Pubky!" });
console.log(post.meta.path); // /pub/social/v1/posts/{id}/{id}.json
```

Every builder takes the writing user first and returns `{object, meta}`:

- `object` is the stored object exactly as it is written: `JSON.stringify(object)` is the body to PUT. Media is `{bytes: Uint8Array}`.
- `meta` is `{id, path, url}`: the generated id (`""` for the profile), the owner-relative `path`, and the full `pubky://` `url`.

Every rejection is a thrown `Error` whose message starts with `Validation Error: `, the crate's own text for the value the rules refuse, whatever the entry point. Ill-formed UTF-16 (a lone surrogate) is refused: a string argument before it reaches the wasm, with `Validation Error: text must be well-formed UTF-16`, and a string inside an object by the JSON parser, since objects cross as `JSON.stringify` text.

## Builders

```js
createUser(owner, { name, bio?, image?, links?: [{ title, url }], status? });
createPost(owner, { content, kind?, parent?, embed?, attachments?: [{ uri, alt?, name? }], lock?, root? }); // kind defaults to "note"
createArticlePost(owner, { title, body, coverImage?, parent?, embed?, attachments?, lock?, root? });
createCollectionPost(owner, { name, description?, items?: [{ uri, note? }], coverImage?, layout?, root? });
createFeed(owner, { tags?, domainTags?, reach, layout, sort, content?, name, icon });
createTag(owner, uri, label);
createBookmark(owner, target);
createFollow(owner, followee);
createMute(owner, mutee);
createFile(owner, bytes, declaredType, root?); // bytes: Uint8Array
```

`root` is `"public"` (the default) or `"private"`, the same words `parseUri` reports as `visibility`; the path spells them `pub` and `priv`. A post under `"private"` is a draft, and only a draft may reference the owner's private media.

Every optional input member takes `null` or `undefined` for absent. An input member the builder does not know is an error, so a misspelled option never goes missing silently. So is an argument of the wrong type, and an object with no JSON form (one that refers to itself).

`createUser` stores `image` and every `links[].url` as written, so they must already be canonical: an image is a `pubky://`, `http://` or `https://` URI, a link url is `http://` or `https://`, and surrounding whitespace or the short `pubky<pk>` form rejects. The builder trims `name`, `bio`, `status` and every link title; a blank `bio` or `status` is left out. A stored profile is never rewritten on read, padding included, and `validate` does not trim either: it refuses a blank `bio` or `status`, so an edit path maps blank to `null` itself.

`parent` and `embed` are any URI (`pubky://`, `https://`, `nostr:`, `geo:`, ...), stored exactly as written; a thread can be rooted at a post, a user or an external resource. A post reference is always versionless (`.../posts/{id}`, never a version file). `createPost` trims `content`; `readObject` reads it as stored, so content that is only whitespace rejects unless the post has an embed or attachments. The stored post always carries `attachments`, `[]` when empty. The builder trims an attachment `name`; after that it is stored and counted as written.

`createArticlePost` and `createCollectionPost` write their envelope into `content` as JSON: `{title, body, cover_image?}` and `{name, description?, items: [{uri, note?}], cover_image?, layout?}`. A collection item can point anywhere (a post, a user, a web page, a `nostr:` event) and its note is optional but never blank. The builder trims the collection `name`, its `description` and each item `note`, leaving a blank description or note out; a stored description that is empty or whitespace-only rejects. A collection takes no parent, embed or attachments.

`createTag(owner, uri, label)` stores the uri as written, so it must already be canonical; the builder trims and ASCII-lowercases the label.

`createBookmark(owner, target)` puts the target in the filename: `meta.id` is the canonical target in unpadded base64url and the path is `/priv/social/v1/bookmarks/{filename}.json`, so listing every bookmark is one LIST with no GETs, and one target always lands on one filename. A target over 187 UTF-8 bytes overflows: the filename becomes `~{hash}` and the object carries `target`. `bookmarkTarget(filename, object?)` reads an entry back and throws when it breaks those rules, which is how a reader tells an invalid entry from one to show. The object is needed only for a `~` overflow filename, so a primary entry reads from the LIST alone, with no GET. `bookmarkFilename(target)` gives the filename without building an object.

`createFile` stores the bytes as they are: `meta.id` is the hash of the bytes and the path is `files/{hash}.{ext}`, the extension coming from the declared type. The declared type is read once, here, and never stored. Pass `"private"` as `root` for a draft's media. The 0.x File metadata object and its Blob are gone: this one call makes the one media object.

Feeds are private by default: `createFeed` writes under `/priv/`. The id is derived from the filter alone, so `tags` and `domainTags` are folded, deduplicated and sorted by the builder, and editing the filter gives a new id: `feedId(feed)` derives it from an edited object, so the object keeps its unknown members. `icon` is required, a [Lucide](https://lucide.dev/icons) icon name (at most 50 chars of `a-z`, `0-9`, `-`). `feedPaths(id)` gives `{private, public}` and `feedLifecycle(id)` gives `{publish: {from, to}, unpublish: [...], delete: [...]}`: run each in the order given; a delete of a missing path is a skip, and the publish copy always runs because the name and icon live outside the id.

## Reading and Editing

```js
import { readObject, validate } from "pubky-social-specs";

const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
const { kind, object } = readObject(url, bytes); // kind: "user" | "post" | ... | "file"

object.status = "away";
validate(url, object); // throws when the edit broke a rule
// PUT JSON.stringify(object) back at url
```

The interfaces in `types.d.ts` list the known members only, so a misspelled field does not compile; unknown members still survive at runtime through read, edit, `validate` and PUT (widen with `& Extra` to reach them). `validate` checks exactly what `JSON.stringify(object)` gives, the bytes a PUT sends. `readObject(uri, bytes)` reads whatever is stored at `uri`, validated against the id, the root and the author the URI names, and returns `{kind, object}`; TypeScript narrows `object` on `kind`. Media comes back as `{kind: "file", object: {bytes}}`. Edit a stored object this way, GET, `readObject`, change the fields, `validate`, PUT: the object keeps every member this version does not know. Rebuilding it through a builder would drop them.

## Posts: Drafts, Versions and the Lifecycle

```js
const version = createVersion(owner, post, { root: "private", slug: "my-draft" }); // {id, editId, path, url}
const edit = editVersion(owner, post, { id: version.id, head: version.editId, root: "private" });

const plan = planPublish(owner, version.id, version.editId, post);
// copy each of plan.mediaCopies ([from, to]) first, then PUT plan.rewrittenPost at plan.destPath

planUnpublish(postId, publicPaths, legacyPaths, privateHeadPath); // {copyBacks, deletes}
planDelete(owner, postId, legacyPaths, [{ root, path }], versions); // {deletes, mediaGcCandidates}
```

`root` defaults to `"public"` in the options too. Editing a post keeps its id and writes a new version above the newest one:

```js
const dir = `/pub/social/v1/posts/${postId}/`;
const newest = (await list(dir)) // LIST, owner-relative paths
  .map((path) => parseUri(`pubky://${owner}${path}`).resource)
  .filter((r) => r.kind === "post" && r.version)
  .map((r) => r.version)
  .sort()
  .at(-1);
const url = `pubky://${owner}${dir}${newest}.json`;
const { object: post } = readObject(url, await get(url));
post.content = "edited";
const next = editVersion(owner, post, { id: postId, head: newest });
validate(next.url, post);
// PUT JSON.stringify(post) at next.url
```

The planners do no I/O: they take the paths the caller listed and return the operations in the order to run them.

`deletionPaths({kind, id, listings})` names every stored copy of one object, legacy first. Every public kind spans the epochs, because on resync the highest understood epoch with a surviving copy wins and a surviving legacy copy would bring the object back: a post across both roots and the legacy epoch, a file across both roots plus the legacy `blobs/` bytes and the v0 File objects the caller lists, a tag plus the v0 tags the caller lists, the profile and a follow plus their legacy path. A feed is its two v1 copies; a mute and a bookmark are their one private path.

A listing is a path, spelled exactly as its epoch writes it, except for the two legacy copies whose path cannot name the object: a v0 File object is `{path, src}`, and it counts only when its stored `src` resolves to this file's bytes; a v0 tag is `{path, uri, label, src?, contentType?}`, and its path must be the 0.x id of its stored `uri` and `label` while that target and label, respelled as v1 writes them, must derive the v1 id being deleted; a v0 tag on a v0 File object also carries that object's `src` and `content_type`, which spell the v1 media file the tag targets. Every entry is tied to the object being deleted; anything else throws, naming the entry.

## URIs

```js
import { parseUri, stableId, resolveDeref, listPrefix, postUriBuilder } from "pubky-social-specs";

parseUri(postUriBuilder(owner, "0033SSE3B1FQ0"));
// { userId, visibility: "public", resource: { kind: "post", id: "0033SSE3B1FQ0" }, path: "/pub/social/v1/posts/0033SSE3B1FQ0" }

stableId("pub/pubky.app/posts/0033SSE3B1FQ0"); // { kind: "key", key: "posts/0033SSE3B1FQ0" }
listPrefix(owner, "private"); // "pubky://.../priv/social/v1/", a LIST prefix, not a URI
legacyListPrefix(owner); // "pubky://.../pub/pubky.app/", the 0.x tree an account delete or export walks
```

`parseUri` reports paths under another namespace, an epoch this version does not speak, and anything else as `foreign`, `unsupportedVersion` and `unknown` kinds; it throws only on a string that is not a canonical `pubky://` URI. `stableId` keys every epoch spelling of one object together, or returns `{kind: "needsDeref", tsid}` for a legacy media reference that `resolveDeref(tsid, src)` completes from its v0 File object.

The URI builders check the owner key and throw on a malformed one. They are `userUriBuilder`, `postUriBuilder`, `followUriBuilder`, `muteUriBuilder`, `bookmarkUriBuilder`, `tagUriBuilder`, `fileUriBuilder` (the whole `{hash}.{ext}` filename) and `feedUriBuilder`.

## MIME Types

```js
import { validMimeTypes, mimeToExt, essence, mimeToExtTable } from "pubky-social-specs";

const accept = validMimeTypes.join(","); // a picker hint only; it gates nothing
mimeToExt("IMAGE/PNG; charset=x"); // "png", and "bin" for anything unmapped
essence("IMAGE/PNG; charset=x"); // "image/png", null when malformed
mimeToExtTable["image/png"]; // "png", from the whole frozen map
```

`validMimeTypes` and `mimeToExtTable` are frozen data, readable before `init()`, and also published without the wasm as `pubky-social-specs/mimeTypes`.

## Validation Limits

`validationLimits` is a frozen plain object, readable before `init()`:

```js
import { validationLimits } from "pubky-social-specs";

validationLimits.userNameMaxLength;
```

The same values are published without the wasm at all. Under Node's ESM loader (and TypeScript's `nodenext`), a JSON import needs its attribute:

```js
import { validationLimits } from "pubky-social-specs/validationLimits";
import limitsJson from "pubky-social-specs/validationLimits.json" with { type: "json" };
```

## Migration

The package carries the whole 0.x to 1.x migration: the transforms, compiled into the same wasm, and the engine that walks a tree with them, published as `pubky-social-specs/migration`. The engine uses no browser or Node global, so the same code runs in pubky-app, in a standalone web tool, and under Node for a CLI or a server run. Under Node, `pubky-social-specs/migration/pubky-sdk` is the port over a pubky SDK session and `pubky-social-migrate` runs the whole migration from a terminal (see [Running it from Node](#running-it-from-node)).

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

`runMigration` calls `init()` itself. It resolves with a report in every case; only a programming error (an owner that is not a pubky, an unknown `mode`, a fault inside the package) rejects.

What a run does, in order:

1. With `caps` given, checks that the session covers `ENGINE_CAPS`, before any request, and aborts with `CAPS_MISSING` otherwise, the scopes to ask for in `error.caps`. A session that holds only the 0.x scope hears about its caps first. The engine never prompts.
2. Probes the private root by a HEAD of `priv/social/v1/_migrated.json`. A homeserver without `/priv/`, where the HEAD throws `unsupported`, aborts the run with `PRIV_UNSUPPORTED` and a message saying so: the private types and the flag live there. Any other failure of the probe aborts with `IO_ERROR`. When the flag records a `transform_rev` equal to or above `transformRev`, the run returns `already_migrated` without listing anything, unless `rescan: true`.
3. Lists `pub/social/v1/` and `priv/social/v1/` and keys every path through `stableId`. That set is the journal: a key present in either root is never written again, so a post unpublished to a draft is not copied back to the public root, and an edit made after an earlier run survives. Media is the exception: it counts as present by its exact URL, since a private copy, or one under another extension, does not serve the public references the run writes. So every blob is read and migrated, and the write it gives is what gets checked.
4. Lists `pub/pubky.app/` and walks it by type: the File objects first, since the run reads them to rewrite media references, then blobs, posts, tags, follows, the profile, feeds, bookmarks and mutes. `settings.json`, `last_read` and anything else no 1.x type takes count as `not_migrated` without a read. A File object that cannot be read stops the run with `IO_ERROR`: every blob and post after it depends on it, and would be copied with a wrong extension or media URL that no later run rewrites. A File that reads but that the 0.x reader refuses is only its own skip: it names nothing, so references through it stay as written and a blob only it named migrates as `bin`. The 0.x reader bounds a TimestampId by the clock, at most two hours ahead, so an object refused for a future id on one run is accepted by a later `rescan` (a finished run's flag stops a plain rerun from walking). A File refused that way has already sent its blob to `bin` and left the references through it as written; the rescan adds the copy under its extension and rewrites neither.
5. For each object whose key is not present: GET, `migrate`, PUT every write whose key is still not present, with `ifAbsent`, then a HEAD of the 0.x object. If the owner deleted it meanwhile, or the HEAD fails, the copies just written are deleted (`deleted_mid_run`, or `io_error` for a copy the next run makes again). A destination someone else wrote since the LIST stays as it is and counts `already_present`; the run deletes only what it wrote. Two objects are in flight at a time, and an object whose write folds to a key the other is writing waits for it, and writes itself if that copy did not land. A blob over `validationLimits.maxFileSizeBytes` skips as `oversize` first. Below the cap a blob still never enters the wasm, since a wasm memory grows to fit what is copied into it and never shrinks: one 100 MB blob handed to `migrate` held that memory for the rest of the run. The engine hashes the bytes it read 4 MiB at a time through the hasher, asks `migrateBlob` where they go, and PUTs that same array; the hash naming the destination is its read-back. Under Node, migrating one 100 MB blob through `MemoryPort` peaked at 748 MB RSS when the bytes went through `migrate` and peaks at 352 MB now, most of it the port's own copies of the blob. Those numbers are Node's; the browser target, a peak RSS under 500 MB for the owner of a 100 MB blob, is measured by the replay harness.
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

`sdkPort(session, { pageSize, deadlineMs })` works in the session owner's tree only: a URL of another pubky, or a LIST prefix that is not a directory, throws `rejected` before any request. A LIST asks for 1000 URLs a page (`pageSize` lowers it) and gives the last URL of any page that has one as `next`, so only an empty page ends the walk, even where a server or a proxy answers fewer URLs than asked. Every call has a deadline, 60 s unless `deadlineMs` says otherwise: an answer that never comes counts as `network`, so the engine's retry and `io_error` paths take over instead of waiting on a silent socket (Node's own bound is 300 s, a browser's `fetch` has none). The SDK takes no signal, so the stalled call itself runs on. A directory the homeserver does not have is an empty page. An SDK error with a status, its `data.statusCode`, goes through `refusal()` and maps as the table above does, with two additions: a 410 is `not_found`, as the SDK's own `exists` reads it, and a 403 from a homeserver older than `/priv/` refusing the root itself ("Writing to directories other than '/pub/' is forbidden") is `unsupported`. An error with no status maps by its name: `AuthenticationError` is `unauthorized`; `InvalidInput`, `ClientStateError` and `InternalError` are `rejected`; a `RequestError` or anything that is not an SDK error is `network`. A HEAD answer has no body to tell those 403s apart, so a refused HEAD is asked again as a GET, whose body is dropped unread.

`ifAbsent` is check-then-write here. The homeserver ignores `If-None-Match` on a PUT, so the adapter sends a HEAD and then the PUT, and a write another device lands between the two is overwritten. The window is one round trip; within one run the engine never writes a key twice. A PUT whose answer is lost is retried as a HEAD and the PUT, and that HEAD finds the run's own copy, which then counts `already_present`: the race guard does not take it for the run's own, so if the owner deletes the 0.x object in that moment, the copy stays. That case is accepted. The homeserver has WebDAV `LOCK` since 0.13, and `LOCK`, HEAD, PUT with the lock token, `UNLOCK` is a create-only write; the SDK has no call for `LOCK`, so the adapter cannot send one.

The package also ships the CLI `pubky-social-migrate`:

```bash
read -rs PUBKY_PASSPHRASE && export PUBKY_PASSPHRASE
npx -p pubky-social-specs -p @synonymdev/pubky@^0.14 pubky-social-migrate --recovery ./account.pkarr
```

Name both packages to `npx`: a bare `npx pubky-social-migrate` would fetch whatever package holds that name. `read -rs` keeps the passphrase off the screen and out of the shell history. The CLI signs in from the recovery file with the client id `pubky-social-migrate`, taking the passphrase from an environment variable (`--passphrase-env VAR`, `PUBKY_PASSPHRASE` by default) and never from the arguments, where the process list shows it. It refuses an SDK outside `>=0.11 <1`, and a failed sign-in says the homeserver is probably older than `/priv/`, since grant sign-in shipped with it. It signs out when the run ends, so the session's root grant does not outlive the run. It prints a progress line to stderr at every phase and pass and every 50 objects, then the report, as JSON with `--json`. `--dry-run` writes nothing, `--rescan` walks a tree an earlier run finished, and `--testnet [host]` points it at a pubky testnet (`localhost` by default). The first Ctrl-C stops the run after the objects in flight. It exits 0 when the tree is done or already migrated, 2 when the run ended `incomplete` or `paused` and should run again, 3 when it aborted, and 1 on a usage or unexpected error.

### Live test

`npm run e2e` runs the migration against a pubky testnet; `npm test` does not. It signs up a fresh account on the testnet homeserver, writes the 0.x tree of the semantic vectors through the SDK, and migrates it with `sdkPort`. Then it checks the report against a `MemoryPort` run over the same bytes, reads every write back from the server through `readObject`, expects a second run to return `already_migrated` and the 0.x tree to be byte for byte unchanged, and runs the CLI from a recovery file. The testnet listens on fixed ports at `PUBKY_TESTNET_HOST`, `localhost` by default. With Docker:

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

### The transforms on their own

`runMigration` is built on exports a host can also call directly. `createMigration(owner)` returns a run handle and `migrate(run, path, bytes)` migrates one stored object, by its owner-relative path (`pub/pubky.app/...`) or the full `pubky://` URL a LIST returns. It returns `{writes, dropped}` or `{skip, note?}`, where `note` is what the refusing parser or reader said and the engine puts it in the flag. Each write is `{kind, object, meta}`: the object as `readObject` reads it (media as `{bytes}`) and `meta` as a builder gives it, so `validate(meta.url, object)` already holds and the PUT is `kind === "file" ? object.bytes : JSON.stringify(object)` at `meta.url`. A 0.x File object writes nothing: its name, blob and content type feed the run, so every File has to go through `migrate` before the posts, tags and profile that reference them. A reference the run cannot resolve stays as written, since the legacy URI keeps resolving.

A blob has a second door that keeps its bytes out of the wasm: `migrateBlob(run, path, size, hash)` takes their length and their media id, and gives the same result `migrate` gives for those bytes at that blob path, except that the write is `{kind: "file", meta}` and the caller PUTs its own bytes at `meta.url`. The id comes from the hasher, which copies in one chunk at a time: `hasherNew()`, then `hasherUpdate(hasher, chunk)` for every chunk in order, then `hasherFinish(hasher)`, which consumes the handle and returns what `createFile` would give as `meta.id`. Bytes that do not hash to the blob's id, or no bytes at all, skip as `invalid`, as they do through `migrate`.

`skip` is one of `skipReasons`, frozen data readable before `init()`. An object is skipped when the frozen 0.x reader refuses it: `malformed` when the JSON parser cannot read the bytes, `shape` when the reader cannot read them into its model, `invalid` when its rules refuse the object, as they do a stored id they do not accept or a `[DELETED]` post. What migrates is what the reader stored, so a profile named `[DELETED]` becomes the `anonymous` the reader made of it. `not_migrated` is a path with no 1.x counterpart, such as `last_read`, or another owner's path. A blob that skips leaves the references already rewritten to it dangling, so count every skip and report it.

The handle holds the run's memory in the wasm: call `free()` when the run ends (a handle that is garbage collected is freed too, through the glue's `FinalizationRegistry`). It works only with the entry that made it, since the ESM and CommonJS entries hold separate instances.

## Reading 0.x data

The frozen 0.x reader (`legacy_v0`) is Rust only. This package exposes the 1.x surface and the migration; a JS consumer that has to read un-migrated data as such goes through a Rust service.

## Specification

The 1.x design is in [`docs/rfc-v1-social-specs.md`](https://github.com/pubky/pubky-social-specs/blob/main/docs/rfc-v1-social-specs.md). The legacy 0.x layout is in [`docs/SPEC_V0.md`](https://github.com/pubky/pubky-social-specs/blob/main/docs/SPEC_V0.md), for reading un-migrated data.

## Building from Source

Prerequisites: Rust, the `wasm32-unknown-unknown` target, [`wasm-pack`](https://rustwasm.github.io/wasm-pack/), and Node.js.

```bash
rustup target add wasm32-unknown-unknown

cd pkg
npm install
npm run build
npm run test
npm run example
```

Releases are cut from a git tag, and a build that is not on npm yet can be installed from an `npm pack` tarball. Both are described in [Releasing](https://github.com/pubky/pubky-social-specs#releasing).

## License

MIT
