# Changelog

A release makes two promises, and each entry below lists its changes under both.

## What a release promises

**The API**: the functions, types and entries of this package. From 1.0.0 they follow semver:
a minor release adds, a major release may remove or change a signature. Before 1.0.0 a prerelease may
break them, and each break is marked below. `pkg/api/*.d.ts` holds the declarations as agreed,
and CI fails when the build's differ from them. A refusal's message is the crate's, word for
word; one changes only when the crate's does, and is then listed under API.

**The stored bytes**: the paths, the ids and the bytes a builder writes and a reader takes. They
follow the data model of the `pubky-social-specs` crate, not this package's version. Within the
1.x data model every release reads what any earlier 1.x release wrote and derives every id the
same way, so an object keeps its path. An object read and written back untouched keeps its
bytes, the members a newer writer added and the names from a closed set this version does not
know included. A change to the stored bytes is a change of the crate first and comes with a
migration where stored data is affected. The migration flag (`priv/social/v1/_migrated.json`)
records `transform_rev`, so a release whose transforms write differently walks a migrated tree
again.

## Unreleased

### API

- Breaking: `editPost(owner, headUrl, post, options?)` takes the owner first, as the builders do,
  and refuses a head in another user's tree.
- Breaking: a string of the right type that the model refuses is a `ValidationError`: a `root`,
  `tree` or `kind` outside its set, and a path passed where a URL goes. A wrong JS type or an
  unknown key is an `ArgumentError`, a new `TypeError` subclass with `field`.
- Breaking: `ValidationError` carries `code` (an `ErrorCode`: `json`, `size`, `length`,
  `count`, `blank`, `format`, `id`, `reference`, `unknown_name`, `unsafe_integer`, `path`,
  `conflict`, `migration`), `limit` on a `size`, `length` or `count` refusal, and `field` wherever
  one member or argument is at fault. Validator issues carry the same `code` and `limit`.
- Breaking: the object types close their other arms (`title?: never` on a note input, `bytes` and
  `id` exclusive on a file input), `encodeObject` ties the object to the kind it is encoded as,
  and `listPrefix` returns a `ListPrefix`, which no decode takes.
- Breaking: an unknown post kind or collection layout is a string, kept as read; the
  `"unknown"` placeholder is gone, and `FeedConfig.content` and `CollectionContent.layout` are
  `OrNewer<...>`.
- New: `isPubkyUrl`, `tryDecodeObject`, `idMicros`, `microsToDate`, `dateToMicros`;
  `planPublish` takes the private version's `slug` and keeps it on the public leaf.
- New: outside production, a warning when an encoded `created_at` reads as milliseconds.
- Messages: the crate words a few refusals anew, the same in both: lengths say their bounds
  (`name must be 3 to 50 code points`), a range is `1 to 64`, not `1..=64`, an empty filter list
  says to leave it out, and a path that names no object says so.
- A caller's array past 10,000 items is refused before it is walked, and bytes in shared memory
  are copied before they are read.
- Packaging: TypeScript below 5.7 fails to compile against the package instead of reading its
  types as `any`; node10 resolution finds every subpath's types; `exactOptionalPropertyTypes`
  consumers pass a DOM `Blob` and an SDK session; the migration has a `workerd` glue that takes a
  module compiled at deploy time; `engines` excludes the Node 22 releases that need a flag for
  `require()` of ESM.
- The default clock's reading never steps back inside a millisecond, so `created_at` keeps its
  order.
- Decoding is linear in the input whatever its shape, nesting at the depth limit included.

- Breaking: places and ids are branded types (`Owner`, `PostId`, `EditId`, `MediaId`,
  `PubkyUrl<K>`, `OwnerPath`, `PostRef`). The URL of a post version passed as a reference, an
  `editId` passed as a post id, or a path passed as a URL no longer compiles; plain strings still
  pass. `parseOwner`, `parsePostId`, `parseEditId`, `parseMediaId`, `parsePubkyUrl`,
  `parseOwnerPath` and `parsePostRef` brand a string where it enters.
- Breaking: `buildUri(owner, "post", id)` returns `PostRef`; `listPrefix` returns a plain
  `pubky://` string, since a prefix is no object's URL.
- Every argument is copied once on entry, own members only: a getter or a Proxy is read once.
- New: `validateUser`, `validatePost`, `validateFeed`, `validateTag` collect every issue of an
  input, with `path`, `code` and `message`; `userSchema`, `postSchema`, `feedSchema`,
  `tagSchema` are the same as Standard Schema objects.
- New: `pubky-social-specs/client`, a client over an SDK session: posts, profile, follows, mutes,
  tags, bookmarks, feeds and files, decode errors returned as values.
- New: `fakeOwner`, `samplePost`, `sampleUser`, `sampleFeed` in `pubky-social-specs/testing`.
- New: outside production, a warning when an object read with `$unknown` members is written back
  without them.
- The migration loads its wasm from a file beside the module under Node (the `node` condition of
  the package's `#glue` import) and from the module itself elsewhere, and checks its SHA-256
  before compiling it.
- The migration engine spells each write URL from the write's kind and id and refuses a
  transform that names another; a LIST past about a million objects aborts, and a flag over
  64 MiB reads as none.
- The CLI asks the passphrase on the terminal with echo off, refuses a recovery file others can
  read, and signs out on an uncaught error too.
- The default clock draws the microsecond inside the millisecond at random, so two copies of the
  package rarely mint one id.
- Earlier in this release, breaking: `setClock` moved to `pubky-social-specs/testing`;
  `ProgressEvent.kind` is `pass`; a decoded post's `kind` and a feed's `reach`, `layout` and
  `sort` are narrowed to the names this version knows, never `"unknown"`. Added: `decodeObject(url, bytes, kind)`, `toPath`, `hashMedia`, `ArrayBuffer`
  byte inputs, `ValidationError.reason` and `.field`, a branded `MigrationPortError`.

### Stored bytes

These follow the crate, which changes with them:

- A name from a closed set this version does not know (a feed's `content`, a collection's
  `layout`) is written back with its spelling, and a feed carrying one has its id checked like
  any other.
- Reads: a bare owner URL, `pubky://<pk>`, is no stored object; a post version's id is a valid
  TimestampId no older than the post; a stored object's byte cap holds its bytes as stored, not
  the form a reader fills defaults into; a double is read correctly rounded.
- Rules: a list is refused by its count before any of its items is read, so a long list of bad
  items reports its count; a web reference needs a non-empty host; a 0.x key is read from the
  public 0.x tree only.
- An edit whose head leaves less than a minute below the future bound is refused, so two
  different edits never share a path.
- `deletionPaths` for a mute returns its 0.x copy first.
- `planPublish` keeps the slug and writes the envelope with its members in the kind's order.

### Where this release starts

The native TypeScript implementation of the 1.x data model, with the crate's migration compiled
to wasm under `pubky-social-specs/migration`. See `MIGRATION.md` for the 0.x to 1.x path.
