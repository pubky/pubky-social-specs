//! The JSCalendar (RFC 8984) value types the event kinds share: a local date-time, a duration,
//! an IANA time zone name and a recurrence rule. Each is validated as the text a writer stored
//! and never rewritten, the same discipline as every reference. The rules here are the closed
//! grammars below, not a calendar library's: a library's verdict cannot be pinned across
//! versions and two engines, and the indexer evaluates the values, this crate only admits them.

use crate::common::{check_extra, code_point_len};
use crate::limits::VALIDATION_LIMITS;
use serde::{Deserialize, Serialize};

#[cfg(feature = "openapi")]
use utoipa::ToSchema;

/// A JSCalendar `LocalDateTime`, `YYYY-MM-DDTHH:MM:SS`: a wall-clock time with no offset, read
/// against the object's `timeZone`. Fractions of a second and a `Z` are rejected, so one instant
/// has one spelling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct LocalDateTime {
    pub year: u16,
    pub month: u8,
    pub day: u8,
    pub hour: u8,
    pub minute: u8,
    pub second: u8,
}

fn digits(s: &str, at: usize, count: usize) -> Option<u32> {
    let slice = s.get(at..at + count)?;
    if !slice.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    slice.parse().ok()
}

fn is_leap_year(year: u16) -> bool {
    (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400)
}

fn days_in_month(year: u16, month: u8) -> u8 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

/// Parses a `LocalDateTime`, or `None` when the text is not one: the grammar, then a real
/// calendar date (leap years included), hours 0 to 23, minutes and seconds 0 to 59.
pub fn parse_local_date_time(s: &str) -> Option<LocalDateTime> {
    if s.len() != 19 || !s.is_ascii() {
        return None;
    }
    let b = s.as_bytes();
    if b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let year = digits(s, 0, 4)? as u16;
    let month = digits(s, 5, 2)? as u8;
    let day = digits(s, 8, 2)? as u8;
    let hour = digits(s, 11, 2)? as u8;
    let minute = digits(s, 14, 2)? as u8;
    let second = digits(s, 17, 2)? as u8;
    if year == 0 || !(1..=12).contains(&month) || day == 0 || day > days_in_month(year, month) {
        return None;
    }
    if hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    Some(LocalDateTime {
        year,
        month,
        day,
        hour,
        minute,
        second,
    })
}

/// The rule on a local date-time member named `field`.
pub fn validate_local_date_time(field: &str, value: &str) -> Result<LocalDateTime, String> {
    parse_local_date_time(value).ok_or_else(|| {
        format!(
            "Validation Error: {field} must be a local date-time of the form YYYY-MM-DDTHH:MM:SS: {value}"
        )
    })
}

/// Reads `1*DIGIT` at the head of `s`, at most nine digits so no sum below overflows; returns
/// the value and the rest.
fn number(s: &str) -> Option<(u64, &str)> {
    let end = s.bytes().take_while(|b| b.is_ascii_digit()).count();
    if end == 0 || end > 9 {
        return None;
    }
    Some((s[..end].parse().ok()?, &s[end..]))
}

/// Parses a JSCalendar `Duration`, `PnW` or `PnDTnHnMnS` with every component optional but at
/// least one present, into seconds. Weeks stand alone, as in ISO 8601; a sign and a fraction of
/// a second are rejected. `None` when the text is not one.
pub fn parse_duration_seconds(s: &str) -> Option<u64> {
    let mut rest = s.strip_prefix('P')?;
    let mut seconds: u64 = 0;
    let mut components = 0;
    if let Some((n, after)) = number(rest).filter(|(_, after)| after.starts_with('W')) {
        seconds += n * 7 * 86_400;
        rest = &after[1..];
        // A week duration carries nothing else
        return rest.is_empty().then_some(seconds);
    }
    if let Some((n, after)) = number(rest).filter(|(_, after)| after.starts_with('D')) {
        seconds += n * 86_400;
        rest = &after[1..];
        components += 1;
    }
    if let Some(time) = rest.strip_prefix('T') {
        rest = time;
        let mut time_components = 0;
        for (unit, factor) in [('H', 3_600u64), ('M', 60), ('S', 1)] {
            if let Some((n, after)) = number(rest).filter(|(_, after)| after.starts_with(unit)) {
                seconds += n * factor;
                rest = &after[1..];
                time_components += 1;
            }
        }
        // `PT` alone names nothing
        if time_components == 0 {
            return None;
        }
        components += time_components;
    }
    (components > 0 && rest.is_empty()).then_some(seconds)
}

