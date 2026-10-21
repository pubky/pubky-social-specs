// The Maps side as a caller meets it: the two writer conventions and the route kind.

import assert from "assert";
import { buildPost, decodeContent, decodeObject, encodeObject, geoUri, isGeoUri, limits, osmUrl, parseOsmUrl, planPublish, validatePost } from "./dist/index.js";
import { setClock } from "./dist/testing.js";
import { OTTO, RIO, T0, misuse, refuses, text, utf8 } from "./core.fixture.js";

const TRAIL = "https://www.openstreetmap.org/relation/1234";

const lakeside = () => ({
  kind: "route",
  name: "Lakeside loop",
  description: "Flat, along the shore.",
  activity: "running",
  waypoints: [{ uri: "geo:46.00547,8.95186", name: "Start" }, { uri: "https://www.openstreetmap.org/node/240109189" }, { uri: "geo:46.00547,8.95186", name: "Finish" }],
  polyline: { encoded: "_p~iF~ps|U_ulLnnqC_mqNvxq`@", engine: "valhalla", profile: "pedestrian", precision: 6 },
  distance_m: 5200,
  duration_s: 1800,
  elevation_gain_m: 12,
  elevation_loss_m: 12,
  steps: [{ instruction: "Head south on the promenade", distance_m: 400, duration_s: 150 }],
  embed: TRAIL,
});

describe("the maps conventions", () => {
  it("spell a point one way, and read the spelling back", () => {
    assert.strictEqual(geoUri(46.00547, 8.95186, 5), "geo:46.00547,8.95186");
    assert.strictEqual(geoUri(46.00547, 8.95186, 3), "geo:46.005,8.952");
    assert.strictEqual(geoUri(46.00547, 8.95186, 0), "geo:46,9");
    assert.strictEqual(geoUri(0, 0, 5), "geo:0,0");
    assert.strictEqual(geoUri(-0.000001, 0.000001, 5), "geo:0,0");
    assert.strictEqual(geoUri(-33.8, 151.2, 5), "geo:-33.8,151.2");
    assert.strictEqual(geoUri(90.000004, -180, 5), "geo:90,-180");
    // half up, as the reference rounds
    assert.strictEqual(geoUri(0.125, -0.125, 2), "geo:0.13,-0.12");
    assert.ok(isGeoUri(geoUri(12.3456789, -98.7654321, 5)));
    refuses(() => geoUri(90.000005, 0, 5), "Validation Error: a geo URI needs a latitude within 90 and a longitude within 180 degrees");
    refuses(() => geoUri(0, 0, 6), "Validation Error: a geo URI carries at most 5 fraction digits");
    refuses(() => geoUri(NaN, 0, 5), "Validation Error: a geo URI needs finite coordinates");
    for (const ok of ["geo:46,8", "geo:0,0", "geo:-33.8,151.2", "geo:90,180", "geo:-90,-180", "geo:89.99999,179.99999"]) assert.ok(isGeoUri(ok), ok);
    for (const bad of ["geo:46.0,8", "geo:46.123456,8", "geo:046,8", "geo:-0,8", "geo:91,8", "geo:46,181", "geo:46,8,100", "geo:46,8;u=35", "geo:46", "GEO:46,8", "geo: 46,8", 1])
      assert.ok(!isGeoUri(bad), String(bad));
    assert.strictEqual(limits.geoFractionMaxDigits, 5);
  });

  it("name an OpenStreetMap object by its canonical URL alone", () => {
    assert.deepStrictEqual(parseOsmUrl("https://www.openstreetmap.org/way/481516234"), { object: "way", id: 481516234 });
    assert.strictEqual(osmUrl("way", 481516234), "https://www.openstreetmap.org/way/481516234");
    assert.deepStrictEqual(parseOsmUrl(osmUrl("relation", 62273)), { object: "relation", id: 62273 });
    for (const bad of [
      "https://www.openstreetmap.org/way/481516234/",
      "https://www.openstreetmap.org/way/481516234?x=1",
      "https://www.openstreetmap.org/way/0481516234",
      "https://www.openstreetmap.org/way/0",
      "https://www.openstreetmap.org/Way/1",
      "https://www.openstreetmap.org/user/alice",
      "https://www.openstreetmap.org/?mlat=46&mlon=8",
      "https://openstreetmap.org/way/481516234",
      "http://www.openstreetmap.org/way/481516234",
      "https://osm.org/way/481516234",
      "https://www.openstreetmap.org/way/9007199254740992",
      "https://www.openstreetmap.org/way/1234567890123456789",
    ]) {
      assert.strictEqual(parseOsmUrl(bad), null, bad);
    }
    assert.deepStrictEqual(parseOsmUrl("https://www.openstreetmap.org/node/9007199254740991"), { object: "node", id: 9007199254740991 });
    refuses(() => osmUrl("way", 0), "Validation Error: an OpenStreetMap id is a positive integer: 0");
    refuses(() => osmUrl("way", 2 ** 53), /positive integer/);
    refuses(() => osmUrl("area", 1), /unknown variant `area`/);
    misuse(() => osmUrl("way", "1"), /id must be a number/);
    misuse(() => parseOsmUrl(1), /url must be a string/);
    misuse(() => geoUri("46", 8, 5), /lat must be a number/);
    assert.strictEqual(geoUri(46.00547, 8.95186), "geo:46.00547,8.95186");
  });
});

