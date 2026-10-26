//! The recorded verdicts of `vectors/route.jsonl`: every rule of the route kind once, accepted
//! and refused, read as a stored version is read. `RECORD_VECTORS=1 cargo test -p
//! pubky-maps-specs --test vectors` rewrites the file after a deliberate change.

use pubky_maps_specs::{MapsPostKind, NAMESPACE};
use pubky_social_specs::subspec::vectors::check_vectors;
use serde_json::{json, Value};
use std::path::Path;

const OWNER: &str = "operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo";
const OTHER: &str = "8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo";
const ID: &str = "0032SSN7Q4EVG";

fn url(root: &str) -> String {
    format!("pubky://{OWNER}/{root}/maps/v1/posts/{ID}/{ID}.json")
}

fn lakeside() -> Value {
    json!({
        "name": "Lakeside loop", "description": "Flat, along the shore.", "activity": "running",
        "waypoints": [{ "uri": "geo:46.00547,8.95186", "name": "Start" }, { "uri": "https://www.openstreetmap.org/node/240109189" }],
        "polyline": { "encoded": "_p~iF~ps|U_ulLnnqC_mqNvxq`@", "engine": "valhalla", "profile": "pedestrian", "precision": 6 },
        "distance_m": 5200, "duration_s": 1800, "elevation_gain_m": 12, "elevation_loss_m": 12,
        "steps": [{ "instruction": "Head south on the promenade", "distance_m": 400, "duration_s": 150 }]
    })
}

fn post(content: &Value) -> Value {
    json!({ "content": content.to_string(), "kind": "route", "parent": null, "embed": null, "attachments": [] })
}

fn with(edit: impl Fn(&mut Value)) -> Value {
    let mut route = lakeside();
    edit(&mut route);
    post(&route)
}

