//! # Forward-compatibility contract (permanent)
//!
//! Every JSON object stored on a homeserver obeys two rules, forever:
//!
//! 1. Never `#[serde(deny_unknown_fields)]`, on any model. Unknown fields
//!    are ignored on read; a newer writer must never be able to break an
//!    older reader by adding a field.
//! 2. Additive fields only. Every field added to a model after it first
//!    ships MUST be `Option<T>` + `#[serde(default)]` +
//!    `#[serde(skip_serializing_if = "Option::is_none")]`, so old data
//!    reads back cleanly and old readers never see a shape change.
//! 3. Unknown members are preserved, not only tolerated. A wire model carries
//!    a flattened `extra` map that a read-modify-write carries through
//!    untouched, so an older client never drops a newer client's data. It is
//!    opaque: never validated beyond two rules, it must not shadow a known
//!    field and its integers must be JSON-safe (the 53-bit rule every known
//!    integer already obeys, so any JSON engine carries the value back), and
//!    never written by builders. Member order and escape spelling are not
//!    part of the contract; values are. Deliberate extensions live under
//!    the reserved `ext` member and are hostile input until the extension's
//!    own rules have checked them. Post, attachment, the article and
//!    collection envelopes, collection item, user, user link, tag, follow,
//!    mute and bookmark carry it today; the other models adopt it with their
//!    own wire changes.
//! 4. One total size cap per object (`Validatable::MAX_BYTES`), checked on
//!    the raw bytes before parsing and on the serialized bytes in every
//!    `validate`, so builders and JSON import cannot skip it. It bounds the open-ended `extra`
//!    without counting newer known fields against the extension budget.
//!
//! Every enum that appears as a value inside a stored JSON object carries a
//! `#[serde(other)] Unknown` catch-all and an `is_known()` helper. (`Resource`,
//! the URI parse result, is not a stored object; its serde shape is pinned by
//! the wire fixture and changing it is an API break.) `Unknown` in an object's PRIMARY enum (for
//! example `post.kind` or `feed.reach`) fails validation, so consumers skip
//! the object; `Unknown` in an optional, secondary enum (for example
//! `feed.content` or `collection.layout`) degrades to "no constraint": a
//! consumer treats it as no filter. Deserialization itself never fails on
//! an unrecognized variant. The same enums are `#[non_exhaustive]`, so a
//! variant added later is a minor release: downstream matches must carry a
//! wildcard arm, which is the same discipline `Unknown` already asks for.
//!
//! A derived id is a write-side guarantee, not a read-side one: a reader that
//! meets a value it does not know cannot rebuild the writer's id input around
//! it, so it takes the id as named and applies the rule above to the value.

use crate::uri::media_stem;
use crate::{traits::HasIdPath, traits::Validatable, traits::ValidationCtx, ParsedUri, Resource};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;

pub mod bookmark;
pub mod deletion;
pub mod feed;
pub mod file;
pub mod follow;
pub mod legacy_v0;
pub mod mute;
pub mod post;
pub mod tag;
pub mod user;

use super::{
    PubkySocialBookmark, PubkySocialFeed, PubkySocialFile, PubkySocialFollow, PubkySocialMute,
    PubkySocialPost, PubkySocialTag, PubkySocialUser,
};

/// Which kind of stored object a value or a request is about. The JS surface tags every
/// object it hands out with it and takes it back wherever a caller names an object.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[non_exhaustive]
pub enum ObjectKind {
    User,
    Post,
    Follow,
    Mute,
    Bookmark,
    Tag,
    File,
    Feed,
}

impl ObjectKind {
    /// The frozen spelling, the one its serde form uses.
    pub fn wire_name(&self) -> &'static str {
        match self {
            ObjectKind::User => "user",
            ObjectKind::Post => "post",
            ObjectKind::Follow => "follow",
            ObjectKind::Mute => "mute",
            ObjectKind::Bookmark => "bookmark",
            ObjectKind::Tag => "tag",
            ObjectKind::File => "file",
            ObjectKind::Feed => "feed",
        }
    }
}

/// A unified enum wrapping all PubkySocial objects.
#[derive(Debug, Clone)]
pub enum PubkySocialObject {
    User(user::PubkySocialUser),
    Post(post::PubkySocialPost),
    Follow(follow::PubkySocialFollow),
    Mute(mute::PubkySocialMute),
    Bookmark(bookmark::PubkySocialBookmark),
    Tag(tag::PubkySocialTag),
    File(file::PubkySocialFile),
    Feed(feed::PubkySocialFeed),
}

