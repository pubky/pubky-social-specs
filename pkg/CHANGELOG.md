# Changelog

A release makes two promises, and each entry below lists its changes under both.

## What a release promises

**The API**: the functions, types and entries of this package. From 1.0.0 they follow semver:
a minor release adds, a major release may remove or change a signature. Before 1.0.0 a prerelease may
break them, and each break is marked below. `pkg/api/*.d.ts` holds the declarations as agreed,
and CI fails when the build's differ from them. A refusal's message is the crate's, word for
word, wherever the crate has the rule; one changes only when the crate's does, and is then
listed under API.

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

The next release is 1.1.0-alpha.1: the kinds of the 1.1 specs other apps must read, `event`,
`rsvp`, `availability` and `rating`, and the place conventions, on the 1.0 data model, which it
reads and writes as before.

### API

- New: the 1.1 post kinds. `buildPost` takes an `event` (JSCalendar members: `title`, `start`,
  `timeZone`, `duration`, `showWithoutTime`, `status`, `locations`, `attendance`, `links`,
  `recurrenceRules`, `excludedDates`, `recurrenceOf`, `recurrenceId`), an `rsvp` and a `rating`
  (replies to their `parent`) and an `availability` (`timeZone`, `horizonDays`, `for`,
  `available` and `busy` blocks, an available block's `capacity` the units free in it), each told
  apart by `kind`; an event's `links` are `{ title, url }` as a profile's are. `decodeContent` and
  `encodeContent` read and spell their envelopes, `encodeContent` taking the kind as a second
  argument when the members alone do not tell. `postKinds` grows by the four; `eventStatuses`,
  `attendancePolicies`, `rsvpStatuses`, `recurrenceFrequencies` and `weekdays` are the new
  closed sets, with `Known*` types and `OrNewer` forms. The types `EventContent`,
  `EventLocation`, `EventAttendance`, `EventLink`, `RecurrenceRule`, `NthDay`, `RsvpContent`,
  `AvailabilityContent`, `AvailabilityBlock`, `RatingContent`, `DecodedContent`, `Envelope`,
  `EnvelopeKind` and the `New*` inputs of each kind.
- An app's own kinds are its sub-spec's, in the app's own repository, on the same envelope under
  its own namespace, following the conventions in `docs/SUBSPECS.md`.
- New: the place conventions. `geoUri(lat, lon, digits?)` spells a point one way, `isGeoUri`
  reads the spelling back, `osmUrl(object, id)` and `parseOsmUrl(url)` spell and read the
  canonical OpenStreetMap object URL.
- New: `ErrorCode` `range`, a number outside its bounds, with `limit` the bound in the member's
  unit. 30 limits join `limits`, each named by its unit (`eventDurationMaxSeconds`,
  `eventCapacityMaxPeople`, `availabilityCapacityMaxUnits`, `ratingMaxHalfStars`,
  `geoFractionMaxDigits`, ...).
- `validatePost` collects the issues of the new kinds like the others, and with an owner runs
  the rule that an event override's `recurrenceOf` is the same author's post.
- The size budgets of the entries that carry the post rules grew by 5 to 7 KB gzipped, the cost
  of the four kinds; `import { buildUri }` by about 250 bytes, the cost of the longer limits
  table every bundle that reads a limit carries. `pubky-social-migrator`'s wasm grows too, since
  the crate it is compiled from reads every migrated post through the 1.1 reader.

### Stored bytes

These follow the crate, which changes with them:

- The four 1.1 kinds, as `docs/SPEC_V1.1.md` of the crate specifies them: a post of kind
  `event`, `rsvp`, `availability` or `rating` is read by its envelope's rules and
  written back byte for byte, unknown members kept; a 1.0 reader skips it as a kind it does not
  know. Every integer inside is an `i64` within the JSON-safe range; a closed-set member with a
  spelling this version does not know (an event's `status`, a rule's `frequency`) is refused, not
  degraded. In an event's `locations`, a `geo:` URI must be the
  convention's spelling and an OpenStreetMap URL the canonical object URL; `parent`, `embed`,
  tags and collection items keep the 1.0 gate alone.
- `planPublish` refuses a private reference in any envelope position of the new kinds as it
  refused one in a collection item, before the final validation would.
- A 1.1 kind's raw content cap is checked before its envelope is parsed, and for a 1.1 kind
  `planPublish` checks the byte cap, the attachment count and the list caps before it reads a
  reference: an event with a list far past its cap is refused by the cap, where the
  package threw `RangeError: Maximum call stack size exceeded` at about 150,000 items. The
  answers of the 1.0 kinds are unchanged, in validation and in the planner.

## 1.0.0-rc.1

### API

- Breaking: the migration is its own package, `pubky-social-migrator`, released with this one at
  the same version. `pubky-social-specs/migration` is `pubky-social-migrator`,
  `pubky-social-specs/migration/pubky-sdk` is `pubky-social-migrator/pubky-sdk`, and the
  `pubky-social-migrate` CLI moved with them. This package loads no wasm.
- A URL or path argument takes a plain `string`, as the README said and the types did not: an
  entry of a LIST compiles where only a `pubky://` literal or a branded value did.
- New: `decodeObject({ kind, root? }, bytes)` and the same form of `tryDecodeObject`, for bytes
  kept outside the data model's paths; `parsePubkyUrl(url, kind)`; `toUrl(owner, path)`;
  `isOneOf(names, value)`; `ENGINE_CAPS` and `MIGRATION_CAPS` in the main entry.
- `decodeContent` takes the `kind` and `content` of a post alone.
- New: `tryDecodeContent`, `decodeContent` with the refusal returned, for content an indexer
  handed over.
- `./client`: `posts.delete` also answers `mediaGcCandidates`, the own media its versions
  referenced, from `planDelete`. They are left in place.
- `hashMedia` reads a `Blob` that has no `stream()`, as jsdom's has none, through
  `arrayBuffer()`.
- New: the `cards` feed layout, in `feedLayouts`.
- Breaking, `./client`: `posts.delete` and every `remove` answer `{ legacyRefused }`, the 0.x
  paths a session without that grant could not reach, where they answered nothing. A copy left
  there brings the object back on a reindex of 0.x, so the caller is told.
- `./client`: `posts.edit` mints again when the edit id is already used in either root, as
  `posts.create` does for a post id; `posts.head` of another author's private root is refused
  before a server is asked; a LIST answer that is no list of URLs is refused.
- Breaking: a fraction in an integer member given to `encodeObject` is a `ValidationError` with
  the crate's words, as the same value in stored bytes is. It was an `ArgumentError`.
- `Listing`'s tag form is two shapes: with a File object's `src` and `contentType`, or with
  neither.
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
  says to leave it out, and a path that names no object says so. `buildUri` refuses an id its
  kind cannot have as the crate's emitter does (`value cannot be spelled canonically: <uri>`, a
  followee or mutee as a key), and an owner written as a URL or a path passed for a URL gets the
  crate's refusal instead of the package's own hint.
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
  64 MiB reads as none. A copy found at a write's URL is the run's own only when the crate reads
  it, so another writer's copy the crate refuses is never deleted as ours.
