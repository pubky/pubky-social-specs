// The place conventions as a caller meets them, and the sub-specs' kinds under social.

import assert from "assert";
import { buildPost, decodeObject, geoUri, isGeoUri, limits, osmUrl, parseOsmUrl, postKinds } from "./dist/index.js";
import { setClock } from "./dist/testing.js";
import { OTTO, T0, misuse, refuses, utf8 } from "./core.fixture.js";

describe("the place conventions", () => {
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

describe("a sub-spec's kind under social", () => {
  beforeEach(() => setClock(() => T0));
  after(() => setClock());

  it("is no social kind: a builder refuses it and a reader refuses a stored one", () => {
    for (const kind of ["availability", "route"]) {
      assert.ok(!postKinds.includes(kind), kind);
      refuses(() => buildPost(OTTO, { kind, content: "x" }), `Validation Error: Invalid content kind: ${kind}`);
      const stored = utf8(JSON.stringify({ content: "{}", kind, parent: null, embed: null, attachments: [] }));
      refuses(() => decodeObject(`pubky://${OTTO}/pub/social/v1/posts/0034A0X7NJ52C/0034A0X7NJ52C.json`, stored), "Validation Error: post kind is unknown");
    }
  });
});
