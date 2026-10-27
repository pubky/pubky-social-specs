// The event kinds of 1.1: `event` and `rsvp`, with the optional `availability` and `rating`.
// Each is a post kind whose `content` is a JSON envelope with JSCalendar member names where
// JSCalendar has one; the rules run in the reference's order and its words.

import { limits } from "../data.js";
import { type Each, fail, member } from "../errors.js";
import { bool, type Codec, defaulted, type Extra, i64, inputOf, inputReads, list, object, omitted, option, string } from "../json/schema.js";
import { codePointLen, frozenTrim, trimmedOrNull } from "../text.js";
import { checkExtra } from "./common.js";
import { checkPlaceReference } from "./places.js";
import { type AttendancePolicy, attendancePolicies, attendancePolicy, type EventStatus, eventStatus, eventStatuses, isKnown, type RsvpStatus, rsvpStatus, rsvpStatuses } from "./kinds.js";
import { checkDuration, checkLocalDateTime, checkRecurrenceRule, checkTimeZone, type RecurrenceRule, recurrenceRule } from "./time.js";

export interface EventLocation extends Extra {
  /** A name to show, trimmed by the builder: 1 to 100 code points, not blank; null for none. */
  name: string | null;
  /** A reference to the place, any scheme: a canonical OpenStreetMap object URL, a `geo:` point as `geoUri` spells it, or an https meeting link; at most 1024 code points. */
  uri: string;
}

export interface EventAttendance extends Extra {
  /** How a person gets in, one of `attendancePolicies`. */
  policy: AttendancePolicy;
  /** Seats, 1 to 1000000 people; null for no limit. */
  capacity: bigint | null;
  /** Whether people past the capacity queue. */
  waitlist: boolean;
}

export interface EventLink extends Extra {
  /** A title to show, trimmed by the builder: 1 to 100 code points, not blank. */
  title: string;
  /** An https URL of at most 300 code points, stored as written. */
  url: string;
}

export interface EventContent extends Extra {
  /** The title, trimmed by the builder: 1 to 100 code points, not blank, no control character but tab, newline and carriage return. */
  title: string;
  /** Markdown, as an article body, trimmed by the builder: at most 50000 code points, not blank; null for none. */
  description: string | null;
  /** When it starts, a local date-time `YYYY-MM-DDTHH:MM:SS` in `timeZone`. */
  start: string;
  /** An IANA time zone name of at most 64 code points, such as `Europe/Zurich`. */
  timeZone: string;
  /** How long it lasts, an ISO 8601 duration `PnW` or `PnDTnHnMnS` of at most 31622400 seconds; required unless `showWithoutTime`; null for none. */
  duration: string | null;
  /** An all-day event: the time of `start` is not shown and `duration` may be absent. */
  showWithoutTime: boolean;
  /** Whether the event is on, one of `eventStatuses`; `confirmed` when absent. */
  status: EventStatus;
  /** Where it is: at most 10 places or meeting links; empty for none. */
  locations: EventLocation[];
  /** Who may come and how many; open with no limit when absent. */
  attendance: EventAttendance;
  /** At most 10 links shown with the event, https only; empty for none. */
  links: EventLink[];
  /** How it repeats: at most 1 rule; empty for a single event. */
  recurrenceRules: RecurrenceRule[];
  /** Occurrences removed from the series, each a local date-time in `timeZone`; at most 100. */
  excludedDates: string[];
  /** On an override of one occurrence, the master event: a versionless post reference of the same author; null otherwise. Set together with `recurrenceId`. */
  recurrenceOf: string | null;
  /** On an override of one occurrence, its local start in the master's series; null otherwise. */
  recurrenceId: string | null;
}

export interface RsvpContent extends Extra {
  /** The answer, one of `rsvpStatuses`. */
  status: RsvpStatus;
  /** The occurrence answered, its local start in the event's series; null for the series. */
  recurrenceId: string | null;
  /** Companions without an account, 0 to 100 people; 0 when absent. */
  guests: bigint;
  /** A note to the organiser, trimmed by the builder: at most 2000 code points, not blank; null for none. */
  note: string | null;
}

