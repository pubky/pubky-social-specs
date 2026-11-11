use crate::constants::social_path;
use crate::traits::{Root, ValidationCtx, ValidationError};
use crate::{
    common::{
        ascii_fold, check_extra, code_point_len, frozen_trim, timestamp, validate_hash_id_format,
        validate_safe_json_int,
    },
    limits::VALIDATION_LIMITS,
    models::tag::{sanitize_tag_label, validate_tag_label},
    traits::{HasIdPath, HashId, Validatable},
    PubkySocialPostKind,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::str::FromStr;

#[cfg(feature = "openapi")]
use utoipa::ToSchema;

/// Enum representing the reach of the feed.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(from = "String", into = "String")]
#[non_exhaustive]
pub enum PubkySocialFeedReach {
    Following,
    Followers,
    Friends,
    All,
    Wot,
    Me,
    Unknown(String),
}

wire_names!(PubkySocialFeedReach {
    Following => "following",
    Followers => "followers",
    Friends => "friends",
    All => "all",
    Wot => "wot",
    Me => "me",
});

/// Enum representing the layout of the feed.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(from = "String", into = "String")]
#[non_exhaustive]
pub enum PubkySocialFeedLayout {
    Columns,
    Wide,
    Visual,
    List,
    Cards,
    Unknown(String),
}

wire_names!(PubkySocialFeedLayout {
    Columns => "columns",
    Wide => "wide",
    Visual => "visual",
    List => "list",
    Cards => "cards",
});

/// Enum representing the sort order of the feed.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(from = "String", into = "String")]
#[non_exhaustive]
pub enum PubkySocialFeedSort {
    Recent,
    Popularity,
    Unknown(String),
}

wire_names!(PubkySocialFeedSort {
    Recent => "recent",
    Popularity => "popularity",
});

/// What a feed lists. `Posts` is the default and is stored as no member at all, so every feed
/// written before the member existed keeps its bytes and its id. `Resources` lists the external
/// links people tag, which are no posts: such a feed has no post kind (its `content` lists
/// schema.org types) and no domain filter.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(from = "String", into = "String")]
#[non_exhaustive]
pub enum PubkySocialFeedTarget {
    Posts,
    Resources,
    Unknown(String),
}

wire_names!(PubkySocialFeedTarget {
    Posts => "posts",
    Resources => "resources",
});

/// Whether `name` is spelled as a schema.org type name: an ASCII capital letter or digit, then
/// ASCII letters and digits (`MusicRecording`, `Restaurant`, `3DModel`). Only the spelling is
/// checked: which types exist, and which are subtypes of which, is the index's business, so a
/// type schema.org adds later is still a name.
fn is_resource_type_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
        && chars.all(|c| c.is_ascii_alphanumeric())
}

/// A resources feed's `content` from a caller's list: schema.org type names separated by
/// commas, with no spaces. The builder writes them deduplicated and sorted by code point, so one
/// set of types is one feed with one id. A name that is not spelled as a type name or is longer
/// than `feed_resource_type_max_length`, or more than `feed_resource_types_max_count` types, is
/// refused. It comes back as the `content` a feed stores, which holds a post kind on a post feed,
/// so as [`PubkySocialPostKind`]'s open variant.
pub fn feed_resource_types(list: &str) -> Result<PubkySocialPostKind, String> {
    let mut types = BTreeSet::new();
    for name in list.split(',') {
        if code_point_len(name) > VALIDATION_LIMITS.feed_resource_type_max_length {
            return Err(resource_type_too_long());
        }
        if !is_resource_type_name(name) {
            return Err(format!("Validation Error: Invalid resource type: {name}"));
        }
        types.insert(name);
    }
    if types.len() > VALIDATION_LIMITS.feed_resource_types_max_count {
        return Err(format!(
            "Validation Error: A resources feed cannot list more than {} types",
            VALIDATION_LIMITS.feed_resource_types_max_count
        ));
    }
    Ok(PubkySocialPostKind::from(
        types.into_iter().collect::<Vec<_>>().join(","),
    ))
}

/// The refusal of a name past `feed_resource_type_max_length`; it does not quote the name, which
/// can be as long as the object.
fn resource_type_too_long() -> String {
    format!(
        "Validation Error: Feed resource type names cannot be longer than {} characters",
        VALIDATION_LIMITS.feed_resource_type_max_length
    )
}

/// A stored type list must be what [`feed_resource_types`] writes: every name spelled as a
/// schema.org type name within the length cap, within the count cap, and strictly increasing,
/// which is deduplicated and sorted in one check. Anything else is refused rather than repaired,
/// so one set of types keeps one id.
fn validate_resource_types(content: &str) -> Result<(), String> {
    let types: Vec<&str> = content.split(',').collect();
    for name in &types {
        if code_point_len(name) > VALIDATION_LIMITS.feed_resource_type_max_length {
            return Err(resource_type_too_long());
        }
        if !is_resource_type_name(name) {
            return Err(format!(
                "Validation Error: Feed resource type '{name}' is not a schema.org type name"
            ));
        }
    }
    if types.len() > VALIDATION_LIMITS.feed_resource_types_max_count {
        return Err(format!(
            "Validation Error: A resources feed cannot list more than {} types",
            VALIDATION_LIMITS.feed_resource_types_max_count
        ));
    }
    if !types.windows(2).all(|w| w[0] < w[1]) {
        return Err(
            "Validation Error: Feed resource types must be stored deduplicated and sorted by code point"
                .into(),
        );
    }
    Ok(())
}

/// Configuration object for the feed. The whole of a feed's identity: two feeds with the
/// same config are the same feed, whatever they are named.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[cfg_attr(feature = "openapi", derive(ToSchema))]
pub struct PubkySocialFeedConfig {
    /// Canonical as stored: folded labels, deduplicated, sorted by code point, never empty.
    /// `None` is "no tag filter".
    pub tags: Option<Vec<String>>,
    /// A domain filter, same rules as `tags`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain_tags: Option<Vec<String>>,
    pub reach: PubkySocialFeedReach,
    pub layout: PubkySocialFeedLayout,
    pub sort: PubkySocialFeedSort,
    /// The one post kind a post feed shows, or a newer writer's name kept as written; on a
    /// resources feed its schema.org types, comma-separated and sorted (`MusicAlbum,MusicRecording`,
    /// see [`feed_resource_types`]). `None` for every kind.
    pub content: Option<PubkySocialPostKind>,
    /// What the feed lists; `None` is posts. A resources feed's `content` is a list of up to
    /// ten schema.org type names (see [`feed_resource_types`]), or `None` for every type. A
    /// writer stores `None` for posts, see
    /// [`PubkySocialFeedConfig::with_target`]; a stored `"posts"` reads as written and derives the
    /// same id as `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<PubkySocialFeedTarget>,
    /// Unknown members, preserved on rewrite; see the module contract in `models/mod.rs`.
    /// Outside the id input, which reads named fields only.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl PubkySocialFeedConfig {
    /// The one builder. It canonicalizes both tag lists, so one filter has one spelling and
    /// one id, then validates them, so a caller can never hold a config whose id string would
    /// be ambiguous. `None` is "no filter"; a blank label or an empty list is an error.
    pub fn new(
        tags: Option<Vec<String>>,
        domain_tags: Option<Vec<String>>,
        reach: PubkySocialFeedReach,
        layout: PubkySocialFeedLayout,
        sort: PubkySocialFeedSort,
        content: Option<PubkySocialPostKind>,
    ) -> Result<Self, String> {
        let tags = canonical_filter(tags, "tags")?;
        let domain_tags = canonical_filter(domain_tags, "domain_tags")?;
        validate_tag_list(&tags, "tags")?;
        validate_tag_list(&domain_tags, "domain_tags")?;
        Ok(Self {
            tags,
            domain_tags,
            reach,
            layout,
            sort,
            content,
            target: None,
            extra: Default::default(),
        })
    }

    /// The config listing `target`. Posts, the default, is stored as no member, so the bytes
    /// and the id of a post feed are the ones it had before the member existed. The rules of a
    /// target (a resources feed has no post kind, its `content` lists schema.org types, and no
    /// domain filter) are checked with the
    /// rest of the feed, by [`PubkySocialFeed::derive_id`].
    pub fn with_target(mut self, target: PubkySocialFeedTarget) -> Self {
        self.target = (target != PubkySocialFeedTarget::Posts).then_some(target);
        self
    }

