//! What a sub-spec builds its kinds from. A sub-spec is an app's own kind set on the shared
//! [`PostEnvelope`], stored under `/{pub,priv}/<namespace>/v1/posts/{id}/{editId}.json`; its
//! crate implements [`PostKind`] and takes everything else from here, so every namespace reads
//! the envelope, words a refusal and spells a path the way social does. `docs/SUBSPECS.md` holds
//! the conventions; this module holds the code they share.
//!
//! The envelope mechanics (the reference gate, the attachment caps, the preserved `extra` map,
//! the byte cap, the id mint, the versioned layout) are [`PostEnvelope`]'s and identical under
//! every namespace. The place conventions are [`crate::places`], the JSCalendar values
//! [`crate::jscalendar`].

use crate::canonicalize::is_canonical_segment;
use crate::constants::{epoch_segment, SOCIAL_NAMESPACE};
use crate::models::post::{PostEnvelope, PostKind};
use crate::traits::{Root, Validatable, ValidationCtx};
use crate::types::PubkyId;
use crate::uri::{parse_version_leaf, ParsedUri, Resource, Visibility};
use serde::de::DeserializeOwned;

pub use crate::common::{check_extra, json_error, trimmed_or_none};

/// The wire names of a sub-spec's closed set (its kinds, or a member like a listing's `state`),
/// as social spells its own: a known name reads as its variant, any other is kept in `Unknown`
/// with its spelling, so a reader survives a newer writer and writes the name back. Implements
/// `is_known`, `wire_name`, `Display` and the two `String` conversions the enum's
/// `#[serde(from = "String", into = "String")]` needs; the enum declares `Unknown(String)`.
///
/// ```
/// use serde::{Deserialize, Serialize};
///
/// #[derive(Serialize, Deserialize, Default, Debug, Clone, PartialEq)]
/// #[serde(from = "String", into = "String")]
/// pub enum Kind {
///     #[default]
///     Route,
///     Unknown(String),
/// }
/// pubky_social_specs::subspec_names!(Kind { Route => "route" });
///
/// assert_eq!(serde_json::to_string(&Kind::Route).unwrap(), r#""route""#);
/// let newer: Kind = serde_json::from_str(r#""track""#).unwrap();
/// assert!(!newer.is_known());
/// assert_eq!(newer.to_string(), "track");
/// ```
#[macro_export]
macro_rules! subspec_names {
    ($ty:ident { $($variant:ident => $name:literal),* $(,)? }) => {
        impl $ty {
            /// The known names, in their declared order.
            pub const KNOWN: &'static [&'static str] = &[$($name),*];

            /// `false` only for the `Unknown` catch-all a newer writer's value lands in.
            pub fn is_known(&self) -> bool {
                !matches!(self, Self::Unknown(_))
            }

            /// The wire spelling.
            pub fn wire_name(&self) -> &str {
                match self {
                    $(Self::$variant => $name,)*
                    Self::Unknown(name) => name,
                }
            }
        }

        impl ::core::convert::From<::std::string::String> for $ty {
            fn from(name: ::std::string::String) -> Self {
                match name.as_str() {
                    $($name => Self::$variant,)*
                    _ => Self::Unknown(name),
                }
            }
        }

        impl ::core::convert::From<$ty> for ::std::string::String {
            fn from(value: $ty) -> Self {
                value.wire_name().to_string()
            }
        }

        impl ::core::fmt::Display for $ty {
            fn fmt(&self, f: &mut ::core::fmt::Formatter<'_>) -> ::core::fmt::Result {
                f.write_str(self.wire_name())
            }
        }
    };
}

/// A closed-set member read with a name this version does not know: `{field} must be one of
/// {known}: {name}`, the wording social's closed sets use.
pub fn check_known(field: &str, known: bool, names: &[&str], name: &str) -> Result<(), String> {
    if !known {
        return Err(format!(
            "Validation Error: {field} must be one of {}: {name}",
            names.join(", ")
        ));
    }
    Ok(())
}