export interface AvailabilityBlock extends Extra {
  /** On an `available` block only, a name, trimmed by the builder: 1 to 100 code points, not blank; null for none. */
  title: string | null;
  /** When the block starts, a local date-time in the schedule's `timeZone`. */
  start: string;
  /** How long it lasts, an ISO 8601 duration of at most 31622400 seconds. */
  duration: string;
  /** On an `available` block only, the units free in it (rooms of a type, seats), 1 to 10000 units; null for one. */
  capacity: bigint | null;
  /** How it repeats: at most 1 rule; empty for once. */
  recurrenceRules: RecurrenceRule[];
  /** Occurrences removed from the series; at most 100. */
  excludedDates: string[];
}

export interface AvailabilityContent extends Extra {
  /** An IANA time zone name every block is read in, at most 64 code points. */
  timeZone: string;
  /** How far ahead the schedule is kept, 1 to 366 days. */
  horizonDays: bigint;
  /** The resource the schedule belongs to, a reference of any scheme; null for the author. */
  for: string | null;
  /** When a booking may start; at most 100 blocks. */
  available: AvailabilityBlock[];
  /** What is taken; at most 100 blocks, untitled. */
  busy: AvailabilityBlock[];
}

export interface RatingContent extends Extra {
  /** The stars, 1 to 10 half stars: 10 is five stars. */
  rating: bigint;
  /** The review, trimmed by the builder: at most 2000 code points, not blank; null for none. */
  text: string | null;
}

export const location: Codec<EventLocation> = object<EventLocation>("PubkySocialEventLocation", { name: omitted(string), uri: string });
export const attendance: Codec<EventAttendance> = object<EventAttendance>("PubkySocialEventAttendance", { policy: attendancePolicy, capacity: option(i64), waitlist: defaulted(bool, () => false) });
export const link: Codec<EventLink> = object<EventLink>("PubkySocialEventLink", { title: string, url: string });
export const event: Codec<EventContent> = object<EventContent>("PubkySocialEventContent", {
  title: string,
  description: omitted(string),
  start: string,
  timeZone: string,
  duration: omitted(string),
  showWithoutTime: defaulted(bool, () => false),
  status: defaulted(eventStatus, () => "confirmed"),
  locations: defaulted(list(location), () => []),
  attendance: defaulted(attendance, openAttendance),
  links: defaulted(list(link), () => []),
  recurrenceRules: defaulted(list(recurrenceRule), () => []),
  excludedDates: defaulted(list(string), () => []),
  recurrenceOf: omitted(string),
  recurrenceId: omitted(string),
});
export const rsvp: Codec<RsvpContent> = object<RsvpContent>("PubkySocialRsvpContent", { status: rsvpStatus, recurrenceId: omitted(string), guests: defaulted(i64, () => 0n), note: omitted(string) });
export const block: Codec<AvailabilityBlock> = object<AvailabilityBlock>("PubkySocialAvailabilityBlock", {
  title: omitted(string),
  start: string,
  duration: string,
  capacity: omitted(i64),
  recurrenceRules: defaulted(list(recurrenceRule), () => []),
  excludedDates: defaulted(list(string), () => []),
});
export const availability: Codec<AvailabilityContent> = object<AvailabilityContent>("PubkySocialAvailabilityContent", {
  timeZone: string,
  horizonDays: i64,
  for: omitted(string),
  available: defaulted(list(block), () => []),
  busy: defaulted(list(block), () => []),
});
export const rating: Codec<RatingContent> = object<RatingContent>("PubkySocialRatingContent", { rating: i64, text: omitted(string) });

function openAttendance(): EventAttendance {
  return { policy: "open", capacity: null, waitlist: false, extra: new Map() };
}