    /// The schema.org types a resources feed lists, read from the `content` of a decoded or built
    /// feed (one that passed validation); `None` for every type and for a post feed. A resource is
    /// listed when its type is one of these or a subtype of one, as the index reads it.
    pub fn resource_types(&self) -> Option<Vec<&str>> {
        if self.target != Some(PubkySocialFeedTarget::Resources) {
            return None;
        }
        self.content
            .as_ref()
            .map(|c| c.wire_name().split(',').collect())
    }
}

/// Folds every label, deduplicates and sorts by code point (`str` order is UTF-8 byte order is
/// code point order). Builders call this; a stored list is already its own fixed point, so the
/// id input joins it verbatim.
fn canonical_tag_list(tags: Vec<String>) -> Vec<String> {
    tags.into_iter()
        .map(|tag| sanitize_tag_label(&tag))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

/// A caller's list in canonical form, or the reason it is not a filter at all. A blank label
/// and an empty list are typos, and dropping either silently would write a feed the caller did
/// not ask for: one with no filter, under a different id. `None` is how a caller says that.
fn canonical_filter(tags: Option<Vec<String>>, field: &str) -> Result<Option<Vec<String>>, String> {
    let Some(tags) = tags else {
        return Ok(None);
    };
    if tags.is_empty() {
        return Err(format!(
            "Validation Error: {field} must not be an empty list; leave it out for no filter"
        ));
    }
    if tags.iter().any(|tag| sanitize_tag_label(tag).is_empty()) {
        return Err(format!(
            "Validation Error: {field} must not contain a blank label"
        ));
    }
    Ok(Some(canonical_tag_list(tags)))
}

/// Only the shape of the name is validated, not whether the icon exists: the icon set is
/// curated by the client. The charset check is also the fixed-point check, since a folded
/// icon is exactly one that is 1 to 50 characters of `[a-z0-9-]`.
///
/// `None` is accepted for feeds created before the field existed; new feeds always carry
/// one, since [`PubkySocialFeed::new`] requires it.
fn validate_feed_icon(icon: &Option<String>) -> Result<(), String> {
    let Some(icon) = icon else {
        return Ok(());
    };

    let icon_len = code_point_len(icon);
    if !(1..=VALIDATION_LIMITS.feed_icon_max_length).contains(&icon_len) {
        return Err(format!(
            "Validation Error: Feed icon '{}' must be 1 to {} characters",
            icon, VALIDATION_LIMITS.feed_icon_max_length
        ));
    }

    if let Some(c) = icon
        .chars()
        .find(|c| !c.is_ascii_lowercase() && !c.is_ascii_digit() && *c != '-')
    {
        return Err(format!(
            "Validation Error: Feed icon '{}' contains invalid character: {}",
            icon, c
        ));
    }

    Ok(())
}

/// A stored list must be exactly what the builder would have written: non-empty, within the
/// count cap, every label its own fold, and strictly increasing, which is deduplicated and
/// sorted in one check. Ingest rejects anything else instead of repairing it, so one filter
/// keeps one id and a reader never disagrees with the bytes.
fn validate_tag_list(tags: &Option<Vec<String>>, field_name: &str) -> Result<(), String> {
    let Some(tags) = tags else {
        return Ok(());
    };

    if tags.is_empty() {
        return Err(format!(
            "Validation Error: Feed config {field_name} cannot be an empty list, omit it for no filter"
        ));
    }

    if tags.len() > VALIDATION_LIMITS.feed_tags_max_count {
        return Err(format!(
            "Validation Error: Feed config cannot have more than {} {}",
            VALIDATION_LIMITS.feed_tags_max_count, field_name
        ));
    }

    for tag in tags {
        if *tag != sanitize_tag_label(tag) {
            return Err(format!(
                "Validation Error: Tag '{tag}' must be stored folded (trimmed, ASCII lowercase)"
            ));
        }
        validate_tag_label(tag)?;
    }

    if !tags.windows(2).all(|w| w[0] < w[1]) {
        return Err(format!(
            "Validation Error: Feed config {field_name} must be stored deduplicated and sorted by code point"
        ));
    }

    Ok(())
}

impl Validatable for PubkySocialFeedConfig {
    fn validate_fields(
        &self,
        _id: Option<&str>,
        _ctx: &ValidationCtx,
    ) -> Result<(), ValidationError> {
        // reach, layout, sort and target define the feed, so an unknown value rejects it.
        // An unknown content filter only degrades to "no filter", so it passes.
        if !self.reach.is_known() {
            return Err("Validation Error: feed reach is unknown".into());
        }
        if !self.layout.is_known() {
            return Err("Validation Error: feed layout is unknown".into());
        }
        if !self.sort.is_known() {
            return Err("Validation Error: feed sort is unknown".into());
        }
        if self.target.as_ref().is_some_and(|t| !t.is_known()) {
            return Err("Validation Error: feed target is unknown".into());
        }
        check_extra(
            &self.extra,
            &[
                "tags",
                "domain_tags",
                "reach",
                "layout",
                "sort",
                "content",
                "target",
            ],
        )?;
        validate_tag_list(&self.tags, "tags")?;
        validate_tag_list(&self.domain_tags, "domain_tags")?;
        // An external resource has a schema.org type, not a post kind, and its links carry no
        // domain tags
        if self.target == Some(PubkySocialFeedTarget::Resources) {
            if let Some(content) = &self.content {
                validate_resource_types(content.wire_name())?;
            }
            if self.domain_tags.is_some() {
                return Err(
                    "Validation Error: A resources feed cannot filter by domain_tags".into(),
                );
            }
        }

        Ok(())
    }
}

/// Represents a feed configuration.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[cfg_attr(feature = "openapi", derive(ToSchema))]
pub struct PubkySocialFeed {
    pub feed: PubkySocialFeedConfig,
    pub name: String,
    /// Lucide icon name, e.g. `"bitcoin"`. Required on new feeds, but optional
    /// on the wire: feeds created before this field existed have none, and
    /// clients render their default icon for those. Not part of the `feed_id`,
    /// so the icon can change without recreating the feed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    pub created_at: i64,
    /// Unknown members, preserved on rewrite; see the module contract in `models/mod.rs`.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl PubkySocialFeed {
    /// Trims the name and folds the icon, the two canonicalizations a writer owes. Ingest
    /// never repeats them, so an SDK round trip cannot change the stored bytes. Pass a config
    /// built by [`PubkySocialFeedConfig::new`], which canonicalizes the tag lists.
    pub fn new(feed: PubkySocialFeedConfig, name: String, icon: String) -> Self {
        let created_at = timestamp();
        Self {
            feed,
            name: frozen_trim(&name).to_string(),
            icon: Some(ascii_fold(frozen_trim(&icon))),
            created_at,
            extra: Default::default(),
        }
    }

    /// The id of the config, for a writer. Only a valid config has one: a config the rules
    /// reject can render a string another config also renders (`tags: Some([])` and
    /// `tags: None` are the same six segments). A content kind this version does not know
    /// renders with the spelling it was read with, so it derives the writer's id.
    pub fn derive_id(&self) -> Result<String, String> {
        self.validate(None, &ValidationCtx { root: Self::ROOT })?;
        Ok(self.create_id())
    }

    /// "/{root}/social/v1/feeds/{id}.json". Feeds are private by default; the public
    /// spelling is the published copy.
    pub fn create_path_in(root: Root, id: &str) -> String {
        social_path(root, &format!("{}{id}.json", Self::PATH_SEGMENT))
    }
}

/// Both addresses of one feed.
///
/// A feed lives at `private`. To PUBLISH it, PUT the same bytes at `public`; to unpublish,
/// DELETE `public`. Nothing else is involved: a feed config carries no root-bearing URIs, so
/// publishing is a plain byte copy, and because the id is derived from the config alone the
/// two copies can never disagree about what the feed filters.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct FeedPaths {
    /// Where the builder writes.
    pub private: String,
    /// The published copy, absent until the user publishes.
    pub public: String,
}

