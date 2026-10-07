//! Every stored copy of one logical object, in the order a delete runs them.
//!
//! Pure: the caller LISTs, this orders. Every PUBLIC kind is deleted in every epoch: on resync
//! the highest understood epoch with a surviving copy wins, so a surviving legacy copy
//! resurrects the object. The private tier (mutes, bookmarks) deletes its v1 file alone: its
//! legacy copy is a frozen public snapshot nothing surfaces any more, and migration never
//! deletes. A path that is not there is a skip for the caller, never an error.

use super::post::lifecycle::delete_order;
use super::ObjectKind;
use crate::canonicalize::{canonicalize_pubky_uri, canonicalize_universal};
use crate::common::{validate_hash_id_format, validate_timestamp_id_format};
use crate::constants::{social_path, PROTOCOL};
use crate::mime::mime_to_ext;
use crate::models::legacy_v0;
use crate::normalize::{resolve_deref, stable_id, StableId};
use crate::traits::{HasIdPath, HasPath, HashId, Root};
use crate::types::PubkyId;
use crate::uri::{is_bookmark_filename, media_stem};
use crate::{
    plan_feed_delete, PubkySocialBookmark, PubkySocialFile, PubkySocialFollow, PubkySocialMute,
    PubkySocialTag, PubkySocialUser,
};
use serde::Deserialize;

/// Where the 0.x tree kept everything, public only.
const LEGACY_PREFIX: &str = "/pub/pubky.app/";

/// One stored copy the caller found. A legacy copy whose path cannot name the object carries
/// what the crate needs to check that it does.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(untagged)]
pub enum Listing {
    /// A path as a LIST returns it, `/`-prefixed and owner-relative.
    Path(String),
    V0File(V0FileListing),
    V0Tag(V0TagListing),
}

/// A v0 File object at `path` and its stored `src`, which names the bytes.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V0FileListing {
    pub path: String,
    pub src: String,
}

/// A v0 tag at `path` and its stored `uri` and `label`, which its id hashes. A tag on a v0
/// File object also carries that object's stored `src` and `content_type`, which together
/// name the v1 media file the tag targets.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V0TagListing {
    pub path: String,
    pub uri: String,
    pub label: String,
    #[serde(default)]
    pub src: Option<String>,
    #[serde(default, rename = "contentType")]
    pub content_type: Option<String>,
}

impl Listing {
    fn path(&self) -> &str {
        match self {
            Listing::Path(path) => path,
            Listing::V0File(entry) => &entry.path,
            Listing::V0Tag(entry) => &entry.path,
        }
    }
}

/// The paths to DELETE for the object of `kind` named `id`, legacy first.
///
/// `listings` are the copies the caller found, each spelled exactly as that epoch writes it and
/// checked to belong to this object; anything else is an error naming the entry:
/// - a post: paths of every copy under `posts/{id}/` in both roots plus
///   `/pub/pubky.app/posts/{id}` when present, ordered as [`crate::plan_delete`] orders them;
/// - a file (`id` is the hash): the paths of the `files/{hash}.{ext}` copies found in either
///   root, and each v0 File object as [`Listing::V0File`], whose `src` must resolve to this
///   hash. The result is those v0 objects, the legacy `blobs/{hash}` bytes, then every listed
///   filename under `pub` and under `priv`;
/// - a tag: each v0 tag as [`Listing::V0Tag`], whose path must be the 0.x id of its stored
///   `uri` and `label` (it differs from the v1 id) and whose target and label, respelled as
///   v1 writes them, must derive this v1 id; a tag on a v0 File object also carries that
///   object's `src` and `content_type`, which spell the v1 media target; then the v1 path;
/// - the profile and a follow take no listings: their legacy path is known, so it comes first;
/// - a feed takes none and is its two v1 copies, public first; a mute and a bookmark take none
///   and are their one private path.
pub fn deletion_paths(
    kind: ObjectKind,
    id: &str,
    listings: &[Listing],
) -> Result<Vec<String>, String> {
    match kind {
        ObjectKind::Post => post_paths(id, listings),
        ObjectKind::File => file_paths(id, listings),
        ObjectKind::Tag => tag_paths(id, listings),
        // A listed copy here would be one nothing deletes, so it is refused, not ignored
        _ if !listings.is_empty() => Err(format!(
            "Validation Error: a {} delete takes no listings, found {}",
            kind.wire_name(),
            listings[0].path()
        )),
        ObjectKind::Feed => Ok(plan_feed_delete(id)?.deletes),
        ObjectKind::User if id.is_empty() => Ok(vec![
            format!("{LEGACY_PREFIX}profile.json"),
            PubkySocialUser::create_path(),
        ]),
        ObjectKind::User => Err(format!(
            "Validation Error: the profile has no id, found {id}"
        )),
        ObjectKind::Follow => {
            PubkyId::try_from(id)?;
            Ok(vec![
                format!("{LEGACY_PREFIX}follows/{id}"),
                PubkySocialFollow::create_path(id),
            ])
        }
        ObjectKind::Mute => {
            PubkyId::try_from(id)?;
            Ok(vec![PubkySocialMute::create_path(id)])
        }
        ObjectKind::Bookmark if is_bookmark_filename(id) => {
            Ok(vec![PubkySocialBookmark::create_path(id)])
        }
        ObjectKind::Bookmark => Err(format!("Validation Error: not a bookmark filename: {id}")),
    }
}