/// The rule on a duration member named `field`: the grammar, then the cap. Returns the seconds.
pub fn validate_duration(field: &str, value: &str) -> Result<u64, String> {
    let seconds = parse_duration_seconds(value).ok_or_else(|| {
        format!(
            "Validation Error: {field} must be an ISO 8601 duration of the form PnW or PnDTnHnMnS: {value}"
        )
    })?;
    let max = VALIDATION_LIMITS.event_duration_max_seconds;
    if seconds > max {
        return Err(format!(
            "Validation Error: {field} must be at most {max} seconds: {value}"
        ));
    }
    Ok(seconds)
}

/// Whether `s` is shaped like an IANA time zone name: `Area/Location` segments of ASCII
/// letters, digits, `_`, `+` and `-`, the first character a letter, within the cap. Whether the
/// name is in the current tz database is the reader's question, not this crate's: the database
/// changes several times a year and a frozen copy would refuse real zones.
pub fn is_time_zone_name(s: &str) -> bool {
    let max = VALIDATION_LIMITS.event_time_zone_max_length;
    if s.is_empty() || code_point_len(s) > max || !s.as_bytes()[0].is_ascii_alphabetic() {
        return false;
    }
    s.split('/').all(|segment| {
        !segment.is_empty()
            && segment
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'+' | b'-'))
    })
}

/// The rule on a time zone member named `field`.
pub fn validate_time_zone(field: &str, value: &str) -> Result<(), String> {
    if !is_time_zone_name(value) {
        return Err(format!(
            "Validation Error: {field} must be an IANA time zone name of at most {} code points: {value}",
            VALIDATION_LIMITS.event_time_zone_max_length
        ));
    }
    Ok(())
}

/// The frequency of a recurrence rule: the four JSCalendar values a calendar event uses. The
/// sub-daily ones are not admitted, since an occurrence index cannot hold them.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(from = "String", into = "String")]
#[non_exhaustive]
pub enum PubkySocialRecurrenceFrequency {
    Yearly,
    Monthly,
    Weekly,
    Daily,
    Unknown(String),
}

wire_names!(PubkySocialRecurrenceFrequency {
    Yearly => "yearly",
    Monthly => "monthly",
    Weekly => "weekly",
    Daily => "daily",
});

/// A day of the week as JSCalendar spells it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(from = "String", into = "String")]
#[non_exhaustive]
pub enum PubkySocialWeekday {
    Mo,
    Tu,
    We,
    Th,
    Fr,
    Sa,
    Su,
    Unknown(String),
}

wire_names!(PubkySocialWeekday {
    Mo => "mo",
    Tu => "tu",
    We => "we",
    Th => "th",
    Fr => "fr",
    Sa => "sa",
    Su => "su",
});

