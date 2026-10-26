//! The recorded verdicts of `vectors/{listing,drop,shop}.jsonl`: each rule of the three kinds
//! once, accepted and refused, read as a stored version is read. `RECORD_VECTORS=1 cargo test
//! -p pubky-marketplace-specs --test vectors` rewrites the files after a deliberate change.

mod common;

use common::*;
use pubky_marketplace_specs::{MarketplacePostKind, NAMESPACE};
use pubky_social_specs::subspec::vectors::check_vectors;
use serde_json::{json, Value};
use std::path::Path;

fn url(root: &str) -> String {
    format!("pubky://{SELLER}/{root}/marketplace/v1/posts/{ID}/{ID}.json")
}

fn record(file: &str, cases: Vec<(&str, &str, Value)>) {
    let cases: Vec<(String, String, String)> = cases
        .into_iter()
        .map(|(name, root, object)| (name.to_string(), url(root), object.to_string()))
        .collect();
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("vectors")
        .join(file);
    let n = check_vectors::<MarketplacePostKind>(NAMESPACE, &path, &cases).unwrap();
    assert_eq!(n, cases.len());
}

fn with(edit: impl Fn(&mut Value)) -> Value {
    let mut listing = listing();
    edit(&mut listing);
    listing_post(&listing)
}

fn auction() -> Value {
    json!({
        "format": "auction", "starting_price": usd(1000), "minimum_increment": usd(100),
        "reserve_price": usd(2000), "buy_now_price": usd(9000),
        "starts_at": 1_792_000_000_000_000i64, "ends_at": 1_792_604_800_000_000i64,
        "anti_sniping_window_s": 300, "anti_sniping_extension_s": 120
    })
}

