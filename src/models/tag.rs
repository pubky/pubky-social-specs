use crate::canonicalize::{checked, AllowedSchemes};
use crate::constants::social_path;
use crate::traits::{Root, ValidationCtx, ValidationError, PUB_CTX};
use crate::{
    common::{
        ascii_fold, check_extra, code_point_len, frozen_trim, is_frozen_whitespace, timestamp,
        validate_safe_json_int,
    },
    limits::VALIDATION_LIMITS,
    traits::{HasIdPath, HashId, Validatable},
};
use serde::{Deserialize, Serialize};

#[cfg(feature = "openapi")]
use utoipa::ToSchema;

/// Represents raw homeserver tag with id
/// URI: /pub/social/v1/tags/:tag_id
///
/// Example URI:
///
/// `/pub/social/v1/tags/FPB0AM9S93Q3M1GFY1KV09GMQM`
///
/// Where tag_id is `Crockford-base32(Blake3("{uri_tagged}:{label}")[:half])`
#[derive(Serialize, Deserialize, Default, Debug, Clone)]
#[cfg_attr(feature = "openapi", derive(ToSchema))]
pub struct PubkySocialTag {
    /// The URI of the resource this is a tag on
    pub uri: String,
    pub label: String,
    pub created_at: i64,
    /// Unknown members, preserved on rewrite; see the module contract in `models/mod.rs`.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl PubkySocialTag {
    pub fn new(uri: String, label: String) -> Self {
        let created_at = timestamp();
        // The builder folds; ingest never does
        Self {
            uri,
            label: sanitize_tag_label(&label),
            created_at,
            extra: Default::default(),
        }
    }
}

impl HasIdPath for PubkySocialTag {
    const ROOT: Root = Root::Pub;
    const PATH_SEGMENT: &'static str = "tags/";

    fn create_path(id: &str) -> String {
        social_path(Self::ROOT, &format!("{}{id}.json", Self::PATH_SEGMENT))
    }
}

impl HashId for PubkySocialTag {
    /// Identity input: "{uri}:{label}". The stored uri is already canonical (validation
    /// requires the fixed point), so nothing is re-derived here. Unambiguous only because the
    /// label rejects ':'; that restriction may never be lifted while this id format stands.
    /// Not migration-invariant for social targets (the embedded path prefix changes across
    /// epochs): indexers dedup by normalized target, never by raw HashId.
    fn get_id_data(&self) -> String {
        format!("{}:{}", self.uri, self.label)
    }
}

/// Frozen-trim + ASCII-only lowercase, applied by builders; a stored label must already be its
/// own fold. Full-Unicode lowercasing is not version-pinnable across engines and would fork
/// content-addressed ids; non-Latin labels are stored case-sensitively. Shared with the feed
/// config.
pub fn sanitize_tag_label(tag: &str) -> String {
    ascii_fold(frozen_trim(tag))
}

/// Validates a single tag label according to PubkySocialTag rules.
/// Returns an error message if validation fails, or Ok(()) if valid.
/// This function is public so it can be reused by other models that use tags (e.g., Feed).
pub fn validate_tag_label(tag: &str) -> Result<(), String> {
    let tag_len = code_point_len(tag);

    // Validate tag length
    if tag_len > VALIDATION_LIMITS.tag_label_max_length {
        return Err(format!(
            "Validation Error: Tag '{}' exceeds maximum length of {} characters",
            tag, VALIDATION_LIMITS.tag_label_max_length
        ));
    }
    if tag_len < VALIDATION_LIMITS.tag_label_min_length {
        return Err(format!(
            "Validation Error: Tag '{}' is shorter than minimum length of {} character",
            tag, VALIDATION_LIMITS.tag_label_min_length
        ));
    }

    // The frozen whitespace set, not the engine's notion of whitespace
    if tag.chars().any(is_frozen_whitespace) {
        return Err(format!(
            "Validation Error: Tag '{}' contains whitespace characters",
            tag
        ));
    }

    if let Some(c) = tag
        .chars()
        .find(|c| VALIDATION_LIMITS.tag_invalid_chars.contains(c))
    {
        return Err(format!(
            "Validation Error: Tag '{}' contains invalid character: {}",
            tag, c
        ));
    }

    Ok(())
}

