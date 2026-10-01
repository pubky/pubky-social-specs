//! The JS surface: plain functions over plain objects.
//!
//! Every export takes and returns plain JS values (strings, `Uint8Array`, objects) and throws
//! an `Error` carrying the crate's own message. The one class is the migration run handle: it
//! holds state that lives across calls (what the 0.x File objects said), and copying that in
//! and out on every call would grow with the tree. Builders take the writing user first, since
//! `meta.url` names them, and return `{object, meta}` where `object` is the wire object exactly
//! as it is stored. The package entry (`pkg/index.js`) wraps every export: it loads the wasm in
//! `init()` and rejects a string argument holding ill-formed UTF-16 before it gets here, since
//! a Rust string cannot carry a lone surrogate and the conversion would replace it silently.
//! Objects cross as `JSON.stringify` text, whose parser refuses one.

use crate::canonicalize::canonicalize_pubky_uri;
use crate::constants::PROTOCOL;
use crate::limits::VALIDATION_LIMITS;
use crate::models::deletion;
use crate::traits::{HasIdPath, HasPath, HashId, Root, Validatable, ValidationCtx, PUB_CTX};
use crate::{
    feed_paths as feed_paths_of, list_prefix_builder, mime, plan_feed_delete, plan_feed_publish,
    plan_feed_unpublish, private_list_prefix_builder, Listing, ObjectKind, ParsedUri, PubkyId,
    PubkySocialAttachment, PubkySocialBookmark, PubkySocialCollectionItem,
    PubkySocialCollectionLayout, PubkySocialFeed, PubkySocialFeedConfig, PubkySocialFeedLayout,
    PubkySocialFeedReach, PubkySocialFeedSort, PubkySocialFile, PubkySocialFollow, PubkySocialMute,
    PubkySocialObject, PubkySocialPost, PubkySocialPostKind, PubkySocialTag, PubkySocialUser,
    PubkySocialUserLink, Resource, StableId, Visibility,
};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::fmt::Display;
use std::str::FromStr;
use tsify_next::Tsify;
use wasm_bindgen::prelude::*;

fn fail(e: impl Display) -> JsError {
    JsError::new(&e.to_string())
}

/// Through `JSON.parse`, so the result is what a reader of the stored bytes gets: own data
/// properties only. A direct serializer assigns members, and a stored `__proto__` member
/// would become the object's prototype instead of a member.
fn to_js<T: Serialize + ?Sized>(value: &T) -> Result<JsValue, JsError> {
    let json = serde_json::to_string(value).map_err(fail)?;
    js_sys::JSON::parse(&json).map_err(|_| fail("Validation Error: unreachable, JSON.parse"))
}

/// The bytes a PUT of `value` would send: `JSON.stringify` decides what JS stores (a
/// `toJSON`, a dropped `undefined`, an integer past 2^53), so it decides what is checked.
/// `undefined` stands for an absent argument and reads as `null`.
fn json_of(value: &JsValue) -> Result<String, JsError> {
    if value.is_undefined() {
        return Ok("null".to_string());
    }
    let json = js_sys::JSON::stringify(value)
        .ok()
        .ok_or_else(|| fail("Validation Error: the value has no JSON form"))?;
    // Escaping expands a byte to six at most, so text past this bound holds no object under
    // the largest cap. Refusing it here keeps it out of linear memory, which never shrinks
    if json.length() as usize > 6 * VALIDATION_LIMITS.post_max_bytes {
        return Err(fail(format!(
            "Validation Error: the value's JSON form is over {} bytes",
            6 * VALIDATION_LIMITS.post_max_bytes
        )));
    }
    json.as_string()
        .ok_or_else(|| fail("Validation Error: the value has no JSON form"))
}

/// Parses the JSON form, so an unknown member of an input is an error: a deserializer walking
/// the JS object only asks it for the fields it expects.
fn from_js<T: DeserializeOwned>(value: JsValue) -> Result<T, JsError> {
    serde_json::from_str(&json_of(&value)?).map_err(|e| fail(format!("Validation Error: {e}")))
}

fn owner_of(owner: &str) -> Result<PubkyId, JsError> {
    PubkyId::try_from(owner).map_err(fail)
}

/// A plain object from named values, for the shapes serde cannot give (a `Uint8Array` member).
fn object_of(members: &[(&str, &JsValue)]) -> Result<JsValue, JsError> {
    let out = js_sys::Object::new();
    for (name, value) in members {
        // A setter or a read-only member planted on Object.prototype intercepts the set, by
        // throwing or by refusing; an object missing a member must not come back as a result
        match js_sys::Reflect::set(&out, &JsValue::from_str(name), value) {
            Ok(true) => {}
            _ => {
                return Err(fail(format!(
                    "Validation Error: cannot set member {name} on a plain object"
                )))
            }
        }
    }
    Ok(out.into())
}

/// Where a built object goes. `id` is empty for the profile, `path` is owner-relative and
/// `url` the full `pubky://` URI.
#[derive(Serialize, Tsify)]
pub struct Meta {
    pub id: String,
    pub path: String,
    pub url: String,
}

impl Meta {
    fn new(owner: &PubkyId, id: &str, path: String) -> Self {
        Self {
            id: id.to_string(),
            url: [PROTOCOL, owner.as_ref(), &path].concat(),
            path,
        }
    }
}

