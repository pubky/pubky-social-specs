# Reference

Generated from the package by `qa/docs.mjs`; `npm run docs:check` fails when it is stale. Every
text below is the doc an editor shows on hover.

## Limits

`limits`, exported from the package. A builder, a validator and `decodeObject` refuse past each
one with a `ValidationError` whose `code` is `length`, `count` or `size` and whose `limit` is
the value here. A length counts Unicode code points, not UTF-16 units and not bytes.

| name | value | unit | what it bounds |
|---|---|---|---|
| `articleBodyMaxLength` | 50000 | code points | The longest article body. |
| `articleContentMaxLength` | 104000 | code points | The longest `content` of an article post, the whole envelope as text. |
| `articleTitleMaxLength` | 100 | code points | The longest article title. |
| `attachmentAltMaxLength` | 1000 | code points | The longest `alt` text of an attachment. |
| `attachmentNameMaxLength` | 255 | code points | The longest `name` of an attachment. |
| `availabilityBlockTitleMaxLength` | 100 | code points | The longest `title` of an available block. |
| `availabilityBlocksMaxCount` | 100 | items | The most blocks in each of an availability's `available` and `busy`. |
| `availabilityContentMaxLength` | 100000 | code points | The longest `content` of an availability post, the whole envelope as text. |
| `availabilityHorizonMaxDays` | 366 | days | The furthest ahead an availability's `horizonDays` reaches, one leap year. |
| `bookmarkTargetUriMaxBytes` | 187 | bytes | The longest target a primary bookmark spells in its filename; a longer one takes the overflow form, `~{hash}`. |
| `collectionContentMaxLength` | 40000 | code points | The longest `content` of a collection post, the whole envelope as text. |
| `collectionDescriptionMaxLength` | 500 | code points | The longest collection description. |
| `collectionItemNoteMaxLength` | 1000 | code points | The longest note on a collection item. |
| `collectionItemsMaxCount` | 100 | items | The most items in a collection. |
| `collectionNameMaxLength` | 100 | code points | The longest collection name. |
| `collectionNameMinLength` | 1 | code points | The shortest collection name. |
| `eventCapacityMaxPeople` | 1000000 | people | The largest `attendance.capacity` of an event. |
| `eventContentMaxLength` | 150000 | code points | The longest `content` of an event post, the whole envelope as text. |
| `eventDescriptionMaxLength` | 50000 | code points | The longest event description. |
| `eventDurationMaxSeconds` | 31622400 | seconds | The longest `duration` of an event or an availability block, one leap year. |
| `eventExcludedDatesMaxCount` | 100 | items | The most `excludedDates` on an event or an availability block. |
| `eventLinkNameMaxLength` | 100 | code points | The longest `name` of an event link. |
| `eventLinkUrlMaxLength` | 300 | code points | The longest `url` of an event link. |
| `eventLinksMaxCount` | 10 | items | The most `links` on an event. |
| `eventLocationNameMaxLength` | 100 | code points | The longest `name` of an event location. |
| `eventLocationsMaxCount` | 10 | items | The most `locations` on an event. |
| `eventRecurrenceByMaxCount` | 31 | items | The most entries in each `by*` list of a recurrence rule. |
| `eventRecurrenceIntervalMaxPeriods` | 1000 | periods | The largest `interval` of a recurrence rule. |
| `eventRecurrenceMaxOccurrences` | 1000 | occurrences | The largest `count` of a recurrence rule, where the occurrence generator stops too. |
| `eventRecurrenceMaxSpanYears` | 3 | years | The furthest a recurrence rule's `until` may lie after the start, where the occurrence generator stops too. |
| `eventRecurrenceRulesMaxCount` | 1 | items | The most `recurrenceRules` on an event or an availability block. |
| `eventTimeZoneMaxLength` | 64 | code points | The longest IANA time zone name, an event's or an availability's `timeZone`. |
| `eventTitleMaxLength` | 100 | code points | The longest event title. |
| `feedIconMaxLength` | 50 | code points | The longest feed icon name. |
| `feedNameMaxLength` | 100 | code points | The longest feed name. |
| `feedTagsMaxCount` | 5 | items | The most labels in a feed's `tags`, and in its `domain_tags`. |
| `geoFractionMaxDigits` | 5 | digits | The most fraction digits of a `geo:` coordinate, about a metre. |
| `imageUrlMaxLength` | 300 | code points | The longest profile `image` and article or collection `cover_image`. |
| `maxFileSizeBytes` | 104857600 | bytes | The largest media file, 100 MiB. |
| `objectMaxBytes` | 65536 | bytes | The largest stored object other than a post, as stored. |
| `postAllowedAttachmentProtocols` | `"pubky"` `"http"` `"https"` |  | The schemes an attachment URI may have. |
| `postAttachmentsMaxCount` | 10 | items | The most attachments on a post. |
| `postMaxBytes` | 524288 | bytes | The largest stored post, as stored. |
| `postNoteContentMaxLength` | 2000 | code points | The longest `content` of a post of any kind but an article or a collection. |
| `postSlugMaxLength` | 64 | code points | The longest slug of a post version. |
| `ratingContentMaxLength` | 5000 | code points | The longest `content` of a rating post, the whole envelope as text. |
| `ratingMaxHalfStars` | 10 | half stars | The highest `rating`, five stars. |
| `ratingMinHalfStars` | 1 | half stars | The lowest `rating`, one half star. |
| `ratingTextMaxLength` | 2000 | code points | The longest `text` of a rating. |
| `referenceUriMaxLength` | 1024 | code points | The longest reference: a `parent`, an `embed`, a `lock`, an attachment or a collection item. |
| `routeContentMaxLength` | 400000 | code points | The longest `content` of a route post, the whole envelope as text. |
| `routeDescriptionMaxLength` | 2000 | code points | The longest route description. |
| `routeDistanceMaxMetres` | 100000000 | metres | The longest `distance_m` of a route or a step. |
| `routeDurationMaxSeconds` | 315360000 | seconds | The longest `duration_s` of a route or a step, ten years. |
| `routeElevationMaxMetres` | 100000 | metres | The largest `elevation_gain_m` and `elevation_loss_m` of a route. |
| `routeLabelMaxLength` | 50 | code points | The longest `polyline.engine` and `polyline.profile` of a route. |
| `routeNameMaxLength` | 100 | code points | The longest route name. |
| `routePolylineMaxLength` | 100000 | code points | The longest `polyline.encoded` of a route. |
| `routeStepInstructionMaxLength` | 200 | code points | The longest `instruction` of a route step. |
| `routeStepsMaxCount` | 500 | items | The most `steps` on a route. |
| `routeWaypointNameMaxLength` | 100 | code points | The longest `name` of a route waypoint. |
| `routeWaypointsMaxCount` | 100 | items | The most `waypoints` on a route. |
| `routeWaypointsMinCount` | 2 | items | The fewest `waypoints` on a route, a start and an end. |
| `rsvpContentMaxLength` | 5000 | code points | The longest `content` of an rsvp post, the whole envelope as text. |
| `rsvpGuestsMaxPeople` | 100 | people | The most `guests` on an rsvp. |
| `rsvpNoteMaxLength` | 2000 | code points | The longest `note` of an rsvp. |
| `tagInvalidChars` | `","` `":"` `" "` `"\t"` `"\n"` `"\r"` |  | The characters a tag label may not hold. |
| `tagLabelMaxLength` | 20 | code points | The longest tag label. |
| `tagLabelMinLength` | 1 | code points | The shortest tag label. |
| `userBioMaxLength` | 160 | code points | The longest profile bio. |
| `userLinkTitleMaxLength` | 100 | code points | The longest title of a profile link. |
| `userLinkUrlMaxLength` | 300 | code points | The longest URL of a profile link. |
| `userLinksMaxCount` | 5 | items | The most links on a profile. |
| `userNameMaxLength` | 50 | code points | The longest profile name. |
| `userNameMinLength` | 3 | code points | The shortest profile name. |
| `userStatusMaxLength` | 50 | code points | The longest profile status. |

