# v0 vs v1, model by model

> Companion to `rfc-v1-social-specs.md`: the same design, expanded. This document walks every
> model and explains each change: what it was in v0 (`pubky-app-specs` 0.6.0, verified against
> the July 2026 main), what it becomes in v1 (`pubky-social-specs` 1.0.0, epoch `social/v1`),
> and why the change is an improvement: which problem or requirement it tackles.

---

## 0. Cross-cutting changes (apply to every model)

These are listed once here; the per-model sections below only add what is specific to them.

- **Namespace and epoch: `pub/pubky.app/<res>` becomes `{pub|priv}/social/v1/<res>`.**
  Why: v0 hard-codes one app's domain as the location of SHARED social data and the parser
  rejects every other app's path, contradicting multi-app interop, the project's first-class
  goal. And v0 has no version signal at all, while the path is the only channel that survives
  the events feed, LIST, and anonymous GET. Epochs in the path also make old and new data
  physically coexist in disjoint subtrees, which is what makes non-destructive client-side
  migration possible at all. A third, practical reason the new segment is a bare word: dotted
  directory names are a filesystem hazard. Back up or export a homeserver tree to disk (pubky-app's
  data-export ZIP preserves paths) and you get a folder literally named `pubky.app`, which macOS
  treats as an application bundle: contents hidden behind an app icon, double-click tries to
  launch it. `social` carries no extension, and no directory in the social tree ever will; only
  leaf files carry extensions.
- **`.json` on every JSON leaf.** Why: the homeserver derives the served Content-Type from
  magic bytes and then the path extension; extensionless JSON (everything in v0 except
  `profile.json`) serves as `application/octet-stream`/plaintext. The extension fixes serving
  and downloads for free, using machinery the server already has.
- **A privacy tier.** Why: v0 stores mutes, bookmarks and saved feeds world-readable and on the
  public events feed although their verified reader set is exactly one, the owner's own client.
  `/priv/` (owner-only, excluded from public events, shipped on pubky-core main) is their correct
  home. The rule that decides VISIBILITY is the ACTUAL reader set, not aspiration.
  A second rule decides OWNERSHIP, and it outranks the first: whose specification defines the
  object. `settings.json` and `last_read` pass the reader-set test and still leave this spec
  (sections 9 and 12), because preferences general to any application are not social data however
  portable they are. Reader set tells you which root; the defining spec tells you which namespace.
- **Type rename `PubkyApp*` to `PubkySocial*`, wire-invariant.** Why: the crate name and type
  prefixes teach every integrator that one app owns shared data. Serde field names and enum
  strings stay byte-identical: this break costs a compile, not a migration.
- **Forward-compat contract.** Every wire enum gains `#[serde(other)] Unknown`; no model
  may ever use `deny_unknown_fields`; every future field must be optional, defaulted, and
  skip-if-none. Unknown members are tolerated on read AND preserved on rewrite: every wire model
  carries an opaque flattened catch-all map, so a rewriting client round-trips members it does
  not understand (tolerating without preserving would let any older client silently destroy
  every field added after it shipped). Why: v0 has exactly one `Unknown` catch-all (`PostKind`); adding a value to any
  feed enum hard-crashes every old client on deserialize. This contract is what turns "break
  once, then grow additively" from an aspiration into a property. The bound extensibility
  needs: TOTAL object size is capped (posts 512 KiB, every other JSON resource 64 KiB; media
  bytes keep their own media-size bound), checked before parsing on read and after building on
  write; rewrites fetch from the homeserver rather than indexer views; a rewrite that cannot fit
  the cap while preserving unknown members fails and surfaces rather than silently dropping
  them; and the indexer carries unknown members verbatim in its views (readable by any client)
  while indexing only adopted projections. Deliberate extensions SHOULD nest under the reserved `ext` member, defined once
  as unvalidated third-party data: hostile input until an extension's own rules validate it.