fn created(object: JsValue, meta: Meta) -> Result<JsValue, JsError> {
    object_of(&[("object", &object), ("meta", &to_js(&meta)?)])
}

/// Media has no JSON form, so it crosses as `{bytes}`, one copy out of wasm memory.
fn file_object(file: &PubkySocialFile) -> Result<JsValue, JsError> {
    object_of(&[("bytes", &js_sys::Uint8Array::from(&file.0[..]).into())])
}

/// `undefined` or `"public"` is the public root.
fn root_of(root: JsValue) -> Result<Root, JsError> {
    Ok(from_js::<Option<Root>>(root)?.unwrap_or(Root::Pub))
}

fn post_created(
    post: &PubkySocialPost,
    owner: &PubkyId,
    root: Option<Root>,
) -> Result<JsValue, JsError> {
    let minted = post
        .create_version(root.unwrap_or(Root::Pub), owner, None)
        .map_err(fail)?;
    created(to_js(post)?, Meta::new(owner, &minted.id, minted.path))
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

/// A resource as the parser classifies it. `foreign`, `unsupportedVersion` and `unknown` are
/// classifications, never errors.
#[derive(Serialize, Tsify)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ResourceParts {
    User,
    Post {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        version: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        label: Option<String>,
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
    /// `id` is the hash; the extension lives in the path.
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
            Resource::Post { id, version, label } => Self::Post { id, version, label },
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

/// A parsed `pubky://` URI. `path` is the canonical owner-relative path, empty for a bare host.
#[derive(Serialize, Tsify)]
#[serde(rename_all = "camelCase")]
pub struct UriParts {
    pub user_id: String,
    pub visibility: Visibility,
    pub resource: ResourceParts,
    pub path: String,
}

/// Classifies a URI. Throws only when it is not a canonical pubky URI with a known root.
#[wasm_bindgen(js_name = parseUri)]
pub fn parse_uri(uri: &str) -> Result<JsValue, JsError> {
    let parsed = ParsedUri::try_from(uri).map_err(fail)?;
    let canonical = canonicalize_pubky_uri(uri).map_err(|_| fail("unreachable: parsed above"))?;
    let after_scheme = &canonical[PROTOCOL.len()..];
    let path = after_scheme.find('/').map_or("", |i| &after_scheme[i..]);
    to_js(&UriParts {
        user_id: parsed.user_id.to_string(),
        visibility: parsed.visibility,
        resource: ResourceParts::of(parsed.resource),
        path: path.to_string(),
    })
}

/// The cross-epoch dedup key of a stored path.
#[derive(Serialize, Tsify)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StableKey {
    Key { key: String },
    NeedsDeref { tsid: String },
}

/// `{kind: "key", key}`, or `{kind: "needsDeref", tsid}` for a legacy media reference that its
/// v0 File object completes through `resolveDeref`, or `null` for a path that is no object.
#[wasm_bindgen(js_name = stableId)]
pub fn stable_id(owner_relative_path: &str) -> Result<JsValue, JsError> {
    let key = crate::stable_id(owner_relative_path).map(|id| match id {
        StableId::Key(key) => StableKey::Key { key },
        StableId::NeedsDeref { tsid } => StableKey::NeedsDeref { tsid },
    });
    to_js(&key)
}

/// Completes a legacy media key from the v0 File object's `src`: `files/{hash}`, or null
/// when the src is no legacy blob reference.
#[wasm_bindgen(js_name = resolveDeref, unchecked_return_type = "string | null")]
pub fn resolve_deref(tsid: &str, v0_file_src: &str) -> Result<JsValue, JsError> {
    to_js(&crate::resolve_deref(tsid, v0_file_src))
}

fn object_js(object: &PubkySocialObject) -> Result<JsValue, JsError> {
    match object {
        PubkySocialObject::User(o) => to_js(o),
        PubkySocialObject::Post(o) => to_js(o),
        PubkySocialObject::Follow(o) => to_js(o),
        PubkySocialObject::Mute(o) => to_js(o),
        PubkySocialObject::Bookmark(o) => to_js(o),
        PubkySocialObject::Tag(o) => to_js(o),
        PubkySocialObject::File(o) => file_object(o),
        PubkySocialObject::Feed(o) => to_js(o),
    }
}

/// Reads whatever is stored at `uri` into `{kind, object}`, validated against the id, the
/// root and the author the URI names. Media comes back as `{kind: "file", object: {bytes}}`.
#[wasm_bindgen(js_name = readObject)]
// An owned Vec is the one copy out of the Uint8Array, and media keeps it
pub fn read_object(uri: &str, bytes: Vec<u8>) -> Result<JsValue, JsError> {
    let object = PubkySocialObject::from_uri_owned(uri, bytes).map_err(fail)?;
    let kind = JsValue::from_str(object.kind().wire_name());
    object_of(&[("kind", &kind), ("object", &object_js(&object)?)])
}

/// Throws unless `object` is valid at `uri`, by the path `readObject` takes: for an object
/// read, edited in memory and about to be PUT back with its unknown members intact.
#[wasm_bindgen]
pub fn validate(uri: &str, object: JsValue) -> Result<(), JsError> {
    let parsed = ParsedUri::try_from(uri).map_err(fail)?;
    let bytes = match parsed.resource {
        // instanceof fails for a Uint8Array from another realm, which the entry accepts, so
        // the check is by tag
        Resource::File(_) => js_sys::Reflect::get(&object, &JsValue::from_str("bytes"))
            .ok()
            .filter(|b| {
                js_sys::Reflect::get(b, &js_sys::Symbol::to_string_tag())
                    .ok()
                    .and_then(|t| t.as_string())
                    .as_deref()
                    == Some("Uint8Array")
            })
            .ok_or_else(|| fail("Validation Error: a media object is {bytes: Uint8Array}"))
            // Copied through the constructor, which reads the view's own length rather than
            // a `length` a subclass reports, so the copy cannot outrun its allocation
            .map(|b| js_sys::Uint8Array::new(&b).to_vec())?,
        _ => json_of(&object)?.into_bytes(),
    };
    PubkySocialObject::from_uri_owned(uri, bytes).map_err(fail)?;
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------------------------

#[derive(Deserialize, Tsify)]
#[tsify(missing_as_null)]
#[serde(deny_unknown_fields)]
pub struct LinkInput {
    pub title: String,
    pub url: String,
}

#[derive(Deserialize, Tsify)]
#[tsify(missing_as_null)]
#[serde(deny_unknown_fields)]
pub struct CreateUserInput {
    pub name: String,
    #[serde(default)]
    pub bio: Option<String>,
    #[serde(default)]
    pub image: Option<String>,
    #[serde(default)]
    pub links: Option<Vec<LinkInput>>,
    #[serde(default)]
    pub status: Option<String>,
}

/// A fresh profile. `image` and each link `url` are stored as written and must already be
/// canonical; the builder trims the display text. Changing a stored profile and keeping what
/// this version does not know is `readObject`, edit, `validate`.
#[wasm_bindgen(js_name = createUser)]
pub fn create_user(owner: &str, input: JsValue) -> Result<JsValue, JsError> {
    let owner = owner_of(owner)?;
    let input: CreateUserInput = from_js(input)?;
    let links = input.links.map(|links| {
        links
            .into_iter()
            .map(|l| PubkySocialUserLink::new(l.title, l.url))
            .collect()
    });
    let user = PubkySocialUser::new(input.name, input.bio, input.image, links, input.status);
    user.validate(None, &PUB_CTX).map_err(fail)?;
    let path = PubkySocialUser::create_path();
    created(to_js(&user)?, Meta::new(&owner, "", path))
}

// ---------------------------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------------------------

#[derive(Deserialize, Tsify)]
#[tsify(missing_as_null)]
#[serde(deny_unknown_fields)]
pub struct AttachmentInput {
    pub uri: String,
    #[serde(default)]
    pub alt: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

fn attachments_of(input: Option<Vec<AttachmentInput>>) -> Vec<PubkySocialAttachment> {
    input
        .unwrap_or_default()
        .into_iter()
        .map(|a| PubkySocialAttachment::new(a.uri, a.alt, a.name))
        .collect()
}

#[derive(Deserialize, Tsify)]
#[tsify(missing_as_null)]
#[serde(deny_unknown_fields)]
pub struct CreatePostInput {
    pub content: String,
    /// A note when absent.
    #[serde(default)]
    #[tsify(type = "Exclude<PubkySocialPostKind, \"unknown\"> | null")]
    pub kind: Option<String>,
    #[serde(default)]
    pub parent: Option<String>,
    #[serde(default)]
    pub embed: Option<String>,
    #[serde(default)]
    pub attachments: Option<Vec<AttachmentInput>>,
    #[serde(default)]
    pub lock: Option<String>,
    /// The public root when absent; a private draft may reference the owner's private media.
    #[serde(default)]
    pub root: Option<Root>,
}

/// A post at `posts/{id}/{id}.json`, the id minted here. A readable slug goes through
/// `createVersion` with the built object.
#[wasm_bindgen(js_name = createPost)]
pub fn create_post(owner: &str, input: JsValue) -> Result<JsValue, JsError> {
    let owner = owner_of(owner)?;
    let input: CreatePostInput = from_js(input)?;
    let kind = match input.kind {
        Some(kind) => PubkySocialPostKind::from_str(&kind).map_err(fail)?,
        None => PubkySocialPostKind::Note,
    };
    let post = PubkySocialPost::new_with_lock(
        input.content,
        kind,
        input.parent,
        input.embed,
        attachments_of(input.attachments),
        input.lock,
    );
    post_created(&post, &owner, input.root)
}

#[derive(Deserialize, Tsify)]
#[tsify(missing_as_null)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CreateArticlePostInput {
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub cover_image: Option<String>,
    #[serde(default)]
    pub parent: Option<String>,
    #[serde(default)]
    pub embed: Option<String>,
    #[serde(default)]
    pub attachments: Option<Vec<AttachmentInput>>,
    #[serde(default)]
    pub lock: Option<String>,
    /// The public root when absent; a private draft may reference the owner's private media.
    #[serde(default)]
    pub root: Option<Root>,
}

/// A `kind: "article"` post; the builder writes the `{title, body, cover_image?}` envelope
/// into `content` and trims the title.
#[wasm_bindgen(js_name = createArticlePost)]
pub fn create_article_post(owner: &str, input: JsValue) -> Result<JsValue, JsError> {
    let owner = owner_of(owner)?;
    let input: CreateArticlePostInput = from_js(input)?;
    let post = PubkySocialPost::new_article(
        input.title,
        input.body,
        input.cover_image,
        input.parent,
        input.embed,
        attachments_of(input.attachments),
        input.lock,
    );
    post_created(&post, &owner, input.root)
}

#[derive(Deserialize, Tsify)]
#[tsify(missing_as_null)]
#[serde(deny_unknown_fields)]
pub struct CollectionItemInput {
    pub uri: String,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Deserialize, Tsify)]
#[tsify(missing_as_null)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CreateCollectionPostInput {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub items: Option<Vec<CollectionItemInput>>,
    #[serde(default)]
    pub cover_image: Option<String>,
    #[serde(default)]
    #[tsify(type = "Exclude<PubkySocialCollectionLayout, \"unknown\"> | null")]
    pub layout: Option<String>,
    /// The public root when absent; a private draft may reference the owner's private media.
    #[serde(default)]
    pub root: Option<Root>,
}