#[test]
fn listing_verdicts_are_current() {
    let variant = |id: &str| json!({ "id": id, "quantity": 1 });
    record(
        "listing.jsonl",
        vec![
            ("a listing", "pub", listing_post(&listing())),
            ("a private draft", "priv", listing_post(&listing())),
            (
                "unknown members kept",
                "pub",
                with(|v| {
                    v["warranty_months"] = 6.into();
                    v["variants"][0]["color_hex"] = "#c0c0c0".into();
                }),
            ),
            ("an auction", "pub", with(|v| v["sale"] = auction())),
            (
                "pickup only, no location",
                "pub",
                with(|v| {
                    v["fulfillment_methods"] = json!(["pickup"]);
                    v.as_object_mut().unwrap().remove("package");
                    v["shipping_options"] = json!([]);
                    v.as_object_mut().unwrap().remove("location");
                }),
            ),
            ("a parent", "pub", {
                let mut p = listing_post(&listing());
                p["parent"] = listing_uri().into();
                p
            }),
            ("no photo", "pub", post("listing", &listing(), &[])),
            ("a photo of another user", "pub", {
                let mut v = listing();
                v["variants"][0]["media"] = json!([file(BUYER, PHOTO)]);
                post("listing", &v, &[file(BUYER, PHOTO)])
            }),
            ("a photo on the web", "pub", {
                let mut v = listing();
                v["variants"][0]["media"] = json!(["https://example.com/a.png"]);
                post("listing", &v, &["https://example.com/a.png".into()])
            }),
            (
                "a private photo on a public listing",
                "pub",
                post(
                    "listing",
                    &listing(),
                    &[format!("pubky://{SELLER}/priv/social/v1/files/{PHOTO}.png")],
                ),
            ),
            ("a title of 2", "pub", with(|v| v["title"] = "ab".into())),
            (
                "a title of 81",
                "pub",
                with(|v| v["title"] = "t".repeat(81).into()),
            ),
            (
                "a blank description",
                "pub",
                with(|v| v["description"] = " ".into()),
            ),
            (
                "a state this version does not know",
                "pub",
                with(|v| v["state"] = "sold".into()),
            ),
            (
                "a category in snake_case",
                "pub",
                with(|v| v["category_id"] = "electronics_audio".into()),
            ),
            (
                "taxonomy version 0",
                "pub",
                with(|v| v["taxonomy_version"] = 0.into()),
            ),
            (
                "an attribute key with a capital",
                "pub",
                with(|v| v["attributes"] = json!({ "Brand": "Sony" })),
            ),
            (
                "an attribute repeating a value",
                "pub",
                with(|v| v["attributes"] = json!({ "colors": ["red", "red"] })),
            ),
            (
                "21 attributes",
                "pub",
                with(|v| {
                    v["attributes"] = (0..21)
                        .map(|i| (format!("a{i}"), json!("x")))
                        .collect::<serde_json::Map<_, _>>()
                        .into()
                }),
            ),
            (
                "a condition this version does not know",
                "pub",
                with(|v| v["condition"] = "mint".into()),
            ),
            (
                "a place of six fraction digits",
                "pub",
                with(|v| v["location"]["uri"] = "geo:46.123456,8".into()),
            ),
            (
                "a country in lowercase",
                "pub",
                with(|v| v["location"]["country_code"] = "ch".into()),
            ),
            (
                "an OpenStreetMap city",
                "pub",
                with(|v| {
                    v["location"]["uri"] = "https://www.openstreetmap.org/relation/1685013".into()
                }),
            ),
            ("no variant", "pub", with(|v| v["variants"] = json!([]))),
            (
                "101 variants",
                "pub",
                with(|v| {
                    v["variants"] = json!((0..101)
                        .map(|i| variant(&format!("v{i}")))
                        .collect::<Vec<_>>())
                }),
            ),
            (
                "two variants of one id",
                "pub",
                with(|v| v["variants"] = json!([variant("a"), variant("a")])),
            ),
            (
                "a variant photo the post does not carry",
                "pub",
                with(|v| {
                    v["variants"][0]["media"] = json!([file(SELLER, "0000000000000000000000000G")])
                }),
            ),
            (
                "a variant price in another asset",
                "pub",
                with(|v| {
                    v["variants"][0]["price_override"] =
                        json!({ "amount_minor": 5000, "currency": "SAT", "exponent": 0 })
                }),
            ),
            (
                "an active listing out of stock",
                "pub",
                with(|v| v["variants"][0]["quantity"] = 0.into()),
            ),
            (
                "a paused listing out of stock",
                "pub",
                with(|v| {
                    v["state"] = "paused".into();
                    v["variants"][0]["quantity"] = 0.into();
                }),
            ),
            (
                "a price of zero",
                "pub",
                with(|v| v["sale"]["unit_price"]["amount_minor"] = 0.into()),
            ),
            (
                "a currency in lowercase",
                "pub",
                with(|v| v["sale"]["unit_price"]["currency"] = "usd".into()),
            ),
            (
                "an exponent of 19",
                "pub",
                with(|v| v["sale"]["unit_price"]["exponent"] = 19.into()),
            ),
            (
                "a fixed price with an auction's end",
                "pub",
                with(|v| v["sale"]["ends_at"] = 1_792_604_800_000_000i64.into()),
            ),
            (
                "an auction ending before it starts",
                "pub",
                with(|v| {
                    v["sale"] = auction();
                    v["sale"]["ends_at"] = 1_791_000_000_000_000i64.into();
                }),
            ),
            (
                "milliseconds are not told from microseconds",
                "pub",
                with(|v| {
                    v["sale"] = auction();
                    v["sale"]["starts_at"] = 1_792_000_000_000i64.into();
                    v["sale"]["ends_at"] = 1_792_604_800_000i64.into();
                }),
            ),
            (
                "an auction time as text",
                "pub",
                with(|v| {
                    v["sale"] = auction();
                    v["sale"]["starts_at"] = "2026-10-20T10:00:00Z".into();
                }),
            ),
            (
                "a reserve below the start",
                "pub",
                with(|v| {
                    v["sale"] = auction();
                    v["sale"]["reserve_price"] = usd(500);
                }),
            ),
            (
                "an anti-sniping window past an hour",
                "pub",
                with(|v| {
                    v["sale"] = auction();
                    v["sale"]["anti_sniping_window_s"] = 3601.into();
                }),
            ),
            (
                "an auction of two variants",
                "pub",
                with(|v| {
                    v["sale"] = auction();
                    v["variants"] = json!([variant("a"), variant("b")]);
                }),
            ),
            (
                "a sale format this version does not know",
                "pub",
                with(|v| v["sale"]["format"] = "raffle".into()),
            ),
            (
                "no fulfillment method",
                "pub",
                with(|v| v["fulfillment_methods"] = json!([])),
            ),
            (
                "physical with no package",
                "pub",
                with(|v| {
                    v.as_object_mut().unwrap().remove("package");
                }),
            ),
            (
                "physical with no shipping option",
                "pub",
                with(|v| v["shipping_options"] = json!([])),
            ),
            (
                "a package of 0 grams",
                "pub",
                with(|v| v["package"]["weight_g"] = 0.into()),
            ),
            (
                "a flat option with no price",
                "pub",
                with(|v| {
                    v["shipping_options"][0]
                        .as_object_mut()
                        .unwrap()
                        .remove("price");
                }),
            ),
            (
                "a free option of 0 days",
                "pub",
                with(
                    |v| v["shipping_options"] = json!([{ "id": "free", "pricing": "free", "label": "Free", "estimated_min_days": 0, "estimated_max_days": 0 }]),
                ),
            ),
            (
                "an estimate ending before it starts",
                "pub",
                with(|v| v["shipping_options"][0]["estimated_max_days"] = 0.into()),
            ),
            (
                "a calculated option with no provider",
                "pub",
                with(
                    |v| v["shipping_options"] = json!([{ "id": "c", "pricing": "calculated", "label": "Carrier", "service_code": "X", "estimated_min_days": 1, "estimated_max_days": 2 }]),
                ),
            ),
            (
                "returns accepted with no window",
                "pub",
                with(|v| {
                    v["return_policy"]
                        .as_object_mut()
                        .unwrap()
                        .remove("return_window_days");
                }),
            ),
            (
                "no returns with a window",
                "pub",
                with(|v| v["return_policy"]["accepts_returns"] = false.into()),
            ),
            ("a digital good behind a lock", "pub", {
                let mut v = listing();
                v["fulfillment_methods"] = json!(["digital"]);
                v.as_object_mut().unwrap().remove("package");
                v["shipping_options"] = json!([]);
                v["digital_lock"] =
                    json!({ "resource_hash": "0".repeat(64), "minimum_confirmations": 1 });
                let mut p = listing_post(&v);
                p["lock"] = format!("pubky://{SELLER}/pub/locks/v1/posts/{ID}").into();
                p
            }),
            (
                "a digital_lock with no lock",
                "pub",
                with(|v| {
                    v["fulfillment_methods"] = json!(["physical", "digital"]);
                    v["digital_lock"] =
                        json!({ "resource_hash": "0".repeat(64), "minimum_confirmations": 1 });
                }),
            ),
            ("a lock on a physical listing", "pub", {
                let mut p = listing_post(&listing());
                p["lock"] = format!("pubky://{SELLER}/pub/locks/v1/posts/{ID}").into();
                p
            }),
            ("content past the raw cap", "pub", {
                let mut p = listing_post(&listing());
                p["content"] = "[".repeat(100_001).into();
                p
            }),
            (
                "the fork's listing record",
                "pub",
                listing_post(&json!({
                    "schemaVersion": 1, "recordType": "listing", "listingId": "2577a25c412e44a7bc56118c91d98623",
                    "title": "Issue 12 staging proof", "state": "active"
                })),
            ),
        ],
    );
}