## Media types

The declared type of a file picks the extension of its path and is never stored. A type is
matched on its essence: the text before any `;`, ASCII-lowercased. Any type not below, an empty
one included, gets `.bin`.

| type | extension |
|---|---|
| `application/javascript` | `.js` |
| `application/json` | `.json` |
| `application/octet-stream` | `.bin` |
| `application/pdf` | `.pdf` |
| `application/x-www-form-urlencoded` | `.bin` |
| `application/xml` | `.xml` |
| `application/zip` | `.zip` |
| `audio/mpeg` | `.mp3` |
| `audio/wav` | `.wav` |
| `image/gif` | `.gif` |
| `image/jpeg` | `.jpg` |
| `image/png` | `.png` |
| `image/svg+xml` | `.svg` |
| `image/webp` | `.webp` |
| `multipart/form-data` | `.bin` |
| `text/css` | `.css` |
| `text/csv` | `.csv` |
| `text/html` | `.html` |
| `text/plain` | `.txt` |
| `text/xml` | `.xml` |
| `video/mp4` | `.mp4` |
| `video/mpeg` | `.mpeg` |

## Stored objects

Each object as `decodeObject` gives it and `encodeObject` takes it. Every known member is
present, `null` when it has no value, and `$unknown` carries members a newer writer added, as
text. Integers are numbers; `created_at` is microseconds since the epoch.

