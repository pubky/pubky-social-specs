use crate::common::{check_extra, code_point_len, frozen_trim, json_error, trimmed_or_none};
use crate::limits::VALIDATION_LIMITS;
use serde::{Deserialize, Serialize};
use std::str::FromStr;

#[cfg(feature = "openapi")]
use utoipa::ToSchema;

use super::super::PubkySocialPost;

/// Creator-chosen default layout for experiencing a collection.
///
/// Unrecognized values deserialize as `Unknown`, spelling kept, so future layouts never
/// invalidate the whole post (same policy as `PubkySocialPostKind`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(from = "String", into = "String")]
#[non_exhaustive]
pub enum PubkySocialCollectionLayout {
    Grid,
    List,
    Visual,
    Unknown(String),
}

wire_names!(PubkySocialCollectionLayout {
    Grid => "grid",
    List => "list",
    Visual => "visual",
});

impl FromStr for PubkySocialCollectionLayout {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "grid" => Ok(Self::Grid),
            "list" => Ok(Self::List),
            "visual" => Ok(Self::Visual),
            _ => Err(format!(
                "Validation Error: Invalid collection layout: {}",
                s
            )),
        }
    }
}

/// One curated item: any URI on the universal tier, with an optional note. An object rather
/// than a string so per-item metadata stays additive.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "openapi", derive(ToSchema))]
#[serde(rename_all = "snake_case")]
pub struct PubkySocialCollectionItem {
    /// Reference tier, universal: a social object, another app's object, or an external URI.
    pub uri: String,
    /// Curator's note on this item, `1..=collection_item_note_max_length` code points and not
    /// whitespace-only: an empty note is an absent one, spelled once.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// Unknown members, preserved on rewrite; see the module contract in `models/mod.rs`.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl PubkySocialCollectionItem {
    /// An item over a canonical `uri` with an optional curator `note`; no unknown members.
    /// Trims the note, a blank one becoming absent; the uri passes through verbatim.
    pub fn new(uri: String, note: Option<String>) -> Self {
        Self {
            uri,
            note: note.and_then(trimmed_or_none),
            extra: Default::default(),
        }
    }
}

