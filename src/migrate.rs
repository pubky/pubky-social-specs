//! The v0 to v1 transforms: one owner's `pub/pubky.app/` objects in, the `social/v1` objects
//! to write out.
//!
//! Every transform works from the object the frozen 0.x reader returns for the path, at the
//! path's own id: [`legacy_v0::V0Object::from_resource`], the read an indexer takes,
//! typed and sanitized as the reader stored it. An object is skipped when the frozen 0.x
//! reader refuses it: `malformed` when the JSON parser cannot read the bytes at all, `shape`
//! when the reader cannot read them into its model, `invalid` when it reads them and its rules
//! refuse the object. The reader bounds a TimestampId by the clock, at most two hours ahead,
//! so an object refused for a future id on one run is accepted on a later run; apart from
//! that clock the transforms are pure functions over bytes.
//!
//! What the reader stored is what migrates: names and text come trimmed, a content type
//! trimmed, a URL as the reader re-serialized it, and a profile named `[DELETED]` as the
//! `anonymous` the reader made of it. A JSON array the reader takes for its model migrates like
//! any object it accepts. An integer must also lie within ±(2^53-1), which v1 requires and the
//! reader did not. The output is built with the v1 builders, which trim and fold, and every
//! output is read back through [`PubkySocialObject::from_uri`] before it is returned. Between
//! the two reads an object either migrates whole or is skipped with a [`Skip`] category.
//!
//! What the run learned from listing the v0 tree lives in a [`MigrationCtx`]: the owner, and
//! from every v0 File object the name and blob it names and the blob's extension. Feed it all
//! the File objects first; posts, profiles, tags and blobs read it.
//!
//! References are rewritten one way everywhere. A `pubky://<pk>/pub/pubky.app/...` URI that
//! the frozen v0 parser classifies as a profile, post or follow takes its v1 spelling
//! (`profile.json`, the versionless post, `follows/{pk}.json`) with the host unchanged, other
//! users' included. The owner's v0 `files/{tsid}` and `blobs/{hash}` references instead
//! resolve to the migrated `files/{hash}.{ext}`, the former through the File object, and stay
//! as they were when the run cannot resolve them, since the legacy URI keeps resolving. A tag,
//! feed, mute or bookmark reference stays as written too: a tag's v1 id is derived from its
//! rewritten target, which the reference does not carry, and the others migrate under the
//! private root, so no public v1 spelling of them resolves. A path the v0 parser calls
//! unknown, and `http` and `https` targets, are not rewritten. Every value then takes its
//! canonical spelling, which is what the v1 reader requires and what ids are derived from.
//!
//! Members of a v0 object the reader's model does not have are discarded and not reported: the
//! reader's structs have no catch-all, so a run cannot count them.

use crate::canonicalize::{
    canonicalize_external_uri, canonicalize_pubky_uri, canonicalize_web_uri, checked,
    AllowedSchemes,
};
use crate::common::{frozen_trim, is_frozen_whitespace, trimmed_or_none, validate_safe_json_int};
use crate::constants::PROTOCOL;
use crate::limits::VALIDATION_LIMITS;
use crate::mime::{essence, mime_to_ext};
use crate::models::legacy_v0;
use crate::traits::{HasIdPath, HasPath, HashId, Root, Validatable, PUB_CTX};
use crate::{
    bookmark_filename, follow_uri_builder, post_uri_builder, resolve_deref, sanitize_tag_label,
    user_uri_builder, ParsedUri, PubkyId, PubkySocialAttachment, PubkySocialBookmark,
    PubkySocialCollectionItem, PubkySocialCollectionLayout, PubkySocialFeed, PubkySocialFeedConfig,
    PubkySocialFile, PubkySocialFollow, PubkySocialMute, PubkySocialObject, PubkySocialPost,
    PubkySocialPostKind, PubkySocialTag, PubkySocialUser, PubkySocialUserLink,
};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

/// The revision of these transforms, recorded by a finished run. Bump it when a transform
/// changes what it writes: a tree recorded under a lower revision is walked again, which picks
/// up the objects an earlier revision skipped. A walk never rewrites a destination that exists.
/// Revision 2: the transforms read through the frozen 0.x reader, which writes a `[DELETED]`
/// profile as `anonymous` and a few objects revision 1 skipped or spelled otherwise.
pub const TRANSFORM_REV: u32 = 2;

/// Why an object did not migrate. Categories, not messages, so a run can count them.
#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Skip {
    /// The JSON parser cannot read the bytes: a syntax error, invalid UTF-8, a lone surrogate.
    Malformed,
    /// The bytes are JSON the 0.x reader cannot read into its model: a member missing, of the
    /// wrong type, or given twice.
    Shape,
    /// An integer the 0.x reader read lies outside ±(2^53-1), which v1 requires.
    UnsafeInteger,
    /// An article with no title anywhere in its text and nothing a note could carry either:
    /// no text, embed or attachment.
    EmptyTitle,
    /// A feed filtering on a content kind v1 does not know. Its id cannot be derived, and
    /// dropping the filter would write a different feed.
    UnknownFeedContent,
    /// The output is over the v1 size cap of its type.
    Oversize,
    /// The 0.x reader reads the object and its rules refuse it, or the output fails the v1
    /// reader. An object is skipped when the frozen 0.x reader refuses it.
    Invalid,
    /// The path is not a v0 object with a v1 counterpart, or it is another owner's. A path the
    /// v0 parser refuses carries the parser's message as the note.
    NotMigrated,
}

impl Skip {
    /// Every category, in declaration order, for a report that counts them.
    pub const ALL: &[Skip] = &[
        Skip::Malformed,
        Skip::Shape,
        Skip::UnsafeInteger,
        Skip::EmptyTitle,
        Skip::UnknownFeedContent,
        Skip::Oversize,
        Skip::Invalid,
        Skip::NotMigrated,
    ];

    /// The snake_case category name.
    pub fn as_str(&self) -> &'static str {
        match self {
            Skip::Malformed => "malformed",
            Skip::Shape => "shape",
            Skip::UnsafeInteger => "unsafe_integer",
            Skip::EmptyTitle => "empty_title",
            Skip::UnknownFeedContent => "unknown_feed_content",
            Skip::Oversize => "oversize",
            Skip::Invalid => "invalid",
            Skip::NotMigrated => "not_migrated",
        }
    }
}

impl fmt::Display for Skip {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A category is also an error, so a run can carry it through `?` and report it.
impl std::error::Error for Skip {}

/// A skip with what the refusing parser or reader said: the frozen 0.x reader's message when
/// it refused the object, the v0 path parser's when it refused the path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skipped {
    pub skip: Skip,
    pub note: Option<String>,
}

impl Skipped {
    fn noted(skip: Skip, note: impl ToString) -> Self {
        Self {
            skip,
            note: Some(note.to_string()),
        }
    }
}

impl From<Skip> for Skipped {
    fn from(skip: Skip) -> Self {
        Self { skip, note: None }
    }
}

impl fmt::Display for Skipped {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.note {
            Some(note) => write!(f, "{}: {note}", self.skip),
            None => write!(f, "{}", self.skip),
        }
    }
}

impl std::error::Error for Skipped {}

/// A value the v1 rules refuse, dropped so the object around it still migrates.
#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Dropped {
    /// The profile image failed the image gate: a scheme other than pubky or web, a
    /// non-canonical spelling, or over the cap.
    ProfileImage,
    /// The profile link at this index of the v0 list failed the web gate.
    ProfileLink { index: usize },
}

