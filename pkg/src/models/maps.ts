// The Maps side of 1.1: the `route` kind. The two writer conventions it enforces on its
// waypoints are in geo.ts; a located post is otherwise a post whose parent or embed is a place.

import { limits } from "../data.js";
import { type Each, fail } from "../errors.js";
import { type Codec, defaulted, type Extra, i64, inputOf, inputReads, list, object, omitted, string } from "../json/schema.js";
import { asciiFold, codePointLen, frozenTrim, hasFrozenWhitespace, trimmedOrNull } from "../text.js";
import { checkExtra } from "./common.js";
import { type ContentRef, optionalInt, requiredInt } from "./events.js";
import { checkPlaceReference } from "./geo.js";

export interface RouteWaypoint extends Extra {
  /** A reference to the place, any scheme: a `geo:` point as `geoUri` spells it, a canonical OpenStreetMap object URL, or another reference; at most 1024 code points. */
  uri: string;
  /** A name to show, trimmed by the builder: 1 to 100 code points, not blank; null for none. */
  name: string | null;
}

export interface RoutePolyline extends Extra {
  /** The geometry as an encoded polyline: 1 to 100000 characters of the alphabet `?` to `~`. */
  encoded: string;
  /** The routing engine that produced it, trimmed by the builder: 1 to 50 code points, not blank. */
  engine: string;
  /** The engine's costing profile, trimmed by the builder: 1 to 50 code points, not blank. */
  profile: string;
  /** The coordinate precision it was encoded at: 5 or 6 decimal digits. */
  precision: bigint;
}

export interface RouteStep extends Extra {
  /** The manoeuvre, trimmed by the builder: 1 to 200 code points, not blank. */
  instruction: string;
  /** Its length, 0 to 100000000 metres; null for none. */
  distance_m: bigint | null;
  /** Its time, 0 to 315360000 seconds; null for none. */
  duration_s: bigint | null;
}

export interface RouteContent extends Extra {
  /** The name, trimmed by the builder: 1 to 100 code points, not blank. */
  name: string;
  /** What the route is, trimmed by the builder: at most 2000 code points, not blank; null for none. */
  description: string | null;
  /** What it is for, a label with a tag label's rules (`hiking`, `cycling`, `running`, ...): 1 to 20 code points, no whitespace, comma or colon, ASCII-lowercased by the builder. */
  activity: string;
  /** The places it passes, in travel order: 2 to 100. */
  waypoints: RouteWaypoint[];
  /** The geometry and what produced it. */
  polyline: RoutePolyline;
  /** The length, 0 to 100000000 metres. */
  distance_m: bigint;
  /** The time, 0 to 315360000 seconds. */
  duration_s: bigint;
  /** The climb, 0 to 100000 metres; null for none. */
  elevation_gain_m: bigint | null;
  /** The descent, 0 to 100000 metres; null for none. */
  elevation_loss_m: bigint | null;
  /** The guidance, at most 500 steps; empty for none. */
  steps: RouteStep[];
}

export const waypoint: Codec<RouteWaypoint> = object<RouteWaypoint>("PubkySocialRouteWaypoint", { uri: string, name: omitted(string) });
export const polyline: Codec<RoutePolyline> = object<RoutePolyline>("PubkySocialRoutePolyline", { encoded: string, engine: string, profile: string, precision: i64 });
export const step: Codec<RouteStep> = object<RouteStep>("PubkySocialRouteStep", { instruction: string, distance_m: omitted(i64), duration_s: omitted(i64) });
export const route: Codec<RouteContent> = object<RouteContent>("PubkySocialRouteContent", {
  name: string,
  description: omitted(string),
  activity: string,
  waypoints: defaulted(list(waypoint), () => []),
  polyline,
  distance_m: i64,
  duration_s: i64,
  elevation_gain_m: omitted(i64),
  elevation_loss_m: omitted(i64),
  steps: defaulted(list(step), () => []),
});

