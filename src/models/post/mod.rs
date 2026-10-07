use crate::canonicalize::{checked, is_canonical_segment, AllowedSchemes};
use crate::common::{
    check_extra, code_point_len, frozen_trim, trimmed_or_none, validate_timestamp_id_format,
};
use crate::constants::{namespace_path, SOCIAL_NAMESPACE};
use crate::limits::VALIDATION_LIMITS;
use crate::traits::{HasIdPath, Root, TimestampId, Validatable, ValidationCtx, ValidationError};
use crate::types::PubkyId;
use crate::uri::is_valid_label;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::{fmt, str::FromStr};

pub mod content;
pub mod lifecycle;

pub use content::{
    PubkySocialArticleContent, PubkySocialCollectionContent, PubkySocialCollectionItem,
    PubkySocialCollectionLayout,
};

#[cfg(feature = "openapi")]
use utoipa::ToSchema;

/// The `posts/` directory under a namespace, the same for every specialization.
const POSTS_SEGMENT: &str = "posts/";

/// Represents the type of pubky-app posted data
/// Used primarily to best display the content in UI
#[derive(Serialize, Deserialize, Default, Debug, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(feature = "openapi", derive(ToSchema))]
#[non_exhaustive]
pub enum PubkySocialPostKind {
    #[default]
    Note,
    Article,
    Image,
    Video,
    Link,
    File,
    Collection,
    #[serde(other)]
    Unknown,
}

impl fmt::Display for PubkySocialPostKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.wire_name())
    }
}

impl FromStr for PubkySocialPostKind {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "note" => Ok(PubkySocialPostKind::Note),
            "article" => Ok(PubkySocialPostKind::Article),
            "image" => Ok(PubkySocialPostKind::Image),
            "video" => Ok(PubkySocialPostKind::Video),
            "link" => Ok(PubkySocialPostKind::Link),
            "file" => Ok(PubkySocialPostKind::File),
            "collection" => Ok(PubkySocialPostKind::Collection),
            _ => Err(format!("Validation Error: Invalid content kind: {}", s)),
        }
    }
}

impl PubkySocialPostKind {
    /// Returns `true` for every variant this crate version knows, `false` for `Unknown`.
    ///
    /// `Unknown` is the forwards-compat catch-all variant (via `#[serde(other)]`)
    /// that captures any post-kind string this crate version doesn't
    /// recognize yet. Most consumers, indexers, stream filters, search ranking,
    /// want to skip such posts, and this helper lets them write
    /// `if kind.is_known() { ... }` rather than
    /// `if !matches!(kind, PubkySocialPostKind::Unknown) { ... }`.
    pub fn is_known(&self) -> bool {
        !matches!(self, PubkySocialPostKind::Unknown)
    }

    /// The frozen wire spelling. One function, so the feed id input, `Display` and every
    /// other text rendering of a kind can never disagree.
    pub fn wire_name(&self) -> &'static str {
        match self {
            PubkySocialPostKind::Note => "note",
            PubkySocialPostKind::Article => "article",
            PubkySocialPostKind::Image => "image",
            PubkySocialPostKind::Video => "video",
            PubkySocialPostKind::Link => "link",
            PubkySocialPostKind::File => "file",
            PubkySocialPostKind::Collection => "collection",
            PubkySocialPostKind::Unknown => "unknown",
        }
    }
}

/// One attached media reference. An object rather than a string so per-item metadata can
/// grow without a break. `name` is per reference: two posts may attach the same bytes under
/// different names.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "openapi", derive(ToSchema))]
pub struct PubkySocialAttachment {
    pub uri: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Unknown members, preserved on rewrite; see the module contract in `models/mod.rs`.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl PubkySocialAttachment {
    /// The builder trims `name`; the uri passes through verbatim. Ingest never rewrites
    /// either, so a stored name is counted and rejected as it was written.
    pub fn new(uri: String, alt: Option<String>, name: Option<String>) -> Self {
        PubkySocialAttachment {
            uri,
            alt,
            name: name.map(|n| frozen_trim(&n).to_string()),
            extra: Default::default(),
        }
    }
}

/// A reference position inside a post's `content`, as a kind reports it to the envelope's
/// reference gate: the field name the error message carries, the uri as stored, and the gate
/// it takes.
#[derive(Debug, Clone)]
pub struct ContentReference {
    pub field: String,
    pub uri: String,
    pub schemes: AllowedSchemes,
    pub max_code_points: usize,
}

/// The kind vocabulary of one post specialization: what `PostEnvelope::kind` holds.
///
/// A specialization owns its content semantics and nothing else: which kinds exist, what
/// each kind's `content` must look like, and which positions inside that content are
/// references. The envelope owns everything shared (the parent, embed, attachments and lock
/// positions, the reference gate, the preserved `extra` map, the byte cap, the versioned
/// storage layout and the id mint), so a namespace can ship its own kind set on the same
/// envelope without touching this crate's post code. The wire shape of every specialization
/// is the same object with a different `kind` string.
///
/// `Default` is the kind a bare builder produces; `is_known` is false for the forwards-compat
/// catch-all every kind enum carries, which reads but never validates.
pub trait PostKind: Serialize + DeserializeOwned + Clone + Default {
    /// `false` for the catch-all variant that captures a kind string this version does not
    /// know. Such a post reads, and fails validation.
    fn is_known(&self) -> bool;

    /// The per-kind rules on `content` and on how the envelope positions combine with it,
    /// after the envelope's own rules (the id, `extra`, `is_known`, the reference gate over
    /// every position and the attachment caps) have passed. An error message starts with
    /// `Validation Error: `; the envelope hands it through unchanged.
    fn validate_content(
        &self,
        post: &PostEnvelope<Self>,
        ctx: &ValidationCtx,
    ) -> Result<(), String>;

    /// The reference positions inside `content`, so the envelope's gate can run over them
    /// with the author in scope where validation alone has none (the builders and ingest by
    /// URI pass the author; plain `validate` cannot). Content that carries no references
    /// keeps the default. An unparsable content is the kind's validation error, not this
    /// method's: it reports what it can read.
    fn content_references(&self, _post: &PostEnvelope<Self>) -> Vec<ContentReference> {
        Vec::new()
    }
}

/// The post object every specialization shares, `{root}/{namespace}/v1/posts/{id}/{editId}.json`.
///
/// The type parameter is the specialization's kind vocabulary ([`PostKind`]). Everything on
/// this struct is envelope authority and identical for every `K`: the reference positions and
/// the gate they pass, the attachment caps, the preserved `extra` map, the total byte cap, the
/// timestamp id mint and the versioned layout. `K` decides what `content` means for each of
/// its kinds through [`PostKind::validate_content`]. [`PubkySocialPost`] is the first
/// specialization, under the `social` namespace; an app that needs its own kinds instantiates
/// the same envelope under its own namespace and inherits the mechanics, and a social reader
/// classifies those paths as foreign without reading them.
///
/// Both ids are CrockfordBase32 encodings of a timestamp. Example path:
///
/// `/pub/social/v1/posts/00321FCW75ZFY/00321FCW75ZFY.json`
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
// The trait already carries DeserializeOwned; without this the derive adds its own
// Deserialize<'de> bound next to it and the two are ambiguous
#[serde(bound = "K: PostKind")]
#[cfg_attr(feature = "openapi", derive(ToSchema))]
pub struct PostEnvelope<K: PostKind> {
    pub content: String,
    pub kind: K,
    /// If a reply, the URI of the parent post. Pubky only: a reply is a thread edge.
    pub parent: Option<String>,
    /// A quoted resource, pubky or web. The kind is derivable from the target.
    pub embed: Option<String>,
    /// Always present on the wire, `[]` when empty. An absent field reads as `[]`; an
    /// explicit `null` is invalid.
    #[serde(default)]
    pub attachments: Vec<PubkySocialAttachment>,
    /// The lock file URI, a foreign-app pubky reference. Presence means "locked content"
    /// whatever the kind; the teaser envelope inside `content` is the client's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lock: Option<String>,
    /// Unknown members, preserved on rewrite; see the module contract in `models/mod.rs`.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// The social post: the envelope with the closed social kind set, stored under `social`.
pub type PubkySocialPost = PostEnvelope<PubkySocialPostKind>;

impl<K: PostKind> PostEnvelope<K> {
    /// Trims `content`; references pass through verbatim. Infallible; callers validate
    /// before writing.
    pub fn new(
        content: String,
        kind: K,
        parent: Option<String>,
        embed: Option<String>,
        attachments: Vec<PubkySocialAttachment>,
    ) -> Self {
        Self::new_with_lock(content, kind, parent, embed, attachments, None)
    }