/** A reference position inside an envelope, as the post's gate takes it. */
export interface ContentRef {
  field: string;
  uri: string;
  schemes: "pubky" | "pubky or web" | "web" | "";
  max: number;
}

/** The reference positions of an event envelope, in the reference's order. */
export function eventRefs(e: EventContent): ContentRef[] {
  const refs: ContentRef[] = e.locations.map((l, index) => ({ field: `locations[${index}].uri`, uri: l.uri, schemes: "", max: limits.referenceUriMaxLength }));
  e.links.forEach((l, index) => refs.push({ field: `links[${index}].url`, uri: l.url, schemes: "web", max: limits.eventLinkUrlMaxLength }));
  if (e.recurrenceOf !== null) refs.push({ field: "recurrenceOf", uri: e.recurrenceOf, schemes: "pubky", max: limits.referenceUriMaxLength });
  return refs;
}

/** The list caps of an event envelope, run before any reference inside it is read. */
export function checkEventCounts(e: EventContent, each: Each): void {
  each(() => {
    if (e.locations.length > limits.eventLocationsMaxCount) fail("count", `Event cannot have more than ${limits.eventLocationsMaxCount} locations`, "locations", limits.eventLocationsMaxCount);
  });
  each(() => {
    if (e.links.length > limits.eventLinksMaxCount) fail("count", `Event cannot have more than ${limits.eventLinksMaxCount} links`, "links", limits.eventLinksMaxCount);
  });
}

const OTHER_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

// Absent, or 1 to `max` code points and not blank
function checkShortText(text: string | null, field: string, max: number): void {
  if (text !== null && (frozenTrim(text) === "" || codePointLen(text) > max)) fail("length", `${field} must be 1 to ${max} code points and not blank`, field, max);
}