/// A `kind: "collection"` post; the builder writes the envelope into `content`, trimming the
/// name, the description and each note, a blank description or note becoming absent. A
/// collection takes no parent, embed or attachments.
#[wasm_bindgen(js_name = createCollectionPost)]
pub fn create_collection_post(owner: &str, input: JsValue) -> Result<JsValue, JsError> {
    let owner = owner_of(owner)?;
    let input: CreateCollectionPostInput = from_js(input)?;
    let layout = input
        .layout
        .map(|s| PubkySocialCollectionLayout::from_str(&s))
        .transpose()
        .map_err(fail)?;
    let items = input
        .items
        .unwrap_or_default()
        .into_iter()
        .map(|i| PubkySocialCollectionItem::new(i.uri, i.note))
        .collect();
    let post = PubkySocialPost::new_collection(
        input.name,
        input.description,
        items,
        input.cover_image,
        layout,
    );
    post_created(&post, &owner, input.root)
}

#[derive(Default, Deserialize, Tsify)]
#[tsify(missing_as_null)]
#[serde(deny_unknown_fields)]
pub struct CreateVersionOptions {
    /// The public root when absent.
    #[serde(default)]
    pub root: Option<Root>,
    #[serde(default)]
    pub slug: Option<String>,
}

/// Where a version of a post goes: [`Meta`] and the version's own id.
#[derive(Serialize, Tsify)]
#[serde(rename_all = "camelCase")]
pub struct VersionMeta {
    pub id: String,
    pub edit_id: String,
    pub path: String,
    pub url: String,
}