/// One `byDay` entry: a weekday, and for a monthly or yearly rule which one of the period
/// (`2` the second, `-1` the last).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "openapi", derive(ToSchema))]
#[serde(rename_all = "camelCase")]
pub struct PubkySocialNthDay {
    pub day: PubkySocialWeekday,
    /// `-53` to `53`, never `0`; absent for every such day of the period.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nth_of_period: Option<i64>,
    /// Unknown members, preserved on rewrite; see the module contract in `models/mod.rs`.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// A JSCalendar `RecurrenceRule`, the members a calendar event uses. Integers are `i64` so a
/// value outside its range is this crate's refusal, worded the same in both implementations.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "openapi", derive(ToSchema))]
#[serde(rename_all = "camelCase")]
pub struct PubkySocialRecurrenceRule {
    pub frequency: PubkySocialRecurrenceFrequency,
    /// Every `interval`th period; `1` when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_day_of_week: Option<PubkySocialWeekday>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub by_day: Vec<PubkySocialNthDay>,
    /// Days of the month, `-31` to `31`, never `0`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub by_month_day: Vec<i64>,
    /// Months as JSCalendar spells them, `"1"` to `"12"`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub by_month: Vec<String>,
    /// Positions in the expanded period, `-366` to `366`, never `0`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub by_set_position: Vec<i64>,
    /// Occurrences in all, at most `event_recurrence_max_occurrences`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<i64>,
    /// The last local date-time an occurrence may start, at most
    /// `event_recurrence_max_span_years` after the start.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<String>,
    /// Unknown members, preserved on rewrite; see the module contract in `models/mod.rs`.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl PubkySocialRecurrenceRule {
    /// A rule of `frequency` alone; the other members are public and default to absent.
    pub fn new(frequency: PubkySocialRecurrenceFrequency) -> Self {
        Self {
            frequency,
            interval: None,
            first_day_of_week: None,
            by_day: Vec::new(),
            by_month_day: Vec::new(),
            by_month: Vec::new(),
            by_set_position: Vec::new(),
            count: None,
            until: None,
            extra: Default::default(),
        }
    }
}

const WEEKDAYS: &str = "mo, tu, we, th, fr, sa, su";

/// A `by*` list is bounded before any of its entries is read.
fn check_by_count(field: &str, name: &str, len: usize) -> Result<(), String> {
    let max = VALIDATION_LIMITS.event_recurrence_by_max_count;
    if len > max {
        return Err(format!(
            "Validation Error: {field}.{name} cannot have more than {max} entries"
        ));
    }
    Ok(())
}

/// The rules of one recurrence rule at `field` (`recurrenceRules[0]`), `start` being the
/// start of what recurs, which `until` is measured from.
pub fn validate_recurrence_rule(
    field: &str,
    rule: &PubkySocialRecurrenceRule,
    start: LocalDateTime,
) -> Result<(), String> {
    check_extra(
        &rule.extra,
        &[
            "frequency",
            "interval",
            "firstDayOfWeek",
            "byDay",
            "byMonthDay",
            "byMonth",
            "bySetPosition",
            "count",
            "until",
        ],
    )?;
    if !rule.frequency.is_known() {
        return Err(format!(
            "Validation Error: {field}.frequency must be one of yearly, monthly, weekly, daily: {}",
            rule.frequency.wire_name()
        ));
    }
    let max_interval = VALIDATION_LIMITS.event_recurrence_interval_max_periods;
    if let Some(interval) = rule.interval {
        if interval < 1 || interval > max_interval as i64 {
            return Err(format!(
                "Validation Error: {field}.interval must be 1 to {max_interval}"
            ));
        }
    }
    if let Some(day) = &rule.first_day_of_week {
        if !day.is_known() {
            return Err(format!(
                "Validation Error: {field}.firstDayOfWeek must be one of {WEEKDAYS}: {}",
                day.wire_name()
            ));
        }
    }
    check_by_count(field, "byDay", rule.by_day.len())?;
    check_by_count(field, "byMonthDay", rule.by_month_day.len())?;
    check_by_count(field, "byMonth", rule.by_month.len())?;
    check_by_count(field, "bySetPosition", rule.by_set_position.len())?;
    for (index, entry) in rule.by_day.iter().enumerate() {
        check_extra(&entry.extra, &["day", "nthOfPeriod"])?;
        if !entry.day.is_known() {
            return Err(format!(
                "Validation Error: {field}.byDay[{index}].day must be one of {WEEKDAYS}: {}",
                entry.day.wire_name()
            ));
        }
        if let Some(nth) = entry.nth_of_period {
            if nth == 0 || !(-53..=53).contains(&nth) {
                return Err(format!(
                    "Validation Error: {field}.byDay[{index}].nthOfPeriod must be -53 to 53 and not 0"
                ));
            }
        }
    }
    for (index, day) in rule.by_month_day.iter().enumerate() {
        if *day == 0 || !(-31..=31).contains(day) {
            return Err(format!(
                "Validation Error: {field}.byMonthDay[{index}] must be -31 to 31 and not 0"
            ));
        }
    }
    for (index, month) in rule.by_month.iter().enumerate() {
        let number: Option<u8> = month.parse().ok();
        let plain = month
            .as_bytes()
            .first()
            .is_some_and(|b| *b != b'0' && *b != b'+');
        if !plain || !number.is_some_and(|m| (1..=12).contains(&m)) {
            return Err(format!(
                "Validation Error: {field}.byMonth[{index}] must be a month number 1 to 12: {month}"
            ));
        }
    }
    for (index, position) in rule.by_set_position.iter().enumerate() {
        if *position == 0 || !(-366..=366).contains(position) {
            return Err(format!(
                "Validation Error: {field}.bySetPosition[{index}] must be -366 to 366 and not 0"
            ));
        }
    }
    let max_count = VALIDATION_LIMITS.event_recurrence_max_occurrences;
    if let Some(count) = rule.count {
        if count < 1 || count > max_count as i64 {
            return Err(format!(
                "Validation Error: {field}.count must be 1 to {max_count} occurrences"
            ));
        }
    }
    if let Some(until) = &rule.until {
        let until_at = validate_local_date_time(&format!("{field}.until"), until)?;
        let years = VALIDATION_LIMITS.event_recurrence_max_span_years;
        let horizon = LocalDateTime {
            year: start.year.saturating_add(years as u16),
            ..start
        };
        if until_at < start || until_at > horizon {
            return Err(format!(
                "Validation Error: {field}.until must be on or after start and at most {years} years after it: {until}"
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_date_time_grammar() {
        let ok = parse_local_date_time("2026-10-14T18:30:00").unwrap();
        assert_eq!((ok.year, ok.month, ok.day), (2026, 10, 14));
        assert_eq!((ok.hour, ok.minute, ok.second), (18, 30, 0));
        assert!(parse_local_date_time("2024-02-29T00:00:00").is_some());
        assert!(parse_local_date_time("2000-02-29T23:59:59").is_some());
        for bad in [
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
        ] {
            assert!(parse_local_date_time(bad).is_none(), "{bad:?}");
        }
        let e = validate_local_date_time("start", "soon").unwrap_err();
        assert_eq!(
            e,
            "Validation Error: start must be a local date-time of the form YYYY-MM-DDTHH:MM:SS: soon"
        );
    }

    #[test]
    fn local_date_times_order_as_text() {
        let a = parse_local_date_time("2026-10-14T18:30:00").unwrap();
        let b = parse_local_date_time("2026-10-14T18:30:01").unwrap();
        let c = parse_local_date_time("2027-01-01T00:00:00").unwrap();
        assert!(a < b && b < c);
    }

    #[test]
    fn duration_grammar_and_seconds() {
        for (text, seconds) in [
            ("PT2H30M", 9_000),
            ("P1D", 86_400),
            ("P2W", 1_209_600),
            ("PT0S", 0),
            ("P1DT1H1M1S", 90_061),
            ("PT90M", 5_400),
            ("PT1H1S", 3_601),
            ("P0D", 0),
            ("PT000005M", 300),
        ] {
            assert_eq!(parse_duration_seconds(text), Some(seconds), "{text}");
        }
        for bad in [
            "",
            "P",
            "PT",
            "P1W1D",
            "P1WT1H",
            "PT1H1H",
            "PT1M1H",
            "P1DT",
            "PT1.5S",
            "-PT1H",
            "+PT1H",
            "pt1h",
            "P1Y",
            "P1M",
            "PT1H ",
            " PT1H",
            "PT1000000000S",
            "PT1Hx",
        ] {
            assert!(parse_duration_seconds(bad).is_none(), "{bad:?}");
        }
        assert_eq!(
            validate_duration("duration", "P366D"),
            Ok(VALIDATION_LIMITS.event_duration_max_seconds)
        );
        let e = validate_duration("duration", "P367D").unwrap_err();
        assert_eq!(
            e,
            format!(
                "Validation Error: duration must be at most {} seconds: P367D",
                VALIDATION_LIMITS.event_duration_max_seconds
            )
        );
        let e = validate_duration("duration", "2h").unwrap_err();
        assert_eq!(
            e,
            "Validation Error: duration must be an ISO 8601 duration of the form PnW or PnDTnHnMnS: 2h"
        );
    }

    #[test]
    fn time_zone_names() {
        for ok in [
            "Europe/Zurich",
            "UTC",
            "Etc/GMT+2",
            "America/Argentina/Buenos_Aires",
            "US/Pacific-New",
            "Z",
        ] {
            assert!(is_time_zone_name(ok), "{ok}");
        }
        for bad in [
            "",
            "/Europe",
            "Europe/",
            "Europe//Zurich",
            "Europe/Zürich",
            "Europe Zurich",
            "+02:00",
            "1Europe",
            &"a".repeat(VALIDATION_LIMITS.event_time_zone_max_length + 1),
        ] {
            assert!(!is_time_zone_name(bad), "{bad:?}");
        }
        assert!(is_time_zone_name(
            &"a".repeat(VALIDATION_LIMITS.event_time_zone_max_length)
        ));
        let e = validate_time_zone("timeZone", "CET+1 ").unwrap_err();
        assert_eq!(
            e,
            "Validation Error: timeZone must be an IANA time zone name of at most 64 code points: CET+1 "
        );
    }

    fn start() -> LocalDateTime {
        parse_local_date_time("2026-10-14T18:30:00").unwrap()
    }

    fn rule(json: &str) -> PubkySocialRecurrenceRule {
        serde_json::from_str(json).unwrap()
    }

    fn err(json: &str) -> String {
        validate_recurrence_rule("recurrenceRules[0]", &rule(json), start()).unwrap_err()
    }

    #[test]
    fn recurrence_rule_accepts_the_design_example_and_the_edges() {
        for ok in [
            r#"{"frequency":"monthly","byDay":[{"day":"tu","nthOfPeriod":2}]}"#,
            r#"{"frequency":"weekly","interval":2,"byDay":[{"day":"mo"},{"day":"we"}],"count":1000}"#,
            r#"{"frequency":"yearly","byMonth":["10"],"byMonthDay":[14,-1],"bySetPosition":[1,-366]}"#,
            r#"{"frequency":"daily","until":"2029-10-14T18:30:00","firstDayOfWeek":"su"}"#,
            r#"{"frequency":"daily","until":"2026-10-14T18:30:00"}"#,
            r#"{"frequency":"daily","interval":1000,"future":true}"#,
        ] {
            assert_eq!(
                validate_recurrence_rule("r", &rule(ok), start()),
                Ok(()),
                "{ok}"
            );
        }
        // written back with every member it was read with, unknown ones included
        let r = rule(r#"{"frequency":"daily","interval":1000,"future":true}"#);
        assert_eq!(
            serde_json::to_string(&r).unwrap(),
            r#"{"frequency":"daily","interval":1000,"future":true}"#
        );
    }

    #[test]
    fn recurrence_rule_rejections_name_the_member() {
        assert_eq!(
            err(r#"{"frequency":"hourly"}"#),
            "Validation Error: recurrenceRules[0].frequency must be one of yearly, monthly, weekly, daily: hourly"
        );
        assert_eq!(
            err(r#"{"frequency":"daily","interval":0}"#),
            "Validation Error: recurrenceRules[0].interval must be 1 to 1000"
        );
        assert!(err(r#"{"frequency":"daily","interval":1001}"#).contains("interval"));
        assert_eq!(
            err(r#"{"frequency":"weekly","firstDayOfWeek":"monday"}"#),
            "Validation Error: recurrenceRules[0].firstDayOfWeek must be one of mo, tu, we, th, fr, sa, su: monday"
        );
        assert_eq!(
            err(r#"{"frequency":"weekly","byDay":[{"day":"Mo"}]}"#),
            "Validation Error: recurrenceRules[0].byDay[0].day must be one of mo, tu, we, th, fr, sa, su: Mo"
        );
        assert_eq!(
            err(r#"{"frequency":"monthly","byDay":[{"day":"mo","nthOfPeriod":0}]}"#),
            "Validation Error: recurrenceRules[0].byDay[0].nthOfPeriod must be -53 to 53 and not 0"
        );
        assert!(
            err(r#"{"frequency":"monthly","byDay":[{"day":"mo","nthOfPeriod":54}]}"#)
                .contains("nthOfPeriod")
        );
        assert_eq!(
            err(r#"{"frequency":"monthly","byMonthDay":[32]}"#),
            "Validation Error: recurrenceRules[0].byMonthDay[0] must be -31 to 31 and not 0"
        );
        for bad in ["0", "13", "01", "+1", "1L", "a", ""] {
            assert_eq!(
                err(&format!(r#"{{"frequency":"yearly","byMonth":["{bad}"]}}"#)),
                format!(
                    "Validation Error: recurrenceRules[0].byMonth[0] must be a month number 1 to 12: {bad}"
                )
            );
        }
        assert_eq!(
            err(r#"{"frequency":"monthly","bySetPosition":[367]}"#),
            "Validation Error: recurrenceRules[0].bySetPosition[0] must be -366 to 366 and not 0"
        );
        assert_eq!(
            err(r#"{"frequency":"daily","count":1001}"#),
            "Validation Error: recurrenceRules[0].count must be 1 to 1000 occurrences"
        );
        assert!(err(r#"{"frequency":"daily","count":0}"#).contains("count"));
        assert_eq!(
            err(r#"{"frequency":"daily","until":"2029-10-14T18:30:01"}"#),
            "Validation Error: recurrenceRules[0].until must be on or after start and at most 3 years after it: 2029-10-14T18:30:01"
        );
        assert!(err(r#"{"frequency":"daily","until":"2026-10-14T18:29:59"}"#).contains("until"));
        assert_eq!(
            err(r#"{"frequency":"daily","until":"tomorrow"}"#),
            "Validation Error: recurrenceRules[0].until must be a local date-time of the form YYYY-MM-DDTHH:MM:SS: tomorrow"
        );
        let many = format!(
            r#"{{"frequency":"monthly","byMonthDay":[{}]}}"#,
            vec!["1"; VALIDATION_LIMITS.event_recurrence_by_max_count + 1].join(",")
        );
        assert_eq!(
            err(&many),
            "Validation Error: recurrenceRules[0].byMonthDay cannot have more than 31 entries"
        );
        assert!(
            err(r#"{"frequency":"daily","byDay":[{"day":"mo","day2":9007199254740992}]}"#)
                .contains("JSON-safe")
        );
        // a known integer member out of its range is that member's refusal, not the JSON-safe one
        assert!(err(
            r#"{"frequency":"daily","byDay":[{"day":"mo","nthOfPeriod":9007199254740992}]}"#
        )
        .contains("nthOfPeriod"));
        assert!(err(r#"{"frequency":"daily","x":9007199254740992}"#).contains("JSON-safe"));
    }

    #[test]
    fn until_horizon_is_calendar_years_from_a_leap_day() {
        let leap = parse_local_date_time("2028-02-29T10:00:00").unwrap();
        let ok = rule(r#"{"frequency":"yearly","until":"2031-02-28T10:00:00"}"#);
        assert!(validate_recurrence_rule("r", &ok, leap).is_ok());
        let late = rule(r#"{"frequency":"yearly","until":"2031-03-01T00:00:00"}"#);
        assert!(validate_recurrence_rule("r", &late, leap).is_err());
    }

    #[test]
    fn frequencies_and_weekdays_round_trip_and_keep_unknown_spellings() {
        for (f, wire) in [
            (PubkySocialRecurrenceFrequency::Yearly, "yearly"),
            (PubkySocialRecurrenceFrequency::Monthly, "monthly"),
            (PubkySocialRecurrenceFrequency::Weekly, "weekly"),
            (PubkySocialRecurrenceFrequency::Daily, "daily"),
        ] {
            assert_eq!(serde_json::to_string(&f).unwrap(), format!("\"{wire}\""));
            assert!(f.is_known());
        }
        let hourly: PubkySocialRecurrenceFrequency = serde_json::from_str("\"hourly\"").unwrap();
        assert_eq!(
            hourly,
            PubkySocialRecurrenceFrequency::Unknown("hourly".into())
        );
        assert_eq!(serde_json::to_string(&hourly).unwrap(), "\"hourly\"");
        for (d, wire) in [
            (PubkySocialWeekday::Mo, "mo"),
            (PubkySocialWeekday::Tu, "tu"),
            (PubkySocialWeekday::We, "we"),
            (PubkySocialWeekday::Th, "th"),
            (PubkySocialWeekday::Fr, "fr"),
            (PubkySocialWeekday::Sa, "sa"),
            (PubkySocialWeekday::Su, "su"),
        ] {
            assert_eq!(serde_json::to_string(&d).unwrap(), format!("\"{wire}\""));
            assert!(d.is_known());
        }
        assert!(!PubkySocialWeekday::Unknown("monday".into()).is_known());
    }
}