/** The rules of an event envelope, after the post's gate ran over its references. */
export function checkEvent(e: EventContent, each: Each): void {
  each(() => checkExtra(e.extra));
  each(() => {
    const field = OTHER_CONTROL.test(e.title) ? "title" : OTHER_CONTROL.test(e.description ?? "") ? "description" : null;
    if (field !== null) fail("format", "Event text must not contain control characters other than tab, newline and carriage return", field);
  });
  each(() => {
    if (frozenTrim(e.title) === "") fail("blank", "Event title must contain non-whitespace characters", "title");
    if (codePointLen(e.title) > limits.eventTitleMaxLength) fail("length", `Event title must be at most ${limits.eventTitleMaxLength} code points`, "title", limits.eventTitleMaxLength);
  });
  each(() => {
    if (e.description === null) return;
    if (frozenTrim(e.description) === "") fail("blank", "Event description must not be blank", "description");
    if (codePointLen(e.description) > limits.eventDescriptionMaxLength)
      fail("length", `Event description must be at most ${limits.eventDescriptionMaxLength} code points`, "description", limits.eventDescriptionMaxLength);
  });
  // The rules below read the start, so they run only once it parsed
  each(() => {
    const start = checkLocalDateTime("start", e.start);
    each(() => checkTimeZone("timeZone", e.timeZone));
    each(() => {
      if (e.duration !== null) checkDuration("duration", e.duration);
      else if (!e.showWithoutTime) fail("conflict", "Event duration is required unless showWithoutTime is true", "duration");
    });
    each(() => {
      if (!isKnown(eventStatuses, e.status)) fail("unknown_name", `Event status must be one of ${eventStatuses.join(", ")}: ${e.status}`, "status");
    });
    e.locations.forEach((l, index) => {
      each(() => checkExtra(l.extra, `locations[${index}].`));
      each(() => checkShortText(l.name, `locations[${index}].name`, limits.eventLocationNameMaxLength));
      each(() => checkPlaceReference(`locations[${index}].uri`, l.uri));
    });
    each(() => checkExtra(e.attendance.extra, "attendance."));
    each(() => {
      if (!isKnown(attendancePolicies, e.attendance.policy)) fail("unknown_name", `attendance.policy must be one of ${attendancePolicies.join(", ")}: ${e.attendance.policy}`, "attendance.policy");
    });
    each(() => {
      const max = limits.eventCapacityMaxPeople;
      const capacity = e.attendance.capacity;
      if (capacity !== null && (capacity < 1n || capacity > BigInt(max))) fail("range", `attendance.capacity must be 1 to ${max} people`, "attendance.capacity", max);
    });
    e.links.forEach((l, index) => {
      each(() => checkExtra(l.extra, `links[${index}].`));
      each(() => {
        const max = limits.eventLinkTitleMaxLength;
        if (frozenTrim(l.title) === "" || codePointLen(l.title) > max) fail("length", `links[${index}].title must be 1 to ${max} code points and not blank`, `links[${index}].title`, max);
      });
      each(() => {
        if (!l.url.startsWith("https://")) fail("reference", `links[${index}].url must be an https URL: ${l.url}`, `links[${index}].url`);
      });
    });
    each(() => {
      const max = limits.eventRecurrenceRulesMaxCount;
      if (e.recurrenceRules.length > max) fail("count", `Event cannot have more than ${max} recurrence rules`, "recurrenceRules", max);
    });
    e.recurrenceRules.forEach((rule, index) => checkRecurrenceRule(`recurrenceRules[${index}]`, rule, start, each));
    each(() => {
      const max = limits.eventExcludedDatesMaxCount;
      if (e.excludedDates.length > max) fail("count", `Event cannot have more than ${max} excluded dates`, "excludedDates", max);
    });
    e.excludedDates.forEach((date, index) => each(() => void checkLocalDateTime(`excludedDates[${index}]`, date)));
    each(() => {
      if (e.recurrenceOf === null && e.recurrenceId === null) return;
      if (e.recurrenceOf === null || e.recurrenceId === null)
        fail("conflict", "recurrenceOf and recurrenceId are set together, on an override of one occurrence", e.recurrenceOf === null ? "recurrenceOf" : "recurrenceId");
      checkLocalDateTime("recurrenceId", e.recurrenceId);
      if (!namesPost(e.recurrenceOf)) fail("reference", `recurrenceOf must reference a post: ${e.recurrenceOf}`, "recurrenceOf");
      if (e.recurrenceRules.length > 0 || e.excludedDates.length > 0)
        fail("conflict", "an override of one occurrence carries no recurrence rules or excluded dates", e.recurrenceRules.length > 0 ? "recurrenceRules" : "excludedDates");
    });
  });
}

// The gate admitted a canonical, versionless pubky URI; it has to name a post
function namesPost(uri: string): boolean {
  return /^pubky:\/\/[a-z0-9]{52}\/(pub|priv)\/social\/v1\/posts\/[0-9A-Z]{13}$/.test(uri);
}

/** The rule an override needs its author for: the master is the same author's post. */
export function checkEventOwner(e: EventContent, owner: string, each: Each): void {
  each(() => {
    if (e.recurrenceOf !== null && !e.recurrenceOf.startsWith(`pubky://${owner}/`)) fail("reference", `recurrenceOf must reference a post of the same author: ${e.recurrenceOf}`, "recurrenceOf");
  });
}

/** The rules of an rsvp envelope. */
export function checkRsvp(e: RsvpContent, each: Each): void {
  each(() => checkExtra(e.extra));
  each(() => {
    if (!isKnown(rsvpStatuses, e.status)) fail("unknown_name", `Rsvp status must be one of ${rsvpStatuses.join(", ")}: ${e.status}`, "status");
  });
  each(() => {
    if (e.recurrenceId !== null) checkLocalDateTime("recurrenceId", e.recurrenceId);
  });
  each(() => {
    const max = limits.rsvpGuestsMaxPeople;
    if (e.guests < 0n || e.guests > BigInt(max)) fail("range", `Rsvp guests must be 0 to ${max} people`, "guests", max);
  });
  each(() => {
    if (e.note === null) return;
    if (frozenTrim(e.note) === "") fail("blank", "Rsvp note must not be blank", "note");
    if (codePointLen(e.note) > limits.rsvpNoteMaxLength) fail("length", `Rsvp note must be at most ${limits.rsvpNoteMaxLength} code points`, "note", limits.rsvpNoteMaxLength);
  });
}

