//! Pure planners for publishing, unpublishing and deleting a post.
//!
//! No I/O: each planner takes the listings the caller already fetched and returns ordered
//! operations for the caller to execute, across both roots. Paths are owner-relative
//! (`/pub/social/v1/...`), the form a homeserver LIST returns.

use super::{PubkySocialPost, PubkySocialPostKind};
use crate::canonicalize::{validate_reference, AllowedSchemes};
use crate::constants::{social_path, PROTOCOL};
use crate::limits::VALIDATION_LIMITS;
use crate::models::file::PubkySocialFile;
use crate::traits::{HasIdPath, Root, TimestampId, Validatable, ValidationCtx};
use crate::types::PubkyId;
use crate::uri::parse_version_leaf;
use serde::Serialize;

/// Publish: media copies first, then the post PUT. Skip-if-exists on a copy is the caller's,
/// since existence proves completion. The public leaf carries no slug: the slug is private
/// decoration on a draft, and the public spelling is the plain `{editId}.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishPlan {
    /// `(private path, public path)` pairs, in reference order, deduplicated.
    pub media_copies: Vec<(String, String)>,
    /// The chosen version with its private media references respelled under `pub`.
    pub rewritten_post_json: String,
    /// `/pub/social/v1/posts/{id}/{editId}.json`.
    pub dest_path: String,
}

/// Unpublish: copy-backs first, then deletes, each list in order. Public media is deliberately
/// absent: removing it needs a whole-tree referencer check only the caller can run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnpublishPlan {
    /// `(public path, private path)` pairs, oldest first.
    pub copy_backs: Vec<(String, String)>,
    /// Legacy paths in the given order, then every public version, oldest first.
    pub deletes: Vec<String>,
}

/// Delete: legacy first, then every version oldest first with `pub` before `priv`, so the
/// post keeps resolving to its newest surviving version until the last DELETE. Media GC runs
/// only after that, and expanding each candidate to its every-epoch spelling is the caller's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletePlan {
    pub deletes: Vec<String>,
    /// Same-owner media referenced by any parsed version, under both roots, sorted.
    pub media_gc_candidates: Vec<String>,
}

fn owner_prefix(owner: &PubkyId) -> String {
    [PROTOCOL, owner.as_ref()].concat()
}

fn media_prefix(owner: &PubkyId, root: Root) -> String {
    let leaf = PubkySocialFile::PATH_SEGMENT;
    [owner_prefix(owner).as_str(), &social_path(root, leaf)].concat()
}

/// A URI the parser reads as a stored media object.
fn is_media_object(uri: &str) -> bool {
    crate::ParsedUri::try_from(uri).is_ok_and(|p| matches!(p.resource, crate::Resource::File(_)))
}

fn is_priv_rooted(uri: &str) -> bool {
    uri.strip_prefix(PROTOCOL)
        .and_then(|rest| rest.split_once('/'))
        .is_some_and(|(_, path)| path == "priv" || path.starts_with("priv/"))
}

/// The envelope as a JSON object, for the kinds that carry one and when it parses. An
/// unparsable envelope is validation's error, not the planner's.
fn envelope_of(post: &PubkySocialPost) -> Option<serde_json::Map<String, serde_json::Value>> {
    if !matches!(
        post.kind,
        PubkySocialPostKind::Article | PubkySocialPostKind::Collection
    ) {
        return None;
    }
    match serde_json::from_str(&post.content) {
        Ok(serde_json::Value::Object(map)) => Some(map),
        _ => None,
    }
}

fn cover_of(post: &PubkySocialPost) -> Option<String> {
    post.envelope_cover()
}

/// Media positions in reference order: attachments, then the cover.
fn media_refs(post: &PubkySocialPost) -> Vec<String> {
    let mut refs: Vec<String> = post.attachments.iter().map(|a| a.uri.clone()).collect();
    refs.extend(cover_of(post));
    refs
}

/// Non-media reference positions: parent, embed, lock, collection items. An item is a
/// reference to a thing, never a media position, so a private file curated as an item is a
/// private reference and publish refuses it: publish the file, or the post carrying it, first.
fn other_refs(post: &PubkySocialPost) -> Vec<String> {
    let mut refs: Vec<String> = [&post.parent, &post.embed, &post.lock]
        .into_iter()
        .flatten()
        .cloned()
        .collect();
    refs.extend(post.collection_item_uris());
    refs
}

