//! The 0.x reader, frozen at the 0.8.0 pin plus the one value 0.8.1 added, so a v0 ingest
//! verdict never moves.
//!
//! Every file under this module is the 0.8.0 source, copied unchanged except for import
//! paths and the stripped JS bindings. Its `url::Url` parsing, its `mime` gate, its
//! `.trim()`/`to_lowercase()` and its error messages ARE the verdict real v0 data was
//! accepted or rejected under, so they are deliberately outside the v1 rules and are never
//! edited, improved or aligned. Indexers read un-migrated data through it forever and the
//! migration transforms read v0 objects through it.
//!
//! One thing is shared rather than copied: [`PubkyId`] is the crate's id type. Two id types
//! would fork every signature a consumer writes, so there is one, and it checks the format,
//! a 52-character z-base32 string.
//!
//! That is a real widening on one axis. 0.8.0 compiled to native also required the decoded
//! bytes to be an Ed25519 curve point; compiled to wasm32 it did not, and this module does
//! not. So a 52-character z-base32 string that decodes cleanly but is not a curve point is
//! accepted here and by v0 on wasm32, and was rejected by v0 on native. It reaches URI hosts
//! through [`try_parse_pubky_path`], the ids of [`PubkyAppFollow`] and [`PubkyAppMute`], and
//! the item hosts of a collection post. Tag and bookmark `uri` fields were never curve
//! checked in v0 at all, they go through `url::Url`. A consumer that holds one of these as a
//! real public key, to verify a signature or to fetch from a homeserver, does the curve check
//! itself; the decode is not one.
//!
//! On another axis it is stricter, on purpose. 0.8.0 decoded with `base32::decode`, which
//! ignores the 4 filler bits of the last character, so a 52-character key ending in anything
//! but `y` or `o` passed, and on native was rewritten to the standard spelling. [`PubkyId`]
//! rejects that key as a URI host, a follow or mute id and a collection item host.
//! Accepting it would give one user several keys, one per spelling.
//!
//! One value was added after the copy: the `cards` feed layout, the only change 0.8.1 made to
//! the data model. 0.8.1 clients store it, and no indexer reads feeds, so no verdict moves.
//!
//! That is the one way this module changes. It may be widened to accept a value a released
//! 0.x client stored. It is never narrowed, and what it stores for an input it already
//! accepted never changes. A widening bumps `TRANSFORM_REV`, adds a row to the reader's
//! corpus with a verdict produced by the client version that introduced the value, and adds
//! a semantic vector for what the value migrates to.

mod common;
mod constants;
mod limits;
mod models;
// `traits` stays a module path: it is the only way in, not a second one.
pub mod traits;
mod uri;

pub use crate::types::PubkyId;
pub use common::validate_crockford_id;
pub use constants::{APP_PATH, PROTOCOL, PUBLIC_PATH};
pub use limits::{ValidationLimits, VALIDATION_LIMITS};
pub use models::blob::PubkyAppBlob;
pub use models::bookmark::PubkyAppBookmark;
pub use models::feed::{
    PubkyAppFeed, PubkyAppFeedConfig, PubkyAppFeedLayout, PubkyAppFeedReach, PubkyAppFeedSort,
};
pub use models::file::{PubkyAppFile, VALID_MIME_TYPES};
pub use models::follow::PubkyAppFollow;
pub use models::last_read::PubkyAppLastRead;
pub use models::mute::PubkyAppMute;
pub use models::post::{
    PubkyAppCollectionContent, PubkyAppCollectionLayout, PubkyAppPost, PubkyAppPostEmbed,
    PubkyAppPostKind,
};
pub use models::tag::PubkyAppTag;
pub use models::user::{PubkyAppUser, PubkyAppUserLink};
pub use models::PubkyAppObject;

/// v0-neutral names for the frozen types the migrator reads through, so no code outside this
/// module spells a pre-rename identifier. Crate-internal: the frozen types have one public path.
/// Only the migrator reads through them, so they exist where it does.
#[cfg(feature = "migrator")]
pub(crate) use models::{
    blob::PubkyAppBlob as V0Blob, bookmark::PubkyAppBookmark as V0Bookmark,
    feed::PubkyAppFeed as V0Feed, file::PubkyAppFile as V0File, follow::PubkyAppFollow as V0Follow,
    mute::PubkyAppMute as V0Mute, post::PubkyAppCollectionContent as V0CollectionContent,
    post::PubkyAppPost as V0Post, post::PubkyAppPostKind as V0PostKind, tag::PubkyAppTag as V0Tag,
    user::PubkyAppUser as V0User,
};
#[cfg(feature = "migrator")]
pub(crate) use traits::Validatable as V0Validatable;
pub use uri::{
    base_uri_builder, blob_uri_builder, bookmark_uri_builder, feed_uri_builder, file_uri_builder,
    follow_uri_builder, is_pubky_scheme, last_read_uri_builder, mute_uri_builder, post_uri_builder,
    tag_uri_builder, try_parse_pubky_path, user_uri_builder, ExtendedParsedUri, ParsedUri,
    PubkyPath, Resource,
};

/// The 0.x id of a tag with this stored `uri` and `label`, as the 0.x writer derived it. Built
/// here so the frozen formula stays the one copy; the stored values are hashed as given.
pub fn tag_id(uri: &str, label: &str) -> String {
    use traits::HashId;
    PubkyAppTag {
        uri: uri.to_string(),
        label: label.to_string(),
        created_at: 0,
    }
    .create_id()
}
