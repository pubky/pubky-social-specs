# pubky-maps-specs

The maps sub-spec of Pubky social: the kind a map app writes that no other app must read, on the
shared post envelope. It follows [`docs/SUBSPECS.md`](../../docs/SUBSPECS.md).

## Paths

| what | path |
| --- | --- |
| a version of a post | `/{pub,priv}/maps/v1/posts/{id}/{editId}[-{slug}].json` |
| the post, as a reference names it | `pubky://{owner}/{pub,priv}/maps/v1/posts/{id}` |

`version_path`, `post_uri` and `parse_post_uri` build and read them; `create_version`,
`edit_version` and `read_version` mint, edit and read a version as social does, with the
ownership rule run with the author.

## Kinds

| kind | what | feed-only |
| --- | --- | --- |
| `route` | a saved route: ordered waypoints, an encoded polyline, distance, duration, elevation, steps | no |

`FEED_ONLY_KINDS` is empty: a route is a durable post, and an indexer gives it a graph node.

### `route`

The shape the social 1.1 drafts had, moved as is; only the namespace changed. `parent` is refused,
`embed` may name the trail the route follows (an OpenStreetMap relation), the cover is
`attachments[0]`.

```json
{
  "name": "Lakeside loop", "description": "Flat, along the shore.", "activity": "running",
  "waypoints": [{ "uri": "geo:46.00547,8.95186", "name": "Start" }, { "uri": "https://www.openstreetmap.org/node/240109189" }],
  "polyline": { "encoded": "_p~iF~ps|U_ulLnnqC_mqNvxq`@", "engine": "valhalla", "profile": "pedestrian", "precision": 6 },
  "distance_m": 5200, "duration_s": 1800, "elevation_gain_m": 12, "elevation_loss_m": 12,
  "steps": [{ "instruction": "Head south on the promenade", "distance_m": 400, "duration_s": 150 }]
}
```

| member | rule |
| --- | --- |
| `name` | trimmed by the builder; 1 to 100 code points, not blank |
| `description` | trimmed, a blank one absent; at most 2000 code points |
| `activity` | a tag label's rules: 1 to 20 code points, no whitespace, comma or colon; ASCII-folded by the builder. `hiking`, `cycling`, `running`, `driving` are the recommended values |
| `waypoints[]` | `{ uri, name? }` in travel order, 2 to 100; `uri` a universal reference under the place conventions (a `geo:` pin or a canonical OpenStreetMap object URL; any other reference passes), `name` 1 to 100 code points |
| `polyline` | `{ encoded, engine, profile, precision }`: `encoded` 1 to 100000 characters of `?` to `~` (the Google algorithm); `engine` and `profile` 1 to 50 code points; `precision` 5 or 6 |
| `distance_m` | integer metres, 0 to 100000000 |
| `duration_s` | integer seconds, 0 to 315360000 (ten years) |
| `elevation_gain_m`, `elevation_loss_m` | integer metres, 0 to 100000; absent for none |
| `steps[]` | `{ instruction, distance_m?, duration_s? }`, at most 500; `instruction` 1 to 200 code points |

The raw content is bounded at 400000 code points before it is parsed, and the waypoint count is
checked before any waypoint reference is read. Every cap is in `MAPS_LIMITS`. An indexer facets
`activity`, `distance_m`, `duration_s`, the first waypoint and the box of the waypoints; it never
decodes the polyline.

## What maps uses instead of its own copies

| a map app wants | it writes | not |
| --- | --- | --- |
| a review of a place | a social `rating` whose `parent` is the place: its OpenStreetMap URL, or its `geo:` pin | a review kind of its own |
| a list of places, a trip plan | a social `collection` whose items are place URIs and route posts | a list kind |
| a label on a place ("vegan", "wifi") | a social tag on the place's URI | its own tags |
| a saved place | a private social bookmark of the place's URI | a favourites file |
| a comment on a place or a route | a social post whose `parent` is the place or the route | a comment kind |
| a photo of a place | a social post (or a rating) with the photo in `attachments` and `parent` the place | a photo kind |
| an event at a place | a social `event` whose `locations[].uri` is the place | an event kind |

The place conventions (one OpenStreetMap URL spelling, one `geo:` spelling) are social's
`places` module, so a place every app names is one resource every indexer counts once.

## Tests and vectors

`cargo test -p pubky-maps-specs` runs the unit tests and checks `vectors/route.jsonl`: one JSON
document per line, `{ name, url, body, verdict }`, the stored bytes and the verdict a reader gives
them (`"ok"` or the refusal, worded as the crate words it). Another implementation reads the same
file. `RECORD_VECTORS=1 cargo test -p pubky-maps-specs --test vectors` rewrites it after a
deliberate change.