/// The publish media closure: the same-owner priv-root `files/` URIs this post references from
/// its attachments and its envelope cover, in first-encountered order, deduplicated. Every media
/// reference passes the media gate with the author in scope first, so a non-canonical spelling or
/// another user's private file is a publish error rather than a dangling reference. A priv-root
/// reference anywhere else (parent, embed, lock, collection item) is the root rule stated as a
/// publish error; covers are media and part of the closure.
pub fn private_media_refs(post: &PubkySocialPost, owner: &PubkyId) -> Result<Vec<String>, String> {
    let own_private = media_prefix(owner, Root::Priv);
    let priv_ctx = ValidationCtx { root: Root::Priv };
    let max = VALIDATION_LIMITS.reference_uri_max_length;
    let mut media = Vec::new();
    for uri in media_refs(post) {
        let canonical = validate_reference(
            &uri,
            AllowedSchemes::PubkyHttpHttps,
            max,
            &priv_ctx,
            Some(owner),
        )
        .map_err(|e| format!("Validation Error: cannot publish: media uri {e}"))?;
        if canonical != uri {
            return Err(format!(
                "Validation Error: cannot publish: media uri must be spelled in canonical form: {uri}"
            ));
        }
        if uri.starts_with(&own_private) {
            // The leaf must be a media object the parser reads, or the copy would land at a
            // path no reader recognizes
            if !is_media_object(&uri) {
                return Err(format!(
                    "Validation Error: cannot publish: a private reference in a media position is not a media object: {uri}"
                ));
            }
            if !media.contains(&uri) {
                media.push(uri);
            }
        } else if is_priv_rooted(&uri) {
            return Err(format!(
                "Validation Error: cannot publish: a private reference in a media position is not media: {uri}"
            ));
        }
    }
    if let Some(uri) = other_refs(post).into_iter().find(|u| is_priv_rooted(u)) {
        return Err(format!(
            "Validation Error: cannot publish: a public post cannot reference a private object: {uri}"
        ));
    }
    Ok(media)
}

/// `pubky://{owner}/priv/social/v1/files/X` -> the same under `pub`.
fn to_public(uri: &str, owner: &PubkyId) -> String {
    let private = media_prefix(owner, Root::Priv);
    match uri.strip_prefix(&private) {
        Some(rest) => [media_prefix(owner, Root::Pub).as_str(), rest].concat(),
        None => uri.to_string(),
    }
}

/// `pubky://{owner}{path}` -> `{path}`.
fn to_path(uri: &str, owner: &PubkyId) -> String {
    uri.strip_prefix(&owner_prefix(owner))
        .unwrap_or(uri)
        .to_string()
}

/// Publish one chosen version of a private post. Rewrites private media references to their
/// public spelling in the reference positions only, never over the content text, and
/// re-validates the result as a public object with the author in scope.
pub fn plan_publish(
    post_id: &str,
    chosen_edit_id: &str,
    chosen_version: &PubkySocialPost,
    owner: &PubkyId,
) -> Result<PublishPlan, String> {
    chosen_version.validate_id(post_id)?;
    chosen_version.validate_id(chosen_edit_id)?;
    if chosen_edit_id.as_bytes() < post_id.as_bytes() {
        return Err(format!(
            "Validation Error: editId {chosen_edit_id} predates the post id {post_id}"
        ));
    }
    let media = private_media_refs(chosen_version, owner)?;
    let media_copies = media
        .iter()
        .map(|uri| (to_path(uri, owner), to_path(&to_public(uri, owner), owner)))
        .collect();

    let mut post = chosen_version.clone();
    for attachment in &mut post.attachments {
        attachment.uri = to_public(&attachment.uri, owner);
    }
    // The cover lives inside the envelope: respell it in place and re-serialize the object as
    // parsed, so every other member comes back with its value (validation already bounded the
    // integers to the JSON-safe range); only when the cover changes
    if let Some(cover) = cover_of(&post) {
        let public = to_public(&cover, owner);
        if public != cover {
            let mut envelope = envelope_of(&post)
                .ok_or("Validation Error: cannot publish: the cover did not parse")?;
            // Until every envelope validates its unknown members, the planner refuses to
            // re-emit an integer a JSON engine cannot carry back
            crate::common::check_safe_numbers(&serde_json::Value::Object(envelope.clone()))
                .map_err(|e| {
                    let e = e.strip_prefix("Validation Error: ").unwrap_or(&e);
                    format!("Validation Error: cannot publish: {e}")
                })?;
            envelope.insert("cover_image".into(), serde_json::Value::String(public));
            post.content = serde_json::Value::Object(envelope).to_string();
        }
    }
    let ctx = ValidationCtx { root: Root::Pub };
    post.validate(Some(post_id), &ctx)?;
    post.check_references(&ctx, Some(owner))?;
    Ok(PublishPlan {
        media_copies,
        rewritten_post_json: serde_json::to_string(&post).map_err(|e| e.to_string())?,
        dest_path: PubkySocialPost::create_path_in(Root::Pub, post_id, chosen_edit_id, None),
    })
}