fn not_a_copy(kind: &str, id: &str, path: &str) -> String {
    format!("Validation Error: not a stored copy of {kind} {id}: {path}")
}

fn sorted(mut paths: Vec<String>) -> Vec<String> {
    paths.sort();
    paths.dedup();
    paths
}

/// The plain paths, or the first entry that carries more than a path.
fn plain_paths(kind: &str, id: &str, listings: &[Listing]) -> Result<Vec<String>, String> {
    listings
        .iter()
        .map(|l| match l {
            Listing::Path(path) => Ok(path.clone()),
            other => Err(not_a_copy(kind, id, other.path())),
        })
        .collect()
}

fn post_paths(id: &str, listings: &[Listing]) -> Result<Vec<String>, String> {
    let (legacy, v1): (Vec<String>, Vec<String>) = sorted(plain_paths("post", id, listings)?)
        .into_iter()
        .partition(|p| p.starts_with(LEGACY_PREFIX));
    // The root is the path's own first segment; a path under neither is refused by the order
    let copies: Vec<(Root, String)> = v1
        .into_iter()
        .map(|p| {
            let root = if p.starts_with(&format!("/{}/", Root::Priv.segment())) {
                Root::Priv
            } else {
                Root::Pub
            };
            (root, p)
        })
        .collect();
    delete_order(id, &legacy, &copies)
}

/// The v1 spelling of a v0 tag target: a social object under its v1 path, or a web uri
/// through the same gate the v1 builder uses. A tag on a v0 File object targets the media
/// file, whose hash only that object's `src` names and whose extension its `content_type`.
fn v1_tag_target(
    uri: &str,
    src: Option<&str>,
    content_type: Option<&str>,
) -> Result<String, String> {
    if uri.starts_with("pubky") {
        let canonical = canonicalize_pubky_uri(uri)
            .map_err(|_| format!("Validation Error: not a pubky uri: {uri}"))?;
        let (owner, path) = canonical[PROTOCOL.len()..]
            .split_once('/')
            .ok_or_else(|| format!("Validation Error: not a stored object: {uri}"))?;
        let key = match stable_id(path) {
            Some(StableId::Key(key)) => key,
            Some(StableId::NeedsDeref { tsid }) => {
                let (Some(src), Some(content_type)) = (src, content_type) else {
                    return Err(
                        "Validation Error: a legacy tag on a file needs its File src and content_type"
                            .to_string(),
                    );
                };
                let key = resolve_deref(&tsid, src)
                    .ok_or_else(|| format!("Validation Error: not a legacy blob src: {src}"))?;
                format!("{key}.{}", mime_to_ext(content_type))
            }
            None => return Err(format!("Validation Error: not a stored object: {uri}")),
        };
        let leaf = match key.as_str() {
            "profile" => PubkySocialUser::PATH_SEGMENT.to_string(),
            k if k.starts_with("posts/") || k.starts_with("files/") => key,
            _ => format!("{key}.json"),
        };
        return Ok([PROTOCOL, owner, &social_path(Root::Pub, &leaf)].concat());
    }
    if uri.starts_with("http://") || uri.starts_with("https://") {
        return canonicalize_universal(uri)
            .map_err(|_| format!("Validation Error: not a canonical web uri: {uri}"));
    }
    Err(format!(
        "Validation Error: not a tag target v1 spells: {uri}"
    ))
}

