//! The forward-compatibility contract: unknown enum values and unknown fields never break a
//! reader. `PubkySocialFile` is not covered: its wire form is raw bytes, not a JSON object.
#![cfg(not(target_arch = "wasm32"))]

use pubky_social_specs::{
    traits::Validatable, PubkySocialArticleContent, PubkySocialAttachment, PubkySocialBookmark,
    PubkySocialCollectionContent, PubkySocialCollectionItem, PubkySocialCollectionLayout,
    PubkySocialFeed, PubkySocialFeedConfig, PubkySocialFeedLayout, PubkySocialFeedReach,
    PubkySocialFeedSort, PubkySocialFollow, PubkySocialMute, PubkySocialPost, PubkySocialPostKind,
    PubkySocialTag, PubkySocialUser, PubkySocialUserLink, PUB_CTX,
};
use serde::de::DeserializeOwned;

const PK: &str = "operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo";

fn config(reach: &str, layout: &str, sort: &str, content: &str) -> String {
    format!(
        r#"{{"tags":null,"reach":"{reach}","layout":"{layout}","sort":"{sort}","content":{content}}}"#
    )
}

#[test]
fn unknown_feed_enum_values_deserialize_to_unknown() {
    let c: PubkySocialFeedConfig =
        serde_json::from_str(&config("galaxy", "columns", "recent", "null")).unwrap();
    assert_eq!(c.reach, PubkySocialFeedReach::Unknown("galaxy".into()));
    let c: PubkySocialFeedConfig =
        serde_json::from_str(&config("all", "spiral", "recent", "null")).unwrap();
    assert_eq!(c.layout, PubkySocialFeedLayout::Unknown("spiral".into()));
    let c: PubkySocialFeedConfig =
        serde_json::from_str(&config("all", "columns", "random", "null")).unwrap();
    assert_eq!(c.sort, PubkySocialFeedSort::Unknown("random".into()));
}

#[test]
fn unknown_primary_feed_enum_fails_validation_with_a_clear_message() {
    for (json, field) in [
        (config("galaxy", "columns", "recent", "null"), "reach"),
        (config("all", "spiral", "recent", "null"), "layout"),
        (config("all", "columns", "random", "null"), "sort"),
    ] {
        let c: PubkySocialFeedConfig = serde_json::from_str(&json).unwrap();
        let err = c.validate(None, &PUB_CTX).unwrap_err();
        assert!(err.contains(field) && err.contains("unknown"), "{err}");
    }
    let feed = format!(
        r#"{{"feed":{},"name":"x","created_at":1727740800000000}}"#,
        config("galaxy", "columns", "recent", "null")
    );
    let f: PubkySocialFeed = serde_json::from_str(&feed).unwrap();
    let err = f.validate(None, &PUB_CTX).unwrap_err();
    assert!(err.contains("reach") && err.contains("unknown"), "{err}");

    // The id-checked read path reports the unknown value, not an id mismatch.
    let err = <PubkySocialFeed as Validatable>::try_from(
        feed.as_bytes(),
        "8Z8CWH8NVYQY39ZEBFGKQWWEKG",
        &PUB_CTX,
    )
    .unwrap_err();
    assert!(err.contains("reach") && err.contains("unknown"), "{err}");
}

