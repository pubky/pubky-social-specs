# Changelog

A release makes two promises, and each entry below lists its changes under both. This changelog
also covers the `pubky-social-specs` crate on crates.io; an entry that starts with "Crate:" is a
change to its Rust API.

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

### API

- New: a feed's `target`, one of `feedTargets` (`posts`, `resources`), in `buildFeed`'s input and
  on the stored `FeedConfig`, with the types `FeedTarget` and `KnownFeedTarget`. A decoded feed
  carries `target: null` when it stores none; a stored `"posts"` decodes as `"posts"` and has the
  same id.
- New: a resources feed's `content` is a list of up to 10 schema.org type names, comma-separated
  (`MusicAlbum,MusicRecording`), or null for every type. `buildFeed` takes one there with
  `target: "resources"` and stores it deduplicated and sorted, and `feedResourceTypes(feed)` reads
  it back as an array. New limits `feedResourceTypesMaxCount` (10) and `feedResourceTypeMaxLength`
  (64).
- New: a resources feed's search `filters`, in `buildFeed`'s input (`NewFeedFilters`) and on the
  stored `FeedConfig` (`FeedFilters`, null for none), every value a string: `when`, `from`, `to`,
  `near`, `radius`, `place`, `category`, `host`, `key`, `remote`, `closed`, `ingredients`, `sort`,
  `window`, `rows` and `exclude_types`. The README says what each one means. The builder sorts and
  deduplicates the hosts, the ingredients and the excluded types, and stores no empty set. New
  limits `feedFilterHostsMaxCount` (10), `feedFilterIngredientsMaxCount` (3),
  `feedFilterIngredientMaxLength` (64), `feedFilterRadiusMaxKm` (200), `feedFilterPlaceMaxLength`
  (120), `feedFilterTextMaxBytes` (256) and `feedFilterExcludeTypesMaxCount` (50).
- New refusals:
  - on a read: `feed target is unknown` (`unknown_name`, field `target`); `Feed resource type '…'
    is not a schema.org type name` and `Feed resource types must be stored deduplicated and sorted
    by code point` (`format`, field `content`); `A resources feed's filters must not be empty;
    leave them out for none` (`blank`, field `filters`); `Resource feed filter host must be stored
    deduplicated and sorted by code point` (`format`, field `filters.host`), and the same for
    `ingredients` and `exclude_types`;
  - from the builder: `Invalid feed target: …` (`unknown_name`, field `target`) and `Invalid
    resource type: …` (`format`, field `content`);
  - on a read and from the builder: `A resources feed cannot list more than 10 types` (`count`,
    field `content`); `Feed resource type names cannot be longer than 64 characters` (`length`,
    field `content`); `A resources feed cannot filter by domain_tags` (`conflict`, field
    `domain_tags`); `Only a resources feed has filters` (`conflict`, field `filters`); `A resources
    feed's filters hold a member this version does not know` (`unknown_name`, field `filters`);
    `Resource feed filter … is not valid` (`format`, field `filters.…`, among them a `radius`
    outside 1 to 200, with no `limit`); `Resource feed filters when and from or to cannot go
    together` and `Resource feed filters radius and place need near` (`conflict`, field `filters`);
    `Resource feed filter from is after to`, `Resource feed filter sort nearest needs near` and
    `Resource feed filter window needs sort trending` (`conflict`, fields `filters.from`,
    `filters.sort`, `filters.window`); `Resource feed filter place cannot be longer than 120
    characters`, `Resource feed filter ingredients cannot be longer than 64 characters each` and
    `Resource feed filter exclude_types cannot be longer than 64 characters each` (`length`, fields
    `filters.place`, `filters.ingredients`, `filters.exclude_types`); `Resource feed filter
    category cannot be longer than 256 bytes` and `Resource feed filter key cannot be longer than
    256 bytes` (`size`, fields `filters.category`, `filters.key`); `A resources feed cannot filter
    by more than 10 hosts`, `A resources feed cannot filter by more than 3 ingredients` and
    `Resource feed filter exclude_types cannot name more than 50 types` (`count`, fields
    `filters.host`, `filters.ingredients`, `filters.exclude_types`).