/** The reference positions of an availability envelope. */
export function availabilityRefs(e: AvailabilityContent): ContentRef[] {
  return e.for === null ? [] : [{ field: "for", uri: e.for, schemes: "", max: limits.referenceUriMaxLength }];
}

function checkBlock(field: string, b: AvailabilityBlock, available: boolean, each: Each): void {
  each(() => checkExtra(b.extra, `${field}.`));
  each(() => {
    if (b.title === null) return;
    if (!available) fail("conflict", `${field} carries no title`, `${field}.title`);
    checkShortText(b.title, `${field}.title`, limits.availabilityBlockTitleMaxLength);
  });
  each(() => {
    if (b.capacity === null) return;
    if (!available) fail("conflict", `${field} carries no capacity`, `${field}.capacity`);
    const max = limits.availabilityCapacityMaxUnits;
    if (b.capacity < 1n || b.capacity > BigInt(max)) fail("range", `${field}.capacity must be 1 to ${max} units`, `${field}.capacity`, max);
  });
  each(() => {
    const start = checkLocalDateTime(`${field}.start`, b.start);
    each(() => void checkDuration(`${field}.duration`, b.duration));
    each(() => {
      const max = limits.eventRecurrenceRulesMaxCount;
      if (b.recurrenceRules.length > max) fail("count", `${field} cannot have more than ${max} recurrence rules`, `${field}.recurrenceRules`, max);
    });
    b.recurrenceRules.forEach((rule, index) => checkRecurrenceRule(`${field}.recurrenceRules[${index}]`, rule, start, each));
    each(() => {
      const max = limits.eventExcludedDatesMaxCount;
      if (b.excludedDates.length > max) fail("count", `${field} cannot have more than ${max} excluded dates`, `${field}.excludedDates`, max);
    });
    b.excludedDates.forEach((date, index) => each(() => void checkLocalDateTime(`${field}.excludedDates[${index}]`, date)));
  });
}

/** The rules of an availability envelope, after the post's gate ran over `for`. */
export function checkAvailability(e: AvailabilityContent, each: Each): void {
  each(() => checkExtra(e.extra));
  each(() => checkTimeZone("timeZone", e.timeZone));
  each(() => {
    const max = limits.availabilityHorizonMaxDays;
    if (e.horizonDays < 1n || e.horizonDays > BigInt(max)) fail("range", `Availability horizonDays must be 1 to ${max} days`, "horizonDays", max);
  });
  each(() => {
    const max = limits.availabilityBlocksMaxCount;
    if (e.available.length > max) fail("count", `Availability cannot have more than ${max} available blocks`, "available", max);
  });
  each(() => {
    const max = limits.availabilityBlocksMaxCount;
    if (e.busy.length > max) fail("count", `Availability cannot have more than ${max} busy blocks`, "busy", max);
  });
  e.available.forEach((b, index) => checkBlock(`available[${index}]`, b, true, each));
  e.busy.forEach((b, index) => checkBlock(`busy[${index}]`, b, false, each));
}

/** The rules of a rating envelope. */
export function checkRating(e: RatingContent, each: Each): void {
  each(() => checkExtra(e.extra));
  each(() => {
    const min = limits.ratingMinHalfStars;
    const max = limits.ratingMaxHalfStars;
    if (e.rating < BigInt(min) || e.rating > BigInt(max)) fail("range", `Rating must be ${min} to ${max} half stars`, "rating", max);
  });
  each(() => {
    if (e.text === null) return;
    if (frozenTrim(e.text) === "") fail("blank", "Rating text must not be blank", "text");
    if (codePointLen(e.text) > limits.ratingTextMaxLength) fail("length", `Rating text must be at most ${limits.ratingTextMaxLength} code points`, "text", limits.ratingTextMaxLength);
  });
}