### User

A profile, stored at `/pub/social/v1/profile.json`: one per owner, public.

| member | type | null | meaning |
|---|---|---|---|
| `links` | `UserLink[]` | yes | At most 5 links shown on the profile; null for none. |
| `name` | `string` |  | The display name, trimmed by the builder: 3 to 50 code points, not blank. |
| `bio` | `string \| number` | yes | A short description, trimmed by the builder: at most 160 code points; null for none. |
| `image` | `string \| number` | yes | The avatar: a canonical pubky or web URI of at most 300 code points, never under the private root; null for none. |
| `status` | `string \| number` | yes | A status line, trimmed by the builder: at most 50 code points; null for none. |
| `$unknown` (optional) | `string` |  | The members a newer writer added, as the text they were read with. Carry it along. |

### UserLink

One link on a profile.

| member | type | null | meaning |
|---|---|---|---|
| `title` | `string` |  | The link's label, trimmed by the builder: 1 to 100 code points, not blank. |
| `url` | `string` |  | A canonical `http://` or `https://` URL, stored as written: at most 300 code points. |
| `$unknown` (optional) | `string` |  | The members a newer writer added, as the text they were read with. Carry it along. |

### Post

One version of a post, stored at `posts/{id}/{editId}[-slug].json` under the public or the private root. `id` and `editId` are in the path, not in the object.

| member | type | null | meaning |
|---|---|---|---|
| `kind` | `"image" \| "note" \| "article" \| "video" \| "link" \| "file" \| "collection" \| "event" \| "rsvp" \| "availability" \| "rating" \| "route"` |  | What the post is, one of `postKinds`: a kind this version does not know is refused on read. It decides what `content` holds. |
| `attachments` | `Attachment[]` |  | At most 10 media references; empty for none. A collection carries none: its items are in its envelope. |
| `content` | `string` |  | Text for an untyped kind; for an article or a collection, the envelope `decodeContent` reads. |
| `parent` | `string \| number` | yes | The post this one replies to: a versionless reference of at most 1024 code points; null for none. |
| `embed` | `string \| number` | yes | The post or URI this one quotes: a versionless reference of at most 1024 code points; null for none. |
| `lock` | `string \| number` | yes | A pubky reference to what gates the post (a payment or a membership), at most 1024 code points; null for none. Readers that do not honour it show the post as it is. |
| `$unknown` (optional) | `string` |  | The members a newer writer added, as the text they were read with. Carry it along. |

### Attachment

One media reference of a post.

| member | type | null | meaning |
|---|---|---|---|
| `uri` | `string` |  | The media: a canonical `pubky`, `http` or `https` URI of at most 1024 code points, under the post's root rules. |
| `alt` | `string \| number` | yes | Text describing the media for a screen reader: at most 1000 code points; null for none. |
| `name` | `string \| number` | yes | The file name shown, trimmed by the builder: 1 to 255 code points, not blank; null for none. |
| `$unknown` (optional) | `string` |  | The members a newer writer added, as the text they were read with. Carry it along. |

### ArticleContent

The envelope of an article, inside its post's `content`: read it with `decodeContent`.

| member | type | null | meaning |
|---|---|---|---|
| `title` | `string` |  | The title, trimmed by the builder: 1 to 100 code points, not blank, no control character but tab, newline and carriage return. |
| `body` | `string` |  | The text, Markdown by convention: at most 50000 code points, no control character but tab, newline and carriage return. |
| `cover_image` | `string \| number` | yes | A canonical `pubky`, `http` or `https` URI of an image, at most 300 code points; null for none. |
| `$unknown` (optional) | `string` |  | The members a newer writer added, as the text they were read with. Carry it along. |

### CollectionContent

