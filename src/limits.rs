//! Validation limits for pubky-social-specs data models.
//!
//! These constants are the single source of truth for client-side validation.
//! Every `*_max_length` counts Unicode code points. Byte-denominated caps are the two object
//! size caps, the media size cap and `bookmark_target_uri_max_bytes`.
//!
//! # Examples
//! Serialize the bundled limits for client consumption.
//! ```
//! use pubky_social_specs::VALIDATION_LIMITS;
//!
//! let limits_json = serde_json::to_value(&VALIDATION_LIMITS).unwrap();
//! assert!(limits_json.is_object());
//! ```

use serde::Serialize;

/// Bundled validation limits for quick consumption.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationLimits {
    /// Maximum media file size in bytes, aligned with the homeserver upload cap.
    pub max_file_size_bytes: usize,
    /// Minimum number of characters for tag labels.
    pub tag_label_min_length: usize,
    /// Maximum number of characters for tag labels.
    pub tag_label_max_length: usize,
    /// Disallowed characters, including common whitespace.
    pub tag_invalid_chars: &'static [char],
    /// Minimum username length in characters.
    pub user_name_min_length: usize,
    /// Maximum username length in characters.
    pub user_name_max_length: usize,
    /// Maximum bio length in characters.
    pub user_bio_max_length: usize,
    /// Maximum length of any image URL field: the profile image and cover images.
    pub image_url_max_length: usize,
    /// Maximum number of profile links.
    pub user_links_max_count: usize,
    /// Maximum link title length in characters.
    pub user_link_title_max_length: usize,
    /// Maximum link URL length in characters.
    pub user_link_url_max_length: usize,
    /// Maximum status length in characters.
    pub user_status_max_length: usize,
    /// Maximum content length of a note and of the media post kinds.
    pub post_note_content_max_length: usize,
    /// Maximum article title length in characters.
    pub article_title_max_length: usize,
    /// Maximum article body length in characters.
    pub article_body_max_length: usize,
    /// Maximum length of the raw article envelope string, checked before it is parsed. The
    /// envelope is JSON-escaped, so a body at its own cap can take twice the code points.
    pub article_content_max_length: usize,
    /// Maximum number of attachments per post.
    pub post_attachments_max_count: usize,
    /// Maximum length of an attachment's alt text.
    pub attachment_alt_max_length: usize,
    /// Maximum length of an attachment's display name.
    pub attachment_name_max_length: usize,
    /// Maximum length of a reference URI field: parent, embed, lock, attachment URIs.
    /// Tag and bookmark targets adopt it with their 1.0 validators.
    pub reference_uri_max_length: usize,
    /// Retired: every media reference runs through the reference gate now. Kept in the
    /// limits asset so its key stays pinned; nothing reads it.
    pub post_allowed_attachment_protocols: &'static [&'static str],
    /// Maximum scalar count (`chars().count()`, not bytes) for the JSON
    /// envelope content of a Collection post. Sized to hold a
    /// max-population envelope (100 canonical post URIs at 94 chars each,
    /// plus name, description, cover_image, JSON overhead, and headroom for
    /// additive future fields).
    pub collection_content_max_length: usize,
    /// Minimum character count for a Collection name. The validator rejects
    /// whitespace-only names separately, then counts the full string length.
    pub collection_name_min_length: usize,
    /// Maximum character count for a Collection name. Leading/trailing
    /// whitespace counts toward the total (the validator does not trim).
    pub collection_name_max_length: usize,
    /// Maximum character count for a Collection description.
    pub collection_description_max_length: usize,
    /// Maximum number of items per Collection.
    pub collection_items_max_count: usize,
    /// Maximum code points of a collection item's `note`, the same bound as an attachment's
    /// `alt`. A single-field bound: the envelope cap (`collection_content_max_length`) binds
    /// first for a long list, as `post_max_bytes` does for attachments.
    pub collection_item_note_max_length: usize,
    /// Maximum number of tags allowed in a feed.
    pub feed_tags_max_count: usize,
    /// Maximum feed name length in characters.
    pub feed_name_max_length: usize,
    /// Maximum length of a feed icon name in characters.
    pub feed_icon_max_length: usize,
    /// Maximum UTF-8 byte length of a bookmark target that still fits the
    /// reversible filename form; longer targets use the overflow form.
    pub bookmark_target_uri_max_bytes: usize,
    /// Maximum length of the optional readable label on a post version leaf
    /// (`{editId}-{label}.json`): chars of `a-z`, `0-9` and `-`. Not an id,
    /// never hashed, validated as written and stored verbatim.
    pub post_slug_max_length: usize,
    /// Maximum serialized size of a post object in bytes, envelopes and unknown
    /// members included. Checked before parsing on read and after building on write.
    pub post_max_bytes: usize,
    /// Maximum serialized size of every other JSON object in bytes (profile, tag,
    /// bookmark, follow, mute, feed). Media bytes have their own cap.
    pub object_max_bytes: usize,
}

/// All validation limits in a single bundle.
pub const VALIDATION_LIMITS: ValidationLimits = ValidationLimits {
    max_file_size_bytes: 100 * (1 << 20), // 100 MB cap aligned with homeserver limits.
    tag_label_min_length: 1,
    tag_label_max_length: 20,
    tag_invalid_chars: &[',', ':', ' ', '\t', '\n', '\r'],
    user_name_min_length: 3,
    user_name_max_length: 50,
    user_bio_max_length: 160,
    image_url_max_length: 300,
    user_links_max_count: 5,
    user_link_title_max_length: 100,
    user_link_url_max_length: 300,
    user_status_max_length: 50,
    post_note_content_max_length: 2000,
    article_title_max_length: 100,
    article_body_max_length: 50_000,
    article_content_max_length: 104_000,
    post_attachments_max_count: 10,
    attachment_alt_max_length: 1000,
    attachment_name_max_length: 255,
    reference_uri_max_length: 1024,
    post_allowed_attachment_protocols: &["pubky", "http", "https"],
    collection_content_max_length: 40_000,
    collection_name_min_length: 1,
    collection_name_max_length: 100,
    collection_description_max_length: 500,
    collection_items_max_count: 100,
    collection_item_note_max_length: 1000,
    feed_tags_max_count: 5,
    feed_name_max_length: 100,
    feed_icon_max_length: 50,
    bookmark_target_uri_max_bytes: 187,
    post_slug_max_length: 64,
    post_max_bytes: 512 * 1024,
    object_max_bytes: 64 * 1024,
};