/** The reference positions of a route envelope: its waypoints. */
export function routeRefs(e: RouteContent): ContentRef[] {
  return e.waypoints.map((w, index) => ({ field: `waypoints[${index}].uri`, uri: w.uri, schemes: "", max: limits.referenceUriMaxLength }));
}

/** The waypoint count, run before any waypoint reference is read. */
export function checkRouteCounts(e: RouteContent, each: Each): void {
  each(() => {
    const min = limits.routeWaypointsMinCount;
    const max = limits.routeWaypointsMaxCount;
    if (e.waypoints.length < min || e.waypoints.length > max) fail("count", `Route must have ${min} to ${max} waypoints`, "waypoints", e.waypoints.length < min ? min : max);
  });
}

// `label` is how the message names the member, `field` where a form finds it
function checkRange(label: string, field: string, value: bigint, max: number, unit: string): void {
  if (value < 0n || value > BigInt(max)) fail("range", `${label} must be 0 to ${max} ${unit}`, field, max);
}

function checkShortText(text: string, field: string, max: number): void {
  if (frozenTrim(text) === "" || codePointLen(text) > max) fail("length", `${field} must be 1 to ${max} code points and not blank`, field, max);
}

/** The rules of a route envelope, after the post's gate ran over its waypoints. */
export function checkRoute(e: RouteContent, each: Each): void {
  each(() => checkExtra(e.extra));
  each(() => {
    if (frozenTrim(e.name) === "") fail("blank", "Route name must contain non-whitespace characters", "name");
    if (codePointLen(e.name) > limits.routeNameMaxLength) fail("length", `Route name must be at most ${limits.routeNameMaxLength} code points`, "name", limits.routeNameMaxLength);
  });
  each(() => {
    if (e.description === null) return;
    if (frozenTrim(e.description) === "") fail("blank", "Route description must not be blank", "description");
    if (codePointLen(e.description) > limits.routeDescriptionMaxLength)
      fail("length", `Route description must be at most ${limits.routeDescriptionMaxLength} code points`, "description", limits.routeDescriptionMaxLength);
  });
  each(() => {
    const length = codePointLen(e.activity);
    let bad = length < limits.tagLabelMinLength || length > limits.tagLabelMaxLength || hasFrozenWhitespace(e.activity);
    for (const c of e.activity) if ((limits.tagInvalidChars as readonly string[]).includes(c)) bad = true;
    if (bad) fail("format", `Route activity must be a label of ${limits.tagLabelMinLength} to ${limits.tagLabelMaxLength} code points with no whitespace, comma or colon: ${e.activity}`, "activity");
  });
  e.waypoints.forEach((w, index) => {
    each(() => checkExtra(w.extra, `waypoints[${index}].`));
    each(() => {
      if (w.name !== null) checkShortText(w.name, `waypoints[${index}].name`, limits.routeWaypointNameMaxLength);
    });
    each(() => checkPlaceReference(`waypoints[${index}].uri`, w.uri));
  });
  each(() => checkExtra(e.polyline.extra, "polyline."));
  each(() => {
    const max = limits.routePolylineMaxLength;
    if (e.polyline.encoded === "" || codePointLen(e.polyline.encoded) > max || !/^[?-~]*$/.test(e.polyline.encoded))
      fail("format", `polyline.encoded must be 1 to ${max} characters of the encoded polyline alphabet, ? to ~`, "polyline.encoded", max);
  });
  each(() => checkShortText(e.polyline.engine, "polyline.engine", limits.routeLabelMaxLength));
  each(() => checkShortText(e.polyline.profile, "polyline.profile", limits.routeLabelMaxLength));
  each(() => {
    if (e.polyline.precision !== 5n && e.polyline.precision !== 6n) fail("range", "polyline.precision must be 5 or 6", "polyline.precision", 6);
  });
  each(() => checkRange("Route distance_m", "distance_m", e.distance_m, limits.routeDistanceMaxMetres, "metres"));
  each(() => checkRange("Route duration_s", "duration_s", e.duration_s, limits.routeDurationMaxSeconds, "seconds"));
  each(() => {
    if (e.elevation_gain_m !== null) checkRange("Route elevation_gain_m", "elevation_gain_m", e.elevation_gain_m, limits.routeElevationMaxMetres, "metres");
  });
  each(() => {
    if (e.elevation_loss_m !== null) checkRange("Route elevation_loss_m", "elevation_loss_m", e.elevation_loss_m, limits.routeElevationMaxMetres, "metres");
  });
  each(() => {
    const max = limits.routeStepsMaxCount;
    if (e.steps.length > max) fail("count", `Route cannot have more than ${max} steps`, "steps", max);
  });
  e.steps.forEach((s, index) => {
    each(() => checkExtra(s.extra, `steps[${index}].`));
    each(() => checkShortText(s.instruction, `steps[${index}].instruction`, limits.routeStepInstructionMaxLength));
    each(() => {
      if (s.distance_m !== null) checkRange(`steps[${index}].distance_m`, `steps[${index}].distance_m`, s.distance_m, limits.routeDistanceMaxMetres, "metres");
    });
    each(() => {
      if (s.duration_s !== null) checkRange(`steps[${index}].duration_s`, `steps[${index}].duration_s`, s.duration_s, limits.routeDurationMaxSeconds, "seconds");
    });
  });
}