fn tag_paths(id: &str, listings: &[Listing]) -> Result<Vec<String>, String> {
    validate_hash_id_format(id)?;
    let mut deletes = Vec::new();
    for listing in listings {
        let Listing::V0Tag(V0TagListing {
            path,
            uri,
            label,
            src,
            content_type,
        }) = listing
        else {
            return Err(not_a_copy("tag", id, listing.path()));
        };
        if *path != format!("{LEGACY_PREFIX}tags/{}", legacy_v0::tag_id(uri, label)) {
            return Err(not_a_copy("tag", id, path));
        }
        // The 0.x id proves the entry is a tag; only the v1 id proves it is this one
        let target = v1_tag_target(uri, src.as_deref(), content_type.as_deref())?;
        if PubkySocialTag::new(target, label.clone()).create_id() != id {
            return Err(format!(
                "Validation Error: legacy tag {path} is not a copy of tag {id}"
            ));
        }
        deletes.push(path.clone());
    }
    let mut deletes = sorted(deletes);
    deletes.push(PubkySocialTag::create_path(id));
    Ok(deletes)
}

fn file_paths(hash: &str, listings: &[Listing]) -> Result<Vec<String>, String> {
    validate_hash_id_format(hash)?;
    let blob = format!("{LEGACY_PREFIX}blobs/{hash}");
    let v0_files = format!("{LEGACY_PREFIX}files/");
    let key = format!("files/{hash}");
    let v1_dirs = [Root::Pub, Root::Priv].map(|r| social_path(r, PubkySocialFile::PATH_SEGMENT));
    let mut v0_objects = Vec::new();
    let mut filenames = Vec::new();
    for listing in listings {
        match listing {
            // The legacy bytes, always part of the result anyway
            Listing::Path(path) if *path == blob => {}
            Listing::Path(path) => {
                let leaf = v1_dirs
                    .iter()
                    .find_map(|dir| path.strip_prefix(dir.as_str()));
                match leaf {
                    Some(leaf) if media_stem(leaf) == Some(hash) => {
                        filenames.push(leaf.to_string())
                    }
                    _ => return Err(not_a_copy("file", hash, path)),
                }
            }
            // A v0 File object belongs to this file only when its src resolves to these bytes
            Listing::V0File(V0FileListing { path, src }) => match path.strip_prefix(&v0_files) {
                Some(tsid)
                    if validate_timestamp_id_format(tsid).is_ok()
                        && resolve_deref(tsid, src).as_deref() == Some(key.as_str()) =>
                {
                    v0_objects.push(path.clone())
                }
                _ => return Err(not_a_copy("file", hash, path)),
            },
            Listing::V0Tag(entry) => return Err(not_a_copy("file", hash, &entry.path)),
        }
    }

    // The v0 objects go before the bytes they point at, so no step leaves a v0 reader a
    // reference to missing bytes; then the public copy before the private one, so the file
    // stops being world-readable first.
    let mut deletes = sorted(v0_objects);
    deletes.push(blob);
    for root in [Root::Pub, Root::Priv] {
        deletes.extend(
            sorted(filenames.clone())
                .iter()
                .map(|f| social_path(root, &[PubkySocialFile::PATH_SEGMENT, f].concat())),
        );
    }
    Ok(deletes)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PK: &str = "operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo";
    const TS: &str = "0032SSN7Q4EVG";
    const H26: &str = "8Z8CWH8NVYQY39ZEBFGKQWWEKG";

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|p| p.to_string()).collect()
    }

    fn l(v: &[&str]) -> Vec<Listing> {
        v.iter().map(|p| Listing::Path(p.to_string())).collect()
    }

    fn v0_file(tsid: &str, hash: &str) -> Listing {
        Listing::V0File(V0FileListing {
            path: format!("/pub/pubky.app/files/{tsid}"),
            src: format!("pubky://{PK}/pub/pubky.app/blobs/{hash}"),
        })
    }

    #[test]
    fn a_post_is_every_copy_legacy_first_then_oldest_pub_before_priv() {
        let listings = l(&[
            "/priv/social/v1/posts/0032SSN7Q4EVG/0032SSN7Q4EW0.json",
            "/pub/social/v1/posts/0032SSN7Q4EVG/0032SSN7Q4EW0.json",
            "/priv/social/v1/posts/0032SSN7Q4EVG/0032SSN7Q4EVG-draft.json",
            "/pub/pubky.app/posts/0032SSN7Q4EVG",
        ]);
        assert_eq!(
            deletion_paths(ObjectKind::Post, TS, &listings).unwrap(),
            s(&[
                "/pub/pubky.app/posts/0032SSN7Q4EVG",
                "/priv/social/v1/posts/0032SSN7Q4EVG/0032SSN7Q4EVG-draft.json",
                "/pub/social/v1/posts/0032SSN7Q4EVG/0032SSN7Q4EW0.json",
                "/priv/social/v1/posts/0032SSN7Q4EVG/0032SSN7Q4EW0.json",
            ])
        );
    }

    #[test]
    fn a_post_refuses_a_path_of_another_object() {
        for stray in [
            "/pub/social/v1/posts/0034A0X7NJ52G/0034A0X7NJ52G.json",
            "/pub/pubky.app/posts/0034A0X7NJ52G",
            "/pub/social/v1/tags/8Z8CWH8NVYQY39ZEBFGKQWWEKG.json",
        ] {
            assert!(
                deletion_paths(ObjectKind::Post, TS, &l(&[stray])).is_err(),
                "{stray}"
            );
        }
        assert!(deletion_paths(ObjectKind::Post, "nope", &[]).is_err());
        // A post copy is a path; an entry carrying more is not one
        assert!(deletion_paths(ObjectKind::Post, TS, &[v0_file(TS, H26)]).is_err());
    }

    #[test]
    fn a_file_is_its_v0_objects_the_blob_then_both_roots() {
        let mut listings = l(&[
            "/priv/social/v1/files/8Z8CWH8NVYQY39ZEBFGKQWWEKG.png",
            "/pub/pubky.app/blobs/8Z8CWH8NVYQY39ZEBFGKQWWEKG",
        ]);
        listings.push(v0_file(TS, H26));
        assert_eq!(
            deletion_paths(ObjectKind::File, H26, &listings).unwrap(),
            s(&[
                "/pub/pubky.app/files/0032SSN7Q4EVG",
                "/pub/pubky.app/blobs/8Z8CWH8NVYQY39ZEBFGKQWWEKG",
                "/pub/social/v1/files/8Z8CWH8NVYQY39ZEBFGKQWWEKG.png",
                "/priv/social/v1/files/8Z8CWH8NVYQY39ZEBFGKQWWEKG.png",
            ])
        );
        // Nothing listed still reaches the legacy bytes
        assert_eq!(
            deletion_paths(ObjectKind::File, H26, &[]).unwrap(),
            s(&["/pub/pubky.app/blobs/8Z8CWH8NVYQY39ZEBFGKQWWEKG"])
        );
    }

    #[test]
    fn a_file_refuses_another_hash_and_non_media() {
        for stray in [
            "/pub/social/v1/files/PZBQ010FF079VVZPQG1RNFN6DR.png",
            "/pub/pubky.app/blobs/PZBQ010FF079VVZPQG1RNFN6DR",
            "/pub/social/v1/posts/0032SSN7Q4EVG/0032SSN7Q4EVG.json",
            "/pub/social/v2/files/8Z8CWH8NVYQY39ZEBFGKQWWEKG.png",
            "/pub/social/v1/files/8Z8CWH8NVYQY39ZEBFGKQWWEKG.PNG",
            "/pub/social/v1/files/8Z8CWH8NVYQY39ZEBFGKQWWEKG.png/",
            "/pub/pubky.app/blobs/8Z8CWH8NVYQY39ZEBFGKQWWEKG/",
            // A v0 File object as a bare path: nothing says which bytes it names
            "/pub/pubky.app/files/0032SSN7Q4EVG",
        ] {
            assert!(
                deletion_paths(ObjectKind::File, H26, &l(&[stray])).is_err(),
                "{stray}"
            );
        }
        for bad_path in [
            "/pub/pubky.app/files/0032SSN7Q4EVG/../../../../priv/social/v1/mutes/x",
            "/pub/pubky.app/files/0032SSN7Q4EVG?x",
            "/pub/pubky.app/files/0032SSN7Q4EVG/",
            "/pub/pubky.app/files/0032ssn7q4evg",
            "/pub/pubky.app/files/0032SSN7Q4EVG.json",
        ] {
            let entry = Listing::V0File(V0FileListing {
                path: bad_path.into(),
                src: format!("pubky://{PK}/pub/pubky.app/blobs/{H26}"),
            });
            let err = deletion_paths(ObjectKind::File, H26, &[entry]).unwrap_err();
            assert!(err.contains(bad_path), "{err}");
        }
        // The src must resolve to these bytes, not to other ones or to nothing
        for src in [
            format!("pubky://{PK}/pub/pubky.app/blobs/PZBQ010FF079VVZPQG1RNFN6DR"),
            "https://example.com/x.png".to_string(),
        ] {
            let entry = Listing::V0File(V0FileListing {
                path: "/pub/pubky.app/files/0032SSN7Q4EVG".into(),
                src,
            });
            assert!(deletion_paths(ObjectKind::File, H26, &[entry]).is_err());
        }
        assert!(deletion_paths(ObjectKind::File, "nope", &[]).is_err());
    }

    #[test]
    fn listings_read_from_json_by_shape() {
        let read: Vec<Listing> = serde_json::from_str(
            r#"["/a", {"path": "/b", "src": "s"}, {"path": "/c", "uri": "u", "label": "l"}]"#,
        )
        .unwrap();
        assert_eq!(read[0], Listing::Path("/a".into()));
        assert!(matches!(read[1], Listing::V0File(_)));
        assert!(matches!(read[2], Listing::V0Tag(_)));
        // A shape that is neither is refused, not guessed
        for bad in [
            r#"[{"path": "/b"}]"#,
            r#"[{"path": "/b", "src": "s", "label": "l"}]"#,
        ] {
            assert!(serde_json::from_str::<Vec<Listing>>(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_feed_is_both_copies_public_first() {
        assert_eq!(
            deletion_paths(ObjectKind::Feed, H26, &[]).unwrap(),
            s(&[
                "/pub/social/v1/feeds/8Z8CWH8NVYQY39ZEBFGKQWWEKG.json",
                "/priv/social/v1/feeds/8Z8CWH8NVYQY39ZEBFGKQWWEKG.json",
            ])
        );
    }

    #[test]
    fn a_post_sorts_and_dedups_its_listings() {
        let v = "/pub/social/v1/posts/0032SSN7Q4EVG/0032SSN7Q4EVG.json";
        let legacy = "/pub/pubky.app/posts/0032SSN7Q4EVG";
        assert_eq!(
            deletion_paths(ObjectKind::Post, TS, &l(&[v, legacy, v, legacy])).unwrap(),
            s(&[legacy, v])
        );
    }

    #[test]
    fn the_profile_and_a_follow_take_their_legacy_copy_first() {
        assert_eq!(
            deletion_paths(ObjectKind::User, "", &[]).unwrap(),
            s(&["/pub/pubky.app/profile.json", "/pub/social/v1/profile.json"])
        );
        assert_eq!(
            deletion_paths(ObjectKind::Follow, PK, &[]).unwrap(),
            vec![
                format!("/pub/pubky.app/follows/{PK}"),
                format!("/pub/social/v1/follows/{PK}.json"),
            ]
        );
    }

    fn v0_tag(uri: &str, label: &str, file: Option<(&str, &str)>) -> Listing {
        Listing::V0Tag(V0TagListing {
            path: format!("/pub/pubky.app/tags/{}", legacy_v0::tag_id(uri, label)),
            uri: uri.into(),
            label: label.into(),
            src: file.map(|(src, _)| src.to_string()),
            content_type: file.map(|(_, ct)| ct.to_string()),
        })
    }

    fn v1_tag_id(uri: &str, label: &str) -> String {
        PubkySocialTag::new(uri.into(), label.into()).create_id()
    }

    #[test]
    fn a_tag_takes_its_listed_v0_copies_then_the_v1_path() {
        let entry = v0_tag(
            &format!("pubky://{PK}/pub/pubky.app/profile.json"),
            "friend",
            None,
        );
        let id = v1_tag_id(&crate::user_uri_builder(PK.into()), "friend");
        assert_eq!(
            deletion_paths(ObjectKind::Tag, &id, &[entry.clone(), entry.clone()]).unwrap(),
            vec![
                entry.path().to_string(),
                format!("/pub/social/v1/tags/{id}.json")
            ]
        );
        assert_eq!(
            deletion_paths(ObjectKind::Tag, H26, &[]).unwrap(),
            vec![format!("/pub/social/v1/tags/{H26}.json")]
        );
        // A path the stored uri and label do not hash to, or a bare path, is refused
        let Listing::V0Tag(good) = entry.clone() else {
            unreachable!()
        };
        let strays = [
            Listing::V0Tag(V0TagListing {
                label: "foe".into(),
                ..good.clone()
            }),
            Listing::V0Tag(V0TagListing {
                path: format!("{}/", good.path),
                ..good
            }),
            Listing::Path(entry.path().to_string()),
        ];
        for stray in strays {
            let err =
                deletion_paths(ObjectKind::Tag, &id, std::slice::from_ref(&stray)).unwrap_err();
            assert!(err.contains(stray.path()), "{err}");
        }
    }

    #[test]
    fn a_tag_refuses_a_v0_tag_of_another_label_or_target() {
        let v0_post = format!("pubky://{PK}/pub/pubky.app/posts/{TS}");
        let v1_post = crate::post_uri_builder(PK.into(), TS.into());
        let id = v1_tag_id(&v1_post, "cool");
        assert!(deletion_paths(ObjectKind::Tag, &id, &[v0_tag(&v0_post, "cool", None)]).is_ok());
        // The builder folds the label, so the check does too
        assert!(deletion_paths(ObjectKind::Tag, &id, &[v0_tag(&v0_post, "CoOl", None)]).is_ok());
        let other_label = v0_tag(&v0_post, "hot", None);
        let other_target = v0_tag(
            &format!("pubky://{PK}/pub/pubky.app/posts/0034A0X7NJ52G"),
            "cool",
            None,
        );
        for stray in [other_label, other_target] {
            let err =
                deletion_paths(ObjectKind::Tag, &id, std::slice::from_ref(&stray)).unwrap_err();
            assert!(
                err == format!(
                    "Validation Error: legacy tag {} is not a copy of tag {id}",
                    stray.path()
                ),
                "{err}"
            );
        }
        // A target v1 never spells cannot be a copy of any v1 tag
        for uri in [
            format!("pubky://{PK}/pub/other.app/posts/{TS}"),
            format!("pubky://{PK}"),
            "ftp://example.com/x".to_string(),
        ] {
            assert!(
                deletion_paths(ObjectKind::Tag, &id, &[v0_tag(&uri, "cool", None)]).is_err(),
                "{uri}"
            );
        }
    }

    #[test]
    fn a_tag_on_a_v0_file_needs_the_file_src_and_content_type() {
        let v0_file = format!("pubky://{PK}/pub/pubky.app/files/{TS}");
        let src = format!("pubky://{PK}/pub/pubky.app/blobs/{H26}");
        let id = v1_tag_id(
            &format!("pubky://{PK}/pub/social/v1/files/{H26}.png"),
            "pic",
        );
        let entry = v0_tag(&v0_file, "pic", Some((&src, "image/png")));
        assert_eq!(
            deletion_paths(ObjectKind::Tag, &id, std::slice::from_ref(&entry)).unwrap(),
            vec![
                entry.path().to_string(),
                format!("/pub/social/v1/tags/{id}.json")
            ]
        );
        let Listing::V0Tag(full) = entry else {
            unreachable!()
        };
        for missing in [
            V0TagListing {
                src: None,
                ..full.clone()
            },
            V0TagListing {
                content_type: None,
                ..full.clone()
            },
        ] {
            let err = deletion_paths(ObjectKind::Tag, &id, &[Listing::V0Tag(missing)]).unwrap_err();
            assert!(err.contains("needs its File src and content_type"), "{err}");
        }
        // Other bytes or another extension is a tag on another file
        let other = format!("pubky://{PK}/pub/pubky.app/blobs/PZBQ010FF079VVZPQG1RNFN6DR");
        for file in [(other.as_str(), "image/png"), (src.as_str(), "image/jpeg")] {
            assert!(
                deletion_paths(ObjectKind::Tag, &id, &[v0_tag(&v0_file, "pic", Some(file))])
                    .is_err()
            );
        }
    }

    #[test]
    fn a_tag_on_a_web_uri_keeps_its_target() {
        let uri = "https://example.com/post/1";
        let id = v1_tag_id(uri, "cool");
        assert_eq!(
            deletion_paths(ObjectKind::Tag, &id, &[v0_tag(uri, "cool", None)]).unwrap(),
            vec![
                format!("/pub/pubky.app/tags/{}", legacy_v0::tag_id(uri, "cool")),
                format!("/pub/social/v1/tags/{id}.json"),
            ]
        );
        assert!(deletion_paths(ObjectKind::Tag, H26, &[v0_tag(uri, "cool", None)]).is_err());
    }

    #[test]
    fn the_private_tier_is_its_one_v1_path() {
        let cases = [
            (
                ObjectKind::Mute,
                PK,
                format!("/priv/social/v1/mutes/{PK}.json"),
            ),
            (
                ObjectKind::Bookmark,
                "~8Z8CWH8NVYQY39ZEBFGKQWWEKG",
                "/priv/social/v1/bookmarks/~8Z8CWH8NVYQY39ZEBFGKQWWEKG.json".to_string(),
            ),
        ];
        for (kind, id, path) in cases {
            assert_eq!(deletion_paths(kind, id, &[]).unwrap(), vec![path]);
        }
    }

    #[test]
    fn kinds_with_a_known_path_refuse_listings() {
        for (kind, id) in [
            (ObjectKind::User, ""),
            (ObjectKind::Follow, PK),
            (ObjectKind::Mute, PK),
            (ObjectKind::Feed, H26),
            (ObjectKind::Bookmark, "~8Z8CWH8NVYQY39ZEBFGKQWWEKG"),
        ] {
            // A listing would be a copy nothing deletes, so it is refused, not ignored
            let err = deletion_paths(kind, id, &l(&["/pub/pubky.app/x"])).unwrap_err();
            assert!(err.contains("takes no listings"), "{err}");
        }
    }

    #[test]
    fn every_other_kind_checks_its_id() {
        for (kind, id) in [
            (ObjectKind::User, "x"),
            (ObjectKind::Tag, "x"),
            (ObjectKind::Feed, "x"),
            (ObjectKind::Follow, "x"),
            (ObjectKind::Mute, "x"),
            (ObjectKind::Bookmark, "_x"),
        ] {
            assert!(deletion_paths(kind, id, &[]).is_err(), "{kind:?} {id}");
        }
    }
}
