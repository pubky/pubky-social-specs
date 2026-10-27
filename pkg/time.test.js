// The JSCalendar value rules on their own: the grammars of a local date-time, a duration and a
// time zone name, and a recurrence rule's members, each in the reference's words. The kinds
// that carry them are in events.test.js.

import assert from "assert";
import { checkDuration, checkLocalDateTime, checkRecurrenceRule, checkTimeZone, isTimeZoneName, parseDurationSeconds, parseLocalDateTime, recurrenceRule } from "./dist/models/time.js";
import { parse } from "./dist/models/common.js";
import { limits, ValidationError } from "./dist/index.js";

const refusal = (fn) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ValidationError) return e.message;
    throw e;
  }
  assert.fail("no refusal");
};

describe("the JSCalendar value rules", () => {
  it("read a local date-time by its grammar and the calendar", () => {
    assert.deepStrictEqual(parseLocalDateTime("2026-10-14T18:30:00"), { year: 2026, month: 10, day: 14, hour: 18, minute: 30, second: 0 });
    assert.ok(parseLocalDateTime("2024-02-29T00:00:00") && parseLocalDateTime("2000-02-29T23:59:59"));
    for (const bad of [
      "2023-02-29T00:00:00",
      "1900-02-29T00:00:00",
      "2026-13-01T00:00:00",
      "2026-00-10T00:00:00",
      "2026-04-31T00:00:00",
      "2026-10-14T24:00:00",
      "2026-10-14T18:60:00",
      "2026-10-14T18:30:60",
      "2026-10-14T18:30:00Z",
      "2026-10-14T18:30:00.000",
      "2026-10-14T18:30",
      "2026-10-14 18:30:00",
      "2026-10-14t18:30:00",
      "0000-01-01T00:00:00",
      "２026-10-14T18:30:00",
      " 2026-10-14T18:30:00",
      "",
    ]) {
      assert.strictEqual(parseLocalDateTime(bad), null, bad);
    }
    assert.strictEqual(
      refusal(() => checkLocalDateTime("start", "soon")),
      "Validation Error: start must be a local date-time of the form YYYY-MM-DDTHH:MM:SS: soon",
    );
  });

  it("read a duration by its grammar, into seconds, under the cap", () => {
    for (const [text, seconds] of [
      ["PT2H30M", 9_000],
      ["P1D", 86_400],
      ["P2W", 1_209_600],
      ["PT0S", 0],
      ["P1DT1H1M1S", 90_061],
      ["PT90M", 5_400],
      ["PT1H1S", 3_601],
      ["P0D", 0],
      ["PT000005M", 300],
    ]) {
      assert.strictEqual(parseDurationSeconds(text), seconds, text);
    }
    for (const bad of ["", "P", "PT", "P1W1D", "P1WT1H", "PT1H1H", "PT1M1H", "P1DT", "PT1.5S", "-PT1H", "+PT1H", "pt1h", "P1Y", "P1M", "PT1H ", " PT1H", "PT1000000000S", "PT1Hx"]) {
      assert.strictEqual(parseDurationSeconds(bad), null, bad);
    }
    assert.strictEqual(checkDuration("duration", "P366D"), limits.eventDurationMaxSeconds);
    assert.strictEqual(
      refusal(() => checkDuration("duration", "P367D")),
      `Validation Error: duration must be at most ${limits.eventDurationMaxSeconds} seconds: P367D`,
    );
    assert.strictEqual(
      refusal(() => checkDuration("duration", "2h")),
      "Validation Error: duration must be an ISO 8601 duration of the form PnW or PnDTnHnMnS: 2h",
    );
  });

  it("take a time zone name by its shape", () => {
    for (const ok of ["Europe/Zurich", "UTC", "Etc/GMT+2", "America/Argentina/Buenos_Aires", "US/Pacific-New", "Z", "a".repeat(64)]) assert.ok(isTimeZoneName(ok), ok);
    for (const bad of ["", "/Europe", "Europe/", "Europe//Zurich", "Europe/Zürich", "Europe Zurich", "+02:00", "1Europe", "a".repeat(65)]) assert.ok(!isTimeZoneName(bad), bad);
    assert.strictEqual(
      refusal(() => checkTimeZone("timeZone", "CET+1 ")),
      "Validation Error: timeZone must be an IANA time zone name of at most 64 code points: CET+1 ",
    );
  });

  describe("a recurrence rule", () => {
    const start = parseLocalDateTime("2026-10-14T18:30:00");
    const rule = (json) => parse(recurrenceRule, json);
    const err = (json) => refusal(() => checkRecurrenceRule("recurrenceRules[0]", rule(json), start));

    it("accepts the design example and the edges", () => {
      for (const ok of [
        '{"frequency":"monthly","byDay":[{"day":"tu","nthOfPeriod":2}]}',
        '{"frequency":"weekly","interval":2,"byDay":[{"day":"mo"},{"day":"we"}],"count":1000}',
        '{"frequency":"yearly","byMonth":["10"],"byMonthDay":[14,-1],"bySetPosition":[1,-366]}',
        '{"frequency":"daily","until":"2029-10-14T18:30:00","firstDayOfWeek":"su"}',
        '{"frequency":"daily","until":"2026-10-14T18:30:00"}',
        '{"frequency":"daily","interval":1000,"future":true}',
      ]) {
        checkRecurrenceRule("r", rule(ok), start);
      }
      assert.strictEqual(recurrenceRule.write(rule('{"frequency":"daily","interval":1000,"future":true}')), '{"frequency":"daily","interval":1000,"future":true}');
    });

    it("refuses each member in the reference's words", () => {
      assert.strictEqual(err('{"frequency":"hourly"}'), "Validation Error: recurrenceRules[0].frequency must be one of yearly, monthly, weekly, daily: hourly");
      assert.strictEqual(err('{"frequency":"daily","interval":0}'), "Validation Error: recurrenceRules[0].interval must be 1 to 1000");
      assert.match(err('{"frequency":"daily","interval":1001}'), /interval/);
      assert.strictEqual(err('{"frequency":"weekly","firstDayOfWeek":"monday"}'), "Validation Error: recurrenceRules[0].firstDayOfWeek must be one of mo, tu, we, th, fr, sa, su: monday");
      assert.strictEqual(err('{"frequency":"weekly","byDay":[{"day":"Mo"}]}'), "Validation Error: recurrenceRules[0].byDay[0].day must be one of mo, tu, we, th, fr, sa, su: Mo");
      assert.strictEqual(err('{"frequency":"monthly","byDay":[{"day":"mo","nthOfPeriod":0}]}'), "Validation Error: recurrenceRules[0].byDay[0].nthOfPeriod must be -53 to 53 and not 0");
      assert.match(err('{"frequency":"monthly","byDay":[{"day":"mo","nthOfPeriod":54}]}'), /nthOfPeriod/);
      assert.strictEqual(err('{"frequency":"monthly","byMonthDay":[32]}'), "Validation Error: recurrenceRules[0].byMonthDay[0] must be -31 to 31 and not 0");
      for (const bad of ["0", "13", "01", "+1", "1L", "a", ""])
        assert.strictEqual(err(`{"frequency":"yearly","byMonth":["${bad}"]}`), `Validation Error: recurrenceRules[0].byMonth[0] must be a month number 1 to 12: ${bad}`);
      assert.strictEqual(err('{"frequency":"monthly","bySetPosition":[367]}'), "Validation Error: recurrenceRules[0].bySetPosition[0] must be -366 to 366 and not 0");
      assert.strictEqual(err('{"frequency":"daily","count":1001}'), "Validation Error: recurrenceRules[0].count must be 1 to 1000 occurrences");
      assert.match(err('{"frequency":"daily","count":0}'), /count/);
      assert.strictEqual(
        err('{"frequency":"daily","until":"2029-10-14T18:30:01"}'),
        "Validation Error: recurrenceRules[0].until must be on or after start and at most 3 years after it: 2029-10-14T18:30:01",
      );
      assert.match(err('{"frequency":"daily","until":"2026-10-14T18:29:59"}'), /until/);
      assert.strictEqual(err('{"frequency":"daily","until":"tomorrow"}'), "Validation Error: recurrenceRules[0].until must be a local date-time of the form YYYY-MM-DDTHH:MM:SS: tomorrow");
      assert.strictEqual(
        err(
          `{"frequency":"monthly","byMonthDay":[${Array(limits.eventRecurrenceByMaxCount + 1)
            .fill("1")
            .join(",")}]}`,
        ),
        "Validation Error: recurrenceRules[0].byMonthDay cannot have more than 31 entries",
      );
      assert.match(err('{"frequency":"daily","byDay":[{"day":"mo","day2":9007199254740992}]}'), /JSON-safe/);
      assert.match(err('{"frequency":"daily","x":9007199254740992}'), /JSON-safe/);
    });

    it("measures until in calendar years, from a leap day too", () => {
      const leap = parseLocalDateTime("2028-02-29T10:00:00");
      checkRecurrenceRule("r", rule('{"frequency":"yearly","until":"2031-02-28T10:00:00"}'), leap);
      assert.match(
        refusal(() => checkRecurrenceRule("r", rule('{"frequency":"yearly","until":"2031-03-01T00:00:00"}'), leap)),
        /until/,
      );
    });
  });
});