- **Canonical-encoding id validation.** An encoded id is valid if and only if re-encoding its decoded
  bytes reproduces the input, with closed-form regexes and final-char sets. Why: v0's validators
  decode Crockford aliases (`O` as `0`, lowercase, a dangling final bit) and z-base32 dangling
  bits, so one logical id has dozens of accepted spellings, each a DISTINCT homeserver key:
  identity forks, dedup splits, and broken bytewise ordering. Verified empirically. The ed25519
  point check also leaves PubkyId validation: v0 ran it native-only, which made Rust and JS
  disagree by construction.
- **Pinned text operations.** Trim uses a frozen whitespace table (a DATA asset); tag-label
  lowercasing is ASCII-only; lengths are code points; all wire i64s must fit in 53 bits. Why:
  engine trim/lowercase/Unicode tables differ between Rust and JS and across browser versions
  (verified divergences on U+FEFF, U+0085, full-Unicode case mapping, i64 rounding), and
  content-addressed ids freeze whatever functions feed them. Changing these later re-ids data,
  a break fixable only by opening a new `social/vN` epoch, so they are pinned now, engine-free.
- **One URI grammar.** All `pubky://` validation goes through one raw-string
  canonicalizer (accepts the SDK short form, #120; rejects userinfo, `..`, `%`, query, fragment,
  whitespace, control, #141); web references are gated by a pinned regex. Reference field values are validated by per-field
  scheme tiers: pubky-only, pubky+web, web-only, or universal (any scheme-shaped URI via the
  pinned opaque gate); `url::Url` and WHATWG
  `new URL()` leave the normative surface entirely. Why: v0's `url::Url` normalizes junk into
  acceptance and rejects valid short forms, and two independent validation surfaces (parser vs
  field validators) had already drifted; engine URL parsers cannot be version-pinned across
  browsers.
- **The root rule.** A public-rooted object must never reference a priv-root pubky URI;
  private objects may reference both roots. Why: such a reference dangles for every reader but
  the owner and leaks the existence of a private path via the 401-vs-404 oracle. This is the one
  now-or-never piece of the private tier: tightening validation later is epoch-class.
- **Folder ownership (the composition law).** The specification that defines an object
  determines its storage namespace, never the application that writes it; apps compose spec
  packages (each bringing capability scopes and path builders). App namespaces SHOULD carry an
  epoch (`pub/<app>/v1/...`): unenforceable for foreign namespaces, but the parser already
  surfaces the post-namespace segment from Foreign paths, so for conforming apps that segment IS
  the version and the convention buys version-routing for free. `social/vN` itself is governed by the spec repo: a resource type exists exactly when the
  released crate parses it.
- **No silent sanitize-rewrites.** v0 silently rewrote `[DELETED]` names to "anonymous",
  truncated-then-blanked over-long `file.src`, and passed unparseable URLs through
  `sanitize_url`. v1 makes invalid input a validation error. Why: silent rewrites hide bugs and
  make two implementations disagree about what was stored.

---

## 1. User (profile)

v0: `pub/pubky.app/profile.json`, `{name, bio?, image?, links?, status?}`.
v1: `pub/social/v1/profile.json`, same fields.

- **`image` explicitly allows `pubky`, `http`, `https` and uses the one shared image validator,
  cap 300.** Why: pubky-app avatars ARE pubky URIs today (`pubky://<pk>/pub/.../files/<id>` is what
  the client writes into `image`, verified end-to-end); an http-only rule, which one design
  draft proposed, would have invalidated every real avatar. One validator now covers
  `user.image` and both `cover_image` fields, one rule for one kind of value.
- **The `[DELETED]` magic string dies entirely.** v0 silently rewrote a user named `[DELETED]`
  to "anonymous" because the indexer keys its deletion handling on that literal (verified), so a
  user carrying the name would be treated as deleted. v1 removes the rewrite with NO replacement
  rule: `[DELETED]` is an ordinary legal name. The load-bearing requirement moves to the indexer
  contract instead: **nexus (the shared indexer) must key deletion on a real flag** (`deleted`
  on the indexed row)
  before indexing v1 data, and display of deleted accounts becomes pure client presentation. A
  magic string survives nowhere in the v1 wire rules.
- **`links[].url` validated by the pinned web gate instead of `Url::parse` + `sanitize_url`.**
  Why: cross-implementation determinism (cross-cutting rationale above); v0's `sanitize_url`
  passed invalid URLs through unchanged.
- Unchanged: field set, caps (name 3..50, bio 160, links 5 x {100, 300}, status 50), and wire
  field names. The profile stays public: identity is the one thing that must be readable.

## 2. Post

v0: `pub/pubky.app/posts/{id}`, one flat file, overwritten on edit;
`{content, kind, parent?, embed?: {kind, uri}, attachments?: [String], lock?}`.
v1: `{pub|priv}/social/v1/posts/{id}/{editId}.json`, referenced versionlessly as
`posts/{id}`.

- **The post becomes a reusable envelope.** The shared mechanics (versioned storage, ids,
  references, attachments, lock, preservation) ship as a generic crate layer that app specs
  specialize with their own kinds in their own namespaces; the social post is the first
  specialization, wire-identical to the shape described here. Why: the consumers are real
  (Mapky, Eventky) and the layer costs no wire change. It is a library convenience; this spec
  defines no process for admitting a foreign kind into `social/vN`.
- **Per-edit path versioning.** Storage is one file per edit; the first version reuses the
  post id; every reference (reply, embed, tag, bookmark, collection item) uses the versionless
  form. Why: v0 edits overwrite in place, so nothing distinguishes an edit from a new post on
  the events feed, and there is no history. A counter-based scheme was rejected because the
  substrate has no compare-and-swap: counters race across the owner's devices. TimestampId
  editIds mint with no prior read, sort chronologically under bytewise LIST order, and
  `decode(editId)` doubles as an approximate edit timestamp. Versionless references mean edits
  never orphan replies or re-key tags. This is now-or-never: a `posts/{id}` file and a
  `posts/{id}/` directory are mutually exclusive on the homeserver, so the layout cannot be
  retrofitted.
- **Dual-root: private posts.** Drafts, personal notes, and private collections live under
  `/priv/` with identical shapes and ids; publish is a deterministic root migration; unpublish
  deletes the public copies. Why: drafts and private collections are committed
  product needs, and the Locks flow independently demonstrates the value of post-shaped private
  content. Public stays the default root, so this adds capability without changing anyone's
  existing mental model.
- **Kinds renamed: `short` to `note`, `long` to `article`.** Why: the old names describe length,
  not nature; `article` is what the thing actually is, and it now has a typed envelope (model 3)
  instead of a hand-rolled convention. All seven concrete kinds survive (each has a live
  creation path in pubky-app); `Link` deliberately stays untyped because the URL lives inside the
  content text, so there is no per-kind shape decision being missed.
- **`embed` collapses from `{kind, uri}` to a plain URI string, and accepts ANY external
  target (the universal tier: http/https strictly gated, any other scheme via a pinned opaque
  gate).** Why: the embedded target's kind is derivable by resolving the target;
  storing it duplicates state that can go stale. External embeds make quoting a web resource
  first-class (the indexer reuses the External Resource nodes it already builds for external tag
  targets), and they keep migration total: v0's `Url::parse` gate accepted arbitrary embed URLs,
  so real v0 posts can carry them. `parent` stays pubky-only: reply threads are social-graph
  edges between posts.
- **`attachments` becomes `Vec<{uri, alt?, name?}>`, always present, default `[]` (#48).** Why: v0's
  `Option<Vec<String>>` made every consumer branch on null-vs-empty; and a bare string array can
  never grow per-item metadata without a breaking change. The object form makes alt text (a
  committed accessibility need) and `name` (the display filename, relocated from the deleted v0
  File object by the media collapse) ship now, and every future per-attachment field (hash,
  blurhash, dimensions, `content_type`/`size`) additive. Exactly two optional fields ship;
  nothing speculative.
- **`lock` is kept with corrected semantics.** The value is the lock FILE URI
  (`pubky://<creator>/pub/app.locks/<lock_id>.json`, illustrative), pubky-only; presence means "locked
  content" regardless of kind. Why: this matches the resolved Locks design (pubky-app #2029);
  earlier drafts (including v0 doc comments) mis-described it as a lock-server URI. The client-owned
  teaser object inside a locked post's `content` stays deliberately client-owned, per the Locks
  team's own recorded decision.
- **Reference fields get one shared cap (1024) and canonicalization.** Why: v0 was a mix
  (attachment URI 200, src 1024, parent/embed/lock effectively uncapped or 200); one
  `reference_uri_max_length` replaces four inconsistent rules.
- **The `[DELETED]` content sentinel is removed; absence is the tombstone.** Why: a
  magic content string must not survive the one clean break; deletion is now defined honestly as
  "delete every version in every epoch and both roots, retry to completion", with nexus
  synthesizing its own tombstones from DELETE events and real deletion state, never from content
  strings (the same required flag upgrade as the user model).

## 3. ArticleContent (new model)

v0: none. pubky-app hand-rolls `JSON.stringify({title, body})` into `long` posts, unspecified,
with the cover image smuggled as `attachments[0]` (both verified in the client).
v1: `PubkySocialArticleContent {title, body, cover_image?}`, a typed content envelope in
`content` when `kind == article` (a per-kind schema inside the content string, distinct from
the `PostEnvelope` mechanics layer).

- **The envelope exists at all.** Why: an unspec'd JSON convention inside a spec'd field is
  interop debt; any other client rendering articles must reverse-engineer pubky-app. Per-kind
  content shapes are now-or-never (changing what `content` means for a kind is a break), so this
  is exactly what the one break budget is for.
- **`cover_image` moves INTO the envelope.** Why: `attachments[0]`-as-cover is positional
  convention, invisible in the type system; the field is explicit, validated by the shared image
  validator, and composes with real attachments. Migration maps the old convention in.
- **Articles may carry `parent`, `embed`, and `attachments`.** Why: an article can legitimately
  be a reply or a quote and carry media; and a forbid rule would have made any v0 long post
  holding more than the single mapped cover attachment FAIL migration. Composability plus
  migration totality.
- **Caps: title 100 code points, body 50000 (renamed from `post_long_content_max_length`), raw
  envelope 52000.** Why: the title cap formalizes what pubky-app's UI already enforces; the raw cap
  is a cheap pre-parse bound. pubky-app's brittle "body budget = long cap minus 100 minus 22 bytes
  of JSON skeleton" arithmetic dies because validation is field-level now.

## 4. CollectionContent

v0: `PubkyAppCollectionContent {name, description?, items[], cover_image?}` in `content` when
`kind == collection` (shipped shortly before v1).
v1: same shape, three rule changes.

- **`items` accept ANY scheme-shaped URI, on the universal tier.** Why: v0's item check
  hard-restricted items to `posts/` under `pubky.app`, contradicting the interop goal. The first
  draft relaxed that to any pubky URI while keeping items pubky-only, on the reasoning that "a web
  link belongs in a post". That reasoning does not survive the obvious case: a collection of OSM
  locations or Spotify tracks is a collection of those resources, not a collection of posts about
  them. Tags, bookmarks and `post.embed` were already universal, so collections were the last
  field narrowed for no reason that held.
- **`items` become objects, `{uri, note?}`, not plain strings.** Why: the earlier draft kept plain
  strings and recorded per-item annotation as an accepted future break. It is not worth accepting.
  `attachments` makes exactly this move in v1 (section 2) because per-item metadata is additive
  once the element is an object and a wire break once it is not. Doing it now costs one level of
  nesting; doing it later costs an epoch.
- **`cover_image` uses the shared image validator (cap 300).** Why: one rule for one kind of
  value, aligned with Article and `user.image`.
- **Private collections come free.** A collection post under `/priv/` is a private
  curation list, a requested future feature that costs zero extra spec surface because
  collections are posts.
- Unchanged: the v0 guards (collections carry no parent, embed, or attachments) because they are
  live in v0 and cost migration nothing.

## 5. Tag

v0: `pub/pubky.app/tags/{id}`, `{uri, label, created_at}`, id = `HashId("{uri}:{label}")` where
the uri was normalized by `Url::parse(...).to_string()` and the label by full-Unicode lowercase.
v1: `pub/social/v1/tags/{id}.json`, same fields.

- **The hash input is pinned: canonicalized target + frozen-trim + ASCII-folded label.** Why:
  v0's normalization was engine-dependent twice over (`url` crate re-serialization and ICU case
  tables), and content-addressed ids freeze their input functions forever; an engine-skew fork
  in a tag id never heals. The ASCII-only fold trades non-Latin case-insensitive dedup (bounded
  regression, documented) for permanent cross-implementation determinism.
- **The injectivity invariant is stated:** `"{uri}:{label}"` is unambiguous only because labels
  reject `:`; that restriction may never be lifted while the id format stands. Why: implicit
  invariants get broken by well-meaning future edits.
- **`uri` gains the shared 1024 cap** (was uncapped) **and hash inputs always use the
  canonicalizer's output** (v0's bookmark hashed the RAW string while tag hashed a normalized
  one, two different identity rules for the same kind of value).