/// The raw content cap of a kind, checked on the string before it is parsed, as social's 1.1
/// kinds check theirs: `{name} content must be at most {max} code points`.
pub fn check_content_cap(name: &str, content: &str, max: usize) -> Result<(), String> {
    if crate::code_point_len(content) > max {
        return Err(format!(
            "Validation Error: {name} content must be at most {max} code points"
        ));
    }
    Ok(())
}

/// The kind's JSON envelope, under its raw cap: `{name} content must be a valid JSON envelope:
/// {reason}` when it does not parse.
pub fn parse_content<T: DeserializeOwned>(
    name: &str,
    content: &str,
    max: usize,
) -> Result<T, String> {
    check_content_cap(name, content, max)?;
    serde_json::from_str(content).map_err(|e| {
        format!(
            "Validation Error: {name} content must be a valid JSON envelope: {}",
            json_error(&e)
        )
    })
}

/// Display text the builder trimmed: 1 to `max` code points and not blank, counted as stored.
pub fn check_text(field: &str, value: &str, max: usize) -> Result<(), String> {
    if crate::frozen_trim(value).is_empty() || crate::code_point_len(value) > max {
        return Err(format!(
            "Validation Error: {field} must be 1 to {max} code points and not blank"
        ));
    }
    Ok(())
}

/// An integer member within `min..=max`, worded with its unit: `{field} must be {min} to {max}
/// {unit}`.
pub fn check_range(field: &str, value: i64, min: i64, max: i64, unit: &str) -> Result<(), String> {
    if value < min || value > max {
        return Err(format!(
            "Validation Error: {field} must be {min} to {max} {unit}"
        ));
    }
    Ok(())
}

/// The namespace rule: one lowercase ASCII segment of `a-z`, `0-9` and `-`, starting with a
/// letter, at most 32 characters, and not `social`. A sub-spec's `NAMESPACE` const passes it; a
/// test in each crate holds that.
pub fn validate_namespace(namespace: &str) -> Result<(), String> {
    let b = namespace.as_bytes();
    let shaped = !b.is_empty()
        && b.len() <= 32
        && b[0].is_ascii_lowercase()
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
        && is_canonical_segment(namespace);
    if !shaped {
        return Err(format!(
            "Validation Error: a namespace is 1 to 32 characters of a-z, 0-9 and -, starting with a letter: {namespace}"
        ));
    }
    if namespace == SOCIAL_NAMESPACE {
        return Err(format!(
            "Validation Error: the social namespace is reserved for the social post kind: {namespace}"
        ));
    }
    Ok(())
}

/// `/{root}/{namespace}/v1/posts/{id}/{editId}.json`, the path of one version.
pub fn version_path(namespace: &str, root: Root, id: &str, edit_id: &str) -> String {
    PostEnvelope::<crate::PubkySocialPostKind>::version_path(namespace, root, id, edit_id, None)
}

/// `pubky://{owner}/{root}/{namespace}/v1/posts/{id}`, the versionless reference to a post: what
/// a reply's `parent`, a rating's target or a collection item names.
pub fn post_uri(owner: &PubkyId, namespace: &str, root: Root, id: &str) -> String {
    format!(
        "pubky://{owner}/{}/{namespace}/{}/posts/{id}",
        root.segment(),
        epoch_segment()
    )
}

/// A post of a sub-spec, classified from a URI or a path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubspecPostRef {
    pub owner: PubkyId,
    pub visibility: Visibility,
    pub id: String,
    /// `None` for the versionless reference; `Some` for a stored version.
    pub version: Option<String>,
    /// The readable tail of the version leaf, `{editId}-{label}.json`; never part of the identity.
    pub label: Option<String>,
}

/// Classifies `uri` as a post of `namespace`, versionless (`…/posts/{id}`) or stored
/// (`…/posts/{id}/{editId}[-{label}].json`), under the epoch this crate speaks; `None` for
/// anything else, another namespace's post included. Like the social parser it never reads the
/// clock: the id's time bound is the object validator's.
pub fn parse_post_uri(namespace: &str, uri: &str) -> Option<SubspecPostRef> {
    let parsed = ParsedUri::try_from(uri).ok()?;
    let Resource::Foreign {
        namespace: ns,
        version: Some(epoch),
        rest,
    } = parsed.resource
    else {
        return None;
    };
    if ns != namespace || epoch != epoch_segment() {
        return None;
    }
    let rest: Vec<&str> = rest.iter().map(String::as_str).collect();
    let (id, version, label) = match rest.as_slice() {
        ["posts", id] => (*id, None, None),
        ["posts", id, leaf] => {
            let (version, label) = parse_version_leaf(leaf)?;
            (*id, Some(version), label)
        }
        _ => return None,
    };
    crate::validate_timestamp_id_format(id).ok()?;
    Some(SubspecPostRef {
        owner: parsed.user_id,
        visibility: parsed.visibility,
        id: id.to_string(),
        version,
        label,
    })
}

