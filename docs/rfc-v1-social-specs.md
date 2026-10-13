# RFC: pubky-social-specs v1 (first stable, first breaking release)

> Status: DRAFT, for review. This document is the complete v1 design and rollout plan: the
> design model by model (v0 shape, v1 shape, why), then migration, then the rollout. Comment
> inline on the line you disagree with. The companion `v0-vs-v1.md` expands every model change
> with its full reasoning.
>
> Terms used throughout:
> - **epoch**: the `vN` path segment; each epoch is a disjoint subtree holding one generation of data (`social/v1` today).
> - **root**: the leading `pub` or `priv` path segment. The parser reports it as a resource's `visibility`; the `/priv/` root as a feature is the **privacy tier**.
> - **dual-root**: a resource that may live under either root (posts, files, feeds).
> - **now-or-never**: a rule only a breaking release can introduce; deferring it means waiting for `social/v2`.
> - **wire**: the stored/serialized JSON byte form.
> - **scheme tier**: a reference field's validation class: pubky-only, pubky+web, web-only, or universal (any scheme).
> - **nexus**: the shared indexer.
> - **substrate**: the homeserver's dumb blob store (no compare-and-swap, no server-side logic).
> - **tombstone**: the deletion marker readers act on; in v1, the absence of any public copy.
> - **pinned / frozen**: committed as a closed-form rule or data asset; never tracks library or Unicode updates.

This is the first stable release of the shared social-data layer, and the first breaking one.

Shared means many applications read and write the same objects: posts, follows, tags. So the
schema cannot belong to any single app.

Two things change. The crate `pubky-app-specs` becomes `pubky-social-specs` at `1.0.0`. All data
moves from the hard-coded app path `/pub/pubky.app/<res>` to a versioned, app-neutral epoch at
`/{pub|priv}/social/v1/<res>`.

An epoch is the `vN` path segment. Each epoch is a disjoint subtree holding one generation of
data, so two epochs can coexist without either one knowing about the other.

**What this release promises, and what it does not.** This one coordinated break makes every
now-or-never change we are aware of at current time, meaning the ones that cannot be added
additively later. A permanent forward-compat contract then makes everything else additive **for
the wire models**, so v1.x grows without breaking them.

The contract stops at the wire models. The path grammar and the id functions sit outside it.

A future epoch, `social/v2`, stays reserved for the changes no contract can make additive:

- re-pinning a text or id function, which re-ids existing data
- changing a resource's root, its leading `pub` or `priv` segment
- changing per-kind content semantics
- breaking the path grammar

**This is not a claim that no epoch will ever follow v1.** It is a claim that v1.x will not need
one, and that when one does come, the path already carries the version signal that makes
coexistence and migration work.

**What a third-party reader can rely on.** The promise above is what an outside integrator
integrates against, so it is worth stating from their side. It is the same promise for every
resource; no resource gets a second, stabler address than the one the epoch already gives it.

- A path under `social/v1/` keeps its shape for the life of v1. The shape may grow optional
  fields; it never removes one, retypes one, or changes what one means.
- A reader must ignore fields it does not know. That is the reader's half of the contract, and a
  reader that rejects unknown fields breaks on the next additive release rather than on ours.
- A shape change needs a different path. `social/v2` is a disjoint subtree, so it never overwrites
  `social/v1`, and a reader pinned to the v1 path never receives a shape it did not agree to.

**The limit, stated plainly.** When a later epoch exists, the v1 copy survives, because migrating
away from a promised-stable epoch never deletes it. It stops being current, though, from the
moment the owner's client starts writing v2. A reader that needs current data resolves the highest
epoch it understands and falls back, which is the rule the indexer follows (Part C). A reader that
only ever wants a shape it already parses can stay pinned to v1 and accept that it may be reading
a snapshot.

None of this covers `pub/pubky.app/`. v0 was never published as a stable target, and the cleanup
pass removes it once the owner agrees (Part C).

# Part A: Why break now

- `pub/pubky.app/` hard-codes one app's domain as the home of shared data and the parser rejects
  every other app. A shared spec must classify foreign data, not error on it.
- The path is the only version signal that survives the `/events/` feed, LIST, and anonymous GET.
  v0 has none, so v1.x could not evolve without breaking old clients.
- No privacy tier, no file extensions, GET-per-file bookmarks (listing them costs one GET each), and `url::Url` validation that
  normalizes junk into acceptance while rejecting valid short-form URIs.

# Part B: Design, model by model

## B0. Cross-cutting (applies to every model)

- **Namespace and epoch: `pub/pubky.app/<res>` becomes `{pub|priv}/social/v1/<res>`.** Three
  properties, one per part of the new path:

  - `social` is app-neutral. `pubky.app` signals that one app owns shared data, which is false.
  - `v1` is a version. The path is the only channel that survives the events feed, LIST and
    anonymous GET, so a version anywhere else is invisible to most readers.
  - `social` is a bare word with no dot. macOS treats a directory named `pubky.app/` as an
    application bundle when a tree is exported to disk.

  **This has a consequence for deletion, stated here rather than only under migration: deleting an
  object means deleting it in every epoch that holds a copy.** Epochs are disjoint subtrees. A
  surviving copy in an older epoch is still publicly readable, and a from-scratch reindex would
  resurrect it.

  For the v0-to-v1 transition the problem is bounded. The cleanup pass (Part C) removes v0 some
  weeks after migration, leaving one epoch again. It is not bounded in general: any future epoch
  reintroduces it for as long as two epochs coexist, and this release does not solve that.
- **Folder ownership, the composition law.** The specification that defines an object determines
  its storage namespace. The application that writes it does not.

  So an app writing social objects writes them under `social/vN`, and its own objects live under
  its own namespace. Apps compose spec packages, and each package brings its own capability scopes
  and path builders: request `/pub/social/v1/:rw` alongside your app scopes, and use each
  package's builders for its paths.

  **Apps SHOULD request the narrowest scope they use, not the whole namespace.** Capabilities are
  path prefixes. A scope with a trailing slash covers everything below it; a scope without one is
  exact-match. An app that only tags therefore requests `/pub/social/v1/tags/:rw`, and a consent
  screen can say which data is at stake.

  That narrows what an app can reach, not what it can do once inside. Any write capability over a
  directory is total within it. This is unchanged from v0 and is a homeserver concern
  (`pubky/pubky-homeserver#544`) rather than something this spec can enforce.

  Tags follow from the law directly. A tag is a social object, so the one canonical v1 write
  location is `pub/social/v1/tags/`. **Write a tag there and any conforming indexer counts it.**
  That guarantee is what the write location buys an app author, and it is the reason the location
  is fixed rather than advisory.

  What an indexer additionally chooses to read is its own policy. This spec neither requires nor
  forbids an indexer ingesting social objects it finds in other namespaces; that decision belongs
  to the indexer, and the same applies to any other resource type. What the spec does not do is
  promise on the indexer's behalf: an app writing social objects outside `social/vN` has no
  guarantee that anyone indexes them.