impl fmt::Display for Dropped {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Dropped::ProfileImage => f.write_str("profile_image"),
            Dropped::ProfileLink { index } => write!(f, "profile_link[{index}]"),
        }
    }
}

/// What one v0 object becomes: the owner-relative paths and bytes to write, and what was
/// dropped on the way.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Migrated {
    pub writes: Vec<(String, Vec<u8>)>,
    pub dropped: Vec<Dropped>,
}

impl Migrated {
    fn one(write: (String, Vec<u8>)) -> Self {
        Self {
            writes: vec![write],
            dropped: vec![],
        }
    }
}

/// A v0 File object as the run keeps it.
#[derive(Debug, Clone)]
struct RunFile {
    name: String,
    /// The blob it names, only when that blob is the owner's own: another tree's blob
    /// migrates under that tree's extension table, which this run cannot see.
    hash: Option<String>,
    /// The extension and image flag its content type gives that blob.
    ext: String,
    image: bool,
}

/// What one run knows about the owner's v0 tree.
#[derive(Debug, Clone)]
pub struct MigrationCtx {
    owner: PubkyId,
    files: BTreeMap<String, RunFile>,
    /// blob hash -> ids of the Files naming it
    namers: BTreeMap<String, BTreeSet<String>>,
}

impl MigrationCtx {
    pub fn new(owner: PubkyId) -> Self {
        Self {
            owner,
            files: BTreeMap::new(),
            namers: BTreeMap::new(),
        }
    }

    pub fn owner(&self) -> &PubkyId {
        &self.owner
    }

    /// Reads the v0 File object stored at `files/{tsid}`. It has no v1 counterpart: its name
    /// moves into the attachments that reference it, its blob becomes the reference target,
    /// and its content type picks the blob's extension. A File the 0.x reader refuses names
    /// nothing, so its references stay as written and a blob only it named is an orphan.
    pub fn read_v0_file(&mut self, tsid: &str, v0_bytes: &[u8]) -> Result<(), Skipped> {
        // A File read again replaces its earlier reading, a refused one included
        if let Some(old) = self.files.remove(tsid).and_then(|f| f.hash) {
            if let Some(ids) = self.namers.get_mut(&old) {
                ids.remove(tsid);
                if ids.is_empty() {
                    self.namers.remove(&old);
                }
            }
        }
        let file: legacy_v0::V0File = read_v0(v0_bytes, tsid)?;
        let own = legacy_v0::ParsedUri::try_from(file.src.as_str())
            .is_ok_and(|p| p.user_id == self.owner);
        let hash = own
            .then(|| resolve_deref(tsid, &file.src))
            .flatten()
            .and_then(|key| key.strip_prefix("files/").map(str::to_string));
        if let Some(hash) = &hash {
            self.namers
                .entry(hash.clone())
                .or_default()
                .insert(tsid.to_string());
        }
        let content_type = &file.content_type;
        let file = RunFile {
            hash,
            ext: mime_to_ext(content_type),
            image: essence(content_type).is_some_and(|e| e.starts_with("image/")),
            name: file.name,
        };
        self.files.insert(tsid.to_string(), file);
        Ok(())
    }

    /// One v0 object by its owner-relative path, for a run that walks the tree: a File
    /// object is read into the run and writes nothing, anything else goes through
    /// [`transform`]. Walk `files/` first, so the objects that reference them find them.
    pub fn migrate(&mut self, v0_path: &str, v0_bytes: &[u8]) -> Result<Migrated, Skipped> {
        match classify(&self.owner, v0_path)? {
            legacy_v0::Resource::File(tsid) => self
                .read_v0_file(&tsid, v0_bytes)
                .map(|()| Migrated::default()),
            resource => transform_resource(resource, v0_bytes, self),
        }
    }

    /// The File that names a blob's extension: the one with the bytewise-lowest id, so the
    /// answer does not depend on the order the run met the Files in.
    fn namer(&self, hash: &str) -> Option<&RunFile> {
        let tsid = self.namers.get(hash)?.first()?;
        self.files.get(tsid)
    }

    /// The extension a blob migrates under; `bin` for a blob no File names.
    fn ext_of(&self, hash: &str) -> &str {
        self.namer(hash).map_or("bin", |file| file.ext.as_str())
    }

    /// Where the v0 blob at `v0_path` migrates, from its size and the crate's id spelling of
    /// its bytes' hash, so a caller holding a large blob never hands the bytes over: the same
    /// rules [`transform_blob`] applies, and the owner-relative path its write would take. A
    /// path the v0 parser does not call the owner's blob skips as `NotMigrated`.
    pub fn blob_destination(
        &self,
        v0_path: &str,
        size: u64,
        hash: &str,
    ) -> Result<String, Skipped> {
        let legacy_v0::Resource::Blob(v0_hash) = classify(&self.owner, v0_path)? else {
            return Err(Skip::NotMigrated.into());
        };
        let path = self.blob_path(&v0_hash, size)?;
        // The media read-back without the bytes: they are not empty and hash to the id the
        // reader takes from the path
        let uri = [PROTOCOL, self.owner.as_ref(), &path].concat();
        let named = ParsedUri::try_from(uri.as_str())
            .ok()
            .and_then(|parsed| parsed.resource.id());
        if size == 0 || named.as_deref() != Some(hash) {
            return Err(Skipped::noted(
                Skip::Invalid,
                "blob bytes do not hash to the id in the path",
            ));
        }
        Ok(path.trim_start_matches('/').to_string())
    }

    /// A blob's destination by its v0 id: over the cap it skips before anything else, and the
    /// extension is the namer's.
    fn blob_path(&self, v0_hash: &str, size: u64) -> Result<String, Skip> {
        if size > VALIDATION_LIMITS.max_file_size_bytes as u64 {
            return Err(Skip::Oversize);
        }
        Ok(PubkySocialFile::create_path(&format!(
            "{v0_hash}.{}",
            self.ext_of(v0_hash)
        )))
    }

    /// Rewrites one reference, with the name of the v0 File it went through, if any. The
    /// input is trimmed first: v0's own writer trimmed, and a migrator owes canonical spelling.
    fn rewrite(&self, uri: &str) -> Rewritten {
        use legacy_v0::Resource;
        let folded = fold_scheme(frozen_trim(uri));
        let uri = folded.as_str();
        if !uri.starts_with("pubky") {
            let canonical = if uri.starts_with("http://") || uri.starts_with("https://") {
                canonicalize_web_uri(uri)
            } else {
                canonicalize_external_uri(uri)
            };
            return Rewritten::plain(canonical.unwrap_or_else(|_| uri.to_string()));
        }
        // A spelling nothing can canonicalize stays as written, for the reader to refuse
        let Ok(canonical) = canonicalize_pubky_uri(uri) else {
            return Rewritten::plain(uri.to_string());
        };
        let rest = &canonical[PROTOCOL.len()..];
        let Some((host, path)) = rest.split_once('/') else {
            return Rewritten::plain(canonical);
        };
        if !path.starts_with(LEGACY_PREFIX) {
            return Rewritten::plain(canonical);
        }
        let Ok(parsed) = legacy_v0::ParsedUri::try_from(canonical.as_str()) else {
            return Rewritten::plain(canonical);
        };
        let own = host == self.owner.as_ref();
        match parsed.resource {
            // Another tree's media migrates under that tree's extension table, which this
            // run cannot see, so only the owner's references resolve
            Resource::File(tsid) => {
                let file = own.then(|| self.files.get(&tsid)).flatten();
                match file.and_then(|f| f.hash.as_ref().map(|h| (f, h))) {
                    Some((file, hash)) => self.media(hash, Some(file.name.clone())),
                    None => Rewritten::plain(canonical),
                }
            }
            Resource::Blob(hash) if own => self.media(&hash, None),
            // A tag's v1 id is derived from its rewritten target, which the old id does not
            // carry. Feeds, mutes and bookmarks migrate under the private root, a feed under
            // a re-derived id. No v1 spelling of these resolves; the legacy one does
            Resource::Blob(_)
            | Resource::Tag(_)
            | Resource::Feed(_)
            | Resource::Mute(_)
            | Resource::Bookmark(_)
            | Resource::LastRead
            | Resource::Unknown => Rewritten::plain(canonical),
            Resource::User => Rewritten::plain(user_uri_builder(host.to_string())),
            Resource::Post(id) => Rewritten::plain(post_uri_builder(host.to_string(), id)),
            Resource::Follow(pk) => {
                Rewritten::plain(follow_uri_builder(host.to_string(), pk.to_string()))
            }
        }
    }