export const ROUTE_MEMBERS = ["name", "description", "activity", "waypoints", "polyline", "distance_m", "duration_s", "elevation_gain_m", "elevation_loss_m", "steps"];

/** A route envelope from a caller's input, the builder's trims and the activity fold applied. */
export function routeFromInput(i: Record<string, unknown>, each: Each): RouteContent {
  const { str, opt, items } = inputReads(each);
  const p = i.polyline === undefined || i.polyline === null ? {} : inputOf(i.polyline, "input.polyline", ["encoded", "engine", "profile", "precision"], each);
  return {
    name: frozenTrim(str(i.name, "input.name")),
    description: trimmedOrNull(opt(i.description, "input.description")),
    activity: asciiFold(frozenTrim(str(i.activity, "input.activity"))),
    waypoints:
      items(i.waypoints, "input.waypoints", (entry, at): RouteWaypoint => {
        const w = inputOf(entry, at, ["uri", "name"], each);
        return { uri: str(w.uri, `${at}.uri`), name: trimmedOrNull(opt(w.name, `${at}.name`)), extra: new Map() };
      }) ?? [],
    polyline: {
      encoded: str(p.encoded, "input.polyline.encoded"),
      engine: frozenTrim(str(p.engine, "input.polyline.engine")),
      profile: frozenTrim(str(p.profile, "input.polyline.profile")),
      precision: requiredInt(each, p.precision, "input.polyline.precision"),
      extra: new Map(),
    },
    distance_m: requiredInt(each, i.distance_m, "input.distance_m"),
    duration_s: requiredInt(each, i.duration_s, "input.duration_s"),
    elevation_gain_m: optionalInt(each, i.elevation_gain_m, "input.elevation_gain_m"),
    elevation_loss_m: optionalInt(each, i.elevation_loss_m, "input.elevation_loss_m"),
    steps:
      items(i.steps, "input.steps", (entry, at): RouteStep => {
        const s = inputOf(entry, at, ["instruction", "distance_m", "duration_s"], each);
        return {
          instruction: frozenTrim(str(s.instruction, `${at}.instruction`)),
          distance_m: optionalInt(each, s.distance_m, `${at}.distance_m`),
          duration_s: optionalInt(each, s.duration_s, `${at}.duration_s`),
          extra: new Map(),
        };
      }) ?? [],
    extra: new Map(),
  };
}
