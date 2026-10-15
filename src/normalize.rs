//! The one normalization every consumer shares, so an indexer, a migrator and a client
//! cannot disagree about which stored paths are the same object.

use crate::constants::{PRIVATE_ROOT, PROTOCOL, PUBLIC_ROOT, SOCIAL_NAMESPACE};
use crate::models::legacy_v0::{ParsedUri, Resource};

/// The dedup key of a stored object across epochs and roots, or a legacy media reference
/// that needs its v0 File object to complete.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StableId {
    Key(String),
    NeedsDeref { tsid: String },
}

/// The v0 namespace, epoch 0: one path segment where a social epoch takes two.
const LEGACY_EPOCH: &str = "pubky.app";

/// Resource segments whose leaf carries the id. An empty or missing leaf is not a stored
/// object, so it has no key.
const ID_SEGMENTS: &[&str] = &["tags", "follows", "mutes", "bookmarks", "feeds"];

/// v0 resources that are a whole object on their own. They key only under `pubky.app`, so
/// the migrator can find them; in v1 they belong to the app, not to this library.
const LEAF_SEGMENTS: &[&str] = &["last_read", "settings"];

/// Any canonical key works: an owner-relative path has no host, and the key never keeps one.
const PLACEHOLDER_HOST: &str = "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy";

fn strip_json(leaf: &str) -> &str {
    leaf.strip_suffix(".json").unwrap_or(leaf)
}

/// `{segment}/{id}`, or `None` when the strip left no id behind, so `tags/.json` and
/// `files/.png` are not stored objects rather than a key with an empty id.
fn keyed(segment: &str, id: &str) -> Option<String> {
    if id.is_empty() {
        return None;
    }
    Some(format!("{segment}/{id}"))
}

/// From an owner-relative path (`pub/social/v1/posts/X/Y.json`, `pub/pubky.app/posts/X`,
/// `priv/social/v1/files/H.png`, ...) to the resource-relative key that every epoch spelling
/// of one object shares. `None` for a path that is not a social object under any epoch.
///
/// The key drops the root, so a private draft and its published copy are one object, and it
/// drops the whole post version leaf, label included, so every edit of a post is one row.
///
/// A leaf is read on the terms of the epoch that wrote it. A `social/v1` path goes through
/// the v1 parser and keys from the resource it classifies, so the key cannot drift from the
/// grammar: whatever the parser calls unknown (a wrong root, a malformed id, a nested post
/// path, a `blobs/` segment) has no key. A `pubky.app` path keeps the v0 reading: a post
/// leaf is dropped from its first segment on, any other leaf is the id, and a trailing extra
/// segment is ignored because the v0 parser ignores it and keys the object anyway. No v0 id
/// is validated here: the key comes from a path the v0 ingest already accepted.
///
/// Only `social/v1` keys among the social epochs. A new epoch exists for a change that
/// breaks these rules, a re-pinned id function or a grammar break, so a later epoch adds
/// its own rules here instead of inheriting v1's.
///
/// What collapses across epochs is the path grammar, not the id inside it. `posts`, `files`
/// and `blobs`, `follows`, `mutes` and `profile` carry the same id in both spellings of one
/// object, so the two paths key onto one row. `tags`, `bookmarks`
/// and `feeds` do not: a v0 tag id hashes a target uri that the migration itself respells
/// for social targets, a v0 bookmark id is a hash where the v1 leaf is a filename, and a
/// feed id is re-derived. One migrated tag, bookmark or feed therefore holds two keys, and
/// collapsing those is the indexer's own job, by normalized target or by its own rule.
pub fn stable_id(owner_relative_path: &str) -> Option<StableId> {
    let path = owner_relative_path
        .strip_prefix('/')
        .unwrap_or(owner_relative_path);

    let (root, after_root) = path.split_once('/')?;
    if root != PUBLIC_ROOT && root != PRIVATE_ROOT {
        return None;
    }

    let (namespace, rest) = after_root.split_once('/')?;
    if namespace == SOCIAL_NAMESPACE {
        return social_key(path).map(StableId::Key);
    }
    // The v0 tree was public only, so a private path is never one of its objects
    if namespace != LEGACY_EPOCH || root != PUBLIC_ROOT {
        return None;
    }

    // The resource segment and everything after it.
    let (segment, leaf) = match rest.split_once('/') {
        Some((s, l)) => (s, Some(l)),
        None => (rest, None),
    };
    // The v0 parser matches `[resource, id, ..]` and ignores whatever follows, so only the
    // first segment of the leaf is read, or a read-then-key pass drops objects v0 accepted.
    let leaf = match leaf.filter(|l| !l.is_empty()) {
        Some(l) => match l.split('/').next().unwrap_or(l) {
            "" => return None,
            first => Some(first),
        },
        None => None,
    };

    let key = match (segment, leaf) {
        ("posts", Some(id)) => keyed("posts", id)?,
        // The v0 metadata object names the bytes; only its `src` completes the key.
        ("files", Some(leaf)) => {
            return Some(StableId::NeedsDeref {
                tsid: leaf.to_string(),
            })
        }
        // v0 kept the bytes under `blobs/` and their metadata under `files/`; the bytes are
        // the v1 media object, so a blob id keys straight onto it.
        ("blobs", Some(leaf)) => keyed("files", leaf)?,
        (seg, Some(leaf)) if ID_SEGMENTS.contains(&seg) || LEAF_SEGMENTS.contains(&seg) => {
            keyed(seg, strip_json(leaf))?
        }
        ("profile.json", None) => "profile".to_string(),
        (seg, None) if LEAF_SEGMENTS.contains(&strip_json(seg)) => strip_json(seg).to_string(),
        _ => return None,
    };
    Some(StableId::Key(key))
}