- **App namespaces SHOULD carry an epoch too**, as `pub/<app>/v1/...`. Nothing here can be
  mandated for a foreign namespace, because no enforcement point exists. The recommendation is
  free, and it buys an app the same migration mechanics this spec built for itself: old and new
  data coexist in disjoint subtrees, and the version survives the events feed, LIST and anonymous
  GET.

  The parser already anticipates it. A `Foreign` classification surfaces the segment after the
  namespace verbatim, so for an app following the convention that segment is its version, and an
  indexer can version-route conforming app data with a single match.
- **Namespace governance.** This repo owns `social/vN`. A resource type exists exactly when the
  released crate parses it, and additions land as ordinary crate-minor PRs here, with the parser
  arm, the model, the data assets and the vectors in one change.

  These are reserved:

  - epoch segments matching `v[0-9]+`
  - the `_` filename prefix
  - every current resource segment
  - the `ext` member name

  An unknown segment under `social/vN` parses as `Resource::Unknown`. That is a valid
  classification a reader skips, not an error, so additions never break deployed readers. It is a
  different thing from the `Unknown` enum variant in the forward-compat contract below, which is
  about values inside an object rather than segments in a path.

  A new epoch (`social/v2`) is reserved for changes that cannot be made additively: re-pinned text
  or id functions, a changed root, changed content semantics, or a grammar break.

  App namespaces are self-assigned and the parser classifies them foreign, never invalid. Use the
  reversed-domain form, `app.locks` and `app.eventky` rather than `locks.app`, for the same reason
  the social segment is a bare word: macOS treats a directory ending in `.app` as an application
  bundle when a tree is exported to disk.
- **`.json` on every JSON leaf.** The homeserver derives the served type from magic bytes then the
  path extension; extensionless JSON serves as octet-stream/plaintext.
- **A privacy tier at `/priv/`**, owner-only and excluded from `/events/`. It holds state whose
  only reader is the owner's own client. Placement follows the reader set a resource actually has,
  not the one we would like it to have.

  The leading path segment is the root, either `pub` or `priv`, and the parser reports it as the
  resource's visibility. Posts, files and feeds are dual-root: each may live under either root,
  and publishing is a deterministic move between them.

  **The root rule is now-or-never: a public-rooted object must never reference a priv-root pubky
  URI.** Private objects may reference both roots. A public-to-private reference dangles for every
  reader except the owner, and it leaks the private path's existence through the difference
  between a 401 and a 404.
  **Why the root sits inside a reference at all, since it makes references root-specific:** a
  pubky reference is also a fetch address, and the root is the segment that says who may read it.
  A root-less reference would need resolving against both roots, which costs the reader a probe
  and costs validation the ability to reject a public-to-private reference statically.
  **Publish is a copy, not a move, and that is the rule for the whole content family** (posts,
  files, feeds), not only for feeds: the object is written under the other root and the original
  stays. The only reference that must change is a same-owner media URI inside a published object,
  where publish rewrites the `priv` prefix to `pub` (B2).
  **Building on today's `/priv/` is deliberate, and a rework of it is expected.**

  Private data is closed-world. Nothing public references it, and the indexer never reads it. So
  moving it to a different private mechanism later is a sweep over the owner's own files rather
  than a network-wide migration.

  That asymmetry is why the private tier is cheap to place now and expensive to defer. It does not
  hold for anything public, which is where this release spends its care.

  If the eventual mechanism is not client-side encrypted, the homeserver could move the bytes
  itself, which leaves clients a path change to ship rather than a migration to run. If it is
  encrypted, the client-side migration machinery this release builds already covers it.
- **Scheme tiers, which govern reference values rather than paths.** Appendix A governs where
  objects live. This governs what a reference field may contain: `parent`, `embed`, targets,
  images.

  Each field is assigned one of three tiers: pubky-only, pubky and web, or universal. The
  universal tier accepts any scheme-shaped URI through a pinned opaque gate that lowercases the
  scheme and keeps the rest verbatim. Appendix A5 is the normative statement of what each gate
  accepts; each model section gives the rationale for its own field.

  | Field | Tier |
  |---|---|
  | `post.parent` | universal |
  | `post.embed` | universal |
  | `post.lock` | pubky-only |
  | `collection.items[].uri` | universal |
  | tag target | universal |
  | bookmark target | universal |
  | `attachments[].uri` | pubky+web |
  | `user.image`, `article.cover_image`, `collection.cover_image` | pubky+web |
  | `user.links[].url` | web-only |
- **Forward-compat contract, permanent.** Three mechanisms let v1.x grow without breaking a
  deployed reader, and two rules keep that growth bounded.

  **Unknown enum values never crash a reader.** Every wire enum is a plain string enum with unit
  variants and `rename_all`, so `#[serde(other)] Unknown` plus `#[non_exhaustive]` is well
  defined. No model uses `deny_unknown_fields`, and every future field is optional, defaulted and
  skip-if-none. What happens on an unknown value depends on where it sits:

  - in an object's primary enum, such as `post.kind`, validation fails and the reader skips that
    object
  - in a secondary enum, such as `feed.content`, it degrades to "no constraint"

  Deserialization itself never fails.

  **Unknown members are preserved on rewrite, not merely tolerated on read.** Every wire model
  carries an opaque catch-all map, a serde flatten that absorbs any member the model does not
  declare. A client rewriting an object round-trips members it does not understand instead of
  destroying another client's data. Tolerating without preserving would let any older client drop
  every field added after it shipped.

  Preservation is of values, not bytes. A rewrite may reorder members and respell escapes; what
  it carries back is every member with its value. That needs one bound on the members
  themselves: an unknown member may not shadow a declared one, and any integer inside it, at any
  depth, is within the same JSON-safe range (2^53 - 1) every declared integer already obeys.
  Without the second rule an integer beyond that range is rewritten by any JSON engine, this
  crate's or a JavaScript caller's, and preservation would be a promise no implementation can
  keep. Any other content of an unknown member is never inspected.

  Preservation fixes exactly one failure: a client deserializing into its own older types and
  writing back, silently destroying fields it never modeled. It does not fix concurrency.
  Concurrent writers still clobber whole files under last-write-wins wherever that is the
  documented rule.

  **Conformance vectors cover both behaviours.** These are committed input and expected-output
  files that every implementation must reproduce.

  Two rules bound the growth. The first: **total object size is capped**, at 512 KiB for posts and
  64 KiB for every other JSON resource, measured on stored bytes, checked before parsing on read
  and after building on write. Unknown members stopped per-field validation from bounding size,
  and a total cap cannot be added later without a break, so it ships now. The caps cover JSON
  resources only; media bytes keep their own size bound.

  The second: **a conforming rewrite fetches the current object from the homeserver**, never from
  an indexer view, because a view can be stale or partial (Part C2 rule 7).

  One wedge case is pinned. If a rewrite cannot fit the cap while preserving unknown members, the
  writer fails the write and surfaces it. It never silently drops members. The user may then
  explicitly discard extensions.

  **On the indexer side**, unknown members are carried verbatim into object views, so any client
  can read an extension through the shared index before the indexer understands it. They are
  never validated, queried or indexed. Queryability requires an adopted projection, meaning the
  indexer explicitly promoting the member into its queryable schema. That gives an extension three
  stages: readable when carried, queryable when projected, validated when it becomes a spec field.

  **Deliberate extensions SHOULD nest under the reserved `ext` member**, as `"ext": {"badge":
  {...}}`. It is one greppable home whose meaning is pinned once: everything under `ext` is
  third-party data the base spec never validates. Treat it as hostile input, so escape before
  rendering and validate against the extension's own rules before interpreting (Part C2 rules 10
  and 11).

