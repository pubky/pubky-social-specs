// The two writer conventions of the Maps spec, as the reference holds them: an OpenStreetMap
// place is its canonical object URL, and a coordinate is one `geo:` spelling. Both pass the
// universal reference gate like any URI; these rules run after it, in the positions that name
// a place (an event's locations, a route's waypoints).

import { limits } from "../data.js";
import { fail } from "../errors.js";

/** An OpenStreetMap object type, the segment of its canonical URL. */
export type OsmObject = "node" | "way" | "relation";

const OSM_PREFIX = "https://www.openstreetmap.org/";
const OSM_HOSTS = ["www.openstreetmap.org", "openstreetmap.org", "osm.org", "www.osm.org"];

/** Whether `uri` is a web URL on an OpenStreetMap host, canonical or not. */
export function namesOsm(uri: string): boolean {
  const rest = uri.startsWith("https://") ? uri.slice(8) : uri.startsWith("http://") ? uri.slice(7) : null;
  if (rest === null) return false;
  const end = rest.search(/[/?#]/);
  const authority = end < 0 ? rest : rest.slice(0, end);
  const host = authority.slice(authority.lastIndexOf("@") + 1).split(":")[0] as string;
  return OSM_HOSTS.includes(host.toLowerCase());
}

// A decimal integer with no leading zero and no sign, at most `maxDigits` digits
const plainInteger = (s: string, maxDigits: number): number | null => (s.length >= 1 && s.length <= maxDigits && /^(0|[1-9][0-9]*)$/.test(s) ? Number(s) : null);

/**
 * The canonical OpenStreetMap object URL taken apart, `https://www.openstreetmap.org/{node|way|relation}/{id}`:
 * no trailing slash, query or fragment, the id a positive integer with no leading zeros. Null for
 * anything else, a map link with a view but no object included.
 */
export function parseOsmUrl(uri: string): { object: OsmObject; id: number } | null {
  if (!uri.startsWith(OSM_PREFIX)) return null;
  const [object, id, ...more] = uri.slice(OSM_PREFIX.length).split("/");
  if (more.length > 0 || id === undefined || (object !== "node" && object !== "way" && object !== "relation")) return null;
  // From 1, and within the JSON-safe range every stored integer obeys, so the id is exact here
  if (!/^[1-9][0-9]{0,15}$/.test(id) || BigInt(id) > 9007199254740991n) return null;
  return { object, id: Number(id) };
}

/** The canonical URL of an OpenStreetMap object. */
export const osmUrl = (object: OsmObject, id: number): string => `${OSM_PREFIX}${object}/${id}`;

// One coordinate as the convention spells it, within `maxDegrees`
function coordinate(s: string, maxDegrees: number): boolean {
  const negative = s.startsWith("-");
  const unsigned = negative ? s.slice(1) : s;
  const dot = unsigned.indexOf(".");
  const whole = dot < 0 ? unsigned : unsigned.slice(0, dot);
  const fraction = dot < 0 ? "" : unsigned.slice(dot + 1);
  const degrees = plainInteger(whole, 3);
  if (degrees === null) return false;
  if (dot >= 0 && (fraction === "" || fraction.length > limits.geoFractionMaxDigits || !/^[0-9]+$/.test(fraction) || fraction.endsWith("0"))) return false;
  if (negative && degrees === 0 && fraction === "") return false;
  return degrees < maxDegrees || (degrees === maxDegrees && fraction === "");
}

/** Whether `uri` is a `geo:` URI as the convention spells it: `geo:<lat>,<lon>` in decimal degrees, no altitude and no parameters, as `geoUri` writes it. */
export function isGeoUri(uri: string): boolean {
  if (!uri.startsWith("geo:")) return false;
  const parts = uri.slice(4).split(",");
  return parts.length === 2 && coordinate(parts[0] as string, 90) && coordinate(parts[1] as string, 180);
}

/**
 * The `geo:` URI of a point, rounded to `digits` fraction digits (at most 5; five is about a
 * metre, three about 100 m, two about 1 km) with no trailing zeros, so one point has one
 * spelling. Rounding is half up, as the reference rounds.
 */
export function geoUri(lat: number, lon: number, digits: number): string {
  const max = limits.geoFractionMaxDigits;
  if (!Number.isInteger(digits) || digits < 0 || digits > max) fail("range", `a geo URI carries at most ${max} fraction digits`, "digits", max);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) fail("format", "a geo URI needs finite coordinates");
  const scale = 10 ** digits;
  const spell = (value: number, maxDegrees: number): string | null => {
    const scaled = Math.floor(value * scale + 0.5);
    if (Math.abs(scaled) > maxDegrees * scale) return null;
    if (scaled === 0) return "0";
    const magnitude = Math.abs(scaled);
    const whole = Math.floor(magnitude / scale);
    const fraction = String(magnitude % scale)
      .padStart(digits, "0")
      .replace(/0+$/, "");
    return `${scaled < 0 ? "-" : ""}${whole}${fraction === "" ? "" : `.${fraction}`}`;
  };
  const a = spell(lat, 90);
  const b = spell(lon, 180);
  if (a === null || b === null) fail("range", "a geo URI needs a latitude within 90 and a longitude within 180 degrees");
  return `geo:${a},${b}`;
}

/**
 * The two conventions as a rule on a place position named `field`, after the reference gate:
 * a `geo:` URI must be the convention's spelling, and a URL on an OpenStreetMap host the
 * canonical object URL. Every other reference passes.
 */
export function checkPlaceReference(field: string, uri: string): void {
  if (uri.startsWith("geo:") && !isGeoUri(uri)) {
    fail("reference", `${field} must be a geo URI, geo:<lat>,<lon> in decimal degrees with at most ${limits.geoFractionMaxDigits} fraction digits and no trailing zeros: ${uri}`, field);
  }
  if (namesOsm(uri) && parseOsmUrl(uri) === null) fail("reference", `${field} must be a canonical OpenStreetMap object URL, https://www.openstreetmap.org/{node|way|relation}/{id}: ${uri}`, field);
}