/// A v1.x writer that knows a `short` post kind names the file after
/// "all:columns:recent:short::". This reader keeps the name as spelled, so it rebuilds that
/// string and checks the id like any other.
#[test]
fn an_unknown_content_filter_keeps_the_id_checked() {
    let feed = format!(
        r#"{{"feed":{},"name":"Shorts","created_at":1727740800000000}}"#,
        config("all", "columns", "recent", r#""short""#)
    );
    // blake3("all:columns:recent:short::")[..16] in Crockford, what that writer wrote
    let f = <PubkySocialFeed as Validatable>::try_from(
        feed.as_bytes(),
        "CGJ944DEG4TZ7ZGS5F1GYTWRTW",
        &PUB_CTX,
    )
    .unwrap();
    assert_eq!(
        f.feed.content,
        Some(PubkySocialPostKind::Unknown("short".into()))
    );
    let e = <PubkySocialFeed as Validatable>::try_from(
        feed.as_bytes(),
        "8Z8CWH8NVYQY39ZEBFGKQWWEKG",
        &PUB_CTX,
    )
    .unwrap_err();
    assert!(e.contains("Invalid ID"), "{e}");
    // an unknown reach is still a rejection, by name, and the id keeps its spelling rule
    let e = <PubkySocialFeed as Validatable>::try_from(feed.as_bytes(), "not-an-id", &PUB_CTX)
        .unwrap_err();
    assert!(e.contains("Validation Error"), "{e}");
    let broken = feed.replace(r#""reach":"all""#, r#""reach":"short""#);
    let err = <PubkySocialFeed as Validatable>::try_from(
        broken.as_bytes(),
        "CGJ944DEG4TZ7ZGS5F1GYTWRTW",
        &PUB_CTX,
    )
    .unwrap_err();
    assert!(err.contains("reach") && err.contains("unknown"), "{err}");
}

#[test]
fn from_str_never_produces_unknown() {
    assert!("unknown".parse::<PubkySocialFeedReach>().is_err());
    assert!("unknown".parse::<PubkySocialFeedLayout>().is_err());
    assert!("unknown".parse::<PubkySocialFeedSort>().is_err());
    assert!("unknown".parse::<PubkySocialCollectionLayout>().is_err());
    assert!("unknown".parse::<PubkySocialPostKind>().is_err());
}

#[test]
fn unknown_secondary_enum_degrades_instead_of_rejecting() {
    let c: PubkySocialFeedConfig =
        serde_json::from_str(&config("all", "columns", "recent", r#""totally-new-kind""#)).unwrap();
    assert_eq!(
        c.content,
        Some(PubkySocialPostKind::Unknown("totally-new-kind".into()))
    );
    assert_eq!(c.validate(None, &PUB_CTX), Ok(()));

    let c: PubkySocialCollectionContent =
        serde_json::from_str(r#"{"name":"X","layout":"spiral"}"#).unwrap();
    assert_eq!(
        c.layout,
        Some(PubkySocialCollectionLayout::Unknown("spiral".into()))
    );
}

fn round_trips<T: DeserializeOwned + serde::Serialize>(wire: &[&str]) {
    for w in wire {
        let quoted = format!("\"{w}\"");
        let v: T = serde_json::from_str(&quoted).unwrap();
        assert_eq!(serde_json::to_string(&v).unwrap(), quoted);
    }
}

#[test]
fn known_wire_strings_round_trip_and_unknown_serializes_as_unknown() {
    round_trips::<PubkySocialFeedReach>(&["following", "followers", "friends", "all", "wot", "me"]);
    round_trips::<PubkySocialFeedLayout>(&["columns", "wide", "visual", "list"]);
    round_trips::<PubkySocialFeedSort>(&["recent", "popularity"]);
    round_trips::<PubkySocialPostKind>(&[
        "note",
        "article",
        "image",
        "video",
        "link",
        "file",
        "collection",
    ]);
    round_trips::<PubkySocialCollectionLayout>(&["grid", "list", "visual"]);
    assert_eq!(
        serde_json::to_string(&PubkySocialFeedReach::Unknown("galaxy".into())).unwrap(),
        "\"galaxy\""
    );
    assert_eq!(
        serde_json::to_string(&PubkySocialFeedLayout::Unknown("spiral".into())).unwrap(),
        "\"spiral\""
    );
    assert_eq!(
        serde_json::to_string(&PubkySocialFeedSort::Unknown("random".into())).unwrap(),
        "\"random\""
    );
    assert_eq!(
        serde_json::to_string(&PubkySocialPostKind::Unknown("podcast".into())).unwrap(),
        "\"podcast\""
    );
    assert_eq!(
        serde_json::to_string(&PubkySocialCollectionLayout::Unknown("spiral".into())).unwrap(),
        "\"spiral\""
    );
}

#[test]
fn is_known_is_false_only_for_unknown() {
    use PubkySocialFeedLayout as L;
    use PubkySocialFeedReach as R;
    use PubkySocialFeedSort as S;
    for r in [
        R::Following,
        R::Followers,
        R::Friends,
        R::All,
        R::Wot,
        R::Me,
    ] {
        assert!(r.is_known());
    }
    assert!(!R::Unknown("galaxy".into()).is_known());
    for l in [L::Columns, L::Wide, L::Visual, L::List] {
        assert!(l.is_known());
    }
    assert!(!L::Unknown("spiral".into()).is_known());
    for s in [S::Recent, S::Popularity] {
        assert!(s.is_known());
    }
    assert!(!S::Unknown("random".into()).is_known());
    use PubkySocialCollectionLayout as C;
    for c in [C::Grid, C::List, C::Visual] {
        assert!(c.is_known());
    }
    assert!(!C::Unknown("spiral".into()).is_known());
}

fn with_unknown_field(json: &str) -> String {
    let mut v: serde_json::Value = serde_json::from_str(json).unwrap();
    v.as_object_mut()
        .unwrap()
        .insert("__future_field".into(), serde_json::json!({"x": 1}));
    serde_json::to_string(&v).unwrap()
}

fn reads_with_unknown_field<T: DeserializeOwned>(json: &str) {
    serde_json::from_str::<T>(&with_unknown_field(json)).unwrap();
}

#[test]
fn every_json_wire_type_ignores_unknown_fields() {
    let post_uri = format!("pubky://{PK}/pub/pubky.app/posts/0032SSN7Q4EVG");
    reads_with_unknown_field::<PubkySocialUser>(r#"{"name":"Alice"}"#);
    reads_with_unknown_field::<PubkySocialUserLink>(
        r#"{"title":"site","url":"https://example.com/"}"#,
    );
    reads_with_unknown_field::<PubkySocialPost>(
        r#"{"content":"hello","kind":"note","parent":null,"embed":null,"attachments":[]}"#,
    );
    reads_with_unknown_field::<PubkySocialAttachment>(&format!(r#"{{"uri":"{post_uri}"}}"#));
    reads_with_unknown_field::<PubkySocialCollectionContent>(r#"{"name":"Photos","items":[]}"#);
    reads_with_unknown_field::<PubkySocialCollectionItem>(&format!(r#"{{"uri":"{post_uri}"}}"#));
    reads_with_unknown_field::<PubkySocialArticleContent>(r#"{"title":"t","body":"b"}"#);
    reads_with_unknown_field::<PubkySocialTag>(&format!(
        r#"{{"uri":"{post_uri}","label":"rust","created_at":1727740800000000}}"#
    ));
    reads_with_unknown_field::<PubkySocialBookmark>(r#"{"created_at":1727740800000000}"#);
    reads_with_unknown_field::<PubkySocialBookmark>(&format!(
        r#"{{"created_at":1727740800000000,"target":"{post_uri}"}}"#
    ));
    reads_with_unknown_field::<PubkySocialFollow>(r#"{"created_at":1727740800000000}"#);
    reads_with_unknown_field::<PubkySocialMute>(r#"{"created_at":1727740800000000}"#);
    reads_with_unknown_field::<PubkySocialFeedConfig>(&config("all", "list", "popularity", "null"));
    reads_with_unknown_field::<PubkySocialFeed>(&format!(
        r#"{{"feed":{},"name":"All","created_at":1727740800000000}}"#,
        config("all", "list", "popularity", "null")
    ));
}

/// On the wire these enums are strings, a newer name included, and so is their schema: no
/// closed `enum` that would refuse a newer name, no object for the catch-all.
#[cfg(feature = "openapi")]
#[test]
fn the_open_enums_are_strings_in_the_openapi_schema() {
    fn schema<T: utoipa::PartialSchema>() -> serde_json::Value {
        serde_json::to_value(T::schema()).unwrap()
    }
    for s in [
        schema::<PubkySocialPostKind>(),
        schema::<PubkySocialFeedReach>(),
        schema::<PubkySocialFeedLayout>(),
        schema::<PubkySocialFeedSort>(),
        schema::<PubkySocialCollectionLayout>(),
    ] {
        assert_eq!(s["type"], "string", "{s}");
        assert!(s.get("enum").is_none() && s.get("oneOf").is_none(), "{s}");
    }
    assert!(schema::<PubkySocialPostKind>()["description"]
        .as_str()
        .unwrap()
        .contains("collection"));
}
