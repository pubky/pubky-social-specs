//! The `route` kind: a saved route as a post. Ordered waypoints as
//! references to places, an encoded polyline with the engine and profile that produced it, the
//! distance, the duration, the elevation and optional steps. The indexer facets `activity`,
//! `distance_m`, the duration, the first waypoint and the bounding box of the waypoints; it
//! never decodes the polyline. Members are snake_case, as the article and collection envelopes
//! are: no outside standard names them.

use crate::{MapsPost, MAPS_LIMITS};
use pubky_social_specs::places::check_place_reference;
use pubky_social_specs::subspec::{check_extra, json_error, trimmed_or_none};
use pubky_social_specs::{
    ascii_fold, code_point_len, frozen_trim, is_frozen_whitespace, VALIDATION_LIMITS,
};
use serde::{Deserialize, Serialize};

/// One point the route passes, in order: a reference to a place, through the universal gate
/// and the place conventions, and a name to show.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct RouteWaypoint {
    /// A `geo:` point or a canonical OpenStreetMap object URL, or any other universal reference.
    pub uri: String,
    /// Trimmed by the builder, a blank one absent; `1..=route_waypoint_name_max_length`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Unknown members, preserved on rewrite; see the module contract in `models/mod.rs`.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl RouteWaypoint {
    /// A waypoint over a canonical `uri` with an optional `name`, which the builder trims, a
    /// blank one becoming absent; the uri passes through verbatim.
    pub fn new(uri: String, name: Option<String>) -> Self {
        Self {
            uri,
            name: name.and_then(trimmed_or_none),
            extra: Default::default(),
        }
    }
}

/// The geometry: an encoded polyline (the Google algorithm) and what produced it.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
pub struct RoutePolyline {
    /// `1..=route_polyline_max_length` characters of the polyline alphabet, `?` to `~`.
    pub encoded: String,
    /// The routing engine, trimmed by the builder; `1..=route_label_max_length`, not blank.
    pub engine: String,
    /// The engine's costing profile, trimmed by the builder; `1..=route_label_max_length`, not
    /// blank.
    pub profile: String,
    /// The coordinate precision the polyline was encoded at: `5` or `6` decimal digits.
    pub precision: i64,
    /// Unknown members, preserved on rewrite; see the module contract in `models/mod.rs`.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl RoutePolyline {
    /// Trims the two labels; the encoded text passes through verbatim.
    pub fn new(encoded: String, engine: String, profile: String, precision: i64) -> Self {
        Self {
            encoded,
            engine: frozen_trim(&engine).to_string(),
            profile: frozen_trim(&profile).to_string(),
            precision,
            extra: Default::default(),
        }
    }
}

/// One manoeuvre of the route's guidance.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
pub struct RouteStep {
    /// Trimmed by the builder; `1..=route_step_instruction_max_length`, not blank.
    pub instruction: String,
    /// `0..=route_distance_max_metres`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub distance_m: Option<i64>,
    /// `0..=route_duration_max_seconds`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_s: Option<i64>,
    /// Unknown members, preserved on rewrite; see the module contract in `models/mod.rs`.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl RouteStep {
    /// Trims the instruction.
    pub fn new(instruction: String, distance_m: Option<i64>, duration_s: Option<i64>) -> Self {
        Self {
            instruction: frozen_trim(&instruction).to_string(),
            distance_m,
            duration_s,
            extra: Default::default(),
        }
    }
}