impl Validatable for PubkySocialTag {
    fn validate_fields(
        &self,
        id: Option<&str>,
        _ctx: &ValidationCtx,
    ) -> Result<(), ValidationError> {
        if let Some(id) = id {
            self.validate_id(id)?;
        }
        check_extra(&self.extra, &["uri", "label", "created_at"])?;
        if self.label != sanitize_tag_label(&self.label) {
            return Err(format!(
                "Validation Error: Tag '{}' must be stored folded (trimmed, ASCII lowercase)",
                self.label
            ));
        }
        validate_tag_label(&self.label)?;
        // Any public resource: a social object, another app's, or an external URI. Tags are
        // public objects, so a private target fails the root rule whatever ctx says.
        checked(
            "uri",
            &self.uri,
            AllowedSchemes::Universal,
            VALIDATION_LIMITS.reference_uri_max_length,
            &PUB_CTX,
            None,
        )?;
        validate_safe_json_int(self.created_at)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::traits::Validatable;
    use crate::{post_uri_builder, user_uri_builder};

    const PK: &str = "operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo";
    const TS: &str = "0032FNCGXE3R0";

    fn tag(uri: &str, label: &str) -> PubkySocialTag {
        PubkySocialTag {
            uri: uri.into(),
            label: label.into(),
            created_at: 1627849723000,
            extra: Default::default(),
        }
    }

    fn post_uri() -> String {
        post_uri_builder(PK.into(), TS.into())
    }

    fn validate(t: &PubkySocialTag) -> Result<(), String> {
        t.validate(Some(&t.create_id()), &PUB_CTX)
    }

    #[test]
    fn test_label_id_kat() {
        // Pinned: blake3("{uri}:cool")[..16] in Crockford, over the v1 post reference
        let t = tag(&post_uri(), "cool");
        assert_eq!(t.create_id(), "ES26HNPH6M0CYFFW65PCRC107W");
        assert_ne!(tag(&post_uri(), "co0l").create_id(), t.create_id());
    }

    #[test]
    fn test_id_reads_the_stored_uri_and_the_label_is_the_only_separator() {
        let t = tag(&post_uri(), "cool");
        assert_eq!(t.get_id_data(), format!("{}:cool", post_uri()));
        // ':' in a label would make "{uri}:{label}" ambiguous from the right
        assert!(validate(&tag(&post_uri(), "a:b")).is_err());
        assert!(VALIDATION_LIMITS.tag_invalid_chars.contains(&':'));
    }

    #[test]
    fn test_uri_is_a_fixed_point_of_the_universal_gate() {
        for ok in [
            post_uri(),
            user_uri_builder(PK.into()),
            "https://example.com/x".into(),
            "ipfs://bafy".into(),
            "nostr:nevent1abc".into(),
            format!("pubky://{PK}/pub/pubky.app/posts/{TS}"),
        ] {
            assert!(validate(&tag(&ok, "cool")).is_ok(), "{ok}");
        }
        for bad in [
            format!("pubky{PK}/pub/social/v1/posts/{TS}"),
            " https://example.com/x".into(),
            "NOSTR:X".into(),
            "invalid_uri".into(),
            format!("pubky://{PK}/priv/social/v1/posts/{TS}"),
            format!("pubky://{PK}/pub/social/v1/posts/{TS}/{TS}.json"),
            format!(
                "nostr:{}",
                "a".repeat(VALIDATION_LIMITS.reference_uri_max_length)
            ),
        ] {
            let e = validate(&tag(&bad, "cool")).unwrap_err();
            assert!(e.starts_with("Validation Error: uri"), "{bad}: {e}");
        }
    }

    #[test]
    fn test_one_target_one_id_and_the_epoch_fork() {
        // the short form is not stored, so it never mints a second id for the same target
        let short = format!("pubky{PK}/pub/social/v1/posts/{TS}");
        assert!(validate(&tag(&short, "cool")).is_err());
        // a social target spelled in two epochs is two ids; the indexer collapses them by
        // normalized target
        assert_ne!(
            tag(&format!("pubky://{PK}/pub/pubky.app/posts/{TS}"), "cool").create_id(),
            tag(&post_uri(), "cool").create_id()
        );
    }

    #[test]
    fn test_label_folding() {
        for (input, want) in [
            ("CoOl", "cool"),
            ("  CoOl  ", "cool"),
            ("\u{3000}tag\u{00A0}", "tag"),
            ("İX", "İx"),
            ("\u{200B}a", "\u{200B}a"),
        ] {
            assert_eq!(sanitize_tag_label(input), want, "{input:?}");
        }
        assert!(validate(&tag(&post_uri(), "\u{200B}a")).is_ok());
        // a stored label is its own fold: the builder folds, ingest never rewrites
        for unfolded in ["CoOl", " cool", "cool "] {
            let e = validate(&tag(&post_uri(), unfolded)).unwrap_err();
            assert!(e.contains("stored folded"), "{unfolded:?}: {e}");
        }
    }

    #[test]
    fn test_label_rules_count_code_points_and_the_frozen_set() {
        let max = VALIDATION_LIMITS.tag_label_max_length;
        assert!(validate(&tag(&post_uri(), &"🦀".repeat(max))).is_ok());
        let e = validate(&tag(&post_uri(), &"🦀".repeat(max + 1))).unwrap_err();
        assert!(e.contains("exceeds maximum length"), "{e}");
        assert!(validate(&tag(&post_uri(), "")).is_err());
        let e = validate(&tag(&post_uri(), "a\u{00A0}b")).unwrap_err();
        assert!(e.contains("whitespace"), "{e}");
        for c in VALIDATION_LIMITS.tag_invalid_chars {
            assert!(
                validate(&tag(&post_uri(), &format!("a{c}b"))).is_err(),
                "{c:?}"
            );
        }
    }

    #[test]
    fn test_created_at_is_json_safe() {
        let mut t = tag(&post_uri(), "cool");
        t.created_at = i64::MAX;
        assert!(validate(&t).unwrap_err().contains("JSON-safe"));
    }

    #[test]
    fn test_new_folds_the_label_and_keeps_the_uri() {
        let t = PubkySocialTag::new("https://example.com/post/1".into(), "  Interesting ".into());
        assert_eq!(t.uri, "https://example.com/post/1");
        assert_eq!(t.label, "interesting");
        let now = timestamp();
        assert!(t.created_at <= now && t.created_at >= now - 1_000_000);
    }

    #[test]
    fn test_create_path() {
        let id = tag(&post_uri(), "cool").create_id();
        assert_eq!(
            PubkySocialTag::create_path(&id),
            format!("/pub/social/v1/tags/{id}.json")
        );
    }

    #[test]
    fn test_try_from_validates_and_preserves() {
        let user_uri = user_uri_builder(PK.into());
        let blob = format!(
            r#"{{"uri":"{user_uri}","label":"cooltag","created_at":1627849723000,"ext":{{"badge":1}}}}"#
        );
        // the builder folds, so its id is the id of the folded blob
        let id = PubkySocialTag::new(user_uri.clone(), "CoolTag".into()).create_id();
        let t = <PubkySocialTag as Validatable>::try_from(blob.as_bytes(), &id, &PUB_CTX).unwrap();
        assert_eq!(t.uri, user_uri);
        assert_eq!(t.label, "cooltag");
        assert_eq!(t.extra["ext"]["badge"], 1);
        assert!(serde_json::to_string(&t)
            .unwrap()
            .contains(r#""ext":{"badge":1}"#));
        assert!(validate(&t).is_ok());
        // an unfolded label on the wire is rejected, never repaired
        let unfolded = blob.replace("cooltag", "CoolTag");
        let e = <PubkySocialTag as Validatable>::try_from(unfolded.as_bytes(), &id, &PUB_CTX)
            .unwrap_err();
        assert!(
            e.contains("Validation Error: Invalid ID") || e.contains("stored folded"),
            "{e}"
        );
        let mut shadow = t.clone();
        shadow.extra.insert("label".into(), "x".into());
        assert!(validate(&shadow).unwrap_err().contains("shadow"));
    }

    #[test]
    fn test_try_from_invalid_uri_and_id() {
        // The pinned id is blake3("invalid_uri:cooltag"), so the id check passes and the uri
        // verdict is the one reported
        let blob = br#"{"uri":"invalid_uri","label":"cooltag","created_at":1627849723000}"#;
        let e =
            <PubkySocialTag as Validatable>::try_from(blob, "D2DV4EZDA03Q3KCRMVGMDYZ8C0", &PUB_CTX)
                .unwrap_err();
        assert!(
            e.starts_with("Validation Error: uri must be a canonical URI"),
            "{e}"
        );
        assert!(tag(&post_uri(), "cool")
            .validate(Some("INVALIDID"), &PUB_CTX)
            .is_err());
    }

    #[test]
    fn test_in_memory_size_cap() {
        // Every field passes on its own; only the total cap can reject
        let mut t = tag(&post_uri(), "cool");
        t.extra
            .insert("ext".into(), "a".repeat(PubkySocialTag::MAX_BYTES).into());
        assert!(t.validate_fields(None, &PUB_CTX).is_ok());
        assert!(t.validate(None, &PUB_CTX).unwrap_err().contains("exceeds"));
    }
}