impl PubkySocialObject {
    pub fn kind(&self) -> ObjectKind {
        match self {
            PubkySocialObject::User(_) => ObjectKind::User,
            PubkySocialObject::Post(_) => ObjectKind::Post,
            PubkySocialObject::Follow(_) => ObjectKind::Follow,
            PubkySocialObject::Mute(_) => ObjectKind::Mute,
            PubkySocialObject::Bookmark(_) => ObjectKind::Bookmark,
            PubkySocialObject::Tag(_) => ObjectKind::Tag,
            PubkySocialObject::File(_) => ObjectKind::File,
            PubkySocialObject::Feed(_) => ObjectKind::Feed,
        }
    }

    /// Given a URI and a blob (raw data from the homeserver),
    /// this function returns the fully formed PubkySocialObject.
    pub fn from_uri<S: AsRef<str>>(uri: S, blob: &[u8]) -> Result<Self, String> {
        Self::from_uri_cow(uri.as_ref(), Cow::Borrowed(blob))
    }

    /// [`Self::from_uri`] over bytes the caller already owns: media keeps them with no copy.
    pub fn from_uri_owned<S: AsRef<str>>(uri: S, blob: Vec<u8>) -> Result<Self, String> {
        Self::from_uri_cow(uri.as_ref(), Cow::Owned(blob))
    }

    fn from_uri_cow(uri: &str, blob: Cow<'_, [u8]>) -> Result<Self, String> {
        let parsed_uri = ParsedUri::try_from(uri)?;
        let ctx = ValidationCtx {
            root: parsed_uri.visibility.root(),
        };
        let object = Self::from_resource_cow(&parsed_uri.resource, blob, &ctx)?;
        // The URI names the author, so the ownership rule can run here where a bare
        // `Resource` cannot supply it
        if let PubkySocialObject::Post(post) = &object {
            post.check_references(&ctx, Some(&parsed_uri.user_id))?;
        }
        Ok(object)
    }

    /// Given a Resource and a blob (raw data from the homeserver),
    /// this function returns the fully formed PubkySocialObject.
    /// Deliberately wildcard-free: a `Resource` variant added later fails here at compile
    /// time instead of silently becoming an error case.
    pub fn from_resource(
        resource: &Resource,
        blob: &[u8],
        ctx: &ValidationCtx,
    ) -> Result<Self, String> {
        Self::from_resource_cow(resource, Cow::Borrowed(blob), ctx)
    }

