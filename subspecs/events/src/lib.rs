//! The events sub-spec: the kinds an events or calendar app writes that no other app must read,
//! on the shared [`PostEnvelope`] under `/{pub,priv}/events/v1/posts/{id}/{editId}.json`.
//!
//! One kind, `availability`: when a person, or a resource of theirs, can be booked, in
//! JSCalendar (RFC 8984) member names and the value rules of [`pubky_social_specs::jscalendar`].
//! There is no event kind here: an event is the social `event`, which every app reads, an answer
//! to it the social `rsvp`, a calendar a social `collection` of event URIs, a review of an event
//! a social `rating`. See `README.md`.

use pubky_social_specs::subspec::{self, SubspecPostRef};
use pubky_social_specs::traits::{Root, ValidationCtx};
use pubky_social_specs::{
    AllowedSchemes, ContentReference, MintedVersion, PostEnvelope, PostKind, PubkyId,
    VALIDATION_LIMITS,
};
use serde::{Deserialize, Serialize};

pub mod availability;

pub use availability::{AvailabilityBlock, AvailabilityContent};

/// The namespace segment every path of this sub-spec carries.
pub const NAMESPACE: &str = "events";

/// The kinds an indexer forwards as feed lines only, without a graph node. An availability is
/// state, not a post people answer: one current version per author, rewritten as bookings come
/// and go, with no parent, embed or attachment to make an edge of. Its consumer is the time
/// index (Pinakes), which reads it from the feed line.
pub const FEED_ONLY_KINDS: &[&str] = &["availability"];

/// The kinds of the events sub-spec. `Unknown` is the forwards-compat catch-all: a kind a newer
/// writer used reads, and fails validation.
#[derive(Serialize, Deserialize, Default, Debug, Clone, PartialEq)]
#[serde(from = "String", into = "String")]
#[non_exhaustive]
pub enum EventsPostKind {
    #[default]
    Availability,
    Unknown(String),
}

pubky_social_specs::subspec_names!(EventsPostKind {
    Availability => "availability",
});

impl EventsPostKind {
    /// Whether an indexer forwards this kind as a feed line only, see [`FEED_ONLY_KINDS`].
    pub fn is_feed_only(&self) -> bool {
        FEED_ONLY_KINDS.contains(&self.wire_name())
    }
}

/// An events post: the shared envelope with the events kinds.
pub type EventsPost = PostEnvelope<EventsPostKind>;

/// The caps of the events kinds. The JSCalendar values (a duration, the recurrence rules, the
/// excluded dates) take social's event caps, `VALIDATION_LIMITS.event_*`, so an availability
/// block and an event repeat under one rule.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventsLimits {
    /// Maximum `horizonDays` of an availability, in days: one leap year.
    pub availability_horizon_max_days: u64,
    /// Maximum number of blocks in each of `available` and `busy`.
    pub availability_blocks_max_count: usize,
    /// Maximum length of an available block's `title` in code points.
    pub availability_block_title_max_length: usize,
    /// Maximum length of the raw availability envelope string, checked before it is parsed.
    pub availability_content_max_length: usize,
}

/// The values the social 1.1 drafts gave the availability kind, unchanged by the move.
pub const EVENTS_LIMITS: EventsLimits = EventsLimits {
    availability_horizon_max_days: 366,
    availability_blocks_max_count: 100,
    availability_block_title_max_length: 100,
    availability_content_max_length: 100_000,
};

impl PostKind for EventsPostKind {
    fn is_known(&self) -> bool {
        EventsPostKind::is_known(self)
    }

    fn validate_content(&self, post: &EventsPost, _ctx: &ValidationCtx) -> Result<(), String> {
        match self {
            EventsPostKind::Availability => availability::validate_availability_post(post),
            // The envelope refused an unknown kind before it dispatched
            EventsPostKind::Unknown(_) => Err("Validation Error: post kind is unknown".into()),
        }
    }

    /// The raw content cap, before the envelope is parsed.
    fn check_counts(&self, post: &EventsPost) -> Result<(), String> {
        match self {
            EventsPostKind::Availability => subspec::check_content_cap(
                "Availability",
                &post.content,
                EVENTS_LIMITS.availability_content_max_length,
            ),
            EventsPostKind::Unknown(_) => Ok(()),
        }
    }