/// Reads one stored version of a sub-spec post: the bytes as written (never rewritten), its
/// envelope rules under the root it was read from, and the ownership rule with the author the
/// URI names, as social ingest by URI runs it.
pub fn read_version<K: PostKind>(
    blob: &[u8],
    id: &str,
    root: Root,
    owner: &PubkyId,
) -> Result<PostEnvelope<K>, String> {
    let ctx = ValidationCtx { root };
    let post = <PostEnvelope<K> as Validatable>::try_from(blob, id, &ctx)?;
    post.check_references(&ctx, Some(owner))?;
    Ok(post)
}

/// The vector files a sub-spec ships beside its crate, so another implementation (a TypeScript
/// package, another app's reader) is held to the same verdicts: one JSON document per line,
/// `{"name", "url", "body", "verdict"}`, `body` the stored bytes as text and `verdict` `"ok"` or
/// the refusal. [`check_vectors`] reads a file and fails on the first verdict the crate no longer
/// gives; with `RECORD_VECTORS=1` in the environment it writes the file from the cases instead.
pub mod vectors {
    use super::{parse_post_uri, read_version};
    use crate::models::post::PostKind;
    use crate::traits::Root;
    use crate::uri::Visibility;
    use serde::{Deserialize, Serialize};
    use std::path::Path;

    /// One recorded case.
    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    pub struct Vector {
        pub name: String,
        /// The stored version's URL, `pubky://{owner}/{root}/{namespace}/v1/posts/{id}/{editId}.json`.
        pub url: String,
        /// The stored bytes, as text.
        pub body: String,
        /// `"ok"`, or the refusal.
        pub verdict: String,
    }

    /// The verdict of reading `body` at `url` as a post of `namespace` with kinds `K`.
    pub fn verdict<K: PostKind>(namespace: &str, url: &str, body: &str) -> String {
        let Some(at) = parse_post_uri(namespace, url) else {
            return format!("Validation Error: not a {namespace} post version: {url}");
        };
        if at.version.is_none() {
            return format!("Validation Error: not a stored version: {url}");
        }
        let root = match at.visibility {
            Visibility::Public => Root::Pub,
            Visibility::Private => Root::Priv,
        };
        // The post id is the time the version is read under; the editId only names the file
        match read_version::<K>(body.as_bytes(), &at.id, root, &at.owner) {
            Ok(_) => "ok".to_string(),
            Err(e) => e,
        }
    }

