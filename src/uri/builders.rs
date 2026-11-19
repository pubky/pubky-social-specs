use crate::{
    constants::{social_path, PROTOCOL},
    traits::Root,
    traits::{HasIdPath, HasPath},
    PubkySocialBookmark, PubkySocialFeed, PubkySocialFile, PubkySocialFollow, PubkySocialMute,
    PubkySocialPost, PubkySocialTag, PubkySocialUser,
};

/// The public v1 LIST prefix, "pubky://<user_id>/pub/social/v1/". NOT a URI: the trailing
/// slash is deliberate and the parser rejects it; use it only as a LIST or capability prefix.
pub fn list_prefix_builder(user_id: String) -> String {
    let prefix = social_path(Root::Pub, "");
    [PROTOCOL, &user_id, &prefix].concat()
}

/// The private v1 LIST prefix, "pubky://<user_id>/priv/social/v1/", where mutes live. A
/// capability scoped to the public prefix alone cannot read or write them.
pub fn private_list_prefix_builder(user_id: String) -> String {
    let prefix = social_path(Root::Priv, "");
    [PROTOCOL, &user_id, &prefix].concat()
}

/// Builds an User URI of the form "pubky://<user_pubky_id>/pub/social/v1/profile.json"
pub fn user_uri_builder(user_id: String) -> String {
    let user_path = PubkySocialUser::create_path();
    [PROTOCOL, &user_id, &user_path].concat()
}

/// Builds the versionless post REFERENCE, "pubky://<author_id>/pub/social/v1/posts/<post_id>":
/// the spelling every reference field uses. The storage path of a version comes from
/// `PubkySocialPost::create_path`.
pub fn post_uri_builder(author_id: String, post_id: String) -> String {
    let leaf = format!("{}{post_id}", PubkySocialPost::PATH_SEGMENT);
    let post_path = social_path(Root::Pub, &leaf);
    [PROTOCOL, &author_id, &post_path].concat()
}

/// Builds a Follow URI of the form "pubky://<author_id>/pub/social/v1/follows/<follow_id>.json\"
pub fn follow_uri_builder(author_id: String, follow_id: String) -> String {
    let follow_path = PubkySocialFollow::create_path(&follow_id);
    [PROTOCOL, &author_id, &follow_path].concat()
}

/// Builds a Mute URI of the form "pubky://<author_id>/priv/social/v1/mutes/<mute_id>.json\"
pub fn mute_uri_builder(author_id: String, mute_id: String) -> String {
    let mute_path = PubkySocialMute::create_path(&mute_id);
    [PROTOCOL, &author_id, &mute_path].concat()
}

/// Builds a Bookmark URI of the form `pubky://<author_id>/priv/social/v1/bookmarks/<filename>.json`.
/// The leaf is the filename the target derives, never a hash of the object.
pub fn bookmark_uri_builder(author_id: String, filename: String) -> String {
    let bookmark_path = PubkySocialBookmark::create_path(&filename);
    [PROTOCOL, &author_id, &bookmark_path].concat()
}

/// Builds a Tag URI of the form "pubky://<author_id>/pub/social/v1/tags/<tag_id>.json\"
pub fn tag_uri_builder(author_id: String, tag_id: String) -> String {
    let tag_path = PubkySocialTag::create_path(&tag_id);
    [PROTOCOL, &author_id, &tag_path].concat()
}

/// Builds a media URI of the form `pubky://<author_id>/pub/social/v1/files/<hash>.<ext>`.
/// Takes the full filename: an extension cannot be derived from an id.
pub fn file_uri_builder(author_id: String, filename: String) -> String {
    let file_path = PubkySocialFile::create_path(&filename);
    [PROTOCOL, &author_id, &file_path].concat()
}

/// Builds a Feed URI of the form "pubky://<author_id>/priv/social/v1/feeds/<feed_id>.json\".
/// Feeds are private by default; the published copy is the same file under `/pub/`, see
/// `feed_paths`.
pub fn feed_uri_builder(author_id: String, feed_id: String) -> String {
    let feed_path = PubkySocialFeed::create_path(&feed_id);
    [PROTOCOL, &author_id, &feed_path].concat()
}
