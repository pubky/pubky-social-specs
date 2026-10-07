//! The JS surface as the crate answers it, for the TypeScript package to be checked against.
//!
//! The package implements these operations natively. This module is their reference: one
//! [`call`] per operation, text and bytes in, JSON out, with the clock and the mint guard
//! given by the caller so an answer depends on its request alone. Objects arrive as JSON
//! text, as a JS caller's `JSON.stringify` gives them, so a duplicate member and the first
//! error in document order are what the parser sees. Stored bytes leave as base64: they are
//! the exact body of a PUT, and a JSON reader of the answer would respell a number.

use crate::canonicalize::{
    canonicalize_external_uri, canonicalize_pubky_uri, canonicalize_universal, canonicalize_web_uri,
};
use crate::common::{
    ascii_fold, code_point_len, frozen_trim, json_error, pinned, validate_hash_id_format,
    validate_timestamp_id_format,
};
use crate::constants::PROTOCOL;
use crate::models::deletion;
use crate::models::legacy_v0::{APP_PATH, PUBLIC_PATH};
use crate::traits::{hash_id_from, HasIdPath, HasPath, HashId, Root, Validatable, ValidationCtx};
use crate::{
    feed_paths, list_prefix_builder, mime, plan_feed_publish, private_list_prefix_builder, Listing,
    ObjectKind, ParsedUri, PubkyId, PubkySocialAttachment, PubkySocialBookmark,
    PubkySocialCollectionItem, PubkySocialCollectionLayout, PubkySocialFeed, PubkySocialFeedConfig,
    PubkySocialFeedLayout, PubkySocialFeedReach, PubkySocialFeedSort, PubkySocialFile,
    PubkySocialFollow, PubkySocialMute, PubkySocialObject, PubkySocialPost, PubkySocialPostKind,
    PubkySocialTag, PubkySocialUser, PubkySocialUserLink, Resource, StableId, Visibility, PUB_CTX,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::de::{DeserializeOwned, IgnoredAny};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::str::FromStr;
use std::sync::Mutex;

/// One argument of a call.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Arg {
    /// A string.
    S(String),
    /// A value by its JSON text.
    J(String),
    /// Bytes, base64.
    B(String),
}

/// The clock and the mint guard a call runs under. `last` comes back as the call left it.
#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
pub struct Env {
    pub now: i64,
    pub last: i64,
}

// The clock and the guard are process state, so calls take turns
static TURN: Mutex<()> = Mutex::new(());

/// Runs `op` under `env`. The answer is the value a JS caller gets, or the message it throws.
pub fn call(op: &str, args: &[Arg], env: &mut Env) -> Result<Value, String> {
    let _turn = TURN.lock().unwrap_or_else(|e| e.into_inner());
    pinned::set(env.now, env.last);
    let answer = run(op, &mut Args(args.iter()));
    env.last = pinned::last_minted();
    answer
}

struct Args<'a>(std::slice::Iter<'a, Arg>);

impl<'a> Args<'a> {
    fn next(&mut self) -> Result<&'a Arg, String> {
        self.0
            .next()
            .ok_or_else(|| "surface: an argument is missing".to_string())
    }

    fn s(&mut self) -> Result<&'a str, String> {
        match self.next()? {
            Arg::S(s) => Ok(s),
            _ => Err("surface: expected a string argument".into()),
        }
    }

    /// The JSON text of a value; an absent one reads as `null`.
    fn j(&mut self) -> Result<&'a str, String> {
        match self.0.next() {
            Some(Arg::J(j)) => Ok(j),
            None => Ok("null"),
            _ => Err("surface: expected a JSON argument".into()),
        }
    }

    fn parsed<T: DeserializeOwned>(&mut self) -> Result<T, String> {
        parse(self.j()?)
    }

    fn b(&mut self) -> Result<Vec<u8>, String> {
        match self.next()? {
            Arg::B(b) => STANDARD
                .decode(b)
                .map_err(|_| "surface: bytes are base64".into()),
            // An object about to be written is checked by the bytes it would be stored as
            Arg::J(j) => Ok(j.clone().into_bytes()),
            Arg::S(_) => Err("surface: expected a bytes argument".into()),
        }
    }
}