fn drop() -> Value {
    json!({
        "title": "Spring drop", "description": "Ten numbered prints.", "format": "fcfs",
        "starts_at": 1_792_000_000_000_000i64, "ends_at": 1_792_086_400_000_000i64,
        "listings": [listing_uri()], "total_quantity": 10, "per_buyer_limit": 2, "stock_display": "bands"
    })
}

#[test]
fn drop_verdicts_are_current() {
    let edit = |f: &dyn Fn(&mut Value)| {
        let mut d = drop();
        f(&mut d);
        post("drop", &d, &[file(SELLER, PHOTO)])
    };
    record(
        "drop.jsonl",
        vec![
            ("a drop", "pub", edit(&|_| {})),
            (
                "a drop ending by selling out",
                "pub",
                edit(&|d| {
                    d.as_object_mut().unwrap().remove("ends_at");
                }),
            ),
            ("no listing", "pub", edit(&|d| d["listings"] = json!([]))),
            (
                "21 listings",
                "pub",
                edit(&|d| d["listings"] = json!(vec![listing_uri(); 21])),
            ),
            (
                "a listing twice",
                "pub",
                edit(&|d| d["listings"] = json!([listing_uri(), listing_uri()])),
            ),
            (
                "a listing of another seller",
                "pub",
                edit(&|d| {
                    d["listings"] =
                        json!([format!("pubky://{BUYER}/pub/marketplace/v1/posts/{ID}")])
                }),
            ),
            (
                "a listing version",
                "pub",
                edit(&|d| d["listings"] = json!([format!("{}/{ID}.json", listing_uri())])),
            ),
            (
                "a social post as a listing",
                "pub",
                edit(&|d| {
                    d["listings"] = json!([format!("pubky://{SELLER}/pub/social/v1/posts/{ID}")])
                }),
            ),
            (
                "a web page as a listing",
                "pub",
                edit(&|d| d["listings"] = json!(["https://shop.example.com/item/1"])),
            ),
            (
                "an end before the start",
                "pub",
                edit(&|d| d["ends_at"] = 1_791_000_000_000_000i64.into()),
            ),
            (
                "a format this version does not know",
                "pub",
                edit(&|d| d["format"] = "lottery".into()),
            ),
            (
                "a per-buyer limit past the total",
                "pub",
                edit(&|d| d["per_buyer_limit"] = 11.into()),
            ),
            (
                "a per-buyer limit of 101",
                "pub",
                edit(&|d| {
                    d["total_quantity"] = 1000.into();
                    d["per_buyer_limit"] = 101.into();
                }),
            ),
            (
                "a stock display this version does not know",
                "pub",
                edit(&|d| d["stock_display"] = "fuzzy".into()),
            ),
            ("a blank title", "pub", edit(&|d| d["title"] = "".into())),
        ],
    );
}