- The CLI asks the passphrase on the terminal with echo off, refuses a recovery file others can
  read, and signs out on an uncaught error too.
- New: `feedPaths(id)`, the private and the public address of a feed, and the client's
  `feeds.publish` and `feeds.unpublish`.
- The client's `tags.remove` deletes the tag's 0.x copies too, found by reading the owner's 0.x
  tags, each once per client; `posts.edit` mints above the version that took its edit id, so a
  clock that is not past the head no longer picks the taken id again.
- `encodeObject` at a post version's URL checks the version as `decodeObject` does: a
  TimestampId inside the time bounds, no older than the post.
- The default clock draws the microsecond inside the millisecond at random, so two copies of the
  package rarely mint one id.
- Earlier in this release, breaking: `setClock` moved to `pubky-social-specs/testing`;
  `ProgressEvent.kind` is `pass`; a decoded post's `kind` and a feed's `reach`, `layout` and
  `sort` are narrowed to the names this version knows, never `"unknown"`. Added: `decodeObject(url, bytes, kind)`, `toPath`, `hashMedia`, `ArrayBuffer`
  byte inputs, `ValidationError.reason` and `.field`, a branded `MigrationPortError`.

### Stored bytes

These follow the crate, which changes with them:

- A feed's `layout` may be `cards`, as 0.8.1 clients store it. The migration carries such a
  feed, which it skipped before, and `transform_rev` is 3 so a migrated tree is walked again.
- The frozen 0.x reader was widened once, by that value: it was copied from 0.8.0, and read a
  `cards` feed a released 0.8.1 client stored as invalid. Nothing it accepted before reads
  differently.
- A name from a closed set this version does not know (a feed's `content`, a collection's
  `layout`) is written back with its spelling, and a feed carrying one has its id checked like
  any other.
- Reads: a bare owner URL, `pubky://<pk>`, is no stored object; a post version's id is a valid
  TimestampId no older than the post; a stored object's byte cap holds its bytes as stored, not
  the form a reader fills defaults into, a feed's filter included; a double is read correctly
  rounded.
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
