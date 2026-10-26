//! The maps sub-spec: the kinds a map app writes that no other app must read, on the shared
//! [`PostEnvelope`] under `/{pub,priv}/maps/v1/posts/{id}/{editId}.json`.
//!
//! One kind, `route`: a saved route, its waypoints references to places under the place
//! conventions of [`pubky_social_specs::places`]. Everything else a map app needs is a shared
//! primitive it never copies: a place review is a social `rating` whose `parent` is the place's
//! OpenStreetMap URL (or its `geo:` pin), a list of places is a social `collection`, a label on a
//! place is a social tag, a saved place a private bookmark, a comment a reply. See `README.md`.

use pubky_social_specs::subspec::{self, SubspecPostRef};
use pubky_social_specs::traits::{Root, ValidationCtx};
use pubky_social_specs::{
    AllowedSchemes, ContentReference, MintedVersion, PostEnvelope, PostKind, PubkyId,
    PubkySocialAttachment, VALIDATION_LIMITS,
};
use serde::{Deserialize, Serialize};

pub mod route;

pub use route::{RouteContent, RoutePolyline, RouteStep, RouteWaypoint};

/// The namespace segment every path of this sub-spec carries.
pub const NAMESPACE: &str = "maps";

/// The kinds an indexer forwards as feed lines only, without a graph node. None: a route is a
/// durable post people reply to, rate and collect.
pub const FEED_ONLY_KINDS: &[&str] = &[];

/// The kinds of the maps sub-spec. `Unknown` is the forwards-compat catch-all: a kind a newer
/// writer used reads, and fails validation.
#[derive(Serialize, Deserialize, Default, Debug, Clone, PartialEq)]
#[serde(from = "String", into = "String")]
#[non_exhaustive]
pub enum MapsPostKind {
    #[default]
    Route,
    Unknown(String),
}

pubky_social_specs::subspec_names!(MapsPostKind { Route => "route" });

impl MapsPostKind {
    /// Whether an indexer forwards this kind as a feed line only, see [`FEED_ONLY_KINDS`].
    pub fn is_feed_only(&self) -> bool {
        FEED_ONLY_KINDS.contains(&self.wire_name())
    }
}

/// A maps post: the shared envelope with the maps kinds.
pub type MapsPost = PostEnvelope<MapsPostKind>;

/// The caps of the maps kinds. Every `*_max_length` counts code points; the others are named by
/// their unit: `_count`, `_metres`, `_seconds`.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapsLimits {
    /// Maximum route name length in code points.
    pub route_name_max_length: usize,
    /// Maximum route description length in code points.
    pub route_description_max_length: usize,
    /// Minimum number of `waypoints` on a route: a start and an end.
    pub route_waypoints_min_count: usize,
    /// Maximum number of `waypoints` on a route.
    pub route_waypoints_max_count: usize,
    /// Maximum length of a waypoint's `name` in code points.
    pub route_waypoint_name_max_length: usize,
    /// Maximum length of the encoded polyline in code points.
    pub route_polyline_max_length: usize,
    /// Maximum length of the polyline's `engine` and `profile` labels in code points.
    pub route_label_max_length: usize,
    /// Maximum `distance_m` of a route, in metres.
    pub route_distance_max_metres: u64,
    /// Maximum `duration_s` of a route, in seconds: ten years.
    pub route_duration_max_seconds: u64,
    /// Maximum `elevation_gain_m` and `elevation_loss_m`, in metres.
    pub route_elevation_max_metres: u64,
    /// Maximum number of `steps` on a route.
    pub route_steps_max_count: usize,
    /// Maximum length of a step's `instruction` in code points.
    pub route_step_instruction_max_length: usize,
    /// Maximum length of the raw route envelope string, checked before it is parsed.
    pub route_content_max_length: usize,
}

/// The values the social 1.1 drafts gave the route kind, unchanged by the move.
pub const MAPS_LIMITS: MapsLimits = MapsLimits {
    route_name_max_length: 100,
    route_description_max_length: 2000,
    route_waypoints_min_count: 2,
    route_waypoints_max_count: 100,
    route_waypoint_name_max_length: 100,
    route_polyline_max_length: 100_000,
    route_label_max_length: 50,
    route_distance_max_metres: 100_000_000,
    route_duration_max_seconds: 10 * 365 * 24 * 60 * 60,
    route_elevation_max_metres: 100_000,
    route_steps_max_count: 500,
    route_step_instruction_max_length: 200,
    route_content_max_length: 400_000,
};

impl PostKind for MapsPostKind {
    fn is_known(&self) -> bool {
        MapsPostKind::is_known(self)
    }

