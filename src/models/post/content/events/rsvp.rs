//! The `rsvp` kind: an answer to a Pubky event, a reply whose `parent` is the event's versionless
//! social post URI. One per author per event or occurrence: the client edits its post, the
//! indexer keeps the newest version. Whether the post named is an event is the indexer's
//! question; an external event takes the ordinary posts (replies, tags, bookmarks, collections).

use crate::common::{check_extra, code_point_len, frozen_trim, json_error};
use crate::limits::VALIDATION_LIMITS;
use crate::{ParsedUri, Resource};
use serde::{Deserialize, Serialize};

#[cfg(feature = "openapi")]
use utoipa::ToSchema;

use super::super::super::PubkySocialPost;
use super::time::validate_local_date_time;

/// The answer. `requested` asks under `approval` or `invite`; the client flips it to `accepted`
/// once it holds the entitlement.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(from = "String", into = "String")]
#[non_exhaustive]
pub enum PubkySocialRsvpStatus {
    Requested,
    #[default]
    Accepted,
    Declined,
    Tentative,
    Unknown(String),
}

wire_names!(PubkySocialRsvpStatus {
    Requested => "requested",
    Accepted => "accepted",
    Declined => "declined",
    Tentative => "tentative",
});

/// Typed JSON envelope stored in `PubkySocialPost::content` when `kind == Rsvp`.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "openapi", derive(ToSchema))]
#[serde(rename_all = "camelCase")]
pub struct PubkySocialRsvpContent {
    pub status: PubkySocialRsvpStatus,
    /// The occurrence answered, its local start in the event's series; absent for the series.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recurrence_id: Option<String>,
    /// Companions without an account, `0..=rsvp_guests_max_people`; `0` when absent.
    #[serde(default)]
    pub guests: i64,
    /// Trimmed by the builder, a blank one absent; at most `rsvp_note_max_length` code points.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// Unknown members, preserved on rewrite; see the module contract in `models/mod.rs`.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// Validates a `kind = Rsvp` post, including its JSON content envelope.
pub(crate) fn validate_rsvp_post(post: &PubkySocialPost) -> Result<(), String> {
    let Some(parent) = &post.parent else {
        return Err(
            "Validation Error: Rsvp posts must have a parent, the event they answer".into(),
        );
    };
    // The gate ran first, so the parent is canonical and a post reference names no version
    let is_post = matches!(
        ParsedUri::try_from(parent.as_str()),
        Ok(ParsedUri {
            resource: Resource::Post { .. },
            ..
        })
    );
    if !is_post {
        return Err(format!(
            "Validation Error: Rsvp parent must be a social post URI, the Pubky event it answers: {parent}"
        ));
    }
    if post.embed.is_some() || !post.attachments.is_empty() {
        return Err("Validation Error: Rsvp posts cannot have embed or attachments".into());
    }
    if code_point_len(&post.content) > VALIDATION_LIMITS.rsvp_content_max_length {
        return Err(format!(
            "Validation Error: Rsvp content must be at most {} code points",
            VALIDATION_LIMITS.rsvp_content_max_length
        ));
    }
    let envelope: PubkySocialRsvpContent = serde_json::from_str(&post.content).map_err(|e| {
        format!(
            "Validation Error: Rsvp content must be a valid JSON envelope: {}",
            json_error(&e)
        )
    })?;
    check_extra(
        &envelope.extra,
        &["status", "recurrenceId", "guests", "note"],
    )?;
    if !envelope.status.is_known() {
        return Err(format!(
            "Validation Error: Rsvp status must be one of requested, accepted, declined, tentative: {}",
            envelope.status.wire_name()
        ));
    }
    if let Some(occurrence) = &envelope.recurrence_id {
        validate_local_date_time("recurrenceId", occurrence)?;
    }
    let max = VALIDATION_LIMITS.rsvp_guests_max_people;
    if envelope.guests < 0 || envelope.guests > max as i64 {
        return Err(format!(
            "Validation Error: Rsvp guests must be 0 to {max} people"
        ));
    }
    if let Some(note) = &envelope.note {
        if frozen_trim(note).is_empty() {
            return Err("Validation Error: Rsvp note must not be blank".into());
        }
        if code_point_len(note) > VALIDATION_LIMITS.rsvp_note_max_length {
            return Err(format!(
                "Validation Error: Rsvp note must be at most {} code points",
                VALIDATION_LIMITS.rsvp_note_max_length
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::traits::{Root, TimestampId, Validatable, ValidationCtx, PUB_CTX};
    use crate::{PubkySocialAttachment, PubkySocialPostKind};

    const PK: &str = "operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo";

    fn event() -> String {
        format!("pubky://{PK}/pub/social/v1/posts/0032SSN7Q4EVG")
    }

    fn rsvp(status: PubkySocialRsvpStatus, guests: i64, note: Option<&str>) -> PubkySocialPost {
        PubkySocialPost::new_rsvp(event(), status, None, guests, note.map(str::to_string))
    }

    fn raw(content: &str, parent: Option<String>) -> PubkySocialPost {
        PubkySocialPost::new(
            content.to_string(),
            PubkySocialPostKind::Rsvp,
            parent,
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

    #[test]
    fn builder_round_trips_and_trims_the_note() {
        let post = rsvp(
            PubkySocialRsvpStatus::Accepted,
            1,
            Some("  bringing cake \u{3000}"),
        );
        assert_eq!(post.kind, PubkySocialPostKind::Rsvp);
        assert_eq!(post.parent.as_deref(), Some(event().as_str()));
        assert_eq!(validate(&post), Ok(()));
        assert_eq!(
            post.content,
            r#"{"status":"accepted","guests":1,"note":"bringing cake"}"#
        );
        let blob = serde_json::to_vec(&post).unwrap();
        let read =
            <PubkySocialPost as Validatable>::try_from(&blob, &post.create_id(), &PUB_CTX).unwrap();
        assert_eq!(read, post);
        // a blank note is an absent one
        let post = rsvp(PubkySocialRsvpStatus::Declined, 0, Some(" \t "));
        assert_eq!(post.content, r#"{"status":"declined","guests":0}"#);
        // an occurrence
        let post = PubkySocialPost::new_rsvp(
            event(),
            PubkySocialRsvpStatus::Tentative,
            Some("2026-11-10T18:30:00".into()),
            0,
            None,
        );
        assert_eq!(validate(&post), Ok(()));
        assert!(post
            .content
            .contains(r#""recurrenceId":"2026-11-10T18:30:00""#));
    }

    #[test]
    fn a_reader_never_rewrites() {
        let json = r#"{"status":"accepted","note":" padded ","guests":2,"plusOne":"Rio"}"#;
        let post = raw(json, Some(event()));
        assert_eq!(validate(&post), Ok(()));
        let e: PubkySocialRsvpContent = serde_json::from_str(&post.content).unwrap();
        assert_eq!(e.note.as_deref(), Some(" padded "));
        assert_eq!(e.extra["plusOne"], "Rio");
        // the default guests, absent on the wire, read as none
        let e: PubkySocialRsvpContent = serde_json::from_str(r#"{"status":"declined"}"#).unwrap();
        assert_eq!(e.guests, 0);
    }

    #[test]
    fn envelope_rules() {
        assert_eq!(
            err(&raw(r#"{"status":"accepted"}"#, None)),
            "Validation Error: Rsvp posts must have a parent, the event they answer"
        );
        let mut quoted = rsvp(PubkySocialRsvpStatus::Accepted, 0, None);
        quoted.embed = Some("https://example.com".into());
        assert_eq!(
            err(&quoted),
            "Validation Error: Rsvp posts cannot have embed or attachments"
        );
        let mut with_media = rsvp(PubkySocialRsvpStatus::Accepted, 0, None);
        with_media.attachments = vec![PubkySocialAttachment::new(
            "https://example.com/a.png".into(),
            None,
            None,
        )];
        assert!(err(&with_media).contains("embed or attachments"));
        // the parent is a social post, public or (for a private post) private; whether it is an
        // event is the indexer's question
        let answer = |parent: String| raw(r#"{"status":"accepted"}"#, Some(parent));
        assert_eq!(validate(&answer(event())), Ok(()));
        let private = answer(format!("pubky://{PK}/priv/social/v1/posts/0032SSN7Q4EVG"));
        assert_eq!(
            private.validate(None, &ValidationCtx { root: Root::Priv }),
            Ok(())
        );
        assert!(err(&private).contains("must not reference a private object"));
        for parent in [
            "https://lu.ma/abc".to_string(),
            "nostr:naddr1x".into(),
            "geo:46.00547,8.95186".into(),
            format!("pubky://{PK}"),
            format!("pubky://{PK}/pub/social/v1/profile.json"),
            format!("pubky://{PK}/pub/social/v1/files/0032SSN7Q4EVG"),
            format!("pubky://{PK}/pub/events/v1/posts/0032SSN7Q4EVG"),
            format!("pubky://{PK}/pub/social/v1/posts/not-an-id"),
        ] {
            assert_eq!(
                err(&answer(parent.clone())),
                format!("Validation Error: Rsvp parent must be a social post URI, the Pubky event it answers: {parent}"),
            );
        }
        assert!(err(&answer(format!(
            "pubky://{PK}/pub/social/v1/posts/0032SSN7Q4EVG/0032SSN7Q4EVG.json"
        )))
        .contains("versionless"));
        let over = "x".repeat(VALIDATION_LIMITS.rsvp_content_max_length + 1);
        assert!(err(&raw(&over, Some(event()))).contains("Rsvp content must be at most"));
        assert!(err(&raw("{", Some(event())))
            .starts_with("Validation Error: Rsvp content must be a valid JSON envelope: "));
        assert!(err(&raw("{}", Some(event()))).contains("missing field `status`"));
    }

    #[test]
    fn member_rules() {
        let with = |json: &str| raw(json, Some(event()));
        for status in ["requested", "accepted", "declined", "tentative"] {
            assert_eq!(
                validate(&with(&format!(r#"{{"status":"{status}"}}"#))),
                Ok(()),
                "{status}"
            );
        }
        assert_eq!(
            err(&with(r#"{"status":"going"}"#)),
            "Validation Error: Rsvp status must be one of requested, accepted, declined, tentative: going"
        );
        assert_eq!(
            err(&with(r#"{"status":"accepted","recurrenceId":"2026-11-10"}"#)),
            "Validation Error: recurrenceId must be a local date-time of the form YYYY-MM-DDTHH:MM:SS: 2026-11-10"
        );
        let max = VALIDATION_LIMITS.rsvp_guests_max_people;
        assert_eq!(
            validate(&with(&format!(r#"{{"status":"accepted","guests":{max}}}"#))),
            Ok(())
        );
        for bad in [-1i64, max as i64 + 1] {
            assert_eq!(
                err(&with(&format!(r#"{{"status":"accepted","guests":{bad}}}"#))),
                format!("Validation Error: Rsvp guests must be 0 to {max} people")
            );
        }
        assert!(err(&with(r#"{"status":"accepted","guests":1.5}"#)).contains("expected i64"));
        assert_eq!(
            err(&with(r#"{"status":"accepted","note":"  "}"#)),
            "Validation Error: Rsvp note must not be blank"
        );
        let max = VALIDATION_LIMITS.rsvp_note_max_length;
        assert_eq!(
            validate(&with(&format!(
                r#"{{"status":"accepted","note":"{}"}}"#,
                "n".repeat(max)
            ))),
            Ok(())
        );
        assert_eq!(
            err(&with(&format!(
                r#"{{"status":"accepted","note":"{}"}}"#,
                "n".repeat(max + 1)
            ))),
            format!("Validation Error: Rsvp note must be at most {max} code points")
        );
        assert!(err(&with(
            r#"{"status":"accepted","status2":1,"guests":9007199254740992}"#
        ))
        .contains("Rsvp guests must be 0 to"));
        assert!(err(&with(
            r#"{"status":"accepted","guests":99999999999999999999}"#
        ))
        .contains("expected i64"));
        assert!(
            err(&with(r#"{"status":"accepted","big":9007199254740992}"#)).contains("JSON-safe")
        );
    }

    #[test]
    fn statuses_round_trip_and_keep_unknown_spellings() {
        for (s, wire) in [
            (PubkySocialRsvpStatus::Requested, "requested"),
            (PubkySocialRsvpStatus::Accepted, "accepted"),
            (PubkySocialRsvpStatus::Declined, "declined"),
            (PubkySocialRsvpStatus::Tentative, "tentative"),
        ] {
            assert_eq!(serde_json::to_string(&s).unwrap(), format!("\"{wire}\""));
            assert!(s.is_known());
        }
        let odd: PubkySocialRsvpStatus = serde_json::from_str("\"going\"").unwrap();
        assert_eq!(odd, PubkySocialRsvpStatus::Unknown("going".into()));
        assert_eq!(serde_json::to_string(&odd).unwrap(), "\"going\"");
    }
}