    pub fn new_with_lock(
        content: String,
        kind: K,
        parent: Option<String>,
        embed: Option<String>,
        attachments: Vec<PubkySocialAttachment>,
        lock: Option<String>,
    ) -> Self {
        PostEnvelope {
            content: frozen_trim(&content).to_string(),
            kind,
            parent,
            embed,
            attachments,
            lock,
            extra: Default::default(),
        }
    }
}

impl<K: PostKind> TimestampId for PostEnvelope<K> {}

impl HasIdPath for PubkySocialPost {
    const ROOT: Root = Root::Pub;
    const PATH_SEGMENT: &'static str = POSTS_SEGMENT;

    fn create_path(id: &str) -> String {
        Self::create_path_in(Self::ROOT, id, id, None)
    }
}

/// Where one version of a post is stored. A call result, not a wire type.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MintedVersion {
    pub id: String,
    pub edit_id: String,
    pub path: String,
}

impl<K: PostKind> PostEnvelope<K> {
    /// "/{root}/{namespace}/v1/posts/{id}/{editId}[-{slug}].json". Creation writes
    /// `editId == id`, deterministic so migration never invents a value. The slug is readable
    /// decoration on the file name, never part of the identity; the builders validate it,
    /// this assembles.
    pub fn version_path(
        namespace: &str,
        root: Root,
        id: &str,
        edit_id: &str,
        slug: Option<&str>,
    ) -> String {
        let leaf = match slug {
            Some(slug) => format!("{POSTS_SEGMENT}{id}/{edit_id}-{slug}.json"),
            None => format!("{POSTS_SEGMENT}{id}/{edit_id}.json"),
        };
        namespace_path(root, namespace, &leaf)
    }

    /// Creation under a namespace: mints the post id, validates against the destination
    /// root with the author in scope, returns `posts/{id}/{id}.json`. The social namespace
    /// is reserved: social readers own that location and refuse any other kind, so only
    /// [`PubkySocialPost::create_version`] writes there.
    pub fn create_version_under(
        &self,
        namespace: &str,
        root: Root,
        owner: &PubkyId,
        slug: Option<&str>,
    ) -> Result<MintedVersion, String> {
        reject_social_namespace(namespace)?;
        let id = self.create_id();
        self.mint(namespace, id.clone(), id, root, owner, slug)
    }

    /// Edit under a namespace: keeps `id`, mints an editId strictly above `head`, the
    /// current newest version (the id itself for a never-edited post). The newest version is
    /// the bytewise greatest, so an editId below the head would hide the edit; a head created
    /// by a faster clock is a floor, and a head already at the validity bound makes the edit
    /// an error rather than an id no reader accepts. The social namespace is reserved, as for
    /// [`PostEnvelope::create_version_under`].
    pub fn edit_version_under(
        &self,
        namespace: &str,
        id: &str,
        head: &str,
        root: Root,
        owner: &PubkyId,
        slug: Option<&str>,
    ) -> Result<MintedVersion, String> {
        reject_social_namespace(namespace)?;
        let edit_id = self.edit_id_above(id, head)?;
        self.mint(namespace, id.to_string(), edit_id, root, owner, slug)
    }

    fn edit_id_above(&self, id: &str, head: &str) -> Result<String, String> {
        validate_timestamp_id_format(id)?;
        if head.as_bytes() < id.as_bytes() {
            return Err(format!(
                "Validation Error: head {head} is older than the post id {id}"
            ));
        }
        let salt = {
            let bytes = serde_json::to_vec(self).map_err(|e| e.to_string())?;
            let mut hasher = blake3::Hasher::new();
            hasher.update(head.as_bytes());
            hasher.update(&bytes);
            u64::from_le_bytes(hasher.finalize().as_bytes()[..8].try_into().unwrap())
        };
        self.create_id_above(head, salt)
    }

    fn mint(
        &self,
        namespace: &str,
        id: String,
        edit_id: String,
        root: Root,
        owner: &PubkyId,
        slug: Option<&str>,
    ) -> Result<MintedVersion, String> {
        if let Some(slug) = slug {
            if !is_valid_label(slug) {
                return Err(format!(
                    "Validation Error: slug must be 1..={} chars of a-z, 0-9 and -: {slug}",
                    VALIDATION_LIMITS.post_slug_max_length
                ));
            }
        }
        if !is_canonical_segment(namespace) {
            return Err(format!(
                "Validation Error: namespace must be one path segment: {namespace}"
            ));
        }
        let ctx = ValidationCtx { root };
        self.validate(Some(&id), &ctx)?;
        // The editId is a TimestampId too, so the validity bound applies to it
        self.validate_id(&edit_id)?;
        // The ownership rule, which plain validate has no author for
        self.check_references(&ctx, Some(owner))?;
        let path = Self::version_path(namespace, root, &id, &edit_id, slug);
        Ok(MintedVersion { id, edit_id, path })
    }

    /// Every reference position through the one gate: `parent` and `embed` universal, `lock`
    /// pubky, attachments pubky or web, then whatever positions the kind reports inside
    /// `content`. `owner` enables the ownership rule (a private object of another user
    /// resolves for nobody): `validate` has no author and passes `None`, the builders pass
    /// it, and ingest by URI must call this with the author the URI names, as
    /// `PubkySocialObject::from_uri` does.
    pub fn check_references(
        &self,
        ctx: &ValidationCtx,
        owner: Option<&PubkyId>,
    ) -> Result<(), String> {
        use AllowedSchemes::*;
        let max = VALIDATION_LIMITS.reference_uri_max_length;
        if let Some(parent) = &self.parent {
            checked("parent", parent, Universal, max, ctx, owner)?;
        }
        if let Some(embed) = &self.embed {
            checked("embed", embed, Universal, max, ctx, owner)?;
        }
        if let Some(lock) = &self.lock {
            checked("lock", lock, PubkyOnly, max, ctx, owner)?;
        }
        for (index, attachment) in self.attachments.iter().enumerate() {
            let field = format!("attachments[{index}].uri");
            checked(&field, &attachment.uri, PubkyHttpHttps, max, ctx, owner)?;
        }
        for r in self.kind.content_references(self) {
            checked(&r.field, &r.uri, r.schemes, r.max_code_points, ctx, owner)?;
        }
        Ok(())
    }
}

fn reject_social_namespace(namespace: &str) -> Result<(), String> {
    if namespace == SOCIAL_NAMESPACE {
        return Err(format!(
            "Validation Error: the social namespace is reserved for the social post kind: {namespace}"
        ));
    }
    Ok(())
}

impl PubkySocialPost {
    /// "/{root}/social/v1/posts/{id}/{editId}[-{slug}].json", see [`PostEnvelope::version_path`].
    pub fn create_path_in(root: Root, id: &str, edit_id: &str, slug: Option<&str>) -> String {
        Self::version_path(SOCIAL_NAMESPACE, root, id, edit_id, slug)
    }

