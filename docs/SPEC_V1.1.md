# pubky-social-specs 1.1: events, availability, ratings and places

The 1.1 release adds four post kinds to the `social/v1` envelope, `event`, `rsvp`, `availability`
and `rating`, and two writer conventions for places. They are the kinds other apps must read: an
event any app lists, the answers to it, when a person or a resource can be booked, and stars on
any thing. A kind only its own app reads (a route, a listing) is that app's sub-spec, on the same
envelope under its own namespace; `SUBSPECS.md` holds the rules every sub-spec follows. Nothing in
1.0 changes: the envelope, its reference gate, the ids, the paths and every 1.0 kind are as
`v1` left them, and a 1.0 reader reads a 1.1 post as a post of a kind it does not know and skips
it. This document is normative for the new kinds; the 1.0 design is in the `v1` RFC and the
layout of 0.x data in `SPEC_V0.md`.

Terms: a **kind** is `post.kind`; an **envelope** is the JSON document in `post.content` of a
typed kind; a **reference** is a URI in a position the reference gate checks (`parent`, `embed`,
`lock`, an attachment, and the positions each envelope names); the **universal tier** is the
gate's widest scheme set, any scheme-shaped URI; a **cap** is a value of the limits table,
named here as `VALIDATION_LIMITS` names it and exported to the npm package under the camelCase
spelling.

Every rule below is checked by both implementations, the Rust crate and the npm package, with
the same message, and every refusal starts with `Validation Error: `. Builders trim display
text and fold labels; readers accept the stored bytes or refuse them and never rewrite.

## Part A: Events, availability and ratings

Four kinds. `event` and `rsvp` are required of a client that shows events; `availability` and
`rating` are optional. Member names follow JSCalendar (RFC 8984) wherever JSCalendar has one, so
an iCalendar import or export is a rename. Times are local: a `start` is a wall-clock time in the
object's `timeZone`, and the indexer computes the instant. The crate admits the values; it never
evaluates a recurrence or resolves a zone.

### A1. JSCalendar values

Three value grammars, shared by `event`, `rsvp` and `availability`, and public for a sub-spec
whose own kinds carry times.

| value | grammar | refused |
|---|---|---|
| local date-time | `YYYY-MM-DDTHH:MM:SS`: a real calendar date (leap years included), hours 00 to 23, minutes and seconds 00 to 59, year 0001 or later | an offset or `Z`, a fraction of a second, a date alone, padding |
| duration | `PnW`, or `PnD`, `PTnHnMnS` and `PnDTnHnMnS` with each component optional and at least one present, every `n` 1 to 9 digits; in all at most `event_duration_max_seconds` (31622400, one leap year) | weeks with any other component, `PT` alone, a sign, a fraction of a second, `P1Y`, `P1M` |
| time zone | an IANA name: `Area/Location` segments of ASCII letters, digits, `_`, `+` and `-`, the first character a letter, at most `event_time_zone_max_length` (64) code points | an offset, an empty segment, non-ASCII |

Whether a zone name is in the tz database is the reader's question: the database changes
several times a year and a frozen copy would refuse real zones. Fractions of a second and leap
seconds are refused so one instant has one spelling.

A **recurrence rule** is a JSCalendar `RecurrenceRule` with these members, any other member
preserved as unknown:

| member | rule |
|---|---|
| `frequency` | `yearly`, `monthly`, `weekly` or `daily`; the sub-daily frequencies are refused, an occurrence index cannot hold them |
| `interval` | 1 to `event_recurrence_interval_max_periods` (1000); absent is 1 |
| `firstDayOfWeek` | `mo` to `su` |
| `byDay[]` | `{ day, nthOfPeriod? }`, `day` `mo` to `su`, `nthOfPeriod` -53 to 53 and never 0; at most `event_recurrence_by_max_count` (31) entries |
| `byMonthDay[]` | integers -31 to 31, never 0; at most 31 entries |
| `byMonth[]` | strings `"1"` to `"12"`; at most 31 entries |
| `bySetPosition[]` | integers -366 to 366, never 0; at most 31 entries |
| `count` | 1 to `event_recurrence_max_occurrences` (1000) |
| `until` | a local date-time, on or after the start and at most `event_recurrence_max_span_years` (3 calendar years) after it |

