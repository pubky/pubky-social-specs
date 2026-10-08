# Changelog

A release makes two promises, and each entry below lists its changes under both.

## What a release promises

**The API**: the functions, types and entries of this package. From 1.0.0 they follow semver:
a minor release adds, a major release may remove or change a signature. Before 1.0.0 a beta may
break them, and each break is marked below. `pkg/api/*.d.ts` holds the declarations as agreed,
and CI fails when the build's differ from them. A refusal's message is the crate's, word for
word; one changes only when the crate's does, and is then listed under API.

**The stored bytes**: the paths, the ids and the bytes a builder writes and a reader takes. They
follow the data model of the `pubky-social-specs` crate, not this package's version. Within the
1.x data model every release reads what any earlier 1.x release wrote and derives every id the
same way, so an object keeps its path. An object read and written back untouched keeps its
bytes, the members a newer writer added included, with one exception the crate shares: a name
from a closed set this version does not know reads as `"unknown"` and is written back so. That
is a feed's `content` filter, and a collection's `layout` once its envelope goes through
`encodeContent`. A change to the stored bytes is a change of the crate first and comes with a
migration where stored data is affected. The migration flag (`priv/social/v1/_migrated.json`)
records `transform_rev`, so a release whose transforms write differently walks a migrated tree
again.

## Unreleased (1.0.0-beta.2)

### API

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

No change.

## 1.0.0-beta.1

The native TypeScript implementation of the 1.x data model, with the crate's migration compiled
to wasm under `pubky-social-specs/migration`. See `MIGRATION.md` for the 0.x to 1.x path.