/// Typed JSON envelope stored in `PubkySocialPost::content` when `kind == Collection`.
///
/// A collection post curates an ordered list of items under a `name` and optional
/// `description`. The envelope is parsed and validated by this crate, never re-serialized by it
/// as a top-level homeserver object. Re-exported so SDK consumers can inspect the shape; the
/// authoritative way to produce one is a `PubkySocialPost` with `kind: Collection` whose
/// `content` JSON-parses into it. No `deny_unknown_fields`: unknown members are preserved.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "openapi", derive(ToSchema))]
#[serde(rename_all = "snake_case")]
pub struct PubkySocialCollectionContent {
    /// Display name; `collection_name_{min,max}_length` code points, not whitespace-only.
    pub name: String,
    /// Optional description, at most `collection_description_max_length` code points and not
    /// whitespace-only: a blank description is an absent one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Ordered curated items, at most `collection_items_max_count`.
    #[serde(default)]
    pub items: Vec<PubkySocialCollectionItem>,
    /// Optional cover, an image reference per the post-level gate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover_image: Option<String>,
    /// Creator's preferred default layout.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<PubkySocialCollectionLayout>,
    /// Unknown members, preserved on rewrite; see the module contract in `models/mod.rs`.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// Validates a `kind = Collection` post, including its JSON content envelope. The cover and
/// every item uri are reference positions and run through the post-level gate before this,
/// with the author in scope when there is one; nothing here re-gates them.
pub(crate) fn validate_collection_post(post: &PubkySocialPost) -> Result<(), String> {
    if post.parent.is_some() || post.embed.is_some() {
        return Err("Validation Error: Collection posts cannot have parent or embed".into());
    }
    // Anti-misuse guard: items belong in the envelope, not in `post.attachments`.
    if !post.attachments.is_empty() {
        return Err(
            "Validation Error: Collection posts must not use post.attachments; items belong in the content envelope"
                .into(),
        );
    }
    if code_point_len(&post.content) > VALIDATION_LIMITS.collection_content_max_length {
        return Err(format!(
            "Validation Error: Collection content exceeds max length {}",
            VALIDATION_LIMITS.collection_content_max_length
        ));
    }
    let envelope: PubkySocialCollectionContent =
        serde_json::from_str(&post.content).map_err(|e| {
            format!(
                "Validation Error: Collection content must be a valid JSON envelope: {}",
                json_error(&e)
            )
        })?;
    validate_collection_envelope(&envelope)
}

fn validate_collection_envelope(envelope: &PubkySocialCollectionContent) -> Result<(), String> {
    check_extra(
        &envelope.extra,
        &["name", "description", "items", "cover_image", "layout"],
    )?;
    if frozen_trim(&envelope.name).is_empty() {
        return Err(
            "Validation Error: Collection name must contain non-whitespace characters".into(),
        );
    }
    let name_chars = code_point_len(&envelope.name);
    let name_min = VALIDATION_LIMITS.collection_name_min_length;
    let name_max = VALIDATION_LIMITS.collection_name_max_length;
    if !(name_min..=name_max).contains(&name_chars) {
        return Err(format!(
            "Validation Error: Collection name must be {} to {} characters",
            name_min, name_max
        ));
    }
    if let Some(desc) = &envelope.description {
        // Absent is the one spelling of no description
        if frozen_trim(desc).is_empty() {
            return Err("Validation Error: Collection description must not be blank".into());
        }
        if code_point_len(desc) > VALIDATION_LIMITS.collection_description_max_length {
            return Err(format!(
                "Validation Error: Collection description exceeds {} characters",
                VALIDATION_LIMITS.collection_description_max_length
            ));
        }
    }
    // The item count is checked with the post's list caps, before any reference is read
    for (index, item) in envelope.items.iter().enumerate() {
        check_extra(&item.extra, &["uri", "note"])?;
        if let Some(note) = &item.note {
            let max = VALIDATION_LIMITS.collection_item_note_max_length;
            if frozen_trim(note).is_empty() || code_point_len(note) > max {
                return Err(format!(
                    "Validation Error: items[{index}].note must be 1 to {max} code points and not blank"
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::super::{PubkySocialAttachment, PubkySocialPost, PubkySocialPostKind};
    use super::*;
    use crate::traits::PUB_CTX;
    use crate::traits::{TimestampId, Validatable};

    const TEST_PUBKY_ID: &str = "operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo";

    fn collection_envelope_json(name: &str, description: Option<&str>, items: &[String]) -> String {
        serde_json::to_string(&PubkySocialCollectionContent {
            name: name.to_string(),
            description: description.map(|d| d.to_string()),
            items: items
                .iter()
                .map(|u| PubkySocialCollectionItem::new(u.clone(), None))
                .collect(),
            ..Default::default()
        })
        .unwrap()
    }

    fn make_collection_post(
        name: &str,
        description: Option<&str>,
        items: Option<Vec<String>>,
    ) -> PubkySocialPost {
        let items = items.unwrap_or_default();
        PubkySocialPost::new(
            collection_envelope_json(name, description, &items),
            PubkySocialPostKind::Collection,
            None,
            None,
            vec![],
        )
    }

    fn make_collection_post_with_cover(cover_image: Option<&str>) -> PubkySocialPost {
        let envelope = PubkySocialCollectionContent {
            name: "X".to_string(),
            cover_image: cover_image.map(|s| s.to_string()),
            ..Default::default()
        };
        let content = serde_json::to_string(&envelope).expect("envelope serialization");
        PubkySocialPost::new(content, PubkySocialPostKind::Collection, None, None, vec![])
    }

    #[test]
    fn test_collection_post_roundtrip_valid() {
        let post = make_collection_post(
            "AI papers",
            Some("Best stuff"),
            Some(vec![
                format!("pubky://{TEST_PUBKY_ID}/pub/social/v1/posts/0034A0X7NJ52A"),
                format!("pubky://{TEST_PUBKY_ID}/pub/social/v1/posts/0034A0X7NJ52E"),
                format!("pubky://{TEST_PUBKY_ID}/pub/social/v1/posts/0034A0X7NJ52C"),
            ]),
        );
        let id = post.create_id();
        let blob = serde_json::to_vec(&post).unwrap();
        let parsed = <PubkySocialPost as Validatable>::try_from(&blob, &id, &PUB_CTX).unwrap();
        assert_eq!(parsed.kind, PubkySocialPostKind::Collection);
        assert!(parsed.attachments.is_empty());
        let envelope: PubkySocialCollectionContent = serde_json::from_str(&parsed.content).unwrap();
        assert_eq!(envelope.items.len(), 3);
    }

    #[test]
    fn test_collection_post_rejects_malformed_envelope() {
        let post = PubkySocialPost::new(
            "this is not JSON".to_string(),
            PubkySocialPostKind::Collection,
            None,
            None,
            vec![],
        );
        let id = post.create_id();
        let result = post.validate(Some(&id), &PUB_CTX);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.contains("JSON envelope"),
            "expected JSON envelope error, got: {}",
            err
        );
    }

    #[test]
    fn test_collection_post_rejects_empty_name() {
        let post = make_collection_post("", None, None);
        let id = post.create_id();
        let result = post.validate(Some(&id), &PUB_CTX);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("name"));
    }

    #[test]
    fn test_collection_post_rejects_oversized_name() {
        // 101 grapheme-ish chars; mix in emoji to confirm we count by unicode scalars, not bytes.
        let oversized = "a".repeat(99) + "🚀🚀";
        assert_eq!(oversized.chars().count(), 101);
        let post = make_collection_post(&oversized, None, None);
        let id = post.create_id();
        let result = post.validate(Some(&id), &PUB_CTX);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("name"));
    }

    #[test]
    fn test_collection_post_accepts_max_name() {
        let exactly_100 = "a".repeat(100);
        assert_eq!(exactly_100.chars().count(), 100);
        let post = make_collection_post(&exactly_100, None, None);
        let id = post.create_id();
        assert!(post.validate(Some(&id), &PUB_CTX).is_ok());
    }

    #[test]
    fn test_collection_post_rejects_whitespace_only_name() {
        // Whitespace-only names pass `min_length=1` purely by char count, so
        // we reject them with a dedicated guard. Without that guard, a name
        // of `"    "` would be a 4-char valid name with no meaningful content.
        let post = make_collection_post("    ", None, None);
        let id = post.create_id();
        let err = post
            .validate(Some(&id), &PUB_CTX)
            .expect_err("whitespace-only name must fail validation");
        assert!(
            err.contains("whitespace"),
            "error should mention whitespace, got: {err}"
        );
    }

    #[test]
    fn test_collection_post_counts_whitespace_in_name_length() {
        // Regression guard: the validator does NOT trim before counting. A
        // 99-char name padded with one space on each side is 101 chars and
        // must fail max=100. With the previous trim-then-count behavior this
        // would have been 99 chars and passed.
        let padded = format!(" {} ", "a".repeat(99));
        assert_eq!(padded.chars().count(), 101);
        let post = make_collection_post(&padded, None, None);
        let id = post.create_id();
        let err = post
            .validate(Some(&id), &PUB_CTX)
            .expect_err("101-char padded name must fail max length");
        assert!(
            err.contains("1 to 100"),
            "error should report the length range, got: {err}"
        );
    }

    #[test]
    fn test_collection_post_accepts_cover_image_pubky_uri() {
        let cover = format!("pubky://{TEST_PUBKY_ID}/pub/social/v1/files/0034A0X7NJ52A");
        let post = make_collection_post_with_cover(Some(&cover));
        let id = post.create_id();
        assert!(post.validate(Some(&id), &PUB_CTX).is_ok());
    }

    #[test]
    fn test_collection_post_accepts_cover_image_https() {
        let post = make_collection_post_with_cover(Some("https://example.com/cover.png"));
        let id = post.create_id();
        assert!(post.validate(Some(&id), &PUB_CTX).is_ok());
    }

    #[test]
    fn test_collection_post_rejects_cover_image_invalid_url() {
        let post = make_collection_post_with_cover(Some("not a url"));
        let id = post.create_id();
        let err = post.validate(Some(&id), &PUB_CTX).unwrap_err();
        assert!(err.contains("cover_image must be"), "got: {err}");
    }

    #[test]
    fn test_collection_post_rejects_cover_image_disallowed_protocol() {
        let post = make_collection_post_with_cover(Some("ftp://example.com/cover.png"));
        let id = post.create_id();
        let err = post.validate(Some(&id), &PUB_CTX).unwrap_err();
        assert!(err.contains("cover_image must be"), "got: {err}");
    }

    #[test]
    fn test_collection_post_rejects_cover_image_too_long() {
        // image_url_max_length is 300; this URL exceeds it.
        let too_long = format!("https://example.com/{}", "a".repeat(300));
        let post = make_collection_post_with_cover(Some(&too_long));
        let id = post.create_id();
        let err = post.validate(Some(&id), &PUB_CTX).unwrap_err();
        assert!(
            err.contains("cover_image must be") && err.contains("300"),
            "got: {err}"
        );
    }

    #[test]
    fn test_collection_post_rejects_oversized_description() {
        let too_long = "a".repeat(501);
        let post = make_collection_post("X", Some(&too_long), None);
        let id = post.create_id();
        let result = post.validate(Some(&id), &PUB_CTX);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("description"));
    }

    #[test]
    fn test_collection_post_rejects_blank_description() {
        for blank in ["", " ", "\u{3000}\t"] {
            let post = make_collection_post("X", Some(blank), None);
            let id = post.create_id();
            let err = post.validate(Some(&id), &PUB_CTX).unwrap_err();
            assert!(
                err.contains("description must not be blank"),
                "{blank:?}: {err}"
            );
        }
    }

    #[test]
    fn test_item_builder_trims_the_note_and_maps_blank_to_none() {
        let uri = "https://example.com/i".to_string();
        let item = PubkySocialCollectionItem::new(uri.clone(), Some("  worth it\u{3000}".into()));
        assert_eq!(item.note.as_deref(), Some("worth it"));
        let item = PubkySocialCollectionItem::new(uri.clone(), Some(" \t ".into()));
        assert_eq!(item.note, None);
        assert_eq!(item.uri, uri);
    }

    #[test]
    fn test_collection_builder_trims_and_maps_blank_description_to_none() {
        let envelope_of = |post: &PubkySocialPost| -> PubkySocialCollectionContent {
            serde_json::from_str(&post.content).unwrap()
        };
        let post = PubkySocialPost::new_collection(
            "  Picks  ".into(),
            Some(" \u{3000} ".into()),
            vec![],
            None,
            None,
        );
        let envelope = envelope_of(&post);
        assert_eq!(envelope.name, "Picks");
        assert_eq!(envelope.description, None);
        assert!(!post.content.contains("description"));
        assert!(post.validate(Some(&post.create_id()), &PUB_CTX).is_ok());

        let post = PubkySocialPost::new_collection(
            "Picks".into(),
            Some("  the best  ".into()),
            vec![],
            None,
            None,
        );
        assert_eq!(envelope_of(&post).description.as_deref(), Some("the best"));
    }

    #[test]
    fn test_collection_post_accepts_max_description() {
        let exactly_500 = "a".repeat(500);
        assert_eq!(exactly_500.chars().count(), 500);
        let post = make_collection_post("X", Some(&exactly_500), None);
        let id = post.create_id();
        assert!(post.validate(Some(&id), &PUB_CTX).is_ok());
    }

    #[test]
    fn test_collection_post_rejects_missing_name() {
        // Envelope JSON without a `name` field at all (description-only).
        // Distinct from `test_collection_post_rejects_empty_name`, which sends
        // an empty string; this sends a missing key entirely.
        let envelope = r#"{ "description": "no name here" }"#.to_string();
        let post = PubkySocialPost::new(
            envelope,
            PubkySocialPostKind::Collection,
            None,
            None,
            vec![],
        );
        let id = post.create_id();
        let result = post.validate(Some(&id), &PUB_CTX);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.contains("name") || err.to_lowercase().contains("missing"),
            "expected name-required error, got: {err}"
        );
    }

    #[test]
    fn test_collection_post_rejects_parent() {
        let post = PubkySocialPost::new(
            collection_envelope_json("X", None, &[]),
            PubkySocialPostKind::Collection,
            Some(format!(
                "pubky://{TEST_PUBKY_ID}/pub/social/v1/posts/0034A0X7NJ52A"
            )),
            None,
            vec![],
        );
        let id = post.create_id();
        let result = post.validate(Some(&id), &PUB_CTX);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.contains("parent or embed"),
            "expected parent-or-embed error, got: {}",
            err
        );
    }