impl VersionMeta {
    fn of(owner: &PubkyId, minted: crate::MintedVersion) -> Self {
        let meta = Meta::new(owner, &minted.id, minted.path);
        Self {
            id: meta.id,
            edit_id: minted.edit_id,
            path: meta.path,
            url: meta.url,
        }
    }
}

/// Where a new post is stored: mints the post id, validates the post under the root with its
/// author in scope, returns `{id, editId, path, url}` with `editId == id`.
#[wasm_bindgen(js_name = createVersion)]
pub fn create_version(owner: &str, post: JsValue, options: JsValue) -> Result<JsValue, JsError> {
    let owner = owner_of(owner)?;
    let post: PubkySocialPost = from_js(post)?;
    let options = from_js::<Option<CreateVersionOptions>>(options)?.unwrap_or_default();
    let root = options.root.unwrap_or(Root::Pub);
    let minted = post
        .create_version(root, &owner, options.slug.as_deref())
        .map_err(fail)?;
    to_js(&VersionMeta::of(&owner, minted))
}

#[derive(Deserialize, Tsify)]
#[tsify(missing_as_null)]
#[serde(deny_unknown_fields)]
pub struct EditVersionOptions {
    pub id: String,
    /// The newest editId the post has now, the id itself for a never-edited post.
    pub head: String,
    /// The public root when absent.
    #[serde(default)]
    pub root: Option<Root>,
    #[serde(default)]
    pub slug: Option<String>,
}

/// Where an edit of post `id` is stored: an editId strictly above `head`.
#[wasm_bindgen(js_name = editVersion)]
pub fn edit_version(owner: &str, post: JsValue, options: JsValue) -> Result<JsValue, JsError> {
    let owner = owner_of(owner)?;
    let post: PubkySocialPost = from_js(post)?;
    let options: EditVersionOptions = from_js(options)?;
    let root = options.root.unwrap_or(Root::Pub);
    let minted = post
        .edit_version(
            &options.id,
            &options.head,
            root,
            &owner,
            options.slug.as_deref(),
        )
        .map_err(fail)?;
    to_js(&VersionMeta::of(&owner, minted))
}

