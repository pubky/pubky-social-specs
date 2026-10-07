//! Rust types, builders and validation for Pubky social data.
//!
//! [`legacy_v0`] is the 0.x reader, frozen at the 0.8.0 pin so a v0 ingest verdict never
//! moves. It is the 0.8.0 source copied unchanged, and its `url::Url` parsing, its `mime`
//! gate and its engine `.trim()` are the terms real v0 data was accepted or rejected under,
//! so they sit outside the v1 rules on purpose and are never edited. Indexers read
//! un-migrated data through it and the migration transforms read v0 objects through it.

mod canonicalize;
mod common;
mod constants;
pub mod limits;
#[cfg(feature = "migrator")]
pub mod migrate;
mod mime;
mod models;
mod normalize;
#[cfg(all(feature = "surface", not(target_arch = "wasm32")))]
#[doc(hidden)]
pub mod surface;
pub mod traits;
mod types;
mod uri;

// Re-export constants
pub use constants::{
    epoch_segment, namespace_path, social_path, PROTOCOL, SOCIAL_EPOCH, SOCIAL_NAMESPACE, VERSION,
};
// Re-export common utilities
pub use canonicalize::{
    canonicalize_external_uri, canonicalize_pubky_uri, canonicalize_universal,
    canonicalize_web_uri, validate_reference, AllowedSchemes,
};
pub use common::{
    ascii_fold, code_point_len, frozen_trim, is_frozen_whitespace, mint_timestamp_micros,
    validate_hash_id_format, validate_safe_json_int, validate_timestamp_id_format,
    FROZEN_WHITESPACE, MAX_SAFE_JSON_INT,
};
#[doc(inline)]
pub use limits::*;
// Re-export the frozen MIME map
pub use mime::{essence, mime_to_ext, MIME_TO_EXT, STRIP_SET};
// Re-export the one cross-epoch normalization
pub use normalize::{resolve_deref, stable_id, StableId};
pub use traits::{Root, ValidationCtx, ValidationError, PUB_CTX};
// Re-export domain types
pub use models::bookmark::{
    bookmark_filename, bookmark_target, create_bookmark, CreatedBookmark, PubkySocialBookmark,
};
pub use models::deletion::{deletion_paths, Listing};
pub use models::feed::{
    feed_paths, plan_feed_delete, plan_feed_publish, plan_feed_unpublish, FeedDeletePlan,
    FeedPaths, FeedPublishPlan, FeedUnpublishPlan, PubkySocialFeed, PubkySocialFeedConfig,
    PubkySocialFeedLayout, PubkySocialFeedReach, PubkySocialFeedSort,
};
pub use models::file::{CreatedFile, PubkySocialFile, VALID_MIME_TYPES};
pub use models::follow::PubkySocialFollow;
pub use models::mute::PubkySocialMute;
pub use models::post::lifecycle::{
    plan_delete, plan_publish, plan_unpublish, private_media_refs, DeletePlan, PublishPlan,
    UnpublishPlan,
};
pub use models::post::{
    ContentReference, MintedVersion, PostEnvelope, PostKind, PubkySocialArticleContent,
    PubkySocialAttachment, PubkySocialCollectionContent, PubkySocialCollectionItem,
    PubkySocialCollectionLayout, PubkySocialPost, PubkySocialPostKind,
};
pub use models::tag::{sanitize_tag_label, validate_tag_label, PubkySocialTag};
pub use models::user::{PubkySocialUser, PubkySocialUserLink};
pub use models::{ObjectKind, PubkySocialObject};
// The frozen 0.x reader, under its own name; no v0 symbol is re-exported at the root
pub use models::legacy_v0;
pub use types::PubkyId;
#[doc(inline)]
pub use uri::{
    bookmark_uri_builder, feed_uri_builder, file_uri_builder, follow_uri_builder, is_pubky_scheme,
    list_prefix_builder, mute_uri_builder, post_uri_builder, private_list_prefix_builder,
    tag_uri_builder, user_uri_builder, ParsedUri, Resource, Visibility,
};

// The JS surface; its functions share names with the Rust ones they wrap, so it stays a module
#[cfg(target_arch = "wasm32")]
pub mod wasm;