The two recurrence caps are the design's: an occurrence generator stops at 1,000 occurrences or
three years, whichever comes first, and the rule's own `count` and `until` cannot ask for more. A
rule with neither `count` nor `until` is open-ended and the generator caps it. The three-year
horizon is counted on the calendar: `(start.year + 3, start.month, start.day, start.time)`, so a
rule starting on a leap day may run to 28 February three years on.

### A2. `event`

An event someone creates on Pubky is a post of kind `event`. The envelope:

```json
{
  "title": "Lugano Bitcoin Evening",
  "description": "Monthly meetup. Talks start at 19:00.",
  "start": "2026-10-14T18:30:00", "timeZone": "Europe/Zurich", "duration": "PT2H30M", "showWithoutTime": false,
  "status": "confirmed",
  "locations": [{ "name": "Plan ₿ Hub", "uri": "https://www.openstreetmap.org/way/481516234" }],
  "attendance": { "policy": "open", "capacity": null, "waitlist": false },
  "links": [{ "title": "Website", "url": "https://planb.network/" }],
  "recurrenceRules": [{ "frequency": "monthly", "byDay": [{ "day": "tu", "nthOfPeriod": 2 }] }],
  "excludedDates": []
}
```

| member | rule |
|---|---|
| `title` | trimmed by the builder; 1 to `event_title_max_length` (100) code points, not blank, no control character but tab, newline and carriage return |
| `description` | Markdown, as an article body; trimmed by the builder, a blank one absent; at most `event_description_max_length` (50000) code points, the same control rule; absent for none |
| `start` | a local date-time in `timeZone`; required |
| `timeZone` | an IANA zone name; required |
| `duration` | a duration; required unless `showWithoutTime` is true |
| `showWithoutTime` | boolean; an all-day event, whose start time is not shown; false when absent |
| `status` | `confirmed`, `tentative` or `cancelled`; `confirmed` when absent |
| `locations[]` | `{ name?, uri }`; `uri` a reference on the universal tier (a place as B1 spells it, an https meeting link, or any other resource), `name` trimmed, 1 to `event_location_name_max_length` (100) code points when present; at most `event_locations_max_count` (10) |
| `attendance` | `{ policy, capacity, waitlist }`: `policy` one of `open`, `approval`, `invite`, `ticket`; `capacity` an integer 1 to `event_capacity_max_people` (1000000) or null for no limit; `waitlist` boolean. Open with no limit and no waitlist when absent |
| `links[]` | `{ title, url }`, as a profile's links are; `title` trimmed, 1 to `event_link_title_max_length` (100) code points; `url` an https URL of at most `event_link_url_max_length` (300) code points, `http://` refused; at most `event_links_max_count` (10) |
| `recurrenceRules[]` | at most `event_recurrence_rules_max_count` (1) rule, as A1 |
| `excludedDates[]` | local date-times removed from the series; at most `event_excluded_dates_max_count` (100) |
| `recurrenceOf`, `recurrenceId` | on an override of one occurrence only, set together: `recurrenceOf` a versionless pubky post reference to the master event, by the same author; `recurrenceId` the occurrence's local start. An override carries no `recurrenceRules` and no `excludedDates` |

The raw envelope string is bounded at `event_content_max_length` (150000) code points before it
is parsed. The envelope carries the rest: the cover is `attachments[0]`, categories are tags,
`parent` and `embed` are unset (refused when present), `lock` is set when details are guarded.
The event id is the post id and edits are versions.