/// Publishing one private version: the media copies to run first, then `rewrittenPost` to
/// PUT at `destPath`.
#[wasm_bindgen(js_name = planPublish)]
pub fn plan_publish(
    owner: &str,
    post_id: &str,
    edit_id: &str,
    post: JsValue,
) -> Result<JsValue, JsError> {
    let owner = owner_of(owner)?;
    let post: PubkySocialPost = from_js(post)?;
    let plan = crate::plan_publish(post_id, edit_id, &post, &owner).map_err(fail)?;
    let rewritten: serde_json::Value =
        serde_json::from_str(&plan.rewritten_post_json).map_err(fail)?;
    to_js(&serde_json::json!({
        "mediaCopies": plan.media_copies,
        "rewrittenPost": rewritten,
        "destPath": plan.dest_path,
    }))
}

/// Unpublishing: the copy-backs into the private root, then the deletes.
#[wasm_bindgen(js_name = planUnpublish)]
pub fn plan_unpublish(
    post_id: &str,
    public_paths: Vec<String>,
    legacy_paths: Vec<String>,
    private_head_path: Option<String>,
) -> Result<JsValue, JsError> {
    let plan = crate::plan_unpublish(
        post_id,
        &public_paths,
        &legacy_paths,
        private_head_path.as_deref(),
    )
    .map_err(fail)?;
    to_js(&plan)
}

/// One stored copy of a post version.
#[derive(Deserialize, Tsify)]
#[tsify(missing_as_null)]
#[serde(deny_unknown_fields)]
pub struct StoredCopy {
    pub root: Root,
    pub path: String,
}

/// Deleting a post everywhere: the deletes in order, then the media to garbage collect.
#[wasm_bindgen(js_name = planDelete)]
pub fn plan_delete(
    owner: &str,
    post_id: &str,
    legacy_paths: Vec<String>,
    copies: JsValue,
    versions: JsValue,
) -> Result<JsValue, JsError> {
    let owner = owner_of(owner)?;
    let copies: Vec<StoredCopy> = from_js(copies)?;
    let copies: Vec<(Root, String)> = copies.into_iter().map(|c| (c.root, c.path)).collect();
    let versions: Vec<PubkySocialPost> = from_js(versions)?;
    let plan =
        crate::plan_delete(post_id, &legacy_paths, &copies, &versions, &owner).map_err(fail)?;
    to_js(&plan)
}

// ---------------------------------------------------------------------------------------------
// Feeds
// ---------------------------------------------------------------------------------------------

#[derive(Deserialize, Tsify)]
#[tsify(missing_as_null)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CreateFeedInput {
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub domain_tags: Option<Vec<String>>,
    #[tsify(type = "Exclude<PubkySocialFeedReach, \"unknown\">")]
    pub reach: String,
    #[tsify(type = "Exclude<PubkySocialFeedLayout, \"unknown\">")]
    pub layout: String,
    #[tsify(type = "Exclude<PubkySocialFeedSort, \"unknown\">")]
    pub sort: String,
    #[serde(default)]
    #[tsify(type = "Exclude<PubkySocialPostKind, \"unknown\"> | null")]
    pub content: Option<String>,
    pub name: String,
    /// Required on a new feed; only legacy stored feeds lack one.
    pub icon: String,
}

/// A feed at its private path; the id is derived from the filter alone.
#[wasm_bindgen(js_name = createFeed)]
pub fn create_feed(owner: &str, input: JsValue) -> Result<JsValue, JsError> {
    let owner = owner_of(owner)?;
    let input: CreateFeedInput = from_js(input)?;
    let content = input
        .content
        .map(|c| PubkySocialPostKind::from_str(&c))
        .transpose()
        .map_err(fail)?;
    let config = PubkySocialFeedConfig::new(
        input.tags,
        input.domain_tags,
        PubkySocialFeedReach::from_str(&input.reach).map_err(fail)?,
        PubkySocialFeedLayout::from_str(&input.layout).map_err(fail)?,
        PubkySocialFeedSort::from_str(&input.sort).map_err(fail)?,
        content,
    )
    .map_err(fail)?;
    let feed = PubkySocialFeed::new(config, input.name, input.icon);
    // derive_id validates the feed first
    let id = feed.derive_id().map_err(fail)?;
    let path = PubkySocialFeed::create_path(&id);
    created(to_js(&feed)?, Meta::new(&owner, &id, path))
}

/// The id of a feed object, derived from its filter: an edited feed gets its new id here
/// without a rebuild through `createFeed`, which would drop its unknown members.
#[wasm_bindgen(js_name = feedId)]
pub fn feed_id(feed: JsValue) -> Result<String, JsError> {
    let feed: PubkySocialFeed = from_js(feed)?;
    feed.derive_id().map_err(fail)
}

/// `{private, public}`: a feed lives at `private`, and its published copy is the same bytes
/// at `public`.
#[wasm_bindgen(js_name = feedPaths)]
pub fn feed_paths(id: &str) -> Result<JsValue, JsError> {
    to_js(&feed_paths_of(id))
}

#[derive(Serialize, Tsify)]
pub struct FeedCopy {
    pub from: String,
    pub to: String,
}

/// Every path a feed lifecycle step touches, in the order to run them.
#[derive(Serialize, Tsify)]
pub struct FeedLifecycle {
    pub publish: FeedCopy,
    pub unpublish: Vec<String>,
    pub delete: Vec<String>,
}