    fn from_resource_cow(
        resource: &Resource,
        blob: Cow<'_, [u8]>,
        ctx: &ValidationCtx,
    ) -> Result<Self, String> {
        match resource {
            Resource::User => {
                let user = <PubkySocialUser as Validatable>::try_from(&blob, "", ctx)?;
                Ok(PubkySocialObject::User(user))
            }
            Resource::Post {
                id,
                version: Some(_),
                ..
            } => {
                let post = <PubkySocialPost as Validatable>::try_from(&blob, id, ctx)?;
                Ok(PubkySocialObject::Post(post))
            }
            Resource::Post { version: None, .. } => Err(
                "Validation Error: a versionless post reference is never a stored object"
                    .to_string(),
            ),
            Resource::Follow(follow_id) => {
                let follow = <PubkySocialFollow as Validatable>::try_from(&blob, follow_id, ctx)?;
                Ok(PubkySocialObject::Follow(follow))
            }
            Resource::Mute(muted_id) => {
                let mute = <PubkySocialMute as Validatable>::try_from(&blob, muted_id, ctx)?;
                Ok(PubkySocialObject::Mute(mute))
            }
            Resource::Bookmark(filename) => {
                // A bookmark read under the public root would turn a private-only resource
                // public; the parser never classifies one there, and neither does a caller.
                if ctx.root != <PubkySocialBookmark as HasIdPath>::ROOT {
                    return Err("Validation Error: a bookmark is never a public object".to_string());
                }
                let bookmark =
                    <PubkySocialBookmark as Validatable>::try_from(&blob, filename, ctx)?;
                Ok(PubkySocialObject::Bookmark(bookmark))
            }
            Resource::Tag(tag_id) => {
                let tag = <PubkySocialTag as Validatable>::try_from(&blob, tag_id, ctx)?;
                Ok(PubkySocialObject::Tag(tag))
            }
            Resource::File(filename) => {
                // A hand-built value takes the parser's leaf rule too, so a filename without a
                // media extension is refused here as it is there
                let id = media_stem(filename).ok_or_else(|| {
                    format!(
                        "Validation Error: a media filename needs a known extension: {filename}"
                    )
                })?;
                // Media is raw bytes with no JSON form, so it has its own reader
                let file = PubkySocialFile::from_vec(blob.into_owned(), id)?;
                Ok(PubkySocialObject::File(file))
            }
            Resource::Feed(feed_id) => {
                let feed = <PubkySocialFeed as Validatable>::try_from(&blob, feed_id, ctx)?;
                Ok(PubkySocialObject::Feed(feed))
            }
            Resource::Foreign { .. } => {
                Err("Validation Error: a foreign namespace is not a social object".to_string())
            }
            Resource::UnsupportedVersion { .. } => {
                Err("Validation Error: an unsupported epoch is a skip, not an object".to_string())
            }
            Resource::Unknown => Err(format!(
                "Validation Error: Unrecognized resource {:?}",
                resource
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::traits::{HasIdPath, HashId, PUB_CTX};
    use crate::{
        bookmark_uri_builder, feed_uri_builder, file_uri_builder, follow_uri_builder,
        mute_uri_builder, post_uri_builder, tag_uri_builder, user_uri_builder,
    };

    use super::*;

    // These tests assume that the respective try_from implementations for each model
    // parse the provided JSON. Adjust the JSON payloads as needed.

    #[test]
    fn unparsable_bytes_are_a_validation_error() {
        let uri = user_uri_builder("operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo".into());
        let err = PubkySocialObject::from_uri(&uri, b"{").unwrap_err();
        assert!(err.starts_with("Validation Error: "), "{err}");
        let err = PubkySocialObject::from_uri_owned(uri, b"{".to_vec()).unwrap_err();
        assert!(err.starts_with("Validation Error: "), "{err}");
    }

    #[test]
    fn test_import_user() {
        let uri = user_uri_builder("operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo".into());
        let user_json = r#"{
            "name": "Alice",
            "bio": "Hello, I am Alice",
            "image": "https://example.com/alice.png",
            "links": null,
            "status": "active"
        }"#;
        let result = PubkySocialObject::from_uri(uri, user_json.as_bytes());
        assert!(
            result.is_ok(),
            "Expected a successful import for user, got error: {:?}",
            result.err()
        );
        match result.unwrap() {
            PubkySocialObject::User(user) => {
                assert_eq!(user.name, "Alice", "User name mismatch");
                assert_eq!(
                    user.bio.unwrap_or_default(),
                    "Hello, I am Alice",
                    "User bio mismatch"
                );
            }
            other => panic!("Expected a User object, got {:?}", other),
        }
    }

    #[test]
    fn test_import_post() {
        // The storage path: a versionless reference is never a stored object.
        let uri = format!(
            "pubky://operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo{}",
            post::PubkySocialPost::create_path("0032SSN7Q4EVG")
        );
        let post_json = r#"{
            "content": "Hello World!",
            "kind": "note",
            "parent": null,
            "embed": null,
            "attachments": []
        }"#;
        let result = PubkySocialObject::from_uri(uri, post_json.as_bytes());
        assert!(
            result.is_ok(),
            "Expected a successful import for post, got error: {:?}",
            result.err()
        );
        match result.unwrap() {
            PubkySocialObject::Post(post) => {
                assert_eq!(post.content, "Hello World!", "Post content mismatch");
            }
            other => panic!("Expected a Post object, got {:?}", other),
        }
    }

    #[test]
    fn test_import_follow() {
        let uri = follow_uri_builder(
            "operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo".into(),
            "pxnu33x7jtpx9ar1ytsi4yxbp6a5o36gwhffs8zoxmbuptici1jy".into(),
        );
        let follow_json = r#"{
            "created_at": 1627849723
        }"#;
        let result = PubkySocialObject::from_uri(uri, follow_json.as_bytes());
        assert!(
            result.is_ok(),
            "Expected a successful import for follow, got error: {:?}",
            result.err()
        );
        match result.unwrap() {
            PubkySocialObject::Follow(follow) => {
                assert_eq!(follow.created_at, 1627849723, "Follow created_at mismatch");
            }
            other => panic!("Expected a Follow object, got {:?}", other),
        }
    }

    #[test]
    fn test_import_mute() {
        let uri = mute_uri_builder(
            "operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo".into(),
            "pxnu33x7jtpx9ar1ytsi4yxbp6a5o36gwhffs8zoxmbuptici1jy".into(),
        );
        let mute_json = r#"{
            "created_at": 1627849724
        }"#;
        let result = PubkySocialObject::from_uri(uri, mute_json.as_bytes());
        assert!(
            result.is_ok(),
            "Expected a successful import for mute, got error: {:?}",
            result.err()
        );
        match result.unwrap() {
            PubkySocialObject::Mute(mute) => {
                assert_eq!(mute.created_at, 1627849724, "Mute created_at mismatch");
            }
            other => panic!("Expected a Mute object, got {:?}", other),
        }
    }

