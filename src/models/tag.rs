use crate::{
    common::timestamp,
    limits::VALIDATION_LIMITS,
    traits::{HasIdPath, HashId, Validatable},
    APP_PATH, PUBLIC_PATH,
};
use serde::{Deserialize, Serialize};
use url::Url;

#[cfg(target_arch = "wasm32")]
use crate::traits::Json;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

#[cfg(feature = "openapi")]
use utoipa::ToSchema;

/// Represents raw homeserver tag with id
/// URI: /pub/pubky.app/tags/:tag_id
///
/// Example URI:
///
/// `/pub/pubky.app/tags/FPB0AM9S93Q3M1GFY1KV09GMQM`
///
/// Where tag_id is Crockford-base32(Blake3("{uri_tagged}:{label}")[:half])
#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
#[derive(Serialize, Deserialize, Default, Debug, Clone)]
#[cfg_attr(feature = "openapi", derive(ToSchema))]
pub struct PubkyAppTag {
    /// The URI of the resource this is a tag on
    #[cfg_attr(target_arch = "wasm32", wasm_bindgen(skip))]
    pub uri: String,
    #[cfg_attr(target_arch = "wasm32", wasm_bindgen(skip))]
    pub label: String,
    pub created_at: i64,
}

impl PubkyAppTag {
    pub fn new(uri: String, label: String) -> Self {
        let created_at = timestamp();
        Self {
            uri,
            label,
            created_at,
        }
        .sanitize()
    }
}

#[cfg(target_arch = "wasm32")]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
impl PubkyAppTag {
    #[cfg_attr(target_arch = "wasm32", wasm_bindgen(js_name = fromJson))]
    pub fn from_json(js_value: &JsValue) -> Result<Self, String> {
        Self::import_json(js_value)
    }

    /// Serialize to JSON for WASM.
    #[cfg_attr(target_arch = "wasm32", wasm_bindgen(js_name = toJson))]
    pub fn to_json(&self) -> Result<JsValue, String> {
        self.export_json()
    }

    /// Getter for `uri`.
    #[cfg_attr(target_arch = "wasm32", wasm_bindgen(getter))]
    pub fn uri(&self) -> String {
        self.uri.clone()
    }

    /// Getter for `label`.
    #[cfg_attr(target_arch = "wasm32", wasm_bindgen(getter))]
    pub fn label(&self) -> String {
        self.label.clone()
    }
}

#[cfg(target_arch = "wasm32")]
impl Json for PubkyAppTag {}

impl HasIdPath for PubkyAppTag {
    const PATH_SEGMENT: &'static str = "tags/";

    fn create_path(id: &str) -> String {
        [PUBLIC_PATH, APP_PATH, Self::PATH_SEGMENT, id].concat()
    }
}

impl HashId for PubkyAppTag {
    /// Tag ID is created based on the hash of the URI tagged and the label used
    fn get_id_data(&self) -> String {
        format!("{}:{}", self.uri, self.label)
    }
}

/// Sanitizes a single tag label by trimming whitespace and converting to lowercase.
/// This function is public so it can be reused by other models that use tags (e.g., Feed).
pub fn sanitize_tag_label(tag: &str) -> String {
    tag.trim().to_lowercase()
}