    fn media(&self, hash: &str, name: Option<String>) -> Rewritten {
        let path = PubkySocialFile::create_path(&format!("{hash}.{}", self.ext_of(hash)));
        Rewritten {
            uri: [PROTOCOL, self.owner.as_ref(), &path].concat(),
            name,
            image: self.namer(hash).is_some_and(|file| file.image),
        }
    }

    /// Serializes, checks the size cap, and reads the result back through the v1 reader.
    fn emit<T: Validatable>(&self, path: &str, object: &T) -> Result<(String, Vec<u8>), Skipped> {
        let bytes = serde_json::to_vec(object).map_err(|e| Skipped::noted(Skip::Invalid, e))?;
        if bytes.len() > T::MAX_BYTES {
            return Err(Skip::Oversize.into());
        }
        self.read_back(path, bytes)
    }

    /// The v1 reader's refusal is the note, so a run can say why the output was refused.
    fn read_back(&self, path: &str, bytes: Vec<u8>) -> Result<(String, Vec<u8>), Skipped> {
        let uri = [PROTOCOL, self.owner.as_ref(), path].concat();
        PubkySocialObject::from_uri(&uri, &bytes).map_err(|e| Skipped::noted(Skip::Invalid, e))?;
        Ok((path.trim_start_matches('/').to_string(), bytes))
    }
}

/// The legacy namespace under the public root, where every v0 object lived.
const LEGACY_PREFIX: &str = "pub/pubky.app/";

struct Rewritten {
    uri: String,
    name: Option<String>,
    /// Resolved to the owner's media, and that media is an image type.
    image: bool,
}

impl Rewritten {
    fn plain(uri: String) -> Self {
        Self {
            uri,
            name: None,
            image: false,
        }
    }
}

// ---- reading v0 bytes ----

/// The object the frozen 0.x reader stores for bytes at an id: its own `try_from`, the call
/// [`legacy_v0::V0Object::from_resource`] makes for the path. The reader reports a
/// refusal as a message only, so its first step is retaken on refusal to tell the JSON
/// parser's, the model's and the rules' refusals apart.
fn read_v0<T: legacy_v0::V0Validatable>(bytes: &[u8], id: &str) -> Result<T, Skipped> {
    <T as legacy_v0::V0Validatable>::try_from(bytes, id).map_err(|message| {
        let skip = match serde_json::from_slice::<T>(bytes) {
            Ok(_) => Skip::Invalid,
            Err(e) if e.is_data() => Skip::Shape,
            Err(_) => Skip::Malformed,
        };
        Skipped::noted(skip, message)
    })
}

fn safe_int(value: i64) -> Result<i64, Skip> {
    validate_safe_json_int(value)
        .map(|()| value)
        .map_err(|_| Skip::UnsafeInteger)
}

/// A v0 enum as its v1 counterpart, which spells the same wire names.
fn same_wire<T: DeserializeOwned>(value: &impl Serialize) -> Result<T, Skip> {
    serde_json::to_value(value)
        .and_then(serde_json::from_value)
        .map_err(|_| Skip::Shape)
}

/// v0 spelled two kinds differently; every other kind keeps its name.
fn v1_kind(kind: &legacy_v0::V0PostKind) -> PubkySocialPostKind {
    use legacy_v0::V0PostKind as V0;
    match kind {
        V0::Short => PubkySocialPostKind::Note,
        V0::Long => PubkySocialPostKind::Article,
        V0::Image => PubkySocialPostKind::Image,
        V0::Video => PubkySocialPostKind::Video,
        V0::Link => PubkySocialPostKind::Link,
        V0::File => PubkySocialPostKind::File,
        V0::Collection => PubkySocialPostKind::Collection,
        // The v0 reader kept no spelling for a kind it did not know
        V0::Unknown => PubkySocialPostKind::Unknown("unknown".to_string()),
    }
}

// ---- the transforms ----

/// The v0 profile as the reader stored it: text trimmed, and a `[DELETED]` name read as
/// `anonymous`, so the v0 deletion marker never reaches v1. Display text takes the builder
/// trim. An image or a link url the v1 gate refuses is dropped and reported, and the profile
/// still migrates.
fn transform_user(user: legacy_v0::V0User, ctx: &MigrationCtx) -> Result<Migrated, Skipped> {
    let mut dropped = vec![];
    let image = user.image.and_then(|raw| {
        let uri = ctx.rewrite(&raw).uri;
        let max = VALIDATION_LIMITS.image_url_max_length;
        match checked(
            "image",
            &uri,
            AllowedSchemes::PubkyHttpHttps,
            max,
            &PUB_CTX,
            None,
        ) {
            Ok(()) => Some(uri),
            Err(_) => {
                dropped.push(Dropped::ProfileImage);
                None
            }
        }
    });
    let links = user.links.map(|items| {
        let mut links = vec![];
        for (index, link) in items.into_iter().enumerate() {
            let url = ctx.rewrite(&link.url).uri;
            let max = VALIDATION_LIMITS.user_link_url_max_length;
            match checked("url", &url, AllowedSchemes::HttpHttps, max, &PUB_CTX, None) {
                Ok(()) => links.push(PubkySocialUserLink::new(link.title, url)),
                Err(_) => dropped.push(Dropped::ProfileLink { index }),
            }
        }
        links
    });
    let user = PubkySocialUser::new(user.name, user.bio, image, links, user.status);
    let write = ctx.emit(&PubkySocialUser::create_path(), &user)?;
    Ok(Migrated {
        writes: vec![write],
        dropped,
    })
}

