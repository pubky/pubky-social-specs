// The JSCalendar (RFC 8984) value types the event kinds share, as the reference admits them: a
// local date-time, a duration, an IANA time zone name and a recurrence rule, each validated as
// the text a writer stored and never rewritten. Closed grammars, not a calendar library's
// verdict, so two engines and two versions agree.

import { limits } from "../data.js";
import { type Each, fail, throwing } from "../errors.js";
import { type Codec, type Extra, i64, object, omitted, omittedList, string } from "../json/schema.js";
import { codePointLen } from "../text.js";
import { checkExtra } from "./common.js";
import { isKnown, type RecurrenceFrequency, recurrenceFrequencies, recurrenceFrequency, type Weekday, weekday, weekdays } from "./kinds.js";

/** A JSCalendar `LocalDateTime`, `YYYY-MM-DDTHH:MM:SS`, taken apart. */
export interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const DIGITS = /^[0-9]+$/;
const digits = (s: string, at: number, count: number): number | null => (DIGITS.test(s.slice(at, at + count)) ? Number(s.slice(at, at + count)) : null);
const isLeapYear = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
const daysInMonth = (year: number, month: number): number => [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;

/** A `LocalDateTime`, or null when the text is not one: the grammar, then a real calendar date. */
export function parseLocalDateTime(s: string): LocalDateTime | null {
  if (s.length !== 19 || s[4] !== "-" || s[7] !== "-" || s[10] !== "T" || s[13] !== ":" || s[16] !== ":") return null;
  const year = digits(s, 0, 4);
  const month = digits(s, 5, 2);
  const day = digits(s, 8, 2);
  const hour = digits(s, 11, 2);
  const minute = digits(s, 14, 2);
  const second = digits(s, 17, 2);
  if (year === null || month === null || day === null || hour === null || minute === null || second === null) return null;
  if (year === 0 || month < 1 || month > 12 || day === 0 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  return { year, month, day, hour, minute, second };
}

/** Local date-times compare as their text does. */
const compare = (a: LocalDateTime, b: LocalDateTime): number => a.year - b.year || a.month - b.month || a.day - b.day || a.hour - b.hour || a.minute - b.minute || a.second - b.second;

export function checkLocalDateTime(field: string, value: string): LocalDateTime {
  return parseLocalDateTime(value) ?? fail("format", `${field} must be a local date-time of the form YYYY-MM-DDTHH:MM:SS: ${value}`, field);
}

// 1*DIGIT at the head of `s`, at most nine digits so no sum below loses precision
function number(s: string): [number, string] | null {
  const m = /^[0-9]{1,9}(?![0-9])/.exec(s);
  return m === null ? null : [Number(m[0]), s.slice(m[0].length)];
}

/**
 * A JSCalendar `Duration`, `PnW` or `PnDTnHnMnS` with every component optional but at least
 * one present, in seconds; null when the text is not one. Weeks stand alone; a sign and a
 * fraction of a second are refused.
 */
export function parseDurationSeconds(s: string): number | null {
  if (!s.startsWith("P")) return null;
  let rest = s.slice(1);
  let seconds = 0;
  let components = 0;
  let n = number(rest);
  if (n !== null && n[1].startsWith("W")) return n[1].length === 1 ? n[0] * 7 * 86_400 : null;
  if (n !== null && n[1].startsWith("D")) {
    seconds += n[0] * 86_400;
    rest = n[1].slice(1);
    components++;
  }
  if (rest.startsWith("T")) {
    rest = rest.slice(1);
    let timeComponents = 0;
    for (const [unit, factor] of [
      ["H", 3_600],
      ["M", 60],
      ["S", 1],
    ] as const) {
      n = number(rest);
      if (n !== null && n[1].startsWith(unit)) {
        seconds += n[0] * factor;
        rest = n[1].slice(1);
        timeComponents++;
      }
    }
    if (timeComponents === 0) return null;
    components += timeComponents;
  }
  return components > 0 && rest === "" ? seconds : null;
}

export function checkDuration(field: string, value: string): number {
  const seconds = parseDurationSeconds(value) ?? fail("format", `${field} must be an ISO 8601 duration of the form PnW or PnDTnHnMnS: ${value}`, field);
  const max = limits.eventDurationMaxSeconds;
  if (seconds > max) fail("range", `${field} must be at most ${max} seconds: ${value}`, field, max);
  return seconds;
}

/**
 * Whether `s` is shaped like an IANA time zone name: `Area/Location` segments of ASCII
 * letters, digits, `_`, `+` and `-`, the first character a letter, within the cap. Whether the
 * name is in the tz database is the reader's question.
 */
export function isTimeZoneName(s: string): boolean {
  return s !== "" && codePointLen(s) <= limits.eventTimeZoneMaxLength && /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(s);
}

export function checkTimeZone(field: string, value: string): void {
  if (!isTimeZoneName(value)) fail("format", `${field} must be an IANA time zone name of at most ${limits.eventTimeZoneMaxLength} code points: ${value}`, field);
}

export interface NthDay extends Extra {
  /** The weekday, one of `weekdays`. */
  day: Weekday;
  /** Which one of the period, an index -53 to 53 and never 0, negative from the end; null for every such day. */
  nthOfPeriod: bigint | null;
}

export interface RecurrenceRule extends Extra {
  /** How often, one of `recurrenceFrequencies`. */
  frequency: RecurrenceFrequency;
  /** Every `interval`th period, 1 to 1000 periods; null for every period. */
  interval: bigint | null;
  /** The first day of the week for a weekly rule, one of `weekdays`; null for the default. */
  firstDayOfWeek: Weekday | null;
  /** The weekdays, with which one of the period; at most 31 entries. */
  byDay: NthDay[];
  /** Days of the month, -31 to 31 and never 0; at most 31 entries. */
  byMonthDay: bigint[];
  /** Months, `"1"` to `"12"`; at most 31 entries. */
  byMonth: string[];
  /** Positions in the expanded period, -366 to 366 and never 0; at most 31 entries. */
  bySetPosition: bigint[];
  /** Occurrences in all, 1 to 1000; null for no count. */
  count: bigint | null;
  /** The last local date-time an occurrence may start, at most 3 years after the start; null for none. */
  until: string | null;
}

export const nthDay: Codec<NthDay> = object<NthDay>("PubkySocialNthDay", { day: weekday, nthOfPeriod: omitted(i64) });
export const recurrenceRule: Codec<RecurrenceRule> = object<RecurrenceRule>("PubkySocialRecurrenceRule", {
  frequency: recurrenceFrequency,
  interval: omitted(i64),
  firstDayOfWeek: omitted(weekday),
  byDay: omittedList(nthDay),
  byMonthDay: omittedList(i64),
  byMonth: omittedList(string),
  bySetPosition: omittedList(i64),
  count: omitted(i64),
  until: omitted(string),
});

const WEEKDAYS = weekdays.join(", ");

function checkByCount(field: string, name: string, length: number): void {
  const max = limits.eventRecurrenceByMaxCount;
  if (length > max) fail("count", `${field}.${name} cannot have more than ${max} entries`, `${field}.${name}`, max);
}

function checkSigned(field: string, value: bigint, bound: number): void {
  if (value === 0n || value < -BigInt(bound) || value > BigInt(bound)) fail("range", `${field} must be -${bound} to ${bound} and not 0`, field, bound);
}

/** The rules of one recurrence rule at `field`, `start` being the start of what recurs. */
export function checkRecurrenceRule(field: string, rule: RecurrenceRule, start: LocalDateTime, each: Each = throwing): void {
  each(() => checkExtra(rule.extra, `${field}.`));
  each(() => {
    if (!isKnown(recurrenceFrequencies, rule.frequency)) fail("unknown_name", `${field}.frequency must be one of ${recurrenceFrequencies.join(", ")}: ${rule.frequency}`, `${field}.frequency`);
  });
  each(() => {
    const max = limits.eventRecurrenceIntervalMaxPeriods;
    if (rule.interval !== null && (rule.interval < 1n || rule.interval > BigInt(max))) fail("range", `${field}.interval must be 1 to ${max}`, `${field}.interval`, max);
  });
  each(() => {
    if (rule.firstDayOfWeek !== null && !isKnown(weekdays, rule.firstDayOfWeek))
      fail("unknown_name", `${field}.firstDayOfWeek must be one of ${WEEKDAYS}: ${rule.firstDayOfWeek}`, `${field}.firstDayOfWeek`);
  });
  each(() => checkByCount(field, "byDay", rule.byDay.length));
  each(() => checkByCount(field, "byMonthDay", rule.byMonthDay.length));
  each(() => checkByCount(field, "byMonth", rule.byMonth.length));
  each(() => checkByCount(field, "bySetPosition", rule.bySetPosition.length));
  rule.byDay.forEach((entry, index) => {
    const at = `${field}.byDay[${index}]`;
    each(() => checkExtra(entry.extra, `${at}.`));
    each(() => {
      if (!isKnown(weekdays, entry.day)) fail("unknown_name", `${at}.day must be one of ${WEEKDAYS}: ${entry.day}`, `${at}.day`);
    });
    each(() => {
      if (entry.nthOfPeriod !== null) checkSigned(`${at}.nthOfPeriod`, entry.nthOfPeriod, 53);
    });
  });
  rule.byMonthDay.forEach((day, index) => each(() => checkSigned(`${field}.byMonthDay[${index}]`, day, 31)));
  rule.byMonth.forEach((month, index) =>
    each(() => {
      if (!/^([1-9]|1[0-2])$/.test(month)) fail("format", `${field}.byMonth[${index}] must be a month number 1 to 12: ${month}`, `${field}.byMonth[${index}]`);
    }),
  );
  rule.bySetPosition.forEach((position, index) => each(() => checkSigned(`${field}.bySetPosition[${index}]`, position, 366)));
  each(() => {
    const max = limits.eventRecurrenceMaxOccurrences;
    if (rule.count !== null && (rule.count < 1n || rule.count > BigInt(max))) fail("range", `${field}.count must be 1 to ${max} occurrences`, `${field}.count`, max);
  });
  each(() => {
    if (rule.until === null) return;
    const until = checkLocalDateTime(`${field}.until`, rule.until);
    const years = limits.eventRecurrenceMaxSpanYears;
    const horizon = { ...start, year: Math.min(start.year + years, 65535) };
    if (compare(until, start) < 0 || compare(until, horizon) > 0) fail("range", `${field}.until must be on or after start and at most ${years} years after it: ${rule.until}`, `${field}.until`, years);
  });
}