/// The key of a `social/v1` path, from the resource the v1 parser classifies it as.
fn social_key(path: &str) -> Option<String> {
    let uri = [PROTOCOL, PLACEHOLDER_HOST, "/", path].concat();
    match crate::ParsedUri::try_from(uri.as_str()).ok()?.resource {
        crate::Resource::User => Some("profile".to_string()),
        resource => Some(format!("{resource}/{}", resource.id()?)),
    }
}

/// Completes a legacy `files/{tsid}` reference through the v0 File object's `src`
/// (`pubky://<pk>/pub/pubky.app/blobs/<hash>`) to `files/<hash>`. `None` when the src is not
/// a legacy blob reference; the caller then keys the reference verbatim, so a dangling or
/// foreign src still resolves for a reader.
///
/// The src is read with the frozen v0 parser, so a reference is completed on exactly the
/// terms v0 accepted it. The tsid does not reach the result: it is in the signature because
/// the two halves of one operation should read as a pair, and because a later policy may
/// need to know which reference it is completing.
pub fn resolve_deref(_tsid: &str, v0_file_src: &str) -> Option<String> {
    match ParsedUri::try_from(v0_file_src).ok()?.resource {
        Resource::Blob(hash) => Some(format!("files/{hash}")),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(path: &str) -> Option<String> {
        match stable_id(path) {
            Some(StableId::Key(k)) => Some(k),
            _ => None,
        }
    }

    const HASH: &str = "8Z8CWH8NVYQY39ZEBFGKQWWEKG";

    #[test]
    fn the_contract_table() {
        let cases: &[(&str, &str)] = &[
            (
                "pub/social/v1/posts/0RDX5H0000000/0RDX5J0000002.json",
                "posts/0RDX5H0000000",
            ),
            (
                "pub/social/v1/posts/0RDX5H0000000/0RDX5J0000002-hello-world.json",
                "posts/0RDX5H0000000",
            ),
            ("pub/pubky.app/posts/0RDX5H0000000", "posts/0RDX5H0000000"),
            (
                "priv/social/v1/files/8Z8CWH8NVYQY39ZEBFGKQWWEKG.jpg",
                "files/8Z8CWH8NVYQY39ZEBFGKQWWEKG",
            ),
            (
                "pub/pubky.app/blobs/8Z8CWH8NVYQY39ZEBFGKQWWEKG",
                "files/8Z8CWH8NVYQY39ZEBFGKQWWEKG",
            ),
        ];
        for (path, expected) in cases {
            assert_eq!(key(path).as_deref(), Some(*expected), "{path}");
        }
        assert_eq!(
            stable_id("pub/pubky.app/files/0RDX5H0000000"),
            Some(StableId::NeedsDeref {
                tsid: "0RDX5H0000000".to_string()
            })
        );
    }

    #[test]
    fn the_key_is_root_and_epoch_independent() {
        let one = format!("posts/{}", "0RDX5H0000000");
        for path in [
            "pub/social/v1/posts/0RDX5H0000000",
            "priv/social/v1/posts/0RDX5H0000000",
            "/pub/social/v1/posts/0RDX5H0000000",
            "pub/pubky.app/posts/0RDX5H0000000",
        ] {
            assert_eq!(key(path).as_deref(), Some(one.as_str()), "{path}");
        }
    }

    #[test]
    fn a_blobs_path_under_a_social_epoch_has_no_key() {
        // v1 has no blobs/ resource, so the parser calls the path unknown.
        for path in [
            format!("pub/social/v1/blobs/{HASH}"),
            format!("priv/social/v1/blobs/{HASH}"),
            format!("pub/social/v1/blobs/{HASH}.png"),
        ] {
            assert_eq!(stable_id(&path), None, "{path}");
        }
    }

    #[test]
    fn only_a_closed_set_extension_is_stripped() {
        assert_eq!(
            key(&format!("priv/social/v1/files/{HASH}.jpg")).as_deref(),
            Some(format!("files/{HASH}").as_str())
        );
        // The strip set is case-sensitive and takes one rightmost extension, matching the
        // parser, which then finds no canonical hash and calls the leaf unknown.
        for leaf in [
            HASH.to_string(),
            format!("{HASH}.JPG"),
            format!("{HASH}.tar.gz"),
            format!("{HASH}.tar.zip"),
        ] {
            assert_eq!(
                stable_id(&format!("priv/social/v1/files/{leaf}")),
                None,
                "{leaf}"
            );
        }
    }

    #[test]
    fn the_remaining_segments_drop_one_trailing_json() {
        let cases: &[(String, String)] = &[
            ("pub/social/v1/profile.json".into(), "profile".into()),
            ("pub/pubky.app/profile.json".into(), "profile".into()),
            (
                format!("pub/social/v1/tags/{HASH}.json"),
                format!("tags/{HASH}"),
            ),
            ("pub/pubky.app/tags/ABC".into(), "tags/ABC".into()),
            (
                format!("pub/social/v1/follows/{OWNER}.json"),
                format!("follows/{OWNER}"),
            ),
            (
                format!("priv/social/v1/mutes/{OWNER}.json"),
                format!("mutes/{OWNER}"),
            ),
            (
                format!("priv/social/v1/bookmarks/{B64}.json"),
                format!("bookmarks/{B64}"),
            ),
            (
                format!("priv/social/v1/bookmarks/~{HASH}.json"),
                format!("bookmarks/~{HASH}"),
            ),
            (
                format!("priv/social/v1/feeds/{HASH}.json"),
                format!("feeds/{HASH}"),
            ),
            (
                format!("pub/social/v1/feeds/{HASH}.json"),
                format!("feeds/{HASH}"),
            ),
            ("pub/pubky.app/last_read".into(), "last_read".into()),
            ("pub/pubky.app/settings.json".into(), "settings".into()),
        ];
        for (path, expected) in cases {
            assert_eq!(key(path).as_deref(), Some(expected.as_str()), "{path}");
        }
    }

    #[test]
    fn a_post_keys_the_same_with_or_without_a_version_leaf() {
        let versionless = key("pub/social/v1/posts/0RDX5H0000000");
        assert!(versionless.is_some());
        for leaf in ["0RDX5J0000002.json", "0RDX5J0000002-hello-world.json"] {
            assert_eq!(
                key(&format!("pub/social/v1/posts/0RDX5H0000000/{leaf}")),
                versionless,
                "{leaf}"
            );
        }
        // A leaf the parser does not read as a version is no stored object.
        for leaf in [
            "0RDX5J0000002",
            "0RDX5J0000002.JSON",
            "0RDX5J0000002-Hello.json",
            "0RDX5J000000.json",
        ] {
            assert_eq!(
                stable_id(&format!("pub/social/v1/posts/0RDX5H0000000/{leaf}")),
                None,
                "{leaf}"
            );
        }
    }

    const OWNER: &str = "operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo";
    /// base64url of a canonical pubky post reference: a primary bookmark filename.
    const B64: &str = "cHVia3k6Ly9vcGVycnI4d3NicHIzdWU5ZDRxajQxZ2Uxa2NjNnI3ZmRpeTZvM3VnanJyaGk0eTc3cmRvL3B1Yi9zb2NpYWwvdjEvcG9zdHMvMDAzMlNTTjdRNEVWRw";

    #[test]
    fn a_deref_completes_only_through_a_legacy_blob_src() {
        let tsid = "0032SSN7Q4EVG";
        assert_eq!(
            resolve_deref(tsid, &format!("pubky://{OWNER}/pub/pubky.app/blobs/{HASH}")),
            Some(format!("files/{HASH}"))
        );
        for src in [
            // The owner-relative spelling is not a URI, and v0 never stored one.
            &format!("/pub/pubky.app/blobs/{HASH}"),
            &format!("pub/pubky.app/blobs/{HASH}"),
            // An off-network src: the reference keys verbatim instead.
            "https://example.com/photo.jpg",
            // A v0 File never points into a social epoch.
            &format!("pubky://{OWNER}/pub/social/v1/files/{HASH}.jpg"),
            // A v0 File pointing at another File rather than at bytes.
            &format!("pubky://{OWNER}/pub/pubky.app/files/{tsid}"),
            "not a url",
        ] {
            assert_eq!(resolve_deref(tsid, src), None, "{src}");
        }
    }

    #[test]
    fn a_path_that_is_not_a_social_object_has_no_key() {
        for path in [
            "",
            "/",
            "pub",
            "pub/",
            "pub/social/v1/",
            "www/social/v1/profile.json",           // not a root
            "pub/other.app/posts/0RDX5H0000000",    // not an epoch
            "pub/social/posts/0RDX5H0000000",       // no version segment
            "pub/social/vX/posts/0RDX5H0000000",    // not digits
            "pub/social/v/posts/0RDX5H0000000",     // no digits
            "pub/social/v0/posts/0RDX5H0000000",    // epoch 0 spells itself as pubky.app
            "pub/social/v01/posts/0RDX5H0000000",   // a leading zero is not an epoch
            "pub/social/v2/posts/0RDX5H0000000",    // a later epoch brings its own rules
            "priv/social/v10/posts/0RDX5H0000000",  // a later epoch brings its own rules
            "pub/social/v1/last_read.json",         // app-owned in v1
            "pub/social/v1/settings.json",          // app-owned in v1
            "pub/social/v1/settings/x.json",        // app-owned in v1
            "pub/social/v1/widgets/ABC",            // unknown segment
            "pub/social/v1/posts/",                 // missing leaf
            "pub/social/v1/tags/",                  // missing leaf
            "pub/social/v1/tags",                   // missing leaf
            "pub/pubky.app/files/",                 // missing leaf
            "pub/social/v1/profile",                // the leaf is profile.json
            "pubky://x/pub/social/v1/profile.json", // not owner-relative
        ] {
            assert_eq!(stable_id(path), None, "{path}");
        }
    }

    #[test]
    fn an_empty_id_is_not_an_object() {
        // A key with an empty id would collapse every such path onto one row.
        for path in [
            "pub/social/v1/posts//0RDX5J0000002.json",
            "pub/social/v1/posts//",
            "pub/social/v1/tags/.json",
            "pub/pubky.app/settings/.json",
            "pub/social/v1/files/.png",
            "pub/social/v1/files/.jpg",
        ] {
            assert_eq!(stable_id(path), None, "{path}");
        }
    }

    #[test]
    fn a_nested_post_path_keys_only_under_the_legacy_epoch() {
        // v0 ignores what follows the id; the v1 grammar has exactly one version leaf.
        assert_eq!(
            key("pub/pubky.app/posts/0RDX5H0000000/a/b/c").as_deref(),
            Some("posts/0RDX5H0000000")
        );
        for path in [
            "pub/social/v1/posts/0RDX5H0000000/a/b/c",
            "pub/social/v1/posts/0RDX5H0000000/0RDX5J0000002.json/x",
            "priv/social/v1/posts/0RDX5H0000000/0RDX5J0000002/0RDX5J0000002.json",
            "pub/social/v1/posts/0RDX5H0000000.json",
        ] {
            assert_eq!(stable_id(path), None, "{path}");
        }
    }

    #[test]
    fn a_resource_under_the_wrong_root_has_no_key() {
        for path in [
            "priv/social/v1/profile.json".to_string(),
            format!("priv/social/v1/tags/{HASH}.json"),
            format!("priv/social/v1/follows/{OWNER}.json"),
            format!("pub/social/v1/mutes/{OWNER}.json"),
            format!("pub/social/v1/bookmarks/{B64}.json"),
            // Root spellings the grammar does not have.
            format!("Pub/social/v1/tags/{HASH}.json"),
            format!("private/social/v1/tags/{HASH}.json"),
            format!("pub/Social/v1/tags/{HASH}.json"),
            format!("pub/social/V1/tags/{HASH}.json"),
        ] {
            assert_eq!(stable_id(&path), None, "{path}");
        }
    }

    #[test]
    fn a_malformed_social_id_has_no_key() {
        for path in [
            "pub/social/v1/tags/ABC.json",
            "pub/social/v1/follows/PK.json",
            "priv/social/v1/feeds/ABC.json",
            "priv/social/v1/bookmarks/_x.json",
            "pub/social/v1/posts/0RDX5H000000",
            "pub/social/v1/posts/0rdx5h0000000",
        ] {
            assert_eq!(stable_id(path), None, "{path}");
        }
    }

    #[test]
    fn a_v0_leaf_ignores_an_extra_segment_the_way_the_v0_parser_does() {
        // The v0 parser matches [resource, id, ..] and keys on the id, so dropping these
        // would lose objects that v0 itself accepted.
        assert_eq!(
            stable_id(&format!("pub/pubky.app/files/{HASH}/extra")),
            Some(StableId::NeedsDeref {
                tsid: HASH.to_string()
            })
        );
        let cases: &[(&str, &str)] = &[
            ("pub/pubky.app/tags/ABC/x", "tags/ABC"),
            ("pub/pubky.app/tags/ABC/", "tags/ABC"),
            ("pub/pubky.app/bookmarks/ABC/x/y", "bookmarks/ABC"),
            ("pub/pubky.app/follows/PK/x", "follows/PK"),
            ("pub/pubky.app/blobs/ABC/x", "files/ABC"),
        ];
        for (path, expected) in cases {
            assert_eq!(key(path).as_deref(), Some(*expected), "{path}");
        }
        // An empty first segment is still no object, and the v0 tree had no private root.
        for path in [
            "priv/pubky.app/bookmarks/ABC",
            "pub/pubky.app/tags//x",
            "pub/pubky.app/files//extra",
            "pub/pubky.app/posts//x",
        ] {
            assert_eq!(stable_id(path), None, "{path}");
        }
    }

    #[test]
    fn a_social_epoch_leaf_may_not_be_a_path() {
        // The v1 parser rejects the extra segment, so nothing was ever stored there.
        for path in [
            &format!("pub/social/v1/tags/{HASH}/"),
            &format!("pub/social/v1/files/{HASH}.png/x"),
            &format!("pub/social/v1/blobs/{HASH}/x"),
            &format!("pub/social/v1/follows/{HASH}/x"),
            "pub/social/v1/profile.json/x",
            "pub/pubky.app/profile.json/x",
        ] {
            assert_eq!(stable_id(path), None, "{path}");
        }
    }
}