/// The v0 post `posts/{id}`, written as its first version `posts/{id}/{id}.json`.
fn transform_post(
    id: &str,
    post: legacy_v0::V0Post,
    ctx: &MigrationCtx,
) -> Result<Migrated, Skipped> {
    let rewrite = |uri: &str| ctx.rewrite(uri).uri;
    let parent = post.parent.as_deref().map(rewrite);
    // The embed kind is derivable from its target, so only the uri moves
    let embed = post.embed.as_ref().map(|embed| rewrite(&embed.uri));
    let lock = post.lock.as_deref().map(rewrite);
    let references: Vec<Rewritten> = post
        .attachments
        .iter()
        .flatten()
        .map(|uri| ctx.rewrite(uri))
        .collect();

    let post = match v1_kind(&post.kind) {
        PubkySocialPostKind::Article => match article_text(&post.content) {
            (Some(title), body, cover) => {
                let mut references = references;
                // An envelope cover wins. Otherwise the first attachment was the cover by
                // convention, but only an image can be one: it moves into the envelope
                // without its file name, and anything else stays an attachment
                let cover = match cover {
                    Some(uri) => Some(rewrite(&uri)),
                    None if references.first().is_some_and(|r| r.image) => {
                        Some(references.remove(0).uri)
                    }
                    None => None,
                };
                PubkySocialPost::new_article(
                    title,
                    body,
                    cover,
                    parent,
                    embed,
                    references.into_iter().map(attachment).collect(),
                    lock,
                )
            }
            // v0 accepted a long post with no title, so its body lives on as a note while
            // there is anything for one to carry
            (None, body, _) => {
                let note = PubkySocialPost::new_with_lock(
                    body,
                    PubkySocialPostKind::Note,
                    parent,
                    embed,
                    references.into_iter().map(attachment).collect(),
                    lock,
                );
                if frozen_trim(&note.content).is_empty()
                    && note.embed.is_none()
                    && note.attachments.is_empty()
                {
                    return Err(Skip::EmptyTitle.into());
                }
                note
            }
        },
        // The reader refuses a collection with a parent, embed or attachments
        PubkySocialPostKind::Collection => {
            let mut collection = collection(&post.content, ctx)?;
            collection.lock = lock;
            collection
        }
        kind => PubkySocialPost::new_with_lock(
            post.content,
            kind,
            parent,
            embed,
            references.into_iter().map(attachment).collect(),
            lock,
        ),
    };
    let path = PubkySocialPost::create_path_in(Root::Pub, id, id, None);
    Ok(Migrated::one(ctx.emit(&path, &post)?))
}

/// An attachment keeps the v0 File name it was dereferenced through; a blank one is absent.
fn attachment(reference: Rewritten) -> PubkySocialAttachment {
    let name = reference.name.and_then(trimmed_or_none);
    PubkySocialAttachment::new(reference.uri, None, name)
}

/// A v0 long post's title, body and cover, the title through [`article_title`]. The JSON
/// envelope's when the content is one, else the whole content is the body. When the envelope
/// has no title, the title is the first line with text in the body; `None` when no title is
/// left.
fn article_text(content: &str) -> (Option<String>, String, Option<String>) {
    let parsed = serde_json::from_str::<Value>(content).ok();
    let envelope = parsed.as_ref().and_then(|envelope| {
        let text = |key: &str| envelope.get(key).and_then(Value::as_str);
        Some((text("title")?, text("body")?, text("cover_image")))
    });
    let (body, cover) = match envelope {
        Some((title, body, cover)) => match article_title(title) {
            Some(title) => return (Some(title), body.to_string(), cover.map(str::to_string)),
            None => (body, cover),
        },
        None => (content, None),
    };
    let title = body
        .split('\n')
        .find(|line| !frozen_trim(line).is_empty())
        .and_then(article_title);
    (title, body.to_string(), cover.map(str::to_string))
}

/// Trim, truncate to the title cap in code points, trim the end again; `None` when nothing
/// is left.
fn article_title(raw: &str) -> Option<String> {
    let truncated: String = frozen_trim(raw)
        .chars()
        .take(VALIDATION_LIMITS.article_title_max_length)
        .collect();
    let title = truncated.trim_end_matches(is_frozen_whitespace);
    (!title.is_empty()).then(|| title.to_string())
}

/// A v0 collection envelope, in the reader's own model, which it already read it through:
/// items become item objects, a blank description becomes absent through the builder, the
/// rest copies.
fn collection(content: &str, ctx: &MigrationCtx) -> Result<PubkySocialPost, Skip> {
    let envelope: legacy_v0::V0CollectionContent =
        serde_json::from_str(content).map_err(|_| Skip::Shape)?;
    let items = envelope
        .items
        .iter()
        .map(|uri| PubkySocialCollectionItem::new(ctx.rewrite(uri).uri, None))
        .collect();
    let cover = envelope.cover_image.map(|uri| ctx.rewrite(&uri).uri);
    let layout: Option<PubkySocialCollectionLayout> =
        envelope.layout.as_ref().map(same_wire).transpose()?;
    Ok(PubkySocialPost::new_collection(
        envelope.name,
        envelope.description,
        items,
        cover,
        layout,
    ))
}

/// A v0 tag. The target is rewritten, the label folded, and the id re-derived from both.
fn transform_tag(tag: legacy_v0::V0Tag, ctx: &MigrationCtx) -> Result<Migrated, Skipped> {
    let tag = PubkySocialTag {
        uri: ctx.rewrite(&tag.uri).uri,
        label: sanitize_tag_label(&tag.label),
        created_at: safe_int(tag.created_at)?,
        extra: Default::default(),
    };
    let path = PubkySocialTag::create_path(&tag.create_id());
    Ok(Migrated::one(ctx.emit(&path, &tag)?))
}

/// A v0 follow of `followee`.
fn transform_follow(
    followee: &str,
    follow: legacy_v0::V0Follow,
    ctx: &MigrationCtx,
) -> Result<Migrated, Skipped> {
    let follow = PubkySocialFollow {
        created_at: safe_int(follow.created_at)?,
        extra: Default::default(),
    };
    let path = PubkySocialFollow::create_path(followee);
    Ok(Migrated::one(ctx.emit(&path, &follow)?))
}

/// A v0 mute of `mutee`, now under the private root.
fn transform_mute(
    mutee: &str,
    mute: legacy_v0::V0Mute,
    ctx: &MigrationCtx,
) -> Result<Migrated, Skipped> {
    let mute = PubkySocialMute {
        created_at: safe_int(mute.created_at)?,
        extra: Default::default(),
    };
    let path = PubkySocialMute::create_path(mutee);
    Ok(Migrated::one(ctx.emit(&path, &mute)?))
}

/// A v0 bookmark, now under the private root with the rewritten target in its filename. A
/// target too long for the filename takes the overflow form and rides in the content.
fn transform_bookmark(
    bookmark: legacy_v0::V0Bookmark,
    ctx: &MigrationCtx,
) -> Result<Migrated, Skipped> {
    let target = ctx.rewrite(&bookmark.uri).uri;
    let created_at = safe_int(bookmark.created_at)?;
    let filename = bookmark_filename(&target).map_err(|e| Skipped::noted(Skip::Invalid, e))?;
    let bookmark = PubkySocialBookmark {
        created_at,
        target: filename.starts_with('~').then_some(target),
        extra: Default::default(),
    };
    let path = PubkySocialBookmark::create_path(&filename);
    Ok(Migrated::one(ctx.emit(&path, &bookmark)?))
}

