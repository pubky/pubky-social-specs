//! The `availability` kind: one current post per author saying when they, or a resource of
//! theirs, can be booked. Public, coarse, derived by the client from its private calendar and
//! its bookings: `available` blocks in the fields of a calendar event's timing, `busy` blocks
//! untitled.

use crate::{EventsPost, EVENTS_LIMITS};
use pubky_social_specs::jscalendar::{
    validate_duration, validate_local_date_time, validate_recurrence_rule, validate_time_zone,
};
use pubky_social_specs::subspec::{check_extra, json_error, trimmed_or_none};
use pubky_social_specs::{
    code_point_len, frozen_trim, PubkySocialRecurrenceRule, VALIDATION_LIMITS,
};
use serde::{Deserialize, Serialize};

/// One block of time: a start in the schedule's `timeZone`, a duration, and a recurrence as an
/// event has one.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AvailabilityBlock {
    /// On an `available` block only, trimmed by the builder, a blank one absent;
    /// `1..=availability_block_title_max_length`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// A `LocalDateTime`.
    pub start: String,
    /// A `Duration`.
    pub duration: String,
    /// At most `event_recurrence_rules_max_count`: one.
    #[serde(default)]
    pub recurrence_rules: Vec<PubkySocialRecurrenceRule>,
    /// At most `event_excluded_dates_max_count`.
    #[serde(default)]
    pub excluded_dates: Vec<String>,
    /// Unknown members, preserved on rewrite; see the module contract in `models/mod.rs`.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl AvailabilityBlock {
    /// A block of `start` and `duration`, with no recurrence; the other members are public.
    pub fn new(start: String, duration: String, title: Option<String>) -> Self {
        Self {
            title,
            start,
            duration,
            ..Default::default()
        }
    }

    fn trimmed(self) -> Self {
        Self {
            title: self.title.and_then(trimmed_or_none),
            ..self
        }
    }
}

/// Typed JSON envelope stored in an events post's `content` when `kind == Availability`.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AvailabilityContent {
    /// An IANA time zone name every block is read in.
    pub time_zone: String,
    /// How far ahead the schedule is kept, `1..=availability_horizon_max_days`.
    pub horizon_days: i64,
    /// The resource the schedule belongs to, any universal reference; absent for the author.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#for: Option<String>,
    /// When a booking may start; at most `availability_blocks_max_count`.
    #[serde(default)]
    pub available: Vec<AvailabilityBlock>,
    /// What is taken; at most `availability_blocks_max_count`.
    #[serde(default)]
    pub busy: Vec<AvailabilityBlock>,
    /// Unknown members, preserved on rewrite; see the module contract in `models/mod.rs`.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl AvailabilityContent {
    /// A schedule of its zone and horizon alone; the blocks and `for` are public to set.
    pub fn new(time_zone: String, horizon_days: i64) -> Self {
        Self {
            time_zone,
            horizon_days,
            ..Default::default()
        }
    }

    /// The builder trim: each block's title.
    pub fn trimmed(self) -> Self {
        Self {
            available: self
                .available
                .into_iter()
                .map(AvailabilityBlock::trimmed)
                .collect(),
            busy: self
                .busy
                .into_iter()
                .map(AvailabilityBlock::trimmed)
                .collect(),
            ..self
        }
    }
}

/// The envelope when it parses; the kind's validation words the failure.
pub(crate) fn parse_availability(post: &EventsPost) -> Option<AvailabilityContent> {
    serde_json::from_str(&post.content).ok()
}