/// The private and published addresses of the feed with this id, see [`FeedPaths`].
pub fn feed_paths(id: &str) -> FeedPaths {
    FeedPaths {
        private: PubkySocialFeed::create_path_in(Root::Priv, id),
        public: PubkySocialFeed::create_path_in(Root::Pub, id),
    }
}

fn checked_feed_paths(id: &str) -> Result<FeedPaths, String> {
    validate_hash_id_format(id)?;
    Ok(feed_paths(id))
}

/// Publish: PUT the bytes read from the first path at the second. A feed config carries no
/// root-bearing URIs, so nothing inside the file changes and there is nothing to rewrite.
/// Always copy, never skip an existing public copy: the name, the icon and unknown members
/// sit outside the id, so the same path can hold stale bytes, and a copy of identical bytes
/// is a harmless overwrite.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeedPublishPlan {
    /// `(private path, public path)`.
    pub copy: (String, String),
}

/// Unpublish: the public copy goes, the feed stays where its owner reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeedUnpublishPlan {
    pub delete: String,
}

/// Delete: both copies, public first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeedDeletePlan {
    pub deletes: Vec<String>,
}

/// Plans a publish of the feed with this id. Pure: the caller does the GET and the PUT.
pub fn plan_feed_publish(id: &str) -> Result<FeedPublishPlan, String> {
    let paths = checked_feed_paths(id)?;
    Ok(FeedPublishPlan {
        copy: (paths.private, paths.public),
    })
}

/// Plans an unpublish of the feed with this id.
pub fn plan_feed_unpublish(id: &str) -> Result<FeedUnpublishPlan, String> {
    Ok(FeedUnpublishPlan {
        delete: checked_feed_paths(id)?.public,
    })
}

/// Plans a delete of the feed with this id, in order. The public copy goes first so the feed
/// stops being world-readable before the one its owner reads disappears. A path that is not
/// there is a skip for the caller, never an error.
pub fn plan_feed_delete(id: &str) -> Result<FeedDeletePlan, String> {
    let paths = checked_feed_paths(id)?;
    Ok(FeedDeletePlan {
        deletes: vec![paths.public, paths.private],
    })
}

impl HashId for PubkySocialFeed {
    /// "{reach}:{layout}:{sort}:{content or ''}:{tags or ''}:{domain_tags or ''}", frozen wire
    /// names, each list joined with ',' exactly as stored (canonical: folded, deduplicated,
    /// sorted by code point). Injective because ':' and ',' are both in `tag_invalid_chars`,
    /// the segment count is fixed, and the empty string is the one spelling no wire name and
    /// no stored list can produce, a stored list being non-empty. The sentinel cannot be a
    /// printable token: '-' would collide with the legal label `["-"]`. `name`, `icon`,
    /// `created_at` and `extra` stay outside: a feed is what it filters, not how it looks.
    ///
    /// A target other than posts goes in front, "{target}:" and then the six segments, so a
    /// post feed, whose target is stored as no member, keeps the id it had before the member
    /// existed. A prefix, never a suffix: every older id input starts with a reach, a valid
    /// feed's reach is a known one and no reach is a target's name, while the last segment ends
    /// in a domain label anyone can choose (`content: ":music"` with `domain_tags: ["resources"]`
    /// would spell a suffix).
    ///
    /// Writers go through [`PubkySocialFeed::derive_id`], which validates the config first. A
    /// name this version does not know is spelled as it was read, so it derives the writer's id.
    fn get_id_data(&self) -> String {
        let list =
            |l: &Option<Vec<String>>| l.as_ref().map_or_else(String::new, |list| list.join(","));
        let target = match &self.feed.target {
            None | Some(PubkySocialFeedTarget::Posts) => String::new(),
            Some(target) => format!("{}:", target.wire_name()),
        };
        format!(
            "{target}{}:{}:{}:{}:{}:{}",
            self.feed.reach.wire_name(),
            self.feed.layout.wire_name(),
            self.feed.sort.wire_name(),
            self.feed.content.as_ref().map_or("", |c| c.wire_name()),
            list(&self.feed.tags),
            list(&self.feed.domain_tags),
        )
    }
}

impl HasIdPath for PubkySocialFeed {
    const ROOT: Root = Root::Priv;
    const PATH_SEGMENT: &'static str = "feeds/";

    fn create_path(id: &str) -> String {
        Self::create_path_in(Self::ROOT, id)
    }
}

impl Validatable for PubkySocialFeed {
    fn validate_fields(
        &self,
        id: Option<&str>,
        ctx: &ValidationCtx,
    ) -> Result<(), ValidationError> {
        // Config first, so an unrecognized value is reported as such and not as an id mismatch
        // The filter has no cap of its own: the object's holds it, as stored on a read
        self.feed.validate_fields(None, ctx)?;
        check_extra(&self.extra, &["feed", "name", "icon", "created_at"])?;

        if frozen_trim(&self.name).is_empty() {
            return Err("Validation Error: Feed name cannot be empty".into());
        }
        if code_point_len(&self.name) > VALIDATION_LIMITS.feed_name_max_length {
            return Err(format!(
                "Validation Error: Feed name exceeds maximum length of {} characters",
                VALIDATION_LIMITS.feed_name_max_length
            ));
        }

        validate_feed_icon(&self.icon)?;
        validate_safe_json_int(self.created_at)?;

        if let Some(id) = id {
            validate_hash_id_format(id)?;
            self.validate_id(id)?;
        }

        Ok(())
    }
}

impl FromStr for PubkySocialFeedReach {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "following" => Ok(PubkySocialFeedReach::Following),
            "followers" => Ok(PubkySocialFeedReach::Followers),
            "friends" => Ok(PubkySocialFeedReach::Friends),
            "all" => Ok(PubkySocialFeedReach::All),
            "wot" => Ok(PubkySocialFeedReach::Wot),
            "me" => Ok(PubkySocialFeedReach::Me),
            _ => Err(format!("Validation Error: Invalid feed reach: {}", s)),
        }
    }
}

impl FromStr for PubkySocialFeedLayout {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "columns" => Ok(PubkySocialFeedLayout::Columns),
            "wide" => Ok(PubkySocialFeedLayout::Wide),
            "visual" => Ok(PubkySocialFeedLayout::Visual),
            "list" => Ok(PubkySocialFeedLayout::List),
            "cards" => Ok(PubkySocialFeedLayout::Cards),
            _ => Err(format!("Validation Error: Invalid feed layout: {}", s)),
        }
    }
}

impl FromStr for PubkySocialFeedSort {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "recent" => Ok(PubkySocialFeedSort::Recent),
            "popularity" => Ok(PubkySocialFeedSort::Popularity),
            _ => Err(format!("Validation Error: Invalid feed sort: {}", s)),
        }
    }
}