- Crate: `PubkySocialFeedConfig` gains the public fields `target` and `filters`, so code that
  builds the config as a struct literal must now set them (`target: None, filters: None` for a
  post feed); `PubkySocialFeedConfig::new` is unchanged, and `with_target` and `with_filters` set
  them. New: `PubkySocialFeedTarget`, `PubkySocialFeedFilters` with `canonical()`,
  `feed_resource_types()` (a caller's list as the stored `content`),
  `PubkySocialFeedConfig::resource_types()`, and the limits `feed_resource_types_max_count`,
  `feed_resource_type_max_length`, `feed_filter_hosts_max_count`,
  `feed_filter_ingredients_max_count`, `feed_filter_ingredient_max_length`,
  `feed_filter_radius_max_km`, `feed_filter_place_max_length`, `feed_filter_text_max_bytes` and
  `feed_filter_exclude_types_max_count`.

### Stored bytes

- A feed may list external resources: `"target":"resources"` in its `feed`. Its id hashes
  `resources:` in front of the six segments of the filter, so it never takes the id or the path of
  the post feed with the same filter. Posts is the default and is stored as no member, so a post
  feed keeps its bytes and its id, and a builder never writes `"target":"posts"`. A stored
  `"posts"` reads as written and has the id of a feed without the member. A read refuses a target
  this version does not know, as it refuses an unknown reach, layout or sort.
- A resources feed's `content` is its sorted list of schema.org types, in the content segment of
  its id: songs, every resource and posts of an unknown kind `MusicRecording` are three feeds with
  three ids, and one set of types is one feed whatever order a caller gave. A read refuses a
  resources feed whose `content` is not a stored type list or that has a `domain_tags` filter.
- A resources feed may keep its search filters: `"filters":{…}` in its `feed`, after `target`.
  They are a seventh segment of its id input, after the (empty) domain segment: one JSON object of
  the members set, `place` left out, in the fixed order `when`, `from`, `to`, `near`, `radius`,
  `category`, `host`, `key`, `remote`, `closed`, `ingredients`, `sort`, `window`, `rows`,
  `exclude_types` (the order a builder writes), whatever order they are stored in. None of the six
  segments of a valid resources feed holds a `:`, so no two feeds share an input. A resources feed
  without filters has no seventh segment. `place` only names the point: the same point under a new
  name is the same feed, renamed in place. A stored default (`radius: "10"`, `window: "7d"`) is a
  second feed with its own id. `host` is always a list, of one host or up to 10.
- `filters` is a closed set, an exception to the forward-compatibility rules: a read refuses a
  member or a value this version does not know, because a reader that ignored it would list a
  different feed. So a later release that adds a member or a value to `filters` makes deployed
  readers skip the feeds that use it. A read also refuses an empty set, filters on a post feed, and
  hosts, ingredients or excluded types not stored sorted and deduplicated.
- Older readers: a 1.0.0-rc.1 reader refuses a resources feed, with or without `filters`, when it
  reads the feed at its URL, because the id it derives has neither the `resources:` prefix nor the
  filters segment. Such a reader, decoding the bytes without a URL, has no id to check. It reads the
  post feed with the same six segments, keeping `target` and `filters` as unknown members, and
  `feedId` points it at that post feed's path. Update indexers and clients before any client
  writes a resources feed, and always decode a feed at its URL.
- A feed written by 1.0.0-rc.1 that carried `target` or `filters` in its `feed` as an unknown
  member is read by the new rules now: its id and its validity change. This is an exception to
  the promise above that a release reads what an earlier release wrote and derives every id the
  same way. Deliberate extensions belong under `ext`.

## 1.0.0

### API

- None in this package since 1.0.0-rc.2. The package ships `docs/guide.md`: coming from
  `pubky-app-specs`, and the parts of the data model the README leaves out.
- The crate's Cargo features changed, which this package does not see: `surface` is now
  `__surface` and `replay` is now `__replay`, both internal to the repository's tooling, and
  `utoipa` is no longer a feature. `openapi` is unchanged and is the one to use.

### Stored bytes

- None since 1.0.0-rc.2.

## 1.0.0-rc.2

### Stored bytes

These follow the crate, which changes with them:

- The migration of a 0.x article promotes its first attachment to the `cover_image` only when
  that attachment is an image and the body does not reference `attachment:0`, which is inline
  media there and no cover. When it promotes, every inline reference `attachment:{n}` of the body
  is respelled `attachment:{n-1}`, so each still names the file it did; everything else in the
  body keeps its bytes. The scan is textual, so an `attachment:{n}` literal inside a code span
  or fence counts too: it blocks the promotion when it names slot 0 and is renumbered otherwise,
  where the app's reader, which walks the markdown tree, saw no reference. 1.0.0-rc.1 promoted
  the first image regardless and left the references one slot off. `transform_rev` is 4, so a
  tree migrated under rc.1 is walked again, which picks up what rc.1 skipped; a walk never
  rewrites a 1.x object that exists, so an article rc.1 wrote keeps its bytes. That is the
  never-rewrite policy, not a repair.
- The docs now state the convention those references follow, on `ArticleContent` (and so in
  `docs/reference.md`) and on the crate's `PubkySocialArticleContent`: in an article's `body`,
  `![alt](attachment:{n})` shows the post's `attachments[n]`, whatever its media type, with `n`
  counted from zero, and the cover lives in `cover_image`, not among the `attachments`. No bytes
  change with it and the data model checks none of it: what a reader shows for a slot that is
  not there is the app's to decide.

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