/// The editId of a version path that lives under this post's directory in the given root,
/// parsed by the path grammar's own rule.
fn edit_id_of(post_id: &str, root: Root, path: &str) -> Result<String, String> {
    let dir = social_path(
        root,
        &format!("{}{post_id}/", PubkySocialPost::PATH_SEGMENT),
    );
    let leaf = path
        .strip_prefix(&dir)
        .filter(|leaf| !leaf.contains('/'))
        .ok_or_else(|| {
            format!("Validation Error: not a version path of post {post_id} under {dir}: {path}")
        })?;
    parse_version_leaf(leaf)
        .map(|(v, _)| v)
        .ok_or_else(|| format!("Validation Error: not a post version path: {path}"))
}

/// The one legacy (pre-epoch) path of this post, `/pub/pubky.app/posts/{id}`: ids are stable
/// across epochs, and nothing else may ride along into a delete list.
fn check_legacy_paths(post_id: &str, paths: &[String]) -> Result<(), String> {
    let legacy = format!("/pub/pubky.app/{}{post_id}", PubkySocialPost::PATH_SEGMENT);
    match paths.iter().find(|p| **p != legacy) {
        Some(p) => Err(format!(
            "Validation Error: not a legacy path of post {post_id}: {p}"
        )),
        None => Ok(()),
    }
}

/// Same version leaf under the other root.
fn under(root: Root, path: &str) -> String {
    let after_root = path
        .trim_start_matches('/')
        .split_once('/')
        .map(|(_, rest)| rest)
        .unwrap_or("");
    ["/", root.segment(), "/", after_root].concat()
}

/// Versions keyed by editId and sorted oldest first. Bytewise on the editId, never decoded:
/// fixed-width single-case ids make bytewise order chronological. `tiebreak` orders equal
/// editIds.
fn sorted_versions<T: Clone>(
    post_id: &str,
    items: &[T],
    locate: impl Fn(&T) -> (Root, &str),
    tiebreak: impl Fn(&T, &T) -> std::cmp::Ordering,
) -> Result<Vec<(String, T)>, String> {
    let mut keyed = items
        .iter()
        .map(|t| {
            let (root, path) = locate(t);
            Ok((edit_id_of(post_id, root, path)?, t.clone()))
        })
        .collect::<Result<Vec<_>, String>>()?;
    keyed.sort_by(|a, b| {
        a.0.as_bytes()
            .cmp(b.0.as_bytes())
            .then_with(|| tiebreak(&a.1, &b.1))
    });
    Ok(keyed)
}

/// Unpublish: every public version newer than the private head is copied back, oldest
/// first; without a private tree the newest public version seeds it. Then the legacy paths
/// and every public version are deleted.
pub fn plan_unpublish(
    post_id: &str,
    public_v1_paths: &[String],
    legacy_public_paths: &[String],
    private_head_path: Option<&str>,
) -> Result<UnpublishPlan, String> {
    crate::common::validate_timestamp_id_format(post_id)?;
    check_legacy_paths(post_id, legacy_public_paths)?;
    let public = sorted_versions(
        post_id,
        public_v1_paths,
        |p| (Root::Pub, p.as_str()),
        |_, _| std::cmp::Ordering::Equal,
    )?;
    let head = private_head_path
        .map(|p| edit_id_of(post_id, Root::Priv, p))
        .transpose()?;
    if public.is_empty() && head.is_none() {
        return Err(format!(
            "Validation Error: nothing to unpublish for post {post_id}"
        ));
    }
    let copy_backs = match &head {
        Some(head) => public
            .iter()
            .filter(|(e, _)| e.as_bytes() > head.as_bytes())
            .map(|(_, p)| (p.clone(), under(Root::Priv, p)))
            .collect(),
        None => public
            .last()
            .map(|(_, p)| vec![(p.clone(), under(Root::Priv, p))])
            .unwrap_or_default(),
    };
    let mut deletes = legacy_public_paths.to_vec();
    deletes.extend(public.into_iter().map(|(_, p)| p));
    Ok(UnpublishPlan {
        copy_backs,
        deletes,
    })
}