- **Migration non-invariance is documented:** a tag id embedding a social target changes
  across epochs by construction; nexus dedups on `(author, normalized target, label)` with an
  id-SET per edge so cross-epoch un-tagging works. Why: without this, dual-read double-counts
  every tag and a "like" placed before migration can never be removed after it.
- **One write location, any target.** Every app writes tags at the author's
  `pub/social/v1/tags/` (folder ownership above); the target may be any public pubky resource or
  ANY external URI (the universal tier: http/https via the strict web gate, other schemes like
  `nostr:`/`geo:`/`ipfs:` via the pinned opaque gate). One logical tag has exactly one address,
  so re-tags self-overwrite and the indexer drops the writing-app dimension for v1 data; tag
  files under other app namespaces survive as a legacy READ rule only. Because addresses
  converge, a tag writer SHOULD GET the address first and preserve unknown members if a file
  exists: a blind PUT would destroy another app's enrichment (e.g. `ext.badge`) of the same
  statement.
- Tags stay public-only in v1; tagging private objects is deferred (dual-rooting a resource
  later is additive).

## 6. Bookmark

v0: `pub/pubky.app/bookmarks/{HashId(raw uri)}`, content `{uri, created_at}`: world-readable,
and the filename is one-way, so listing your bookmarks costs one GET per bookmark.
v1: `priv/social/v1/bookmarks/{filename}.json`.

