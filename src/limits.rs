//! Validation limits for pubky-app-specs data models.
//!
//! These constants are the single source of truth for client-side validation.
//!
//! # Examples
//! Serialize the bundled limits for client consumption.
//! ```
//! use pubky_app_specs::VALIDATION_LIMITS;
//!
//! let limits_json = serde_json::to_value(&VALIDATION_LIMITS).unwrap();
//! assert!(limits_json.is_object());
//! ```

use serde::Serialize;

/// Bundled validation limits for quick consumption.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationLimits {
    /// Maximum blob/file size in bytes.
    ///
    /// Chosen to cap user storage per upload and align with homeserver limits.
    pub max_blob_size_bytes: usize,
    /// Maximum file size in bytes.
    ///
    /// Kept in sync with blob validation since files are blob-backed.
    pub max_file_size_bytes: usize,
    /// Minimum number of characters for tag labels.
    pub tag_label_min_length: usize,
    /// Maximum number of characters for tag labels.
    pub tag_label_max_length: usize,
    /// Disallowed characters, including common whitespace.
    pub tag_invalid_chars: &'static [char],
    /// Maximum tag URI length in characters, counted on the sanitized URI.
    ///
    /// The cap the 1.x tag adopts for its target, so a tag that passes here also migrates.
    pub tag_uri_max_length: usize,
    /// Minimum username length in characters.
    pub user_name_min_length: usize,
    /// Maximum username length in characters.
    pub user_name_max_length: usize,
    /// Maximum bio length in characters.
    pub user_bio_max_length: usize,
    /// Maximum image URL length in characters.
    pub user_image_url_max_length: usize,
    /// Maximum number of profile links.
    pub user_links_max_count: usize,
    /// Maximum link title length in characters.
    pub user_link_title_max_length: usize,
    /// Maximum link URL length in characters.
    pub user_link_url_max_length: usize,
    /// Maximum status length in characters.
    pub user_status_max_length: usize,
    /// Maximum character count for short posts.
    pub post_short_content_max_length: usize,
    /// Maximum character count for long posts.
    pub post_long_content_max_length: usize,
    /// Maximum number of attachments per post.
    pub post_attachments_max_count: usize,
    /// Maximum length for attachment URLs.
    pub post_attachment_url_max_length: usize,
    /// Allowed protocols for attachment URLs.
    pub post_allowed_attachment_protocols: &'static [&'static str],
    /// Maximum scalar count (`chars().count()`, not bytes) for the JSON
    /// envelope content of a Collection post. Sized to hold a
    /// max-population envelope (100 canonical post URIs at 94 chars each,
    /// plus name, description, cover_image (up to 200 chars), JSON
    /// overhead, and headroom for additive future fields).
    pub collection_content_max_length: usize,
    /// Minimum character count for a Collection name. The validator rejects
    /// whitespace-only names separately, then counts the full string length.
    pub collection_name_min_length: usize,
    /// Maximum character count for a Collection name. Leading/trailing
    /// whitespace counts toward the total (the validator does not trim).
    pub collection_name_max_length: usize,
    /// Maximum character count for a Collection description.
    pub collection_description_max_length: usize,
    /// Maximum number of items (attachment URIs) per Collection.
    pub collection_items_max_count: usize,
    /// Minimum file name length in characters.
    pub file_name_min_length: usize,
    /// Maximum file name length in characters.
    pub file_name_max_length: usize,
    /// Maximum file src length in characters.
    pub file_src_max_length: usize,
    /// Maximum number of tags allowed in a feed.
    pub feed_tags_max_count: usize,
    /// Maximum length of a feed icon name in characters.
    pub feed_icon_max_length: usize,
}

/// All validation limits in a single bundle.
pub const VALIDATION_LIMITS: ValidationLimits = ValidationLimits {
    max_blob_size_bytes: 100 * (1 << 20), // 100 MB cap aligned with homeserver limits.
    max_file_size_bytes: 100 * (1 << 20), // Kept in sync with blob validation.
    tag_label_min_length: 1,
    tag_label_max_length: 20,
    tag_invalid_chars: &[',', ':', ' ', '\t', '\n', '\r'],
    tag_uri_max_length: 1024,
    user_name_min_length: 3,
    user_name_max_length: 50,
    user_bio_max_length: 160,
    user_image_url_max_length: 300,
    user_links_max_count: 5,
    user_link_title_max_length: 100,
    user_link_url_max_length: 300,
    user_status_max_length: 50,
    post_short_content_max_length: 2000,
    post_long_content_max_length: 50_000,
    post_attachments_max_count: 10,
    post_attachment_url_max_length: 200,
    post_allowed_attachment_protocols: &["pubky", "http", "https"],
    collection_content_max_length: 40_000,
    collection_name_min_length: 1,
    collection_name_max_length: 100,
    collection_description_max_length: 500,
    collection_items_max_count: 100,
    file_name_min_length: 1,
    file_name_max_length: 255,
    file_src_max_length: 1024,
    feed_tags_max_count: 5,
    feed_icon_max_length: 50,
};