/// What publishing, unpublishing and deleting the feed touch. A delete of a missing path is a
/// skip; the publish copy always runs, since name and icon live outside the id.
#[wasm_bindgen(js_name = feedLifecycle)]
pub fn feed_lifecycle(id: &str) -> Result<JsValue, JsError> {
    let (from, to) = plan_feed_publish(id).map_err(fail)?.copy;
    to_js(&FeedLifecycle {
        publish: FeedCopy { from, to },
        unpublish: vec![plan_feed_unpublish(id).map_err(fail)?.delete],
        delete: plan_feed_delete(id).map_err(fail)?.deletes,
    })
}

// ---------------------------------------------------------------------------------------------
// Tags, bookmarks, graph
// ---------------------------------------------------------------------------------------------

/// A tag on `uri`; the builder folds the label, the uri must already be canonical.
#[wasm_bindgen(js_name = createTag)]
pub fn create_tag(owner: &str, uri: String, label: String) -> Result<JsValue, JsError> {
    let owner = owner_of(owner)?;
    let tag = PubkySocialTag::new(uri, label);
    let id = tag.create_id();
    tag.validate(Some(&id), &PUB_CTX).map_err(fail)?;
    let path = PubkySocialTag::create_path(&id);
    created(to_js(&tag)?, Meta::new(&owner, &id, path))
}

/// A bookmark of `target`; `meta.id` is the filename, which carries the target.
#[wasm_bindgen(js_name = createBookmark)]
pub fn create_bookmark(owner: &str, target: &str) -> Result<JsValue, JsError> {
    let owner = owner_of(owner)?;
    let made = crate::create_bookmark(target).map_err(fail)?;
    let meta = Meta::new(&owner, &made.filename, made.path);
    created(to_js(&made.bookmark)?, meta)
}

/// The filename `target` is bookmarked under, without building an object.
#[wasm_bindgen(js_name = bookmarkFilename)]
pub fn bookmark_filename(target: &str) -> Result<String, JsError> {
    crate::bookmark_filename(target).map_err(fail)
}

/// The target a stored bookmark names. `filename` is the leaf without `.json`; `content` is
/// the stored object, needed only for the `~` overflow form, so a primary entry reads from a
/// LIST alone. Throws when the entry breaks the filename rules, so a reader skips it.
#[wasm_bindgen(js_name = bookmarkTarget)]
pub fn bookmark_target(filename: &str, content: JsValue) -> Result<String, JsError> {
    let bookmark = if content.is_undefined() || content.is_null() {
        PubkySocialBookmark::default()
    } else {
        let ctx = ValidationCtx {
            root: <PubkySocialBookmark as HasIdPath>::ROOT,
        };
        let bytes = json_of(&content)?.into_bytes();
        <PubkySocialBookmark as Validatable>::try_from(&bytes, filename, &ctx).map_err(fail)?
    };
    crate::bookmark_target(filename, &bookmark).map_err(fail)
}

/// A follow of `followee`, a public object.
#[wasm_bindgen(js_name = createFollow)]
pub fn create_follow(owner: &str, followee: &str) -> Result<JsValue, JsError> {
    let owner = owner_of(owner)?;
    let follow = PubkySocialFollow::new();
    follow.validate(Some(followee), &PUB_CTX).map_err(fail)?;
    let path = PubkySocialFollow::create_path(followee);
    created(to_js(&follow)?, Meta::new(&owner, followee, path))
}

/// A mute of `mutee`, under the private root.
#[wasm_bindgen(js_name = createMute)]
pub fn create_mute(owner: &str, mutee: &str) -> Result<JsValue, JsError> {
    let owner = owner_of(owner)?;
    let mute = PubkySocialMute::new();
    let ctx = ValidationCtx {
        root: <PubkySocialMute as HasIdPath>::ROOT,
    };
    mute.validate(Some(mutee), &ctx).map_err(fail)?;
    let path = PubkySocialMute::create_path(mutee);
    created(to_js(&mute)?, Meta::new(&owner, mutee, path))
}

// ---------------------------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------------------------

/// Media, content addressed: `meta.id` is the hash of the bytes and `meta.path` carries the
/// extension the declared type maps to; the type itself is not stored. `root` defaults to
/// `"public"`; `"private"` is where a draft's media goes.
// An owned Vec is one copy out of the Uint8Array, moved into the object; a JsValue would be
// deserialized one element at a time, seconds at the cap
#[wasm_bindgen(js_name = createFile)]
pub fn create_file(
    owner: &str,
    bytes: Vec<u8>,
    declared_type: &str,
    root: JsValue,
) -> Result<JsValue, JsError> {
    let owner = owner_of(owner)?;
    let root = root_of(root)?;
    let made = PubkySocialFile::create_file(bytes, declared_type, root).map_err(fail)?;
    let meta = Meta::new(&owner, &made.id, made.path);
    created(file_object(&made.file)?, meta)
}

/// A media id computed a chunk at a time, for bytes too large to copy into the wasm whole.
/// Opaque to JS; `hasherFinish` consumes it. The migration engine is its caller, so it ships
/// with the migrator.
#[cfg(feature = "migrator")]
#[wasm_bindgen]
pub struct Hasher {
    inner: blake3::Hasher,
}