/// The deletes of [`plan_delete`] alone: the legacy paths, then every v1 copy oldest first,
/// `pub` before `priv` at equal editId so the public copy goes first.
pub(crate) fn delete_order(
    post_id: &str,
    legacy_paths: &[String],
    v1_copies: &[(Root, String)],
) -> Result<Vec<String>, String> {
    crate::common::validate_timestamp_id_format(post_id)?;
    check_legacy_paths(post_id, legacy_paths)?;
    let copies = sorted_versions(
        post_id,
        v1_copies,
        |(root, p)| (*root, p.as_str()),
        |a, b| (a.0 == Root::Priv).cmp(&(b.0 == Root::Priv)),
    )?;
    let mut deletes = legacy_paths.to_vec();
    deletes.extend(copies.into_iter().map(|(_, (_, p))| p));
    Ok(deletes)
}

/// Delete everywhere. `parsed_versions` are the versions the caller could read; one it could
/// not contributes no GC candidates, a documented residual, since the caller's own index is
/// the real GC source.
pub fn plan_delete(
    post_id: &str,
    legacy_paths: &[String],
    v1_copies: &[(Root, String)],
    parsed_versions: &[PubkySocialPost],
    owner: &PubkyId,
) -> Result<DeletePlan, String> {
    let deletes = delete_order(post_id, legacy_paths, v1_copies)?;

    let public = media_prefix(owner, Root::Pub);
    let private = media_prefix(owner, Root::Priv);
    let mut media_gc_candidates: Vec<String> = parsed_versions
        .iter()
        .flat_map(media_refs)
        .filter(|u| (u.starts_with(&public) || u.starts_with(&private)) && is_media_object(u))
        .map(|u| to_path(&u, owner))
        .collect();
    media_gc_candidates.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    media_gc_candidates.dedup();
    Ok(DeletePlan {
        deletes,
        media_gc_candidates,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{PubkySocialArticleContent, PubkySocialAttachment};

    const PK: &str = "operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo";
    const OTHER: &str = "8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo";
    const TS: &str = "0032SSN7Q4EVG";
    const E2: &str = "0032SSN7Q4EW0";
    const E3: &str = "0032SSN7Q4EWG";

    fn owner() -> PubkyId {
        PubkyId::try_from(PK).unwrap()
    }

    fn priv_file(n: &str) -> String {
        format!("pubky://{PK}/priv/social/v1/files/{n}")
    }

    fn pub_file(n: &str) -> String {
        format!("pubky://{PK}/pub/social/v1/files/{n}")
    }

    fn att(uri: &str) -> PubkySocialAttachment {
        PubkySocialAttachment::new(uri.into(), None, None)
    }

    fn image(atts: Vec<PubkySocialAttachment>) -> PubkySocialPost {
        PubkySocialPost::new("pic".into(), PubkySocialPostKind::Image, None, None, atts)
    }

    fn post_id() -> String {
        PubkySocialPost::default().create_id()
    }

    #[test]
    fn publish_copies_own_private_media_and_respells_only_those() {
        let a = priv_file("PZBQ010FF079VVZPQG1RNFN6DR.png");
        let b = priv_file("8Z8CWH8NVYQY39ZEBFGKQWWEKG.png");
        let web = "https://x.com/c.png";
        let mut draft = image(vec![att(&a), att(web), att(&b), att(&a)]);
        // prose that mentions a private URI must survive byte for byte
        draft.content = format!("see {a}");
        let id = post_id();
        let plan = plan_publish(&id, &id, &draft, &owner()).unwrap();
        assert_eq!(
            plan.media_copies,
            vec![
                (
                    "/priv/social/v1/files/PZBQ010FF079VVZPQG1RNFN6DR.png".to_string(),
                    "/pub/social/v1/files/PZBQ010FF079VVZPQG1RNFN6DR.png".to_string()
                ),
                (
                    "/priv/social/v1/files/8Z8CWH8NVYQY39ZEBFGKQWWEKG.png".to_string(),
                    "/pub/social/v1/files/8Z8CWH8NVYQY39ZEBFGKQWWEKG.png".to_string()
                ),
            ]
        );
        let out: PubkySocialPost = serde_json::from_str(&plan.rewritten_post_json).unwrap();
        let uris: Vec<&str> = out.attachments.iter().map(|a| a.uri.as_str()).collect();
        assert_eq!(
            uris,
            [
                pub_file("PZBQ010FF079VVZPQG1RNFN6DR.png").as_str(),
                web,
                pub_file("8Z8CWH8NVYQY39ZEBFGKQWWEKG.png").as_str(),
                pub_file("PZBQ010FF079VVZPQG1RNFN6DR.png").as_str()
            ]
        );
        assert_eq!(out.content, format!("see {a}"));
        assert_eq!(
            plan.dest_path,
            format!("/pub/social/v1/posts/{id}/{id}.json")
        );
    }

    /// The publish round trip over the media leaf the collapse produces.
    #[test]
    fn publish_round_trips_a_hashed_media_leaf() {
        let owner = owner();
        let bytes = vec![1, 2];
        let created = PubkySocialFile::create_file(bytes, "image/png", Root::Priv).unwrap();
        let leaf = format!("{}.png", created.id);
        let uri = priv_file(&leaf);
        assert_eq!(created.path, format!("/priv/social/v1/files/{leaf}"));

        let mut draft = PubkySocialPost::new(
            "pic".into(),
            PubkySocialPostKind::Image,
            None,
            None,
            vec![PubkySocialAttachment::new(
                uri.clone(),
                None,
                Some("pic.png".into()),
            )],
        );
        assert_eq!(
            crate::private_media_refs(&draft, &owner).unwrap(),
            vec![uri.clone()]
        );

        let plan = plan_publish(TS, TS, &draft, &owner).unwrap();
        assert_eq!(
            plan.media_copies,
            vec![(
                format!("/priv/social/v1/files/{leaf}"),
                format!("/pub/social/v1/files/{leaf}")
            )]
        );
        assert_eq!(
            plan.dest_path,
            format!("/pub/social/v1/posts/{TS}/{TS}.json")
        );
        let published: PubkySocialPost = serde_json::from_str(&plan.rewritten_post_json).unwrap();
        assert_eq!(published.attachments[0].uri, pub_file(&leaf));
        assert_eq!(published.attachments[0].name.as_deref(), Some("pic.png"));
        published
            .validate(Some(TS), &ValidationCtx { root: Root::Pub })
            .unwrap();

        // The Err twins, through the exported enumerator
        draft.attachments[0].uri = format!("pubky://{OTHER}/priv/social/v1/files/{leaf}");
        let e = crate::private_media_refs(&draft, &owner).unwrap_err();
        assert!(
            e.contains(
                "Validation Error: cannot publish: media uri must not reference a private object of another user: "
            ),
            "{e}"
        );
        draft.attachments[0].uri = uri;
        draft.parent = Some(format!("pubky://{PK}/priv/social/v1/posts/{TS}"));
        let e = crate::private_media_refs(&draft, &owner).unwrap_err();
        assert!(e.contains("private object"), "{e}");
    }

    #[test]
    fn publish_rewrites_the_article_cover_inside_the_envelope() {
        let cover = priv_file("PZBQ010FF079VVZPQG1RNFN6DR.png");
        let article = PubkySocialPost::new_article(
            "t".into(),
            "b".into(),
            Some(cover.clone()),
            None,
            None,
            vec![],
            None,
        );
        let id = post_id();
        let plan = plan_publish(&id, &id, &article, &owner()).unwrap();
        assert_eq!(plan.media_copies.len(), 1);
        let out: PubkySocialPost = serde_json::from_str(&plan.rewritten_post_json).unwrap();
        let e: PubkySocialArticleContent = serde_json::from_str(&out.content).unwrap();
        assert_eq!(
            e.cover_image.as_deref(),
            Some(pub_file("PZBQ010FF079VVZPQG1RNFN6DR.png").as_str())
        );
        assert_eq!(e.title, "t");
        // an already-public cover leaves the content bytes alone
        let public = PubkySocialPost::new_article(
            "t".into(),
            "b".into(),
            Some(pub_file("PZBQ010FF079VVZPQG1RNFN6DR.png")),
            None,
            None,
            vec![],
            None,
        );
        let plan = plan_publish(&id, &id, &public, &owner()).unwrap();
        let out: PubkySocialPost = serde_json::from_str(&plan.rewritten_post_json).unwrap();
        assert_eq!(out.content, public.content);
        assert!(plan.media_copies.is_empty());
    }

    #[test]
    fn publish_refuses_private_references_it_cannot_carry() {
        let id = post_id();
        let mut reply = PubkySocialPost::new(
            "re".into(),
            PubkySocialPostKind::Note,
            Some(format!("pubky://{PK}/priv/social/v1/posts/{TS}")),
            None,
            vec![],
        );
        let e = plan_publish(&id, &id, &reply, &owner()).unwrap_err();
        assert!(e.contains("private object"), "{e}");
        reply.parent = None;
        let foreign = image(vec![att(&format!(
            "pubky://{OTHER}/priv/social/v1/files/PZBQ010FF079VVZPQG1RNFN6DR.png"
        ))]);
        let e = plan_publish(&id, &id, &foreign, &owner()).unwrap_err();
        assert!(
            e.contains(
                "Validation Error: cannot publish: media uri must not reference a private object of another user: "
            ),
            "{e}"
        );
        // the owner's own private post in a media position is not media
        let not_media = image(vec![att(&format!(
            "pubky://{PK}/priv/social/v1/posts/{TS}"
        ))]);
        let e = plan_publish(&id, &id, &not_media, &owner()).unwrap_err();
        assert!(e.contains("not media"), "{e}");
        // a same-owner private files/ leaf the parser does not read as media is refused, not copied
        for leaf in [
            "not-a-hash",
            "PZBQ010FF079VVZPQG1RNFN6DR",
            "PZBQ010FF079VVZPQG1RNFN6DR.JPG",
        ] {
            let junk = image(vec![att(&format!(
                "pubky://{PK}/priv/social/v1/files/{leaf}"
            ))]);
            let e = plan_publish(&id, &id, &junk, &owner()).unwrap_err();
            assert!(e.contains("not a media object"), "{leaf}: {e}");
        }
        assert!(plan_publish("not-an-id", &id, &reply, &owner()).is_err());
        assert!(plan_publish(&id, "not-an-id", &reply, &owner()).is_err());
        // a canonical editId outside the validity window, or older than the post, is refused
        assert!(plan_publish(&id, "FZZZZZZZZZZZY", &reply, &owner()).is_err());
        assert!(plan_publish(&id, TS, &reply, &owner()).is_err());
    }

    #[test]
    fn publish_rewrites_the_collection_cover_and_keeps_every_other_member() {
        let cover = priv_file("PZBQ010FF079VVZPQG1RNFN6DR.png");
        let content = format!(
            r#"{{"name":"n","items":[{{"uri":"pubky://{PK}/pub/social/v1/posts/{TS}","note":"x","rating":5}}],"cover_image":"{cover}","layout":"carousel","future":1}}"#
        );
        let collection =
            PubkySocialPost::new(content, PubkySocialPostKind::Collection, None, None, vec![]);
        let id = post_id();
        let plan = plan_publish(&id, &id, &collection, &owner()).unwrap();
        assert_eq!(plan.media_copies.len(), 1);
        let out: PubkySocialPost = serde_json::from_str(&plan.rewritten_post_json).unwrap();
        let e: serde_json::Value = serde_json::from_str(&out.content).unwrap();
        assert_eq!(e["cover_image"], pub_file("PZBQ010FF079VVZPQG1RNFN6DR.png"));
        assert_eq!(e["layout"], "carousel");
        assert_eq!(e["future"], 1);
        assert_eq!(e["name"], "n");
        assert_eq!(e["items"][0]["rating"], 5);
        // an integer no JSON engine carries back is refused, not re-spelled
        let content =
            format!(r#"{{"name":"n","items":[],"cover_image":"{cover}","big":9007199254740992}}"#);
        let collection =
            PubkySocialPost::new(content, PubkySocialPostKind::Collection, None, None, vec![]);
        let e = plan_publish(&id, &id, &collection, &owner()).unwrap_err();
        assert!(e.contains("JSON-safe"), "{e}");
        assert!(
            e.starts_with("Validation Error: cannot publish: integer"),
            "{e}"
        );
        assert_eq!(e.matches("Validation Error").count(), 1, "{e}");
    }

    #[test]
    fn publish_refuses_a_private_file_curated_as_an_item() {
        // An item is a link, not a media position: the cover is copied and respelled, an item
        // is not, so a private draft pointing at the owner's own private file cannot publish
        // until that file (or the post carrying it) is public.
        let file = priv_file("PZBQ010FF079VVZPQG1RNFN6DR.png");
        let content = format!(r#"{{"name":"n","items":[{{"uri":"{file}"}}]}}"#);
        let collection =
            PubkySocialPost::new(content, PubkySocialPostKind::Collection, None, None, vec![]);
        let id = post_id();
        let e = plan_publish(&id, &id, &collection, &owner()).unwrap_err();
        assert!(e.contains("private object"), "{e}");
        // the same file as the cover publishes, and copies
        let content = format!(r#"{{"name":"n","items":[],"cover_image":"{file}"}}"#);
        let collection =
            PubkySocialPost::new(content, PubkySocialPostKind::Collection, None, None, vec![]);
        let plan = plan_publish(&id, &id, &collection, &owner()).unwrap();
        assert_eq!(plan.media_copies.len(), 1);
    }

    #[test]
    fn publish_dedupes_media_shared_by_attachment_and_cover() {
        let file = priv_file("PZBQ010FF079VVZPQG1RNFN6DR.png");
        let article = PubkySocialPost::new_article(
            "t".into(),
            "b".into(),
            Some(file.clone()),
            None,
            None,
            vec![att(&file)],
            None,
        );
        let id = post_id();
        let plan = plan_publish(&id, &id, &article, &owner()).unwrap();
        assert_eq!(plan.media_copies.len(), 1);
    }

    #[test]
    fn publish_refuses_a_non_canonical_media_spelling() {
        let id = post_id();
        let shouting = image(vec![att(&format!(
            "PUBKY://{PK}/priv/social/v1/files/PZBQ010FF079VVZPQG1RNFN6DR.png"
        ))]);
        let e = plan_publish(&id, &id, &shouting, &owner()).unwrap_err();
        assert!(
            e.contains(
                "Validation Error: cannot publish: media uri must be a canonical pubky or web URI"
            ),
            "{e}"
        );
    }

    #[test]
    fn legacy_paths_and_the_post_id_are_checked_too() {
        let sibling = format!("/pub/pubky.app/posts/{E2}");
        assert!(plan_unpublish(TS, &[pub_v(TS)], std::slice::from_ref(&sibling), None).is_err());
        let err = plan_delete(TS, &[sibling], &[], &[], &owner()).unwrap_err();
        assert!(
            err.starts_with("Validation Error: not a legacy path"),
            "{err}"
        );
        let mine = format!("/pub/pubky.app/posts/{TS}");
        assert!(plan_delete(TS, &[mine], &[], &[], &owner()).is_ok());
        for near in [
            format!("/priv/pubky.app/posts/{TS}"),
            format!("/pub/other.app/posts/{TS}"),
            format!("/pub/pubky.app/posts/{TS}/"),
        ] {
            assert!(
                plan_delete(TS, std::slice::from_ref(&near), &[], &[], &owner()).is_err(),
                "{near}"
            );
            assert!(
                plan_unpublish(TS, &[pub_v(TS)], std::slice::from_ref(&near), None).is_err(),
                "{near}"
            );
        }
        // a non-canonical post id never matches a listing, however the paths are spelled
        let odd = "/pub/social/v1/posts/x/0032SSN7Q4EVG.json".to_string();
        assert!(plan_unpublish("x", std::slice::from_ref(&odd), &[], None).is_err());
        assert!(plan_delete("x", &[], &[(Root::Pub, odd)], &[], &owner()).is_err());
    }

    #[test]
    fn version_paths_must_belong_to_the_post_and_root() {
        let other_post = format!("/pub/social/v1/posts/{E2}/{E2}.json");
        let err = plan_unpublish(TS, &[other_post], &[], None).unwrap_err();
        assert!(
            err.starts_with("Validation Error: not a version path"),
            "{err}"
        );
        let wrong_root = vec![(Root::Priv, pub_v(TS))];
        assert!(plan_delete(TS, &[], &wrong_root, &[], &owner()).is_err());
        let nested = format!("/pub/social/v1/posts/{TS}/x/{TS}.json");
        assert!(plan_unpublish(TS, &[nested], &[], None).is_err());
        // a slugged leaf is a version like any other
        let slugged = vec![
            (
                Root::Pub,
                format!("/pub/social/v1/posts/{TS}/{E2}-hello.json"),
            ),
            (Root::Priv, priv_v(TS)),
        ];
        let plan = plan_delete(TS, &[], &slugged, &[], &owner()).unwrap();
        assert_eq!(plan.deletes, vec![priv_v(TS), slugged[0].1.clone()]);
    }

    fn pub_v(e: &str) -> String {
        format!("/pub/social/v1/posts/{TS}/{e}.json")
    }

    fn priv_v(e: &str) -> String {
        format!("/priv/social/v1/posts/{TS}/{e}.json")
    }

    #[test]
    fn unpublish_copies_back_versions_newer_than_the_private_head() {
        let legacy = "/pub/pubky.app/posts/0032SSN7Q4EVG".to_string();
        let public = vec![pub_v(E3), pub_v(TS), pub_v(E2)];
        let plan = plan_unpublish(
            TS,
            &public,
            std::slice::from_ref(&legacy),
            Some(&priv_v(E2)),
        )
        .unwrap();
        assert_eq!(plan.copy_backs, vec![(pub_v(E3), priv_v(E3))]);
        assert_eq!(plan.deletes, vec![legacy, pub_v(TS), pub_v(E2), pub_v(E3)]);
        let plan = plan_unpublish(TS, &public, &[], Some(&priv_v(E3))).unwrap();
        assert!(plan.copy_backs.is_empty());
        // no private tree: the newest public version seeds it
        let plan = plan_unpublish(TS, &public, &[], None).unwrap();
        assert_eq!(plan.copy_backs, vec![(pub_v(E3), priv_v(E3))]);
        assert!(plan_unpublish(TS, &[], &[], None).is_err());
        // a slugged leaf keeps its slug on the way back
        let slugged = format!("/pub/social/v1/posts/{TS}/{E3}-hello.json");
        let plan = plan_unpublish(TS, std::slice::from_ref(&slugged), &[], None).unwrap();
        assert_eq!(
            plan.copy_backs,
            vec![(
                slugged,
                format!("/priv/social/v1/posts/{TS}/{E3}-hello.json")
            )]
        );
        assert!(plan_unpublish(
            TS,
            &[format!("/pub/social/v1/posts/{TS}/y.json")],
            &[],
            None
        )
        .is_err());
    }

    #[test]
    fn delete_orders_versions_oldest_first_pub_before_priv() {
        let legacy = "/pub/pubky.app/posts/0032SSN7Q4EVG".to_string();
        let copies = vec![
            (Root::Priv, priv_v(E3)),
            (Root::Priv, priv_v(TS)),
            (Root::Pub, pub_v(E2)),
            (Root::Pub, pub_v(TS)),
        ];
        let plan = plan_delete(TS, std::slice::from_ref(&legacy), &copies, &[], &owner()).unwrap();
        assert_eq!(
            plan.deletes,
            vec![legacy, pub_v(TS), priv_v(TS), pub_v(E2), priv_v(E3)]
        );
        assert!(plan.media_gc_candidates.is_empty());
    }

    #[test]
    fn delete_collects_same_owner_media_under_both_roots() {
        let v1 = image(vec![
            att(&priv_file("8Z8CWH8NVYQY39ZEBFGKQWWEKG.png")),
            att("https://x.com/a.png"),
        ]);
        let v2 = image(vec![
            att(&pub_file("PZBQ010FF079VVZPQG1RNFN6DR.png")),
            att(&pub_file("8Z8CWH8NVYQY39ZEBFGKQWWEKG.png")),
            att(&format!(
                "pubky://{OTHER}/pub/social/v1/files/PZBQ010FF079VVZPQG1RNFN6DR.png"
            )),
        ]);
        // a same-owner files/ leaf that is not a media object is nothing to collect
        let v3 = image(vec![att(&format!("pubky://{PK}/pub/social/v1/files/junk"))]);
        let plan = plan_delete(TS, &[], &[], &[v1, v2, v3], &owner()).unwrap();
        assert_eq!(
            plan.media_gc_candidates,
            vec![
                "/priv/social/v1/files/8Z8CWH8NVYQY39ZEBFGKQWWEKG.png".to_string(),
                "/pub/social/v1/files/8Z8CWH8NVYQY39ZEBFGKQWWEKG.png".to_string(),
                "/pub/social/v1/files/PZBQ010FF079VVZPQG1RNFN6DR.png".to_string(),
            ]
        );
    }
}