    /// `for`, the resource the schedule belongs to, on the universal tier.
    fn content_references(&self, post: &EventsPost) -> Vec<ContentReference> {
        availability::parse_availability(post)
            .and_then(|schedule| schedule.r#for)
            .map(|resource| ContentReference {
                field: "for".to_string(),
                uri: resource,
                schemes: AllowedSchemes::Universal,
                max_code_points: VALIDATION_LIMITS.reference_uri_max_length,
            })
            .into_iter()
            .collect()
    }
}

/// Builds the availability envelope into `content` and wraps it in a `kind = Availability`
/// post. Trims each block's title, a blank one becoming absent. An availability replies to
/// nothing, quotes nothing and carries no media. Infallible; callers validate before writing.
pub fn new_availability(schedule: AvailabilityContent) -> EventsPost {
    let content = serde_json::to_string(&schedule.trimmed())
        .expect("an envelope of strings and integers always serializes");
    EventsPost::new(content, EventsPostKind::Availability, None, None, vec![])
}

/// Creation: mints the post id, validates under `root` with the author in scope, returns
/// `/{root}/events/v1/posts/{id}/{id}[-{slug}].json`.
pub fn create_version(
    post: &EventsPost,
    root: Root,
    owner: &PubkyId,
    slug: Option<&str>,
) -> Result<MintedVersion, String> {
    post.create_version_under(NAMESPACE, root, owner, slug)
}

/// An edit of post `id` whose newest version is `head`: an editId strictly above it. An
/// availability is one current post per author, so a client edits it rather than creating
/// another.
pub fn edit_version(
    post: &EventsPost,
    id: &str,
    head: &str,
    root: Root,
    owner: &PubkyId,
    slug: Option<&str>,
) -> Result<MintedVersion, String> {
    post.edit_version_under(NAMESPACE, id, head, root, owner, slug)
}

/// Reads one stored version: the bytes as written, the rules under `root`, the ownership rule
/// with the author the URI names.
pub fn read_version(
    blob: &[u8],
    id: &str,
    root: Root,
    owner: &PubkyId,
) -> Result<EventsPost, String> {
    subspec::read_version(blob, id, root, owner)
}

/// `/{root}/events/v1/posts/{id}/{editId}.json`.
pub fn version_path(root: Root, id: &str, edit_id: &str) -> String {
    subspec::version_path(NAMESPACE, root, id, edit_id)
}

/// `pubky://{owner}/{root}/events/v1/posts/{id}`, the versionless reference to a post.
pub fn post_uri(owner: &PubkyId, root: Root, id: &str) -> String {
    subspec::post_uri(owner, NAMESPACE, root, id)
}

/// Classifies `uri` as an events post, versionless or stored; `None` for anything else.
pub fn parse_post_uri(uri: &str) -> Option<SubspecPostRef> {
    subspec::parse_post_uri(NAMESPACE, uri)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_namespace_is_a_namespace() {
        assert_eq!(subspec::validate_namespace(NAMESPACE), Ok(()));
        for kind in FEED_ONLY_KINDS {
            assert!(EventsPostKind::from(kind.to_string()).is_known(), "{kind}");
        }
        assert!(EventsPostKind::Availability.is_feed_only());
        assert!(!EventsPostKind::Unknown("x".into()).is_feed_only());
    }

    #[test]
    fn kinds_read_and_write_by_their_names() {
        assert_eq!(
            serde_json::to_string(&EventsPostKind::Availability).unwrap(),
            r#""availability""#
        );
        let newer: EventsPostKind = serde_json::from_str(r#""event""#).unwrap();
        assert_eq!(newer, EventsPostKind::Unknown("event".into()));
    }

    #[test]
    fn limits_are_pinned() {
        assert_eq!(
            serde_json::to_string(&EVENTS_LIMITS).unwrap(),
            r#"{"availabilityHorizonMaxDays":366,"availabilityBlocksMaxCount":100,"availabilityBlockTitleMaxLength":100,"availabilityContentMaxLength":100000}"#
        );
    }

    #[test]
    fn paths() {
        let owner =
            PubkyId::try_from("operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo").unwrap();
        let id = "0032SSN7Q4EVG";
        assert_eq!(
            version_path(Root::Pub, id, id),
            format!("/pub/events/v1/posts/{id}/{id}.json")
        );
        let uri = post_uri(&owner, Root::Pub, id);
        assert_eq!(parse_post_uri(&uri).unwrap().id, id);
        let minted = create_version(
            &new_availability(AvailabilityContent::new("UTC".into(), 7)),
            Root::Pub,
            &owner,
            None,
        )
        .unwrap();
        assert!(
            minted.path.starts_with("/pub/events/v1/posts/"),
            "{}",
            minted.path
        );
    }
}