- **Targets take the universal tier** (any public pubky resource or any external URI), same
  domain as tags; over-cap and exotic targets all representable (overflow form below).
- **Moves to `/priv/`.** Why: what you saved is personal state with zero cross-user readers
  (verified: even pubky-app reads bookmark state via nexus, which only surfaces it to the owner);
  world-readable bookmarks are a privacy leak.
- **The target moves into the filename, reversibly (the primary form):** `base64url_nopad(canonical target)` for
  targets up to 187 bytes. Why: LIST returns keys only, so a reversible filename makes "list all
  my bookmarks" ZERO GETs (v0's defining defect, #47's sibling). 187 bytes is the exact
  substrate maximum (250 chars + `.json` = 255), and at that cap base64url is the ONLY standard
  encoding that fits at all. base64url is also `/`-free, `%`-free, JS-decodable natively, and
  already in the SDK dependency stack.
- **An overflow form for long targets:** `~ + HashId(target)` with the target kept in content,
  from 188 bytes up to the shared 1024 code-point reference cap. Why: real bookmarks exceed 187 bytes (maps and shop URLs); without an
  overflow they could not be represented at all under the reversible form. `~` is outside the
  base64url alphabet, so the two forms are unambiguous.
- **Content shrinks to `{created_at}`** (plus `target` only in overflow). Why: the target lives
  in the filename; duplicating it invites mismatch. Stated honestly: recency SORT still costs
  GETs (created_at is in content), and each OVERFLOW entry costs one GET to recover its target;
  primary-form listing is zero GETs.