fn shop() -> Value {
    json!({
        "name": "Lugano Vintage", "bio": "Old electronics, tested.",
        "location": { "uri": "https://www.openstreetmap.org/relation/1685013", "country_code": "CH" },
        "shipping_policy": "Ships within two days.", "return_policy": "14 days.",
        "vacation_mode": false, "transaction_service": "https://shop.example.com/api",
        "delivery_assume_days": 14, "auto_complete_days": 7
    })
}

#[test]
fn shop_verdicts_are_current() {
    let edit = |f: &dyn Fn(&mut Value)| {
        let mut s = shop();
        f(&mut s);
        post("shop", &s, &[file(SELLER, PHOTO)])
    };
    record(
        "shop.jsonl",
        vec![
            ("a shop", "pub", edit(&|_| {})),
            (
                "the least shop",
                "pub",
                post("shop", &json!({ "name": "S" }), &[]),
            ),
            (
                "a name of 61",
                "pub",
                edit(&|s| s["name"] = "n".repeat(61).into()),
            ),
            ("a blank bio", "pub", edit(&|s| s["bio"] = " ".into())),
            (
                "an http service",
                "pub",
                edit(&|s| s["transaction_service"] = "http://shop.example.com/api".into()),
            ),
            (
                "a service with a query",
                "pub",
                edit(&|s| s["transaction_service"] = "https://shop.example.com/api?k=1".into()),
            ),
            (
                "a pubky service",
                "pub",
                edit(&|s| {
                    s["transaction_service"] =
                        format!("pubky://{SELLER}/pub/social/v1/profile.json").into()
                }),
            ),
            (
                "a delivery term of 61 days",
                "pub",
                edit(&|s| s["delivery_assume_days"] = 61.into()),
            ),
            ("a parent", "pub", {
                let mut p = post("shop", &shop(), &[]);
                p["parent"] = listing_uri().into();
                p
            }),
        ],
    );
}