/// Typed JSON envelope stored in a maps post's `content` when `kind == Route`.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
pub struct RouteContent {
    /// Trimmed by the builder; `[1, route_name_max_length]` code points.
    pub name: String,
    /// Trimmed by the builder, a blank one absent; at most `route_description_max_length`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// What the route is for, a label with the tag label rules (`hiking`, `cycling`, `running`,
    /// `driving`, ...), ASCII-folded by the builder; the indexer facets it.
    pub activity: String,
    /// `route_waypoints_min_count..=route_waypoints_max_count`, in travel order.
    #[serde(default)]
    pub waypoints: Vec<RouteWaypoint>,
    pub polyline: RoutePolyline,
    /// `0..=route_distance_max_metres`.
    pub distance_m: i64,
    /// `0..=route_duration_max_seconds`.
    pub duration_s: i64,
    /// `0..=route_elevation_max_metres`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub elevation_gain_m: Option<i64>,
    /// `0..=route_elevation_max_metres`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub elevation_loss_m: Option<i64>,
    /// At most `route_steps_max_count`.
    #[serde(default)]
    pub steps: Vec<RouteStep>,
    /// Unknown members, preserved on rewrite; see the module contract in `models/mod.rs`.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl RouteContent {
    /// A route of its required members; the optional ones are public to set. Nothing is
    /// trimmed here; [`crate::new_route`] is the builder.
    pub fn new(
        name: String,
        activity: String,
        waypoints: Vec<RouteWaypoint>,
        polyline: RoutePolyline,
        distance_m: i64,
        duration_s: i64,
    ) -> Self {
        Self {
            name,
            activity,
            waypoints,
            polyline,
            distance_m,
            duration_s,
            ..Default::default()
        }
    }

    /// The builder trim: the name, the description (a blank one absent), the activity (trimmed
    /// and ASCII-folded, as a tag label is), each waypoint's name, the polyline's labels and
    /// each step's instruction. References and the encoded polyline pass through verbatim.
    pub fn trimmed(self) -> Self {
        Self {
            name: frozen_trim(&self.name).to_string(),
            description: self.description.and_then(trimmed_or_none),
            activity: ascii_fold(frozen_trim(&self.activity)),
            waypoints: self
                .waypoints
                .into_iter()
                .map(|w| RouteWaypoint {
                    name: w.name.and_then(trimmed_or_none),
                    ..w
                })
                .collect(),
            polyline: RoutePolyline {
                engine: frozen_trim(&self.polyline.engine).to_string(),
                profile: frozen_trim(&self.polyline.profile).to_string(),
                ..self.polyline
            },
            steps: self
                .steps
                .into_iter()
                .map(|s| RouteStep {
                    instruction: frozen_trim(&s.instruction).to_string(),
                    ..s
                })
                .collect(),
            ..self
        }
    }
}

/// The envelope when it parses; the kind's validation words the failure.
pub(crate) fn parse_route(post: &MapsPost) -> Option<RouteContent> {
    serde_json::from_str(&post.content).ok()
}

/// The waypoint count, run before any waypoint reference is read.
pub(crate) fn check_route_counts(post: &MapsPost) -> Result<(), String> {
    let Some(envelope) = parse_route(post) else {
        return Ok(());
    };
    let min = MAPS_LIMITS.route_waypoints_min_count;
    let max = MAPS_LIMITS.route_waypoints_max_count;
    if !(min..=max).contains(&envelope.waypoints.len()) {
        return Err(format!(
            "Validation Error: Route must have {min} to {max} waypoints"
        ));
    }
    Ok(())
}

fn check_range(field: &str, value: i64, max: u64, unit: &str) -> Result<(), String> {
    if value < 0 || value > max as i64 {
        return Err(format!(
            "Validation Error: {field} must be 0 to {max} {unit}"
        ));
    }
    Ok(())
}