fn validate_block(field: &str, block: &AvailabilityBlock, titled: bool) -> Result<(), String> {
    check_extra(
        &block.extra,
        &[
            "title",
            "start",
            "duration",
            "recurrenceRules",
            "excludedDates",
        ],
    )?;
    if let Some(title) = &block.title {
        if !titled {
            return Err(format!("Validation Error: {field} carries no title"));
        }
        let max = EVENTS_LIMITS.availability_block_title_max_length;
        if frozen_trim(title).is_empty() || code_point_len(title) > max {
            return Err(format!(
                "Validation Error: {field}.title must be 1 to {max} code points and not blank"
            ));
        }
    }
    let start = validate_local_date_time(&format!("{field}.start"), &block.start)?;
    validate_duration(&format!("{field}.duration"), &block.duration)?;
    let max = VALIDATION_LIMITS.event_recurrence_rules_max_count;
    if block.recurrence_rules.len() > max {
        return Err(format!(
            "Validation Error: {field} cannot have more than {max} recurrence rules"
        ));
    }
    for (index, rule) in block.recurrence_rules.iter().enumerate() {
        validate_recurrence_rule(&format!("{field}.recurrenceRules[{index}]"), rule, start)?;
    }
    let max = VALIDATION_LIMITS.event_excluded_dates_max_count;
    if block.excluded_dates.len() > max {
        return Err(format!(
            "Validation Error: {field} cannot have more than {max} excluded dates"
        ));
    }
    for (index, date) in block.excluded_dates.iter().enumerate() {
        validate_local_date_time(&format!("{field}.excludedDates[{index}]"), date)?;
    }
    Ok(())
}