- **The hash/encoding input is the canonicalizer's output, never the raw spelling.** Why: v0
  hashed the raw string, so two spellings of one URL made two bookmarks.
- **Read-side rules are pinned:** decode-then-re-encode must reproduce the filename
  byte-for-byte, UTF-8 decode is fatal, failures are skipped entries. Why: JS base64 decoding is
  catastrophically lenient (verified: it accepts padding, aliases, and garbage the Rust crate
  rejects), and a hostile filename must not fork implementations.

## 7. Follow

v0: `pub/pubky.app/follows/{followeePk}`, `{created_at}`.
v1: `pub/social/v1/follows/{followeePk}.json`. Shape unchanged.

- Only the cross-cutting changes apply (path, `.json`, canonical PubkyId spelling). Follows stay
  public: they are the social graph, nexus's core input. The filename-is-the-target pattern
  (one LIST answers "who do I follow") was already right in v0 and is kept.

## 8. Mute

v0: `pub/pubky.app/mutes/{muteePk}`, `{created_at}`, world-readable.
v1: `priv/social/v1/mutes/{muteePk}.json`. Shape unchanged.

- **Moves to `/priv/`.** Why: who you muted is among the most sensitive social data there is,
  and its verified reader set is the owner alone: nexus main has ZERO mute consumers (the
  watcher no-ops mute events), and pubky-app already reads mutes by LISTing its own directory. The
  move costs nexus nothing and the client a path change.