#[cfg(feature = "migrator")]
#[wasm_bindgen(js_name = hasherNew)]
pub fn hasher_new() -> Hasher {
    Hasher {
        inner: blake3::Hasher::new(),
    }
}

/// Feeds the next chunk; only the chunk is copied in.
#[cfg(feature = "migrator")]
#[wasm_bindgen(js_name = hasherUpdate)]
pub fn hasher_update(hasher: &mut Hasher, chunk: &[u8]) {
    hasher.inner.update(chunk);
}

/// The id of everything fed, spelled as `createFile` spells `meta.id`.
#[cfg(feature = "migrator")]
#[wasm_bindgen(js_name = hasherFinish)]
pub fn hasher_finish(hasher: Hasher) -> String {
    crate::traits::hash_id_from(&hasher.inner)
}

/// The path extension a declared type maps to; `"bin"` for anything unmapped or malformed.
#[wasm_bindgen(js_name = mimeToExt)]
pub fn mime_to_ext(declared: &str) -> String {
    mime::mime_to_ext(declared)
}

/// The essence of a declared type, or null when it is malformed.
#[wasm_bindgen(unchecked_return_type = "string | null")]
pub fn essence(declared: &str) -> Result<JsValue, JsError> {
    to_js(&mime::essence(declared))
}

// ---------------------------------------------------------------------------------------------
// Deletion and prefixes
// ---------------------------------------------------------------------------------------------

#[derive(Deserialize, Tsify)]
#[tsify(missing_as_null)]
#[serde(deny_unknown_fields)]
pub struct DeletionInput {
    pub kind: ObjectKind,
    pub id: String,
    /// The copies found; only a post, a file and a tag take any.
    #[serde(default)]
    pub listings: Option<Vec<Listing>>,
}

/// Every stored copy of one object across epochs and roots, legacy first.
#[wasm_bindgen(js_name = deletionPaths)]
pub fn deletion_paths(input: JsValue) -> Result<Vec<String>, JsError> {
    let input: DeletionInput = from_js(input)?;
    let listings = input.listings.unwrap_or_default();
    deletion::deletion_paths(input.kind, &input.id, &listings).map_err(fail)
}

/// The LIST prefix of the social namespace under `root`, `pubky://{user}/{pub|priv}/social/v1/`.
/// Not a URI: the trailing slash is deliberate and the parser rejects it.
#[wasm_bindgen(js_name = listPrefix)]
pub fn list_prefix(user_id: String, root: JsValue) -> Result<String, JsError> {
    owner_of(&user_id)?;
    Ok(match from_js::<Root>(root)? {
        Root::Pub => list_prefix_builder(user_id),
        Root::Priv => private_list_prefix_builder(user_id),
    })
}

/// The LIST prefix of the 0.x tree, `pubky://{user}/pub/pubky.app/`, which an account delete
/// or an export also walks.
#[wasm_bindgen(js_name = legacyListPrefix)]
pub fn legacy_list_prefix(user_id: &str) -> Result<String, JsError> {
    owner_of(user_id)?;
    use crate::models::legacy_v0::{APP_PATH, PUBLIC_PATH};
    Ok([PROTOCOL, user_id, PUBLIC_PATH, APP_PATH].concat())
}

// The URI builders check the owner key; the second part is spelled as given.

#[wasm_bindgen(js_name = userUriBuilder)]
pub fn user_uri_builder(user_id: String) -> Result<String, JsError> {
    owner_of(&user_id)?;
    Ok(crate::user_uri_builder(user_id))
}

#[wasm_bindgen(js_name = postUriBuilder)]
pub fn post_uri_builder(author_id: String, post_id: String) -> Result<String, JsError> {
    owner_of(&author_id)?;
    Ok(crate::post_uri_builder(author_id, post_id))
}

#[wasm_bindgen(js_name = followUriBuilder)]
pub fn follow_uri_builder(author_id: String, follow_id: String) -> Result<String, JsError> {
    owner_of(&author_id)?;
    Ok(crate::follow_uri_builder(author_id, follow_id))
}

#[wasm_bindgen(js_name = muteUriBuilder)]
pub fn mute_uri_builder(author_id: String, mute_id: String) -> Result<String, JsError> {
    owner_of(&author_id)?;
    Ok(crate::mute_uri_builder(author_id, mute_id))
}

#[wasm_bindgen(js_name = bookmarkUriBuilder)]
pub fn bookmark_uri_builder(author_id: String, filename: String) -> Result<String, JsError> {
    owner_of(&author_id)?;
    Ok(crate::bookmark_uri_builder(author_id, filename))
}

#[wasm_bindgen(js_name = tagUriBuilder)]
pub fn tag_uri_builder(author_id: String, tag_id: String) -> Result<String, JsError> {
    owner_of(&author_id)?;
    Ok(crate::tag_uri_builder(author_id, tag_id))
}

/// Takes the full `{hash}.{ext}` filename: an extension cannot be derived from an id.
#[wasm_bindgen(js_name = fileUriBuilder)]
pub fn file_uri_builder(author_id: String, filename: String) -> Result<String, JsError> {
    owner_of(&author_id)?;
    Ok(crate::file_uri_builder(author_id, filename))
}