/// Validates a `kind = Availability` post, including its JSON content envelope. `for` is a
/// reference position and ran through the post-level gate before this.
pub(crate) fn validate_availability_post(post: &EventsPost) -> Result<(), String> {
    if post.parent.is_some() || post.embed.is_some() || !post.attachments.is_empty() {
        return Err(
            "Validation Error: Availability posts cannot have parent, embed or attachments".into(),
        );
    }
    if code_point_len(&post.content) > EVENTS_LIMITS.availability_content_max_length {
        return Err(format!(
            "Validation Error: Availability content must be at most {} code points",
            EVENTS_LIMITS.availability_content_max_length
        ));
    }
    let envelope: AvailabilityContent = serde_json::from_str(&post.content).map_err(|e| {
        format!(
            "Validation Error: Availability content must be a valid JSON envelope: {}",
            json_error(&e)
        )
    })?;
    check_extra(
        &envelope.extra,
        &["timeZone", "horizonDays", "for", "available", "busy"],
    )?;
    validate_time_zone("timeZone", &envelope.time_zone)?;
    let max = EVENTS_LIMITS.availability_horizon_max_days;
    if envelope.horizon_days < 1 || envelope.horizon_days > max as i64 {
        return Err(format!(
            "Validation Error: Availability horizonDays must be 1 to {max} days"
        ));
    }
    let max = EVENTS_LIMITS.availability_blocks_max_count;
    if envelope.available.len() > max {
        return Err(format!(
            "Validation Error: Availability cannot have more than {max} available blocks"
        ));
    }
    if envelope.busy.len() > max {
        return Err(format!(
            "Validation Error: Availability cannot have more than {max} busy blocks"
        ));
    }
    for (index, block) in envelope.available.iter().enumerate() {
        validate_block(&format!("available[{index}]"), block, true)?;
    }
    for (index, block) in envelope.busy.iter().enumerate() {
        validate_block(&format!("busy[{index}]"), block, false)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{new_availability, EventsPostKind};
    use pubky_social_specs::traits::{TimestampId, Validatable, PUB_CTX};
    use pubky_social_specs::{
        PubkySocialNthDay, PubkySocialRecurrenceFrequency, PubkySocialWeekday,
    };

    const PK: &str = "operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo";

    fn weekly() -> AvailabilityContent {
        let mut schedule = AvailabilityContent::new("Europe/Zurich".into(), 60);
        let mut office = AvailabilityBlock::new(
            "2026-10-19T09:00:00".into(),
            "PT8H".into(),
            Some("Office hours".into()),
        );
        let mut rule = PubkySocialRecurrenceRule::new(PubkySocialRecurrenceFrequency::Weekly);
        rule.by_day = ["mo", "tu", "we", "th", "fr"]
            .iter()
            .map(|d| PubkySocialNthDay {
                day: PubkySocialWeekday::from(d.to_string()),
                nth_of_period: None,
                extra: Default::default(),
            })
            .collect();
        office.recurrence_rules = vec![rule];
        schedule.available = vec![office];
        schedule.busy = vec![AvailabilityBlock::new(
            "2026-10-21T14:00:00".into(),
            "PT1H".into(),
            None,
        )];
        schedule.r#for = Some(format!(
            "pubky://{PK}/pub/marketplace/v1/posts/0032SSN7Q4EVG"
        ));
        schedule
    }

    fn raw(content: &str) -> EventsPost {
        EventsPost::new(
            content.to_string(),
            EventsPostKind::Availability,
            None,
            None,
            vec![],
        )
    }

    fn validate(post: &EventsPost) -> Result<(), String> {
        post.validate(Some(&post.create_id()), &PUB_CTX)
    }

    fn err(post: &EventsPost) -> String {
        validate(post).expect_err("expected a validation error")
    }

    fn with(schedule: &AvailabilityContent, edit: impl Fn(&mut serde_json::Value)) -> EventsPost {
        let mut v = serde_json::to_value(schedule).unwrap();
        edit(&mut v);
        raw(&v.to_string())
    }

    #[test]
    fn builder_round_trips_and_trims_titles() {
        let mut schedule = weekly();
        schedule.available[0].title = Some("  Office hours  ".into());
        schedule.busy[0].title = None;
        let post = new_availability(schedule);
        assert_eq!(post.kind, EventsPostKind::Availability);
        assert_eq!(validate(&post), Ok(()));
        let e: AvailabilityContent = serde_json::from_str(&post.content).unwrap();
        assert_eq!(e, weekly());
        assert!(post
            .content
            .starts_with(r#"{"timeZone":"Europe/Zurich","horizonDays":60,"for":"pubky://"#));
        let blob = serde_json::to_vec(&post).unwrap();
        let read =
            <EventsPost as Validatable>::try_from(&blob, &post.create_id(), &PUB_CTX).unwrap();
        assert_eq!(read, post);
        // the least schedule: a zone and a horizon
        assert_eq!(
            validate(&raw(r#"{"timeZone":"UTC","horizonDays":1}"#)),
            Ok(())
        );
    }

    #[test]
    fn a_reader_never_rewrites_and_keeps_unknown_members() {
        let json = r#"{"timeZone":"UTC","horizonDays":30,"available":[{"title":" padded ","start":"2026-10-19T09:00:00","duration":"PT1H","room":"A"}],"slotMinutes":30}"#;
        let post = raw(json);
        assert_eq!(validate(&post), Ok(()));
        let e: AvailabilityContent = serde_json::from_str(json).unwrap();
        assert_eq!(e.available[0].title.as_deref(), Some(" padded "));
        let back: serde_json::Value = serde_json::to_value(&e).unwrap();
        assert_eq!(back["slotMinutes"], 30);
        assert_eq!(back["available"][0]["room"], "A");
    }

    #[test]
    fn envelope_rules() {
        let base = weekly();
        let mut post = new_availability(base.clone());
        post.parent = Some(format!("pubky://{PK}/pub/social/v1/posts/0032SSN7Q4EVG"));
        assert_eq!(
            err(&post),
            "Validation Error: Availability posts cannot have parent, embed or attachments"
        );
        let over = "x".repeat(EVENTS_LIMITS.availability_content_max_length + 1);
        assert!(err(&raw(&over)).contains("Availability content must be at most"));
        assert!(err(&raw("{"))
            .starts_with("Validation Error: Availability content must be a valid JSON envelope: "));
        assert!(err(&raw(r#"{"timeZone":"UTC"}"#)).contains("missing field `horizonDays`"));
        assert_eq!(
            err(&with(&base, |v| v["timeZone"] = "Zurich time".into())),
            "Validation Error: timeZone must be an IANA time zone name of at most 64 code points: Zurich time"
        );
        let max = EVENTS_LIMITS.availability_horizon_max_days;
        assert_eq!(
            validate(&with(&base, |v| v["horizonDays"] = (max as i64).into())),
            Ok(())
        );
        for bad in [0i64, max as i64 + 1] {
            assert_eq!(
                err(&with(&base, |v| v["horizonDays"] = bad.into())),
                format!("Validation Error: Availability horizonDays must be 1 to {max} days")
            );
        }
        // `for` is a reference through the gate
        assert!(err(&with(&base, |v| v["for"] = " https://x.y".into()))
            .contains("for must be a canonical"));
        assert!(err(&with(&base, |v| v["for"] =
            format!("pubky://{PK}/priv/social/v1/posts/0032SSN7Q4EVG").into()))
        .contains("for must not reference a private object"));
        assert_eq!(
            validate(&with(&base, |v| v["for"] = "geo:46,8".into())),
            Ok(())
        );
    }

    #[test]
    fn block_rules() {
        let base = weekly();
        let max = EVENTS_LIMITS.availability_blocks_max_count;
        let block = serde_json::json!({ "start": "2026-10-19T09:00:00", "duration": "PT1H" });
        assert_eq!(
            err(&with(&base, |v| v["available"] =
                serde_json::json!(vec![block.clone(); max + 1]))),
            format!("Validation Error: Availability cannot have more than {max} available blocks")
        );
        assert_eq!(
            err(&with(&base, |v| v["busy"] =
                serde_json::json!(vec![block.clone(); max + 1]))),
            format!("Validation Error: Availability cannot have more than {max} busy blocks")
        );
        assert_eq!(
            err(&with(&base, |v| v["busy"][0]["title"] = "Dentist".into())),
            "Validation Error: busy[0] carries no title"
        );
        let max = EVENTS_LIMITS.availability_block_title_max_length;
        assert_eq!(
            err(&with(&base, |v| v["available"][0]["title"] = " ".into())),
            format!(
                "Validation Error: available[0].title must be 1 to {max} code points and not blank"
            )
        );
        assert_eq!(
            err(&with(&base, |v| v["available"][0]["start"] = "9am".into())),
            "Validation Error: available[0].start must be a local date-time of the form YYYY-MM-DDTHH:MM:SS: 9am"
        );
        assert_eq!(
            err(&with(&base, |v| v["busy"][0]["duration"] = "1h".into())),
            "Validation Error: busy[0].duration must be an ISO 8601 duration of the form PnW or PnDTnHnMnS: 1h"
        );
        assert!(err(&with(&base, |v| {
            v["busy"][0].as_object_mut().unwrap().remove("duration");
        }))
        .contains("missing field `duration`"));
        assert_eq!(
            err(&with(
                &base,
                |v| v["available"][0]["recurrenceRules"] =
                    serde_json::json!([{ "frequency": "weekly" }, { "frequency": "daily" }])
            )),
            "Validation Error: available[0] cannot have more than 1 recurrence rules"
        );
        assert_eq!(
            err(&with(&base, |v| v["available"][0]["recurrenceRules"][0]["until"] = "2026-01-01T00:00:00".into())),
            "Validation Error: available[0].recurrenceRules[0].until must be on or after start and at most 3 years after it: 2026-01-01T00:00:00"
        );
        let max = VALIDATION_LIMITS.event_excluded_dates_max_count;
        assert_eq!(
            err(&with(&base, |v| v["available"][0]["excludedDates"] =
                serde_json::json!(vec!["2026-12-25T09:00:00"; max + 1]))),
            format!("Validation Error: available[0] cannot have more than {max} excluded dates")
        );
        assert_eq!(
            err(&with(&base, |v| v["available"][0]["excludedDates"] = serde_json::json!(["2026-12-25"]))),
            "Validation Error: available[0].excludedDates[0] must be a local date-time of the form YYYY-MM-DDTHH:MM:SS: 2026-12-25"
        );
        assert!(err(&with(&base, |v| v["available"][0]["x"] =
            serde_json::json!(9007199254740992i64)))
        .contains("JSON-safe"));
    }
}