    /// Creation under `social`, see [`PostEnvelope::create_version_under`].
    pub fn create_version(
        &self,
        root: Root,
        owner: &PubkyId,
        slug: Option<&str>,
    ) -> Result<MintedVersion, String> {
        let id = self.create_id();
        self.mint(SOCIAL_NAMESPACE, id.clone(), id, root, owner, slug)
    }

    /// Edit under `social`, see [`PostEnvelope::edit_version_under`].
    pub fn edit_version(
        &self,
        id: &str,
        head: &str,
        root: Root,
        owner: &PubkyId,
        slug: Option<&str>,
    ) -> Result<MintedVersion, String> {
        let edit_id = self.edit_id_above(id, head)?;
        self.mint(SOCIAL_NAMESPACE, id.to_string(), edit_id, root, owner, slug)
    }

    /// The item uris of the collection envelope, when the kind and the content say so.
    pub(crate) fn collection_item_uris(&self) -> Vec<String> {
        if !matches!(self.kind, PubkySocialPostKind::Collection) {
            return vec![];
        }
        serde_json::from_str::<content::collection::PubkySocialCollectionContent>(&self.content)
            .map(|e| e.items.into_iter().map(|i| i.uri).collect())
            .unwrap_or_default()
    }

    /// `cover_image` of the article or collection envelope, when the content parses.
    pub(crate) fn envelope_cover(&self) -> Option<String> {
        if !matches!(
            self.kind,
            PubkySocialPostKind::Article | PubkySocialPostKind::Collection
        ) {
            return None;
        }
        let envelope: serde_json::Value = serde_json::from_str(&self.content).ok()?;
        envelope.get("cover_image")?.as_str().map(str::to_string)
    }
}

impl PostKind for PubkySocialPostKind {
    fn is_known(&self) -> bool {
        PubkySocialPostKind::is_known(self)
    }

    fn validate_content(&self, post: &PubkySocialPost, ctx: &ValidationCtx) -> Result<(), String> {
        match self {
            PubkySocialPostKind::Collection => content::collection::validate_collection_post(post),
            PubkySocialPostKind::Article => content::article::validate_article_post(post, ctx),
            // Note, Image, Video, Link, File: untyped content. The envelope refused Unknown
            // before dispatching, so the wildcard never sees it.
            _ => {
                if frozen_trim(&post.content).is_empty()
                    && post.embed.is_none()
                    && post.attachments.is_empty()
                {
                    return Err(
                        "Validation Error: Post must have content, an embed, or attachments".into(),
                    );
                }
                let max = VALIDATION_LIMITS.post_note_content_max_length;
                if code_point_len(&post.content) > max {
                    return Err(format!(
                        "Validation Error: content must be at most {max} code points for kind {self}"
                    ));
                }
                Ok(())
            }
        }
    }

    /// Either envelope's cover, then the collection items; an unparsable envelope is that
    /// validator's error.
    fn content_references(&self, post: &PubkySocialPost) -> Vec<ContentReference> {
        let mut refs = Vec::new();
        if let Some(cover) = post.envelope_cover() {
            refs.push(ContentReference {
                field: "cover_image".to_string(),
                uri: cover,
                schemes: AllowedSchemes::PubkyHttpHttps,
                max_code_points: VALIDATION_LIMITS.image_url_max_length,
            });
        }
        for (index, uri) in post.collection_item_uris().into_iter().enumerate() {
            refs.push(ContentReference {
                field: format!("items[{index}].uri"),
                uri,
                schemes: AllowedSchemes::Universal,
                max_code_points: VALIDATION_LIMITS.reference_uri_max_length,
            });
        }
        refs
    }
}

impl<K: PostKind> Validatable for PostEnvelope<K> {
    const MAX_BYTES: usize = VALIDATION_LIMITS.post_max_bytes;

    fn validate_fields(
        &self,
        id: Option<&str>,
        ctx: &ValidationCtx,
    ) -> Result<(), ValidationError> {
        if let Some(id) = id {
            self.validate_id(id)?;
        }
        check_extra(
            &self.extra,
            &["content", "kind", "parent", "embed", "attachments", "lock"],
        )?;

        // `Unknown` is the forwards-compat catch-all: readable, never valid to write
        if !self.kind.is_known() {
            return Err("Validation Error: post kind is unknown".into());
        }

        self.check_references(ctx, None)?;

        if self.attachments.len() > VALIDATION_LIMITS.post_attachments_max_count {
            return Err(format!(
                "Validation Error: Too many attachments (max: {})",
                VALIDATION_LIMITS.post_attachments_max_count
            ));
        }
        for (index, attachment) in self.attachments.iter().enumerate() {
            check_extra(&attachment.extra, &["uri", "alt", "name"])?;
            if let Some(alt) = &attachment.alt {
                if code_point_len(alt) > VALIDATION_LIMITS.attachment_alt_max_length {
                    return Err(format!(
                        "Validation Error: attachments[{index}].alt must be at most {} code points",
                        VALIDATION_LIMITS.attachment_alt_max_length
                    ));
                }
            }
            if let Some(name) = &attachment.name {
                let max = VALIDATION_LIMITS.attachment_name_max_length;
                if frozen_trim(name).is_empty() || code_point_len(name) > max {
                    return Err(format!(
                        "Validation Error: attachments[{index}].name must be 1..={max} code points and not blank"
                    ));
                }
            }
        }

        self.kind.validate_content(self, ctx)
    }
}

impl PubkySocialPost {
    /// Builds the article envelope into `content` and wraps it in a `kind = Article` post.
    /// Infallible; callers validate before writing.
    pub fn new_article(
        title: String,
        body: String,
        cover_image: Option<String>,
        parent: Option<String>,
        embed: Option<String>,
        attachments: Vec<PubkySocialAttachment>,
        lock: Option<String>,
    ) -> Self {
        let envelope = PubkySocialArticleContent {
            title: frozen_trim(&title).to_string(),
            body,
            cover_image,
            extra: Default::default(),
        };
        let content =
            serde_json::to_string(&envelope).expect("a string-only envelope always serializes");
        Self::new_with_lock(
            content,
            PubkySocialPostKind::Article,
            parent,
            embed,
            attachments,
            lock,
        )
    }

