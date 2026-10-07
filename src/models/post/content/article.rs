use crate::common::{code_point_len, frozen_trim, json_error};
use crate::limits::VALIDATION_LIMITS;
use serde::{Deserialize, Serialize};

#[cfg(feature = "openapi")]
use utoipa::ToSchema;

use crate::common::check_extra;
use crate::traits::ValidationCtx;

use super::super::PubkySocialPost;

/// Typed JSON envelope stored in `PubkySocialPost::content` when `kind == Article`.
///
/// Parsed and validated by this crate, never stored as a top-level object. Build one through
/// `PubkySocialPost::create_article_post`; the struct is public so consumers can inspect the
/// shape. No `deny_unknown_fields`: later minors may add members, and `extra` keeps them.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "openapi", derive(ToSchema))]
#[serde(rename_all = "snake_case")]
pub struct PubkySocialArticleContent {
    /// Trimmed by the builder; `[1, article_title_max_length]` code points.
    pub title: String,
    /// Markdown; at most `article_body_max_length` code points.
    pub body: String,
    /// Optional cover, a canonical pubky or web URI of at most `image_url_max_length`
    /// code points.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover_image: Option<String>,
    /// Unknown members, preserved on rewrite; see the module contract in `models/mod.rs`.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// Validates the envelope of a `kind = Article` post. The post-level rules (references,
/// the cover included, attachments) run before this in `PubkySocialPost::validate`.
pub(crate) fn validate_article_post(
    post: &PubkySocialPost,
    _ctx: &ValidationCtx,
) -> Result<(), String> {
    if code_point_len(&post.content) > VALIDATION_LIMITS.article_content_max_length {
        return Err(format!(
            "Validation Error: Article content must be at most {} code points",
            VALIDATION_LIMITS.article_content_max_length
        ));
    }
    let envelope: PubkySocialArticleContent = serde_json::from_str(&post.content).map_err(|e| {
        format!(
            "Validation Error: Article content must be a valid JSON envelope: {}",
            json_error(&e)
        )
    })?;
    check_extra(&envelope.extra, &["title", "body", "cover_image"])?;
    // Other controls escape to six characters and would break the two-to-one envelope bound
    let is_control = |c: char| c.is_ascii_control() && !matches!(c, '\t' | '\n' | '\r');
    if envelope.title.chars().any(is_control) || envelope.body.chars().any(is_control) {
        return Err(
            "Validation Error: Article text must not contain control characters other than tab, newline and carriage return".into(),
        );
    }
    if frozen_trim(&envelope.title).is_empty() {
        return Err(
            "Validation Error: Article title must contain non-whitespace characters".into(),
        );
    }
    // The untrimmed length, so a padded title cannot slip past the cap
    if code_point_len(&envelope.title) > VALIDATION_LIMITS.article_title_max_length {
        return Err(format!(
            "Validation Error: Article title must be at most {} code points",
            VALIDATION_LIMITS.article_title_max_length
        ));
    }
    if code_point_len(&envelope.body) > VALIDATION_LIMITS.article_body_max_length {
        return Err(format!(
            "Validation Error: Article body must be at most {} code points",
            VALIDATION_LIMITS.article_body_max_length
        ));
    }
    // The cover is a reference position and runs through the post-level gate
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::traits::{TimestampId, Validatable, PUB_CTX};
    use crate::{PubkySocialAttachment, PubkySocialPostKind};

    const PK: &str = "operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo";

    fn p(path: &str) -> String {
        format!("pubky://{PK}{path}")
    }

    fn article(title: &str, body: &str, cover: Option<&str>) -> PubkySocialPost {
        PubkySocialPost::new_article(
            title.to_string(),
            body.to_string(),
            cover.map(str::to_string),
            None,
            None,
            vec![],
            None,
        )
    }

    fn validate(post: &PubkySocialPost) -> Result<(), String> {
        let id = post.create_id();
        post.validate(Some(&id), &PUB_CTX)
    }

    fn err(post: &PubkySocialPost) -> String {
        validate(post).expect_err("expected a validation error")
    }

    #[test]
    fn builder_round_trips_and_trims_the_title() {
        let post = article("\u{3000} Hello \u{3000}", "# body", None);
        assert_eq!(post.kind, PubkySocialPostKind::Article);
        assert!(validate(&post).is_ok());
        let envelope: PubkySocialArticleContent = serde_json::from_str(&post.content).unwrap();
        assert_eq!(envelope.title, "Hello");
        assert_eq!(envelope.body, "# body");
        assert!(envelope.cover_image.is_none());
        assert_eq!(post.content, r##"{"title":"Hello","body":"# body"}"##);
    }

    #[test]
    fn title_rules() {
        assert!(err(&article("   ", "b", None)).contains("title"));
        let max = VALIDATION_LIMITS.article_title_max_length;
        assert!(validate(&article(&"\u{1F600}".repeat(max), "b", None)).is_ok());
        assert!(err(&article(&"a".repeat(max + 1), "b", None)).contains("title"));
        // A padded title inside a hand-written envelope counts untrimmed
        let padded = format!(r#"{{"title":"{} ","body":"b"}}"#, "a".repeat(max));
        let post = PubkySocialPost::new(padded, PubkySocialPostKind::Article, None, None, vec![]);
        assert!(err(&post).contains("title"));
    }

    #[test]
    fn body_rules() {
        let max = VALIDATION_LIMITS.article_body_max_length;
        assert!(validate(&article("t", &"b".repeat(max), None)).is_ok());
        assert!(err(&article("t", &"b".repeat(max + 1), None)).contains("body"));
        // A max body made of escaped characters must still fit the raw envelope cap
        let escaped = "a\n\"\\".repeat(max / 4);
        assert_eq!(code_point_len(&escaped), max);
        let title = "t".repeat(VALIDATION_LIMITS.article_title_max_length);
        assert!(validate(&article(
            &title,
            &escaped,
            Some("https://example.com/c.png")
        ))
        .is_ok());
    }

    #[test]
    fn control_characters_reject() {
        assert!(err(&article("t", "a\u{0}b", None)).contains("control"));
        assert!(err(&article("t\u{1b}", "b", None)).contains("control"));
        assert!(validate(&article("t", "a\tb\r\nc", None)).is_ok());
    }

    #[test]
    fn raw_cap_is_checked_before_parsing() {
        let raw = "x".repeat(VALIDATION_LIMITS.article_content_max_length + 1);
        let post = PubkySocialPost::new(raw, PubkySocialPostKind::Article, None, None, vec![]);
        let e = err(&post);
        assert!(e.contains("at most"), "{e}");
        assert!(!e.contains("JSON"), "{e}");
    }

    #[test]
    fn malformed_envelope_rejects() {
        let post = PubkySocialPost::new(
            "not json".into(),
            PubkySocialPostKind::Article,
            None,
            None,
            vec![],
        );
        assert!(err(&post).contains("JSON envelope"));
        let post = PubkySocialPost::new(
            r#"{"title":"t"}"#.into(),
            PubkySocialPostKind::Article,
            None,
            None,
            vec![],
        );
        assert!(err(&post).contains("JSON envelope"));
    }

    #[test]
    fn cover_image_rules() {
        let file = p("/pub/social/v1/files/PZBQ010FF079VVZPQG1RNFN6DR.png");
        assert!(validate(&article("t", "b", Some(&file))).is_ok());
        assert!(validate(&article("t", "b", Some("https://example.com/c.png"))).is_ok());
        let short = format!(
            "pubky{}/pub/social/v1/files/PZBQ010FF079VVZPQG1RNFN6DR.png",
            &p("")["pubky://".len()..]
        );
        let versioned = p("/pub/social/v1/posts/0032SSN7Q4EVG/0032SSN7Q4EVG.json");
        for bad in [
            "ftp://x/c.png",
            " https://example.com/c.png",
            "",
            short.as_str(),
            versioned.as_str(),
        ] {
            assert!(
                err(&article("t", "b", Some(bad))).contains("cover_image"),
                "{bad}"
            );
        }
        let max = VALIDATION_LIMITS.image_url_max_length;
        let long = format!("https://e.com/{}", "a".repeat(max - 14));
        assert_eq!(code_point_len(&long), max);
        assert!(validate(&article("t", "b", Some(&long))).is_ok());
        assert!(err(&article("t", "b", Some(&format!("{long}a")))).contains("cover_image"));
    }

    #[test]
    fn article_may_reply_quote_attach_and_lock() {
        let post = PubkySocialPost::new_article(
            "t".into(),
            "b".into(),
            None,
            Some(p("/pub/social/v1/posts/0032SSN7Q4EVG")),
            Some("https://example.com/source".into()),
            vec![PubkySocialAttachment::new(
                p("/pub/social/v1/files/PZBQ010FF079VVZPQG1RNFN6DR.png"),
                None,
                None,
            )],
            Some(p("/pub/app.locks/0032SSN7Q4EVG.json")),
        );
        assert!(validate(&post).is_ok());
        assert!(post.lock.is_some());
    }

    #[test]
    fn attachment_rules_still_apply_to_articles() {
        let many = (0..=VALIDATION_LIMITS.post_attachments_max_count)
            .map(|_| {
                PubkySocialAttachment::new(
                    p("/pub/social/v1/files/PZBQ010FF079VVZPQG1RNFN6DR.png"),
                    None,
                    None,
                )
            })
            .collect();
        let post =
            PubkySocialPost::new_article("t".into(), "b".into(), None, None, None, many, None);
        assert!(err(&post).contains("Too many attachments"));
    }

    #[test]
    fn unknown_members_survive_rewrite() {
        let envelope: PubkySocialArticleContent =
            serde_json::from_str(r#"{"title":"t","body":"b","ext":{"toc":true}}"#).unwrap();
        let out: serde_json::Value = serde_json::to_value(&envelope).unwrap();
        assert_eq!(out["ext"]["toc"], true);
        assert_eq!(out["title"], "t");
    }
}
