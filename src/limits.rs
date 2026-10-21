//! Validation limits for pubky-social-specs data models.
//!
//! These constants are the single source of truth for client-side validation.
//! Every `*_max_length` counts Unicode code points. Byte-denominated caps are the two object
//! size caps, the media size cap and `bookmark_target_uri_max_bytes`. The 1.1 kinds add caps
//! in other units, each named by its suffix: `_seconds`, `_days`, `_years`, `_metres`,
//! `_people`, `_occurrences`, `_periods`, `_digits` and `_half_stars`.
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

    // ---- v1.1: events ----
    /// Maximum event title length in code points, the article title cap.
    pub event_title_max_length: usize,
    /// Maximum event description length in code points, the article body cap.
    pub event_description_max_length: usize,
    /// Maximum length of the raw event envelope string, checked before it is parsed. Twice the
    /// description, as the article bound is, plus room for the lists at their caps.
    pub event_content_max_length: usize,
    /// Maximum length of an IANA time zone name in code points (`timeZone`).
    pub event_time_zone_max_length: usize,
    /// Maximum `duration` of an event or an availability block, in seconds: one leap year.
    pub event_duration_max_seconds: u64,
    /// Maximum number of `locations` on an event.
    pub event_locations_max_count: usize,
    /// Maximum length of a location's `name` in code points.
    pub event_location_name_max_length: usize,
    /// Maximum number of `links` on an event.
    pub event_links_max_count: usize,
    /// Maximum length of a link's `name` in code points.
    pub event_link_name_max_length: usize,
    /// Maximum length of a link's `url` in code points, the profile link cap.
    pub event_link_url_max_length: usize,
    /// Maximum `attendance.capacity`, in people.
    pub event_capacity_max_people: u64,
    /// Maximum number of `recurrenceRules`: one, as the design says.
    pub event_recurrence_rules_max_count: usize,
    /// Maximum `count` of a recurrence rule, in occurrences; the generator stops there too.
    pub event_recurrence_max_occurrences: u64,
    /// Maximum span of a recurrence rule's `until` after `start`, in calendar years; the
    /// generator stops there too.
    pub event_recurrence_max_span_years: u64,
    /// Maximum `interval` of a recurrence rule, in periods of its frequency.
    pub event_recurrence_interval_max_periods: u64,
    /// Maximum number of entries in each `by*` list of a recurrence rule.
    pub event_recurrence_by_max_count: usize,
    /// Maximum number of `excludedDates` on an event or an availability block.
    pub event_excluded_dates_max_count: usize,
    /// Maximum `guests` on an rsvp, in people.
    pub rsvp_guests_max_people: u64,
    /// Maximum length of an rsvp `note` in code points, the note content cap.
    pub rsvp_note_max_length: usize,
    /// Maximum length of the raw rsvp envelope string, checked before it is parsed.
    pub rsvp_content_max_length: usize,
    /// Maximum `horizonDays` of an availability, in days: one leap year.
    pub availability_horizon_max_days: u64,
    /// Maximum number of blocks in each of `available` and `busy`.
    pub availability_blocks_max_count: usize,
    /// Maximum length of an available block's `title` in code points.
    pub availability_block_title_max_length: usize,
    /// Maximum length of the raw availability envelope string, checked before it is parsed.
    pub availability_content_max_length: usize,
    /// Minimum `rating`, in half stars: one half star.
    pub rating_min_half_stars: u64,
    /// Maximum `rating`, in half stars: five stars.
    pub rating_max_half_stars: u64,
    /// Maximum length of a rating's `text` in code points, the note content cap.
    pub rating_text_max_length: usize,
    /// Maximum length of the raw rating envelope string, checked before it is parsed.
    pub rating_content_max_length: usize,

    // ---- v1.1: maps ----
    /// Maximum number of fraction digits of a `geo:` coordinate, about a metre.
    pub geo_fraction_max_digits: usize,
    /// Maximum route name length in code points.
    pub route_name_max_length: usize,
    /// Maximum route description length in code points.
    pub route_description_max_length: usize,
    /// Minimum number of `waypoints` on a route: a start and an end.
    pub route_waypoints_min_count: usize,
    /// Maximum number of `waypoints` on a route.
    pub route_waypoints_max_count: usize,
    /// Maximum length of a waypoint's `name` in code points.
    pub route_waypoint_name_max_length: usize,
    /// Maximum length of the encoded polyline in code points.
    pub route_polyline_max_length: usize,
    /// Maximum length of the polyline's `engine` and `profile` labels in code points.
    pub route_label_max_length: usize,
    /// Maximum `distance_m` of a route, in metres.
    pub route_distance_max_metres: u64,
    /// Maximum `duration_s` of a route, in seconds: ten years.
    pub route_duration_max_seconds: u64,
    /// Maximum `elevation_gain_m` and `elevation_loss_m`, in metres.
    pub route_elevation_max_metres: u64,
    /// Maximum number of `steps` on a route.
    pub route_steps_max_count: usize,
    /// Maximum length of a step's `instruction` in code points.
    pub route_step_instruction_max_length: usize,
    /// Maximum length of the raw route envelope string, checked before it is parsed.
    pub route_content_max_length: usize,
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
    event_title_max_length: 100,
    event_description_max_length: 50_000,
    event_content_max_length: 150_000,
    event_time_zone_max_length: 64,
    event_duration_max_seconds: 366 * 24 * 60 * 60,
    event_locations_max_count: 10,
    event_location_name_max_length: 100,
    event_links_max_count: 10,
    event_link_name_max_length: 100,
    event_link_url_max_length: 300,
    event_capacity_max_people: 1_000_000,
    event_recurrence_rules_max_count: 1,
    event_recurrence_max_occurrences: 1_000,
    event_recurrence_max_span_years: 3,
    event_recurrence_interval_max_periods: 1_000,
    event_recurrence_by_max_count: 31,
    event_excluded_dates_max_count: 100,
    rsvp_guests_max_people: 100,
    rsvp_note_max_length: 2000,
    rsvp_content_max_length: 5_000,
    availability_horizon_max_days: 366,
    availability_blocks_max_count: 100,
    availability_block_title_max_length: 100,
    availability_content_max_length: 100_000,
    rating_min_half_stars: 1,
    rating_max_half_stars: 10,
    rating_text_max_length: 2000,
    rating_content_max_length: 5_000,
    geo_fraction_max_digits: 5,
    route_name_max_length: 100,
    route_description_max_length: 2000,
    route_waypoints_min_count: 2,
    route_waypoints_max_count: 100,
    route_waypoint_name_max_length: 100,
    route_polyline_max_length: 100_000,
    route_label_max_length: 50,
    route_distance_max_metres: 100_000_000,
    route_duration_max_seconds: 10 * 365 * 24 * 60 * 60,
    route_elevation_max_metres: 100_000,
    route_steps_max_count: 500,
    route_step_instruction_max_length: 200,
    route_content_max_length: 400_000,
};
