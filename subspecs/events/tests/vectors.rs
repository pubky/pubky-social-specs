//! The recorded verdicts of `vectors/availability.jsonl`: every rule of the availability kind
//! once, accepted and refused, read as a stored version is read. `RECORD_VECTORS=1 cargo test -p
//! pubky-events-specs --test vectors` rewrites the file after a deliberate change.

use pubky_events_specs::{EventsPostKind, NAMESPACE};
use pubky_social_specs::subspec::vectors::check_vectors;
use serde_json::{json, Value};
use std::path::Path;

const OWNER: &str = "operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo";
const OTHER: &str = "8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo";
const ID: &str = "0032SSN7Q4EVG";

fn url(root: &str) -> String {
    format!("pubky://{OWNER}/{root}/events/v1/posts/{ID}/{ID}.json")
}

fn weekly() -> Value {
    json!({
        "timeZone": "Europe/Zurich", "horizonDays": 60,
        "for": format!("pubky://{OWNER}/pub/marketplace/v1/posts/{ID}"),
        "available": [{ "title": "Office hours", "start": "2026-10-19T09:00:00", "duration": "PT8H",
                        "recurrenceRules": [{ "frequency": "weekly", "byDay": [{ "day": "mo" }, { "day": "tu" }] }] }],
        "busy": [{ "start": "2026-10-21T14:00:00", "duration": "PT1H" }]
    })
}

fn post(content: &Value) -> Value {
    json!({ "content": content.to_string(), "kind": "availability", "parent": null, "embed": null, "attachments": [] })
}

fn with(edit: impl Fn(&mut Value)) -> Value {
    let mut schedule = weekly();
    edit(&mut schedule);
    post(&schedule)
}

#[test]
fn recorded_verdicts_are_current() {
    let block = json!({ "start": "2026-10-19T09:00:00", "duration": "PT1H" });
    let cases: Vec<(&str, &str, Value)> = vec![
        ("a weekly schedule", "pub", post(&weekly())),
        (
            "the least schedule",
            "pub",
            post(&json!({ "timeZone": "UTC", "horizonDays": 1 })),
        ),
        ("a private schedule", "priv", post(&weekly())),
        (
            "unknown members kept",
            "pub",
            with(|v| {
                v["slotMinutes"] = 30.into();
                v["available"][0]["room"] = "A".into();
            }),
        ),
        (
            "a place as the resource",
            "pub",
            with(|v| v["for"] = "https://www.openstreetmap.org/way/481516234".into()),
        ),
        ("a parent", "pub", {
            let mut p = post(&weekly());
            p["parent"] = format!("pubky://{OTHER}/pub/social/v1/posts/{ID}").into();
            p
        }),
        ("an attachment", "pub", {
            let mut p = post(&weekly());
            p["attachments"] = json!([{ "uri": "https://example.com/a.png" }]);
            p
        }),
        (
            "a zone with a space",
            "pub",
            with(|v| v["timeZone"] = "Zurich time".into()),
        ),
        (
            "an offset as the zone",
            "pub",
            with(|v| v["timeZone"] = "+02:00".into()),
        ),
        (
            "a horizon of 0",
            "pub",
            with(|v| v["horizonDays"] = 0.into()),
        ),
        (
            "a horizon of 366",
            "pub",
            with(|v| v["horizonDays"] = 366.into()),
        ),
        (
            "a horizon of 367",
            "pub",
            with(|v| v["horizonDays"] = 367.into()),
        ),
        (
            "no horizon",
            "pub",
            with(|v| {
                v.as_object_mut().unwrap().remove("horizonDays");
            }),
        ),
        (
            "a resource that is not canonical",
            "pub",
            with(|v| v["for"] = " https://x.y".into()),
        ),
        (
            "a private resource on a public schedule",
            "pub",
            with(|v| v["for"] = format!("pubky://{OWNER}/priv/social/v1/posts/{ID}").into()),
        ),
        (
            "100 available blocks",
            "pub",
            with(|v| v["available"] = json!(vec![block.clone(); 100])),
        ),
        (
            "101 available blocks",
            "pub",
            with(|v| v["available"] = json!(vec![block.clone(); 101])),
        ),
        (
            "101 busy blocks",
            "pub",
            with(|v| v["busy"] = json!(vec![block.clone(); 101])),
        ),
        (
            "a titled busy block",
            "pub",
            with(|v| v["busy"][0]["title"] = "Dentist".into()),
        ),
        (
            "a blank title",
            "pub",
            with(|v| v["available"][0]["title"] = " ".into()),
        ),
        (
            "a title of 101",
            "pub",
            with(|v| v["available"][0]["title"] = "t".repeat(101).into()),
        ),
        (
            "a start with an offset",
            "pub",
            with(|v| v["available"][0]["start"] = "2026-10-19T09:00:00Z".into()),
        ),
        (
            "a duration of hours as text",
            "pub",
            with(|v| v["busy"][0]["duration"] = "1h".into()),
        ),
        (
            "a duration of a month",
            "pub",
            with(|v| v["busy"][0]["duration"] = "P1M".into()),
        ),
        (
            "a duration past a leap year",
            "pub",
            with(|v| v["busy"][0]["duration"] = "P367D".into()),
        ),
        (
            "a block without a duration",
            "pub",
            with(|v| {
                v["busy"][0].as_object_mut().unwrap().remove("duration");
            }),
        ),
        (
            "two recurrence rules",
            "pub",
            with(|v| {
                v["available"][0]["recurrenceRules"] =
                    json!([{ "frequency": "weekly" }, { "frequency": "daily" }])
            }),
        ),
        (
            "an hourly rule",
            "pub",
            with(|v| v["available"][0]["recurrenceRules"][0]["frequency"] = "hourly".into()),
        ),
        (
            "an until before the start",
            "pub",
            with(|v| {
                v["available"][0]["recurrenceRules"][0]["until"] = "2026-01-01T00:00:00".into()
            }),
        ),
        (
            "101 excluded dates",
            "pub",
            with(|v| v["available"][0]["excludedDates"] = json!(vec!["2026-12-25T09:00:00"; 101])),
        ),
        (
            "an excluded date alone",
            "pub",
            with(|v| v["available"][0]["excludedDates"] = json!(["2026-12-25"])),
        ),
        (
            "an unsafe integer",
            "pub",
            with(|v| v["available"][0]["x"] = json!(9007199254740992i64)),
        ),
        ("content that is no envelope", "pub", {
            let mut p = post(&weekly());
            p["content"] = "{".into();
            p
        }),
        ("content past the raw cap", "pub", {
            let mut p = post(&weekly());
            p["content"] = "[".repeat(100_001).into();
            p
        }),
        ("a social event under events", "pub", {
            let mut p = post(&weekly());
            p["kind"] = "event".into();
            p
        }),
    ];
    let cases: Vec<(String, String, String)> = cases
        .into_iter()
        .map(|(name, root, object)| (name.to_string(), url(root), object.to_string()))
        .collect();
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("vectors/availability.jsonl");
    let n = check_vectors::<EventsPostKind>(NAMESPACE, &file, &cases).unwrap();
    assert_eq!(n, cases.len());
}
