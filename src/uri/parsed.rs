use crate::canonicalize::canonicalize_pubky_uri;
use crate::common::{validate_hash_id_format, validate_timestamp_id_format};
use crate::constants::{
    epoch_segment, social_path, PRIVATE_ROOT, PROTOCOL, PUBLIC_ROOT, SOCIAL_NAMESPACE,
};
use crate::mime::STRIP_SET;
use crate::models::user::PubkySocialUser;
use crate::traits::{HasPath, Root};
use crate::types::PubkyId;
use crate::uri::resource::Resource;
use crate::VALIDATION_LIMITS;
use serde::{Deserialize, Serialize};

/// Which root a parsed path lives under.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Visibility {
    Public,
    Private,
}

impl Visibility {
    pub fn root(&self) -> Root {
        match self {
            Visibility::Public => Root::Pub,
            Visibility::Private => Root::Priv,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ParsedUri {
    pub user_id: PubkyId,
    pub visibility: Visibility,
    pub resource: Resource,
}

impl ParsedUri {
    /// Rebuilds the canonical URI string, and refuses any value the grammar cannot produce:
    /// the emitted string is reparsed and must classify back to the same value, so a
    /// hand-built or deserialized `ParsedUri` with a wrong root, a malformed id or an
    /// unspeakable shape returns `Err` instead of a lying string. `Unknown` and
    /// `UnsupportedVersion` cannot be spelled at all.
    pub fn try_to_uri_str(&self) -> Result<String, String> {
        let root = self.visibility.root();
        let leaf = match &self.resource {
            Resource::User => {
                if root == Root::Priv {
                    return Err("the profile lives under the public root".to_string());
                }
                PubkySocialUser::PATH_SEGMENT.to_string()
            }
            Resource::Post { id, version, label } => match (version, label) {
                (None, Some(_)) => {
                    return Err("a label without a version cannot be spelled".to_string())
                }
                (None, None) => format!("posts/{id}"),
                (Some(v), None) => format!("posts/{id}/{v}.json"),
                (Some(v), Some(l)) => format!("posts/{id}/{v}-{l}.json"),
            },
            Resource::Follow(pk) => format!("follows/{pk}.json"),
            Resource::Mute(pk) => {
                if root == Root::Pub {
                    return Err("mutes live under the private root".to_string());
                }
                format!("mutes/{pk}.json")
            }
            Resource::Bookmark(filename) => {
                if root == Root::Pub {
                    return Err("bookmarks live under the private root".to_string());
                }
                format!("bookmarks/{filename}.json")
            }
            Resource::Tag(id) => format!("tags/{id}.json"),
            Resource::File(filename) => format!("files/{filename}"),
            Resource::Feed(id) => format!("feeds/{id}.json"),
            Resource::Foreign {
                namespace,
                version,
                rest,
            } => {
                let mut segs = vec![namespace.clone()];
                if let Some(v) = version {
                    segs.push(v.clone());
                }
                segs.extend(rest.iter().cloned());
                let path = ["/", root.segment(), "/", &segs.join("/")].concat();
                return self.verify_emitted([PROTOCOL, self.user_id.as_ref(), &path].concat());
            }
            Resource::UnsupportedVersion { .. } => {
                return Err("an unsupported epoch does not carry its path".to_string())
            }
            Resource::Unknown => return Err("Cannot convert Unknown resource to URI".to_string()),
        };
        let path = social_path(root, &leaf);
        let out = [PROTOCOL, self.user_id.as_ref(), &path].concat();
        self.verify_emitted(out)
    }

    /// The single validation boundary for emitted strings: reparse and compare.
    fn verify_emitted(&self, out: String) -> Result<String, String> {
        match ParsedUri::try_from(out.as_str()) {
            Ok(reparsed) if reparsed == *self => Ok(out),
            _ => Err(format!("value cannot be spelled canonically: {out}")),
        }
    }
}

fn is_epoch_segment(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 2 && b[0] == b'v' && b[1..].iter().all(u8::is_ascii_digit)
}

/// The optional readable tail of a post version leaf: 1 to 64 chars of `[a-z0-9-]`.
pub(crate) fn is_valid_label(l: &str) -> bool {
    !l.is_empty()
        && l.len() <= VALIDATION_LIMITS.post_slug_max_length
        && l.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Splits a post version leaf: strips `.json`, then splits at the FIRST `-`. The head must be
/// a canonical TimestampId; the optional tail is the label.
pub(crate) fn parse_version_leaf(leaf: &str) -> Option<(String, Option<String>)> {
    let stem = leaf.strip_suffix(".json")?;
    let (version, label) = match stem.split_once('-') {
        Some((v, l)) if is_valid_label(l) => (v, Some(l.to_string())),
        Some(_) => return None,
        None => (stem, None),
    };
    validate_timestamp_id_format(version).ok()?;
    Some((version.to_string(), label))
}

/// The pre-dot part of a media filename when its rightmost extension is in the closed strip
/// set, else `None`. Case-sensitive: `.JPG` is not the same extension as `.jpg`.
pub(crate) fn media_stem(filename: &str) -> Option<&str> {
    match filename.rsplit_once('.') {
        Some((hash, ext)) if STRIP_SET.contains(&ext) => Some(hash),
        _ => None,
    }
}

/// The id of a raw media filename. The one strip the parser, `Resource::id()` and the object
/// dispatch all share, so recompute-and-compare cannot disagree with the path.
pub(crate) fn strip_media_ext(filename: &str) -> &str {
    media_stem(filename).unwrap_or(filename)
}

/// Unpadded base64url of the longest target the primary form carries: 187 bytes become 250
/// characters, which with `.json` is the 255-character segment maximum.
const BOOKMARK_FILENAME_MAX: usize =
    (VALIDATION_LIMITS.bookmark_target_uri_max_bytes * 4).div_ceil(3);

/// The FORM of a bookmark filename: `~` plus a canonical HashId for the overflow form, an
/// unpadded base64url string of a length base64 can actually produce for the primary one
/// (4n+1 characters never encode anything). A leading `_` is reserved across every leaf, and
/// it happens to be a base64url character, so the primary arm refuses it there and accepts it
/// anywhere else in the name. Only the form: the decode round trip that recovers the target
/// runs when the object is read.
pub(crate) fn is_bookmark_filename(name: &str) -> bool {
    match name.strip_prefix('~') {
        Some(hash) => validate_hash_id_format(hash).is_ok(),
        None => {
            !name.is_empty()
                && !name.starts_with('_')
                && name.len() <= BOOKMARK_FILENAME_MAX
                && name.len() % 4 != 1
                && name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        }
    }
}

/// Time bounds never run here: parser verdicts must not depend on the wall clock. The
/// object validator bounds the post id when the object is read.
///
/// Adding a resource touches SIX surfaces the compiler will not connect for you: this
/// dispatch (pattern, root, `.json` strip, id check), the emitter leaf in `try_to_uri_str`,
/// `Display` and `id()` in `resource.rs`, `from_resource` in `models/mod.rs`, the builder in
/// `builders.rs`, and the model's `create_path`. The emit-reparse boundary and the
/// `every_speakable_value_round_trips` test catch a mismatch; add your vectors to both tables.
fn dispatch(root: Root, rest: &[&str]) -> Resource {
    match (root, rest) {
        (Root::Pub, ["profile.json"]) => Resource::User,
        // The versionless reference takes no extension: posts/{id}.json is Unknown.
        (_, ["posts", id]) if validate_timestamp_id_format(id).is_ok() => Resource::Post {
            id: (*id).into(),
            version: None,
            label: None,
        },
        (_, ["posts", id, leaf]) if validate_timestamp_id_format(id).is_ok() => {
            match parse_version_leaf(leaf) {
                Some((version, label)) => Resource::Post {
                    id: (*id).into(),
                    version: Some(version),
                    label,
                },
                None => Resource::Unknown,
            }
        }
        // files (media): strip exactly one rightmost extension, only when it is in the closed
        // strip set, then require a canonical HashId. An unknown or absent extension is left
        // intact and fails id validation. The payload stays the RAW filename.
        (_, ["files", leaf]) => match media_stem(leaf) {
            Some(hash) if validate_hash_id_format(hash).is_ok() => Resource::File((*leaf).into()),
            _ => Resource::Unknown,
        },
        (_, ["feeds", leaf]) => match leaf.strip_suffix(".json") {
            Some(id) if validate_hash_id_format(id).is_ok() => Resource::Feed(id.into()),
            _ => Resource::Unknown,
        },
        (Root::Pub, ["tags", leaf]) => match leaf.strip_suffix(".json") {
            Some(id) if validate_hash_id_format(id).is_ok() => Resource::Tag(id.into()),
            _ => Resource::Unknown,
        },
        (Root::Pub, ["follows", leaf]) => match leaf.strip_suffix(".json") {
            Some(pk) => match PubkyId::try_from(pk) {
                Ok(pk) => Resource::Follow(pk),
                Err(_) => Resource::Unknown,
            },
            _ => Resource::Unknown,
        },
        (Root::Priv, ["mutes", leaf]) => match leaf.strip_suffix(".json") {
            Some(pk) => match PubkyId::try_from(pk) {
                Ok(pk) => Resource::Mute(pk),
                Err(_) => Resource::Unknown,
            },
            _ => Resource::Unknown,
        },
        (Root::Priv, ["bookmarks", leaf]) => match leaf.strip_suffix(".json") {
            Some(name) if is_bookmark_filename(name) => Resource::Bookmark(name.into()),
            _ => Resource::Unknown,
        },
        // Wrong root, missing or extra segments, `_`-prefixed leaves, unrecognized names.
        _ => Resource::Unknown,
    }
}

impl TryFrom<&str> for ParsedUri {
    type Error = String;

    fn try_from(uri: &str) -> Result<Self, Self::Error> {
        let canonical = canonicalize_pubky_uri(uri)
            .map_err(|_| format!("Validation Error: Not a canonical pubky URI: {uri}"))?;
        // Offsets are safe: the prefix is ASCII and the host was validated as a PubkyId.
        let rest = &canonical["pubky://".len()..];
        let (host, path) = match rest.find('/') {
            Some(i) => (&rest[..i], Some(&rest[i + 1..])),
            None => (rest, None),
        };
        let user_id = PubkyId::try_from(host).expect("host was validated by the canonicalizer");
        let Some(path) = path else {
            return Ok(ParsedUri {
                user_id,
                visibility: Visibility::Public,
                resource: Resource::User,
            });
        };
        let segments: Vec<&str> = path.split('/').collect();
        let visibility = match segments.first() {
            Some(&s) if s == PUBLIC_ROOT => Visibility::Public,
            Some(&s) if s == PRIVATE_ROOT => Visibility::Private,
            _ => return Err(format!("Validation Error: Unknown root in URI: {uri}")),
        };
        let resource = match segments.get(1) {
            None => Resource::Unknown,
            Some(&ns) if ns != SOCIAL_NAMESPACE => {
                // A namespace SHOULD carry an epoch as its second segment; surface it only
                // when it is epoch-shaped, otherwise the segment stays in `rest`.
                let (version, rest_from) = match segments.get(2) {
                    Some(&e) if is_epoch_segment(e) => (Some(e.to_string()), 3),
                    _ => (None, 2),
                };
                Resource::Foreign {
                    namespace: ns.to_string(),
                    version,
                    rest: segments
                        .get(rest_from..)
                        .unwrap_or(&[])
                        .iter()
                        .map(|s| s.to_string())
                        .collect(),
                }
            }
            Some(_) => match segments.get(2) {
                None => Resource::Unknown,
                Some(&e) if e == epoch_segment() => {
                    dispatch(visibility.root(), segments.get(3..).unwrap_or(&[]))
                }
                Some(&e) if is_epoch_segment(e) => Resource::UnsupportedVersion {
                    version: e.to_string(),
                },
                Some(_) => Resource::Unknown,
            },
        };
        Ok(ParsedUri {
            user_id,
            visibility,
            resource,
        })
    }
}

impl TryFrom<String> for ParsedUri {
    type Error = String;

    fn try_from(uri: String) -> Result<Self, Self::Error> {
        ParsedUri::try_from(uri.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{post::PubkySocialPost, user::PubkySocialUser};
    use crate::traits::{HasIdPath, HasPath, PUB_CTX};
    use crate::uri::builders::{
        list_prefix_builder, post_uri_builder, private_list_prefix_builder, user_uri_builder,
    };
    use crate::PubkySocialObject;

    const HOST: &str = "operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo";
    const TS: &str = "0032SSN7Q4EVG";
    const TS2: &str = "0034A0X7NJ52G";
    const H26: &str = "8Z8CWH8NVYQY39ZEBFGKQWWEKG";
    /// base64url of a canonical pubky post reference: the primary bookmark form.
    const B64: &str = "cHVia3k6Ly9vcGVycnI4d3NicHIzdWU5ZDRxajQxZ2Uxa2NjNnI3ZmRpeTZvM3VnanJyaGk0eTc3cmRvL3B1Yi9zb2NpYWwvdjEvcG9zdHMvMDAzMlNTTjdRNEVWRw";

    fn p(path: &str) -> String {
        format!("pubky://{HOST}{path}")
    }

    fn pk() -> PubkyId {
        PubkyId::try_from(HOST).unwrap()
    }

    fn post(id: &str, version: Option<&str>, label: Option<&str>) -> Resource {
        Resource::Post {
            id: id.into(),
            version: version.map(Into::into),
            label: label.map(Into::into),
        }
    }

    /// The classification table. `None` expected = hard error.
    #[rustfmt::skip]
    fn vectors() -> Vec<(String, Option<(Visibility, Resource)>)> {
        use Visibility::{Private, Public};
        let label64 = "a".repeat(64);
        let label65 = "a".repeat(65);
        vec![
            // Accepted forms and the post family
            (p(""), Some((Public, Resource::User))),
            (format!("pubky{HOST}"), Some((Public, Resource::User))),
            (format!("pubky{HOST}/pub/social/v1/profile.json"), Some((Public, Resource::User))),
            (p("/pub/social/v1/profile.json"), Some((Public, Resource::User))),
            (p(&format!("/pub/social/v1/posts/{TS}")), Some((Public, post(TS, None, None)))),
            (p(&format!("/pub/social/v1/posts/{TS}/{TS}.json")), Some((Public, post(TS, Some(TS), None)))),
            (p(&format!("/priv/social/v1/posts/{TS}/{TS2}.json")), Some((Private, post(TS, Some(TS2), None)))),
            (p(&format!("/pub/social/v1/posts/{TS}.json")), Some((Public, Resource::Unknown))),
            (p(&format!("/pub/social/v1/posts/{TS}/{TS2}")), Some((Public, Resource::Unknown))),
            (p("/pub/social/v1/posts/0032ssn7q4evg"), Some((Public, Resource::Unknown))),
            (p("/pub/social/v1/posts/O032SSN7Q4EVG"), Some((Public, Resource::Unknown))),
            (p(&format!("/pub/social/v1/posts/{TS}/{TS}.json/x")), Some((Public, Resource::Unknown))),
            // The optional version label
            (p(&format!("/pub/social/v1/posts/{TS}/{TS2}-hello-world.json")), Some((Public, post(TS, Some(TS2), Some("hello-world"))))),
            (p(&format!("/pub/social/v1/posts/{TS}/{TS2}-a-b.json")), Some((Public, post(TS, Some(TS2), Some("a-b"))))),
            (p(&format!("/pub/social/v1/posts/{TS}/{TS}-hello.json")), Some((Public, post(TS, Some(TS), Some("hello"))))),
            (p(&format!("/pub/social/v1/posts/{TS}/{TS2}-Hello.json")), Some((Public, Resource::Unknown))),
            (p(&format!("/pub/social/v1/posts/{TS}/{TS2}-.json")), Some((Public, Resource::Unknown))),
            (p(&format!("/pub/social/v1/posts/{TS}/{TS2}-{label64}.json")), Some((Public, post(TS, Some(TS2), Some(&label64))))),
            (p(&format!("/pub/social/v1/posts/{TS}/{TS2}-{label65}.json")), Some((Public, Resource::Unknown))),
            (p(&format!("/pub/social/v1/posts/{TS}/{TS2}-h_llo.json")), Some((Public, Resource::Unknown))),
            (p(&format!("/pub/social/v1/posts/{TS}/{TS2}-héllo.json")), Some((Public, Resource::Unknown))),
            // Tags, follows, mutes, bookmarks
            (p(&format!("/pub/social/v1/tags/{H26}.json")), Some((Public, Resource::Tag(H26.into())))),
            (p(&format!("/pub/social/v1/tags/{H26}")), Some((Public, Resource::Unknown))),
            (p(&format!("/priv/social/v1/tags/{H26}.json")), Some((Private, Resource::Unknown))),
            (p("/pub/social/v1/tags/8Z8CWH8NVYQY39ZEBFGKQWWEK.json"), Some((Public, Resource::Unknown))),
            (p(&format!("/pub/social/v1/follows/{HOST}.json")), Some((Public, Resource::Follow(pk())))),
            (p(&format!("/pub/social/v1/follows/{}.json", HOST.to_uppercase())), Some((Public, Resource::Unknown))),
            (p(&format!("/priv/social/v1/mutes/{HOST}.json")), Some((Private, Resource::Mute(pk())))),
            (p(&format!("/priv/social/v1/bookmarks/{B64}.json")), Some((Private, Resource::Bookmark(B64.into())))),
            (p(&format!("/priv/social/v1/bookmarks/~{H26}.json")), Some((Private, Resource::Bookmark(format!("~{H26}"))))),
            (p(&format!("/priv/social/v1/bookmarks/~{H26}")), Some((Private, Resource::Unknown))),
            (p(&format!("/priv/social/v1/bookmarks/~{}.json", &H26[..25])), Some((Private, Resource::Unknown))),
            (p(&format!("/priv/social/v1/bookmarks/{B64}=.json")), Some((Private, Resource::Unknown))),
            (p("/priv/social/v1/bookmarks/cHVia3k+.json"), Some((Private, Resource::Unknown))),
            (p("/priv/social/v1/bookmarks/.json"), Some((Private, Resource::Unknown))),
            (p("/priv/social/v1/bookmarks/a.json"), Some((Private, Resource::Unknown))),
            (p("/priv/social/v1/bookmarks/_a.json"), Some((Private, Resource::Unknown))),
            // base64url of "https://example.com/?q=1": a `_` anywhere but the front is a byte
            (p("/priv/social/v1/bookmarks/aHR0cHM6Ly9leGFtcGxlLmNvbS8_cT0x.json"), Some((Private, Resource::Bookmark("aHR0cHM6Ly9leGFtcGxlLmNvbS8_cT0x".into())))),
            (p(&format!("/priv/social/v1/bookmarks/{}.json", "a".repeat(250))), Some((Private, Resource::Bookmark("a".repeat(250))))),
            (p(&format!("/priv/social/v1/bookmarks/{}.json", "a".repeat(251))), Some((Private, Resource::Unknown))),
            // Media: the hash carries a path-only extension, dual-root
            (p(&format!("/pub/social/v1/files/{H26}.svg")), Some((Public, Resource::File(format!("{H26}.svg"))))),
            (p(&format!("/priv/social/v1/files/{H26}.svg")), Some((Private, Resource::File(format!("{H26}.svg"))))),
            (p(&format!("/pub/social/v1/files/{H26}.bin")), Some((Public, Resource::File(format!("{H26}.bin"))))),
            // A JSON document uploaded as media is legal: `json` is a media extension
            (p(&format!("/pub/social/v1/files/{H26}.json")), Some((Public, Resource::File(format!("{H26}.json"))))),
            (p(&format!("/pub/social/v1/files/{H26}.JPG")), Some((Public, Resource::Unknown))),
            (p(&format!("/pub/social/v1/files/{H26}.tar.gz")), Some((Public, Resource::Unknown))),
            (p(&format!("/pub/social/v1/files/{H26}")), Some((Public, Resource::Unknown))),
            (p(&format!("/pub/social/v1/files/{TS}.json")), Some((Public, Resource::Unknown))),
            (p(&format!("/pub/social/v1/blobs/{H26}")), Some((Public, Resource::Unknown))),
            (p(&format!("/priv/social/v1/blobs/{H26}")), Some((Private, Resource::Unknown))),
            // Feeds are dual-root already
            (p(&format!("/pub/social/v1/feeds/{H26}.json")), Some((Public, Resource::Feed(H26.into())))),
            (p(&format!("/priv/social/v1/feeds/{H26}.json")), Some((Private, Resource::Feed(H26.into())))),
            // Gone or reserved leaves (classify Unknown, never error)
            (p("/pub/social/v1/last_read.json"), Some((Public, Resource::Unknown))),
            (p("/priv/social/v1/settings.json"), Some((Private, Resource::Unknown))),
            (p("/priv/social/v1/_migrated.json"), Some((Private, Resource::Unknown))),
            // Epoch handling
            (p(&format!("/pub/social/v2/posts/{TS}")), Some((Public, Resource::UnsupportedVersion { version: "v2".into() }))),
            (p(&format!("/pub/social/V1/posts/{TS}")), Some((Public, Resource::Unknown))),
            (p("/pub/social/version2/x"), Some((Public, Resource::Unknown))),
            (p("/pub/social"), Some((Public, Resource::Unknown))),
            (p("/pub"), Some((Public, Resource::Unknown))),
            // Foreign namespaces
            (p(&format!("/pub/pubky.app/posts/{TS}")), Some((Public, Resource::Foreign { namespace: "pubky.app".into(), version: None, rest: vec!["posts".into(), TS.into()] }))),
            (p("/priv/app.pubky/v1/settings.json"), Some((Private, Resource::Foreign { namespace: "app.pubky".into(), version: Some("v1".into()), rest: vec!["settings.json".into()] }))),
            (p("/priv/app.pubky/v1/last_read.json"), Some((Private, Resource::Foreign { namespace: "app.pubky".into(), version: Some("v1".into()), rest: vec!["last_read.json".into()] }))),
            (p("/pub/日本語/データ"), Some((Public, Resource::Foreign { namespace: "日本語".into(), version: None, rest: vec!["データ".into()] }))),
            // Hard errors: only canonicalization failures and an unknown root
            (p("/dav/social/v1/profile.json"), None),
            (format!("Pubky://{HOST}/pub/social/v1/profile.json"), None),
            (format!("https://{HOST}/pub/social/v1/profile.json"), None),
            (format!("pubky://user@{HOST}/pub/x"), None),
            (format!("pubky://{HOST}:8080/pub/x"), None),
            (format!("pubky://{}", &HOST[..51]), None),
            (p("/"), None),
            (p("/pub//social/v1"), None),
            (p("/pub/social/v1/posts/../profile.json"), None),
            (p("/pub/social/v1/ta%67s/x.json"), None),
            (p("/pub/social/v1/tags/a?b.json"), None),
            (p("/pub/social/v1/tags/a#b.json"), None),
            (p("/pub/social/v1/tags/a b.json"), None),
            (p("/pub/social/v1/tags/a\u{3000}b.json"), None),
            (p("/pub/social/v1/tags/a\u{0009}b.json"), None),
            (format!("pubky://{}b", &HOST[..51]), None),
            (p("/pub/social/v1/posts/0032SSN7Q4EVD"), Some((Public, Resource::Unknown))),
            (p("/pub/social/v1/tags/8Z8CWH8NVYQY39ZEBFGKQWWEKZ.json"), Some((Public, Resource::Unknown))),
            (p("/pub/social/v1/posts/_x"), Some((Public, Resource::Unknown))),
            (p("/pub/social/v1/tags/_a.json"), Some((Public, Resource::Unknown))),
            (p("/pub/acme/a*b(1)~"), Some((Public, Resource::Foreign { namespace: "acme".into(), version: None, rest: vec!["a*b(1)~".into()] }))),
(p("/pub/acme/a\\b"), Some((Public, Resource::Foreign { namespace: "acme".into(), version: None, rest: vec!["a\\b".into()] }))),
            (format!("pubky://{}/pub/social/v1/profile.json", HOST.to_uppercase()), None),
            (p("/priv/social/v1/profile.json"), Some((Private, Resource::Unknown))),
            (p(&format!("/priv/social/v1/follows/{HOST}.json")), Some((Private, Resource::Unknown))),
            (p(&format!("/pub/social/v1/mutes/{HOST}.json")), Some((Public, Resource::Unknown))),
            (p(&format!("/pub/social/v1/bookmarks/{B64}.json")), Some((Public, Resource::Unknown))),
            (p(&format!("/pub/social/v1/blobs/{H26}.json")), Some((Public, Resource::Unknown))),
            (p(&format!("/pub/social/v1/feeds/{H26}")), Some((Public, Resource::Unknown))),
            (p(&format!("/pub/social/v1/posts/{TS}/{TS2}.json.json")), Some((Public, Resource::Unknown))),
            (p(&format!("/pub/social/v1/posts/{TS}/.json")), Some((Public, Resource::Unknown))),
            (p(&format!("/pub/social/v1/posts/{TS}/{TS2}--a.json")), Some((Public, post(TS, Some(TS2), Some("-a"))))),
            (p(&format!("/pub/social/v1/posts/{TS}/{TS2}-a-.json")), Some((Public, post(TS, Some(TS2), Some("a-"))))),
            (p(&format!("/pub/social/v1/posts/{TS}/{TS2}-2col-9.json")), Some((Public, post(TS, Some(TS2), Some("2col-9"))))),
            (p(&format!("/pub/social/v0/posts/{TS}")), Some((Public, Resource::UnsupportedVersion { version: "v0".into() }))),
            (p(&format!("/pub/social/v01/posts/{TS}")), Some((Public, Resource::UnsupportedVersion { version: "v01".into() }))),
            (p("/pub/social/v/x"), Some((Public, Resource::Unknown))),
            (p("/pub/x"), Some((Public, Resource::Foreign { namespace: "x".into(), version: None, rest: vec![] }))),
        ]
    }

    #[test]
    fn classification_table() {
        for (input, expected) in vectors() {
            let got = ParsedUri::try_from(input.as_str());
            match expected {
                None => assert!(got.is_err(), "expected a hard error: {input}"),
                Some((vis, res)) => {
                    let parsed = got.unwrap_or_else(|e| panic!("{input}: {e}"));
                    assert_eq!(parsed.visibility, vis, "{input}");
                    assert_eq!(parsed.resource, res, "{input}");
                }
            }
        }
    }

    #[test]
    fn round_trips() {
        for (input, expected) in vectors() {
            let Some((_, res)) = expected else { continue };
            let parsed = ParsedUri::try_from(input.as_str()).unwrap();
            match res {
                Resource::Unknown | Resource::UnsupportedVersion { .. } => {
                    assert!(parsed.try_to_uri_str().is_err(), "{input}");
                }
                Resource::User => {
                    // Bare-host inputs cannot string-round-trip to profile.json; the value must.
                    let emitted = parsed.try_to_uri_str().unwrap();
                    if input.contains("profile.json") {
                        assert_eq!(emitted, crate::canonicalize_pubky_uri(&input).unwrap());
                    }
                    let reparsed = ParsedUri::try_from(emitted.as_str()).unwrap();
                    assert_eq!(reparsed, parsed, "{input}");
                }
                _ => {
                    let canonical = crate::canonicalize_pubky_uri(&input).unwrap();
                    assert_eq!(parsed.try_to_uri_str().unwrap(), canonical, "{input}");
                }
            }
        }
    }

    #[test]
    fn no_panic_on_junk() {
        let long_seg = format!("pubky://{HOST}/{}", "x".repeat(5000));
        for junk in [
            "",
            "pubky",
            "pubky:",
            "pubky://",
            "///",
            "pubkyé",
            "pubky://\u{0000}",
            long_seg.as_str(),
        ] {
            let _ = ParsedUri::try_from(junk);
        }
    }

    /// The two-hard-error-class rule as a property: any grammar-safe path under a valid root
    /// classifies Ok, whatever the classification is.
    #[test]
    fn any_safe_path_classifies() {
        let pool = [
            "a",
            "posts",
            "social",
            "v1",
            "v2",
            "_x",
            "\u{65e5}\u{672c}",
            "a-b",
            "x.json",
            "~",
            "(1)",
            "a*b",
            "a\\b",
            "0032SSN7Q4EVG",
        ];
        for root in ["pub", "priv"] {
            for seg_a in pool {
                assert!(ParsedUri::try_from(p(&format!("/{root}/{seg_a}")).as_str()).is_ok());
                for seg_b in pool {
                    assert!(
                        ParsedUri::try_from(p(&format!("/{root}/{seg_a}/{seg_b}")).as_str())
                            .is_ok()
                    );
                }
            }
        }
        // And only the two classes may error: a bad root errs whatever follows.
        for seg in pool {
            assert!(ParsedUri::try_from(p(&format!("/dav/{seg}")).as_str()).is_err());
        }
    }

    /// One value of every speakable variant: emitted, reparsed, equal.
    #[test]
    fn every_speakable_value_round_trips() {
        let values = [
            (Visibility::Public, Resource::User),
            (Visibility::Public, post(TS, None, None)),
            (Visibility::Private, post(TS, Some(TS2), Some("hello"))),
            (Visibility::Public, Resource::Follow(pk())),
            (Visibility::Private, Resource::Mute(pk())),
            (Visibility::Private, Resource::Bookmark(B64.into())),
            (Visibility::Public, Resource::Tag(H26.into())),
            (Visibility::Private, Resource::File(format!("{H26}.svg"))),
            (Visibility::Private, Resource::Feed(H26.into())),
            (
                Visibility::Public,
                Resource::Foreign {
                    namespace: "acme".into(),
                    version: Some("v3".into()),
                    rest: vec!["x.json".into()],
                },
            ),
        ];
        for (visibility, resource) in values {
            let value = ParsedUri {
                user_id: pk(),
                visibility,
                resource,
            };
            let emitted = value.try_to_uri_str().unwrap();
            assert_eq!(ParsedUri::try_from(emitted.as_str()).unwrap(), value);
        }
    }

    /// Hand-built and deserialized values the grammar cannot produce are refused, not spelled.
    #[test]
    fn unspeakable_values_are_refused() {
        let cases = [
            (Visibility::Private, Resource::User),
            (Visibility::Public, Resource::Mute(pk())),
            (Visibility::Public, Resource::Bookmark(B64.into())),
            (Visibility::Private, Resource::Bookmark("a=b".into())),
            (Visibility::Private, Resource::Tag(H26.into())),
            (Visibility::Public, Resource::Tag("bad".into())),
            (Visibility::Public, post(TS, None, Some("orphan"))),
            (Visibility::Public, post(TS, Some("nope"), None)),
            (Visibility::Public, post(TS, Some(TS2), Some("Bad_Label"))),
            (Visibility::Public, Resource::File(format!("{H26}.JPG"))),
            (Visibility::Public, Resource::File(H26.into())),
        ];
        for (i, (visibility, resource)) in cases.into_iter().enumerate() {
            let value = ParsedUri {
                user_id: pk(),
                visibility,
                resource,
            };
            assert!(value.try_to_uri_str().is_err(), "case {i} was spelled");
        }
        // Through serde, the way real callers build impossible values.
        let json = format!(
            r#"{{"user_id":"{HOST}","visibility":"public","resource":{{"Post":{{"id":"{TS}","version":null,"label":"x"}}}}}}"#
        );
        let value: ParsedUri = serde_json::from_str(&json).unwrap();
        assert!(value.try_to_uri_str().is_err());
        // A Foreign whose spelling would reclassify: an epoch-shaped first rest segment.
        let value = ParsedUri {
            user_id: pk(),
            visibility: Visibility::Public,
            resource: Resource::Foreign {
                namespace: "acme".into(),
                version: None,
                rest: vec!["v1".into(), "y".into()],
            },
        };
        assert!(value.try_to_uri_str().is_err());
    }

    #[test]
    fn versionless_reference_is_never_a_stored_object() {
        let err =
            PubkySocialObject::from_resource(&post(TS, None, None), b"{}", &PUB_CTX).unwrap_err();
        assert!(err.contains("versionless"), "{err}");
        let body = br#"{"content":"x","kind":"note","parent":null,"embed":null,"attachments":[]}"#;
        assert!(
            PubkySocialObject::from_resource(&post(TS, Some(TS), None), body, &PUB_CTX).is_ok()
        );
    }

    #[test]
    fn create_paths_and_builders() {
        assert_eq!(
            PubkySocialUser::create_path(),
            "/pub/social/v1/profile.json"
        );
        assert_eq!(
            PubkySocialPost::create_path(TS),
            format!("/pub/social/v1/posts/{TS}/{TS}.json")
        );
        assert_eq!(
            post_uri_builder(HOST.into(), TS.into()),
            format!("pubky://{HOST}/pub/social/v1/posts/{TS}")
        );
        assert_eq!(
            list_prefix_builder(HOST.into()),
            format!("pubky://{HOST}/pub/social/v1/")
        );
        assert_eq!(
            private_list_prefix_builder(HOST.into()),
            format!("pubky://{HOST}/priv/social/v1/")
        );
    }

    #[test]
    fn display_and_id() {
        assert_eq!(post(TS, Some(TS2), Some("x")).to_string(), "posts");
        assert_eq!(post(TS, Some(TS2), Some("x")).id(), Some(TS.to_string()));
        assert_eq!(
            Resource::File(format!("{H26}.svg")).id(),
            Some(H26.to_string())
        );
        // An extension outside the strip set is not an extension: the id keeps it, and
        // recompute-and-compare then rejects the file
        assert_eq!(
            Resource::File(format!("{H26}.JPG")).id(),
            Some(format!("{H26}.JPG"))
        );
        assert_eq!(
            Resource::Foreign {
                namespace: "x".into(),
                version: None,
                rest: vec![]
            }
            .to_string(),
            "foreign"
        );
        assert_eq!(
            Resource::UnsupportedVersion {
                version: "v2".into()
            }
            .to_string(),
            "unsupported_version"
        );
        assert_eq!(
            Resource::UnsupportedVersion {
                version: "v2".into()
            }
            .id(),
            None
        );
        assert_eq!(
            user_uri_builder(pk().to_string()),
            p("/pub/social/v1/profile.json")
        );
    }
}