fn parse<T: DeserializeOwned>(json: &str) -> Result<T, String> {
    serde_json::from_str(json).map_err(|e| format!("Validation Error: {}", json_error(&e)))
}

fn body<T: Serialize>(object: &T) -> Result<String, String> {
    Ok(STANDARD.encode(serde_json::to_vec(object).map_err(|e| e.to_string())?))
}

fn url(owner: &PubkyId, path: &str) -> String {
    [PROTOCOL, owner.as_ref(), path].concat()
}

/// A built object and where it goes: `body` is the PUT body, `id` is empty for the profile.
fn created<T: Serialize>(
    owner: &PubkyId,
    id: &str,
    path: &str,
    object: &T,
) -> Result<Value, String> {
    Ok(json!({ "id": id, "path": path, "url": url(owner, path), "body": body(object)? }))
}

fn version(owner: &PubkyId, minted: crate::MintedVersion, body: String) -> Value {
    json!({
        "id": minted.id,
        "editId": minted.edit_id,
        "url": url(owner, &minted.path),
        "path": minted.path,
        "body": body,
    })
}

fn copies(pairs: Vec<(String, String)>) -> Vec<Value> {
    pairs
        .into_iter()
        .map(|(from, to)| json!({ "from": from, "to": to }))
        .collect()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LinkInput {
    title: String,
    url: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UserInput {
    name: String,
    #[serde(default)]
    bio: Option<String>,
    #[serde(default)]
    image: Option<String>,
    #[serde(default)]
    links: Option<Vec<LinkInput>>,
    #[serde(default)]
    status: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AttachmentInput {
    uri: String,
    #[serde(default)]
    alt: Option<String>,
    #[serde(default)]
    name: Option<String>,
}

fn attachments_of(input: Option<Vec<AttachmentInput>>) -> Vec<PubkySocialAttachment> {
    input
        .unwrap_or_default()
        .into_iter()
        .map(|a| PubkySocialAttachment::new(a.uri, a.alt, a.name))
        .collect()
}

/// Which input a new post is read as. Read on its own first, so the members of one kind are
/// unknown members of another.
#[derive(Deserialize)]
struct KindProbe {
    #[serde(default)]
    kind: Option<String>,
    #[serde(flatten)]
    _rest: std::collections::BTreeMap<String, IgnoredAny>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NoteInput {
    content: String,
    /// A note when absent.
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    parent: Option<String>,
    #[serde(default)]
    embed: Option<String>,
    #[serde(default)]
    attachments: Option<Vec<AttachmentInput>>,
    #[serde(default)]
    lock: Option<String>,
    #[serde(default)]
    root: Option<Root>,
    #[serde(default)]
    slug: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ArticleInput {
    #[serde(rename = "kind")]
    _kind: IgnoredAny,
    title: String,
    body: String,
    #[serde(default)]
    cover_image: Option<String>,
    #[serde(default)]
    parent: Option<String>,
    #[serde(default)]
    embed: Option<String>,
    #[serde(default)]
    attachments: Option<Vec<AttachmentInput>>,
    #[serde(default)]
    lock: Option<String>,
    #[serde(default)]
    root: Option<Root>,
    #[serde(default)]
    slug: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ItemInput {
    uri: String,
    #[serde(default)]
    note: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CollectionInput {
    #[serde(rename = "kind")]
    _kind: IgnoredAny,
    name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    items: Option<Vec<ItemInput>>,
    #[serde(default)]
    cover_image: Option<String>,
    #[serde(default)]
    layout: Option<String>,
    #[serde(default)]
    root: Option<Root>,
    #[serde(default)]
    slug: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EditAt {
    id: String,
    /// The newest editId the post has now, the id itself for a never-edited post.
    head: String,
    #[serde(default)]
    root: Option<Root>,
    #[serde(default)]
    slug: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct FeedInput {
    #[serde(default)]
    tags: Option<Vec<String>>,
    #[serde(default)]
    domain_tags: Option<Vec<String>>,
    reach: String,
    layout: String,
    sort: String,
    #[serde(default)]
    content: Option<String>,
    name: String,
    icon: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PublishInput {
    id: String,
    edit_id: String,
    post: PubkySocialPost,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct UnpublishInput {
    id: String,
    public_paths: Vec<String>,
    #[serde(default)]
    legacy_paths: Option<Vec<String>>,
    #[serde(default)]
    private_head: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredCopy {
    root: Root,
    path: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DeleteInput {
    id: String,
    #[serde(default)]
    legacy_paths: Option<Vec<String>>,
    #[serde(default)]
    copies: Option<Vec<StoredCopy>>,
    #[serde(default)]
    versions: Option<Vec<PubkySocialPost>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeletionInput {
    kind: ObjectKind,
    id: String,
    #[serde(default)]
    listings: Option<Vec<Listing>>,
}

/// The three trees a LIST walks.
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Tree {
    Public,
    Private,
    Legacy,
}

/// A parsed URI, flat: the owner, the root, the canonical path and what the path names.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UriParts {
    user_id: String,
    root: Visibility,
    path: String,
    #[serde(flatten)]
    resource: ResourceParts,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum ResourceParts {
    User,
    #[serde(rename_all = "camelCase")]
    Post {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        edit_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        slug: Option<String>,
    },
    Follow {
        id: String,
    },
    Mute {
        id: String,
    },
    Bookmark {
        id: String,
    },
    Tag {
        id: String,
    },
    File {
        id: String,
    },
    Feed {
        id: String,
    },
    Foreign {
        namespace: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        version: Option<String>,
        rest: Vec<String>,
    },
    UnsupportedVersion {
        version: String,
    },
    Unknown,
}

impl ResourceParts {
    fn of(resource: Resource) -> Self {
        match resource {
            Resource::User => Self::User,
            Resource::Post { id, version, label } => Self::Post {
                id,
                edit_id: version,
                slug: label,
            },
            Resource::Follow(pk) => Self::Follow { id: pk.to_string() },
            Resource::Mute(pk) => Self::Mute { id: pk.to_string() },
            Resource::Bookmark(id) => Self::Bookmark { id },
            Resource::Tag(id) => Self::Tag { id },
            file @ Resource::File(_) => Self::File {
                id: file.id().unwrap_or_default(),
            },
            Resource::Feed(id) => Self::Feed { id },
            Resource::Foreign {
                namespace,
                version,
                rest,
            } => Self::Foreign {
                namespace,
                version,
                rest,
            },
            Resource::UnsupportedVersion { version } => Self::UnsupportedVersion { version },
            Resource::Unknown => Self::Unknown,
        }
    }
}

fn value<T: Serialize>(v: &T) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

fn new_post(owner: &PubkyId, input: &str) -> Result<Value, String> {
    let probe: KindProbe = parse(input)?;
    let (post, root, slug) = match probe.kind.as_deref() {
        Some("article") => {
            let i: ArticleInput = parse(input)?;
            let post = PubkySocialPost::new_article(
                i.title,
                i.body,
                i.cover_image,
                i.parent,
                i.embed,
                attachments_of(i.attachments),
                i.lock,
            );
            (post, i.root, i.slug)
        }
        Some("collection") => {
            let i: CollectionInput = parse(input)?;
            let layout = i
                .layout
                .map(|s| PubkySocialCollectionLayout::from_str(&s))
                .transpose()?;
            let items = i
                .items
                .unwrap_or_default()
                .into_iter()
                .map(|item| PubkySocialCollectionItem::new(item.uri, item.note))
                .collect();
            let post = PubkySocialPost::new_collection(
                i.name,
                i.description,
                items,
                i.cover_image,
                layout,
            );
            (post, i.root, i.slug)
        }
        _ => {
            let i: NoteInput = parse(input)?;
            let kind = match i.kind {
                Some(kind) => PubkySocialPostKind::from_str(&kind)?,
                None => PubkySocialPostKind::Note,
            };
            let post = PubkySocialPost::new_with_lock(
                i.content,
                kind,
                i.parent,
                i.embed,
                attachments_of(i.attachments),
                i.lock,
            );
            (post, i.root, i.slug)
        }
    };
    let minted = post.create_version(root.unwrap_or(Root::Pub), owner, slug.as_deref())?;
    Ok(version(owner, minted, body(&post)?))
}

fn read(uri: &str, bytes: Vec<u8>) -> Result<Value, String> {
    let object = PubkySocialObject::from_uri_owned(uri, bytes)?;
    let kind = object.kind().wire_name();
    let body = match &object {
        PubkySocialObject::User(o) => body(o),
        PubkySocialObject::Post(o) => body(o),
        PubkySocialObject::Follow(o) => body(o),
        PubkySocialObject::Mute(o) => body(o),
        PubkySocialObject::Bookmark(o) => body(o),
        PubkySocialObject::Tag(o) => body(o),
        PubkySocialObject::File(o) => Ok(STANDARD.encode(&o.0)),
        PubkySocialObject::Feed(o) => body(o),
    }?;
    Ok(json!({ "kind": kind, "body": body }))
}

fn run(op: &str, a: &mut Args) -> Result<Value, String> {
    Ok(match op {
        // Text, ids and canonical forms: what every rule above them is made of
        "frozenTrim" => frozen_trim(a.s()?).into(),
        "asciiFold" => ascii_fold(a.s()?).into(),
        "codePointLen" => code_point_len(a.s()?).into(),
        "publicKey" => PubkyId::try_from(a.s()?)?.to_string().into(),
        // As a string: a JSON reader of the answer keeps 53 bits of a number
        "timestampId" => validate_timestamp_id_format(a.s()?)?.to_string().into(),
        "hashId" => {
            validate_hash_id_format(a.s()?)?;
            Value::Null
        }
        "canonicalPubky" => value(&canonicalize_pubky_uri(a.s()?).ok())?,
        "canonicalWeb" => value(&canonicalize_web_uri(a.s()?).ok())?,
        "canonicalExternal" => value(&canonicalize_external_uri(a.s()?).ok())?,
        "canonicalUniversal" => value(&canonicalize_universal(a.s()?).ok())?,
        // Any JSON value read and written back, as an unknown member of an object is
        "json" => STANDARD
            .encode(serde_json::to_vec(&a.parsed::<Value>()?).map_err(|e| e.to_string())?)
            .into(),

        "decode" => {
            let uri = a.s()?.to_string();
            read(&uri, a.b()?)?
        }
        "parseUri" => {
            let uri = a.s()?;
            let parsed = ParsedUri::try_from(uri)?;
            let canonical =
                canonicalize_pubky_uri(uri).map_err(|_| "unreachable: parsed above".to_string())?;
            let after_scheme = &canonical[PROTOCOL.len()..];
            let path = after_scheme.find('/').map_or("", |i| &after_scheme[i..]);
            value(&UriParts {
                user_id: parsed.user_id.to_string(),
                root: parsed.visibility,
                path: path.to_string(),
                resource: ResourceParts::of(parsed.resource),
            })?
        }
        "stableKey" => match crate::stable_id(a.s()?) {
            Some(StableId::Key(key)) => json!({ "key": key }),
            Some(StableId::NeedsDeref { tsid }) => json!({ "needsDeref": tsid }),
            None => Value::Null,
        },
        "legacyMediaKey" => value(&crate::resolve_deref("", a.s()?))?,

        "createUser" => {
            let owner = PubkyId::try_from(a.s()?)?;
            let i: UserInput = a.parsed()?;
            let links = i.links.map(|links| {
                links
                    .into_iter()
                    .map(|l| PubkySocialUserLink::new(l.title, l.url))
                    .collect()
            });
            let user = PubkySocialUser::new(i.name, i.bio, i.image, links, i.status);
            user.validate(None, &PUB_CTX)?;
            created(&owner, "", &PubkySocialUser::create_path(), &user)?
        }
        "createPost" => {
            let owner = PubkyId::try_from(a.s()?)?;
            new_post(&owner, a.j()?)?
        }
        "editPost" => {
            let owner = PubkyId::try_from(a.s()?)?;
            let post: PubkySocialPost = a.parsed()?;
            let at: EditAt = a.parsed()?;
            let minted = post.edit_version(
                &at.id,
                &at.head,
                at.root.unwrap_or(Root::Pub),
                &owner,
                at.slug.as_deref(),
            )?;
            version(&owner, minted, body(&post)?)
        }
        "planPublish" => {
            let owner = PubkyId::try_from(a.s()?)?;
            let i: PublishInput = a.parsed()?;
            let plan = crate::plan_publish(&i.id, &i.edit_id, &i.post, &owner)?;
            let minted = crate::MintedVersion {
                id: i.id,
                edit_id: i.edit_id,
                path: plan.dest_path,
            };
            let put = version(&owner, minted, STANDARD.encode(plan.rewritten_post_json));
            json!({ "copies": copies(plan.media_copies), "put": put })
        }
        "planUnpublish" => {
            let i: UnpublishInput = a.parsed()?;
            let plan = crate::plan_unpublish(
                &i.id,
                &i.public_paths,
                &i.legacy_paths.unwrap_or_default(),
                i.private_head.as_deref(),
            )?;
            json!({ "copies": copies(plan.copy_backs), "deletes": plan.deletes })
        }
        "planDelete" => {
            let owner = PubkyId::try_from(a.s()?)?;
            let i: DeleteInput = a.parsed()?;
            let stored: Vec<(Root, String)> = i
                .copies
                .unwrap_or_default()
                .into_iter()
                .map(|c| (c.root, c.path))
                .collect();
            let plan = crate::plan_delete(
                &i.id,
                &i.legacy_paths.unwrap_or_default(),
                &stored,
                &i.versions.unwrap_or_default(),
                &owner,
            )?;
            value(&plan)?
        }

        "createFeed" => {
            let owner = PubkyId::try_from(a.s()?)?;
            let i: FeedInput = a.parsed()?;
            let content = i
                .content
                .map(|c| PubkySocialPostKind::from_str(&c))
                .transpose()?;
            let config = PubkySocialFeedConfig::new(
                i.tags,
                i.domain_tags,
                PubkySocialFeedReach::from_str(&i.reach)?,
                PubkySocialFeedLayout::from_str(&i.layout)?,
                PubkySocialFeedSort::from_str(&i.sort)?,
                content,
            )?;
            let feed = PubkySocialFeed::new(config, i.name, i.icon);
            // derive_id validates the feed first
            let id = feed.derive_id()?;
            created(&owner, &id, &PubkySocialFeed::create_path(&id), &feed)?
        }
        "feedId" => a.parsed::<PubkySocialFeed>()?.derive_id()?.into(),
        "feedPaths" => {
            let id = a.s()?;
            // The plan checks the id; the paths alone would spell any string
            plan_feed_publish(id)?;
            value(&feed_paths(id))?
        }

        "createTag" => {
            let owner = PubkyId::try_from(a.s()?)?;
            let tag = PubkySocialTag::new(a.s()?.to_string(), a.s()?.to_string());
            let id = tag.create_id();
            tag.validate(Some(&id), &PUB_CTX)?;
            created(&owner, &id, &PubkySocialTag::create_path(&id), &tag)?
        }
        "createBookmark" => {
            let owner = PubkyId::try_from(a.s()?)?;
            let made = crate::create_bookmark(a.s()?)?;
            created(&owner, &made.filename, &made.path, &made.bookmark)?
        }
        "bookmarkId" => crate::bookmark_filename(a.s()?)?.into(),
        "bookmarkTarget" => {
            let id = a.s()?;
            let content = a.j()?;
            let bookmark = if content == "null" {
                PubkySocialBookmark::default()
            } else {
                let ctx = ValidationCtx {
                    root: <PubkySocialBookmark as HasIdPath>::ROOT,
                };
                <PubkySocialBookmark as Validatable>::try_from(content.as_bytes(), id, &ctx)?
            };
            crate::bookmark_target(id, &bookmark)?.into()
        }
        "createFollow" => {
            let owner = PubkyId::try_from(a.s()?)?;
            let followee = a.s()?;
            let follow = PubkySocialFollow::new();
            follow.validate(Some(followee), &PUB_CTX)?;
            created(
                &owner,
                followee,
                &PubkySocialFollow::create_path(followee),
                &follow,
            )?
        }
        "createMute" => {
            let owner = PubkyId::try_from(a.s()?)?;
            let mutee = a.s()?;
            let mute = PubkySocialMute::new();
            let ctx = ValidationCtx {
                root: <PubkySocialMute as HasIdPath>::ROOT,
            };
            mute.validate(Some(mutee), &ctx)?;
            created(&owner, mutee, &PubkySocialMute::create_path(mutee), &mute)?
        }

        "createFile" => {
            let owner = PubkyId::try_from(a.s()?)?;
            let bytes = a.b()?;
            let declared = a.s()?.to_string();
            let root = a.parsed::<Option<Root>>()?.unwrap_or(Root::Pub);
            let made = PubkySocialFile::create_file(bytes, &declared, root)?;
            json!({ "id": made.id, "url": url(&owner, &made.path), "path": made.path })
        }
        "mediaId" => {
            let mut hasher = blake3::Hasher::new();
            hasher.update(&a.b()?);
            hash_id_from(&hasher).into()
        }
        "mimeToExt" => mime::mime_to_ext(a.s()?).into(),

        "deletionPaths" => {
            let i: DeletionInput = a.parsed()?;
            value(&deletion::deletion_paths(
                i.kind,
                &i.id,
                &i.listings.unwrap_or_default(),
            )?)?
        }
        "listPrefix" => {
            let owner = PubkyId::try_from(a.s()?)?.to_string();
            match a.parsed::<Tree>()? {
                Tree::Public => list_prefix_builder(owner),
                Tree::Private => private_list_prefix_builder(owner),
                Tree::Legacy => [PROTOCOL, &owner, PUBLIC_PATH, APP_PATH].concat(),
            }
            .into()
        }
        // The builders check the owner key; the second part is spelled as given
        "userUri" => crate::user_uri_builder(PubkyId::try_from(a.s()?)?.to_string()).into(),
        "postUri" | "followUri" | "muteUri" | "bookmarkUri" | "tagUri" | "fileUri" | "feedUri" => {
            let owner = PubkyId::try_from(a.s()?)?.to_string();
            let leaf = a.s()?.to_string();
            match op {
                "postUri" => crate::post_uri_builder(owner, leaf),
                "followUri" => crate::follow_uri_builder(owner, leaf),
                "muteUri" => crate::mute_uri_builder(owner, leaf),
                "bookmarkUri" => crate::bookmark_uri_builder(owner, leaf),
                "tagUri" => crate::tag_uri_builder(owner, leaf),
                "fileUri" => crate::file_uri_builder(owner, leaf),
                _ => crate::feed_uri_builder(owner, leaf),
            }
            .into()
        }
        _ => return Err(format!("surface: no operation {op}")),
    })
}