/// Validates a single tag label according to PubkyAppTag rules.
/// Returns an error message if validation fails, or Ok(()) if valid.
/// This function is public so it can be reused by other models that use tags (e.g., Feed).
pub fn validate_tag_label(tag: &str) -> Result<(), String> {
    let tag_len = tag.chars().count();

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

    // Validate tag chars: disallow whitespace or invalid characters.
    if tag.chars().any(|c| c.is_whitespace()) {
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

impl Validatable for PubkyAppTag {
    fn sanitize(self) -> Self {
        // Sanitize label: trim whitespace and lowercase
        let label = sanitize_tag_label(&self.label);

        // Sanitize URI
        let uri = match Url::parse(&self.uri) {
            // If the URL is valid, reformat it to a sanitized string representation
            Ok(url) => url.to_string(),
            // If the URL is invalid, return as-is for error reporting later
            Err(_) => self.uri.trim().to_string(),
        };

        PubkyAppTag {
            uri,
            label,
            created_at: self.created_at,
        }
    }

    fn validate(&self, id: Option<&str>) -> Result<(), String> {
        // Validate the tag ID
        if let Some(id) = id {
            self.validate_id(id)?;
        }

        // Validate label
        validate_tag_label(&self.label)?;

        // Validate URI format
        Url::parse(&self.uri)
            .map_err(|_| format!("Validation Error: Invalid URI format: {}", self.uri))?;

        // Validate URI length. The message leaves the URI out: it can be any size.
        if self.uri.chars().count() > VALIDATION_LIMITS.tag_uri_max_length {
            return Err(format!(
                "Validation Error: Tag URI exceeds maximum length of {} characters",
                VALIDATION_LIMITS.tag_uri_max_length
            ));
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{post_uri_builder, traits::Validatable, user_uri_builder, APP_PATH};

    #[test]
    fn test_label_id() {
        let post_uri = post_uri_builder("user_id".into(), "post_id".into());
        // Precomputed earlier
        let tag_id = "CBYS8P6VJPHC5XXT4WDW26662W";
        // Create new tag
        let tag = PubkyAppTag {
            uri: post_uri.clone(),
            created_at: 1627849723,
            label: "cool".to_string(),
        };

        let new_tag_id = tag.create_id();
        assert!(!tag_id.is_empty());

        // Check if the tag ID is correct
        assert_eq!(new_tag_id, tag_id);

        let wrong_tag = PubkyAppTag {
            uri: post_uri,
            created_at: 1627849723,
            label: "co0l".to_string(),
        };

        // Assure that the new tag has wrong ID
        assert_ne!(wrong_tag.create_id(), tag_id);
    }

    #[test]
    fn test_create_id() {
        let tag = PubkyAppTag {
            uri: "https://example.com/post/1".to_string(),
            created_at: 1627849723000,
            label: "cool".to_string(),
        };

        let tag_id = tag.create_id();
        println!("Generated Tag ID: {}", tag_id);

        // Assert that the tag ID is of expected length
        // The length depends on your implementation of create_id
        assert!(!tag_id.is_empty());
    }

    #[test]
    fn test_new() {
        let uri = "https://example.com/post/1".to_string();
        let label = "interesting".to_string();
        let tag = PubkyAppTag::new(uri.clone(), label.clone());

        assert_eq!(tag.uri, uri);
        assert_eq!(tag.label, label);
        // Check that created_at is recent
        let now = timestamp();

        assert!(tag.created_at <= now && tag.created_at >= now - 1_000_000); // within 1 second
    }

    #[test]
    fn test_create_path() {
        let post_uri = post_uri_builder(
            "operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo".into(),
            "0032FNCGXE3R0".into(),
        );
        let tag = PubkyAppTag {
            uri: post_uri,
            created_at: 1627849723000,
            label: "cool".to_string(),
        };

        let expected_id = tag.create_id();
        let expected_path = format!("{}{}tags/{}", PUBLIC_PATH, APP_PATH, expected_id);
        let path = PubkyAppTag::create_path(&expected_id);

        assert_eq!(path, expected_path);
    }

    #[test]
    fn test_sanitize() {
        // Test sanitization: lowercase conversion and whitespace trimming
        let post_uri = post_uri_builder("user_id".into(), "0000000000000".into());
        let test_cases = vec![
            ("CoOl", "cool"),
            ("  CoOl  ", "cool"),
            ("UPPERCASE", "uppercase"),
        ];

        for (input, expected) in test_cases {
            let tag = PubkyAppTag {
                uri: post_uri.clone(),
                label: input.to_string(),
                created_at: 1627849723000,
            };
            let sanitized_tag = tag.sanitize();
            assert_eq!(sanitized_tag.label, expected, "Failed for input: {}", input);
        }
    }

    #[test]
    fn test_validate() {
        let post_uri = post_uri_builder("user_id".into(), "0000000000000".into());
        let tag = PubkyAppTag {
            uri: post_uri,
            label: "cool".to_string(),
            created_at: 1627849723000,
        };

        let id = tag.create_id();
        let result = tag.validate(Some(&id));
        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_invalid_label_length() {
        let post_uri = post_uri_builder("user_id".into(), "0000000000000".into());
        let tag = PubkyAppTag {
            uri: post_uri,
            label: "a".repeat(VALIDATION_LIMITS.tag_label_max_length + 1),
            created_at: 1627849723000,
        };

        let id = tag.create_id();
        let result = tag.validate(Some(&id));
        assert!(result.is_err());
        let error_msg = result.unwrap_err();
        assert!(
            error_msg.contains("exceeds maximum length"),
            "Expected error about maximum length, got: {}",
            error_msg
        );
    }

    #[test]
    fn test_validate_invalid_id() {
        let post_uri = post_uri_builder("user_id".into(), "0000000000000".into());
        let tag = PubkyAppTag {
            uri: post_uri,
            label: "cool".to_string(),
            created_at: 1627849723000,
        };

        let invalid_id = "INVALIDID";
        let result = tag.validate(Some(invalid_id));
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_invalid_char() {
        let post_uri = post_uri_builder("user_id".into(), "0000000000000".into());
        let tag = PubkyAppTag {
            uri: post_uri,
            label: format!("invalidchar{}", VALIDATION_LIMITS.tag_invalid_chars[0]),
            created_at: 1627849723000,
        };

        let id = tag.create_id();
        let result = tag.validate(Some(&id));
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_invalid_uri() {
        let tag = PubkyAppTag {
            uri: "user_id/pub/pubky.app/posts/post_id".into(),
            label: "cool".to_string(),
            created_at: 1627849723000,
        };

        let id = tag.create_id();
        let result = tag.validate(Some(&id));
        assert!(result
            .unwrap_err()
            .starts_with("Validation Error: Invalid URI format"));
    }

    #[test]
    fn test_try_from_valid() {
        let user_uri = user_uri_builder("user_pubky_id".into());
        let tag_label = "CoolTag".to_string();
        let tag_json = format!(
            r#"
            {{
                "uri": "{user_uri}",
                "label": "{tag_label}",
                "created_at": 1627849723000
            }}
        "#
        );

        let id = PubkyAppTag::new(user_uri.clone(), tag_label.clone()).create_id();

        let blob = tag_json.as_bytes();
        let sanitized_validated_tag = <PubkyAppTag as Validatable>::try_from(blob, &id).unwrap();
        assert_eq!(sanitized_validated_tag.uri, user_uri);
        assert_eq!(sanitized_validated_tag.label, "cooltag");
    }

    #[test]
    fn test_try_from_invalid_uri() {
        let tag_json = r#"
        {
            "uri": "invalid_uri",
            "label": "CoolTag",
            "created_at": 1627849723000
        }
        "#;

        let id = "D2DV4EZDA03Q3KCRMVGMDYZ8C0";
        let blob = tag_json.as_bytes();
        let result = <PubkyAppTag as Validatable>::try_from(blob, id);
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err().to_string(),
            "Validation Error: Invalid URI format: invalid_uri"
        );
    }

    #[test]
    fn test_whitespace_handling() {
        let post_uri = post_uri_builder("user_id".into(), "post_id".into());

        // Leading/trailing whitespace should be trimmed and pass validation
        let trim_cases = vec![" cool", "cool ", "cool\n", "  cool  "];
        for label in trim_cases {
            let tag = PubkyAppTag {
                uri: post_uri.clone(),
                created_at: 1627849723,
                label: label.to_string(),
            };
            let sanitized = tag.sanitize();
            assert_eq!(sanitized.label, "cool", "Failed for: {}", label);
            assert!(
                sanitized.validate(None).is_ok(),
                "Should pass after trimming: {}",
                label
            );
        }

        // Internal whitespace cannot be trimmed and should fail validation
        let tag = PubkyAppTag {
            uri: post_uri,
            created_at: 1627849723,
            label: "   co ol ".to_string(),
        };
        let sanitized = tag.sanitize();
        assert_eq!(sanitized.label, "co ol"); // Only leading/trailing whitespace trimmed
        assert!(sanitized.validate(None).is_err()); // Internal space should fail validation
    }

    #[test]
    fn test_unicode_tag_labels() {
        let post_uri = post_uri_builder("user_id".into(), "post_id".into());

        // Unicode tags should work (emoji, non-latin scripts)
        let unicode_cases = vec![
            ("比特币", "比特币"),             // Chinese characters
            ("ビットコイン", "ビットコイン"), // Japanese katakana
            ("🚀", "🚀"),                     // Single emoji
            ("café", "café"),                 // Accented characters
        ];

        for (input, expected) in unicode_cases {
            let tag = PubkyAppTag::new(post_uri.clone(), input.to_string());
            assert_eq!(tag.label, expected, "Failed for input: {}", input);
            assert!(
                tag.validate(None).is_ok(),
                "Should accept Unicode tag: {}",
                input
            );
        }

        // Test max length with multi-byte characters
        // tag_label_max_length is 20, so 20 emoji should pass
        let max_emoji_tag: String = "🔥".repeat(VALIDATION_LIMITS.tag_label_max_length);
        assert_eq!(
            max_emoji_tag.chars().count(),
            VALIDATION_LIMITS.tag_label_max_length
        );
        let tag = PubkyAppTag::new(post_uri.clone(), max_emoji_tag);
        assert!(
            tag.validate(None).is_ok(),
            "Should accept {} emoji characters as tag",
            VALIDATION_LIMITS.tag_label_max_length
        );
    }

    #[test]
    fn test_uri_max_length() {
        let max = VALIDATION_LIMITS.tag_uri_max_length;
        let base = "https://example.com/";
        let at_max = format!("{base}{}", "a".repeat(max - base.len()));
        assert_eq!(at_max.chars().count(), max);

        let tag = PubkyAppTag::new(at_max.clone(), "cool".to_string());
        assert!(tag.validate(None).is_ok(), "a URI at the cap is accepted");

        let tag = PubkyAppTag::new(format!("{at_max}a"), "cool".to_string());
        assert_eq!(
            tag.validate(None).unwrap_err(),
            format!("Validation Error: Tag URI exceeds maximum length of {max} characters")
        );
    }

    #[test]
    fn test_uri_length_is_counted_after_sanitization() {
        let max = VALIDATION_LIMITS.tag_uri_max_length;
        // Each `é` is one character as written and six (`%C3%A9`) once sanitized.
        let uri = format!("https://example.com/{}", "é".repeat(max / 2));
        assert!(uri.chars().count() < max);

        let tag = PubkyAppTag::new(uri, "cool".to_string());
        assert!(tag.uri.chars().count() > max);
        assert!(tag.validate(None).is_err());
    }
}