/// The private path, where a feed lives.
#[wasm_bindgen(js_name = feedUriBuilder)]
pub fn feed_uri_builder(author_id: String, feed_id: String) -> Result<String, JsError> {
    owner_of(&author_id)?;
    Ok(crate::feed_uri_builder(author_id, feed_id))
}

// ---------------------------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------------------------

#[cfg(feature = "migrator")]
pub use migration::{create_migration, migrate, migrate_blob, Migration};

#[cfg(feature = "migrator")]
mod migration {
    use super::*;
    use crate::migrate::MigrationCtx;

    /// One run over an owner's 0.x tree: what the v0 File objects read so far say about
    /// names, blobs and extensions. Opaque to JS; `free()` it when the run ends.
    #[wasm_bindgen]
    pub struct Migration {
        ctx: MigrationCtx,
    }

    /// A run for `owner`; feed it every path of the 0.x tree through `migrate`.
    #[wasm_bindgen(js_name = createMigration)]
    pub fn create_migration(owner: &str) -> Result<Migration, JsError> {
        Ok(Migration {
            ctx: MigrationCtx::new(owner_of(owner)?),
        })
    }

    /// One 0.x object by its owner-relative path or the full `pubky://` URL a LIST returns:
    /// `{writes, dropped}`, each write as `readObject` reads it plus its `meta`, or `{skip}`
    /// with the category and, when the reader that refused it said why, its `note`. A File
    /// object is read into the run and writes nothing, so walk `files/` first.
    /// A skip as the JS caller reads it: `{skip, note?}`.
    fn skipped_js(skipped: &crate::migrate::Skipped) -> Result<JsValue, JsError> {
        let mut result = serde_json::json!({ "skip": skipped.skip.as_str() });
        if let Some(note) = &skipped.note {
            result["note"] = note.clone().into();
        }
        to_js(&result)
    }

    #[wasm_bindgen]
    pub fn migrate(
        migration: &mut Migration,
        v0_path: &str,
        bytes: &[u8],
    ) -> Result<JsValue, JsError> {
        let migrated = match migration.ctx.migrate(v0_path, bytes) {
            Ok(migrated) => migrated,
            Err(skipped) => return skipped_js(&skipped),
        };
        let owner = migration.ctx.owner();
        let writes = js_sys::Array::new();
        for (path, bytes) in migrated.writes {
            writes.push(&write_js(owner, &path, Some(bytes))?);
        }
        let dropped: Vec<String> = migrated.dropped.iter().map(ToString::to_string).collect();
        object_of(&[
            ("writes", &JsValue::from(writes)),
            ("dropped", &to_js(&dropped)?),
        ])
    }

    /// A 0.x blob by its path, its size and `hasherFinish` over its bytes, which stay with
    /// the caller: a blob up to the media cap copied into the wasm grows its memory for the
    /// rest of the run. `{writes: [{kind: "file", meta}], dropped: []}`, the caller PUTting
    /// its own bytes at `meta.url`, or `{skip}` as `migrate` gives for the same bytes.
    #[wasm_bindgen(js_name = migrateBlob)]
    pub fn migrate_blob(
        migration: &Migration,
        v0_path: &str,
        size: f64,
        hash: &str,
    ) -> Result<JsValue, JsError> {
        // A JS number: a fraction or a negative is no size; one past u64 saturates, over the cap
        if !(size >= 0.0 && size.fract() == 0.0) {
            return Err(fail(
                "Validation Error: a blob size is a non-negative integer",
            ));
        }
        let path = match migration.ctx.blob_destination(v0_path, size as u64, hash) {
            Ok(path) => path,
            Err(skipped) => return skipped_js(&skipped),
        };
        let write = write_js(migration.ctx.owner(), &path, None)?;
        object_of(&[
            ("writes", &js_sys::Array::of1(&write).into()),
            ("dropped", &js_sys::Array::new().into()),
        ])
    }

    /// A write as `readObject` reads it back, with where it goes, so after the PUT the
    /// engine holds what a later GET would give. Media is wrapped as it is: its bytes passed
    /// the same gate in the transform, and hashing them again would double the cost of a blob.
    /// Without bytes the write is only where they go, for media the caller holds.
    fn write_js(owner: &PubkyId, path: &str, bytes: Option<Vec<u8>>) -> Result<JsValue, JsError> {
        let url = [PROTOCOL, owner.as_ref(), "/", path].concat();
        let parsed = ParsedUri::try_from(url.as_str())
            .map_err(|_| fail("Validation Error: unreachable, the transform read this path"))?;
        let id = parsed.resource.id().unwrap_or_default();
        let meta = to_js(&Meta::new(owner, &id, format!("/{path}")))?;
        let Some(bytes) = bytes else {
            let kind = JsValue::from_str(ObjectKind::File.wire_name());
            return object_of(&[("kind", &kind), ("meta", &meta)]);
        };
        let object = match parsed.resource {
            Resource::File(_) => PubkySocialObject::File(PubkySocialFile(bytes)),
            _ => PubkySocialObject::from_uri_owned(&url, bytes).map_err(|_| {
                fail("Validation Error: unreachable, the transform read this object back")
            })?,
        };
        object_of(&[
            ("kind", &JsValue::from_str(object.kind().wire_name())),
            ("object", &object_js(&object)?),
            ("meta", &meta),
        ])
    }
}