The envelope of a collection, inside its post's `content`: read it with `decodeContent`.

| member | type | null | meaning |
|---|---|---|---|
| `items` | `CollectionItem[]` |  | At most 100 items, in the curator's order; empty for none. |
| `name` | `string` |  | The collection's name, trimmed by the builder: 1 to 100 code points, not blank. |
| `cover_image` | `string \| number` | yes | A canonical `pubky`, `http` or `https` URI of an image, at most 300 code points; null for none. |
| `description` | `string \| number` | yes | What it gathers, trimmed by the builder: at most 500 code points, not blank; null for none. |
| `layout` | `number \| CollectionLayout` | yes | How the creator would show it, one of `collectionLayouts`, or a newer writer's name kept as written; null for the reader's choice. |
| `$unknown` (optional) | `string` |  | The members a newer writer added, as the text they were read with. Carry it along. |

### CollectionItem

One entry of a collection.

| member | type | null | meaning |
|---|---|---|---|
| `uri` | `string` |  | What is curated: a versionless reference of any scheme (a pubky URL, a web URL or another scheme), at most 1024 code points. |
| `note` | `string \| number` | yes | The curator's note, trimmed by the builder: 1 to 1000 code points, not blank; null for none. |
| `$unknown` (optional) | `string` |  | The members a newer writer added, as the text they were read with. Carry it along. |

### EventContent

The envelope of an event, inside its post's `content`: read it with `decodeContent`. Member names are JSCalendar's.

| member | type | null | meaning |
|---|---|---|---|
| `status` | `"confirmed" \| "tentative" \| "cancelled"` |  | Whether the event is on, one of `eventStatuses`: a status this version does not know is refused on read. |
| `locations` | `EventLocation[]` |  | Where it is: at most 10 places or meeting links; empty for none. |
| `attendance` | `EventAttendance` |  | Who may come and how many. |
| `links` | `EventLink[]` |  | At most 10 links shown with the event, https only; empty for none. |
| `recurrenceRules` | `RecurrenceRule[]` |  | How it repeats: at most 1 rule; empty for a single event. |
| `title` | `string` |  | The title, trimmed by the builder: 1 to 100 code points, not blank, no control character but tab, newline and carriage return. |
| `description` | `string \| number` | yes | Markdown, as an article body, trimmed by the builder: at most 50000 code points, not blank; null for none. |
| `start` | `string` |  | When it starts, a local date-time `YYYY-MM-DDTHH:MM:SS` in `timeZone`. |
| `timeZone` | `string` |  | An IANA time zone name of at most 64 code points, such as `Europe/Zurich`. |
| `duration` | `string \| number` | yes | How long it lasts, an ISO 8601 duration `PnW` or `PnDTnHnMnS` of at most 31622400 seconds; required unless `showWithoutTime`; null for none. |
| `showWithoutTime` | `boolean` |  | An all-day event: the time of `start` is not shown and `duration` may be absent. |
| `excludedDates` | `string[]` |  | Occurrences removed from the series, each a local date-time in `timeZone`; at most 100. |
| `recurrenceOf` | `string \| number` | yes | On an override of one occurrence, the master event: a versionless post reference of the same author; null otherwise. Set together with `recurrenceId`. |
| `recurrenceId` | `string \| number` | yes | On an override of one occurrence, its local start in the master's series; null otherwise. |
| `$unknown` (optional) | `string` |  | The members a newer writer added, as the text they were read with. Carry it along. |

### EventLocation

One place or meeting link of an event.

| member | type | null | meaning |
|---|---|---|---|
| `name` | `string \| number` | yes | A name to show, trimmed by the builder: 1 to 100 code points, not blank; null for none. |
| `uri` | `string` |  | A reference to the place, any scheme: a canonical OpenStreetMap object URL, a `geo:` point as `geoUri` spells it, or an https meeting link; at most 1024 code points. |
| `$unknown` (optional) | `string` |  | The members a newer writer added, as the text they were read with. Carry it along. |

### EventAttendance

Who may come to an event and how many.

| member | type | null | meaning |
|---|---|---|---|
| `policy` | `"open" \| "approval" \| "invite" \| "ticket"` |  | How a person gets in, one of `attendancePolicies`: a policy this version does not know is refused on read. |
| `capacity` | `number` | yes | Seats, 1 to 1000000 people; null for no limit. |
| `waitlist` | `boolean` |  | Whether people past the capacity queue. |
| `$unknown` (optional) | `string` |  | The members a newer writer added, as the text they were read with. Carry it along. |