    /// Records `cases` (name, url, body) into `file` when `RECORD_VECTORS=1`, else checks that
    /// the file holds exactly these cases and that every verdict is the crate's. Returns the
    /// number of vectors.
    pub fn check_vectors<K: PostKind>(
        namespace: &str,
        file: &Path,
        cases: &[(String, String, String)],
    ) -> Result<usize, String> {
        let fresh: Vec<Vector> = cases
            .iter()
            .map(|(name, url, body)| Vector {
                name: name.clone(),
                url: url.clone(),
                body: body.clone(),
                verdict: verdict::<K>(namespace, url, body),
            })
            .collect();
        if std::env::var("RECORD_VECTORS").as_deref() == Ok("1") {
            let lines: Vec<String> = fresh
                .iter()
                .map(|v| serde_json::to_string(v).expect("a vector serializes"))
                .collect();
            std::fs::write(file, lines.join("\n") + "\n").map_err(|e| e.to_string())?;
            return Ok(fresh.len());
        }
        let text = std::fs::read_to_string(file)
            .map_err(|e| format!("{}: {e} (record with RECORD_VECTORS=1)", file.display()))?;
        let recorded: Vec<Vector> = text
            .lines()
            .map(serde_json::from_str)
            .collect::<Result<_, _>>()
            .map_err(|e| format!("{}: {e}", file.display()))?;
        if recorded.len() != fresh.len() {
            return Err(format!(
                "{}: {} vectors recorded, {} cases now (record with RECORD_VECTORS=1)",
                file.display(),
                recorded.len(),
                fresh.len()
            ));
        }
        for (want, got) in recorded.iter().zip(&fresh) {
            if want.name != got.name || want.url != got.url || want.body != got.body {
                return Err(format!("{}: case {} changed", file.display(), want.name));
            }
            // The recorded verdict against the crate's answer for the recorded bytes
            let now = verdict::<K>(namespace, &want.url, &want.body);
            if now != want.verdict {
                return Err(format!(
                    "{}: {}: recorded {:?}, the crate answers {:?}",
                    file.display(),
                    want.name,
                    want.verdict,
                    now
                ));
            }
        }
        Ok(recorded.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PK: &str = "operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo";
    const TS: &str = "0032SSN7Q4EVG";

    #[test]
    fn namespaces() {
        for ok in ["maps", "events", "marketplace", "music", "a", "x-2"] {
            assert_eq!(validate_namespace(ok), Ok(()), "{ok}");
        }
        for bad in [
            "",
            "Maps",
            "2maps",
            "-maps",
            "pubky.app",
            "a/b",
            "ma ps",
            "ünï",
            &"m".repeat(33),
        ] {
            assert!(validate_namespace(bad).is_err(), "{bad}");
        }
        assert!(validate_namespace("social")
            .unwrap_err()
            .contains("reserved"));
    }

    #[test]
    fn paths_and_uris_round_trip() {
        let owner = PubkyId::try_from(PK).unwrap();
        assert_eq!(
            version_path("maps", Root::Pub, TS, TS),
            format!("/pub/maps/v1/posts/{TS}/{TS}.json")
        );
        let uri = post_uri(&owner, "maps", Root::Priv, TS);
        assert_eq!(uri, format!("pubky://{PK}/priv/maps/v1/posts/{TS}"));
        let parsed = parse_post_uri("maps", &uri).unwrap();
        assert_eq!(parsed.visibility, Visibility::Private);
        assert_eq!((parsed.id.as_str(), parsed.version), (TS, None));
        let stored = format!("pubky://{PK}/pub/maps/v1/posts/{TS}/{TS}-lakeside.json");
        let parsed = parse_post_uri("maps", &stored).unwrap();
        assert_eq!(parsed.version.as_deref(), Some(TS));
        assert_eq!(parsed.label.as_deref(), Some("lakeside"));
        for other in [
            format!("pubky://{PK}/pub/events/v1/posts/{TS}"),
            format!("pubky://{PK}/pub/maps/v2/posts/{TS}"),
            format!("pubky://{PK}/pub/maps/posts/{TS}"),
            format!("pubky://{PK}/pub/maps/v1/posts/{TS}.json"),
            format!("pubky://{PK}/pub/maps/v1/posts/{TS}/x.json"),
            format!("pubky://{PK}/pub/maps/v1/listings/{TS}"),
            format!("pubky://{PK}/pub/social/v1/posts/{TS}"),
            "https://example.com/maps/v1/posts".to_string(),
        ] {
            assert_eq!(parse_post_uri("maps", &other), None, "{other}");
        }
    }

    #[test]
    fn shared_wording() {
        assert_eq!(
            check_content_cap("Route", "abc", 2).unwrap_err(),
            "Validation Error: Route content must be at most 2 code points"
        );
        assert!(parse_content::<serde_json::Value>("Route", "nope", 10)
            .unwrap_err()
            .starts_with("Validation Error: Route content must be a valid JSON envelope: "));
        assert_eq!(
            check_text("name", " ", 3).unwrap_err(),
            "Validation Error: name must be 1 to 3 code points and not blank"
        );
        assert_eq!(check_text("name", "abc", 3), Ok(()));
        assert_eq!(
            check_range("price_sats", -1, 0, 9, "sats").unwrap_err(),
            "Validation Error: price_sats must be 0 to 9 sats"
        );
    }
}