    /// Builds the collection envelope into `content` and wraps it in a `kind = Collection`
    /// post. Trims the name and the description, a blank description becoming absent; item
    /// and cover uris pass through verbatim. Infallible; callers validate before writing.
    pub fn new_collection(
        name: String,
        description: Option<String>,
        items: Vec<PubkySocialCollectionItem>,
        cover_image: Option<String>,
        layout: Option<PubkySocialCollectionLayout>,
    ) -> Self {
        let envelope = PubkySocialCollectionContent {
            name: frozen_trim(&name).to_string(),
            description: description.and_then(trimmed_or_none),
            items,
            cover_image,
            layout,
            extra: Default::default(),
        };
        let content =
            serde_json::to_string(&envelope).expect("a string-only envelope always serializes");
        Self::new(content, PubkySocialPostKind::Collection, None, None, vec![])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::traits::PUB_CTX;

    const PK: &str = "operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo";
    const TS: &str = "0032SSN7Q4EVG";

    fn p(path: &str) -> String {
        format!("pubky://{PK}{path}")
    }

    fn post_uri() -> String {
        p("/pub/social/v1/posts/0032SSN7Q4EVG")
    }

    fn file_uri() -> String {
        p("/pub/social/v1/files/PZBQ010FF079VVZPQG1RNFN6DR.png")
    }

    fn note(content: &str) -> PubkySocialPost {
        PubkySocialPost::new(
            content.to_string(),
            PubkySocialPostKind::Note,
            None,
            None,
            vec![],
        )
    }

    fn att(uri: &str) -> PubkySocialAttachment {
        PubkySocialAttachment::new(uri.to_string(), None, None)
    }

    fn post(
        kind: PubkySocialPostKind,
        parent: Option<&str>,
        embed: Option<&str>,
        attachments: Vec<PubkySocialAttachment>,
    ) -> PubkySocialPost {
        PubkySocialPost::new(
            "".into(),
            kind,
            parent.map(str::to_string),
            embed.map(str::to_string),
            attachments,
        )
    }

    fn validate(post: &PubkySocialPost) -> Result<(), String> {
        let id = post.create_id();
        post.validate(Some(&id), &PUB_CTX)
    }

    fn err(post: &PubkySocialPost) -> String {
        validate(post).expect_err("expected a validation error")
    }

    // ---- ids, paths, builders ----

    #[test]
    fn test_create_id() {
        let id = note("Hello World!").create_id();
        assert_eq!(id.len(), 13);
        assert!(id.chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn test_new() {
        let post = note("Hello World!");
        assert_eq!(post.content, "Hello World!");
        assert_eq!(post.kind, PubkySocialPostKind::Note);
        assert!(post.parent.is_none());
        assert!(post.embed.is_none());
        assert!(post.attachments.is_empty());
        assert!(post.lock.is_none());
        assert!(post.extra.is_empty());
    }

    #[test]
    fn test_default_kind_is_note() {
        assert_eq!(PubkySocialPostKind::default(), PubkySocialPostKind::Note);
    }

    #[test]
    fn test_create_path() {
        let path = PubkySocialPost::create_path("0032SSN7Q4EVG");
        assert_eq!(
            path,
            "/pub/social/v1/posts/0032SSN7Q4EVG/0032SSN7Q4EVG.json"
        );
    }

    #[test]
    fn test_validate() {
        assert!(validate(&note("Hello World!")).is_ok());
    }

    #[test]
    fn test_validate_invalid_id() {
        let post = note("Hello World!");
        assert!(post.validate(Some("INVALIDID12345"), &PUB_CTX).is_err());
    }

    #[test]
    fn test_try_from_valid() {
        let post_json = r#"{"content":"Hello World!","kind":"note","parent":null,"embed":null,"attachments":[]}"#;
        let id = note("x").create_id();
        let post = <PubkySocialPost as Validatable>::try_from(post_json.as_bytes(), &id, &PUB_CTX)
            .unwrap();
        assert_eq!(post.content, "Hello World!");
    }

    // ---- text ops ----

    #[test]
    fn builder_trims_content_and_leaves_references_verbatim() {
        let parent = format!("  {}  ", post_uri());
        let post = PubkySocialPost::new(
            "\u{3000}  hello  \u{3000}".to_string(),
            PubkySocialPostKind::Note,
            Some(parent.clone()),
            None,
            vec![PubkySocialAttachment::new(
                format!("  {}  ", file_uri()),
                None,
                Some("  cat.jpg  ".to_string()),
            )],
        );
        assert_eq!(post.content, "hello");
        // References are never rewritten; validation rejects a padded one
        assert_eq!(post.parent.as_deref(), Some(parent.as_str()));
        assert_eq!(post.attachments[0].uri, format!("  {}  ", file_uri()));
        assert_eq!(post.attachments[0].name.as_deref(), Some("cat.jpg"));
        assert!(err(&post).contains("parent"));
    }

    #[test]
    fn attachment_name_is_trimmed_by_the_builder_and_never_on_read() {
        let json = format!(
            r#"{{"content":"x","kind":"note","parent":null,"embed":null,"attachments":[{{"uri":"{}","name":"  cat.jpg  "}}]}}"#,
            file_uri()
        );
        let id = note("x").create_id();
        let post =
            <PubkySocialPost as Validatable>::try_from(json.as_bytes(), &id, &PUB_CTX).unwrap();
        assert_eq!(post.attachments[0].name.as_deref(), Some("  cat.jpg  "));
        // Blank is rejected where a rewrite used to blank it silently
        let blank = json.replace(r#""  cat.jpg  ""#, r#""  ""#);
        let e = <PubkySocialPost as Validatable>::try_from(blank.as_bytes(), &id, &PUB_CTX)
            .expect_err("a blank name is invalid");
        assert!(e.contains("not blank"), "{e}");
    }

    #[test]
    fn content_is_read_verbatim() {
        let json =
            r#"{"content":"  hello  ","kind":"note","parent":null,"embed":null,"attachments":[]}"#;
        let id = note("x").create_id();
        let post =
            <PubkySocialPost as Validatable>::try_from(json.as_bytes(), &id, &PUB_CTX).unwrap();
        assert_eq!(post.content, "  hello  ");
        // Blank as stored still fails the content-or-embed-or-attachments rule
        let blank = json.replace("  hello  ", r" \u3000 ");
        let e = <PubkySocialPost as Validatable>::try_from(blank.as_bytes(), &id, &PUB_CTX)
            .expect_err("blank content with nothing else is invalid");
        assert!(e.contains("must have content"), "{e}");
    }

    #[test]
    fn padded_content_is_counted_as_stored() {
        let max = VALIDATION_LIMITS.post_note_content_max_length;
        let json = |content: String| {
            format!(
                r#"{{"content":"{content}","kind":"note","parent":null,"embed":null,"attachments":[]}}"#
            )
        };
        let id = note("x").create_id();
        let read = |content: String| {
            <PubkySocialPost as Validatable>::try_from(json(content).as_bytes(), &id, &PUB_CTX)
        };
        assert!(read("a".repeat(max)).is_ok());
        let e = read(format!(" {}", "a".repeat(max))).expect_err("padding counts");
        assert!(e.contains("at most"), "{e}");
    }

    #[test]
    fn builder_trim_keeps_zero_width_space() {
        let post = note("\u{200B}hello\u{200B}");
        assert_eq!(post.content, "\u{200B}hello\u{200B}");
    }

    #[test]
    fn test_content_length_counts_code_points() {
        let post = note(&"\u{1F600}".repeat(VALIDATION_LIMITS.post_note_content_max_length));
        assert!(validate(&post).is_ok());
        let post = note(&"\u{1F600}".repeat(VALIDATION_LIMITS.post_note_content_max_length + 1));
        assert!(err(&post).contains("at most"));
    }

    // v0 reserved this literal; v1 keys deletion on the indexer's flag instead
    #[test]
    fn test_deleted_literal_is_ordinary_content() {
        let post_json =
            r#"{"content":"[DELETED]","kind":"note","parent":null,"embed":null,"attachments":[]}"#;
        let id = note("x").create_id();
        let post = <PubkySocialPost as Validatable>::try_from(post_json.as_bytes(), &id, &PUB_CTX)
            .expect("no reserved literal in v1");
        assert_eq!(post.content, "[DELETED]");
    }

    // ---- preservation and size caps ----

    #[test]
    fn test_unknown_members_survive_rewrite() {
        let post_json = format!(
            r#"{{"content":"hello","kind":"note","parent":null,"embed":null,"attachments":[{{"uri":"{}","focus":"center"}}],"ext":{{"badge":1}},"later":"field"}}"#,
            file_uri()
        );
        let post: PubkySocialPost = serde_json::from_str(&post_json).unwrap();
        assert_eq!(post.extra.len(), 2);
        let out: serde_json::Value = serde_json::to_value(&post).unwrap();
        assert_eq!(out["ext"]["badge"], 1);
        assert_eq!(out["later"], "field");
        assert_eq!(out["attachments"][0]["focus"], "center");
        assert_eq!(out["content"], "hello");
    }

    #[test]
    fn test_empty_extra_emits_nothing() {
        let out = serde_json::to_string(&note("hello")).unwrap();
        assert!(!out.contains("extra"), "{out}");
    }

    fn padded_blob(len: usize) -> Vec<u8> {
        let head =
            r#"{"content":"x","kind":"note","parent":null,"embed":null,"attachments":[],"pad":""#;
        let tail = r#""}"#;
        let mut blob = head.to_string();
        blob.push_str(&"a".repeat(len - head.len() - tail.len()));
        blob.push_str(tail);
        assert_eq!(blob.len(), len);
        blob.into_bytes()
    }

    #[test]
    fn test_size_cap_is_checked_before_parsing() {
        let id = note("x").create_id();
        let cap = VALIDATION_LIMITS.post_max_bytes;
        assert!(
            <PubkySocialPost as Validatable>::try_from(&padded_blob(cap), &id, &PUB_CTX).is_ok()
        );
        // Malformed on purpose: only the pre-parse check can produce the size error
        let mut oversize = padded_blob(cap + 2);
        oversize.pop();
        let err = <PubkySocialPost as Validatable>::try_from(&oversize, &id, &PUB_CTX).unwrap_err();
        assert!(err.contains("exceeds"), "{err}");
    }

    #[test]
    fn test_extra_must_not_shadow_a_field() {
        let mut post = note("real");
        post.extra.insert("kind".into(), "article".into());
        assert!(err(&post).contains("shadow"));
        let mut post = note("real");
        post.attachments.push(att(&file_uri()));
        post.attachments[0].extra.insert("uri".into(), "x".into());
        assert!(err(&post).contains("shadow"));
    }

    #[test]
    fn test_size_cap_applies_to_built_objects() {
        let mut post = note("x");
        post.extra.insert(
            "pad".into(),
            serde_json::Value::String("a".repeat(VALIDATION_LIMITS.post_max_bytes)),
        );
        assert!(err(&post).contains("exceeds"));
    }

    // ---- kinds ----

    #[test]
    fn test_kinds_round_trip_and_retired_spellings_read_as_unknown() {
        for (kind, wire) in [
            (PubkySocialPostKind::Note, "\"note\""),
            (PubkySocialPostKind::Article, "\"article\""),
            (PubkySocialPostKind::Image, "\"image\""),
            (PubkySocialPostKind::Video, "\"video\""),
            (PubkySocialPostKind::Link, "\"link\""),
            (PubkySocialPostKind::File, "\"file\""),
            (PubkySocialPostKind::Collection, "\"collection\""),
        ] {
            assert_eq!(serde_json::to_string(&kind).unwrap(), wire);
            assert_eq!(
                serde_json::from_str::<PubkySocialPostKind>(wire).unwrap(),
                kind
            );
            assert_eq!(kind.to_string(), wire.trim_matches('"'));
            assert!(kind.is_known());
        }
        for retired in ["\"short\"", "\"long\"", "\"hologram\""] {
            let kind: PubkySocialPostKind = serde_json::from_str(retired).unwrap();
            assert_eq!(kind, PubkySocialPostKind::Unknown);
            assert!(!kind.is_known());
        }
        assert_eq!(PubkySocialPostKind::Unknown.to_string(), "unknown");
    }

    #[test]
    fn test_fromstr_never_produces_unknown() {
        assert_eq!(
            "note".parse::<PubkySocialPostKind>().unwrap(),
            PubkySocialPostKind::Note
        );
        assert_eq!(
            "article".parse::<PubkySocialPostKind>().unwrap(),
            PubkySocialPostKind::Article
        );
        assert_eq!(
            "collection".parse::<PubkySocialPostKind>().unwrap(),
            PubkySocialPostKind::Collection
        );
        for bad in ["short", "long", "unknown", "Note", ""] {
            assert!(bad.parse::<PubkySocialPostKind>().is_err(), "{bad}");
        }
    }

    #[test]
    fn test_unknown_kind_reads_then_fails_validation() {
        let post_json =
            r#"{"content":"hello","kind":"short","parent":null,"embed":null,"attachments":[]}"#;
        let post: PubkySocialPost = serde_json::from_str(post_json).unwrap();
        assert_eq!(post.kind, PubkySocialPostKind::Unknown);
        assert!(err(&post).contains("post kind is unknown"));
    }

    // ---- references ----

    #[test]
    fn test_parent_is_universal_and_versionless() {
        // A thread can be rooted at a post, a user, a web page or an external resource
        for ok in [
            post_uri(),
            p(""),
            "https://example.com/post".to_string(),
            "nostr:nevent1abc".to_string(),
        ] {
            let mut reply = post(PubkySocialPostKind::Note, Some(&ok), None, vec![]);
            reply.content = "re".into();
            assert!(validate(&reply).is_ok(), "{ok}");
        }
        for bad in [
            format!("pubky{PK}/pub/social/v1/posts/0032SSN7Q4EVG"),
            p("/pub/social/v1/posts/../profile.json"),
            p("/pub/social/v1/posts/00%32"),
            p("/pub/social/v1/posts/0032SSN7Q4EVG/0032SSN7Q4EVG.json"),
            p("/priv/social/v1/posts/0032SSN7Q4EVG"),
            " https://example.com".to_string(),
            "IPFS://x".to_string(),
            String::new(),
        ] {
            let mut reply = post(PubkySocialPostKind::Note, Some(&bad), None, vec![]);
            reply.content = "re".into();
            assert!(err(&reply).contains("parent"), "{bad}");
        }
    }

    #[test]
    fn test_root_rule_on_every_reference_position() {
        let private = p("/priv/social/v1/posts/0032SSN7Q4EVG");
        let priv_file = p("/priv/social/v1/files/PZBQ010FF079VVZPQG1RNFN6DR.png");
        let priv_ctx = ValidationCtx { root: Root::Priv };
        let id = PubkySocialPost::default().create_id();
        let mut reply = post(PubkySocialPostKind::Note, Some(&private), None, vec![]);
        reply.content = "re".into();
        let quote = post(PubkySocialPostKind::Note, None, Some(&private), vec![]);
        let with_file = post(
            PubkySocialPostKind::Image,
            None,
            None,
            vec![att(&priv_file)],
        );
        let mut locked = note("x");
        locked.lock = Some(private.clone());
        let covered = PubkySocialPost::new_article(
            "t".into(),
            "b".into(),
            Some(priv_file.clone()),
            None,
            None,
            vec![],
            None,
        );
        for (name, p) in [
            ("parent", reply),
            ("embed", quote),
            ("attachments[0].uri", with_file),
            ("lock", locked),
            ("cover_image", covered),
        ] {
            assert!(
                p.validate(Some(&id), &priv_ctx).is_ok(),
                "{name} under priv"
            );
            let e = p.validate(Some(&id), &PUB_CTX).unwrap_err();
            assert!(
                e.contains(&format!(
                    "Validation Error: {name} must not reference a private object: "
                )),
                "{name}: {e}"
            );
        }
        // a web attachment is root-indifferent
        let web = post(
            PubkySocialPostKind::Image,
            None,
            None,
            vec![att("https://x.com/a.png")],
        );
        assert!(web.validate(Some(&id), &priv_ctx).is_ok());
        assert!(web.validate(Some(&id), &PUB_CTX).is_ok());
    }

    #[test]
    fn test_embed_is_universal() {
        for ok in [
            post_uri(),
            "https://example.com/a?b=c".to_string(),
            "nostr:nevent1abc".to_string(),
            "ftp://x/y".to_string(),
            "geo:1,2".to_string(),
        ] {
            let quote = post(PubkySocialPostKind::Note, None, Some(&ok), vec![]);
            assert!(validate(&quote).is_ok(), "{ok}");
        }
        // Not fixed points of the gate: padding, an unfolded scheme, no scheme at all
        for bad in [" https://example.com", "IPFS://x", "just words", ""] {
            let quote = post(PubkySocialPostKind::Note, None, Some(bad), vec![]);
            assert!(err(&quote).contains("embed"), "{bad}");
        }
    }

    // ---- storage builders ----

    fn owner() -> PubkyId {
        PubkyId::try_from(PK).unwrap()
    }

    #[test]
    fn test_create_version_mints_first_version_under_either_root() {
        let n = note("hi");
        let pub_v = n.create_version(Root::Pub, &owner(), None).unwrap();
        assert_eq!(pub_v.edit_id, pub_v.id);
        assert_eq!(
            pub_v.path,
            format!("/pub/social/v1/posts/{}/{}.json", pub_v.id, pub_v.id)
        );
        assert_eq!(pub_v.path, PubkySocialPost::create_path(&pub_v.id));
        let priv_v = n.create_version(Root::Priv, &owner(), None).unwrap();
        assert!(priv_v.path.starts_with("/priv/social/v1/posts/"));
    }

    #[test]
    fn test_edit_version_keeps_id_and_mints_increasing_edit_ids() {
        let n = note("hi");
        let first = n.create_version(Root::Pub, &owner(), None).unwrap();
        let mut prev = first.edit_id.clone();
        for _ in 0..3 {
            let v = n
                .edit_version(&first.id, &prev, Root::Pub, &owner(), None)
                .unwrap();
            assert_eq!(v.id, first.id);
            assert!(
                v.edit_id.as_bytes() > prev.as_bytes(),
                "{} > {prev}",
                v.edit_id
            );
            assert!(v
                .path
                .starts_with(&format!("/pub/social/v1/posts/{}/", first.id)));
            prev = v.edit_id;
        }
        // an alias spelling of the id is not an id
        let alias = first.id.replace('0', "O");
        assert!(n
            .edit_version(&alias, &alias, Root::Pub, &owner(), None)
            .is_err());
        // a head that predates the post is not this post's head
        assert!(n
            .edit_version(&first.id, "0032SSN7Q4EVG", Root::Pub, &owner(), None)
            .is_err());
    }

    #[test]
    fn test_edit_version_stays_above_a_head_minted_by_a_faster_clock() {
        use crate::common::timestamp;
        let n = note("hi");
        let encode =
            |micros: i64| base32::encode(base32::Alphabet::Crockford, &micros.to_be_bytes());
        let hour = 60 * 60 * 1_000_000;
        // created an hour ahead of this clock: the edit must still sort after it
        let ahead = encode(timestamp() + hour);
        let v = n
            .edit_version(&ahead, &ahead, Root::Pub, &owner(), None)
            .unwrap();
        assert!(
            v.edit_id.as_bytes() > ahead.as_bytes(),
            "{} > {ahead}",
            v.edit_id
        );
        // and the floor does not drag later mints into the future
        assert!(n.create_id().as_bytes() < ahead.as_bytes());
        // behind the head, different bytes land on different successors; the same bytes on the
        // same one, so a duplicate write is harmless and a different write is never lost
        let again = note("hi")
            .edit_version(&ahead, &ahead, Root::Pub, &owner(), None)
            .unwrap();
        let other = note("bye")
            .edit_version(&ahead, &ahead, Root::Pub, &owner(), None)
            .unwrap();
        assert_ne!(v.edit_id, other.edit_id);
        assert!(again.edit_id.as_bytes() > ahead.as_bytes());
        // a head past the validity window is not a head
        let e = n
            .edit_version(
                &ahead,
                &encode(timestamp() + 3 * hour),
                Root::Pub,
                &owner(),
                None,
            )
            .unwrap_err();
        assert!(e.contains("future"), "{e}");
        // a canonical spelling of i64::MAX is not a head either, and never overflows
        assert!(n
            .edit_version(&ahead, "FZZZZZZZZZZZY", Root::Pub, &owner(), None)
            .is_err());
    }

    #[test]
    fn test_slug_is_validated_and_reparses() {
        let n = note("hi");
        let long = "a".repeat(VALIDATION_LIMITS.post_slug_max_length);
        let v = n.create_version(Root::Pub, &owner(), Some(&long)).unwrap();
        assert!(v.path.ends_with(&format!("/{}-{long}.json", v.edit_id)));
        let uri = format!("pubky://{PK}{}", v.path);
        let parsed = crate::ParsedUri::try_from(uri.as_str()).unwrap();
        assert_eq!(
            parsed.resource,
            crate::Resource::Post {
                id: v.id.clone(),
                version: Some(v.edit_id.clone()),
                label: Some(long.clone()),
            }
        );
        assert_eq!(parsed.try_to_uri_str().unwrap(), uri);
        for bad in [
            format!("{long}a"),
            "Bad Slug".into(),
            String::new(),
            "a_b".into(),
        ] {
            let e = n
                .create_version(Root::Pub, &owner(), Some(&bad))
                .unwrap_err();
            assert!(e.contains("slug"), "{bad}: {e}");
        }
    }

    #[test]
    fn test_builders_enforce_ownership_where_validate_cannot() {
        let other = "8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo";
        let foreign_private = format!("pubky://{other}/priv/social/v1/posts/0032SSN7Q4EVG");
        let mut draft = post(
            PubkySocialPostKind::Note,
            Some(&foreign_private),
            None,
            vec![],
        );
        draft.content = "re".into();
        let id = draft.create_id();
        // No author in scope: only the root rule applies, and a private draft may hold it
        assert!(draft
            .validate(Some(&id), &ValidationCtx { root: Root::Priv })
            .is_ok());
        let e = draft
            .create_version(Root::Priv, &owner(), None)
            .unwrap_err();
        assert!(
            e.contains(
                "Validation Error: parent must not reference a private object of another user: "
            ),
            "{e}"
        );
        // A public destination is refused by the root rule before ownership is considered
        let e = draft.create_version(Root::Pub, &owner(), None).unwrap_err();
        assert!(e.contains("must not reference a private object: "), "{e}");
    }

    #[test]
    fn test_builders_check_the_article_cover_with_the_owner() {
        let other = "8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo";
        let cover = format!("pubky://{other}/priv/social/v1/files/PZBQ010FF079VVZPQG1RNFN6DR.png");
        let article = PubkySocialPost::new_article(
            "t".into(),
            "b".into(),
            Some(cover),
            None,
            None,
            vec![],
            None,
        );
        let e = article
            .create_version(Root::Priv, &owner(), None)
            .unwrap_err();
        assert!(
            e.contains("Validation Error: cover_image must not reference a private object of another user: "),
            "{e}"
        );
    }

    #[test]
    fn test_ingest_by_uri_applies_the_ownership_rule() {
        let other = "8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo";
        let foreign_private = format!("pubky://{other}/priv/social/v1/posts/0032SSN7Q4EVG");
        let mut draft = post(
            PubkySocialPostKind::Note,
            Some(&foreign_private),
            None,
            vec![],
        );
        draft.content = "re".into();
        let id = draft.create_id();
        let blob = serde_json::to_vec(&draft).unwrap();
        let uri = format!("pubky://{PK}/priv/social/v1/posts/{id}/{id}.json");
        // by resource alone there is no author, so only the root rule applies
        let ctx = ValidationCtx { root: Root::Priv };
        let resource = crate::ParsedUri::try_from(uri.as_str()).unwrap().resource;
        assert!(crate::PubkySocialObject::from_resource(&resource, &blob, &ctx).is_ok());
        let e = crate::PubkySocialObject::from_uri(&uri, &blob).unwrap_err();
        assert!(
            e.contains(
                "Validation Error: parent must not reference a private object of another user: "
            ),
            "{e}"
        );
        // the author's own private reference ingests
        let mine = p("/priv/social/v1/posts/0032SSN7Q4EVG");
        let mut draft = post(PubkySocialPostKind::Note, Some(&mine), None, vec![]);
        draft.content = "re".into();
        let blob = serde_json::to_vec(&draft).unwrap();
        assert!(crate::PubkySocialObject::from_uri(&uri, &blob).is_ok());
    }

    #[test]
    fn test_collection_cover_is_a_media_reference_position() {
        let id = PubkySocialPost::default().create_id();
        let mine = p("/priv/social/v1/files/PZBQ010FF079VVZPQG1RNFN6DR.png");
        let content = format!(r#"{{"name":"n","items":[],"cover_image":"{mine}"}}"#);
        let collection =
            PubkySocialPost::new(content, PubkySocialPostKind::Collection, None, None, vec![]);
        assert!(collection
            .validate(Some(&id), &ValidationCtx { root: Root::Priv })
            .is_ok());
        let e = collection.validate(Some(&id), &PUB_CTX).unwrap_err();
        assert!(
            e.contains("Validation Error: cover_image must not reference a private object: "),
            "{e}"
        );
        let other = "8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo";
        let theirs = format!("pubky://{other}/priv/social/v1/files/PZBQ010FF079VVZPQG1RNFN6DR.png");
        let content = format!(r#"{{"name":"n","items":[],"cover_image":"{theirs}"}}"#);
        let collection =
            PubkySocialPost::new(content, PubkySocialPostKind::Collection, None, None, vec![]);
        let e = collection
            .create_version(Root::Priv, &owner(), None)
            .unwrap_err();
        assert!(
            e.contains("Validation Error: cover_image must not reference a private object of another user: "),
            "{e}"
        );
    }

    #[test]
    fn test_lock_is_a_canonical_pubky_uri() {
        let lock = p("/pub/app.locks/0032SSN7Q4EVG.json");
        let post = PubkySocialPost::new_with_lock(
            "Visible preview".into(),
            PubkySocialPostKind::Note,
            None,
            None,
            vec![],
            Some(lock.clone()),
        );
        assert_eq!(post.lock.as_deref(), Some(lock.as_str()));
        assert!(validate(&post).is_ok());

        for bad in [
            "https://locks.example/0032SSN7Q4EVG".to_string(),
            "pubky:lock-id".to_string(),
            String::new(),
            "   ".to_string(),
            p(&format!(
                "/pub/{}",
                "a".repeat(VALIDATION_LIMITS.reference_uri_max_length)
            )),
        ] {
            let post = PubkySocialPost::new_with_lock(
                "Visible preview".into(),
                PubkySocialPostKind::Note,
                None,
                None,
                vec![],
                Some(bad.clone()),
            );
            assert!(err(&post).contains("lock"), "{bad}");
        }
    }

    #[test]
    fn test_missing_lock_deserializes_unlocked() {
        let post_json =
            r#"{"content":"hello","kind":"note","parent":null,"embed":null,"attachments":[]}"#;
        let post: PubkySocialPost = serde_json::from_str(post_json).unwrap();
        assert!(post.lock.is_none());
        let out = serde_json::to_string(&post).unwrap();
        assert!(!out.contains("lock"));
    }

    #[test]
    fn test_collection_post_lock_rule_applies() {
        let content = r#"{"name":"Favorites","items":[]}"#.to_string();
        let ok = PubkySocialPost::new_with_lock(
            content.clone(),
            PubkySocialPostKind::Collection,
            None,
            None,
            vec![],
            Some(p("/pub/app.locks/0032SSN7Q4EVG.json")),
        );
        assert!(validate(&ok).is_ok());
        let bad = PubkySocialPost::new_with_lock(
            content,
            PubkySocialPostKind::Collection,
            None,
            None,
            vec![],
            Some("https://locks.example/x".into()),
        );
        assert!(err(&bad).contains("lock"));
    }

    // ---- attachments ----

    #[test]
    fn test_attachments_absent_reads_empty_and_null_is_invalid() {
        let post: PubkySocialPost =
            serde_json::from_str(r#"{"content":"hello","kind":"note","parent":null,"embed":null}"#)
                .unwrap();
        assert!(post.attachments.is_empty());
        let null = serde_json::from_str::<PubkySocialPost>(
            r#"{"content":"hello","kind":"note","parent":null,"embed":null,"attachments":null}"#,
        );
        assert!(null.is_err());
    }

    #[test]
    fn test_attachments_serialize_as_objects() {
        let post = PubkySocialPost::new(
            "".into(),
            PubkySocialPostKind::Image,
            None,
            None,
            vec![PubkySocialAttachment::new(
                file_uri(),
                Some("a cat".into()),
                Some("cat.jpg".into()),
            )],
        );
        assert!(validate(&post).is_ok());
        let out: serde_json::Value = serde_json::to_value(&post).unwrap();
        assert_eq!(out["attachments"][0]["uri"], file_uri());
        assert_eq!(out["attachments"][0]["alt"], "a cat");
        assert_eq!(out["attachments"][0]["name"], "cat.jpg");
        let bare: serde_json::Value = serde_json::to_value(att(&file_uri())).unwrap();
        assert_eq!(bare.as_object().unwrap().len(), 1, "{bare}");
    }

    #[test]
    fn test_attachments_count_cap() {
        let max = VALIDATION_LIMITS.post_attachments_max_count;
        let many = |n: usize| {
            PubkySocialPost::new(
                "".into(),
                PubkySocialPostKind::Image,
                None,
                None,
                (0..n).map(|_| att(&file_uri())).collect(),
            )
        };
        assert!(validate(&many(max)).is_ok());
        assert!(err(&many(max + 1)).contains("Too many attachments"));
    }

    #[test]
    fn test_attachment_uri_rule() {
        let image = |uri: &str| post(PubkySocialPostKind::Image, None, None, vec![att(uri)]);
        for ok in [file_uri(), "https://example.com/cat.jpg".to_string()] {
            assert!(validate(&image(&ok)).is_ok(), "{ok}");
        }
        let max = VALIDATION_LIMITS.reference_uri_max_length;
        let long_ok = p(&format!(
            "/pub/{}",
            "a".repeat(max - code_point_len(&p("/pub/")))
        ));
        assert_eq!(code_point_len(&long_ok), max);
        assert!(validate(&image(&long_ok)).is_ok());

        for bad in [
            "ipfs://bafy".to_string(),
            format!("pubky{PK}/pub/social/v1/files/PZBQ010FF079VVZPQG1RNFN6DR.png"),
            format!("{long_ok}a"),
            "not a url".to_string(),
            String::new(),
        ] {
            assert!(err(&image(&bad)).contains("attachments[0].uri"), "{bad}");
        }
    }

    #[test]
    fn test_attachment_alt_and_name_caps() {
        let with = |alt: Option<String>, name: Option<String>| {
            PubkySocialPost::new(
                "".into(),
                PubkySocialPostKind::Image,
                None,
                None,
                vec![PubkySocialAttachment::new(file_uri(), alt, name)],
            )
        };
        let alt_max = VALIDATION_LIMITS.attachment_alt_max_length;
        assert!(validate(&with(Some("\u{1F600}".repeat(alt_max)), None)).is_ok());
        assert!(err(&with(Some("a".repeat(alt_max + 1)), None)).contains("alt"));

        let name_max = VALIDATION_LIMITS.attachment_name_max_length;
        assert!(validate(&with(None, Some("\u{1F600}".repeat(name_max)))).is_ok());
        assert!(err(&with(None, Some("a".repeat(name_max + 1)))).contains("name"));
        assert!(err(&with(None, Some("".into()))).contains("name"));
        assert!(err(&with(None, Some("   ".into()))).contains("name"));
    }

    #[test]
    fn test_attachment_unknown_members_survive() {
        let a: PubkySocialAttachment =
            serde_json::from_str(&format!(r#"{{"uri":"{}","focus":"center"}}"#, file_uri()))
                .unwrap();
        let out: serde_json::Value = serde_json::to_value(&a).unwrap();
        assert_eq!(out["focus"], "center");
    }

    // ---- at least one of ----

    #[test]
    fn test_empty_post_rejected() {
        assert!(err(&note("")).contains("must have content"));
        assert!(err(&note("   \u{3000}")).contains("must have content"));
    }

    #[test]
    fn test_embed_or_attachment_alone_is_enough() {
        let embed_only = PubkySocialPost::new(
            "".into(),
            PubkySocialPostKind::Note,
            None,
            Some(post_uri()),
            vec![],
        );
        assert!(validate(&embed_only).is_ok());
        let attachment_only = PubkySocialPost::new(
            "".into(),
            PubkySocialPostKind::Image,
            None,
            None,
            vec![att(&file_uri())],
        );
        assert!(validate(&attachment_only).is_ok());
    }

    #[test]
    fn test_namespace_must_be_one_canonical_segment() {
        let post = note("hi");
        for bad in ["", ".", "foo/bar"] {
            let e = post
                .create_version_under(bad, Root::Pub, &owner(), None)
                .unwrap_err();
            assert_eq!(
                e,
                format!("Validation Error: namespace must be one path segment: {bad}")
            );
            let e = post
                .edit_version_under(bad, TS, TS, Root::Pub, &owner(), None)
                .unwrap_err();
            assert_eq!(
                e,
                format!("Validation Error: namespace must be one path segment: {bad}")
            );
        }
        let reserved = format!(
            "Validation Error: the social namespace is reserved for the social post kind: {SOCIAL_NAMESPACE}"
        );
        let e = post
            .create_version_under("social", Root::Pub, &owner(), None)
            .unwrap_err();
        assert_eq!(e, reserved);
        let e = post
            .edit_version_under("social", TS, TS, Root::Pub, &owner(), None)
            .unwrap_err();
        assert_eq!(e, reserved);
        let minted = post
            .create_version_under("mapky", Root::Pub, &owner(), None)
            .unwrap();
        assert_eq!(
            minted.path,
            format!("/pub/mapky/v1/posts/{}/{}.json", minted.id, minted.id)
        );
    }

    /// A kind set outside this crate: the envelope mechanics, the reference gate and the
    /// ownership rule included, come for free.
    #[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
    #[serde(rename_all = "lowercase")]
    enum ReviewKind {
        #[default]
        Review,
        #[serde(other)]
        Unknown,
    }

    impl PostKind for ReviewKind {
        fn is_known(&self) -> bool {
            !matches!(self, ReviewKind::Unknown)
        }

        fn validate_content(
            &self,
            post: &PostEnvelope<Self>,
            _ctx: &ValidationCtx,
        ) -> Result<(), String> {
            if post.content.is_empty() {
                return Err("Validation Error: a review needs text".into());
            }
            Ok(())
        }
    }

    #[test]
    fn test_a_foreign_kind_rides_the_envelope() {
        let other = "8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo";
        let mut review: PostEnvelope<ReviewKind> = PostEnvelope::new(
            "five stars".into(),
            ReviewKind::Review,
            Some(format!("pubky://{other}/priv/social/v1/posts/{TS}")),
            None,
            vec![],
        );
        let priv_ctx = ValidationCtx { root: Root::Priv };
        // Plain validation has no author, so the private parent passes under the private root
        assert!(review.validate(None, &priv_ctx).is_ok());
        // With the author in scope the ownership rule refuses another user's private object
        let e = review
            .check_references(&priv_ctx, Some(&owner()))
            .unwrap_err();
        assert!(
            e.contains(
                "Validation Error: parent must not reference a private object of another user: "
            ),
            "{e}"
        );
        let e = review
            .create_version_under("reviews", Root::Priv, &owner(), None)
            .unwrap_err();
        assert!(e.contains("of another user"), "{e}");
        review.parent = None;
        let minted = review
            .create_version_under("reviews", Root::Priv, &owner(), None)
            .unwrap();
        assert!(minted.path.starts_with("/priv/reviews/v1/posts/"));
        review.content.clear();
        assert_eq!(
            review.validate(None, &priv_ctx).unwrap_err(),
            "Validation Error: a review needs text"
        );
        // The wire shape is the envelope's, whatever the kind
        let parsed: PostEnvelope<ReviewKind> =
            serde_json::from_str(r#"{"content":"x","kind":"rant","attachments":[]}"#).unwrap();
        assert_eq!(parsed.kind, ReviewKind::Unknown);
        assert!(parsed.validate(None, &PUB_CTX).is_err());
    }
}