    fn validate_content(&self, post: &MapsPost, _ctx: &ValidationCtx) -> Result<(), String> {
        match self {
            MapsPostKind::Route => route::validate_route_post(post),
            // The envelope refused an unknown kind before it dispatched
            MapsPostKind::Unknown(_) => Err("Validation Error: post kind is unknown".into()),
        }
    }

    /// The raw content cap, then the waypoint count, before any waypoint reference is read.
    fn check_counts(&self, post: &MapsPost) -> Result<(), String> {
        match self {
            MapsPostKind::Route => {
                subspec::check_content_cap(
                    "Route",
                    &post.content,
                    MAPS_LIMITS.route_content_max_length,
                )?;
                route::check_route_counts(post)
            }
            MapsPostKind::Unknown(_) => Ok(()),
        }
    }

    fn content_references(&self, post: &MapsPost) -> Vec<ContentReference> {
        let Some(route) = route::parse_route(post) else {
            return Vec::new();
        };
        route
            .waypoints
            .into_iter()
            .enumerate()
            .map(|(index, waypoint)| ContentReference {
                field: format!("waypoints[{index}].uri"),
                uri: waypoint.uri,
                schemes: AllowedSchemes::Universal,
                max_code_points: VALIDATION_LIMITS.reference_uri_max_length,
            })
            .collect()
    }
}

/// Builds the route envelope into `content` and wraps it in a `kind = Route` post. Trims the
/// name, the description (a blank one becoming absent), the activity (folded as a tag label is),
/// each waypoint's name, the polyline's labels and each step's instruction; references and the
/// encoded polyline pass through verbatim. `embed` may name the trail the route follows (an
/// OpenStreetMap relation); the cover is `attachments[0]`. Infallible; callers validate before
/// writing.
pub fn new_route(
    route: RouteContent,
    embed: Option<String>,
    attachments: Vec<PubkySocialAttachment>,
) -> MapsPost {
    let content = serde_json::to_string(&route.trimmed())
        .expect("an envelope of strings and integers always serializes");
    MapsPost::new(content, MapsPostKind::Route, None, embed, attachments)
}

/// Creation: mints the post id, validates under `root` with the author in scope, returns
/// `/{root}/maps/v1/posts/{id}/{id}[-{slug}].json`.
pub fn create_version(
    post: &MapsPost,
    root: Root,
    owner: &PubkyId,
    slug: Option<&str>,
) -> Result<MintedVersion, String> {
    post.create_version_under(NAMESPACE, root, owner, slug)
}

/// An edit of post `id` whose newest version is `head`: an editId strictly above it.
pub fn edit_version(
    post: &MapsPost,
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
) -> Result<MapsPost, String> {
    subspec::read_version(blob, id, root, owner)
}

/// `/{root}/maps/v1/posts/{id}/{editId}.json`.
pub fn version_path(root: Root, id: &str, edit_id: &str) -> String {
    subspec::version_path(NAMESPACE, root, id, edit_id)
}

/// `pubky://{owner}/{root}/maps/v1/posts/{id}`, the versionless reference to a route.
pub fn post_uri(owner: &PubkyId, root: Root, id: &str) -> String {
    subspec::post_uri(owner, NAMESPACE, root, id)
}

/// Classifies `uri` as a maps post, versionless or stored; `None` for anything else.
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
            assert!(MapsPostKind::from(kind.to_string()).is_known(), "{kind}");
        }
        assert!(!MapsPostKind::Route.is_feed_only());
    }

    #[test]
    fn kinds_read_and_write_by_their_names() {
        assert_eq!(
            serde_json::to_string(&MapsPostKind::Route).unwrap(),
            r#""route""#
        );
        let newer: MapsPostKind = serde_json::from_str(r#""track""#).unwrap();
        assert_eq!(newer, MapsPostKind::Unknown("track".into()));
        assert_eq!(serde_json::to_string(&newer).unwrap(), r#""track""#);
        assert_eq!(MapsPostKind::KNOWN, &["route"]);
    }

    #[test]
    fn limits_are_pinned() {
        assert_eq!(
            serde_json::to_string(&MAPS_LIMITS).unwrap(),
            r#"{"routeNameMaxLength":100,"routeDescriptionMaxLength":2000,"routeWaypointsMinCount":2,"routeWaypointsMaxCount":100,"routeWaypointNameMaxLength":100,"routePolylineMaxLength":100000,"routeLabelMaxLength":50,"routeDistanceMaxMetres":100000000,"routeDurationMaxSeconds":315360000,"routeElevationMaxMetres":100000,"routeStepsMaxCount":500,"routeStepInstructionMaxLength":200,"routeContentMaxLength":400000}"#
        );
    }
}
