//! The `event` kind: a calendar event as a post, its content a JSON envelope whose member
//! names are JSCalendar's (RFC 8984) wherever JSCalendar has one, so an ICS import or export is
//! a rename. The envelope carries the rest: the cover is `attachments[0]`, categories are tags,
//! `parent` and `embed` stay unset, and `lock` is set when the details are guarded.

use crate::common::{check_extra, code_point_len, frozen_trim, json_error, trimmed_or_none};
use crate::limits::VALIDATION_LIMITS;
use serde::{Deserialize, Serialize};

#[cfg(feature = "openapi")]
use utoipa::ToSchema;

use super::super::super::PubkySocialPost;
use super::super::places::check_place_reference;
use super::time::{
    validate_duration, validate_local_date_time, validate_recurrence_rule, validate_time_zone,
    PubkySocialRecurrenceRule,
};

/// JSCalendar `status`: whether the event is on.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(from = "String", into = "String")]
#[non_exhaustive]
pub enum PubkySocialEventStatus {
    #[default]
    Confirmed,
    Tentative,
    Cancelled,
    Unknown(String),
}

wire_names!(PubkySocialEventStatus {
    Confirmed => "confirmed",
    Tentative => "tentative",
    Cancelled => "cancelled",
});

/// How a person gets in: `open` to anyone, `approval` by the organiser, `invite` only, or a
/// `ticket` sold through a lock.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(from = "String", into = "String")]
#[non_exhaustive]
pub enum PubkySocialAttendancePolicy {
    #[default]
    Open,
    Approval,
    Invite,
    Ticket,
    Unknown(String),
}

wire_names!(PubkySocialAttendancePolicy {
    Open => "open",
    Approval => "approval",
    Invite => "invite",
    Ticket => "ticket",
});

/// Where the event is: a reference to a place, through the universal gate, and a name to show.
/// A place is a canonical OpenStreetMap object URL or a `geo:` point (the place conventions), a
/// meeting link an https URL.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "openapi", derive(ToSchema))]
pub struct PubkySocialEventLocation {
    /// Trimmed by the builder, a blank one absent; `1..=event_location_name_max_length`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Reference tier, universal, and a place convention when it names a place.
    pub uri: String,
    /// Unknown members, preserved on rewrite; see the module contract in `models/mod.rs`.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl PubkySocialEventLocation {
    /// A location over a canonical `uri` with an optional display `name`, which the builder
    /// trims, a blank one becoming absent; the uri passes through verbatim.
    pub fn new(uri: String, name: Option<String>) -> Self {
        Self {
            name: name.and_then(trimmed_or_none),
            uri,
            extra: Default::default(),
        }
    }
}

/// Who may come and how many.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "openapi", derive(ToSchema))]
pub struct PubkySocialEventAttendance {
    pub policy: PubkySocialAttendancePolicy,
    /// Seats, `1..=event_capacity_max_people`; `null` for no limit.
    pub capacity: Option<i64>,
    /// Whether people past the capacity queue.
    #[serde(default)]
    pub waitlist: bool,
    /// Unknown members, preserved on rewrite; see the module contract in `models/mod.rs`.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl Default for PubkySocialEventAttendance {
    /// Open to anyone, no limit, no waitlist: what an absent `attendance` reads as.
    fn default() -> Self {
        Self {
            policy: PubkySocialAttendancePolicy::Open,
            capacity: None,
            waitlist: false,
            extra: Default::default(),
        }
    }
}

/// A link shown with the event, `{ title, url }` as a profile's links are; https only.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "openapi", derive(ToSchema))]
pub struct PubkySocialEventLink {
    /// Trimmed by the builder; `1..=event_link_title_max_length`, not blank.
    pub title: String,
    /// An https URL of at most `event_link_url_max_length` code points, stored as written.
    pub url: String,
    /// Unknown members, preserved on rewrite; see the module contract in `models/mod.rs`.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl PubkySocialEventLink {
    /// Trims the title; the url is a reference and passes through verbatim.
    pub fn new(title: String, url: String) -> Self {
        Self {
            title: frozen_trim(&title).to_string(),
            url,
            extra: Default::default(),
        }
    }
}