The list caps run before any reference inside the lists is read, as the collection's item cap
does. Every `locations[].uri`, `links[].url` and `recurrenceOf` then runs through the
envelope's reference gate: canonical spelling, the root rule (a public event never references a
private object), the ownership rule where the author is in scope, the versionless rule. After the
gate, a location that names a place takes the place conventions (Part B), and a link must be
https.

The same-author rule on `recurrenceOf` needs the author, which plain validation has no access
to: the builders (`create_version`, `buildPost`) and ingest by URI (`PubkySocialObject::from_uri`,
`decodeObject` with a URL) check it; `validate` and `validatePost` without an owner do not.
This is the same scope the private-reference ownership rule has.

**Recurrence.** One rule, the generator capped as A1 says; `excludedDates` removes occurrences.
An override is a separate `event` by the same author with `recurrenceOf` the master and
`recurrenceId` the occurrence's local start; it replaces that occurrence entirely, one override
per occurrence, the newest wins, deleting it restores the generated occurrence, and an override
whose occurrence the master no longer generates is an ordinary post. These are indexer rules;
the spec admits the shape.

**Storage and visibility.** `/pub/social/v1/posts/…` is indexed; `/priv/social/v1/posts/…` is
the owner's. A guarded event is a `/pub` teaser with `lock` set and a second `event` under the
lock's guarded storage with what the teaser withholds; the client merges the two for an entitled
reader. There is no visibility flag on the object.

**Calendars are collections.** There is no calendar kind. A calendar is a 1.0 `collection`
whose items are event URIs: name, description, cover, layout, at most 100 items, owner-written,
taggable, public or private. Items are universal, so an external event (a Luma or Meetup page, a
feed) sits in a calendar next to `event` posts.

### A3. `rsvp`

An answer to an event: a reply whose `parent` is the event's versionless URI. `parent` is
required; the envelope's gate admits any universal reference, and which targets are events is
the indexer's question (an answer to an external event page is the same post). `embed` and
`attachments` are refused.

```json
{ "status": "accepted", "recurrenceId": "2026-11-10T18:30:00", "guests": 1, "note": "bringing cake" }
```

| member | rule |
|---|---|
| `status` | `requested`, `accepted`, `declined` or `tentative`; required |
| `recurrenceId` | a local date-time, the occurrence answered; absent for the series |
| `guests` | an integer 0 to `rsvp_guests_max_people` (100), companions without an account; 0 when absent |
| `note` | trimmed by the builder, a blank one absent; at most `rsvp_note_max_length` (2000) code points; absent for none |

The raw envelope is bounded at `rsvp_content_max_length` (5000) code points. One rsvp per
author per event or occurrence: the client edits its post, the indexer keeps the newest version.
`requested` is how a person asks under `policy: approval` or `invite`; the client flips it to
`accepted` once it holds the entitlement. Guests count toward `capacity` and the waitlist under
`open`, `approval` and `invite`, and are ignored under `ticket`, where one ticket is one person.

### A4. `rating` (optional)

Stars on a thing: a reply whose `parent` is what is rated, any universal reference (a place, an
event, a listing, a link). `parent` is required; `embed` is refused; attachments are allowed
(photos). One per author per target, the newest version wins. A post with stars is a rating; one
without is a plain reply to the same parent.

```json
{ "rating": 7, "text": "great coffee" }
```

| member | rule |
|---|---|
| `rating` | an integer `rating_min_half_stars` (1) to `rating_max_half_stars` (10), shown as half stars up to five: 10 is five stars; required |
| `text` | trimmed by the builder, a blank one absent; at most `rating_text_max_length` (2000) code points |

The raw envelope is bounded at `rating_content_max_length` (5000) code points. The scale is 1 to
10, whole half stars up to five, with no zero: a post without stars is a reply, not a rating of
none.

Every app rates through this kind, never a review kind of its own: a place (`parent` the
OpenStreetMap URL), a track, a listing or an event has one set of ratings that every reader and
the indexer's counts see. What an app adds to a rating (the marketplace's purchase attestation)
travels in the post's `ext` member, outside `content`, under the app's namespace,
`ext.<namespace>`, preserved by every reader as an unknown member.