## 9. LastRead, and 12. Settings: both leave this spec

v0: `pub/pubky.app/last_read` (no extension, MILLISECONDS) and `pub/pubky.app/settings.json`, both
WORLD-READABLE. `settings.json` was the only unspec'd homeserver artifact in the app, exposing
`require_pin`, `sign_out_inactive` and the rest of the user's privacy posture to anyone, read by
nobody but the owner's client.
v1: both move to the writing app's namespace, `priv/app.pubky/v1/` for pubky-app, and leave this
library entirely: no shared model, no validation, no builders.

- **Why they leave rather than move to `priv/social/v1/`.** Device state (`require_pin`,
  `sign_out_inactive`) is not social by any reading. `language` is the interesting case: it is
  genuinely portable, so it passes the reader-set test, and it still leaves, because it is general
  to ANY application rather than to social ones. A spec that defines social objects does not get to
  own general preferences by virtue of having noticed them first. The earlier draft argued the
  opposite, that portability alone justified adopting them; that argument is withdrawn.
- **Consequence, accepted.** A second social client starts your unread count from scratch, and
  neither file is validated by anything shared. That is the correct trade for state whose only
  reader is one app, and it is precisely why they are leaving.
- **Migration still carries them.** The v0 values are imported into the new location by the
  pubky-app `/migrate` route, including the `last_read` millisecond-to-microsecond conversion.
  That conversion is now app-owned; the shared transform table has no unit changes at all.
- **Not a precedent for stripping the spec.** Mutes and bookmarks stay, because a different social
  client reading them gets value: they shape what you see in a shared social graph.

## 10. File (media), the v0 File + Blob pair collapsed

v0: TWO objects per upload: `files/{id}` metadata (`{name, created_at, src, content_type,
size}`, with a HARD 21-entry MIME whitelist gate and a silent truncate-then-blank sanitize on
`src`) pointing at `blobs/{HashId(bytes)}`, extensionless raw bytes.
v1: ONE object: `{pub|priv}/social/v1/files/{hash}.{ext}`, the raw bytes, content-addressed.
The metadata sidecar is deleted.