/// A v0 feed, now private, under an id re-derived from its config. Name and icon copy with
/// the builder trim and fold. The reader already dropped a blank tag label; a list left empty
/// becomes no filter, which is the one spelling the v1 builder accepts for it (v0 kept the
/// empty list). The two renamed post kinds are renamed here too.
fn transform_feed(feed: legacy_v0::V0Feed, ctx: &MigrationCtx) -> Result<Migrated, Skipped> {
    let filter = |labels: Option<Vec<String>>| labels.filter(|labels| !labels.is_empty());
    let config = feed.feed;
    let content = match config.content.as_ref().map(v1_kind) {
        Some(PubkySocialPostKind::Unknown(_)) => return Err(Skip::UnknownFeedContent.into()),
        content => content,
    };
    let config = PubkySocialFeedConfig::new(
        filter(config.tags),
        filter(config.domain_tags),
        same_wire(&config.reach)?,
        same_wire(&config.layout)?,
        same_wire(&config.sort)?,
        content,
    )
    .map_err(|e| Skipped::noted(Skip::Invalid, e))?;
    let feed = PubkySocialFeed {
        feed: config,
        name: frozen_trim(&feed.name).to_string(),
        icon: feed.icon.map(|icon| crate::ascii_fold(frozen_trim(&icon))),
        created_at: safe_int(feed.created_at)?,
        extra: Default::default(),
    };
    let id = feed
        .derive_id()
        .map_err(|e| Skipped::noted(Skip::Invalid, e))?;
    let path = PubkySocialFeed::create_path_in(Root::Priv, &id);
    Ok(Migrated::one(ctx.emit(&path, &feed)?))
}

/// A v0 blob `blobs/{hash}`: the same bytes at `files/{hash}.{ext}`, the extension from the
/// run's table. The size is checked before the reader, which would hash all of it. A blob is
/// bytes, not JSON, so whatever the reader refuses in it is `invalid`.
pub fn transform_blob(hash: &str, bytes: &[u8], ctx: &MigrationCtx) -> Result<Migrated, Skipped> {
    let path = ctx.blob_path(hash, bytes.len() as u64)?;
    <legacy_v0::V0Blob as legacy_v0::V0Validatable>::try_from(bytes, hash)
        .map_err(|message| Skipped::noted(Skip::Invalid, message))?;
    Ok(Migrated::one(ctx.read_back(&path, bytes.to_vec())?))
}

/// A scheme is case-insensitive, and the 0.x reader kept a bookmark target or a cover image as
/// written, so the fold the external arm applies to its scheme happens before dispatch for every
/// arm. Anything that is not scheme-shaped before the first colon is left alone.
fn fold_scheme(uri: &str) -> String {
    let Some(colon) = uri.find(':') else {
        return uri.to_string();
    };
    let (scheme, rest) = uri.split_at(colon);
    let mut chars = scheme.chars();
    let shaped = chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'));
    if !shaped {
        return uri.to_string();
    }
    [&scheme.to_ascii_lowercase(), rest].concat()
}

/// Any v0 object by its owner-relative path (`pub/pubky.app/...`), classified by the v0
/// parser. A v0 File has no v1 counterpart and writes nothing; read it into the context with
/// [`MigrationCtx::read_v0_file`] before anything that references it, or walk the tree with
/// [`MigrationCtx::migrate`], which does both.
pub fn transform(v0_path: &str, v0_bytes: &[u8], ctx: &MigrationCtx) -> Result<Migrated, Skipped> {
    transform_resource(classify(&ctx.owner, v0_path)?, v0_bytes, ctx)
}

/// What the v0 parser calls a path of the owner's tree, given as the owner-relative path or
/// the full `pubky://` URL a LIST returns. A path it refuses or does not know has no v1
/// counterpart, the refusal noted, and another owner's tree is not this run's to migrate.
fn classify(owner: &PubkyId, v0_path: &str) -> Result<legacy_v0::Resource, Skipped> {
    let uri = if v0_path.starts_with(PROTOCOL) {
        v0_path.to_string()
    } else {
        [
            PROTOCOL,
            owner.as_ref(),
            "/",
            v0_path.trim_start_matches('/'),
        ]
        .concat()
    };
    let parsed = legacy_v0::ParsedUri::try_from(uri.as_str())
        .map_err(|message| Skipped::noted(Skip::NotMigrated, message))?;
    if parsed.user_id != *owner {
        return Err(Skip::NotMigrated.into());
    }
    Ok(parsed.resource)
}