/// Typed JSON envelope stored in `PubkySocialPost::content` when `kind == Event`.
///
/// Member names are JSCalendar's. Times are local: `start` is a wall-clock time in `timeZone`,
/// and the indexer computes the instant. Build one through `PubkySocialPost::new_event`; the
/// struct is public so consumers can inspect the shape. No `deny_unknown_fields`: later minors
/// may add members, and `extra` keeps them.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "openapi", derive(ToSchema))]
#[serde(rename_all = "camelCase")]
pub struct PubkySocialEventContent {
    /// Trimmed by the builder; `[1, event_title_max_length]` code points.
    pub title: String,
    /// Markdown, as an article body; at most `event_description_max_length` code points, not
    /// blank: a blank description is an absent one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// A `LocalDateTime`, `YYYY-MM-DDTHH:MM:SS`, in `timeZone`.
    pub start: String,
    /// An IANA time zone name.
    pub time_zone: String,
    /// A `Duration`, `PnW` or `PnDTnHnMnS`; required unless `showWithoutTime`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration: Option<String>,
    /// An all-day event: the time of `start` is not shown and `duration` may be absent.
    #[serde(default)]
    pub show_without_time: bool,
    /// `confirmed` when absent.
    #[serde(default)]
    pub status: PubkySocialEventStatus,
    /// At most `event_locations_max_count`.
    #[serde(default)]
    pub locations: Vec<PubkySocialEventLocation>,
    /// Open with no limit when absent.
    #[serde(default)]
    pub attendance: PubkySocialEventAttendance,
    /// At most `event_links_max_count`.
    #[serde(default)]
    pub links: Vec<PubkySocialEventLink>,
    /// At most `event_recurrence_rules_max_count`: one.
    #[serde(default)]
    pub recurrence_rules: Vec<PubkySocialRecurrenceRule>,
    /// Occurrences removed from the series, each a `LocalDateTime` in `timeZone`; at most
    /// `event_excluded_dates_max_count`.
    #[serde(default)]
    pub excluded_dates: Vec<String>,
    /// On an override of one occurrence: the master event, a versionless post reference of the
    /// same author. Set together with `recurrenceId`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recurrence_of: Option<String>,
    /// On an override of one occurrence: the occurrence's local start in the master's series.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recurrence_id: Option<String>,
    /// Unknown members, preserved on rewrite; see the module contract in `models/mod.rs`.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl PubkySocialEventContent {
    /// An event of its timing alone, the other members at their defaults and public to set.
    /// Nothing is trimmed here; `PubkySocialPost::new_event` is the builder.
    pub fn new(
        title: String,
        start: String,
        time_zone: String,
        duration: Option<String>,
        show_without_time: bool,
    ) -> Self {
        Self {
            title,
            start,
            time_zone,
            duration,
            show_without_time,
            ..Default::default()
        }
    }

    /// The builder trim: the title, the description (a blank one absent), each location's name
    /// and each link's title. References and times pass through verbatim; `extra` is kept.
    pub(crate) fn trimmed(self) -> Self {
        Self {
            title: frozen_trim(&self.title).to_string(),
            description: self.description.and_then(trimmed_or_none),
            locations: self
                .locations
                .into_iter()
                .map(|l| PubkySocialEventLocation {
                    name: l.name.and_then(trimmed_or_none),
                    ..l
                })
                .collect(),
            links: self
                .links
                .into_iter()
                .map(|l| PubkySocialEventLink {
                    title: frozen_trim(&l.title).to_string(),
                    ..l
                })
                .collect(),
            ..self
        }
    }
}

/// The envelope when it parses; the kind's validation words the failure.
pub(crate) fn parse_event(post: &PubkySocialPost) -> Option<PubkySocialEventContent> {
    serde_json::from_str(&post.content).ok()
}

/// The list caps of the envelope, run before any reference inside it is read.
pub(crate) fn check_event_counts(post: &PubkySocialPost) -> Result<(), String> {
    let Some(envelope) = parse_event(post) else {
        return Ok(());
    };
    let max = VALIDATION_LIMITS.event_locations_max_count;
    if envelope.locations.len() > max {
        return Err(format!(
            "Validation Error: Event cannot have more than {max} locations"
        ));
    }
    let max = VALIDATION_LIMITS.event_links_max_count;
    if envelope.links.len() > max {
        return Err(format!(
            "Validation Error: Event cannot have more than {max} links"
        ));
    }
    Ok(())
}

/// Validates a `kind = Event` post, including its JSON content envelope. Every reference inside
/// it (`locations[].uri`, `links[].url`, `recurrenceOf`) ran through the post-level gate before
/// this; the place conventions and the https rule run here, after it.
pub(crate) fn validate_event_post(post: &PubkySocialPost) -> Result<(), String> {
    if post.parent.is_some() || post.embed.is_some() {
        return Err("Validation Error: Event posts cannot have parent or embed".into());
    }
    if code_point_len(&post.content) > VALIDATION_LIMITS.event_content_max_length {
        return Err(format!(
            "Validation Error: Event content must be at most {} code points",
            VALIDATION_LIMITS.event_content_max_length
        ));
    }
    let envelope: PubkySocialEventContent = serde_json::from_str(&post.content).map_err(|e| {
        format!(
            "Validation Error: Event content must be a valid JSON envelope: {}",
            json_error(&e)
        )
    })?;
    validate_event_envelope(&envelope)
}

