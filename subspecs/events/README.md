# pubky-events-specs

The events sub-spec of Pubky social: the kind an events or calendar app writes that no other app
must read, on the shared post envelope. It follows [`docs/SUBSPECS.md`](../../docs/SUBSPECS.md).

## Paths

| what | path |
| --- | --- |
| a version of a post | `/{pub,priv}/events/v1/posts/{id}/{editId}[-{slug}].json` |
| the post, as a reference names it | `pubky://{owner}/{pub,priv}/events/v1/posts/{id}` |

`version_path`, `post_uri` and `parse_post_uri` build and read them; `create_version`,
`edit_version` and `read_version` mint, edit and read a version as social does.

## Kinds

| kind | what | feed-only |
| --- | --- | --- |
| `availability` | when a person, or a resource of theirs, can be booked | yes |

`FEED_ONLY_KINDS` is `["availability"]`: an indexer forwards it as a feed line and gives it no
graph node. An availability is state rather than a post people answer: one current version per
author, rewritten as bookings come and go, with no `parent`, `embed` or attachment to make an edge
of. Its reader is the time index, which takes it from the feed line.

### `availability`

The shape the social 1.1 drafts had, moved as is; only the namespace changed. Member names are
JSCalendar's (RFC 8984), and every time value takes social's JSCalendar rules
(`pubky_social_specs::jscalendar`): a local date-time, a duration, an IANA zone name, a recurrence
rule. `parent`, `embed` and `attachments` are refused.

```json
{
  "timeZone": "Europe/Zurich", "horizonDays": 60,
  "for": "pubky://<owner>/pub/marketplace/v1/posts/0032SSN7Q4EVG",
  "available": [{ "title": "Office hours", "start": "2026-10-19T09:00:00", "duration": "PT8H",
                  "recurrenceRules": [{ "frequency": "weekly", "byDay": [{ "day": "mo" }, { "day": "tu" }] }] }],
  "busy": [{ "start": "2026-10-21T14:00:00", "duration": "PT1H" }]
}
```

| member | rule |
| --- | --- |
| `timeZone` | an IANA zone name every block is read in; required |
| `horizonDays` | an integer 1 to 366; required |
| `for` | a universal reference, the resource the schedule belongs to (a listing, a room, a place); absent for the author |
| `available[]`, `busy[]` | blocks, at most 100 each |

A block is `{ title?, start, duration, recurrenceRules?, excludedDates? }`: `start` a local
date-time, `duration` a JSCalendar duration of at most one leap year (required), at most one
recurrence rule measured from the block's start, at most 100 excluded dates. `title` is allowed on
an `available` block only (1 to 100 code points); a `busy` block is untitled. The raw content is
bounded at 100000 code points before it is parsed. Slots are derived, never stored: `available`
minus `busy` minus open reservations. The caps of this kind are `EVENTS_LIMITS`; the time caps are
social's `event_*` limits, so a block and an event repeat under one rule.

## What events uses instead of its own copies

| an events app wants | it writes | not |
| --- | --- | --- |
| an event | a social `event`: every app lists it, and the indexer places it in time | an event kind of its own |
| an answer, a ticket request | a social `rsvp` whose `parent` is the event | an attendance kind |
| a calendar | a social `collection` whose items are event URIs, `/pub` or `/priv` | a calendar kind |
| a review of an event | a social `rating` whose `parent` is the event | a review kind |
| a venue | a place URI in the event's `locations[]`, under social's place conventions | a venue kind |
| a label ("meetup", "workshop") | a social tag on the event's URI | categories in the event |
| a saved event | a private social bookmark | a favourites file |

## Tests and vectors

`cargo test -p pubky-events-specs` runs the unit tests and checks `vectors/availability.jsonl`:
one JSON document per line, `{ name, url, body, verdict }`. `RECORD_VECTORS=1 cargo test -p
pubky-events-specs --test vectors` rewrites it after a deliberate change.