describe("the route kind", () => {
  beforeEach(() => setClock(() => T0));
  after(() => setClock());

  it("builds, trims, folds the activity, and reads back", () => {
    const built = buildPost(OTTO, {
      ...lakeside(),
      name: "  Lakeside loop ",
      activity: " Running ",
      waypoints: [{ uri: "geo:46,8", name: "  Start " }, { uri: "geo:47,8" }],
      polyline: { ...lakeside().polyline, engine: " Valhalla " },
      steps: [{ instruction: " Head south " }],
    });
    assert.strictEqual(built.object.kind, "route");
    assert.strictEqual(built.object.embed, TRAIL);
    const { content } = decodeContent(built.object);
    assert.strictEqual(content.name, "Lakeside loop");
    assert.strictEqual(content.activity, "running");
    assert.strictEqual(content.waypoints[0].name, "Start");
    assert.strictEqual(content.polyline.engine, "Valhalla");
    assert.deepStrictEqual(content.steps[0], { instruction: "Head south", distance_m: null, duration_s: null });
    const full = buildPost(OTTO, lakeside());
    assert.strictEqual(
      full.object.content,
      '{"name":"Lakeside loop","description":"Flat, along the shore.","activity":"running","waypoints":[{"uri":"geo:46.00547,8.95186","name":"Start"},{"uri":"https://www.openstreetmap.org/node/240109189"},{"uri":"geo:46.00547,8.95186","name":"Finish"}],"polyline":{"encoded":"_p~iF~ps|U_ulLnnqC_mqNvxq`@","engine":"valhalla","profile":"pedestrian","precision":6},"distance_m":5200,"duration_s":1800,"elevation_gain_m":12,"elevation_loss_m":12,"steps":[{"instruction":"Head south on the promenade","distance_m":400,"duration_s":150}]}',
    );
    const read = decodeObject(full.url, full.body, "post");
    assert.deepStrictEqual(read, full.object);
    assert.strictEqual(text(encodeObject(full.url, read)), text(full.body));
  });

  it("refuses what the reference refuses, in its words", () => {
    refuses(() => buildPost(OTTO, { ...lakeside(), name: " " }), "Validation Error: Route name must contain non-whitespace characters");
    refuses(() => buildPost(OTTO, { ...lakeside(), name: "n".repeat(101) }), "Validation Error: Route name must be at most 100 code points");
    refuses(() => buildPost(OTTO, { ...lakeside(), description: "d".repeat(2001) }), "Validation Error: Route description must be at most 2000 code points");
    refuses(
      () => buildPost(OTTO, { ...lakeside(), waypoints: [{ uri: "geo:46,8", name: "n".repeat(101) }, { uri: "geo:47,8" }] }),
      "Validation Error: waypoints[0].name must be 1 to 100 code points and not blank",
    );
    refuses(() => buildPost(OTTO, { ...lakeside(), polyline: { ...lakeside().polyline, profile: "p".repeat(51) } }), "Validation Error: polyline.profile must be 1 to 50 code points and not blank");
    refuses(() => buildPost(OTTO, { ...lakeside(), elevation_loss_m: -1 }), "Validation Error: Route elevation_loss_m must be 0 to 100000 metres");
    refuses(() => buildPost(OTTO, { ...lakeside(), steps: Array.from({ length: 501 }, () => ({ instruction: "go" })) }), "Validation Error: Route cannot have more than 500 steps");
    refuses(() => buildPost(OTTO, { ...lakeside(), steps: [{ instruction: "go", duration_s: -1 }] }), "Validation Error: steps[0].duration_s must be 0 to 315360000 seconds");
    assert.strictEqual(decodeContent(buildPost(OTTO, { ...lakeside(), description: " ", elevation_gain_m: null, steps: null }).object).content.description, null);
    refuses(() => buildPost(OTTO, { ...lakeside(), activity: "trail run" }), "Validation Error: Route activity must be a label of 1 to 20 code points with no whitespace, comma or colon: trail run");
    refuses(() => buildPost(OTTO, { ...lakeside(), waypoints: [{ uri: "geo:46,8" }] }), "Validation Error: Route must have 2 to 100 waypoints");
    refuses(() => buildPost(OTTO, { ...lakeside(), waypoints: Array.from({ length: 101 }, () => ({ uri: "nowhere" })) }), "Validation Error: Route must have 2 to 100 waypoints");
    refuses(
      () => buildPost(OTTO, { ...lakeside(), waypoints: [{ uri: "geo:46.123456,8" }, { uri: "geo:47,8" }] }),
      "Validation Error: waypoints[0].uri must be a geo URI, geo:<lat>,<lon> in decimal degrees with at most 5 fraction digits and no trailing zeros: geo:46.123456,8",
    );
    refuses(() => buildPost(OTTO, { ...lakeside(), waypoints: [{ uri: "geo:46,8" }, { uri: "https://osm.org/node/1" }] }), /waypoints\[1\]\.uri must be a canonical OpenStreetMap object URL/);
    refuses(
      () => buildPost(OTTO, { ...lakeside(), polyline: { ...lakeside().polyline, encoded: "über" } }),
      "Validation Error: polyline.encoded must be 1 to 100000 characters of the encoded polyline alphabet, ? to ~",
    );
    refuses(() => buildPost(OTTO, { ...lakeside(), polyline: { ...lakeside().polyline, precision: 7 } }), "Validation Error: polyline.precision must be 5 or 6");
    refuses(() => buildPost(OTTO, { ...lakeside(), polyline: { ...lakeside().polyline, engine: " " } }), "Validation Error: polyline.engine must be 1 to 50 code points and not blank");
    refuses(() => buildPost(OTTO, { ...lakeside(), distance_m: -1 }), "Validation Error: Route distance_m must be 0 to 100000000 metres");
    refuses(() => buildPost(OTTO, { ...lakeside(), duration_s: 315360001 }), "Validation Error: Route duration_s must be 0 to 315360000 seconds");
    refuses(() => buildPost(OTTO, { ...lakeside(), elevation_gain_m: 100001 }), "Validation Error: Route elevation_gain_m must be 0 to 100000 metres");
    refuses(() => buildPost(OTTO, { ...lakeside(), steps: [{ instruction: "" }] }), "Validation Error: steps[0].instruction must be 1 to 200 code points and not blank");
    refuses(() => buildPost(OTTO, { ...lakeside(), steps: [{ instruction: "go", distance_m: -1 }] }), "Validation Error: steps[0].distance_m must be 0 to 100000000 metres");
    refuses(() => buildPost(OTTO, { ...lakeside(), distance_m: 1.5 }), "Validation Error: invalid type: floating point `1.5`, expected i64");
    misuse(() => buildPost(OTTO, { ...lakeside(), parent: TRAIL }), /input\.parent must be one of/);
    misuse(() => buildPost(OTTO, { ...lakeside(), polyline: { encoded: "x", engine: "e", profile: "p", precision: 6, version: 1 } }), /input\.polyline\.version/);
    const url = `pubky://${OTTO}/pub/social/v1/posts/0035QZPT4QG00/0035QZPT4QG00.json`;
    const stored = buildPost(OTTO, lakeside()).object;
    refuses(() => encodeObject(url, { ...stored, parent: `pubky://${RIO}/pub/social/v1/posts/0035QZPT4QG00` }), "Validation Error: Route posts cannot have parent");
    // the embed keeps the v1 gate alone: a non-canonical OSM link there is an ordinary web URL
    assert.strictEqual(buildPost(OTTO, { ...lakeside(), embed: `${TRAIL}/` }).object.embed, `${TRAIL}/`);
  });

  it("reads stored bytes as written and collects issues for a form", () => {
    const url = `pubky://${OTTO}/pub/social/v1/posts/0035QZPT4QG00/0035QZPT4QG00.json`;
    const content = JSON.stringify({
      name: " padded ",
      activity: "Running",
      waypoints: [{ uri: "geo:46,8", elevation_m: 273 }, { uri: "geo:47,8" }],
      polyline: { encoded: "x", engine: "e", profile: "p", precision: 5, version: "3.4" },
      distance_m: 1,
      duration_s: 1,
      surface: "gravel",
    });
    const read = decodeObject(url, utf8(JSON.stringify({ content, kind: "route", parent: null, embed: null, attachments: [] })), "post");
    const envelope = decodeContent(read).content;
    assert.strictEqual(envelope.name, " padded ");
    assert.strictEqual(envelope.activity, "Running");
    assert.strictEqual(envelope.$unknown, '{"surface":"gravel"}');
    assert.strictEqual(envelope.waypoints[0].$unknown, '{"elevation_m":273}');
    assert.strictEqual(envelope.polyline.$unknown, '{"version":"3.4"}');
    assert.deepStrictEqual(envelope.steps, []);
    const result = validatePost({ ...lakeside(), activity: "a b", polyline: { ...lakeside().polyline, precision: 4 }, distance_m: -2 });
    assert.deepStrictEqual(
      result.issues.map((i) => [i.path.join("."), i.code]),
      [
        ["activity", "format"],
        ["polyline.precision", "range"],
        ["distance_m", "range"],
      ],
    );
  });

  it("publishes a private draft, and refuses a private waypoint", () => {
    const draft = buildPost(OTTO, { ...lakeside(), root: "private" });
    const plan = planPublish(OTTO, { id: draft.id, editId: draft.editId, post: draft.object });
    assert.strictEqual(plan.put.path, `/pub/social/v1/posts/${draft.id}/${draft.editId}.json`);
    const hidden = buildPost(OTTO, { ...lakeside(), root: "private", waypoints: [{ uri: `pubky://${OTTO}/priv/social/v1/posts/0035QZPT4QG00` }, { uri: "geo:47,8" }] });
    refuses(() => planPublish(OTTO, { id: hidden.id, editId: hidden.editId, post: hidden.object }), /cannot publish: a public post cannot reference a private object/);
  });
});