pub(crate) fn validate_event_envelope(envelope: &PubkySocialEventContent) -> Result<(), String> {
    check_extra(
        &envelope.extra,
        &[
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
        ],
    )?;
    // Other controls escape to six characters and would break the envelope bound
    let is_control = |c: char| c.is_ascii_control() && !matches!(c, '\t' | '\n' | '\r');
    let description = envelope.description.as_deref().unwrap_or("");
    if envelope.title.chars().any(is_control) || description.chars().any(is_control) {
        return Err(
            "Validation Error: Event text must not contain control characters other than tab, newline and carriage return".into(),
        );
    }
    if frozen_trim(&envelope.title).is_empty() {
        return Err("Validation Error: Event title must contain non-whitespace characters".into());
    }
    if code_point_len(&envelope.title) > VALIDATION_LIMITS.event_title_max_length {
        return Err(format!(
            "Validation Error: Event title must be at most {} code points",
            VALIDATION_LIMITS.event_title_max_length
        ));
    }
    if let Some(description) = &envelope.description {
        if frozen_trim(description).is_empty() {
            return Err("Validation Error: Event description must not be blank".into());
        }
        if code_point_len(description) > VALIDATION_LIMITS.event_description_max_length {
            return Err(format!(
                "Validation Error: Event description must be at most {} code points",
                VALIDATION_LIMITS.event_description_max_length
            ));
        }
    }
    let start = validate_local_date_time("start", &envelope.start)?;
    validate_time_zone("timeZone", &envelope.time_zone)?;
    match &envelope.duration {
        Some(duration) => {
            validate_duration("duration", duration)?;
        }
        None if !envelope.show_without_time => {
            return Err(
                "Validation Error: Event duration is required unless showWithoutTime is true"
                    .into(),
            );
        }
        None => {}
    }
    if !envelope.status.is_known() {
        return Err(format!(
            "Validation Error: Event status must be one of confirmed, tentative, cancelled: {}",
            envelope.status.wire_name()
        ));
    }
    // The list counts were checked with the post's list caps, before any reference was read
    for (index, location) in envelope.locations.iter().enumerate() {
        check_extra(&location.extra, &["name", "uri"])?;
        if let Some(name) = &location.name {
            let max = VALIDATION_LIMITS.event_location_name_max_length;
            if frozen_trim(name).is_empty() || code_point_len(name) > max {
                return Err(format!(
                    "Validation Error: locations[{index}].name must be 1 to {max} code points and not blank"
                ));
            }
        }
        check_place_reference(&format!("locations[{index}].uri"), &location.uri)?;
    }
    check_extra(
        &envelope.attendance.extra,
        &["policy", "capacity", "waitlist"],
    )?;
    if !envelope.attendance.policy.is_known() {
        return Err(format!(
            "Validation Error: attendance.policy must be one of open, approval, invite, ticket: {}",
            envelope.attendance.policy.wire_name()
        ));
    }
    if let Some(capacity) = envelope.attendance.capacity {
        let max = VALIDATION_LIMITS.event_capacity_max_people;
        if capacity < 1 || capacity > max as i64 {
            return Err(format!(
                "Validation Error: attendance.capacity must be 1 to {max} people"
            ));
        }
    }
    for (index, link) in envelope.links.iter().enumerate() {
        check_extra(&link.extra, &["title", "url"])?;
        let max = VALIDATION_LIMITS.event_link_title_max_length;
        if frozen_trim(&link.title).is_empty() || code_point_len(&link.title) > max {
            return Err(format!(
                "Validation Error: links[{index}].title must be 1 to {max} code points and not blank"
            ));
        }
        // The gate admitted a web URL; the event's links are https only
        if !link.url.starts_with("https://") {
            return Err(format!(
                "Validation Error: links[{index}].url must be an https URL: {}",
                link.url
            ));
        }
    }
    let max = VALIDATION_LIMITS.event_recurrence_rules_max_count;
    if envelope.recurrence_rules.len() > max {
        return Err(format!(
            "Validation Error: Event cannot have more than {max} recurrence rules"
        ));
    }
    for (index, rule) in envelope.recurrence_rules.iter().enumerate() {
        validate_recurrence_rule(&format!("recurrenceRules[{index}]"), rule, start)?;
    }
    let max = VALIDATION_LIMITS.event_excluded_dates_max_count;
    if envelope.excluded_dates.len() > max {
        return Err(format!(
            "Validation Error: Event cannot have more than {max} excluded dates"
        ));
    }
    for (index, date) in envelope.excluded_dates.iter().enumerate() {
        validate_local_date_time(&format!("excludedDates[{index}]"), date)?;
    }
    match (&envelope.recurrence_of, &envelope.recurrence_id) {
        (None, None) => {}
        (Some(master), Some(occurrence)) => {
            validate_local_date_time("recurrenceId", occurrence)?;
            // The gate admitted a canonical, versionless pubky URI; it has to name a post
            let names_a_post = crate::ParsedUri::try_from(master.as_str())
                .is_ok_and(|p| matches!(p.resource, crate::Resource::Post { .. }));
            if !names_a_post {
                return Err(format!(
                    "Validation Error: recurrenceOf must reference a post: {master}"
                ));
            }
            if !envelope.recurrence_rules.is_empty() || !envelope.excluded_dates.is_empty() {
                return Err(
                    "Validation Error: an override of one occurrence carries no recurrence rules or excluded dates".into(),
                );
            }
        }
        _ => {
            return Err(
                "Validation Error: recurrenceOf and recurrenceId are set together, on an override of one occurrence".into(),
            );
        }
    }
    Ok(())
}