// How a builder reads a caller's members: the shapes, under `each`, with the builder's trims

const isAbsent = (js: unknown) => js === null || js === undefined;

/** An optional integer member of a caller's input, as a bigint; absent and null are null. */
export function optionalInt(each: Each, js: unknown, at: string): bigint | null {
  return member<bigint | null>(each, () => (isAbsent(js) ? null : i64.parse(js, at)), null);
}

/** A required integer member of a caller's input, 0 when its shape is refused. */
export const requiredInt = (each: Each, js: unknown, at: string): bigint => member(each, () => i64.parse(js, at), 0n);

/** An optional boolean member of a caller's input; absent and null are `fallback`. */
export const optionalBool = (each: Each, js: unknown, at: string, fallback: boolean): boolean => member(each, () => (isAbsent(js) ? fallback : bool.parse(js, at)), fallback);

/** A caller's list of strings, each read as one; absent and null are empty. */
export function strings(each: Each, js: unknown, at: string): string[] {
  const { items } = inputReads(each);
  return items(js, at, (entry, where) => string.parse(entry, where)) ?? [];
}

/** A caller's list of integers; absent and null are empty. */
export function ints(each: Each, js: unknown, at: string): bigint[] {
  const { items } = inputReads(each);
  return items(js, at, (entry, where) => i64.parse(entry, where)) ?? [];
}

const RULE_MEMBERS = ["frequency", "interval", "firstDayOfWeek", "byDay", "byMonthDay", "byMonth", "bySetPosition", "count", "until"];

/** A caller's recurrence rules, read member by member. */
export function rulesFromInput(each: Each, js: unknown, at: string): RecurrenceRule[] {
  const { str, opt, items } = inputReads(each);
  return (
    items(js, at, (entry, where): RecurrenceRule => {
      const r = inputOf(entry, where, RULE_MEMBERS, each);
      return {
        frequency: str(r.frequency, `${where}.frequency`),
        interval: optionalInt(each, r.interval, `${where}.interval`),
        firstDayOfWeek: opt(r.firstDayOfWeek, `${where}.firstDayOfWeek`),
        byDay:
          items(r.byDay, `${where}.byDay`, (day, dayAt) => {
            const d = inputOf(day, dayAt, ["day", "nthOfPeriod"], each);
            return { day: str(d.day, `${dayAt}.day`), nthOfPeriod: optionalInt(each, d.nthOfPeriod, `${dayAt}.nthOfPeriod`), extra: new Map() };
          }) ?? [],
        byMonthDay: ints(each, r.byMonthDay, `${where}.byMonthDay`),
        byMonth: strings(each, r.byMonth, `${where}.byMonth`),
        bySetPosition: ints(each, r.bySetPosition, `${where}.bySetPosition`),
        count: optionalInt(each, r.count, `${where}.count`),
        until: opt(r.until, `${where}.until`),
        extra: new Map(),
      };
    }) ?? []
  );
}

export const EVENT_MEMBERS = [
  "title",
  "description",
  "start",
  "timeZone",
  "duration",
  "showWithoutTime",
  "status",
  "locations",
  "attendance",
  "links",
  "recurrenceRules",
  "excludedDates",
  "recurrenceOf",
  "recurrenceId",
];

