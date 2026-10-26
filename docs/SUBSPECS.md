# Sub-specs

A kind goes in the social specs only when other apps must read it: social 1.1 adds `event`, `rsvp`
and `rating`, nothing else. An app's own kinds are its **sub-spec**: the same `PostEnvelope<K>`
under the app's namespace, defined by the app's own crate, built from `pubky_social_specs::subspec`.
The public sub-specs are `music` (`pubky-music-specs`, in the music node's repository) and, in this
workspace, `maps`, `events` and `marketplace` (`subspecs/`). These are the rules every sub-spec
follows.

## Paths and namespaces

- A version is `/{pub,priv}/<ns>/v1/posts/{id}/{editId}[-{slug}].json`, a post as references name it
  `pubky://{owner}/{pub,priv}/<ns>/v1/posts/{id}`, versionless. Social's mint, edit and read
  (`create_version_under`, `edit_version_under`, `subspec::read_version`) are the sub-spec's.
- A namespace is short and lowercase: 1 to 32 characters of `a-z`, `0-9` and `-`, starting with a
  letter (`subspec::validate_namespace`). It names the spec, not a domain, so it has no dot;
  `social` is reserved. One namespace per app family, picked by the app.
- `/priv/<app domain>/…` (as `/priv/pubky.music/`) is app data: the app's code alone reads it, no
  spec defines it and no indexer reads it. A private record of a sub-spec kind is
  `/priv/<ns>/v1/posts/…`.

## The kind set

- A `PostKind` enum with a catch-all, `Unknown(String)`: a kind a newer writer used reads and
  fails validation. `subspec_names!` gives it, and every closed set, social's wire behaviour: an
  unknown name is kept with its spelling and written back, and the rules refuse it with
  `{field} must be one of {names}: {name}`.
- Every refusal starts with `Validation Error: `. Builders trim display text; readers accept the
  stored bytes or refuse them, never rewrite. Unknown members are preserved on rewrite (an
  `extra` map, flattened, through `subspec::check_extra`). Every integer is within the JSON-safe
  range.
- Bounds before content: the raw content cap runs on the string before it is parsed and every
  list cap before any item of the list is read, both in `PostKind::check_counts`.
- Every URI inside `content` is a reference position: `PostKind::content_references` reports it
  and the envelope's gate checks it (canonical spelling, a public post never references a private
  object, the ownership rule with the author). A rule that needs the author is
  `PostKind::check_owner`.

## Values

| value | rule |
| --- | --- |
| an instant | `*_at`, integer microseconds since the epoch, as social's ids and `created_at` count |
| a duration | an integer whose name ends in its unit: `_ms` for media, `_s` for travel and timers, `_days` for terms. An ISO 8601 duration only where JSCalendar names the member (`duration`) |
| a place | a URI in a reference position: a canonical OpenStreetMap object URL or a `geo:` pin, under social's place conventions (`places::check_place_reference`); any other reference passes |
| money | `{ amount_minor, currency, exponent }`, an integer of the minor unit |
| a member name | a standard's names where one exists (JSCalendar's camelCase for times), else snake_case |
| a cover image | `attachments[0]` |
| another spec's member on an object | `ext.<ns>`: the key under `ext` is the writer's spec namespace (`ext.marketplace` on a rating) |

## Shared primitives: never copy them

They work on any URI, and an app's readers, other apps and the indexer's counts all see them. A
sub-spec uses them and defines no kind that repeats one.

| primitive | where | for |
| --- | --- | --- |
| tags | `/pub/social/v1/tags/{hash(uri:label)}.json` | labels and keywords on any URI |
| replies | a post's `parent` | comments, answers, review responses |
| embeds | a post's `embed` | quoting a resource |
| bookmarks | `/priv/social/v1/bookmarks/{base64url target}.json` | saved things, watchlists |
| collections | the social `collection` kind | lists, calendars, playlists of URIs |
| rating | the social `rating` kind, 1 to 10 half stars, `parent` the thing | reviews of a place, a track, a listing, an event |
| event, rsvp | the social `event` and `rsvp` kinds | anything with a time people attend |
| files and attachments | `/…/social/v1/files/`, a post's `attachments` | photos, media |
| lock | a post's `lock` | gated content |

## Feed-only kinds

Nexus gives a durable app kind a generic graph node (namespace, kind, author, its `parent` and
`embed` edges, no content) and a reference-feed line `{ op, author, path, namespace, kind }`. A kind
a sub-spec marks feed-only gets the line only. A sub-spec crate exports
`pub const FEED_ONLY_KINDS: &[&str]`, the kinds' wire names, and `is_feed_only()` on its kind enum.
Mark a kind feed-only when it is state rather than a post people answer: one current version per
author, or a stream of moments, with no edges of its own, read by an index that takes it from the
feed line (music's `listening`, events' `availability`). Every other kind is durable.

## What a sub-spec crate ships

`NAMESPACE`, the kind enum and its `PostKind` impl, the content rules, `FEED_ONLY_KINDS`, its limits
as one pinned table, the path builders (`version_path`, `post_uri`, `parse_post_uri`) and the
builders; unit tests; vector files (`subspec::vectors`: one JSON document per line,
`{ name, url, body, verdict }`, checked by the crate's tests and readable by another
implementation); and a short README of its paths, its kinds and the shared primitives it uses
instead of its own copies.