### EventLink

One link shown with an event, https only.

| member | type | null | meaning |
|---|---|---|---|
| `name` | `string` |  | A name to show, trimmed by the builder: 1 to 100 code points, not blank. |
| `url` | `string` |  | An https URL of at most 300 code points, stored as written. |
| `$unknown` (optional) | `string` |  | The members a newer writer added, as the text they were read with. Carry it along. |

### RecurrenceRule

A JSCalendar recurrence rule, as an event or an availability block repeats.

| member | type | null | meaning |
|---|---|---|---|
| `frequency` | `"yearly" \| "monthly" \| "weekly" \| "daily"` |  | How often, one of `recurrenceFrequencies`: a frequency this version does not know is refused on read. |
| `firstDayOfWeek` | `"mo" \| "tu" \| "we" \| "th" \| "fr" \| "sa" \| "su"` | yes | The first day of the week for a weekly rule, one of `weekdays`; null for the default. |
| `byDay` | `NthDay[]` |  | The weekdays, with which one of the period; at most 31 entries. |
| `byMonthDay` | `number[]` |  | Days of the month, -31 to 31 and never 0; at most 31 entries. |
| `bySetPosition` | `number[]` |  | Positions in the expanded period, -366 to 366 and never 0; at most 31 entries. |
| `interval` | `number` | yes | Every `interval`th period, 1 to 1000 periods; null for every period. |
| `byMonth` | `string[]` |  | Months, `"1"` to `"12"`; at most 31 entries. |
| `count` | `number` | yes | Occurrences in all, 1 to 1000; null for no count. |
| `until` | `string \| number` | yes | The last local date-time an occurrence may start, at most 3 years after the start; null for none. |
| `$unknown` (optional) | `string` |  | The members a newer writer added, as the text they were read with. Carry it along. |

### NthDay

One `byDay` entry of a recurrence rule.

| member | type | null | meaning |
|---|---|---|---|
| `day` | `"mo" \| "tu" \| "we" \| "th" \| "fr" \| "sa" \| "su"` |  | The weekday, one of `weekdays`: a day this version does not know is refused on read. |
| `nthOfPeriod` | `number` | yes | Which one of the period, an index -53 to 53 and never 0, negative from the end; null for every such day. |
| `$unknown` (optional) | `string` |  | The members a newer writer added, as the text they were read with. Carry it along. |

### RsvpContent

The envelope of an rsvp, inside its post's `content`; the post's `parent` is the event.

| member | type | null | meaning |
|---|---|---|---|
| `status` | `"tentative" \| "requested" \| "accepted" \| "declined"` |  | The answer, one of `rsvpStatuses`: a status this version does not know is refused on read. |
| `note` | `string \| number` | yes | A note to the organiser, trimmed by the builder: at most 2000 code points, not blank; null for none. |
| `recurrenceId` | `string \| number` | yes | The occurrence answered, its local start in the event's series; null for the series. |
| `guests` | `number` |  | Companions without an account, 0 to 100 people; 0 when absent. |
| `$unknown` (optional) | `string` |  | The members a newer writer added, as the text they were read with. Carry it along. |

### AvailabilityContent

The envelope of an availability, inside its post's `content`: when its author, or a resource of theirs, can be booked.

| member | type | null | meaning |
|---|---|---|---|
| `available` | `AvailabilityBlock[]` |  | When a booking may start; at most 100 blocks. |
| `busy` | `AvailabilityBlock[]` |  | What is taken; at most 100 blocks, untitled. |
| `timeZone` | `string` |  | An IANA time zone name every block is read in, at most 64 code points. |
| `horizonDays` | `number` |  | How far ahead the schedule is kept, 1 to 366 days. |
| `for` | `string \| number` | yes | The resource the schedule belongs to, a reference of any scheme; null for the author. |
| `$unknown` (optional) | `string` |  | The members a newer writer added, as the text they were read with. Carry it along. |

### AvailabilityBlock

One block of an availability.

| member | type | null | meaning |
|---|---|---|---|
| `recurrenceRules` | `RecurrenceRule[]` |  | How it repeats: at most 1 rule; empty for once. |
| `title` | `string \| number` | yes | On an `available` block only, a name, trimmed by the builder: 1 to 100 code points, not blank; null for none. |
| `start` | `string` |  | When the block starts, a local date-time in the schedule's `timeZone`. |
| `duration` | `string` |  | How long it lasts, an ISO 8601 duration of at most 31622400 seconds. |
| `excludedDates` | `string[]` |  | Occurrences removed from the series; at most 100. |
| `$unknown` (optional) | `string` |  | The members a newer writer added, as the text they were read with. Carry it along. |