/// Reads the object through the frozen 0.x reader at the path's id, as
/// [`legacy_v0::V0Object::from_resource`] does, and transforms what it stored.
fn transform_resource(
    resource: legacy_v0::Resource,
    v0_bytes: &[u8],
    ctx: &MigrationCtx,
) -> Result<Migrated, Skipped> {
    use legacy_v0::Resource;
    match resource {
        Resource::User => transform_user(read_v0(v0_bytes, "")?, ctx),
        Resource::Post(id) => transform_post(&id, read_v0(v0_bytes, &id)?, ctx),
        Resource::Follow(pk) => transform_follow(pk.as_ref(), read_v0(v0_bytes, pk.as_ref())?, ctx),
        Resource::Mute(pk) => transform_mute(pk.as_ref(), read_v0(v0_bytes, pk.as_ref())?, ctx),
        Resource::Bookmark(id) => transform_bookmark(read_v0(v0_bytes, &id)?, ctx),
        Resource::Tag(id) => transform_tag(read_v0(v0_bytes, &id)?, ctx),
        Resource::Feed(id) => transform_feed(read_v0(v0_bytes, &id)?, ctx),
        Resource::Blob(hash) => transform_blob(&hash, v0_bytes, ctx),
        Resource::File(tsid) => {
            read_v0::<legacy_v0::V0File>(v0_bytes, &tsid)?;
            Ok(Migrated::default())
        }
        Resource::LastRead | Resource::Unknown => Err(Skip::NotMigrated.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWNER: &str = "operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo";
    const TS: &str = "0032SSN7Q4EVG";
    const TS2: &str = "0034A0X7NJ52G";
    const HASH: &str = "AKSZ57W2RFKHV1EHK007FQQ8TW";

    /// The category alone, for a verdict whose note is not the point.
    fn category<T>(got: Result<T, Skipped>) -> Result<T, Skip> {
        got.map_err(|skipped| skipped.skip)
    }

    fn ctx() -> MigrationCtx {
        MigrationCtx::new(PubkyId::try_from(OWNER).unwrap())
    }

    fn file(content_type: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "name": "photo",
            "created_at": 1727740800000000i64,
            "src": format!("pubky://{OWNER}/pub/pubky.app/blobs/{HASH}"),
            "content_type": content_type,
            "size": 20,
        }))
        .unwrap()
    }

    #[test]
    fn all_lists_every_category_once_in_order() {
        // Wildcard-free, so a new category fails to compile here until ALL carries it
        let position = |skip: &Skip| match skip {
            Skip::Malformed => 0,
            Skip::Shape => 1,
            Skip::UnsafeInteger => 2,
            Skip::EmptyTitle => 3,
            Skip::UnknownFeedContent => 4,
            Skip::Oversize => 5,
            Skip::Invalid => 6,
            Skip::NotMigrated => 7,
        };
        assert_eq!(Skip::ALL.len(), 8);
        for (index, skip) in Skip::ALL.iter().enumerate() {
            assert_eq!(position(skip), index, "{skip}");
        }
    }

    #[test]
    fn a_walk_reads_files_into_the_run_and_transforms_the_rest() {
        let mut ctx = ctx();
        let file_path = format!("pub/pubky.app/files/{TS}");
        assert_eq!(
            ctx.migrate(&file_path, &file("image/png")),
            Ok(Migrated::default())
        );
        assert_eq!(
            category(ctx.migrate(&format!("pub/pubky.app/files/{TS2}"), b"{\"name\":1}")),
            Err(Skip::Shape)
        );
        let target = format!("pubky://{OWNER}/pub/pubky.app/files/{TS}");
        let tag = serde_json::json!({
            "uri": target,
            "label": "pic",
            "created_at": 1727740800000000i64,
        });
        let tag_path = format!("pub/pubky.app/tags/{}", legacy_v0::tag_id(&target, "pic"));
        let migrated = ctx.migrate(&tag_path, tag.to_string().as_bytes()).unwrap();
        let (_, bytes) = &migrated.writes[0];
        let written: serde_json::Value = serde_json::from_slice(bytes).unwrap();
        assert_eq!(
            written["uri"],
            format!("pubky://{OWNER}/pub/social/v1/files/{HASH}.png")
        );
        assert_eq!(
            category(ctx.migrate("pub/pubky.app/widgets/x", b"{}")),
            Err(Skip::NotMigrated)
        );
    }

    #[test]
    fn a_full_url_of_the_owner_classifies_like_its_path_and_another_owners_does_not() {
        let ctx = ctx();
        let bytes = br#"{"created_at":1727740800000000}"#;
        let path = format!("pub/pubky.app/follows/{OWNER}");
        let from_path = transform(&path, bytes, &ctx).unwrap();
        let from_url = transform(&format!("pubky://{OWNER}/{path}"), bytes, &ctx).unwrap();
        assert_eq!(from_url, from_path);
        let other = "pxnu33x7jtpx9ar1ytsi4yxbp6a5o36gwhffs8zoxmbuptici1jy";
        assert_eq!(
            category(transform(&format!("pubky://{other}/{path}"), bytes, &ctx)),
            Err(Skip::NotMigrated)
        );
    }

    #[test]
    fn bytes_the_json_parser_cannot_read_are_malformed_with_its_message() {
        let path = format!("pub/pubky.app/tags/{HASH}");
        let tag = |label: &[u8]| {
            [
                br#"{"uri":"https://x.com","label":""#.as_slice(),
                label,
                br#"","created_at":1727740800000000}"#.as_slice(),
            ]
            .concat()
        };
        for bytes in [
            tag(b"\xff"),
            tag(br"\ud800"),
            tag(br"\udc00\ud800"),
            b"".to_vec(),
            b"{".to_vec(),
        ] {
            let skipped = transform(&path, &bytes, &ctx()).unwrap_err();
            assert_eq!(skipped.skip, Skip::Malformed, "{bytes:?}");
            assert!(skipped.note.is_some(), "{bytes:?}");
        }
    }

    #[test]
    fn the_reader_decides_what_it_can_read_and_its_message_is_the_note() {
        let path = format!("pub/pubky.app/follows/{OWNER}");
        // A JSON array the reader takes for its model migrates like any object it accepts
        let migrated = transform(&path, b"[1727740800000000]", &ctx()).unwrap();
        let written: Value = serde_json::from_slice(&migrated.writes[0].1).unwrap();
        assert_eq!(written["created_at"], 1727740800000000i64);
        for (bytes, said) in [
            (br#"{"created_at":"1"}"#.as_slice(), "invalid type"),
            (
                br#"{"created_at":1,"created_at":2}"#.as_slice(),
                "duplicate field",
            ),
            (b"{}".as_slice(), "missing field"),
        ] {
            let skipped = transform(&path, bytes, &ctx()).unwrap_err();
            assert_eq!(skipped.skip, Skip::Shape, "{said}");
            assert!(skipped.note.unwrap().contains(said), "{said}");
        }
        assert_eq!(Skipped::from(Skip::EmptyTitle).to_string(), "empty_title");
    }

    #[test]
    fn an_integer_field_is_a_safe_integer() {
        let path = format!("pub/pubky.app/follows/{OWNER}");
        for (raw, verdict) in [
            ("9007199254740991", Ok(())),
            ("-9007199254740991", Ok(())),
            ("9007199254740992", Err(Skip::UnsafeInteger)),
            ("-9007199254740992", Err(Skip::UnsafeInteger)),
            // What the reader's i64 cannot hold, it cannot read
            ("1.5", Err(Skip::Shape)),
            ("1e3", Err(Skip::Shape)),
            ("\"1\"", Err(Skip::Shape)),
        ] {
            let bytes = format!(r#"{{"created_at":{raw}}}"#);
            let got = category(transform(&path, bytes.as_bytes(), &ctx())).map(|_| ());
            assert_eq!(got, verdict, "{raw}");
        }
    }

    #[test]
    fn a_path_the_parser_refuses_is_not_migrated_with_its_message() {
        let path = "pubky://not-a-key/pub/pubky.app/profile.json";
        let skipped = transform(path, b"{}", &ctx()).unwrap_err();
        assert_eq!(skipped.skip, Skip::NotMigrated);
        assert!(skipped.note.is_some());
        // An unknown path parses, and has nothing to say
        let skipped = transform("pub/pubky.app/widgets/x", b"{}", &ctx()).unwrap_err();
        assert_eq!(skipped, Skip::NotMigrated.into());
    }

    #[test]
    fn the_lowest_file_id_names_the_extension_in_any_order() {
        for order in [[TS, TS2], [TS2, TS]] {
            let mut ctx = ctx();
            for tsid in order {
                let content_type = if tsid == TS {
                    "image/png"
                } else {
                    "image/jpeg"
                };
                ctx.read_v0_file(tsid, &file(content_type)).unwrap();
            }
            assert_eq!(ctx.ext_of(HASH), "png", "{order:?}");
        }
        assert_eq!(ctx().ext_of(HASH), "bin");
    }

    #[test]
    fn a_file_read_twice_takes_its_last_reading_everywhere() {
        let mut ctx = ctx();
        ctx.read_v0_file(TS, &file("image/png")).unwrap();
        let again = serde_json::to_vec(&serde_json::json!({
            "name": "second",
            "created_at": 1727740800000000i64,
            "src": format!("pubky://{OWNER}/pub/pubky.app/blobs/{HASH}"),
            "content_type": "application/pdf",
            "size": 20,
        }))
        .unwrap();
        ctx.read_v0_file(TS, &again).unwrap();
        assert_eq!(ctx.ext_of(HASH), "pdf");
        let rewritten = ctx.rewrite(&format!("pubky://{OWNER}/pub/pubky.app/files/{TS}"));
        assert_eq!(rewritten.name.as_deref(), Some("second"));
        assert!(!rewritten.image);
    }

    #[test]
    fn a_file_reread_to_another_blob_hands_the_old_one_on() {
        let other = "8Z8CWH8NVYQY39ZEBFGKQWWEKG";
        let naming = |hash: &str, content_type: &str| {
            serde_json::to_vec(&serde_json::json!({
                "name": "photo",
                "created_at": 1727740800000000i64,
                "src": format!("pubky://{OWNER}/pub/pubky.app/blobs/{hash}"),
                "content_type": content_type,
                "size": 20,
            }))
            .unwrap()
        };
        let mut shared = ctx();
        shared.read_v0_file(TS, &naming(HASH, "image/png")).unwrap();
        shared
            .read_v0_file(TS2, &naming(HASH, "application/pdf"))
            .unwrap();
        shared
            .read_v0_file(TS, &naming(other, "image/jpeg"))
            .unwrap();
        assert_eq!(shared.ext_of(HASH), "pdf");
        assert_eq!(shared.ext_of(other), "jpg");
        let blob = shared.rewrite(&format!("pubky://{OWNER}/pub/pubky.app/blobs/{HASH}"));
        assert!(!blob.image);

        // With no other File naming it, the old blob is an orphan again
        let mut alone = ctx();
        alone.read_v0_file(TS, &naming(HASH, "image/png")).unwrap();
        alone
            .read_v0_file(TS, &naming(other, "image/jpeg"))
            .unwrap();
        assert_eq!(alone.ext_of(HASH), "bin");
        assert_eq!(alone.ext_of(other), "jpg");
    }

    #[test]
    fn a_file_that_does_not_read_leaves_its_references_as_written() {
        let mut ctx = ctx();
        assert_eq!(
            category(ctx.read_v0_file(TS, b"{\"name\":1}")),
            Err(Skip::Shape)
        );
        let legacy = format!("pubky://{OWNER}/pub/pubky.app/files/{TS}");
        assert_eq!(ctx.rewrite(&legacy).uri, legacy);
        ctx.read_v0_file(TS, &file("image/png")).unwrap();
        assert_eq!(
            ctx.rewrite(&legacy).uri,
            format!("pubky://{OWNER}/pub/social/v1/files/{HASH}.png")
        );
    }

    #[test]
    fn a_refused_reread_forgets_the_earlier_reading() {
        let mut ctx = ctx();
        ctx.read_v0_file(TS, &file("image/png")).unwrap();
        assert!(ctx.read_v0_file(TS, b"{\"name\":1}").is_err());
        let legacy = format!("pubky://{OWNER}/pub/pubky.app/files/{TS}");
        assert_eq!(ctx.rewrite(&legacy).uri, legacy);
        assert_eq!(ctx.ext_of(HASH), "bin");
    }

    #[test]
    fn a_content_type_comes_trimmed_as_the_reader_stored_it() {
        let mut ctx = ctx();
        ctx.read_v0_file(TS, &file(" image/png ")).unwrap();
        assert_eq!(ctx.ext_of(HASH), "png");
    }

    #[test]
    fn only_the_legacy_prefix_is_rewritten() {
        let ctx = ctx();
        for (from, to) in [
            (
                format!("pubky{OWNER}/pub/pubky.app/posts/{TS}"),
                format!("pubky://{OWNER}/pub/social/v1/posts/{TS}"),
            ),
            (
                format!("pubky://{OWNER}/pub/pubky.app/profile.json"),
                format!("pubky://{OWNER}/pub/social/v1/profile.json"),
            ),
            (
                format!("pubky://{OWNER}/pub/pubky.app/follows/{OWNER}"),
                format!("pubky://{OWNER}/pub/social/v1/follows/{OWNER}.json"),
            ),
            (
                format!("pubky://{OWNER}/pub/locks.app/x"),
                format!("pubky://{OWNER}/pub/locks.app/x"),
            ),
            (
                format!("pubky://{OWNER}/pub/pubky.appx/y"),
                format!("pubky://{OWNER}/pub/pubky.appx/y"),
            ),
            (format!("pubky://{OWNER}"), format!("pubky://{OWNER}")),
            // The v1 id of a tag is derived from its rewritten target; the others are
            // private in v1, a feed under a re-derived id. The legacy spelling resolves
            (
                format!("pubky://{OWNER}/pub/pubky.app/tags/{HASH}"),
                format!("pubky://{OWNER}/pub/pubky.app/tags/{HASH}"),
            ),
            (
                format!("pubky://{OWNER}/pub/pubky.app/feeds/{TS}"),
                format!("pubky://{OWNER}/pub/pubky.app/feeds/{TS}"),
            ),
            (
                format!("pubky://{OWNER}/pub/pubky.app/mutes/{OWNER}"),
                format!("pubky://{OWNER}/pub/pubky.app/mutes/{OWNER}"),
            ),
            (
                format!("pubky://{OWNER}/pub/pubky.app/bookmarks/{HASH}"),
                format!("pubky://{OWNER}/pub/pubky.app/bookmarks/{HASH}"),
            ),
            // No v1 counterpart: the frozen parser calls these last_read and unknown
            (
                format!("pubky://{OWNER}/pub/pubky.app/last_read"),
                format!("pubky://{OWNER}/pub/pubky.app/last_read"),
            ),
            (
                format!("pubky://{OWNER}/pub/pubky.app/widgets/{TS}"),
                format!("pubky://{OWNER}/pub/pubky.app/widgets/{TS}"),
            ),
            ("https://x.com \n".into(), "https://x.com".into()),
            (" https://x.com".into(), "https://x.com".into()),
            ("\u{3000}NOSTR:abc ".into(), "nostr:abc".into()),
            ("not a uri".into(), "not a uri".into()),
        ] {
            assert_eq!(ctx.rewrite(&from).uri, to, "{from}");
        }
    }

    #[test]
    fn the_owners_blob_reference_becomes_the_media_spelling() {
        let mut ctx = ctx();
        ctx.read_v0_file(TS, &file("image/png")).unwrap();
        let own = format!("pubky://{OWNER}/pub/pubky.app/blobs/{HASH}");
        let rewritten = ctx.rewrite(&own);
        assert_eq!(
            rewritten.uri,
            format!("pubky://{OWNER}/pub/social/v1/files/{HASH}.png")
        );
        assert!(rewritten.image && rewritten.name.is_none());
        // An orphan blob still resolves, as bin
        let orphan = "8Z8CWH8NVYQY39ZEBFGKQWWEKG";
        assert_eq!(
            ctx.rewrite(&format!("pubky://{OWNER}/pub/pubky.app/blobs/{orphan}"))
                .uri,
            format!("pubky://{OWNER}/pub/social/v1/files/{orphan}.bin")
        );
        let other = "pxnu33x7jtpx9ar1ytsi4yxbp6a5o36gwhffs8zoxmbuptici1jy";
        let theirs = format!("pubky://{other}/pub/pubky.app/blobs/{HASH}");
        assert_eq!(ctx.rewrite(&theirs).uri, theirs);
    }

    #[test]
    fn a_blob_over_the_size_cap_skips_as_oversize() {
        let path = format!("pub/pubky.app/blobs/{HASH}");
        let bytes = vec![0u8; VALIDATION_LIMITS.max_file_size_bytes + 1];
        assert_eq!(transform(&path, &bytes, &ctx()), Err(Skip::Oversize.into()));
        // At the cap the size passes; the reader then refuses the hash, not the size
        let skipped = transform(&path, &bytes[1..], &ctx()).unwrap_err();
        assert_eq!(skipped.skip, Skip::Invalid);
        assert!(skipped.note.unwrap().starts_with("Invalid ID"));
    }

    #[test]
    fn a_blob_destination_follows_the_blob_rules_without_the_bytes() {
        let mut ctx = ctx();
        ctx.read_v0_file(TS, &file("image/png")).unwrap();
        let blob = format!("pub/pubky.app/blobs/{HASH}");
        let max = VALIDATION_LIMITS.max_file_size_bytes as u64;
        assert_eq!(
            ctx.blob_destination(&blob, 20, HASH),
            Ok(format!("pub/social/v1/files/{HASH}.png"))
        );
        let url = format!("pubky://{OWNER}/{blob}");
        assert_eq!(
            ctx.blob_destination(&url, max, HASH),
            Ok(format!("pub/social/v1/files/{HASH}.png"))
        );
        // Over the cap skips before the hash is looked at
        assert_eq!(
            ctx.blob_destination(&blob, max + 1, "other"),
            Err(Skip::Oversize.into())
        );
        assert_eq!(
            ctx.blob_destination(&blob, u64::MAX, HASH),
            Err(Skip::Oversize.into())
        );
        // Bytes that do not hash to the blob's id, or no bytes at all, fail the read-back
        let other = "8Z8CWH8NVYQY39ZEBFGKQWWEKG";
        assert_eq!(
            ctx.blob_destination(&blob, 20, other).map_err(|s| s.skip),
            Err(Skip::Invalid)
        );
        assert_eq!(
            ctx.blob_destination(&blob, 0, HASH).map_err(|s| s.skip),
            Err(Skip::Invalid)
        );
        // An orphan no File names is bin
        assert_eq!(
            ctx.blob_destination(&format!("pub/pubky.app/blobs/{other}"), 20, other),
            Ok(format!("pub/social/v1/files/{other}.bin"))
        );
        let theirs = "pxnu33x7jtpx9ar1ytsi4yxbp6a5o36gwhffs8zoxmbuptici1jy";
        for path in [
            format!("pubky://{theirs}/{blob}"),
            format!("pub/pubky.app/files/{TS}"),
            "pub/pubky.app/blobs/".to_string(),
        ] {
            assert_eq!(
                ctx.blob_destination(&path, 20, HASH),
                Err(Skip::NotMigrated.into()),
                "{path}"
            );
        }
    }

    #[test]
    fn only_an_image_deref_is_promoted_to_the_cover() {
        let mut ctx = ctx();
        ctx.read_v0_file(TS, &file("application/pdf")).unwrap();
        assert!(
            !ctx.rewrite(&format!("pubky://{OWNER}/pub/pubky.app/files/{TS}"))
                .image
        );
        ctx.read_v0_file(TS2, &file("image/jpeg; charset=x"))
            .unwrap();
        // TS is lower and names the blob pdf, so TS2's jpeg deref is not an image either
        assert!(
            !ctx.rewrite(&format!("pubky://{OWNER}/pub/pubky.app/files/{TS2}"))
                .image
        );
    }

    #[test]
    fn the_title_pipeline_counts_code_points_and_retrims() {
        let title = format!("{}\u{3000}\u{3000}tail", "é".repeat(98));
        assert_eq!(article_title(&title), Some("é".repeat(98)));
        assert_eq!(article_title("\u{3000} x \u{3000}"), Some("x".into()));
        assert_eq!(article_title(" \t "), None);
        // U+200B is not whitespace, so it is a title
        assert_eq!(article_title("\u{200B}"), Some("\u{200B}".into()));
    }

    /// A TimestampId from before October 2024, which the 0.x reader refuses.
    const OLD_TS: &str = "0030VNRG44G00";

    /// The note of an object the 0.x reader refused.
    fn refusal<T: fmt::Debug>(got: Result<T, Skipped>) -> String {
        let skipped = got.unwrap_err();
        assert_eq!(skipped.skip, Skip::Invalid);
        skipped.note.unwrap()
    }

    #[test]
    fn a_tag_whose_stored_id_the_reader_refuses_skips_as_invalid() {
        let target = format!("pubky://{OWNER}/pub/pubky.app/posts/{TS}");
        let bytes = serde_json::to_vec(&serde_json::json!({
            "uri": target, "label": "cool", "created_at": 1727740800000000i64,
        }))
        .unwrap();
        let id = legacy_v0::tag_id(&target, "cool");
        let wrong = "8Z8CWH8NVYQY39ZEBFGKQWWEKG";
        let path = format!("pub/pubky.app/tags/{wrong}");
        assert_eq!(
            transform(&path, &bytes, &ctx()),
            Err(Skipped {
                skip: Skip::Invalid,
                note: Some(format!("Invalid ID: expected {id}, found {wrong}")),
            })
        );
        let path = format!("pub/pubky.app/tags/{id}");
        assert!(transform(&path, &bytes, &ctx()).is_ok());
    }

    #[test]
    fn a_post_with_an_id_from_before_october_2024_skips_as_invalid() {
        let bytes = br#"{"content":"hi","kind":"short","parent":null,"embed":null}"#;
        let path = format!("pub/pubky.app/posts/{OLD_TS}");
        assert!(refusal(transform(&path, bytes, &ctx()))
            .contains("timestamp must be after October 1st, 2024"));
        assert!(transform(&format!("pub/pubky.app/posts/{TS}"), bytes, &ctx()).is_ok());
    }

    #[test]
    fn a_file_the_reader_refuses_names_nothing_and_its_blob_is_an_orphan() {
        use legacy_v0::traits::HashId as _;
        let blob = b"a blob only an old File names".to_vec();
        let hash = legacy_v0::V0Blob(blob.clone()).create_id();
        let file = serde_json::to_vec(&serde_json::json!({
            "name": "old.png",
            "created_at": 1727740800000000i64,
            "src": format!("pubky://{OWNER}/pub/pubky.app/blobs/{hash}"),
            "content_type": "image/png",
            "size": blob.len(),
        }))
        .unwrap();
        let mut ctx = ctx();
        let file_path = format!("pub/pubky.app/files/{OLD_TS}");
        assert!(refusal(ctx.migrate(&file_path, &file))
            .contains("timestamp must be after October 1st, 2024"));

        let legacy = format!("pubky://{OWNER}/pub/pubky.app/files/{OLD_TS}");
        let post = serde_json::to_vec(&serde_json::json!({
            "content": "look", "kind": "image", "parent": null, "embed": null,
            "attachments": [legacy],
        }))
        .unwrap();
        let migrated = ctx
            .migrate(&format!("pub/pubky.app/posts/{TS}"), &post)
            .unwrap();
        let written: Value = serde_json::from_slice(&migrated.writes[0].1).unwrap();
        assert_eq!(written["attachments"][0]["uri"], legacy.as_str());
        assert!(written["attachments"][0]
            .get("name")
            .is_none_or(Value::is_null));

        let migrated = ctx
            .migrate(&format!("pub/pubky.app/blobs/{hash}"), &blob)
            .unwrap();
        assert_eq!(
            migrated.writes,
            vec![(format!("pub/social/v1/files/{hash}.bin"), blob)]
        );
    }

    #[test]
    fn a_deleted_profile_name_migrates_as_the_anonymous_the_reader_made_of_it() {
        let bytes = br#"{"name":" [DELETED] ","bio":null,"image":null,"links":null,"status":null}"#;
        let migrated = transform("pub/pubky.app/profile.json", bytes, &ctx()).unwrap();
        let written: Value = serde_json::from_slice(&migrated.writes[0].1).unwrap();
        assert_eq!(written["name"], "anonymous");
    }

    #[test]
    fn a_profile_the_reader_refuses_skips_and_one_it_accepts_drops_what_v1_refuses() {
        let path = "pub/pubky.app/profile.json";
        let empty = br#"{"name":"alice","bio":null,"image":"","links":null,"status":null}"#;
        assert_eq!(
            refusal(transform(path, empty, &ctx())),
            "Validation Error: Image URI cannot be empty"
        );

        let data = br#"{"name":"alice","bio":null,"image":"data:image/png;base64,AAAA","links":null,"status":null}"#;
        let migrated = transform(path, data, &ctx()).unwrap();
        assert_eq!(migrated.dropped, vec![Dropped::ProfileImage]);
        let written: Value = serde_json::from_slice(&migrated.writes[0].1).unwrap();
        assert!(written.get("image").is_none_or(Value::is_null));
        assert_eq!(written["name"], "alice");
    }
}