- **Canonical-encoding id rule.** An id is valid if and only if re-encoding its decoded bytes
  reproduces the input exactly. The check is closed-form, on the final character.

  v0 accepted dozens of alias spellings for one id: lowercase, `O` for `0`, dangling bits. Each
  alias was a distinct key on the homeserver. That leniency is removed.
- **Engine-free validation.** Three dependencies leave the normative surface: `url::Url`, which
  normalizes junk into acceptance; the `mime` crate; and full-Unicode case and trim operations.

  Pinned rules replace them: a strict raw-string canonicalizer, a frozen whitespace table,
  ASCII-only label folding, and code-point lengths. A frozen table is a committed list of code
  points that never tracks Unicode updates. One implementation, the crate, ships native to the
  indexer and as wasm to the app. The pinned rules are what a second implementation would have to
  reproduce byte-for-byte, and they keep that door open without re-iding data.
- **No silent sanitize-rewrites.** v0 rewrote `[DELETED]` names to "anonymous", and it truncated
  over-long input and then blanked it. In v1 invalid input is a validation error.

A migrated user's tree at a glance (`<pk>` a host key, `TS` a TimestampId, `H26` a HashId):

    pubky://<pk>/
    |-- pub/social/v1/
    |     profile.json
    |     posts/TS1/TS1.json      first version (editId reuses the post id)
    |     posts/TS1/TS2.json      an edit; references still say posts/TS1
    |     tags/H26.json
    |     follows/<pk2>.json
    |     files/H26.jpg
    |     feeds/H26.json          a published feed (copy of the private file)
    |-- priv/social/v1/
          posts/TS3/TS3.json      a draft
          bookmarks/<b64u>.json   target readable from the filename
          mutes/<pk3>.json
          feeds/H26.json

## B1. User (profile)
v0 `pub/pubky.app/profile.json` -> v1 `pub/social/v1/profile.json`.
- `image` accepts pubky/http/https via one shared image validator (cap 300). pubky-app avatars are
  pubky file URIs; an http-only rule would reject every real avatar.
- The `[DELETED]` magic string dies entirely: v0's silent `[DELETED]` -> "anonymous" rewrite is
  removed with NO replacement rule; `[DELETED]` is an ordinary legal name. **Required upgrade in nexus, the shared indexer (gates v1 indexing):** the indexer currently keys deletion on that literal; it must key
  on a real flag (`deleted` on the indexed row / UserView) before indexing any v1 data. How a
  deleted account is displayed then becomes pure client presentation (Part C2 rule 18; the indexer may
  transitionally keep emitting the old literal at its view layer for old clients; storage and
  query logic never key on it).
- Fields and caps otherwise unchanged; profile stays public (identity must be readable).
- Third-party readers: profile is the resource outside apps integrate against most, and it carries
  the ordinary v1 stability promise, no more and no less (B0).

## B2. Post
v0 `pub/pubky.app/posts/{id}` (one flat file, overwritten on edit) -> v1
`{pub|priv}/social/v1/posts/{id}/{editId}.json`, referenced versionlessly as `posts/{id}`;
`{id}` and `{editId}` are both canonical TimestampIds (Appendix A3, A4).
- **Per-edit path versioning.** Each edit is a new file; the first version reuses the post id;
  references use the versionless form so edits never orphan replies or re-key tags. A counter was
  rejected (races across devices; the substrate, the homeserver's dumb blob store, has no
  compare-and-swap). Now-or-never: a
  `posts/{id}` file and a `posts/{id}/` directory are mutually exclusive on the homeserver.
- **An optional readable label on the version leaf.** A version may be written
  `{editId}-{slug}.json`, so a post can carry a human-readable path without a second id scheme.
  The label is opaque: never hashed, never normalized, and it carries no identity.
  `{editId}.json` and `{editId}-anything.json` denote the SAME version, so exactly one spelling
  may exist (Part C2 rule 6). Writing one is optional and a reader that ignores labels entirely
  is conforming. The permanence follows from versions being write-once: a version keeps the label
  it was created with, and a client that derives labels from the title just gets a new label on
  the next edit, which is a new version anyway.
- **Kinds renamed** `short`->`note`, `long`->`article` (nature, not length); all seven kinds kept.
- **`embed`** flattened from `{uri, kind}` to a plain URI string (kind is derivable from the
  target), and it accepts ANY external URI, the same universal tier as tags: http/https through
  the strict web gate (the pinned regex validator for web URLs) (an OpenStreetMap object URL is an ordinary https reference), and any other
  scheme-shaped identifier (`nostr:`, `geo:`, `ipfs:`, `did:`) through a pinned opaque gate
  (lowercased scheme + rest verbatim, no engine parsing). The indexer attaches the post to the same External Resource
  nodes (its graph records for non-pubky targets) that it builds
  for external tag targets. `parent` takes the same tier, so a thread can be rooted at any
  resource (a web page, a nostr event, a user) and tagging, quoting and replying are three edges
  to one target with one vocabulary; a post reference in any of these positions must be
  versionless (it names the logical post, not a version). This also keeps migration total (every real v0 record has a valid v1 image; nothing fails to
  migrate): v0's `Url::parse` accepted arbitrary schemes, so real v0 data can carry them.
- **`attachments`** become `Vec<{uri, alt?, name?}>`, always `[]` never null. Objects, not strings,
  so per-item metadata (alt text now; hash/blurhash later) is additive; ships two committed fields.