### A5. `availability` (optional)

When a person, or a resource of theirs, can be booked: a public, coarse schedule the client
derives from its private calendar and its bookings. `parent`, `embed` and `attachments` are
refused.

```json
{
  "timeZone": "Europe/Zurich", "horizonDays": 60,
  "for": "pubky://<owner>/pub/marketplace/v1/posts/0032SSN7Q4EVG",
  "available": [{ "title": "Double room", "start": "2026-10-19T14:00:00", "duration": "P1D", "capacity": 12,
                  "recurrenceRules": [{ "frequency": "daily" }] }],
  "busy": [{ "start": "2026-10-24T14:00:00", "duration": "P2D" }]
}
```

| member | rule |
|---|---|
| `timeZone` | an IANA zone name every block is read in; required |
| `horizonDays` | an integer 1 to `availability_horizon_max_days` (366); required |
| `for` | a reference on the universal tier, the resource the schedule belongs to (a room type, a listing, a staff member, a place); absent for the author |
| `available[]`, `busy[]` | blocks, at most `availability_blocks_max_count` (100) each |

A block is `{ title?, start, duration, capacity?, recurrenceRules?, excludedDates? }`: `start` a
local date-time, `duration` a duration (required), `recurrenceRules` at most one rule as A1
measured from the block's start, `excludedDates` at most 100 local date-times. `title` and
`capacity` are allowed on an `available` block only, and refused on a `busy` one: `title` trimmed,
1 to `availability_block_title_max_length` (100) code points; `capacity` the units free in the
block (rooms of a type, seats), an integer 1 to `availability_capacity_max_units` (10000), absent
for 1. The raw envelope is bounded at `availability_content_max_length` (100000) code points.

One current availability per author per `for`, an absent `for` meaning the author: the client edits
its post, the indexer keeps the newest version of each. A hotel writes one per room type, a
business one per bookable resource or staff member. Slots are derived, never stored: `available`
minus `busy` minus open reservations.

The kind is the shared public view of a schedule and nothing more. Prices, minimum stays, slot
lengths and booking rules are app data: an app that needs them extends the post with
`ext.<namespace>`, or defines a richer kind of its own in its sub-spec, and keeps a social
availability as the public view where it can.

## Part B: Places

Two writer conventions. Nothing about location enters the envelope: a located post is a post
whose `parent` or `embed` is a located resource, so nobody can misplace a thing, and collections
hold places because their items are universal. A sub-spec's place positions (the maps
sub-spec's route waypoints) take the same conventions through the crate's `places` module.

### B1. The conventions

Every writer lands on one resource without any folding in the indexers:

- An **OpenStreetMap place** is written as `https://www.openstreetmap.org/{node|way|relation}/{id}`,
  with no trailing slash, query or fragment, the id a positive integer with no leading zeros and
  within the JSON-safe range. Map links without an object (`?mlat=`, `go/` short links, a bare
  `#map=`), other hosts (`openstreetmap.org`, `osm.org`), `http://` and any other spelling name a
  view or a mirror, not a place; the client turns them into a `geo:` pin or a reverse lookup
  before writing.
- A **coordinate** is written as `geo:<lat>,<lon>` in decimal degrees: no sign on zero, no
  leading zeros, at most `geo_fraction_max_digits` (5) fraction digits (about a metre), no
  trailing zeros, no altitude and no parameters, latitude within 90 and longitude within 180. A
  deliberately rough spot is fewer digits: three is about 100 m, two about 1 km. Both
  implementations spell a point the same way (`geo_uri` / `geoUri`: rounding half up), and read
  the spelling back (`is_geo_uri` / `isGeoUri`).