/// Validates a `kind = Route` post, including its JSON content envelope. Every waypoint uri ran
/// through the post-level gate before this; the place conventions run here, after it.
pub(crate) fn validate_route_post(post: &MapsPost) -> Result<(), String> {
    if post.parent.is_some() {
        return Err("Validation Error: Route posts cannot have parent".into());
    }
    if code_point_len(&post.content) > MAPS_LIMITS.route_content_max_length {
        return Err(format!(
            "Validation Error: Route content must be at most {} code points",
            MAPS_LIMITS.route_content_max_length
        ));
    }
    let envelope: RouteContent = serde_json::from_str(&post.content).map_err(|e| {
        format!(
            "Validation Error: Route content must be a valid JSON envelope: {}",
            json_error(&e)
        )
    })?;
    check_extra(
        &envelope.extra,
        &[
            "name",
            "description",
            "activity",
            "waypoints",
            "polyline",
            "distance_m",
            "duration_s",
            "elevation_gain_m",
            "elevation_loss_m",
            "steps",
        ],
    )?;
    if frozen_trim(&envelope.name).is_empty() {
        return Err("Validation Error: Route name must contain non-whitespace characters".into());
    }
    if code_point_len(&envelope.name) > MAPS_LIMITS.route_name_max_length {
        return Err(format!(
            "Validation Error: Route name must be at most {} code points",
            MAPS_LIMITS.route_name_max_length
        ));
    }
    if let Some(description) = &envelope.description {
        if frozen_trim(description).is_empty() {
            return Err("Validation Error: Route description must not be blank".into());
        }
        if code_point_len(description) > MAPS_LIMITS.route_description_max_length {
            return Err(format!(
                "Validation Error: Route description must be at most {} code points",
                MAPS_LIMITS.route_description_max_length
            ));
        }
    }
    // The tag label rules, worded for the member
    let activity_len = code_point_len(&envelope.activity);
    if !(VALIDATION_LIMITS.tag_label_min_length..=VALIDATION_LIMITS.tag_label_max_length)
        .contains(&activity_len)
        || envelope.activity.chars().any(is_frozen_whitespace)
        || envelope
            .activity
            .chars()
            .any(|c| VALIDATION_LIMITS.tag_invalid_chars.contains(&c))
    {
        return Err(format!(
            "Validation Error: Route activity must be a label of {} to {} code points with no whitespace, comma or colon: {}",
            VALIDATION_LIMITS.tag_label_min_length,
            VALIDATION_LIMITS.tag_label_max_length,
            envelope.activity
        ));
    }
    // The waypoint count was checked with the post's list caps, before any reference was read
    for (index, waypoint) in envelope.waypoints.iter().enumerate() {
        check_extra(&waypoint.extra, &["uri", "name"])?;
        if let Some(name) = &waypoint.name {
            let max = MAPS_LIMITS.route_waypoint_name_max_length;
            if frozen_trim(name).is_empty() || code_point_len(name) > max {
                return Err(format!(
                    "Validation Error: waypoints[{index}].name must be 1 to {max} code points and not blank"
                ));
            }
        }
        check_place_reference(&format!("waypoints[{index}].uri"), &waypoint.uri)?;
    }
    let polyline = &envelope.polyline;
    check_extra(
        &polyline.extra,
        &["encoded", "engine", "profile", "precision"],
    )?;
    let max = MAPS_LIMITS.route_polyline_max_length;
    if polyline.encoded.is_empty()
        || code_point_len(&polyline.encoded) > max
        || !polyline.encoded.bytes().all(|b| (b'?'..=b'~').contains(&b))
    {
        return Err(format!(
            "Validation Error: polyline.encoded must be 1 to {max} characters of the encoded polyline alphabet, ? to ~"
        ));
    }
    let max = MAPS_LIMITS.route_label_max_length;
    for (field, label) in [("engine", &polyline.engine), ("profile", &polyline.profile)] {
        if frozen_trim(label).is_empty() || code_point_len(label) > max {
            return Err(format!(
                "Validation Error: polyline.{field} must be 1 to {max} code points and not blank"
            ));
        }
    }
    if !matches!(polyline.precision, 5 | 6) {
        return Err("Validation Error: polyline.precision must be 5 or 6".into());
    }
    check_range(
        "Route distance_m",
        envelope.distance_m,
        MAPS_LIMITS.route_distance_max_metres,
        "metres",
    )?;
    check_range(
        "Route duration_s",
        envelope.duration_s,
        MAPS_LIMITS.route_duration_max_seconds,
        "seconds",
    )?;
    for (field, value) in [
        ("Route elevation_gain_m", envelope.elevation_gain_m),
        ("Route elevation_loss_m", envelope.elevation_loss_m),
    ] {
        if let Some(value) = value {
            check_range(
                field,
                value,
                MAPS_LIMITS.route_elevation_max_metres,
                "metres",
            )?;
        }
    }
    let max = MAPS_LIMITS.route_steps_max_count;
    if envelope.steps.len() > max {
        return Err(format!(
            "Validation Error: Route cannot have more than {max} steps"
        ));
    }
    for (index, step) in envelope.steps.iter().enumerate() {
        check_extra(&step.extra, &["instruction", "distance_m", "duration_s"])?;
        let max = MAPS_LIMITS.route_step_instruction_max_length;
        if frozen_trim(&step.instruction).is_empty() || code_point_len(&step.instruction) > max {
            return Err(format!(
                "Validation Error: steps[{index}].instruction must be 1 to {max} code points and not blank"
            ));
        }
        if let Some(distance) = step.distance_m {
            check_range(
                &format!("steps[{index}].distance_m"),
                distance,
                MAPS_LIMITS.route_distance_max_metres,
                "metres",
            )?;
        }
        if let Some(duration) = step.duration_s {
            check_range(
                &format!("steps[{index}].duration_s"),
                duration,
                MAPS_LIMITS.route_duration_max_seconds,
                "seconds",
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{new_route, MapsPostKind};
    use pubky_social_specs::traits::{TimestampId, Validatable, PUB_CTX};
    use pubky_social_specs::PubkySocialAttachment;

    const PK: &str = "operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo";
    const TRAIL: &str = "https://www.openstreetmap.org/relation/1234";

    fn lakeside() -> RouteContent {
        let mut route = RouteContent::new(
            "Lakeside loop".into(),
            "running".into(),
            vec![
                RouteWaypoint::new("geo:46.00547,8.95186".into(), Some("Start".into())),
                RouteWaypoint::new("https://www.openstreetmap.org/node/240109189".into(), None),
                RouteWaypoint::new("geo:46.00547,8.95186".into(), Some("Finish".into())),
            ],
            RoutePolyline::new(
                "_p~iF~ps|U_ulLnnqC_mqNvxq`@".into(),
                "valhalla".into(),
                "pedestrian".into(),
                6,
            ),
            5_200,
            1_800,
        );
        route.description = Some("Flat, along the shore.".into());
        route.elevation_gain_m = Some(12);
        route.elevation_loss_m = Some(12);
        route.steps = vec![RouteStep::new(
            "Head south on the promenade".into(),
            Some(400),
            Some(150),
        )];
        route
    }

    fn route_post(route: RouteContent) -> MapsPost {
        new_route(route, Some(TRAIL.into()), vec![])
    }

    fn raw(content: &str) -> MapsPost {
        MapsPost::new(content.to_string(), MapsPostKind::Route, None, None, vec![])
    }

    fn validate(post: &MapsPost) -> Result<(), String> {
        post.validate(Some(&post.create_id()), &PUB_CTX)
    }

    fn err(post: &MapsPost) -> String {
        validate(post).expect_err("expected a validation error")
    }

    fn with(route: &RouteContent, edit: impl Fn(&mut serde_json::Value)) -> MapsPost {
        let mut v = serde_json::to_value(route).unwrap();
        edit(&mut v);
        raw(&v.to_string())
    }

    #[test]
    fn builder_round_trips_and_trims_and_folds() {
        let mut route = lakeside();
        route.name = "  Lakeside loop ".into();
        route.description = Some(" \u{3000}".into());
        route.activity = " Running ".into();
        route.waypoints[0].name = Some("  Start ".into());
        route.polyline.engine = " Valhalla ".into();
        route.steps[0].instruction = " Head south ".into();
        let post = route_post(route);
        assert_eq!(post.kind, MapsPostKind::Route);
        assert_eq!(post.embed.as_deref(), Some(TRAIL));
        let e: RouteContent = serde_json::from_str(&post.content).unwrap();
        assert_eq!(e.name, "Lakeside loop");
        assert_eq!(e.description, None);
        assert_eq!(e.activity, "running");
        assert_eq!(e.waypoints[0].name.as_deref(), Some("Start"));
        assert_eq!(e.polyline.engine, "Valhalla");
        assert_eq!(e.steps[0].instruction, "Head south");
        assert_eq!(validate(&post), Ok(()));
        let post = route_post(lakeside());
        assert_eq!(validate(&post), Ok(()));
        assert_eq!(
            post.content,
            r#"{"name":"Lakeside loop","description":"Flat, along the shore.","activity":"running","waypoints":[{"uri":"geo:46.00547,8.95186","name":"Start"},{"uri":"https://www.openstreetmap.org/node/240109189"},{"uri":"geo:46.00547,8.95186","name":"Finish"}],"polyline":{"encoded":"_p~iF~ps|U_ulLnnqC_mqNvxq`@","engine":"valhalla","profile":"pedestrian","precision":6},"distance_m":5200,"duration_s":1800,"elevation_gain_m":12,"elevation_loss_m":12,"steps":[{"instruction":"Head south on the promenade","distance_m":400,"duration_s":150}]}"#
        );
        let blob = serde_json::to_vec(&post).unwrap();
        let read = <MapsPost as Validatable>::try_from(&blob, &post.create_id(), &PUB_CTX).unwrap();
        assert_eq!(read, post);
        let with_photo = new_route(
            lakeside(),
            None,
            vec![PubkySocialAttachment::new(
                format!("pubky://{PK}/pub/social/v1/files/PZBQ010FF079VVZPQG1RNFN6DR.png"),
                None,
                None,
            )],
        );
        assert_eq!(validate(&with_photo), Ok(()));
    }

    #[test]
    fn a_reader_never_rewrites_and_keeps_unknown_members() {
        let base = lakeside();
        let post = with(&base, |v| {
            v["name"] = " padded ".into();
            v["activity"] = "Running".into();
            v["surface"] = "gravel".into();
            v["waypoints"][0]["elevation_m"] = 273.into();
            v["polyline"]["version"] = "3.4".into();
            v["steps"][0]["type"] = 1.into();
        });
        assert_eq!(validate(&post), Ok(()));
        let e: RouteContent = serde_json::from_str(&post.content).unwrap();
        assert_eq!(e.name, " padded ");
        assert_eq!(e.activity, "Running");
        let back: serde_json::Value = serde_json::to_value(&e).unwrap();
        assert_eq!(back["surface"], "gravel");
        assert_eq!(back["waypoints"][0]["elevation_m"], 273);
        assert_eq!(back["polyline"]["version"], "3.4");
        assert_eq!(back["steps"][0]["type"], 1);
    }

    #[test]
    fn envelope_rules() {
        let mut post = route_post(lakeside());
        post.parent = Some(format!("pubky://{PK}/pub/social/v1/posts/0032SSN7Q4EVG"));
        assert_eq!(
            err(&post),
            "Validation Error: Route posts cannot have parent"
        );
        let over = "x".repeat(MAPS_LIMITS.route_content_max_length + 1);
        assert!(err(&raw(&over)).contains("Route content must be at most"));
        assert!(err(&raw("nope"))
            .starts_with("Validation Error: Route content must be a valid JSON envelope: "));
        assert!(err(&raw(r#"{"name":"n"}"#)).contains("missing field"));
        // the trail an embed names is a reference like any other
        let mut quoted = route_post(lakeside());
        quoted.embed = Some("https://www.openstreetmap.org/relation/1234/".into());
        assert_eq!(validate(&quoted), Ok(()), "embed keeps the v1 gate alone");
        quoted.embed = Some(" x".into());
        assert!(err(&quoted).contains("embed"));
    }

    #[test]
    fn text_and_activity_rules() {
        let base = lakeside();
        assert_eq!(
            err(&with(&base, |v| v["name"] = " ".into())),
            "Validation Error: Route name must contain non-whitespace characters"
        );
        let max = MAPS_LIMITS.route_name_max_length;
        assert_eq!(
            err(&with(&base, |v| v["name"] = "n".repeat(max + 1).into())),
            format!("Validation Error: Route name must be at most {max} code points")
        );
        assert_eq!(
            err(&with(&base, |v| v["description"] = "".into())),
            "Validation Error: Route description must not be blank"
        );
        let max = MAPS_LIMITS.route_description_max_length;
        assert_eq!(
            err(&with(&base, |v| v["description"] = "d".repeat(max + 1).into())),
            format!("Validation Error: Route description must be at most {max} code points")
        );
        for ok in [
            "hiking",
            "Cycling",
            "e-bike",
            "x".repeat(20).as_str(),
            "山歩き",
        ] {
            assert_eq!(
                validate(&with(&base, |v| v["activity"] = ok.into())),
                Ok(()),
                "{ok}"
            );
        }
        for bad in [
            "",
            "trail run",
            "a,b",
            "a:b",
            "x".repeat(21).as_str(),
            "run\u{3000}",
        ] {
            assert_eq!(
                err(&with(&base, |v| v["activity"] = bad.into())),
                format!("Validation Error: Route activity must be a label of 1 to 20 code points with no whitespace, comma or colon: {bad}"),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn waypoints_take_the_gate_then_the_place_conventions() {
        let base = lakeside();
        let min = MAPS_LIMITS.route_waypoints_min_count;
        let max = MAPS_LIMITS.route_waypoints_max_count;
        let point = serde_json::json!({ "uri": "geo:46,8" });
        for n in [0, 1, max + 1] {
            assert_eq!(
                err(&with(&base, |v| v["waypoints"] =
                    serde_json::json!(vec![point.clone(); n]))),
                format!("Validation Error: Route must have {min} to {max} waypoints"),
                "{n}"
            );
        }
        assert_eq!(
            validate(&with(&base, |v| v["waypoints"] =
                serde_json::json!(vec![point.clone(); max]))),
            Ok(())
        );
        // the count first, before the first bad uri
        let bad = serde_json::json!({ "uri": "nowhere" });
        assert!(err(&with(&base, |v| v["waypoints"] =
            serde_json::json!(vec![bad.clone(); max + 1])))
        .contains("to 100 waypoints"));
        assert!(err(&with(&base, |v| v["waypoints"] =
            serde_json::json!(vec![bad.clone(); 2])))
        .contains("waypoints[0].uri must be a canonical"));
        assert_eq!(
            err(&with(&base, |v| v["waypoints"][1]["uri"] = "geo:46.123456,8".into())),
            "Validation Error: waypoints[1].uri must be a geo URI, geo:<lat>,<lon> in decimal degrees with at most 5 fraction digits and no trailing zeros: geo:46.123456,8"
        );
        assert_eq!(
            err(&with(&base, |v| v["waypoints"][1]["uri"] = "https://www.openstreetmap.org/node/240109189?x".into())),
            "Validation Error: waypoints[1].uri must be a canonical OpenStreetMap object URL, https://www.openstreetmap.org/{node|way|relation}/{id}: https://www.openstreetmap.org/node/240109189?x"
        );
        // any other universal reference passes: a listing, a post, a web page
        assert_eq!(
            validate(&with(&base, |v| v["waypoints"][1]["uri"] =
                format!("pubky://{PK}/pub/social/v1/posts/0032SSN7Q4EVG").into())),
            Ok(())
        );
        assert!(err(&with(&base, |v| v["waypoints"][1]["uri"] =
            format!("pubky://{PK}/priv/social/v1/posts/0032SSN7Q4EVG").into()))
        .contains("private object"));
        let max = MAPS_LIMITS.route_waypoint_name_max_length;
        assert_eq!(
            err(&with(&base, |v| v["waypoints"][0]["name"] =
                "n".repeat(max + 1).into())),
            format!(
                "Validation Error: waypoints[0].name must be 1 to {max} code points and not blank"
            )
        );
    }

    #[test]
    fn polyline_measures_and_steps() {
        let base = lakeside();
        let max = MAPS_LIMITS.route_polyline_max_length;
        for bad in ["", "abc def", "é", "x".repeat(max + 1).as_str(), "a\nb"] {
            assert_eq!(
                err(&with(&base, |v| v["polyline"]["encoded"] = bad.into())),
                format!("Validation Error: polyline.encoded must be 1 to {max} characters of the encoded polyline alphabet, ? to ~"),
                "{bad:?}"
            );
        }
        assert_eq!(
            validate(&with(&base, |v| v["polyline"]["encoded"] =
                "?~".repeat(max / 2).into())),
            Ok(())
        );
        let max = MAPS_LIMITS.route_label_max_length;
        assert_eq!(
            err(&with(&base, |v| v["polyline"]["engine"] = " ".into())),
            format!(
                "Validation Error: polyline.engine must be 1 to {max} code points and not blank"
            )
        );
        assert_eq!(
            err(&with(&base, |v| v["polyline"]["profile"] =
                "p".repeat(max + 1).into())),
            format!(
                "Validation Error: polyline.profile must be 1 to {max} code points and not blank"
            )
        );
        for ok in [5, 6] {
            assert_eq!(
                validate(&with(&base, |v| v["polyline"]["precision"] = ok.into())),
                Ok(())
            );
        }
        for bad in [4, 7, 0, -5] {
            assert_eq!(
                err(&with(&base, |v| v["polyline"]["precision"] = bad.into())),
                "Validation Error: polyline.precision must be 5 or 6"
            );
        }
        assert!(err(&with(&base, |v| {
            v["polyline"].as_object_mut().unwrap().remove("precision");
        }))
        .contains("missing field `precision`"));
        let max = MAPS_LIMITS.route_distance_max_metres;
        assert_eq!(
            validate(&with(&base, |v| v["distance_m"] = (max as i64).into())),
            Ok(())
        );
        for bad in [-1i64, max as i64 + 1] {
            assert_eq!(
                err(&with(&base, |v| v["distance_m"] = bad.into())),
                format!("Validation Error: Route distance_m must be 0 to {max} metres")
            );
        }
        let max = MAPS_LIMITS.route_duration_max_seconds;
        assert_eq!(
            err(&with(&base, |v| v["duration_s"] = (max as i64 + 1).into())),
            format!("Validation Error: Route duration_s must be 0 to {max} seconds")
        );
        let max = MAPS_LIMITS.route_elevation_max_metres;
        assert_eq!(
            err(&with(&base, |v| v["elevation_gain_m"] = (-1).into())),
            format!("Validation Error: Route elevation_gain_m must be 0 to {max} metres")
        );
        assert_eq!(
            err(&with(&base, |v| v["elevation_loss_m"] = (max as i64 + 1).into())),
            format!("Validation Error: Route elevation_loss_m must be 0 to {max} metres")
        );
        assert!(err(&with(&base, |v| v["distance_m"] = 1.5.into())).contains("expected i64"));
        let max = MAPS_LIMITS.route_steps_max_count;
        let step = serde_json::json!({ "instruction": "go" });
        assert_eq!(
            err(&with(&base, |v| v["steps"] =
                serde_json::json!(vec![step.clone(); max + 1]))),
            format!("Validation Error: Route cannot have more than {max} steps")
        );
        let max = MAPS_LIMITS.route_step_instruction_max_length;
        assert_eq!(
            err(&with(&base, |v| v["steps"][0]["instruction"] = "".into())),
            format!("Validation Error: steps[0].instruction must be 1 to {max} code points and not blank")
        );
        assert_eq!(
            err(&with(&base, |v| v["steps"][0]["distance_m"] = (-1).into())),
            format!(
                "Validation Error: steps[0].distance_m must be 0 to {} metres",
                MAPS_LIMITS.route_distance_max_metres
            )
        );
        assert_eq!(
            err(&with(&base, |v| v["steps"][0]["duration_s"] = (-1).into())),
            format!(
                "Validation Error: steps[0].duration_s must be 0 to {} seconds",
                MAPS_LIMITS.route_duration_max_seconds
            )
        );
        assert!(err(&with(&base, |v| v["steps"][0]["big"] =
            serde_json::json!(9007199254740992i64)))
        .contains("JSON-safe"));
    }
}