impl FromStr for PubkySocialFeedTarget {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "posts" => Ok(PubkySocialFeedTarget::Posts),
            "resources" => Ok(PubkySocialFeedTarget::Resources),
            _ => Err(format!("Validation Error: Invalid feed target: {}", s)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::traits::PUB_CTX;
    use crate::{limits::VALIDATION_LIMITS, traits::Validatable};

    const PRIV_CTX: ValidationCtx = ValidationCtx { root: Root::Priv };
    const PK: &str = "operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo";

    use PubkySocialFeedLayout as L;
    use PubkySocialFeedReach as R;
    use PubkySocialFeedSort as S;

    /// A config exactly as stored, bypassing the canonicalizing builder.
    fn stored(
        tags: Option<Vec<&str>>,
        domain_tags: Option<Vec<&str>>,
        reach: R,
        layout: L,
        sort: S,
        content: Option<PubkySocialPostKind>,
    ) -> PubkySocialFeedConfig {
        let own = |l: Option<Vec<&str>>| l.map(|l| l.into_iter().map(String::from).collect());
        PubkySocialFeedConfig {
            tags: own(tags),
            domain_tags: own(domain_tags),
            reach,
            layout,
            sort,
            content,
            target: None,
            extra: Default::default(),
        }
    }

    fn feed(config: PubkySocialFeedConfig) -> PubkySocialFeed {
        PubkySocialFeed::new(config, "Test Feed".into(), "rss".into())
    }

    fn validate(f: &PubkySocialFeed) -> Result<(), String> {
        f.validate(Some(&f.create_id()), &PRIV_CTX)
    }

    #[test]
    fn test_id_input_is_the_pinned_string() {
        // Six fixed segments, wire names, the stored lists joined verbatim
        let legacy = feed(stored(None, None, R::All, L::List, S::Popularity, None));
        assert_eq!(legacy.get_id_data(), "all:list:popularity:::");
        // blake3("all:list:popularity:::")[..16] in Crockford
        assert_eq!(legacy.create_id(), "H91HYJTYNCGYA2EP13ZQTRVD5G");

        let fixture = feed(stored(
            Some(vec!["rust"]),
            Some(vec!["dev"]),
            R::Wot,
            L::Columns,
            S::Recent,
            Some(PubkySocialPostKind::Note),
        ));
        assert_eq!(fixture.get_id_data(), "wot:columns:recent:note:rust:dev");
        // blake3("wot:columns:recent:note:rust:dev")[..16] in Crockford
        assert_eq!(fixture.create_id(), "2CPRX2C4D6FNNS9ZRM50X99288");

        // The builder sorts, so the two spellings of one filter are one feed
        let two = feed(
            PubkySocialFeedConfig::new(
                Some(vec!["b".into(), "a".into()]),
                None,
                R::All,
                L::Columns,
                S::Recent,
                None,
            )
            .unwrap(),
        );
        assert_eq!(two.get_id_data(), "all:columns:recent::a,b:");
        // blake3("all:columns:recent::a,b:")[..16] in Crockford
        assert_eq!(two.create_id(), "7ERKY70ARABKV1SMSASC9Z4YWC");

        // The sentinel has to be unspellable: '-' is a legal label, so a printable one would
        // make the filter ["-"] and "no filter" the same feed.
        let dash = feed(stored(
            Some(vec!["-"]),
            None,
            R::All,
            L::List,
            S::Popularity,
            None,
        ));
        assert_eq!(dash.get_id_data(), "all:list:popularity::-:");
        // blake3("all:list:popularity::-:")[..16] in Crockford
        assert_eq!(dash.create_id(), "DM0YXJ4P6V85Y4BTGHF8Q3PW20");
        assert_ne!(dash.create_id(), legacy.create_id());
        assert!(validate(&dash).is_ok());
    }

    #[test]
    fn test_id_covers_the_config_and_nothing_else() {
        let config = || {
            PubkySocialFeedConfig::new(
                Some(vec!["rust".into()]),
                None,
                R::All,
                L::Columns,
                S::Recent,
                None,
            )
            .unwrap()
        };
        let plain = feed(config());
        let mut dressed = PubkySocialFeed::new(config(), "Another Name".into(), "bitcoin".into());
        dressed.created_at = 1_700_000_000_000_000;
        dressed.extra.insert("ext".into(), 1.into());
        assert_eq!(plain.create_id(), dressed.create_id());

        // every segment moves the id
        let base = plain.create_id();
        for edited in [
            PubkySocialFeedConfig::new(
                Some(vec!["rust".into()]),
                None,
                R::Following,
                L::Columns,
                S::Recent,
                None,
            )
            .unwrap(),
            PubkySocialFeedConfig::new(
                Some(vec!["rust".into()]),
                None,
                R::All,
                L::List,
                S::Recent,
                None,
            )
            .unwrap(),
            PubkySocialFeedConfig::new(
                Some(vec!["rust".into()]),
                None,
                R::All,
                L::Columns,
                S::Popularity,
                None,
            )
            .unwrap(),
            PubkySocialFeedConfig::new(
                Some(vec!["rust".into()]),
                None,
                R::All,
                L::Columns,
                S::Recent,
                Some(PubkySocialPostKind::Note),
            )
            .unwrap(),
            PubkySocialFeedConfig::new(
                Some(vec!["rust".into(), "bitcoin".into()]),
                None,
                R::All,
                L::Columns,
                S::Recent,
                None,
            )
            .unwrap(),
            PubkySocialFeedConfig::new(
                Some(vec!["rust".into()]),
                Some(vec!["dev".into()]),
                R::All,
                L::Columns,
                S::Recent,
                None,
            )
            .unwrap(),
        ] {
            assert_ne!(feed(edited).create_id(), base);
        }
    }

    #[test]
    fn test_builder_sorts_by_code_point_not_utf16_unit() {
        // U+1D51E sorts after U+FB00 by code point; a JS default sort(), which compares
        // UTF-16 units, would put the surrogate pair first and fork the id.
        let config = PubkySocialFeedConfig::new(
            Some(vec!["\u{1D51E}".into(), "\u{FB00}".into()]),
            None,
            R::All,
            L::Columns,
            S::Recent,
            None,
        )
        .unwrap();
        assert_eq!(
            config.tags,
            Some(vec!["\u{FB00}".to_string(), "\u{1D51E}".to_string()])
        );
        assert!(validate(&feed(config)).is_ok());
    }

    #[test]
    fn test_builder_folds_and_dedups() {
        let config = PubkySocialFeedConfig::new(
            Some(vec!["  RUST ".into(), "rust".into(), "Bitcoin".into()]),
            None,
            R::All,
            L::Columns,
            S::Recent,
            None,
        )
        .unwrap();
        assert_eq!(
            config.tags,
            Some(vec!["bitcoin".to_string(), "rust".to_string()])
        );
        assert_eq!(config.domain_tags, None);
        assert!(validate(&feed(config)).is_ok());
    }

    #[test]
    fn test_builder_refuses_a_blank_label_and_an_empty_list() {
        // Dropping either would hand back a feed with no filter, under an id the caller never
        // asked for. None is how a caller says "no filter".
        let build = |tags: Option<Vec<&str>>, domain_tags: Option<Vec<&str>>| {
            let own = |l: Option<Vec<&str>>| l.map(|l| l.into_iter().map(String::from).collect());
            PubkySocialFeedConfig::new(
                own(tags),
                own(domain_tags),
                R::All,
                L::Columns,
                S::Recent,
                None,
            )
        };
        for (list, expected) in [
            (vec![], "must not be an empty list"),
            (vec![" "], "must not contain a blank label"),
            (vec!["\u{3000}"], "must not contain a blank label"),
            (vec!["rust", "  "], "must not contain a blank label"),
        ] {
            let e = build(Some(list.clone()), None).unwrap_err();
            assert!(
                e.starts_with("Validation Error: tags ") && e.contains(expected),
                "{list:?}: {e}"
            );
            let e = build(None, Some(list.clone())).unwrap_err();
            assert!(
                e.starts_with("Validation Error: domain_tags ") && e.contains(expected),
                "{list:?}: {e}"
            );
        }
        // None is not a mistake
        assert!(build(None, None).is_ok());
    }

    #[test]
    fn test_a_stored_list_is_canonical_or_it_is_rejected() {
        // one code point over tag_label_max_length
        const LONG_LABEL: &str = "aaaaaaaaaaaaaaaaaaaaa";
        assert_eq!(LONG_LABEL.len(), VALIDATION_LIMITS.tag_label_max_length + 1);
        for (list, expected) in [
            (Some(vec![]), "cannot be an empty list"),
            (Some(vec!["Rust"]), "stored folded"),
            (Some(vec![" rust"]), "stored folded"),
            (Some(vec!["b", "a"]), "sorted by code point"),
            (Some(vec!["a", "a"]), "sorted by code point"),
            (Some(vec!["a:b"]), "invalid character"),
            (Some(vec!["a,b"]), "invalid character"),
            (Some(vec!["a b"]), "whitespace"),
            (Some(vec![""]), "shorter than minimum length"),
            (Some(vec![LONG_LABEL]), "exceeds maximum length"),
            (
                Some(vec!["t1", "t2", "t3", "t4", "t5", "t6"]),
                "more than 5",
            ),
        ] {
            for field in ["tags", "domain_tags"] {
                let (tags, domain_tags) = match field {
                    "tags" => (list.clone(), None),
                    _ => (None, list.clone()),
                };
                let f = feed(stored(
                    tags,
                    domain_tags,
                    R::All,
                    L::Columns,
                    S::Recent,
                    None,
                ));
                let e = f.validate(Some(&f.create_id()), &PRIV_CTX).unwrap_err();
                assert!(e.contains(expected), "{field} {list:?}: {e}");
            }
        }
        // the cap itself accepts
        let f = feed(stored(
            Some(vec!["t1", "t2", "t3", "t4", "t5"]),
            None,
            R::All,
            L::Columns,
            S::Recent,
            None,
        ));
        assert!(validate(&f).is_ok());
        assert_eq!(VALIDATION_LIMITS.feed_tags_max_count, 5);
    }

    #[test]
    fn test_unknown_enums_and_the_write_side_id() {
        for (config, field) in [
            (
                stored(
                    None,
                    None,
                    R::Unknown("galaxy".into()),
                    L::List,
                    S::Recent,
                    None,
                ),
                "reach",
            ),
            (
                stored(
                    None,
                    None,
                    R::All,
                    L::Unknown("spiral".into()),
                    S::Recent,
                    None,
                ),
                "layout",
            ),
            (
                stored(
                    None,
                    None,
                    R::All,
                    L::List,
                    S::Unknown("random".into()),
                    None,
                ),
                "sort",
            ),
        ] {
            let e = feed(config)
                .validate(Some("8Z8CWH8NVYQY39ZEBFGKQWWEKG"), &PRIV_CTX)
                .unwrap_err();
            assert!(e.contains(field) && e.contains("unknown"), "{e}");
        }
        // An unknown content filter keeps its spelling, so its id is rebuilt and checked
        let f = feed(stored(
            None,
            None,
            R::All,
            L::List,
            S::Recent,
            Some(PubkySocialPostKind::Unknown("podcast".into())),
        ));
        assert!(f.get_id_data().contains(":podcast:"));
        assert!(f.validate(Some(&f.create_id()), &PRIV_CTX).is_ok());
        assert!(f
            .validate(Some("8Z8CWH8NVYQY39ZEBFGKQWWEKG"), &PRIV_CTX)
            .unwrap_err()
            .contains("Invalid ID"));
        // a known content filter is still checked
        let f = feed(stored(
            None,
            None,
            R::All,
            L::List,
            S::Recent,
            Some(PubkySocialPostKind::Note),
        ));
        let e = f
            .validate(Some("8Z8CWH8NVYQY39ZEBFGKQWWEKG"), &PRIV_CTX)
            .unwrap_err();
        assert!(e.contains("Validation Error: Invalid ID"), "{e}");
    }

    #[test]
    fn test_name_is_trimmed_by_the_builder_and_stored_as_written() {
        let max = VALIDATION_LIMITS.feed_name_max_length;
        assert_eq!(max, 100);
        let config =
            || PubkySocialFeedConfig::new(None, None, R::All, L::Columns, S::Recent, None).unwrap();
        let f = PubkySocialFeed::new(config(), "\u{3000}Rust Bitcoiners ".into(), "rss".into());
        assert_eq!(f.name, "Rust Bitcoiners");
        assert!(validate(&f).is_ok());
        // one character is a name
        let f = PubkySocialFeed::new(config(), "x".into(), "rss".into());
        assert!(validate(&f).is_ok());
        // blank is blank however it is spelled
        let f = PubkySocialFeed::new(config(), "   ".into(), "rss".into());
        assert!(validate(&f).unwrap_err().contains("cannot be empty"));
        // the cap counts the stored value
        let f = PubkySocialFeed::new(config(), "\u{1F980}".repeat(max), "rss".into());
        assert_eq!(code_point_len(&f.name), max);
        assert!(validate(&f).is_ok());
        let f = PubkySocialFeed::new(config(), "\u{1F980}".repeat(max + 1), "rss".into());
        let e = validate(&f).unwrap_err();
        assert!(e.contains("exceeds maximum length"), "{e}");
    }

    #[test]
    fn test_ingest_never_repeats_the_builder_canonicalization() {
        // Trim and fold are the writer's. Repeating them on read would make an SDK round trip
        // change the stored bytes, which is what publishing a feed as a byte copy relies on.
        let id = feed(stored(None, None, R::All, L::List, S::Recent, None)).create_id();
        let blob = |name: &str, icon: &str| {
            format!(
                r#"{{"feed":{{"tags":null,"reach":"all","layout":"list","sort":"recent","content":null}},"name":"{name}","icon":"{icon}","created_at":1700000000}}"#
            )
        };
        let read = |name: &str, icon: &str| {
            <PubkySocialFeed as Validatable>::try_from(blob(name, icon).as_bytes(), &id, &PRIV_CTX)
        };
        // a padded name is carried back with its padding, not silently repaired
        let f = read("  Rust  ", "code").unwrap();
        assert_eq!(f.name, "  Rust  ");
        assert!(serde_json::to_string(&f)
            .unwrap()
            .contains(r#""name":"  Rust  ""#));
        // an unfolded icon is a rejection, never a repair
        for bad in ["Code", " code"] {
            let e = read("Rust", bad).unwrap_err();
            assert!(e.contains("icon"), "{bad:?}: {e}");
        }
    }

    #[test]
    fn test_icon_rules() {
        let config =
            || PubkySocialFeedConfig::new(None, None, R::All, L::Columns, S::Recent, None).unwrap();
        // the builder folds with the frozen ops
        let f = PubkySocialFeed::new(config(), "Mixed".into(), "\u{3000}Code-2 ".into());
        assert_eq!(f.icon, Some("code-2".into()));
        assert!(validate(&f).is_ok());

        let max = VALIDATION_LIMITS.feed_icon_max_length;
        assert_eq!(max, 50);
        let with_icon = |icon: Option<String>| {
            let mut f = f.clone();
            f.icon = icon;
            f
        };
        assert!(validate(&with_icon(Some("a".repeat(max)))).is_ok());
        for (bad, expected) in [
            ("a".repeat(max + 1), "must be 1 to 50 characters"),
            (String::new(), "must be 1 to 50 characters"),
            ("Code".into(), "invalid character: C"),
            ("bad icon".into(), "invalid character:  "),
            ("bad,icon".into(), "invalid character: ,"),
            ("bad_icon".into(), "invalid character: _"),
        ] {
            let e = validate(&with_icon(Some(bad.clone()))).unwrap_err();
            assert!(e.contains("icon") && e.contains(expected), "{bad:?}: {e}");
        }
        // shape only: an icon no client knows is still a valid name
        assert!(validate(&with_icon(Some("no-such-icon-42".into()))).is_ok());
        // and a feed written before the field existed has none
        assert!(validate(&with_icon(None)).is_ok());
    }

    #[test]
    fn test_an_explicit_null_icon_reads_as_none() {
        let id = feed(stored(
            Some(vec!["rust"]),
            None,
            R::All,
            L::Columns,
            S::Recent,
            None,
        ))
        .create_id();
        let blob = br#"{"feed":{"tags":["rust"],"reach":"all","layout":"columns","sort":"recent","content":null},"name":"Rust","icon":null,"created_at":1700000000}"#;
        let f = <PubkySocialFeed as Validatable>::try_from(blob, &id, &PRIV_CTX).unwrap();
        assert_eq!(f.icon, None);
        let back = serde_json::to_value(&f).unwrap();
        assert!(back.get("icon").is_none());
    }

    #[test]
    fn test_derive_id_refuses_an_unspellable_config() {
        let known = feed(stored(
            None,
            None,
            R::All,
            L::List,
            S::Recent,
            Some(PubkySocialPostKind::Note),
        ));
        assert_eq!(known.derive_id().unwrap(), known.create_id());

        // Two future kinds keep their names, so they derive two ids
        let kind = |name: &str| {
            feed(stored(
                None,
                None,
                R::All,
                L::List,
                S::Recent,
                Some(PubkySocialPostKind::Unknown(name.into())),
            ))
            .derive_id()
            .unwrap()
        };
        assert_ne!(kind("podcast"), kind("poll"));

        // A config the rules reject has no id either: Some([]) renders the same six segments
        // as None, so handing back its hash would name another feed's file.
        let empty = feed(stored(Some(vec![]), None, R::All, L::List, S::Recent, None));
        let no_filter = feed(stored(None, None, R::All, L::List, S::Recent, None));
        assert_eq!(empty.get_id_data(), no_filter.get_id_data());
        let e = empty.derive_id().unwrap_err();
        assert!(e.contains("cannot be an empty list"), "{e}");
    }

    #[test]
    fn test_created_at_is_json_safe() {
        let mut f = feed(stored(None, None, R::All, L::List, S::Recent, None));
        f.created_at = i64::MAX;
        assert!(validate(&f).unwrap_err().contains("JSON-safe"));
    }

    #[test]
    fn test_feeds_are_private_and_publishing_is_a_byte_copy() {
        let f = feed(stored(None, None, R::All, L::List, S::Recent, None));
        let id = f.create_id();
        assert_eq!(
            PubkySocialFeed::create_path(&id),
            format!("/priv/social/v1/feeds/{id}.json")
        );
        let paths = feed_paths(&id);
        assert_eq!(paths.private, PubkySocialFeed::create_path(&id));
        assert_eq!(paths.public, format!("/pub/social/v1/feeds/{id}.json"));

        // the builder's URI is the private one, and both roots parse back to the same feed
        let uri = crate::feed_uri_builder(PK.into(), id.clone());
        assert_eq!(uri, format!("pubky://{PK}{}", paths.private));
        for (path, visibility) in [
            (&paths.private, crate::Visibility::Private),
            (&paths.public, crate::Visibility::Public),
        ] {
            let uri = format!("pubky://{PK}{path}");
            let parsed = crate::ParsedUri::try_from(uri.as_str()).unwrap();
            assert_eq!(parsed.visibility, visibility);
            assert_eq!(parsed.resource, crate::Resource::Feed(id.clone()));
            assert_eq!(parsed.try_to_uri_str().unwrap(), uri);
        }
    }

    #[test]
    fn test_lifecycle_planners_are_paths_in_order() {
        let id = feed(stored(None, None, R::All, L::List, S::Recent, None)).create_id();
        let paths = feed_paths(&id);

        assert_eq!(
            plan_feed_publish(&id).unwrap().copy,
            (paths.private.clone(), paths.public.clone())
        );
        assert_eq!(plan_feed_unpublish(&id).unwrap().delete, paths.public);
        // public first: the feed stops being world-readable before the owner's copy goes
        assert_eq!(
            plan_feed_delete(&id).unwrap().deletes,
            vec![paths.public.clone(), paths.private.clone()]
        );

        // a planner takes an id, not a path, so a spelling no homeserver key can hold stops here
        for bad in ["", "not-an-id", &id.to_lowercase(), &format!("{id}.json")] {
            assert!(plan_feed_publish(bad).is_err(), "{bad}");
            assert!(plan_feed_unpublish(bad).is_err(), "{bad}");
            assert!(plan_feed_delete(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn test_try_from_validates_and_preserves() {
        let blob = br#"{"feed":{"tags":["rust"],"domain_tags":["dev"],"reach":"all","layout":"columns","sort":"recent","content":null,"ext":{"pinned":true}},"name":"Rust","icon":"code","created_at":1700000000,"ext":{"badge":1}}"#;
        let id = feed(stored(
            Some(vec!["rust"]),
            Some(vec!["dev"]),
            R::All,
            L::Columns,
            S::Recent,
            None,
        ))
        .create_id();
        let f = <PubkySocialFeed as Validatable>::try_from(blob, &id, &PRIV_CTX).unwrap();
        assert_eq!(f.feed.tags, Some(vec!["rust".to_string()]));
        assert_eq!(f.feed.domain_tags, Some(vec!["dev".to_string()]));
        assert_eq!(f.extra["ext"]["badge"], 1);
        assert_eq!(f.feed.extra["ext"]["pinned"], true);
        let back = serde_json::to_string(&f).unwrap();
        assert!(back.contains(r#""ext":{"badge":1}"#), "{back}");
        assert!(back.contains(r#""ext":{"pinned":true}"#), "{back}");

        // an unknown member never shadows a known field, on either object
        let mut shadow = f.clone();
        shadow.extra.insert("name".into(), "x".into());
        assert!(validate(&shadow).unwrap_err().contains("shadow"));
        let mut shadow = f.clone();
        shadow.feed.extra.insert("reach".into(), "x".into());
        assert!(validate(&shadow).unwrap_err().contains("shadow"));
    }

    #[test]
    fn the_filter_of_a_stored_feed_is_capped_with_its_object_as_stored() {
        // 50 KB as stored; a writer spells each number in three more bytes, past the cap
        let pad = vec!["1e-5"; 10_000].join(",");
        let blob = format!(
            r#"{{"feed":{{"tags":null,"reach":"all","layout":"list","sort":"popularity","content":null,"pad":[{pad}]}},"name":"All","created_at":1700000000}}"#
        );
        let id = feed(stored(None, None, R::All, L::List, S::Popularity, None)).create_id();
        let f =
            <PubkySocialFeed as Validatable>::try_from(blob.as_bytes(), &id, &PRIV_CTX).unwrap();
        assert!(serde_json::to_vec(&f.feed).unwrap().len() > VALIDATION_LIMITS.object_max_bytes);
        assert!(f.validate(None, &PRIV_CTX).unwrap_err().contains("exceeds"));
    }

    #[test]
    fn test_ingest_by_uri_under_both_roots() {
        let blob = br#"{"feed":{"tags":null,"reach":"all","layout":"list","sort":"popularity","content":null},"name":"All","created_at":1700000000}"#;
        let id = feed(stored(None, None, R::All, L::List, S::Popularity, None)).create_id();
        for path in [feed_paths(&id).private, feed_paths(&id).public] {
            let uri = format!("pubky://{PK}{path}");
            assert!(
                crate::PubkySocialObject::from_uri(&uri, blob).is_ok(),
                "{uri}"
            );
        }
    }

    #[test]
    fn test_in_memory_size_cap() {
        let mut f = feed(stored(None, None, R::All, L::List, S::Recent, None));
        f.extra
            .insert("ext".into(), "a".repeat(PubkySocialFeed::MAX_BYTES).into());
        assert!(f.validate_fields(None, &PRIV_CTX).is_ok());
        assert!(f.validate(None, &PRIV_CTX).unwrap_err().contains("exceeds"));
    }

    #[test]
    fn test_wire_names_are_the_serde_names() {
        fn serde_name<T: serde::Serialize>(v: &T) -> String {
            serde_json::to_value(v)
                .unwrap()
                .as_str()
                .unwrap()
                .to_string()
        }
        for r in [
            R::Following,
            R::Followers,
            R::Friends,
            R::All,
            R::Wot,
            R::Me,
            R::Unknown("galaxy".into()),
        ] {
            assert_eq!(r.wire_name(), serde_name(&r));
        }
        for l in [
            L::Columns,
            L::Wide,
            L::Visual,
            L::List,
            L::Unknown("spiral".into()),
        ] {
            assert_eq!(l.wire_name(), serde_name(&l));
        }
        for s in [S::Recent, S::Popularity, S::Unknown("random".into())] {
            assert_eq!(s.wire_name(), serde_name(&s));
        }
        for k in [
            PubkySocialPostKind::Note,
            PubkySocialPostKind::Article,
            PubkySocialPostKind::Image,
            PubkySocialPostKind::Video,
            PubkySocialPostKind::Link,
            PubkySocialPostKind::File,
            PubkySocialPostKind::Collection,
            PubkySocialPostKind::Unknown("podcast".into()),
        ] {
            assert_eq!(k.wire_name(), serde_name(&k));
        }
    }

    #[test]
    fn test_validate_with_the_public_ctx_too() {
        // A feed carries no reference-tier field, so the destination root changes nothing
        let f = feed(stored(None, None, R::All, L::List, S::Recent, None));
        assert_eq!(
            f.validate(Some(&f.create_id()), &PUB_CTX),
            f.validate(Some(&f.create_id()), &PRIV_CTX)
        );
    }

    #[test]
    fn test_feed_reach_from_str() {
        // Valid cases
        assert_eq!(
            "following".parse::<PubkySocialFeedReach>().unwrap(),
            PubkySocialFeedReach::Following
        );
        assert_eq!(
            "followers".parse::<PubkySocialFeedReach>().unwrap(),
            PubkySocialFeedReach::Followers
        );
        assert_eq!(
            "friends".parse::<PubkySocialFeedReach>().unwrap(),
            PubkySocialFeedReach::Friends
        );
        assert_eq!(
            "all".parse::<PubkySocialFeedReach>().unwrap(),
            PubkySocialFeedReach::All
        );
        assert_eq!(
            "wot".parse::<PubkySocialFeedReach>().unwrap(),
            PubkySocialFeedReach::Wot
        );
        assert_eq!(
            "me".parse::<PubkySocialFeedReach>().unwrap(),
            PubkySocialFeedReach::Me
        );

        // Invalid case
        assert!("invalid".parse::<PubkySocialFeedReach>().is_err());
    }

    #[test]
    fn test_feed_layout_from_str() {
        // Valid cases
        assert_eq!(
            "columns".parse::<PubkySocialFeedLayout>().unwrap(),
            PubkySocialFeedLayout::Columns
        );
        assert_eq!(
            "wide".parse::<PubkySocialFeedLayout>().unwrap(),
            PubkySocialFeedLayout::Wide
        );
        assert_eq!(
            "visual".parse::<PubkySocialFeedLayout>().unwrap(),
            PubkySocialFeedLayout::Visual
        );
        assert_eq!(
            "list".parse::<PubkySocialFeedLayout>().unwrap(),
            PubkySocialFeedLayout::List
        );

        // Invalid case
        assert!("invalid".parse::<PubkySocialFeedLayout>().is_err());
    }

    #[test]
    fn test_feed_sort_from_str() {
        // Valid cases
        assert_eq!(
            "recent".parse::<PubkySocialFeedSort>().unwrap(),
            PubkySocialFeedSort::Recent
        );
        assert_eq!(
            "popularity".parse::<PubkySocialFeedSort>().unwrap(),
            PubkySocialFeedSort::Popularity
        );

        // Invalid case
        assert!("invalid".parse::<PubkySocialFeedSort>().is_err());
    }

    #[test]
    fn test_new_keeps_the_config_and_times_the_feed() {
        let config = PubkySocialFeedConfig::new(
            Some(vec!["bitcoin".into(), "rust".into()]),
            None,
            R::Following,
            L::Columns,
            S::Recent,
            Some(PubkySocialPostKind::Image),
        )
        .unwrap();
        let f = PubkySocialFeed::new(config.clone(), "Rust Bitcoiners".into(), "bitcoin".into());
        assert_eq!(f.feed, config);
        assert_eq!(f.name, "Rust Bitcoiners");
        assert_eq!(f.icon, Some("bitcoin".to_string()));
        let now = timestamp();
        assert!(f.created_at <= now && f.created_at >= now - 1_000_000);
    }

    /// The music feed of the audit, as a post feed and as a resources feed.
    fn music(target: PubkySocialFeedTarget) -> PubkySocialFeed {
        let config = PubkySocialFeedConfig::new(
            Some(vec!["music".into()]),
            None,
            R::All,
            L::Columns,
            S::Recent,
            None,
        )
        .unwrap()
        .with_target(target);
        PubkySocialFeed::new(config, "Music".into(), "music".into())
    }

    #[test]
    fn test_a_post_feed_keeps_the_id_it_had_before_target() {
        use PubkySocialPostKind as K;
        // Ids as 1.0.0-rc.1, which had no target, derived them for these filters
        for (config, id_data, id) in [
            (
                (
                    Some(vec!["music"]),
                    None,
                    R::All,
                    L::Columns,
                    S::Recent,
                    None,
                ),
                "all:columns:recent::music:",
                "C7PHA9M1X90SH1H2X2YPGY9QW4",
            ),
            (
                (None, None, R::All, L::Columns, S::Recent, None),
                "all:columns:recent:::",
                "96WQS9A0JPXNBAKR4GY7FBT458",
            ),
            (
                (None, None, R::All, L::Columns, S::Recent, Some(K::Link)),
                "all:columns:recent:link::",
                "TSMT23MF0717S1Y389AH13KFMR",
            ),
            (
                (
                    Some(vec!["a", "b"]),
                    Some(vec!["x"]),
                    R::Following,
                    L::List,
                    S::Popularity,
                    None,
                ),
                "following:list:popularity::a,b:x",
                "TXS1GDBJ56JZ10R30VP33FQVPR",
            ),
            (
                (
                    Some(vec!["music", "video"]),
                    None,
                    R::Wot,
                    L::Visual,
                    S::Recent,
                    Some(K::Image),
                ),
                "wot:visual:recent:image:music,video:",
                "QWRTXFXGWMX6DJ44D7X96F7VZW",
            ),
        ] {
            let (tags, domain_tags, reach, layout, sort, content) = config;
            let plain = feed(stored(tags, domain_tags, reach, layout, sort, content));
            assert_eq!(plain.get_id_data(), id_data);
            assert_eq!(plain.derive_id().unwrap(), id);
            // A stored "posts" is the same feed: it derives the same id and validates there
            let mut posts = plain.clone();
            posts.feed.target = Some(PubkySocialFeedTarget::Posts);
            assert_eq!(posts.derive_id().unwrap(), id);
            assert!(posts.validate(Some(id), &PRIV_CTX).is_ok());
            // and the builder never writes it
            let built = plain.feed.clone().with_target(PubkySocialFeedTarget::Posts);
            assert_eq!(built.target, None);
            let bytes = serde_json::to_string(&built).unwrap();
            assert!(!bytes.contains("target"), "{bytes}");
        }
    }

    #[test]
    fn test_a_resources_feed_prefixes_its_id_input() {
        let posts = music(PubkySocialFeedTarget::Posts);
        let resources = music(PubkySocialFeedTarget::Resources);
        assert_eq!(
            resources.get_id_data(),
            "resources:all:columns:recent::music:"
        );
        // blake3("resources:all:columns:recent::music:")[..16] in Crockford
        assert_eq!(resources.derive_id().unwrap(), "D41H1J8VKZ4JDSKYADR4WGAQB4");
        assert_eq!(posts.derive_id().unwrap(), "C7PHA9M1X90SH1H2X2YPGY9QW4");
        // The path is the feeds leaf of every feed, under its own id
        assert_eq!(
            PubkySocialFeed::create_path(&resources.create_id()),
            "/priv/social/v1/feeds/D41H1J8VKZ4JDSKYADR4WGAQB4.json"
        );
    }

    #[test]
    fn test_a_resources_feed_reads_at_its_own_path_only() {
        let resources = music(PubkySocialFeedTarget::Resources);
        let blob = serde_json::to_vec(&resources).unwrap();
        let text = String::from_utf8(blob.clone()).unwrap();
        assert!(
            text.starts_with(r#"{"feed":{"tags":["music"],"reach":"all","layout":"columns","sort":"recent","content":null,"target":"resources"},"#),
            "{text}"
        );
        let id = resources.create_id();
        let read = <PubkySocialFeed as Validatable>::try_from(&blob, &id, &PRIV_CTX).unwrap();
        assert_eq!(read, resources);
        // The bytes it reads are the bytes it writes back
        assert_eq!(serde_json::to_vec(&read).unwrap(), blob);
        // At the path of the post feed with the same filter it is refused, not read as that feed
        let e = <PubkySocialFeed as Validatable>::try_from(
            &blob,
            "C7PHA9M1X90SH1H2X2YPGY9QW4",
            &PRIV_CTX,
        )
        .unwrap_err();
        assert!(e.contains("Invalid ID"), "{e}");
    }

    #[test]
    fn test_an_unknown_target_is_refused_on_read() {
        let blob = br#"{"feed":{"tags":null,"reach":"all","layout":"columns","sort":"recent","content":null,"target":"events"},"name":"x","icon":"a","created_at":1}"#;
        let f: PubkySocialFeed = serde_json::from_slice(blob).unwrap();
        assert_eq!(
            f.feed.target,
            Some(PubkySocialFeedTarget::Unknown("events".into()))
        );
        for id in ["96WQS9A0JPXNBAKR4GY7FBT458", "8Z8CWH8NVYQY39ZEBFGKQWWEKG"] {
            let e = <PubkySocialFeed as Validatable>::try_from(blob, id, &PRIV_CTX).unwrap_err();
            assert_eq!(e, "Validation Error: feed target is unknown");
        }
        assert_eq!(
            f.derive_id().unwrap_err(),
            "Validation Error: feed target is unknown"
        );
        assert_eq!(
            PubkySocialFeedTarget::from_str("events").unwrap_err(),
            "Validation Error: Invalid feed target: events"
        );
    }

    #[test]
    fn test_a_resources_feed_lists_schema_org_types_or_every_one_and_has_no_domain_filter() {
        let with_types = |content: &str| {
            let mut f = music(PubkySocialFeedTarget::Resources);
            f.feed.content = Some(PubkySocialPostKind::from(content.to_string()));
            f
        };
        // The types take the content segment, so songs, every resource and posts of an unknown
        // kind of that name are three feeds
        let songs = with_types("MusicRecording");
        assert_eq!(songs.feed.resource_types(), Some(vec!["MusicRecording"]));
        assert_eq!(
            songs.get_id_data(),
            "resources:all:columns:recent:MusicRecording:music:"
        );
        let songs_id = songs.derive_id().unwrap();
        // blake3("resources:all:columns:recent:MusicRecording:music:")[..16] in Crockford
        assert_eq!(songs_id, "33BN1J3Z0K9HWVJ0S4NG873Y4R");
        let every_resource = music(PubkySocialFeedTarget::Resources);
        assert_eq!(every_resource.feed.resource_types(), None);
        assert_eq!(
            every_resource.derive_id().unwrap(),
            "D41H1J8VKZ4JDSKYADR4WGAQB4"
        );
        let songs_posts = {
            let mut f = music(PubkySocialFeedTarget::Posts);
            f.feed.content = Some(PubkySocialPostKind::from("MusicRecording".to_string()));
            f
        };
        assert_eq!(songs_posts.feed.resource_types(), None);
        let posts_id = songs_posts.derive_id().unwrap();
        // blake3("all:columns:recent:MusicRecording:music:"): an unknown post kind, as 1.0.0-rc.1 had it
        assert_eq!(posts_id, "Y62T3RNH68JPZF4C3WEYY66618");
        assert_ne!(songs_id, posts_id);
        assert_ne!(songs_id, every_resource.derive_id().unwrap());

        // A list is one content segment, and round-trips through the stored bytes at its own id
        let eating = with_types("FoodEstablishment,Restaurant");
        // blake3("resources:all:columns:recent:FoodEstablishment,Restaurant:music:")
        assert_eq!(eating.derive_id().unwrap(), "6KHSJG4TBFADVN49X67HCJA7WM");
        assert_eq!(
            eating.get_id_data(),
            "resources:all:columns:recent:FoodEstablishment,Restaurant:music:"
        );
        assert_eq!(
            eating.feed.resource_types(),
            Some(vec!["FoodEstablishment", "Restaurant"])
        );
        for f in [songs, eating, with_types("3DModel")] {
            let id = f.derive_id().unwrap();
            let blob = serde_json::to_vec(&f).unwrap();
            let read = <PubkySocialFeed as Validatable>::try_from(&blob, &id, &PRIV_CTX).unwrap();
            assert_eq!(read.feed.resource_types(), f.feed.resource_types());
            assert_eq!(serde_json::to_vec(&read).unwrap(), blob);
        }

        // A post kind or a family name is no type name, and a stored list is the builder's
        let ten = "A0,A1,A2,A3,A4,A5,A6,A7,A8,A9";
        let long = "A".repeat(65);
        assert!(with_types(ten).derive_id().is_ok());
        for (content, error) in [
            (
                "link",
                "Feed resource type 'link' is not a schema.org type name",
            ),
            (
                "music",
                "Feed resource type 'music' is not a schema.org type name",
            ),
            ("", "Feed resource type '' is not a schema.org type name"),
            (
                "Event,",
                "Feed resource type '' is not a schema.org type name",
            ),
            (
                "Event, Place",
                "Feed resource type ' Place' is not a schema.org type name",
            ),
            (
                "Music-Group",
                "Feed resource type 'Music-Group' is not a schema.org type name",
            ),
            (
                long.as_str(),
                "Feed resource type names cannot be longer than 64 characters",
            ),
            (
                "A0,A1,A2,A3,A4,A5,A6,A7,A8,A9,B0",
                "A resources feed cannot list more than 10 types",
            ),
            (
                "Restaurant,FoodEstablishment",
                "Feed resource types must be stored deduplicated and sorted by code point",
            ),
            (
                "Event,Event",
                "Feed resource types must be stored deduplicated and sorted by code point",
            ),
        ] {
            assert_eq!(
                with_types(content).derive_id().unwrap_err(),
                format!("Validation Error: {error}"),
                "{content}"
            );
        }
        let mut with_domains = music(PubkySocialFeedTarget::Resources);
        with_domains.feed.domain_tags = Some(vec!["dev".into()]);
        assert_eq!(
            with_domains.derive_id().unwrap_err(),
            "Validation Error: A resources feed cannot filter by domain_tags"
        );
        // A post feed keeps both
        let mut post = music(PubkySocialFeedTarget::Posts);
        post.feed.content = Some(PubkySocialPostKind::Link);
        post.feed.domain_tags = Some(vec!["dev".into()]);
        assert!(post.derive_id().is_ok());
    }

    #[test]
    fn test_resource_type_lists_are_the_shared_table() {
        let table: serde_json::Value =
            serde_json::from_str(include_str!("../../vectors/semantic/resource_types.json"))
                .unwrap();
        assert_eq!(
            table["max_count"].as_u64().unwrap() as usize,
            VALIDATION_LIMITS.feed_resource_types_max_count
        );
        assert_eq!(
            table["max_length"].as_u64().unwrap() as usize,
            VALIDATION_LIMITS.feed_resource_type_max_length
        );
        let text = |v: &serde_json::Value| v.as_str().map(str::to_string);
        for case in table["build"].as_array().unwrap() {
            let given = case[0].as_str().unwrap();
            let got = feed_resource_types(given).map(|c| c.wire_name().to_string());
            match (text(&case[1]), text(&case[2])) {
                (Some(content), None) => assert_eq!(got, Ok(content), "{given}"),
                (None, Some(error)) => {
                    assert_eq!(got, Err(format!("Validation Error: {error}")), "{given}")
                }
                _ => panic!("bad case {case}"),
            }
        }
        for case in table["read"].as_array().unwrap() {
            let content = case[0].as_str().unwrap();
            let got = validate_resource_types(content);
            match text(&case[1]) {
                None => assert_eq!(got, Ok(()), "{content}"),
                Some(error) => {
                    assert_eq!(got, Err(format!("Validation Error: {error}")), "{content}")
                }
            }
        }
    }

    #[test]
    fn test_no_older_feed_spells_the_id_input_of_a_resources_feed() {
        let resources = music(PubkySocialFeedTarget::Resources);
        // A valid older feed whose id input is the music filter with ":resources" after it: an
        // unknown content kind is kept as written and a domain label is anyone's choice
        let forged = feed(stored(
            None,
            Some(vec!["resources"]),
            R::All,
            L::Columns,
            S::Recent,
            Some(PubkySocialPostKind::Unknown(":music".into())),
        ));
        assert!(validate(&forged).is_ok());
        assert_eq!(forged.get_id_data(), "all:columns:recent::music::resources");
        assert_eq!(
            forged.get_id_data(),
            format!(
                "{}:resources",
                music(PubkySocialFeedTarget::Posts).get_id_data()
            )
        );
        assert_ne!(forged.create_id(), resources.create_id());
        // An older id input starts with a reach, and a reach named like a target is refused
        let e = feed(stored(
            Some(vec!["music"]),
            None,
            R::Unknown("resources".into()),
            L::Columns,
            S::Recent,
            None,
        ))
        .derive_id()
        .unwrap_err();
        assert_eq!(e, "Validation Error: feed reach is unknown");
    }

    #[test]
    fn test_target_wire_names() {
        for t in [
            PubkySocialFeedTarget::Posts,
            PubkySocialFeedTarget::Resources,
            PubkySocialFeedTarget::Unknown("events".into()),
        ] {
            assert_eq!(
                serde_json::to_value(&t).unwrap().as_str().unwrap(),
                t.wire_name()
            );
            if t.is_known() {
                assert_eq!(PubkySocialFeedTarget::from_str(t.wire_name()).unwrap(), t);
            }
        }
    }
}