    #[test]
    fn test_import_bookmark() {
        let post_uri = post_uri_builder(
            "operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo".into(),
            "0032SSN7Q4EVG".into(),
        );

        let filename = bookmark::bookmark_filename(&post_uri).unwrap();
        let uri = bookmark_uri_builder(
            "operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo".into(),
            filename.clone(),
        );
        let bookmark_json = r#"{"created_at": 1627849725}"#;
        let result = PubkySocialObject::from_uri(uri, bookmark_json.as_bytes());
        assert!(
            result.is_ok(),
            "Expected a successful import for bookmark, got error: {:?}",
            result.err()
        );
        match result.unwrap() {
            PubkySocialObject::Bookmark(bookmark) => {
                assert_eq!(
                    bookmark::bookmark_target(&filename, &bookmark),
                    Ok(post_uri),
                    "Bookmark target mismatch"
                );
            }
            other => panic!("Expected a Bookmark object, got {:?}", other),
        }
    }

    #[test]
    fn test_import_tag() {
        let post_uri = post_uri_builder(
            "operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo".into(),
            "0032SSN7Q4EVG".into(),
        );

        let tag_id = tag::PubkySocialTag::new(post_uri.clone(), "cool".to_string()).create_id();
        let uri = tag_uri_builder(
            "operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo".into(),
            tag_id,
        );
        let tag_json = format!(
            r#"{{
            "uri": "{post_uri}",
            "label": "cool",
            "created_at": 1627849726
        }}"#
        );
        let result = PubkySocialObject::from_uri(uri, tag_json.as_bytes());
        assert!(
            result.is_ok(),
            "Expected a successful import for tag, got error: {:?}",
            result.err()
        );
        match result.unwrap() {
            PubkySocialObject::Tag(tag) => {
                assert_eq!(tag.label, "cool", "Tag label mismatch");
            }
            other => panic!("Expected a Tag object, got {:?}", other),
        }
    }

    #[test]
    fn test_import_file() {
        let bytes = vec![1, 2, 3];
        let id = file::PubkySocialFile(bytes.clone()).create_id();
        let uri = file_uri_builder(
            "operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo".into(),
            format!("{id}.png"),
        );
        let result = PubkySocialObject::from_uri(&uri, &bytes);
        assert!(
            result.is_ok(),
            "Expected a successful import for file, got error: {:?}",
            result.err()
        );
        match result.unwrap() {
            PubkySocialObject::File(file) => assert_eq!(file.0, bytes, "File bytes mismatch"),
            other => panic!("Expected a File object, got {:?}", other),
        }

        // The extension is path-only, so the id is recomputed from the bytes alone
        assert!(PubkySocialObject::from_uri(&uri, &[9, 9][..]).is_err());
    }

    #[test]
    fn test_import_file_dispatches_raw_bytes() {
        let bytes = [1u8, 2, 3];
        let id = file::PubkySocialFile(bytes.to_vec()).create_id();
        let resource = Resource::File(format!("{id}.bin"));
        assert!(PubkySocialObject::from_resource(&resource, &bytes, &PUB_CTX).is_ok());

        let other = Resource::File("8Z8CWH8NVYQY39ZEBFGKQWWEKG.bin".to_string());
        assert!(PubkySocialObject::from_resource(&other, &bytes, &PUB_CTX).is_err());
        // a leaf without a media extension is refused here as the parser refuses it
        let bare = Resource::File(id.clone());
        let e = PubkySocialObject::from_resource(&bare, &bytes, &PUB_CTX).unwrap_err();
        assert!(e.contains("known extension"), "{e}");
    }

    #[test]
    fn test_import_feed() {
        let uri = feed_uri_builder(
            "operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo".into(),
            // blake3("following:columns:recent:::")[..16] in Crockford
            "FXKCW1SPW80RX2AGB3MCP5CF48".into(),
        );
        let feed_json = r#"{
            "feed": {
                "tags": null,
                "reach": "following",
                "layout": "columns",
                "sort": "recent",
                "content": null
            },
            "name": "My Feed",
            "created_at": 1627849728
        }"#;
        let result = PubkySocialObject::from_uri(uri, feed_json.as_bytes());
        assert!(
            result.is_ok(),
            "Expected a successful import for feed, got error: {:?}",
            result.err()
        );
        match result.unwrap() {
            PubkySocialObject::Feed(feed) => {
                assert_eq!(feed.name, "My Feed", "Feed name mismatch");
            }
            other => panic!("Expected a Feed object, got {:?}", other),
        }
    }

    #[test]
    fn test_import_unknown_resource() {
        let uri =
            "pubky://operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo/pub/social/v1/unknown/ID";
        let json = r#"{}"#;
        let result = PubkySocialObject::from_uri(uri, json.as_bytes());
        assert!(
            result.is_err(),
            "Expected an error for unknown resource, but got: {:?}",
            result.ok()
        );
        let err = result.err().unwrap();
        assert!(
            err.contains("Validation Error: Unrecognized resource"),
            "Error message does not contain expected text: {}",
            err
        );
    }
}