    #[test]
    fn test_collection_post_rejects_embed() {
        let post = PubkySocialPost::new(
            collection_envelope_json("X", None, &[]),
            PubkySocialPostKind::Collection,
            None,
            Some(format!(
                "pubky://{TEST_PUBKY_ID}/pub/social/v1/posts/0034A0X7NJ52A"
            )),
            vec![],
        );
        let id = post.create_id();
        let result = post.validate(Some(&id), &PUB_CTX);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("parent or embed"));
    }

    #[test]
    fn test_collection_post_accepts_100_items() {
        let items: Vec<String> = (0..100)
            .map(|i| format!("pubky://{TEST_PUBKY_ID}/pub/social/v1/posts/{:012X}0", i))
            .collect();
        let post = make_collection_post("Big list", None, Some(items));
        let id = post.create_id();
        assert!(post.validate(Some(&id), &PUB_CTX).is_ok());
    }

    #[test]
    fn test_collection_post_rejects_101_items() {
        let items: Vec<String> = (0..101)
            .map(|i| format!("pubky://{TEST_PUBKY_ID}/pub/social/v1/posts/{:013}", i))
            .collect();
        let post = make_collection_post("Too big", None, Some(items));
        let id = post.create_id();
        let result = post.validate(Some(&id), &PUB_CTX);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("100 items"));
    }
    #[test]
    fn test_collection_post_accepts_zero_items() {
        // Curators may create a draft and add items later via edits.
        let post = make_collection_post("Drafts", None, None);
        let id = post.create_id();
        assert!(post.validate(Some(&id), &PUB_CTX).is_ok());
    }

    #[test]
    fn test_collection_post_roundtrip_layout() {
        let envelope_json = r#"{"name":"Photos","layout":"visual"}"#;
        let post = PubkySocialPost::new(
            envelope_json.to_string(),
            PubkySocialPostKind::Collection,
            None,
            None,
            vec![],
        );
        let id = post.create_id();
        assert!(post.validate(Some(&id), &PUB_CTX).is_ok());
        let envelope: PubkySocialCollectionContent = serde_json::from_str(&post.content).unwrap();
        assert_eq!(envelope.layout, Some(PubkySocialCollectionLayout::Visual));
    }

    #[test]
    fn test_collection_post_unknown_layout_tolerated() {
        // Forward-compat: a layout variant from a future crate version must not
        // invalidate the whole post; it degrades to Unknown.
        let envelope_json = r#"{"name":"X","layout":"spiral"}"#;
        let post = PubkySocialPost::new(
            envelope_json.to_string(),
            PubkySocialPostKind::Collection,
            None,
            None,
            vec![],
        );
        let id = post.create_id();
        assert!(post.validate(Some(&id), &PUB_CTX).is_ok());
        let envelope: PubkySocialCollectionContent = serde_json::from_str(&post.content).unwrap();
        assert_eq!(
            envelope.layout,
            Some(PubkySocialCollectionLayout::Unknown("spiral".into()))
        );
        // written back with its spelling
        assert_eq!(
            serde_json::to_string(&envelope).unwrap(),
            r#"{"name":"X","items":[],"layout":"spiral"}"#
        );
    }

    #[test]
    fn test_collection_envelope_tolerates_extra_fields() {
        // Forward-compat: the envelope intentionally does NOT use deny_unknown_fields,
        // so future minor versions can add fields without breaking older parsers.
        // Use a deliberately-fictional canary field name so this test stays
        // meaningful even after real fields land.
        let envelope_json = r#"{"name":"X","_forward_compat_canary":"future-only"}"#;
        let post = PubkySocialPost::new(
            envelope_json.to_string(),
            PubkySocialPostKind::Collection,
            None,
            None,
            vec![],
        );
        let id = post.create_id();
        assert!(
            post.validate(Some(&id), &PUB_CTX).is_ok(),
            "unknown envelope fields must be tolerated"
        );
    }

    fn item_err(uri: &str) -> String {
        let post = make_collection_post("X", None, Some(vec![uri.to_string()]));
        let id = post.create_id();
        post.validate(Some(&id), &PUB_CTX).unwrap_err()
    }

    #[test]
    fn test_collection_items_are_universal_references() {
        // any resource, any app, any scheme: a collection curates things, not only posts
        for ok in [
            format!("pubky://{TEST_PUBKY_ID}/pub/social/v1/posts/0034A0X7NJ52A"),
            format!("pubky://{TEST_PUBKY_ID}/pub/social/v1/posts/abc-def-ghi-j"),
            format!("pubky://{TEST_PUBKY_ID}/pub/social/v1/posts/0034A0X7NJ52A/extra"),
            format!("pubky://{TEST_PUBKY_ID}/pub/pubky.app/posts/0034A0X7NJ52A"),
            format!("pubky://{TEST_PUBKY_ID}/pub/mapky/v1/reviews/0034A0X7NJ52A"),
            format!("pubky://{TEST_PUBKY_ID}"),
            "https://www.openstreetmap.org/node/1".to_string(),
            "nostr:nevent1abc".to_string(),
            "geo:48.85,2.35".to_string(),
        ] {
            let post = make_collection_post("X", None, Some(vec![ok.clone()]));
            let id = post.create_id();
            assert!(post.validate(Some(&id), &PUB_CTX).is_ok(), "{ok}");
        }
    }

    #[test]
    fn test_collection_items_must_be_canonical() {
        // the gate's reject set, not a parser's repairs: each of these is a distinct spelling
        for bad in [
            format!("pubky://{TEST_PUBKY_ID}/pub/social/v1/posts/0034A0X7NJ52A?foo=bar"),
            format!("pubky://{TEST_PUBKY_ID}/pub/social/v1/posts/0034A0X7NJ52A#frag"),
            format!("pubky://{TEST_PUBKY_ID}/pub/social/v1/posts/0034A0X7NJ52A/"),
            format!("pubky://{TEST_PUBKY_ID}/pub/social/v1/posts/"),
            format!("pubky://user@{TEST_PUBKY_ID}/pub/social/v1/posts/0034A0X7NJ52A"),
            format!("pubky{TEST_PUBKY_ID}/pub/social/v1/posts/0034A0X7NJ52A"),
            format!("pubky://{TEST_PUBKY_ID}/aa/bb/../../pub/social/v1/posts/0034A0X7NJ52A"),
            format!("pubky://{TEST_PUBKY_ID}/pub/social/v1/posts/0034A0X7NJ52A/0034A0X7NJ52A.json"),
            " https://example.com/x".to_string(),
            "NOSTR:X".to_string(),
            "not a uri".to_string(),
            String::new(),
        ] {
            let err = item_err(&bad);
            assert!(err.contains("items[0].uri"), "{bad}: {err}");
        }
    }

    #[test]
    fn test_collection_private_item_follows_the_root_rule() {
        let uri = format!("pubky://{TEST_PUBKY_ID}/priv/social/v1/posts/0034A0X7NJ52A");
        let post = make_collection_post("X", None, Some(vec![uri]));
        let id = post.create_id();
        let err = post.validate(Some(&id), &PUB_CTX).unwrap_err();
        assert!(
            err.contains("Validation Error: items[0].uri must not reference a private object: "),
            "got: {err}"
        );
        let priv_ctx = crate::traits::ValidationCtx {
            root: crate::traits::Root::Priv,
        };
        assert!(post.validate(Some(&id), &priv_ctx).is_ok());
    }

    #[test]
    fn test_collection_item_note_and_unknown_members() {
        let uri = format!("pubky://{TEST_PUBKY_ID}/pub/social/v1/posts/0034A0X7NJ52A");
        let max = VALIDATION_LIMITS.collection_item_note_max_length;
        let ok = format!(
            r#"{{"name":"X","items":[{{"uri":"{uri}","note":"{}","rating":5}}],"future":true}}"#,
            "n".repeat(max)
        );
        let post = PubkySocialPost::new(ok, PubkySocialPostKind::Collection, None, None, vec![]);
        let id = post.create_id();
        assert!(post.validate(Some(&id), &PUB_CTX).is_ok());
        let envelope: PubkySocialCollectionContent = serde_json::from_str(&post.content).unwrap();
        assert_eq!(envelope.items[0].extra["rating"], 5);
        assert_eq!(envelope.extra["future"], true);
        // re-serialized, both unknown members survive
        let back = serde_json::to_string(&envelope).unwrap();
        assert!(
            back.contains(r#""rating":5"#) && back.contains(r#""future":true"#),
            "{back}"
        );
        let long = format!(
            r#"{{"name":"X","items":[{{"uri":"{uri}","note":"{}"}}]}}"#,
            "n".repeat(max + 1)
        );
        let post = PubkySocialPost::new(long, PubkySocialPostKind::Collection, None, None, vec![]);
        let err = post.validate(Some(&id), &PUB_CTX).unwrap_err();
        assert!(err.contains("items[0].note"), "got: {err}");
        // an empty or blank note is an absent one and has exactly one spelling
        for blank in ["", " ", "\u{00A0}"] {
            let content = format!(r#"{{"name":"X","items":[{{"uri":"{uri}","note":"{blank}"}}]}}"#);
            let post =
                PubkySocialPost::new(content, PubkySocialPostKind::Collection, None, None, vec![]);
            let err = post.validate(Some(&id), &PUB_CTX).unwrap_err();
            assert!(err.contains("items[0].note"), "{blank:?}: {err}");
        }
        // an unknown member may not shadow a declared one, in the item or the envelope
        let mut shadow = envelope.clone();
        shadow.items[0].extra.insert("uri".into(), "x".into());
        assert!(validate_collection_envelope(&shadow)
            .unwrap_err()
            .contains("shadow"));
    }

    #[test]
    fn test_collection_post_accepts_canonical_max_length_uri() {
        let uri = format!("pubky://{TEST_PUBKY_ID}/pub/social/v1/posts/0034A0X7NJ52A");
        let post = make_collection_post("X", None, Some(vec![uri]));
        let id = post.create_id();
        assert!(post.validate(Some(&id), &PUB_CTX).is_ok());
    }

    #[test]
    fn test_collection_post_rejects_non_empty_attachments() {
        let post = PubkySocialPost::new(
            collection_envelope_json("X", None, &[]),
            PubkySocialPostKind::Collection,
            None,
            None,
            vec![PubkySocialAttachment::new(
                format!("pubky://{TEST_PUBKY_ID}/pub/social/v1/posts/0034A0X7NJ52A"),
                None,
                None,
            )],
        );
        let id = post.create_id();
        let err = post
            .validate(Some(&id), &PUB_CTX)
            .expect_err("Collection with non-empty post.attachments must be rejected");
        assert!(
            err.contains("post.attachments"),
            "expected anti-misuse error, got: {err}"
        );
    }

    #[test]
    fn test_collection_post_accepts_empty_attachments() {
        let post = PubkySocialPost::new(
            collection_envelope_json("X", None, &[]),
            PubkySocialPostKind::Collection,
            None,
            None,
            vec![],
        );
        let id = post.create_id();
        assert!(post.validate(Some(&id), &PUB_CTX).is_ok());
    }

    #[test]
    fn test_collection_post_accepts_missing_items_field() {
        let envelope_json = r#"{"name":"X"}"#;
        let post = PubkySocialPost::new(
            envelope_json.to_string(),
            PubkySocialPostKind::Collection,
            None,
            None,
            vec![],
        );
        let id = post.create_id();
        assert!(
            post.validate(Some(&id), &PUB_CTX).is_ok(),
            "missing `items` field must deserialize as empty list via serde(default)"
        );
    }

    #[test]
    fn test_collection_post_envelope_at_max_size() {
        // 100 distinct valid pubky post URIs (max-count). Each exactly 94 chars.
        let items: Vec<String> = (0..VALIDATION_LIMITS.collection_items_max_count)
            .map(|i| format!("pubky://{TEST_PUBKY_ID}/pub/social/v1/posts/{:012X}0", i))
            .collect();
        let max_name = "a".repeat(VALIDATION_LIMITS.collection_name_max_length);
        let max_desc = "b".repeat(VALIDATION_LIMITS.collection_description_max_length);
        let post = make_collection_post(&max_name, Some(&max_desc), Some(items));
        assert!(
            post.content.chars().count() < VALIDATION_LIMITS.collection_content_max_length,
            "envelope at max field sizes must fit under collection_content_max_length"
        );
        let id = post.create_id();
        assert!(post.validate(Some(&id), &PUB_CTX).is_ok());
    }
}