/** An event envelope from a caller's input, the builder's trims applied. */
export function eventFromInput(i: Record<string, unknown>, each: Each): EventContent {
  const { str, opt, items } = inputReads(each);
  const given = i.attendance;
  const a = isAbsent(given) ? {} : inputOf(given, "input.attendance", ["policy", "capacity", "waitlist"], each);
  return {
    title: frozenTrim(str(i.title, "input.title")),
    description: trimmedOrNull(opt(i.description, "input.description")),
    start: str(i.start, "input.start"),
    timeZone: str(i.timeZone, "input.timeZone"),
    duration: opt(i.duration, "input.duration"),
    showWithoutTime: optionalBool(each, i.showWithoutTime, "input.showWithoutTime", false),
    status: opt(i.status, "input.status") ?? "confirmed",
    locations:
      items(i.locations, "input.locations", (entry, at): EventLocation => {
        const l = inputOf(entry, at, ["uri", "name"], each);
        return { name: trimmedOrNull(opt(l.name, `${at}.name`)), uri: str(l.uri, `${at}.uri`), extra: new Map() };
      }) ?? [],
    attendance: {
      policy: opt(a.policy, "input.attendance.policy") ?? "open",
      capacity: optionalInt(each, a.capacity, "input.attendance.capacity"),
      waitlist: optionalBool(each, a.waitlist, "input.attendance.waitlist", false),
      extra: new Map(),
    },
    links:
      items(i.links, "input.links", (entry, at): EventLink => {
        const l = inputOf(entry, at, ["title", "url"], each);
        return { title: frozenTrim(str(l.title, `${at}.title`)), url: str(l.url, `${at}.url`), extra: new Map() };
      }) ?? [],
    recurrenceRules: rulesFromInput(each, i.recurrenceRules, "input.recurrenceRules"),
    excludedDates: strings(each, i.excludedDates, "input.excludedDates"),
    recurrenceOf: opt(i.recurrenceOf, "input.recurrenceOf"),
    recurrenceId: opt(i.recurrenceId, "input.recurrenceId"),
    extra: new Map(),
  };
}

const BLOCK_MEMBERS = ["title", "start", "duration", "capacity", "recurrenceRules", "excludedDates"];

function blocksFromInput(each: Each, js: unknown, at: string): AvailabilityBlock[] {
  const { str, opt, items } = inputReads(each);
  return (
    items(js, at, (entry, where): AvailabilityBlock => {
      const b = inputOf(entry, where, BLOCK_MEMBERS, each);
      return {
        title: trimmedOrNull(opt(b.title, `${where}.title`)),
        start: str(b.start, `${where}.start`),
        duration: str(b.duration, `${where}.duration`),
        capacity: optionalInt(each, b.capacity, `${where}.capacity`),
        recurrenceRules: rulesFromInput(each, b.recurrenceRules, `${where}.recurrenceRules`),
        excludedDates: strings(each, b.excludedDates, `${where}.excludedDates`),
        extra: new Map(),
      };
    }) ?? []
  );
}

export const AVAILABILITY_MEMBERS = ["timeZone", "horizonDays", "for", "available", "busy"];

/** An availability envelope from a caller's input, the builder's trims applied. */
export function availabilityFromInput(i: Record<string, unknown>, each: Each): AvailabilityContent {
  const { str, opt } = inputReads(each);
  return {
    timeZone: str(i.timeZone, "input.timeZone"),
    horizonDays: requiredInt(each, i.horizonDays, "input.horizonDays"),
    for: opt(i.for, "input.for"),
    available: blocksFromInput(each, i.available, "input.available"),
    busy: blocksFromInput(each, i.busy, "input.busy"),
    extra: new Map(),
  };
}

/** An rsvp envelope from a caller's input, the builder's trims applied. */
export function rsvpFromInput(i: Record<string, unknown>, each: Each): RsvpContent {
  const { str, opt } = inputReads(each);
  return {
    status: str(i.status, "input.status"),
    recurrenceId: opt(i.recurrenceId, "input.recurrenceId"),
    guests: optionalInt(each, i.guests, "input.guests") ?? 0n,
    note: trimmedOrNull(opt(i.note, "input.note")),
    extra: new Map(),
  };
}

/** A rating envelope from a caller's input, the builder's trims applied. */
export function ratingFromInput(i: Record<string, unknown>, each: Each): RatingContent {
  const { opt } = inputReads(each);
  return { rating: requiredInt(each, i.rating, "input.rating"), text: trimmedOrNull(opt(i.text, "input.text")), extra: new Map() };
}
