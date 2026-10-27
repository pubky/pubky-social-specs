//! The `rating` kind: stars on a thing, a reply whose `parent` is what is rated, any universal
//! reference (a place, an event, a listing, a link). One per author per target, the newest
//! version wins. A post with stars is a rating; one without is a plain reply to the same parent.
//! It is the shared star rating any app can use; an app that needs more than stars and a text
//! defines its own kind in its sub-spec.

use crate::common::{check_extra, code_point_len, frozen_trim, json_error};
use crate::limits::VALIDATION_LIMITS;
use serde::{Deserialize, Serialize};

#[cfg(feature = "openapi")]
use utoipa::ToSchema;

use super::super::super::PubkySocialPost;

/// Typed JSON envelope stored in `PubkySocialPost::content` when `kind == Rating`.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "openapi", derive(ToSchema))]
pub struct PubkySocialRatingContent {
    /// `rating_min_half_stars..=rating_max_half_stars`: an integer 1 to 10, shown as half stars
    /// up to five (10 is five stars).
    pub rating: i64,
    /// Trimmed by the builder, a blank one absent; at most `rating_text_max_length` code points.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Unknown members, preserved on rewrite; see the module contract in `models/mod.rs`.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// Validates a `kind = Rating` post, including its JSON content envelope.
pub(crate) fn validate_rating_post(post: &PubkySocialPost) -> Result<(), String> {
    if post.parent.is_none() {
        return Err(
            "Validation Error: Rating posts must have a parent, the thing they rate".into(),
        );
    }
    if post.embed.is_some() {
        return Err("Validation Error: Rating posts cannot have embed".into());
    }
    if code_point_len(&post.content) > VALIDATION_LIMITS.rating_content_max_length {
        return Err(format!(
            "Validation Error: Rating content must be at most {} code points",
            VALIDATION_LIMITS.rating_content_max_length
        ));
    }
    let envelope: PubkySocialRatingContent = serde_json::from_str(&post.content).map_err(|e| {
        format!(
            "Validation Error: Rating content must be a valid JSON envelope: {}",
            json_error(&e)
        )
    })?;
    check_extra(&envelope.extra, &["rating", "text"])?;
    let min = VALIDATION_LIMITS.rating_min_half_stars;
    let max = VALIDATION_LIMITS.rating_max_half_stars;
    if envelope.rating < min as i64 || envelope.rating > max as i64 {
        return Err(format!(
            "Validation Error: Rating must be {min} to {max} half stars"
        ));
    }
    if let Some(text) = &envelope.text {
        if frozen_trim(text).is_empty() {
            return Err("Validation Error: Rating text must not be blank".into());
        }
        if code_point_len(text) > VALIDATION_LIMITS.rating_text_max_length {
            return Err(format!(
                "Validation Error: Rating text must be at most {} code points",
                VALIDATION_LIMITS.rating_text_max_length
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::traits::{TimestampId, Validatable, PUB_CTX};
    use crate::{PubkySocialAttachment, PubkySocialPostKind};

    const PK: &str = "operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo";

    fn place() -> String {
        "https://www.openstreetmap.org/way/481516234".to_string()
    }

    fn raw(content: &str, parent: Option<String>) -> PubkySocialPost {
        PubkySocialPost::new(
            content.to_string(),
            PubkySocialPostKind::Rating,
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
    fn builder_round_trips_and_trims_the_text() {
        let post = PubkySocialPost::new_rating(place(), 7, Some("  great coffee  ".into()), vec![]);
        assert_eq!(post.kind, PubkySocialPostKind::Rating);
        assert_eq!(post.parent.as_deref(), Some(place().as_str()));
        assert_eq!(post.content, r#"{"rating":7,"text":"great coffee"}"#);
        assert_eq!(validate(&post), Ok(()));
        let blob = serde_json::to_vec(&post).unwrap();
        let read =
            <PubkySocialPost as Validatable>::try_from(&blob, &post.create_id(), &PUB_CTX).unwrap();
        assert_eq!(read, post);
        let stars_only = PubkySocialPost::new_rating(place(), 10, Some("  ".into()), vec![]);
        assert_eq!(stars_only.content, r#"{"rating":10}"#);
        // photos of the place ride the attachments
        let with_photo = PubkySocialPost::new_rating(
            place(),
            9,
            None,
            vec![PubkySocialAttachment::new(
                format!("pubky://{PK}/pub/social/v1/files/PZBQ010FF079VVZPQG1RNFN6DR.png"),
                None,
                None,
            )],
        );
        assert_eq!(validate(&with_photo), Ok(()));
    }

    #[test]
    fn a_reader_never_rewrites() {
        let post = raw(
            r#"{"rating":3,"text":" padded ","aspect":"service"}"#,
            Some(place()),
        );
        assert_eq!(validate(&post), Ok(()));
        let e: PubkySocialRatingContent = serde_json::from_str(&post.content).unwrap();
        assert_eq!(e.text.as_deref(), Some(" padded "));
        assert_eq!(e.extra["aspect"], "service");
        assert_eq!(
            serde_json::to_string(&e).unwrap(),
            r#"{"rating":3,"text":" padded ","aspect":"service"}"#
        );
    }

    #[test]
    fn envelope_and_member_rules() {
        assert_eq!(
            err(&raw(r#"{"rating":7}"#, None)),
            "Validation Error: Rating posts must have a parent, the thing they rate"
        );
        let mut quoted = raw(r#"{"rating":7}"#, Some(place()));
        quoted.embed = Some("https://example.com".into());
        assert_eq!(
            err(&quoted),
            "Validation Error: Rating posts cannot have embed"
        );
        // anything on the universal tier can be rated
        for target in [
            format!("pubky://{PK}/pub/social/v1/posts/0032SSN7Q4EVG"),
            "geo:46.00547,8.95186".to_string(),
            "https://lu.ma/abc".to_string(),
            format!("pubky://{PK}"),
        ] {
            assert_eq!(
                validate(&raw(r#"{"rating":7}"#, Some(target.clone()))),
                Ok(()),
                "{target}"
            );
        }
        let over = "x".repeat(VALIDATION_LIMITS.rating_content_max_length + 1);
        assert!(err(&raw(&over, Some(place()))).contains("Rating content must be at most"));
        assert!(err(&raw("[]", Some(place())))
            .starts_with("Validation Error: Rating content must be a valid JSON envelope: "));
        assert!(err(&raw(r#"{"text":"x"}"#, Some(place()))).contains("missing field `rating`"));
        let min = VALIDATION_LIMITS.rating_min_half_stars;
        let max = VALIDATION_LIMITS.rating_max_half_stars;
        for ok in min..=max {
            assert_eq!(
                validate(&raw(&format!(r#"{{"rating":{ok}}}"#), Some(place()))),
                Ok(()),
                "{ok}"
            );
        }
        for bad in ["0", "11", "-1", "100"] {
            assert_eq!(
                err(&raw(&format!(r#"{{"rating":{bad}}}"#), Some(place()))),
                format!("Validation Error: Rating must be {min} to {max} half stars"),
                "{bad}"
            );
        }
        assert!(err(&raw(r#"{"rating":7.5}"#, Some(place()))).contains("expected i64"));
        assert!(err(&raw(r#"{"rating":"7"}"#, Some(place()))).contains("expected i64"));
        assert_eq!(
            err(&raw(r#"{"rating":7,"text":""}"#, Some(place()))),
            "Validation Error: Rating text must not be blank"
        );
        let max = VALIDATION_LIMITS.rating_text_max_length;
        assert_eq!(
            validate(&raw(
                &format!(r#"{{"rating":7,"text":"{}"}}"#, "t".repeat(max)),
                Some(place())
            )),
            Ok(())
        );
        assert_eq!(
            err(&raw(
                &format!(r#"{{"rating":7,"text":"{}"}}"#, "t".repeat(max + 1)),
                Some(place())
            )),
            format!("Validation Error: Rating text must be at most {max} code points")
        );
        assert!(
            err(&raw(r#"{"rating":7,"n":9007199254740992}"#, Some(place()))).contains("JSON-safe")
        );
    }
}