#[test]
fn recorded_verdicts_are_current() {
    let point = json!({ "uri": "geo:46,8" });
    let mut cases: Vec<(&str, &str, Value)> = vec![
        ("a route", "pub", post(&lakeside())),
        ("a private route", "priv", post(&lakeside())),
        (
            "unknown members kept",
            "pub",
            with(|v| {
                v["surface"] = "gravel".into();
                v["waypoints"][0]["elevation_m"] = 273.into();
            }),
        ),
        ("the trail it follows as embed", "pub", {
            let mut p = post(&lakeside());
            p["embed"] = "https://www.openstreetmap.org/relation/1234".into();
            p
        }),
        ("a photo as attachments[0]", "pub", {
            let mut p = post(&lakeside());
            p["attachments"] = json!([{ "uri": format!("pubky://{OWNER}/pub/social/v1/files/PZBQ010FF079VVZPQG1RNFN6DR.png") }]);
            p
        }),
        ("a parent", "pub", {
            let mut p = post(&lakeside());
            p["parent"] = format!("pubky://{OTHER}/pub/social/v1/posts/{ID}").into();
            p
        }),
        ("a blank name", "pub", with(|v| v["name"] = " ".into())),
        (
            "a name of 101",
            "pub",
            with(|v| v["name"] = "n".repeat(101).into()),
        ),
        (
            "a blank description",
            "pub",
            with(|v| v["description"] = "".into()),
        ),
        (
            "an activity with a space",
            "pub",
            with(|v| v["activity"] = "trail run".into()),
        ),
        (
            "an activity of 21",
            "pub",
            with(|v| v["activity"] = "x".repeat(21).into()),
        ),
        (
            "one waypoint",
            "pub",
            with(|v| v["waypoints"] = json!([point])),
        ),
        (
            "100 waypoints",
            "pub",
            with(|v| v["waypoints"] = json!(vec![point.clone(); 100])),
        ),
        (
            "101 waypoints",
            "pub",
            with(|v| v["waypoints"] = json!(vec![point.clone(); 101])),
        ),
        (
            "a geo pin with six fraction digits",
            "pub",
            with(|v| v["waypoints"][1]["uri"] = "geo:46.123456,8".into()),
        ),
        (
            "an OpenStreetMap view, not an object",
            "pub",
            with(|v| {
                v["waypoints"][1]["uri"] = "https://www.openstreetmap.org/#map=19/46.0/8.9".into()
            }),
        ),
        (
            "another OpenStreetMap host",
            "pub",
            with(|v| v["waypoints"][1]["uri"] = "https://osm.org/node/1".into()),
        ),
        (
            "a listing as a waypoint",
            "pub",
            with(|v| {
                v["waypoints"][1]["uri"] =
                    format!("pubky://{OTHER}/pub/marketplace/v1/posts/{ID}").into()
            }),
        ),
        (
            "a private waypoint on a public route",
            "pub",
            with(|v| {
                v["waypoints"][1]["uri"] =
                    format!("pubky://{OWNER}/priv/social/v1/posts/{ID}").into()
            }),
        ),
        (
            "an own private waypoint on a private route",
            "priv",
            with(|v| {
                v["waypoints"][1]["uri"] =
                    format!("pubky://{OWNER}/priv/social/v1/posts/{ID}").into()
            }),
        ),
        (
            "another user's private waypoint on a private route",
            "priv",
            with(|v| {
                v["waypoints"][1]["uri"] =
                    format!("pubky://{OTHER}/priv/social/v1/posts/{ID}").into()
            }),
        ),
        (
            "a blank waypoint name",
            "pub",
            with(|v| v["waypoints"][0]["name"] = " ".into()),
        ),
        (
            "a polyline outside its alphabet",
            "pub",
            with(|v| v["polyline"]["encoded"] = "über".into()),
        ),
        (
            "a polyline of 100000",
            "pub",
            with(|v| v["polyline"]["encoded"] = "?".repeat(100_000).into()),
        ),
        (
            "a polyline of 100001",
            "pub",
            with(|v| v["polyline"]["encoded"] = "?".repeat(100_001).into()),
        ),
        (
            "a blank engine",
            "pub",
            with(|v| v["polyline"]["engine"] = " ".into()),
        ),
        (
            "precision 7",
            "pub",
            with(|v| v["polyline"]["precision"] = 7.into()),
        ),
        (
            "a negative distance",
            "pub",
            with(|v| v["distance_m"] = (-1).into()),
        ),
        (
            "a duration past ten years",
            "pub",
            with(|v| v["duration_s"] = 315_360_001.into()),
        ),
        (
            "a fractional distance",
            "pub",
            with(|v| v["distance_m"] = 1.5.into()),
        ),
        (
            "an elevation gain past the cap",
            "pub",
            with(|v| v["elevation_gain_m"] = 100_001.into()),
        ),
        (
            "501 steps",
            "pub",
            with(|v| v["steps"] = json!(vec![json!({ "instruction": "go" }); 501])),
        ),
        (
            "a blank instruction",
            "pub",
            with(|v| v["steps"][0]["instruction"] = "".into()),
        ),
        (
            "an unsafe integer in a step",
            "pub",
            with(|v| v["steps"][0]["big"] = json!(9007199254740992i64)),
        ),
        ("content that is no envelope", "pub", {
            let mut p = post(&lakeside());
            p["content"] = "a walk".into();
            p
        }),
        ("content past the raw cap", "pub", {
            let mut p = post(&lakeside());
            p["content"] = "[".repeat(400_001).into();
            p
        }),
        ("a kind a newer writer used", "pub", {
            let mut p = post(&lakeside());
            p["kind"] = "track".into();
            p
        }),
        ("a social kind under maps", "pub", {
            let mut p = post(&lakeside());
            p["kind"] = "note".into();
            p
        }),
    ];
    // a version at a path that is no maps post, read under the social namespace
    let mut cases: Vec<(String, String, String)> = cases
        .drain(..)
        .map(|(name, root, object)| (name.to_string(), url(root), object.to_string()))
        .collect();
    cases.push((
        "a route under social".into(),
        format!("pubky://{OWNER}/pub/social/v1/posts/{ID}/{ID}.json"),
        post(&lakeside()).to_string(),
    ));
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("vectors/route.jsonl");
    let n = check_vectors::<MapsPostKind>(NAMESPACE, &file, &cases).unwrap();
    assert_eq!(n, cases.len());
}