### RatingContent

The envelope of a rating, inside its post's `content`; the post's `parent` is what is rated.

| member | type | null | meaning |
|---|---|---|---|
| `rating` | `number` |  | The stars, 1 to 10 half stars: 10 is five stars. |
| `text` | `string \| number` | yes | The review, trimmed by the builder: at most 2000 code points, not blank; null for none. |
| `$unknown` (optional) | `string` |  | The members a newer writer added, as the text they were read with. Carry it along. |

### RouteContent

The envelope of a route, inside its post's `content`: read it with `decodeContent`.

| member | type | null | meaning |
|---|---|---|---|
| `waypoints` | `RouteWaypoint[]` |  | The places it passes, in travel order: 2 to 100. |
| `polyline` | `RoutePolyline` |  | The geometry and what produced it. |
| `steps` | `RouteStep[]` |  | The guidance, at most 500 steps; empty for none. |
| `name` | `string` |  | The name, trimmed by the builder: 1 to 100 code points, not blank. |
| `description` | `string \| number` | yes | What the route is, trimmed by the builder: at most 2000 code points, not blank; null for none. |
| `activity` | `string` |  | What it is for, a label with a tag label's rules (`hiking`, `cycling`, `running`, ...): 1 to 20 code points, no whitespace, comma or colon, ASCII-lowercased by the builder. |
| `distance_m` | `number` |  | The length, 0 to 100000000 metres. |
| `duration_s` | `number` |  | The time, 0 to 315360000 seconds. |
| `elevation_gain_m` | `number` | yes | The climb, 0 to 100000 metres; null for none. |
| `elevation_loss_m` | `number` | yes | The descent, 0 to 100000 metres; null for none. |
| `$unknown` (optional) | `string` |  | The members a newer writer added, as the text they were read with. Carry it along. |

### RouteWaypoint

One waypoint of a route.

| member | type | null | meaning |
|---|---|---|---|
| `uri` | `string` |  | A reference to the place, any scheme: a `geo:` point as `geoUri` spells it, a canonical OpenStreetMap object URL, or another reference; at most 1024 code points. |
| `name` | `string \| number` | yes | A name to show, trimmed by the builder: 1 to 100 code points, not blank; null for none. |
| `$unknown` (optional) | `string` |  | The members a newer writer added, as the text they were read with. Carry it along. |

### RoutePolyline

The geometry of a route and what produced it.

| member | type | null | meaning |
|---|---|---|---|
| `encoded` | `string` |  | The geometry as an encoded polyline: 1 to 100000 characters of the alphabet `?` to `~`. |
| `engine` | `string` |  | The routing engine that produced it, trimmed by the builder: 1 to 50 code points, not blank. |
| `profile` | `string` |  | The engine's costing profile, trimmed by the builder: 1 to 50 code points, not blank. |
| `precision` | `number` |  | The coordinate precision it was encoded at: 5 or 6 decimal digits. |
| `$unknown` (optional) | `string` |  | The members a newer writer added, as the text they were read with. Carry it along. |

### RouteStep

One manoeuvre of a route's guidance.

| member | type | null | meaning |
|---|---|---|---|
| `instruction` | `string` |  | The manoeuvre, trimmed by the builder: 1 to 200 code points, not blank. |
| `distance_m` | `number` | yes | Its length, 0 to 100000000 metres; null for none. |
| `duration_s` | `number` | yes | Its time, 0 to 315360000 seconds; null for none. |
| `$unknown` (optional) | `string` |  | The members a newer writer added, as the text they were read with. Carry it along. |

### Tag

A label on an object, stored at `/pub/social/v1/tags/{id}.json`; the id hashes the target and the label.

| member | type | null | meaning |
|---|---|---|---|
| `uri` | `string` |  | What is tagged: a reference of any scheme (a pubky URL, a web URL or another scheme), at most 1024 code points. A post is named versionless. |
| `label` | `string` |  | The label as stored: trimmed and ASCII-lowercased, 1 to 20 code points, no whitespace, `,` or `:`. |
| `created_at` | `number` |  | Microseconds since the epoch. |
| `$unknown` (optional) | `string` |  | The members a newer writer added, as the text they were read with. Carry it along. |