- **The collapse itself.** Why: both premises of the v0 split died. `name` now has a better home,
  the attachment object's optional `name` field (per-reference, so two posts can attach the same
  bytes under different names, which one-name-per-File could not express); authoring time is
  carried by the referencing post's own id; `size` and the served type come free from the bytes
  and headers (nexus downloads the bytes anyway to build CDN variants); and the v1 nexus adapter
  is new code regardless, so "nexus is event-driven off the File PUT" stopped being an argument.
  Deleted with it: the `src` indirection, the two-PUT upload dance, the several-metadata-objects-
  per-blob extension ambiguity, and the word "blob" (a backup now shows a `files/` folder holding
  openable `{hash}.jpg` files). Honest costs, accepted: renaming an upload means editing the
  referencing post; the same bytes declared under two MIMEs duplicate storage instead of sharing
  one blob (rare, documented fork); an uploaded-but-never-referenced file carries no metadata.
- **A canonical, path-only extension from a frozen MIME-to-ext map.** Why: the homeserver ignores
  the PUT Content-Type and derives the stored type from magic bytes, then the path extension
  (verified, `file_metadata.rs`); sniff-miss text types (svg, csv, txt, json, html, xml) served
  wrong in v0. The declared type is consumed exactly once, at upload, to derive `{ext}` via a
  pinned essence regex (the essence is the bare type/subtype, parameters stripped) +
  single-valued map; it is never stored. The ext is NEVER part of the
  hash, so the content address and dedup are untouched; `.bin` is the total fallback.
- **The MIME whitelist gate is removed.** Why: a closed list on world-readable content is a
  forward-compat trap (it already rejected avif, heic, webm audio, opus, wasm); and the Rust
  `mime` crate could not stay the judge because its verdicts are not reproducible in JS and it
  accepts the malformed `"image/"` (verified). The old list survives as an advisory hint.
- **The parser strips exactly one known-map extension before id validation.** Why: without the
  strip, recompute-and-compare id validation would reject every single media file.
- **Dual-root.** Why: a private draft whose images sat in public `files/` would leak (media
  directories are anonymously LISTable). Publish copies bytes across roots identically (the hash,
  and therefore the id, is root-independent).

## 11. Feed

v0: `pub/pubky.app/feeds/{HashId(serde_json(config))}`, `{feed: config, name, created_at}`,
public, enums crash on unknown values. (Current v0 also carries the `wot`/`me` reaches and an
optional `domain_tags` filter, added mid-2026 in #143; v1 includes all three, and `domain_tags`
joins the id input as its own trailing segment.)
v1: `{priv|pub}/social/v1/feeds/{id}.json`.

- **Private by default, published by choice (dual-root).** Why: a saved feed is a personal
  config whose verified reader set is the owner (pubky-app only ever LISTs its own feeds dir; no
  share or subscribe feature exists); public-by-default was aspiration, not fact. Publishing is
  a deliberate act: copy the same bytes to `/pub/`, unpublish deletes the copy.
- **The id stays content-addressed but the hash input is a pinned canonical string, never serde
  output.** Why the content-addressing: identical configs self-overwrite
  (natural dedup), migration re-derives ids purely, and two users publishing the same config
  share an id, so public-feed identity is readable from `/events/` paths alone, which makes a
  future cross-homeserver popularity ranking purely additive indexer work. Why the pinned
  string: v0 hashed `serde_json::to_string(config)`, which silently re-ids every feed on any
  struct reshuffle and is not byte-reproducible in JS. `name` and `created_at` stay outside the
  hash: personal labels on a shared identity. Tags sort inside the input so `[a,b]` and `[b,a]`
  are one filter; the format is injective because `:` and `,` are invalid in labels.
- **All three enums gain `Unknown`; an unknown `content` filter degrades to "no filter".** Why:
  the highest value-per-byte fix in v1. In v0, the day a new reach/layout/sort value ships,
  every old client hard-crashes on deserialize; this is the one guarantee only a version
  boundary can make.