| input | verdict |
|---|---|
| `https://www.openstreetmap.org/way/481516234` | a place, way 481516234 |
| `https://www.openstreetmap.org/way/481516234/` | not a place (trailing slash) |
| `https://www.openstreetmap.org/#map=19/46.0/8.9` | not a place (a view) |
| `https://osm.org/way/481516234`, `http://www.openstreetmap.org/way/481516234` | not a place (another spelling of the host) |
| `geo:46.00547,8.95186` | a pin |
| `geo:46,8` | a pin, about a degree |
| `geo:46.0,8`, `geo:046,8`, `geo:-0,8`, `geo:46,8;u=35`, `geo:46,8,100`, `geo:91,8` | not a pin |

**Where the conventions are enforced.** In the place positions of the new kinds, an event's
`locations[].uri`, and of a sub-spec's kinds, after the universal gate: a `geo:` URI there
must be the convention's spelling, and a URL on an OpenStreetMap host must be the canonical
object URL; every other reference passes. In `parent`, `embed`, tag targets and collection
items the 1.0 gate stands alone, so a post stored before 1.1 reads as it did; the conventions
are what a 1.1 client writes there.

## Part C: What a reader does

- A 1.0 reader meets a 1.1 post as a kind it does not know: it reads, it fails validation, it
  skips. Nothing it stored reads differently. A 1.1 reader meets a `route` under `social` the
  same way, as a kind social does not know: it is the maps sub-spec's, under `/pub/maps/v1/`.
- A 1.1 reader checks the envelope of each new kind as Parts A and B say, unknown members
  preserved, and writes a post back byte for byte.
- **Bounds before content.** A 1.1 kind's raw content cap is checked on the string before the
  envelope is parsed, and its list caps (an event's `locations` and `links`) before any reference
  in the list is read. For a 1.1 kind the publish planner
  checks the post's byte cap, its attachment count and these caps before it reads a single
  reference, so an oversized version is refused by its cap and never walked. The 1.0 kinds keep
  the order 1.0 shipped, in validation and in the planner: a 1.0 post past a cap with a private
  reference is refused for the reference, as 1.0 refused it.
- Every integer in an envelope is an `i64` on the wire, within the JSON-safe range; a value
  outside its own range is that member's refusal, worded the same in both implementations.
- The closed sets (`status`, `attendance.policy`, an rsvp's `status`, a rule's `frequency` and
  weekdays) are refused when a spelling this version does not know is stored: an indexer cannot
  place an event whose status it cannot read. This differs from `collection.layout`, which
  degrades to no constraint, because these members carry meaning the indexer acts on.

## Part D: Limits added in 1.1

| limit | value |
|---|---|
| `event_title_max_length` | 100 |
| `event_description_max_length` | 50000 |
| `event_content_max_length` | 150000 |
| `event_time_zone_max_length` | 64 |
| `event_duration_max_seconds` | 31622400 |
| `event_locations_max_count` | 10 |
| `event_location_name_max_length` | 100 |
| `event_links_max_count` | 10 |
| `event_link_title_max_length` | 100 |
| `event_link_url_max_length` | 300 |
| `event_capacity_max_people` | 1000000 |
| `event_recurrence_rules_max_count` | 1 |
| `event_recurrence_max_occurrences` | 1000 |
| `event_recurrence_max_span_years` | 3 |
| `event_recurrence_interval_max_periods` | 1000 |
| `event_recurrence_by_max_count` | 31 |
| `event_excluded_dates_max_count` | 100 |
| `rsvp_guests_max_people` | 100 |
| `rsvp_note_max_length` | 2000 |
| `rsvp_content_max_length` | 5000 |
| `availability_horizon_max_days` | 366 |
| `availability_blocks_max_count` | 100 |
| `availability_block_title_max_length` | 100 |
| `availability_capacity_max_units` | 10000 |
| `availability_content_max_length` | 100000 |
| `rating_min_half_stars` | 1 |
| `rating_max_half_stars` | 10 |
| `rating_text_max_length` | 2000 |
| `rating_content_max_length` | 5000 |
| `geo_fraction_max_digits` | 5 |