### Bookmark

A saved reference, private, stored at `/priv/social/v1/bookmarks/{filename}.json`; the filename spells the target.

| member | type | null | meaning |
|---|---|---|---|
| `created_at` | `number` |  | Microseconds since the epoch. |
| `target` | `string \| number` | yes | What is bookmarked, only on the overflow form (`~{hash}`), whose filename cannot spell a target over 187 bytes; null on the primary form, whose filename is the target in base64url. |
| `$unknown` (optional) | `string` |  | The members a newer writer added, as the text they were read with. Carry it along. |

### Follow

A follow, stored at `/pub/social/v1/follows/{followee}.json`: the path holds the followee.

| member | type | null | meaning |
|---|---|---|---|
| `created_at` | `number` |  | Microseconds since the epoch. |
| `$unknown` (optional) | `string` |  | The members a newer writer added, as the text they were read with. Carry it along. |

### Mute

A mute, private, stored at `/priv/social/v1/mutes/{mutee}.json`: the path holds the muted key.

| member | type | null | meaning |
|---|---|---|---|
| `created_at` | `number` |  | Microseconds since the epoch. |
| `$unknown` (optional) | `string` |  | The members a newer writer added, as the text they were read with. Carry it along. |

### Feed

A saved feed, private, stored at `/priv/social/v1/feeds/{id}.json`; its published copy is the same leaf under `/pub/`.

| member | type | null | meaning |
|---|---|---|---|
| `feed` | `FeedConfig` |  | The filter, which is the whole identity of the feed: its id hashes these members. |
| `name` | `string` |  | The display name, trimmed by the builder: 1 to 100 code points, not blank. Outside the id. |
| `created_at` | `number` |  | Microseconds since the epoch. |
| `icon` | `string \| number` | yes | 1 to 50 of a-z, 0-9 and `-`: a name for the client's icon set, not an emoji. |
| `$unknown` (optional) | `string` |  | The members a newer writer added, as the text they were read with. Carry it along. |

### FeedConfig

The filter of a feed, which is its identity.

| member | type | null | meaning |
|---|---|---|---|
| `reach` | `"following" \| "followers" \| "friends" \| "all" \| "wot" \| "me"` |  | Whose posts the feed shows, one of `feedReaches`: `all`, the owner's `following` or `followers`, mutual `friends`, the `wot` (web of trust) or `me`. |
| `layout` | `"list" \| "visual" \| "columns" \| "wide" \| "cards"` |  | How the client lays the feed out, one of `feedLayouts`: `columns`, `wide`, `visual` (media first), `list` or `cards`. |
| `sort` | `"recent" \| "popularity"` |  | The order of the posts, one of `feedSorts`: `recent` or `popularity`. |
| `content` | `number \| PostKind` | yes | The one post kind shown, one of `postKinds`, or a newer writer's name kept as written; null for every kind. |
| `tags` | `number \| string[]` | yes | The tag labels a post must carry: at most 5, folded, deduplicated and sorted by code point; null for no tag filter. |
| `domain_tags` | `number \| string[]` | yes | The domain labels a post's links must carry, with the rules of `tags`; null for no domain filter. |
| `$unknown` (optional) | `string` |  | The members a newer writer added, as the text they were read with. Carry it along. |

## Error codes

The `code` of a `ValidationError`. The message text may change between releases; the code of a
rule does not.

| code | the rule |
|---|---|
| `json` | the bytes, or an envelope inside them, are not JSON of the stored shape |
| `size` | an object or a file is over its byte cap, `limit` in bytes |
| `length` | text is outside its bounds, `limit` the bound it broke, in code points |
| `count` | a list has more items than `limit` |
| `range` | a number is outside its bounds, `limit` the bound it broke, in the member's unit |
| `blank` | text, a list or a file is empty or whitespace only |
| `format` | text is not spelled the one way the model accepts (a key, an id, a tag, a slug) |
| `id` | an id does not match its object, or its time is out of bounds |
| `reference` | a URI in a reference position is refused |
| `unknown_name` | a kind, reach, layout or sort this version does not know |
| `unsafe_integer` | an integer a JS number cannot hold exactly |
| `path` | a URL or path names no object of the kind asked for |
| `conflict` | members or arguments that cannot go together |
| `migration` | refused by the migrator, see the message |