- **`name` gains a cap (100).** Why: it was the only unbounded display name.
- **Edit semantics stated honestly:** a config change derives a new id (write new, delete old,
  re-publish if desired); pubky-app's v0 flow already works exactly this way, including the
  known orphan-file behavior, now documented instead of accidental.

## 13. Parser and `Resource` (the read side of every model)

v0: `url::Url`-based, hard-rejects any app path that is not `pubky.app`, silently accepts
userinfo/`..`/query/fragment/extra segments, never validates ids, never panics, but errors on
all foreign data.
v1: one closed grammar (normative form: Appendix A of `rfc-v1-social-specs.md`).

- **`Foreign` and `UnsupportedVersion` are first-class handled categories, never errors.** Why:
  v0's defining interop failure was erroring on other apps' data; an indexer iterating the
  events feed must classify and skip, not crash or log-spam. A future `social/v2` object reads
  as "upgrade me", not garbage.
- **Failed id or format validation yields `Unknown`, never an error; every access is
  bounds-safe.** Why: the parser's consumers run unattended over hostile input forever; the two
  hard errors that remain (an uncanonicalizable URI: bad scheme case, bad host, userinfo,
  dot-dot, or an unknown root) exist only because no `ParsedUri` can be
  constructed, and callers treat them as skips.
- **Wrong-root parses to `Unknown` for single-root resources; `visibility` carries the root for
  the dual-root three.** Why: "private object at a public path" becomes unrepresentable at the
  type level, the one structural guard the homeserver cannot give.
- **Reserved names: `^v[0-9]+$` epoch segments, `_`-prefixed private filenames, the `ext`
  field.** Why: reserving names is free; colliding with them later is not.

## 14. IDs (the identity layer under every model)

- **TimestampId: unchanged format, monotonic mint guard in BOTH implementations.** Why:
  the JS runtime mints at millisecond resolution, so same-ms writes collide on path, which
  under path-versioning is silent data loss; the guard is three lines. The JS codec uses BigInt,
  byte-for-byte equal to Rust (verified including `i64::MAX`).
- **HashId: unchanged format (blake3, first 16 bytes, Crockford, 26 chars), kept at 128 bits.**
  Why: under owner-only-write, pubkey-namespaced paths, a collision cannot substitute content at
  someone else's path, and per-user counts are nowhere near the birthday bound; widening buys
  nothing and costs every path 13 chars.
- **Canonical spellings enforced everywhere** (cross-cutting above), and the stale "z-base32"
  doc comments on Crockford code die.

---

## The deltas at a glance

| Model | v0 path | v1 path | Headline change |
|---|---|---|---|
| User | `pub/pubky.app/profile.json` | `pub/social/v1/profile.json` | pubky avatars legal; `[DELETED]` sanitize gone |
| Post | `posts/{id}` flat file | `{root}/.../posts/{id}/{editId}.json` | edit versioning; dual-root drafts; kinds renamed; attachments become objects |
| Article | (hand-rolled JSON) | typed envelope | formalized; cover in envelope |
| Collection | envelope, posts-only items | envelope, reference-tier items | interop items; private collections free |
| Tag | `tags/{id}` | `tags/{id}.json` | engine-free pinned hash input |
| Bookmark | `bookmarks/{HashId}` public, GET-per-file | `priv/.../bookmarks/{b64u\|~hash}.json` | private, reversible filename, overflow form |
| LastRead, Settings | `pub/pubky.app/...`, public | `priv/app.pubky/v1/...` | leave this spec entirely |
| Follow | `follows/{pk}` | `follows/{pk}.json` | unchanged shape |
| Mute | `mutes/{pk}` public | `priv/.../mutes/{pk}.json` | private |
| File (media) | `files/{id}` meta + `blobs/{hash}` bytes | `{root}/.../files/{hash}.{ext}` | ONE object (collapse); canonical extension; dual-root |
| Feed | `feeds/{HashId(serde_json)}` public | `{priv\|pub}/.../feeds/{id}.json` | private default + publish; pinned hash string; enums get Unknown |