/// The rule that needs the author: an override's master is the same author's post.
pub(crate) fn check_event_owner(
    post: &PubkySocialPost,
    owner: &crate::PubkyId,
) -> Result<(), String> {
    let Some(master) = parse_event(post).and_then(|e| e.recurrence_of) else {
        return Ok(());
    };
    let same_author = crate::ParsedUri::try_from(master.as_str())
        .is_ok_and(|p| p.user_id.as_ref() == owner.as_ref());
    if !same_author {
        return Err(format!(
            "Validation Error: recurrenceOf must reference a post of the same author: {master}"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::traits::{Root, TimestampId, Validatable, ValidationCtx, PUB_CTX};
    use crate::{PubkySocialAttachment, PubkySocialPostKind, PubkySocialRecurrenceFrequency};

    const PK: &str = "operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo";
    const OTHER: &str = "8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo";

    fn p(path: &str) -> String {
        format!("pubky://{PK}{path}")
    }

    fn file_uri() -> String {
        p("/pub/social/v1/files/PZBQ010FF079VVZPQG1RNFN6DR.png")
    }

    /// The design page's example, as a builder would be given it.
    fn lugano() -> PubkySocialEventContent {
        let mut event = PubkySocialEventContent::new(
            "Lugano Bitcoin Evening".into(),
            "2026-10-14T18:30:00".into(),
            "Europe/Zurich".into(),
            Some("PT2H30M".into()),
            false,
        );
        event.description = Some("Monthly meetup. Talks start at 19:00.".into());
        event.locations = vec![PubkySocialEventLocation::new(
            "https://www.openstreetmap.org/way/481516234".into(),
            Some("Plan ₿ Hub".into()),
        )];
        event.links = vec![PubkySocialEventLink::new(
            "Website".into(),
            "https://planb.network/".into(),
        )];
        let mut rule = PubkySocialRecurrenceRule::new(PubkySocialRecurrenceFrequency::Monthly);
        rule.by_day = vec![super::super::time::PubkySocialNthDay {
            day: crate::PubkySocialWeekday::Tu,
            nth_of_period: Some(2),
            extra: Default::default(),
        }];
        event.recurrence_rules = vec![rule];
        event
    }

    fn event_post(event: PubkySocialEventContent) -> PubkySocialPost {
        PubkySocialPost::new_event(event, vec![], None)
    }

    fn raw(content: &str) -> PubkySocialPost {
        PubkySocialPost::new(
            content.to_string(),
            PubkySocialPostKind::Event,
            None,
            None,
            vec![],
        )
    }

    fn validate(post: &PubkySocialPost) -> Result<(), String> {
        post.validate(Some(&post.create_id()), &PUB_CTX)
    }

    fn err(post: &PubkySocialPost) -> String {
        validate(post).expect_err("expected a validation error")
    }

    /// The envelope with one member replaced, as a hostile or newer writer would store it.
    fn with(
        event: &PubkySocialEventContent,
        edit: impl Fn(&mut serde_json::Value),
    ) -> PubkySocialPost {
        let mut v = serde_json::to_value(event).unwrap();
        edit(&mut v);
        raw(&v.to_string())
    }

    #[test]
    fn the_design_example_builds_validates_and_round_trips() {
        let post = event_post(lugano());
        assert_eq!(post.kind, PubkySocialPostKind::Event);
        assert_eq!(validate(&post), Ok(()));
        let id = post.create_id();
        let blob = serde_json::to_vec(&post).unwrap();
        let read = <PubkySocialPost as Validatable>::try_from(&blob, &id, &PUB_CTX).unwrap();
        assert_eq!(read, post);
        let envelope: PubkySocialEventContent = serde_json::from_str(&read.content).unwrap();
        assert_eq!(envelope, lugano());
        assert_eq!(
            post.content,
            r#"{"title":"Lugano Bitcoin Evening","description":"Monthly meetup. Talks start at 19:00.","start":"2026-10-14T18:30:00","timeZone":"Europe/Zurich","duration":"PT2H30M","showWithoutTime":false,"status":"confirmed","locations":[{"name":"Plan ₿ Hub","uri":"https://www.openstreetmap.org/way/481516234"}],"attendance":{"policy":"open","capacity":null,"waitlist":false},"links":[{"title":"Website","url":"https://planb.network/"}],"recurrenceRules":[{"frequency":"monthly","byDay":[{"day":"tu","nthOfPeriod":2}]}],"excludedDates":[]}"#
        );
    }

    #[test]
    fn the_builder_trims_display_text_and_leaves_times_and_references_alone() {
        let mut event = lugano();
        event.title = "\u{3000} Evening \u{3000}".into();
        event.description = Some(" \t ".into());
        event.locations[0].name = Some("  Hub  ".into());
        event.links[0].title = "  Site  ".into();
        event.start = " 2026-10-14T18:30:00".into();
        event.locations[0].uri = " https://www.openstreetmap.org/way/481516234".into();
        let post = event_post(event);
        let e: PubkySocialEventContent = serde_json::from_str(&post.content).unwrap();
        assert_eq!(e.title, "Evening");
        assert_eq!(e.description, None);
        assert_eq!(e.locations[0].name.as_deref(), Some("Hub"));
        assert_eq!(e.links[0].title, "Site");
        assert_eq!(e.start, " 2026-10-14T18:30:00");
        assert_eq!(
            e.locations[0].uri,
            " https://www.openstreetmap.org/way/481516234"
        );
        // and what it left alone is refused, the reference first since the gate runs first
        assert!(err(&post).contains("locations[0].uri"));
    }

    #[test]
    fn a_reader_never_rewrites_and_counts_padding() {
        let padded = r#"{"title":" Evening ","start":"2026-10-14T18:30:00","timeZone":"UTC","duration":"PT1H"}"#;
        let post = raw(padded);
        assert_eq!(validate(&post), Ok(()));
        let e: PubkySocialEventContent = serde_json::from_str(&post.content).unwrap();
        assert_eq!(e.title, " Evening ");
        assert_eq!(e.status, PubkySocialEventStatus::Confirmed);
        assert_eq!(e.attendance, PubkySocialEventAttendance::default());
        assert!(!e.show_without_time);
        let max = VALIDATION_LIMITS.event_title_max_length;
        let long = format!(
            r#"{{"title":" {}","start":"2026-10-14T18:30:00","timeZone":"UTC","duration":"PT1H"}}"#,
            "t".repeat(max)
        );
        assert_eq!(
            err(&raw(&long)),
            format!("Validation Error: Event title must be at most {max} code points")
        );
        // absent lists and members are written back in the kind's spelling, members kept
        let back = serde_json::to_string(&e).unwrap();
        assert!(back.contains(r#""attendance":{"policy":"open","capacity":null,"waitlist":false}"#));
        assert!(back.contains(r#""locations":[]"#) && back.contains(r#""excludedDates":[]"#));
    }

    #[test]
    fn unknown_members_survive_everywhere_and_never_shadow() {
        let json = r#"{"title":"t","start":"2026-10-14T18:30:00","timeZone":"UTC","duration":"PT1H","locations":[{"uri":"geo:46,8","floor":2}],"attendance":{"policy":"open","capacity":null,"waitlist":false,"minAge":18},"links":[{"title":"n","url":"https://x.y","rel":"me"}],"recurrenceRules":[{"frequency":"weekly","rscale":"gregorian"}],"color":"red"}"#;
        let post = raw(json);
        assert_eq!(validate(&post), Ok(()));
        let e: PubkySocialEventContent = serde_json::from_str(json).unwrap();
        let back: serde_json::Value = serde_json::to_value(&e).unwrap();
        assert_eq!(back["color"], "red");
        assert_eq!(back["locations"][0]["floor"], 2);
        assert_eq!(back["attendance"]["minAge"], 18);
        assert_eq!(back["links"][0]["rel"], "me");
        assert_eq!(back["recurrenceRules"][0]["rscale"], "gregorian");
        let mut shadow = e.clone();
        shadow.extra.insert("start".into(), "x".into());
        assert!(validate_event_envelope(&shadow)
            .unwrap_err()
            .contains("shadow"));
        let mut unsafe_int = e;
        unsafe_int.locations[0]
            .extra
            .insert("n".into(), serde_json::json!(9007199254740992i64));
        assert!(validate_event_envelope(&unsafe_int)
            .unwrap_err()
            .contains("JSON-safe"));
    }

    #[test]
    fn envelope_rules_parent_embed_cap_and_shape() {
        let mut post = event_post(lugano());
        post.parent = Some(p("/pub/social/v1/posts/0032SSN7Q4EVG"));
        assert_eq!(
            err(&post),
            "Validation Error: Event posts cannot have parent or embed"
        );
        post.parent = None;
        post.embed = Some("https://example.com".into());
        assert!(err(&post).contains("parent or embed"));
        let over = "x".repeat(VALIDATION_LIMITS.event_content_max_length + 1);
        let e = err(&raw(&over));
        assert!(
            e.contains("Event content must be at most") && !e.contains("JSON"),
            "{e}"
        );
        assert!(err(&raw("not json"))
            .starts_with("Validation Error: Event content must be a valid JSON envelope: "));
        assert!(err(&raw(r#"{"title":"t"}"#)).contains("missing field"));
        // a cover and more media ride the envelope's attachments
        let post = PubkySocialPost::new_event(
            lugano(),
            vec![PubkySocialAttachment::new(
                file_uri(),
                Some("poster".into()),
                None,
            )],
            Some(p("/pub/app.locks/0032SSN7Q4EVG.json")),
        );
        assert_eq!(validate(&post), Ok(()));
    }

    #[test]
    fn text_rules() {
        let base = lugano();
        assert_eq!(
            err(&with(&base, |v| v["title"] = "  ".into())),
            "Validation Error: Event title must contain non-whitespace characters"
        );
        assert_eq!(
            err(&with(&base, |v| v["title"] = "a\u{0}b".into())),
            "Validation Error: Event text must not contain control characters other than tab, newline and carriage return"
        );
        assert!(err(&with(&base, |v| v["description"] = "a\u{1b}".into())).contains("control"));
        assert_eq!(
            validate(&with(&base, |v| v["description"] = "a\tb\r\nc".into())),
            Ok(())
        );
        assert_eq!(
            err(&with(&base, |v| v["description"] = "".into())),
            "Validation Error: Event description must not be blank"
        );
        let max = VALIDATION_LIMITS.event_description_max_length;
        assert_eq!(
            validate(&with(&base, |v| v["description"] = "d".repeat(max).into())),
            Ok(())
        );
        assert_eq!(
            err(&with(&base, |v| v["description"] = "d".repeat(max + 1).into())),
            format!("Validation Error: Event description must be at most {max} code points")
        );
        assert_eq!(
            validate(&with(&base, |v| v["title"] = "\u{1F600}"
                .repeat(VALIDATION_LIMITS.event_title_max_length)
                .into())),
            Ok(())
        );
    }

    #[test]
    fn timing_rules() {
        let base = lugano();
        assert_eq!(
            err(&with(&base, |v| v["start"] = "2026-10-14T18:30:00Z".into())),
            "Validation Error: start must be a local date-time of the form YYYY-MM-DDTHH:MM:SS: 2026-10-14T18:30:00Z"
        );
        assert_eq!(
            err(&with(&base, |v| v["timeZone"] = "+02:00".into())),
            "Validation Error: timeZone must be an IANA time zone name of at most 64 code points: +02:00"
        );
        assert_eq!(
            err(&with(&base, |v| v["duration"] = "2h".into())),
            "Validation Error: duration must be an ISO 8601 duration of the form PnW or PnDTnHnMnS: 2h"
        );
        assert_eq!(
            err(&with(&base, |v| v["duration"] = "P367D".into())),
            format!(
                "Validation Error: duration must be at most {} seconds: P367D",
                VALIDATION_LIMITS.event_duration_max_seconds
            )
        );
        // the duration is required unless all-day
        assert_eq!(
            err(&with(&base, |v| {
                v.as_object_mut().unwrap().remove("duration");
            })),
            "Validation Error: Event duration is required unless showWithoutTime is true"
        );
        assert_eq!(
            validate(&with(&base, |v| {
                v.as_object_mut().unwrap().remove("duration");
                v["showWithoutTime"] = true.into();
            })),
            Ok(())
        );
        assert_eq!(
            validate(&with(&base, |v| {
                v["duration"] = "P2D".into();
                v["showWithoutTime"] = true.into();
            })),
            Ok(())
        );
        assert!(err(&with(&base, |v| v["showWithoutTime"] = "yes".into()))
            .contains("expected a boolean"));
        assert!(
            err(&with(&base, |v| v["duration"] = serde_json::Value::Null))
                .contains("duration is required")
        );
    }

    #[test]
    fn status_and_attendance_rules() {
        let base = lugano();
        for status in ["confirmed", "tentative", "cancelled"] {
            assert_eq!(
                validate(&with(&base, |v| v["status"] = status.into())),
                Ok(()),
                "{status}"
            );
        }
        assert_eq!(
            err(&with(&base, |v| v["status"] = "maybe".into())),
            "Validation Error: Event status must be one of confirmed, tentative, cancelled: maybe"
        );
        for policy in ["open", "approval", "invite", "ticket"] {
            assert_eq!(
                validate(&with(&base, |v| v["attendance"]["policy"] = policy.into())),
                Ok(()),
                "{policy}"
            );
        }
        assert_eq!(
            err(&with(&base, |v| v["attendance"]["policy"] = "rsvp".into())),
            "Validation Error: attendance.policy must be one of open, approval, invite, ticket: rsvp"
        );
        let max = VALIDATION_LIMITS.event_capacity_max_people;
        assert_eq!(
            validate(&with(&base, |v| v["attendance"]["capacity"] = (max as i64).into())),
            Ok(())
        );
        for bad in [0i64, -1, max as i64 + 1] {
            assert_eq!(
                err(&with(&base, |v| v["attendance"]["capacity"] = bad.into())),
                format!("Validation Error: attendance.capacity must be 1 to {max} people"),
                "{bad}"
            );
        }
        assert!(
            err(&with(&base, |v| v["attendance"]["capacity"] = 1.5.into()))
                .contains("expected i64")
        );
        assert!(
            err(&with(&base, |v| v["attendance"]["waitlist"] = 1.into()))
                .contains("expected a boolean")
        );
        // an absent attendance is open with no limit, and reads back as the builder writes it
        let open: PubkySocialEventContent = serde_json::from_str(
            r#"{"title":"t","start":"2026-10-14T18:30:00","timeZone":"UTC","duration":"PT1H"}"#,
        )
        .unwrap();
        assert_eq!(open.attendance.policy, PubkySocialAttendancePolicy::Open);
        assert_eq!(open.attendance.capacity, None);
        assert!(!open.attendance.waitlist);
    }

    #[test]
    fn locations_take_the_universal_gate_then_the_place_conventions() {
        let base = lugano();
        let location = |uri: &str| {
            let uri = uri.to_string();
            with(&base, move |v| {
                v["locations"] = serde_json::json!([{ "uri": uri }])
            })
        };
        for ok in [
            "https://www.openstreetmap.org/node/1",
            "https://www.openstreetmap.org/relation/62273",
            "geo:46.00547,8.95186",
            "geo:46,8",
            "https://meet.jit.si/lugano",
            "nostr:nevent1abc",
            p("/pub/social/v1/posts/0032SSN7Q4EVG").as_str(),
        ] {
            assert_eq!(validate(&location(ok)), Ok(()), "{ok}");
        }
        assert_eq!(
            err(&location("geo:46.0,8")),
            "Validation Error: locations[0].uri must be a geo URI, geo:<lat>,<lon> in decimal degrees with at most 5 fraction digits and no trailing zeros: geo:46.0,8"
        );
        assert_eq!(
            err(&location("https://www.openstreetmap.org/way/481516234/")),
            "Validation Error: locations[0].uri must be a canonical OpenStreetMap object URL, https://www.openstreetmap.org/{node|way|relation}/{id}: https://www.openstreetmap.org/way/481516234/"
        );
        assert!(err(&location("https://osm.org/way/481516234")).contains("canonical OpenStreetMap"));
        assert!(
            err(&location("https://www.openstreetmap.org/?mlat=46&mlon=8"))
                .contains("canonical OpenStreetMap")
        );
        // the gate first: spelling, scheme shape, the root rule, the versionless rule
        assert!(err(&location(" geo:46,8"))
            .contains("locations[0].uri must be spelled in canonical form"));
        assert!(err(&location("geo:46,8 "))
            .contains("locations[0].uri must be spelled in canonical form"));
        assert!(err(&location("GEO:46,8"))
            .contains("locations[0].uri must be spelled in canonical form"));
        assert!(err(&location("just a place")).contains("locations[0].uri"));
        assert!(err(&location(&p("/priv/social/v1/posts/0032SSN7Q4EVG")))
            .contains("must not reference a private object"));
        assert!(err(&location(&p(
            "/pub/social/v1/posts/0032SSN7Q4EVG/0032SSN7Q4EVG.json"
        )))
        .contains("versionless"));
        // the name
        let max = VALIDATION_LIMITS.event_location_name_max_length;
        for bad in [" ".to_string(), "".to_string(), "n".repeat(max + 1)] {
            let post = with(&base, |v| {
                v["locations"] = serde_json::json!([{ "uri": "geo:46,8", "name": bad }])
            });
            assert_eq!(
                err(&post),
                format!("Validation Error: locations[0].name must be 1 to {max} code points and not blank"),
                "{bad:?}"
            );
        }
        // the count, before any uri is read
        let max = VALIDATION_LIMITS.event_locations_max_count;
        let many = |n: usize| {
            with(&base, move |v| {
                v["locations"] =
                    serde_json::json!(vec![serde_json::json!({ "uri": "not a uri" }); n])
            })
        };
        assert_eq!(
            err(&many(max + 1)),
            format!("Validation Error: Event cannot have more than {max} locations")
        );
        assert!(err(&many(max)).contains("locations[0].uri"));
    }

    #[test]
    fn links_are_https_only() {
        let base = lugano();
        let link = |url: &str| {
            let url = url.to_string();
            with(&base, move |v| {
                v["links"] = serde_json::json!([{ "title": "Site", "url": url }])
            })
        };
        assert_eq!(validate(&link("https://example.com/a?b=c")), Ok(()));
        assert_eq!(
            err(&link("http://example.com")),
            "Validation Error: links[0].url must be an https URL: http://example.com"
        );
        // not even a pubky reference: a link is a web page
        assert!(err(&link(&p("/pub/social/v1/posts/0032SSN7Q4EVG")))
            .contains("links[0].url must be a canonical web URI"));
        assert!(err(&link("nostr:x")).contains("links[0].url"));
        let max = VALIDATION_LIMITS.event_link_url_max_length;
        let long = format!("https://e.com/{}", "a".repeat(max - 14));
        assert_eq!(validate(&link(&long)), Ok(()));
        assert!(err(&link(&format!("{long}a"))).contains(&format!("at most {max} code points")));
        let max = VALIDATION_LIMITS.event_link_title_max_length;
        for bad in [" ".to_string(), "n".repeat(max + 1)] {
            let post = with(&base, |v| {
                v["links"] = serde_json::json!([{ "title": bad, "url": "https://x.y" }])
            });
            assert_eq!(
                err(&post),
                format!(
                    "Validation Error: links[0].title must be 1 to {max} code points and not blank"
                )
            );
        }
        let max = VALIDATION_LIMITS.event_links_max_count;
        let many = with(&base, |v| {
            v["links"] = serde_json::json!(vec![
                serde_json::json!({ "title": "n", "url": "https://x.y" });
                max + 1
            ])
        });
        assert_eq!(
            err(&many),
            format!("Validation Error: Event cannot have more than {max} links")
        );
        // the 1.1 alpha spelling of a link's title is refused, not read as a title
        let named = with(&base, |v| {
            v["links"] = serde_json::json!([{ "name": "Site", "url": "https://x.y" }])
        });
        assert!(
            err(&named).contains("missing field `title`"),
            "{}",
            err(&named)
        );
    }

    #[test]
    fn recurrence_rules_excluded_dates_and_overrides() {
        let base = lugano();
        let max = VALIDATION_LIMITS.event_recurrence_rules_max_count;
        let two = with(
            &base,
            |v| {
                v["recurrenceRules"] =
                    serde_json::json!([{ "frequency": "weekly" }, { "frequency": "daily" }])
            },
        );
        assert_eq!(
            err(&two),
            format!("Validation Error: Event cannot have more than {max} recurrence rules")
        );
        assert_eq!(
            err(&with(&base, |v| v["recurrenceRules"][0]["frequency"] = "hourly".into())),
            "Validation Error: recurrenceRules[0].frequency must be one of yearly, monthly, weekly, daily: hourly"
        );
        assert_eq!(
            err(&with(&base, |v| v["recurrenceRules"][0]["until"] = "2029-10-14T18:30:01".into())),
            "Validation Error: recurrenceRules[0].until must be on or after start and at most 3 years after it: 2029-10-14T18:30:01"
        );
        assert_eq!(
            validate(&with(&base, |v| v["excludedDates"] =
                serde_json::json!(["2026-11-10T18:30:00"]))),
            Ok(())
        );
        assert_eq!(
            err(&with(&base, |v| v["excludedDates"] = serde_json::json!(["2026-11-10"]))),
            "Validation Error: excludedDates[0] must be a local date-time of the form YYYY-MM-DDTHH:MM:SS: 2026-11-10"
        );
        let max = VALIDATION_LIMITS.event_excluded_dates_max_count;
        let many = with(&base, |v| {
            v["excludedDates"] = serde_json::json!(vec!["2026-11-10T18:30:00"; max + 1])
        });
        assert_eq!(
            err(&many),
            format!("Validation Error: Event cannot have more than {max} excluded dates")
        );
        // an override: the master and the occurrence, together, and no series of its own
        let master = p("/pub/social/v1/posts/0032SSN7Q4EVG");
        let override_of = |edit: &dyn Fn(&mut serde_json::Value)| {
            with(&base, |v| {
                v["recurrenceRules"] = serde_json::json!([]);
                v["recurrenceOf"] = master.clone().into();
                v["recurrenceId"] = "2026-11-10T18:30:00".into();
                edit(v);
            })
        };
        assert_eq!(validate(&override_of(&|_| {})), Ok(()));
        assert_eq!(
            err(&override_of(&|v| { v.as_object_mut().unwrap().remove("recurrenceId"); })),
            "Validation Error: recurrenceOf and recurrenceId are set together, on an override of one occurrence"
        );
        assert!(err(&override_of(&|v| {
            v.as_object_mut().unwrap().remove("recurrenceOf");
        }))
        .contains("set together"));
        assert_eq!(
            err(&override_of(&|v| v["recurrenceRules"] = serde_json::json!([{ "frequency": "daily" }]))),
            "Validation Error: an override of one occurrence carries no recurrence rules or excluded dates"
        );
        assert!(err(&override_of(
            &|v| v["excludedDates"] = serde_json::json!(["2026-11-10T18:30:00"])
        ))
        .contains("carries no"));
        assert!(err(&override_of(&|v| v["recurrenceId"] = "soon".into()))
            .contains("recurrenceId must be a local date-time"));
        // the master is a pubky post reference and nothing else
        assert!(err(&override_of(
            &|v| v["recurrenceOf"] = "https://example.com/event".into()
        ))
        .contains("recurrenceOf must be a canonical pubky URI"));
        assert!(err(&override_of(&|v| v["recurrenceOf"] =
            p("/pub/social/v1/posts/0032SSN7Q4EVG/0032SSN7Q4EVG.json").into()))
        .contains("versionless"));
        assert_eq!(
            err(&override_of(
                &|v| v["recurrenceOf"] = p("/pub/social/v1/profile.json").into()
            )),
            format!(
                "Validation Error: recurrenceOf must reference a post: {}",
                p("/pub/social/v1/profile.json")
            )
        );
        assert!(err(&override_of(
            &|v| v["recurrenceOf"] = p("/priv/social/v1/posts/0032SSN7Q4EVG").into()
        ))
        .contains("private object"));
    }

    #[test]
    fn an_override_master_is_the_same_authors_post_where_the_author_is_known() {
        let owner = crate::PubkyId::try_from(PK).unwrap();
        let mine = p("/pub/social/v1/posts/0032SSN7Q4EVG");
        let theirs = format!("pubky://{OTHER}/pub/social/v1/posts/0032SSN7Q4EVG");
        let override_of = |master: &str| {
            let mut event = lugano();
            event.recurrence_rules.clear();
            event.recurrence_of = Some(master.to_string());
            event.recurrence_id = Some("2026-11-10T18:30:00".into());
            event_post(event)
        };
        let ok = override_of(&mine);
        assert!(ok.create_version(Root::Pub, &owner, None).is_ok());
        let foreign = override_of(&theirs);
        // plain validation has no author, so it passes
        assert_eq!(validate(&foreign), Ok(()));
        let e = foreign.create_version(Root::Pub, &owner, None).unwrap_err();
        assert_eq!(
            e,
            format!(
                "Validation Error: recurrenceOf must reference a post of the same author: {theirs}"
            )
        );
        // and ingest by URI names the author
        let id = foreign.create_id();
        let blob = serde_json::to_vec(&foreign).unwrap();
        let uri = p(&format!("/pub/social/v1/posts/{id}/{id}.json"));
        let e = crate::PubkySocialObject::from_uri(&uri, &blob).unwrap_err();
        assert!(e.contains("same author"), "{e}");
        let blob = serde_json::to_vec(&ok).unwrap();
        assert!(crate::PubkySocialObject::from_uri(&uri, &blob).is_ok());
        // a private draft of an override still obeys the root rule on the master
        let private = override_of(&p("/priv/social/v1/posts/0032SSN7Q4EVG"));
        assert!(private
            .validate(Some(&id), &ValidationCtx { root: Root::Priv })
            .is_ok());
        assert!(private.validate(Some(&id), &PUB_CTX).is_err());
    }

    #[test]
    fn an_all_day_event_with_the_least_members() {
        let post = raw(
            r#"{"title":"Founders day","start":"2026-01-03T00:00:00","timeZone":"UTC","showWithoutTime":true}"#,
        );
        assert_eq!(validate(&post), Ok(()));
    }

    #[test]
    fn wire_enums_round_trip_and_keep_unknown_spellings() {
        for (s, wire) in [
            (PubkySocialEventStatus::Confirmed, "confirmed"),
            (PubkySocialEventStatus::Tentative, "tentative"),
            (PubkySocialEventStatus::Cancelled, "cancelled"),
        ] {
            assert_eq!(serde_json::to_string(&s).unwrap(), format!("\"{wire}\""));
            assert!(s.is_known());
        }
        let odd: PubkySocialEventStatus = serde_json::from_str("\"maybe\"").unwrap();
        assert_eq!(odd, PubkySocialEventStatus::Unknown("maybe".into()));
        assert_eq!(serde_json::to_string(&odd).unwrap(), "\"maybe\"");
        for (p, wire) in [
            (PubkySocialAttendancePolicy::Open, "open"),
            (PubkySocialAttendancePolicy::Approval, "approval"),
            (PubkySocialAttendancePolicy::Invite, "invite"),
            (PubkySocialAttendancePolicy::Ticket, "ticket"),
        ] {
            assert_eq!(serde_json::to_string(&p).unwrap(), format!("\"{wire}\""));
            assert!(p.is_known());
        }
        assert!(!PubkySocialAttendancePolicy::Unknown("rsvp".into()).is_known());
    }
}