- **`lock`** kept: the value is the lock-FILE URI (`pub/app.locks/<lock_id>.json`, illustrative), and presence
  means "locked content" regardless of kind (matches the Locks feature's resolved design).
- **Dual-root:** posts may live under `/priv/` (drafts, private notes, private collections).
  Publishing copies the post to `/pub/` and **rewrites the `priv` prefix to `pub` on same-owner
  media references only** (`attachments[].uri` and a content envelope's `cover_image`), because a
  private draft's image must itself be private or it leaks before the post does. Any OTHER
  reference still pointing at a priv URI fails the root rule at publish: publish the referenced
  object first, or remove the reference. Cross-owner priv references are invalid outright.
- **The post is a reusable envelope (adopted from review).** The crate exports the shared
  mechanics, versioned storage, ids, parent/embed/attachments/lock, preservation, path helpers,
  as a generic layer (`PostEnvelope<K>`), with the social post as its first specialization
  (closed kind set, wire bytes unchanged). App specs specialize it with their own kinds in their
  own namespaces (a Mapky review, an Eventky event), where social readers classify them as
  foreign data. The envelope fixes reference semantics uniformly (a reply edge means the same
  thing everywhere); the specialization owns its kind vocabulary and content validation.

  The envelope is a library convenience, not a governance mechanism. This spec defines no process
  for admitting a foreign kind into `social/vN`, and it does not need one: additions here are
  ordinary crate-minor PRs, and a kind this spec has not defined simply lives in its own namespace
  where readers classify it as foreign and skip it.
- The `[DELETED]` content sentinel dies with no replacement (same flag rule as B1); absence is
  the tombstone (the deletion marker readers act on), synthesized by the indexer from real
  deletion state, never from content strings.

## B3. ArticleContent (new)
v0: pubky-app hand-rolls `{title, body}` JSON inside `long` posts, unspecified, cover smuggled as
`attachments[0]`. v1: a typed `{title, body, cover_image?}` content envelope in `content` when
`kind == article` (a per-kind content schema INSIDE the content string, distinct from the
`PostEnvelope` mechanics layer of B2). Per-kind content shape is now-or-never; the cover moves into the envelope.
Articles may carry parent/embed/attachments (an article can be a reply or carry media).
Caps: title 100 and body 50000 code points; the raw envelope string is bounded at 104000 before
parsing, twice the body, because JSON escaping doubles a body made of newlines and quotes.
`body` is CommonMark; renderers may honor the GFM tables, strikethrough, task-list and autolink
extensions, anything else renders as literal text. The validator does not parse it (every string
is valid CommonMark, so a parse proves nothing). Renderers never execute raw HTML, block or
inline, and limit link destinations to `http`, `https`, `pubky` and `mailto`.

## B4. CollectionContent
`{name, description?, items[], cover_image?}`, with two changes to `items`.

**`items` join the universal tier.** Any scheme-shaped URI, the same gate as tags, bookmarks and
`post.embed` (A5), not just `posts/` under `pubky.app` and not just pubky URIs. A curated list of
OSM locations or `nostr:` events is a collection of those things, not a collection of posts about
them, and collections were the last reference field still narrowed to pubky-only.

**`items` become objects, `{uri, note?}`, not bare strings.** Same move `attachments` makes in B2
and for the same reason: per-item metadata is additive once the item is an object and a wire break
afterwards, so the cheap shape now is the one that forecloses. `note` is the one committed field;
anything further is additive under the forward-compat contract.

Private collections come free from the dual-root post family.

Tracks current v0 (#147): the optional `layout` preference (`grid`, `list`, `visual`) stays, and it
gains `Unknown` like every other wire enum.

## B5. Tag
`tags/{id}.json`. Id = `HashId("{target}:{label}")`, the target canonicalized, the label
frozen-trimmed and ASCII-folded
label (v0 used engine `to_lowercase` and `url::Url` normalization, neither reproducible across
implementations; content-addressed ids must freeze their input functions). The `:` join is injective only because labels reject `:`; that restriction may never be
lifted while the id format stands. One write location, any target: every app writes tags at the
author's `pub/social/v1/tags/`, and the target may be any public resource: social objects, other
apps' objects, or ANY external URI (http/https via the strict web gate; other schemes, `nostr:`,
`geo:`, `ipfs:`, `did:`, via a pinned opaque gate that lowercases the scheme and keeps the rest
verbatim). v0 accepted these via `Url::parse`, so this also keeps migration total. A logical tag therefore has exactly one possible address:
re-tagging self-overwrites idempotently, apps on the same account converge on the same file, and
the indexer reads one namespace with no writing-app dimension (reading `tags/` directories in
other app namespaces survives only as a legacy rule; migrating those files is the owning app's
job). Because addresses converge (Part C2 rule 8), a tag writer SHOULD GET the address first and preserve unknown
members if a file exists: a blind PUT would destroy another app's enrichment of the same
statement (preservation protects read-modify-write, not write-without-read).

## B6. Bookmark
v0 `pub/pubky.app/bookmarks/{HashId(uri)}` (public, one-way filename, GET-per-file) -> v1
`priv/social/v1/bookmarks/{filename}.json`.
- **Private** (reader set is the owner). Targets take the universal tier: any public pubky
  resource or any external URI, same domain as tags. Honest cost, for review: going private
  retires the indexer's bookmark-derived public features, including collection-follows
  (following a collection was modeled as a bookmark on it); an explicit follow/subscribe
  resource is the deferred replacement candidate.
- **Target in the filename, reversibly.** Primary form: unpadded `base64url(canonical target)`
  (no `=`; the parser's form check accepts alphabet characters only) for
  targets up to 187 bytes. The math: the homeserver caps a path segment at 255 characters, and `.json` takes 5, leaving
  250. base64url is the densest standard encoding that is also `/`- and `%`-free and natively
  JS-decodable, and 250 base64url characters carry 187 bytes, so 187 is the largest cap ANY
  reversible encoding allows. Longer targets use the overflow form `~ + HashId(target)`
  with the target kept in content. Listing costs zero GETs for primary-form entries (the
  overwhelming majority); each overflow entry costs one GET to recover its target.
- Content shrinks to `{created_at}` (plus `target` only in overflow).

## B7. Follow
`follows/{followeePk}.json`, `{created_at}`. Public (the social graph). Only the cross-cutting
changes apply; the filename-is-target pattern (one LIST answers "who do I follow") is kept.

## B8. Mute
`priv/social/v1/mutes/{muteePk}.json`. Moves to `/priv/`; who you muted is sensitive and its only
reader is the owner (the indexer has zero mute consumers). Shape unchanged.

## B9. LastRead, and B12. Settings: both leave this spec
v0 kept `last_read` and `settings.json` under `pub/pubky.app/`, world-readable. Neither is social
data, so neither lands in `social/v1`: they move to the writing app's own namespace
(`priv/app.pubky/v1/` for pubky-app) and out of this library entirely, model definition included.

The placement test is normally the ACTUAL reader set. Device state like `require_pin` fails it
outright. But `language` PASSES it, and still leaves, so a second test outranks the first: **whose
specification defines the object.** Preferences general to any application are not social data
however portable they are, and this spec does not own them. Whoever writes an object owns its
schema unless a shared spec claims it.

Accepted cost: a second social client starts your unread count from scratch. Migration still
carries the v0 values into the new location (M3), so no user loses settings.

## B10. File (media), the v0 File + Blob pair collapsed
v0: two objects, `files/{id}` metadata + `blobs/{hash}` bytes -> v1: ONE content-addressed media
object `files/{hash}.{ext}`, the raw bytes.
- `name` relocates to the attachment object (per-reference, so shared bytes can carry different
  names). The declared MIME is consumed once at upload to pick the extension and is never stored;
  size and served type come from the bytes and headers. Authoring time is the referencing post's id.
- Deletes the `src` indirection, the two-PUT dance, and the metadata-per-blob ambiguity. Dual-root.
- **Media is immutable by identity.** The path IS the content hash, so changing the bytes produces
  a different object at a different path and every referrer must be repointed. v0's `files/{id}`
  was a mutable pointer to `blobs/{hash}`, letting bytes be swapped under a stable reference; v1
  drops that indirection deliberately. In practice "editing an image" is uploading a different
  image, and the referencing post is edited too, which is cheap under per-edit versioning.
- The extension comes from a frozen MIME-to-ext map (`.bin` fallback), path-only, never hashed.
- Reclaiming unreferenced media is a client sweep, not a side effect of deleting a post
  (Part C2 rule 16).

## B11. Feed
v0 `pub/pubky.app/feeds/{HashId(serde-json config)}` (public) -> v1
`{priv|pub}/social/v1/feeds/{id}.json`.
- **Private by default, published by choice** (copy the same file to `/pub/`). Reader set is the
  owner today; publishing is a deliberate act.
- **What the crate provides, and what the caller does.** The crate performs no I/O: it exposes the
  path builders, the validation, and the ordered plan of operations for publish, unpublish and
  delete. The caller executes that plan against the homeserver. This is the same shape the
  migrator engine uses, where all I/O goes through an injected client. The boundary is also the
  general one: the artifact enforces the model, the client is responsible for conformance
  behaviour that a pure function cannot observe.
- **Content-addressed id over a pinned config string** (not serde output, which is field-order
  fragile and not JS-reproducible). Six fixed segments: reach, layout, sort, content filter,
  tags, and domain tags. Two users publishing the same config share an id, so future
  cross-homeserver popularity ranking is additive indexer work.
- **The id is checked on every read.** A reader keeps the spelling of a config value it does not
  know, so it recomputes the id from the config as stored and a conforming writer of a newer
  value passes the check. The usual rule then applies (an unknown filter degrades, an unknown
  reach rejects), so adding a filter value never makes older readers drop the feed.
- Tracks current v0 (#143): the `wot` and `me` reach values and the optional `domain_tags`
  filter (same folding and cap rules as tags) are part of the v1 model, and `domain_tags`
  participates in the id (two feeds differing only in domain filter are different feeds).
- Tracks current v0 (#149) too: the optional `icon` name stays. It sits outside the id, because a
  feed is identified by what it filters, not by how it looks, and a published copy carries it
  alongside `name`.
- All three enums gain `Unknown` (v0 hard-crashes old clients on any new reach/layout/sort value);
  `name` gains a cap.

## B13. Parser and `Resource`
v0 `url::Url`-based, hard-rejects any non-`pubky.app` app path, silently accepts userinfo/`..`/query
-> v1 one closed grammar: `Foreign` and `UnsupportedVersion` are first-class handled categories
(never errors), failed id validation yields `Unknown` (never a panic or error), wrong-root is
unrepresentable. A future `social/v2` reads as "upgrade me," not garbage. The normative grammar
is Appendix A; the reference crate and its committed conformance vectors are the executable form.

## B14. IDs
TimestampId (post and edit ids), HashId (tag/media/feed files, 128-bit), PubkyId (host/follow/mute), all
under the canonical-encoding rule (B0). TimestampId gains a per-session monotonic mint guard (in the
browser the crate mints at ms resolution, so same-ms writes would clobber on path). **The guard
constrains MINTING only.** Copying, publishing and migration reuse an id that already exists and
never mint, so none of them is affected by it. No id function
content-addresses a serialized struct, so the byte-identity surface is pure string/byte
functions.

# Part C: Migration

Migration is client-side, opt-in, and resumable from the homeserver tree alone. A dormant user may
migrate years later in one pass, and the indexer reads every epoch for as long as any exist. The v0
parser therefore stays permanently, because the v1 parser classifies `pubky.app` as foreign.

**"Permanently" is cheaper than it sounds, on two counts.** The v0 parser is frozen rather than
maintained: it ships with committed conformance vectors, so the recurring cost is running its
tests. It changes by one rule only, widening: it may come to accept a value that a released v0
client stored and it rejected, it never rejects what it accepted, and it never changes what an
accepted object migrates to. Each widening raises the transform revision, so a migrated tree is walked
again, and adds a conformance row whose verdict comes from running that released client. And the v0 population drains rather than accumulates, because the
cleanup pass below removes v0 a few weeks after each user migrates.

What remains years out is dormant accounts nobody has opened since. That is precisely the
population opt-in migration exists to serve, and precisely the one a cutoff date would strand. A
staged upgrade tool, telling a user their data is too old and to run something first, stays
available as a later option if the maintenance ever proves real. It is additive and needs no
decision now.

## Migration itself never deletes

Migration copies. It never removes legacy-epoch data, and privacy lost before v1 is already lost,
so the copies it leaves behind change nothing about what was already public. Legacy public copies
of now-private types are left inert, and the indexer stops surfacing them.

Copying rather than moving buys three things:

- clients still on v0 keep working
- a bad migration is recoverable, because the source survives
- a good one can be verified against its source before anything is discarded

**It therefore roughly doubles a user's stored social data**, against a homeserver that enforces a
per-user quota. Raising that quota is a prerequisite for the migrator going live rather than a
follow-up. It is release gate `QUOTA`.

## Legacy cleanup is a separate, later pass

Cleanup is never part of migration. It ships once the migrator has run clean on real data, it asks
the user before removing anything, and it deletes a legacy object only after verifying that the v1
counterpart exists and parses.

The delay is the point. It puts distance between "did the migration work" and "throw away the
original", and it gives anything still reading v0 paths a window to move.

**This applies to v0 only, and it happens once.** v0 was never published as a stable target, so
removing it breaks no promise. From v1 onward the rule is the opposite: migrating to a future epoch
never deletes the epoch it came from, because that epoch was promised stable.

## Determinism and resume

Migration is deterministic and total over real v0 data. Each record sources from its highest
present epoch, transforms compose in memory and write only the latest result, and ids and hashes
are re-derived rather than minted.

**A destination that exists is never overwritten; its existence is the proof the object was
done.** Writes are create-only. Freshness comes from sourcing each record from its highest present
epoch, and the user's intent to delete comes from re-checking the source after every copy. An
earlier draft of this section asked resume to compare source against destination and redo the
copy when they differ. That was withdrawn: a destination that differs from the transform of its
source is, in the normal case, an edit the user made in the new epoch after migrating, and redoing
it would overwrite that edit with stale content. It also contradicts the rule above it, since once
a copy exists the highest present epoch is the new one and there is nothing left to migrate. What
comparison was meant to catch is covered elsewhere: a copy written by a buggy transform is a repair
tool's job, never the normal walk's; a source edited from a legacy client after migration is closed
by the client ceasing legacy writes once migrated and by the epoch cleanup.

Three supporting mechanisms:

- a client-private `_migrated` marker records the transform revision, so a shipped migrator fix
  walks the tree again and picks up what earlier revisions skipped (it never rewrites what exists)
- a malformed object is skipped and reported rather than blocking the tree; a run that hit a
  transient I/O failure writes no marker, so the next run walks again
- the homeserver's quota error surfaces as a typed failure

## Known failure mode: writes from a legacy client go unseen

Once a record exists in both epochs, the indexer serves the highest one it understands. So a v0
client editing an already-migrated record writes successfully, to a path that still exists, and no
reader ever sees the change. Nothing errors.

The migrating client stops writing to the legacy epoch once migrated, which narrows the window.
The cleanup pass closes it for good, because a removed epoch has nothing left to write to.

## Deletion spans epochs, and that rule is not migration-scoped

See Part C2, rules 13 to 15. A migrated post lives at both `pub/pubky.app/posts/{id}` and
`pub/social/v1/posts/{id}/...`, so deleting a public object removes every copy, in every epoch and
both roots. Leave one behind and a from-scratch reindex resurrects it.

Absence is the tombstone. On a dumb blob store the owner's files are the only durable state, so
restoring an old backup republishes its contents. That is accepted by design.

Durable per-object tombstone files were considered and rejected. The substrate cannot enforce them
against the owner's own writes, and public tombstones would leak deletion metadata forever.

## The indexer contract

- dedup on `(author, resource_type, stable_id)`
- tag id-sets: each tag edge keeps the set of ids asserting it across epochs, so un-tagging removes
  all of them
- intrinsic-time ranking, by decoding the post id
- tombstone only when no publicly visible copy survives

# Part C2: Client conformance

Everything above defines what a valid object is, and almost all of it is enforced by the shipped
artifacts. The crate, native and as wasm, carries the types, the validators, the builders and the size
checks. A conforming implementation cannot produce an invalid object even by accident.

This section collects the exception: rules a pure-function library cannot enforce, because they
need I/O, ordering, or state the library never sees. They bind clients and they are normative.
They are gathered here rather than scattered so an implementer has one checklist, and the model
sections above reference this section instead of restating it.

Rules addressed to the shared indexer are a separate class, marked inline in Part B and Part C as
the indexer contract. Those bind nexus, not clients.

## Read behaviour

1. **Skip what you do not recognise.** An unknown segment under `social/vN` parses as
   `Resource::Unknown`, foreign namespaces parse as `Foreign`, and both are valid classifications
   that a social reader SKIPS. Neither is an error.
2. **Skip objects whose primary enum is `Unknown`.** An unrecognised `post.kind` fails validation;
   the reader skips that object rather than failing the batch.
3. **Treat an `Unknown` secondary enum as no constraint.** An unrecognised `feed.content` value
   degrades to "no filter", it does not empty the feed.
4. **Complete the bookmark filename check.** The parser performs a FORM check only (A3). Full
   round-trip validation, decode then re-encode and compare, is the reader's job.

## Write behaviour, read-modify-write

5. **A version file is written once.** A version path is created and never rewritten: an edit
   mints a new `{editId}` and writes a new file. Changing the bytes at an existing version path is
   a violation, and a reader keeps the copy it saw first.

6. **One spelling per version.** A version leaf may carry an optional readable label
   (`{editId}-{slug}.json`, A3), and the label is not part of the version's identity. So a writer
   MUST NOT create both `{editId}.json` and `{editId}-{slug}.json` for the same version. Adding or
   changing a label afterwards is already forbidden by rule 5.

7. **Read the current object from the homeserver before rewriting it, never from an indexer
   view.** An indexer view can be stale or partial. Writing back from one destroys whatever the
   view omitted.
8. **GET a tag address before PUTting it.** Tag addresses converge by construction, so a blind PUT
   destroys another app's enrichment of the same statement. Preservation protects
   read-modify-write. It cannot protect a write that never read.
9. **Fail loudly when the size cap and preservation conflict.** If a rewrite cannot fit the cap
   while preserving unknown members, the writer FAILS the write and surfaces it. It never
   silently drops members. The user MAY then explicitly discard extensions.

## Extensions

10. **Nest deliberate extensions under `ext`.** The catch-all preserves members wherever they sit,
   but `ext` is the one greppable home whose meaning is pinned.
11. **Treat everything under `ext` as hostile input.** Escape before rendering; validate against the
   extension's own rules before interpreting. The base spec never validates it.

## Multi-object operations

12. **Publish is a copy, and the client executes it.** The crate supplies the paths, the
    validation and the ordered plan; the client performs the writes (B11).
13. **Deletion is user-initiated only.** Nothing in this spec deletes an object on a user's behalf.
14. **Deleting a public object removes every copy, in every epoch and both roots.** A migrated post
    exists at both its legacy path and its `social/v1` path. Leave either behind and a
    from-scratch reindex resurrects it. This is a permanent client rule rather than a
    migration-only one, and it applies for as long as two epochs coexist.
15. **Private-tier deletes touch only the `/priv/` file,** with one exception. A mute delete
    removes `/pub/pubky.app/mutes/{id}` first: a v0 mute was public and its path is the muted
    key, so the legacy copy is named without a listing, and leaving it would keep the mute
    world-readable.
16. **Deleting a post does not delete its media.** Media is content-addressed and shared, so
    another of your posts may reference the same file, and nothing on the homeserver tracks that:
    `LIST` returns names only, and references live inside post bodies. Deciding whether a file is
    still used costs one GET per post you own. So a client reclaims media in its own pass over all
    posts, with the user's confirmation, rather than on every delete. References from other owners
    cannot be checked and dangle like any other reference to a deleted object.
17. **Un-migrated users must keep reading their own legacy tree.** A client that has adopted v1
    reads the union of v1 and legacy paths for its own user, so opting out of migration costs the
    user nothing. It is stated here because it is normative client behaviour rather than a
    rollout task.

## Presentation

18. **A deleted account's display is client policy.** The spec removes the `[DELETED]` sentinel and
    puts nothing in its place; how a deleted account renders is the client's decision.

## Capabilities

19. **Request the narrowest scope you use** (B0), and use each spec package's own path builders
    rather than hand-built strings.

## What is NOT in this section

Migration conformance is Part C. Those rules bind a migrating client for the duration of a
migration. Rule 12 is the one that looks like migration and is not, which is why it moved here.

# Part D: Rollout and subtasks

Spec crate on a long-lived `v1` branch, one PR per task, CI green on every commit, version
`1.0.0-alpha.N` until release. Each task is independently mergeable in this order.

**Spine (serialized):**
- [ ] **S1** rename crate + types (wire-invariant).
- [ ] **S2** fix the wasm packaging: a build never rewrites a tracked file; the limits asset is
  generated at build.
- [ ] **S3** forward-compat contract (`Unknown` on every wire enum).
- [ ] **S4** validation core: limits table, canonical id validators, frozen text ops, mint guard.
- [ ] **S5** path epoch + canonicalizers + parser (atomic).
- [ ] **S6a** post wire shapes on the concrete social post (kinds, embed, attachments, Article
  envelope). The generic `PostEnvelope<K>` moves to J2: wasm-bindgen refuses type parameters on
  an exported struct, and a wrapper class written now would be deleted when J2 drops the class
  surface.
- [ ] **S6b** post storage, roots, lifecycle on the concrete post (versioned builders, root
  rule, publish/unpublish/delete), with the namespace as a parameter so J2 lifts it unchanged.
- [ ] **S7** tag + collection (canonical id inputs; collection items become `{uri, note?}`
  objects on the universal tier).
- [ ] **S8** media collapse (single bytes object, MIME map, parser ext-strip).
- [ ] **S9** feed dual-root + the user profile field gates (image, links).
- [ ] **S10** private tier + bookmarks.
- [ ] **S11** legacy_v0 module + cross-epoch normalization (`stable_id`/`resolve_deref`).

**Conformance corpus + JS surface:**
- [ ] **J1** Rust conformance-vector generator (byte-identity + verdict tiers, fuzzed).
- [ ] **J2** the v1 wasm surface: function-shaped exports returning `{object, meta}`, an explicit
  `init()`, TS types. Owns the generic envelope (`PostEnvelope<K>` + kind trait + social alias)
  once the model structs lose their `#[wasm_bindgen]` attributes.
- **J3** differential gate, retired: a pure-JS implementation is deferred past v1, and the gate
  returns with it.

**Migrator:**
- [ ] **M1** transform registry + v0 reader, in the crate behind a `migrator` feature and shipped
  in the same wasm (semantic vectors committed).
- [ ] **M2** engine as a library in the package (`pubky-social-specs/migration`): epoch probe,
  existence-based resume with create-only writes, abort-if-no-`/priv/`, calling the M1 transforms,
  with all I/O behind an injected port so the same engine runs in pubky-app, a standalone web
  tool, or Node. This moves the engine out of pubky-app, which keeps its port adapter and the
  route (M3); the library boundary of rule 12 still holds, the port is the only thing that
  touches the network. Acceptance includes: a destination that exists is left in place, a
  destination written by another device during the run is not clobbered, and an interrupted run
  converges on resume.
- [ ] **M3** pubky.app `/migrate` route (caps, upgrade flow, live counts, and the import of
  `settings` and `last_read` into `priv/app.pubky/v1/`, including the `last_read` ms-to-us
  conversion, which is app-owned rather than a shared transform).
- [ ] **M4** legacy cleanup pass: user-confirmed, verify-then-delete per object, shipped after
  M3 has run clean on real data. Gated on confidence, not on a calendar date.

**Cross-repo:**
- [ ] **pubky-nexus:** per-epoch classify/adapt/normalize, permanent v0 parser, the deletion
  flag (deletion keyed on real state, never name/content literals; gates v1 indexing), tag id-sets,
  intrinsic-time ranking, multi-epoch tombstones, bookmark-feature retirement, mixed-epoch resync.
- [ ] **pubky-app:** v1 adoption (new caps, kind strings, own-tree legacy read union per Part C2
  rule 17, publish UI, media type threading, deletion engine).
  - [ ] **moderation:** mixed epoch support by both nexus and homeserver synchronization services as well as by checkstep-request services

**Release gates:**
- [ ] **IN-PRIV** verify the target homeserver runs the `/priv/` tier and permits the write
  paths. Prerequisite for M2 onward and for any private-tier go-live, not a late release check.
- [ ] **QUOTA** raise the per-user storage quota before the migrator goes live. Migration copies,
  so it roughly doubles stored social data; shipping M3 first means users hit the quota partway
  through a migration.
- [ ] **REL** release `1.0.0` (crate + npm), merge `v1` to main after nexus dual-read is live.

**Dependencies** (beyond the serialized spine order above): S11 needs S5. J1 needs S5 and
regenerates as later S tasks land; J2 needs J1 and S11. M1 needs J2 and S11; M2 needs M1 and
IN-PRIV; M3 needs M2. Nexus dual-read must be live before
any client writes v1 data; the pubky-app track needs J2 and that nexus gate. REL is last.

**Acceptance, every task:** its listed artifact lands with the full CI bar green (fmt, clippy
with warnings denied, tests, doctests, feature checks, the wasm and npm legs, and a clean tree
after the package build).

# Part E: Folds in and supersedes

Supersedes the v1 roadmap #12. Resolves: #47 (json extensions), #48 (attachment type array),
#55 (content hash, deferred to v1.x as a flat optional sibling with the shape pinned here), #120
(short-form URIs), #141 (reject non-canonical URIs). Mention-prefix cleanup (`pk:`) is handled
client-side and already shipped.

No open design decisions remain; a carve-out allowing migration to delete some legacy data was
considered and rejected: migration is strictly non-destructive (Part C).

# Appendix A: the v1 URI grammar (normative)

The reference crate's parser and its committed conformance vectors are the executable
definition; this is the same grammar in human-readable form. Scope: this appendix governs PATHS
(where objects live and how path URIs classify); reference FIELD VALUES inside objects go
through the per-field scheme tiers described in Part B, not this grammar.

## A1. URI forms and canonicalization

Accepted input forms: `pubky://<host>[/<path>]` and the SDK short form `pubky<host>[/<path>]`
(scheme prefix case-sensitive; `Pubky://` is invalid). The canonical output form is always
`pubky://<host>[/<path>]`.

Canonicalization is raw string work, byte-level, with no engine URL parser anywhere:

- **Host:** exactly 52 z-base32 characters (lowercase alphabet `ybndrfg8ejkmcpqxot1uwisza345h769`),
  final character `y` or `o` (the canonical-encoding rule: the trailing 4 pad bits must be zero).
  A `@` or `:` anywhere in the host is invalid (no userinfo, no port).
- **Path segments** (split on `/`): reject an empty segment (this covers trailing slashes and
  `//`), `.`, `..`, and any segment containing `%`, `?`, `#`, an ASCII control character, or a
  frozen-whitespace code point. `\\` is permitted: `pubky://` is not a browser special scheme,
  so nothing rewrites it, and it is never a separator in any pubky context. There is NO percent-decoding, NO case folding, and NO segment
  normalization: what is stored is what was written.
- A bare host (`pubky://<host>`) is valid and canonical.

Failures here, plus the root check in A2 step 1, are the only HARD errors (in both cases no
resource with a visibility can be constructed); every other failure is a handled classification,
never an error and never a panic.

## A2. Classification

After canonicalization, split the path into segments and classify:

1. An empty path (a bare host) classifies as **User** (public): the URI references the user
   themselves. Otherwise segment 0 must be `pub` or `priv` (it becomes the resource's
   visibility); anything else is a hard error.
2. Segment 1 not `social`: **Foreign** `{namespace, version?, rest}`. Foreign data is valid,
   classified, and skipped by social readers; it is never an error.
3. Segment 1 `social`, segment 2 matching `v[0-9]+` but not the supported epoch:
   **UnsupportedVersion** (a reader's "upgrade me" signal).
4. Segment 2 not an epoch segment: **Unknown**.
5. Otherwise dispatch on the remaining segments per the table below. Any non-match, any failed
   id validation, any wrong-root spelling of a single-root resource, and any `_`-prefixed leaf
   (reserved client-private names) is **Unknown**.

## A3. Resource dispatch (owner-relative paths under `{root}/social/v1/`)

| Resource | Path remainder | Roots | Leaf rule |
|---|---|---|---|
| User | `profile.json` | pub | none |
| Post (versionless reference) | `posts/{id}` | both | `{id}` = canonical TimestampId |
| Post (version) | `posts/{id}/{editId}[-{slug}].json` | both | strip `.json`, then split at the FIRST `-`: the head is a canonical TimestampId, the optional tail is the label (A4). An absent, illegal or over-length label is Unknown |
| File (media) | `files/{hash}.{ext}` | both | strip exactly one extension, case-sensitively, ONLY if it is in the frozen extension set; remainder = canonical HashId; unknown or absent extension is Unknown |
| Tag | `tags/{id}.json` | pub | `{id}` = canonical HashId |
| Follow | `follows/{pk}.json` | pub | `{pk}` = canonical host key (as A1) |
| Mute | `mutes/{pk}.json` | priv | same |
| Bookmark | `bookmarks/{filename}.json` | priv | FORM check only: every character in the base64url alphabet, or `~` followed by 26 canonical Crockford characters; full round-trip validation is the reader's job |
| Feed | `feeds/{id}.json` | both | `{id}` = canonical HashId |

`.json` stripping is exact and single: `follows/<pk>.json.json` leaves `<pk>.json`, which fails
key validation and classifies Unknown.

## A4. Canonical id encodings

An id is valid if and only if re-encoding its decoded bytes reproduces the input. Closed form:

- **TimestampId** (post/edit ids): 13 chars of uppercase Crockford base32
  (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`); final char in `{0,2,4,6,8,A,C,E,G,J,M,P,R,T,W,Y}`
  (one trailing pad bit, must be zero). Lowercase and the alias letters `O/I/L/U` are invalid.
- **HashId** (tag/media/feed ids): 26 chars, same alphabet; final char in `{0,4,8,C,G,M,R,W}`
  (two pad bits).
- **Host key**: as A1 (52 z-base32, final `y`/`o`).

The optional post label (`{editId}-{slug}.json`, A3) is NOT an id and has no canonical form. It is
1 to 64 characters of `[a-z0-9-]`, validated as written and stored verbatim. It is never hashed,
so it needs no frozen text function, and it is excluded from every id and from `stable_id`.

Time bounds are never checked at parse time; only canonicality is.

## A5. Reference-field gates: what is accepted, and what is not

Appendix A1 to A4 govern PATHS. This section governs reference FIELD VALUES, and it is the
normative statement of what those gates accept: the mentions in B0, B2 and B5 are summaries of
this, not independent rules.

**Not every valid URI is accepted, and that is deliberate.** These gates are engine-free by
design, so their behaviour is defined by the rules below rather than by whatever a URL library
does this year. `url::Url` and WHATWG `new URL()` are outside the normative surface entirely;
their verdicts agree today but cannot be pinned across engine versions, and since the stored value
is the raw string, full parsing buys nothing. A client MAY parse with its engine as an advisory
warning.

Three gates, dispatched on the value's prefix.

**Pubky gate** (`pubky` prefix). The `pubky*` scheme space is reserved; see A1.

**Web gate** (`http://`, `https://`):
1. Trim with the frozen whitespace set.
2. Reject any remaining ASCII control character or frozen-whitespace code point. This is stricter
   than WHATWG, which silently strips embedded tabs and newlines; here they are a rejection.
3. Require `http://` or `https://` followed by an authority with a non-empty host. The authority
   runs to the first `/`, `?` or `#`; the host is what follows any userinfo (up to the last `@`)
   and precedes any port. `https://user@` and `https://:443/path` are rejections. The host is
   otherwise kept as written, case included.
4. Apply the field's length cap.

**Opaque gate** (everything else: `nostr:`, `geo:`, `ipfs:`, `magnet:`, `did:`, any scheme-shaped
value):
1. Trim with the frozen whitespace set; reject remaining ASCII control or frozen-whitespace code
   points.
2. Require a `:` at position 1 or later with at least one character after it. The scheme must be
   RFC 3986 shaped: first character ASCII alphabetic, remainder ASCII alphanumeric or `+`, `.`,
   `-`. Uppercase is accepted on input.
3. Canonical form is the ASCII-lowercased scheme, then `:`, then the remainder VERBATIM. The
   remainder is opaque: no percent-decoding, no query or fragment parsing, no structural rules.
   The value is an identifier this spec carries, not a location it resolves.
4. Apply the field's length cap.

**What this means for an application author**, stated plainly because it is the practical
consequence:

- The opaque gate is MORE permissive than a URI parser in one direction: it accepts any
  scheme-shaped value without understanding the scheme, including schemes that do not exist yet.
- It is LESS permissive in another: it performs no normalisation, so anything a parser would
  repair into acceptance is rejected here, and anything a parser would rewrite is stored as
  written.
- Identity is spelling-sensitive beyond the scheme fold. `http://x.com` and `http://x.com/` are
  two distinct canonical values, as are two spellings of one `nostr:` event. This is an accepted
  and documented fork: authoring clients SHOULD submit the target's own canonical spelling, and
  SHOULD lowercase scheme and host for web URIs before submitting.
- Structure inside the remainder is never validated. A malformed query string in an `https` value
  is accepted; a percent-sequence is neither decoded nor checked.

The committed conformance vectors cover these gates, including the rejection cases (embedded tab, embedded newline, control characters,
a scheme with a leading digit, a bare scheme with no remainder, and over-cap values).

## A6. Representative vectors

`<pk>` is any valid host key, `TS` a canonical TimestampId, `H26` a canonical HashId.

| Input | Result |
|---|---|
| `pubky<pk>/pub/social/v1/posts/TS` | Public Post reference (short form accepted) |
| `pubky://<pk>/priv/social/v1/posts/TS/TS.json` | Private Post version |
| `pubky://<pk>` | User (bare host) |
| `pubky://<pk>/pub/social/v1/files/H26.svg` | Public File, id `H26` |
| `pubky://<pk>/pub/social/v1/files/H26.JPG` | Unknown (extension set is case-sensitive) |
| `pubky://<pk>/pub/social/v1/posts/ts-lowercase` | Unknown (non-canonical id) |
| `pubky://<pk>/pub/social/v1/posts/TS/TS-hello-world.json` | Post version `TS`, label `hello-world` |
| `pubky://<pk>/pub/social/v1/posts/TS/TS.json` | the SAME version as the row above; labels carry no identity |
| `pubky://<pk>/pub/social/v1/posts/TS/TS-Hello.json` | Unknown (label is lowercase only) |
| `pubky://<pk>/pub/social/v1/posts/TS/TS-.json` | Unknown (empty label) |
| `pubky://<pk>/pub/social/v1/posts/TS/TS-a-b.json` | Post version `TS`, label `a-b` (split is at the FIRST hyphen only) |
| `pubky://<pk>/pub/social/v2/posts/TS` | UnsupportedVersion |
| `pubky://<pk>/pub/pubky.app/posts/TS` | Foreign |
| `pubky://<pk>/pub/social/v1/mutes/<pk>.json` | Unknown (mutes are priv-rooted) |
| `Pubky://<pk>/pub/social/v1/profile.json` | hard error (scheme case) |
| `pubky://user@<pk>/pub/social/v1/profile.json` | hard error (userinfo) |
| `pubky://<pk>/pub/social/v1/posts/../profile.json` | hard error (dot-dot) |
| `pubky://<pk>/dav/social/v1/profile.json` | hard error (unknown root) |
