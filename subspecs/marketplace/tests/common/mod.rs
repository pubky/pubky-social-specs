//! What the marketplace tests share: two users, an attestor key, a listing, and the purchase
//! attestation the attestor signs for a review.

#![allow(dead_code)]

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{json, Value};

/// The seller.
pub const SELLER: &str = "operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo";
/// The buyer.
pub const BUYER: &str = "8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo";
pub const ID: &str = "0032SSN7Q4EVG";
pub const ORDER_REF: &str = "5f1d0c3a9b8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a392817060504";
/// The attestor's secret, 32 bytes of 7, as the fork's test vectors use.
pub const ATTESTOR_SECRET: [u8; 32] = [7; 32];

pub fn attestor() -> SigningKey {
    SigningKey::from_bytes(&ATTESTOR_SECRET)
}

/// The attestor's pubky: the z-base-32 of its verifying key.
pub fn attestor_pubky() -> String {
    base32::encode(base32::Alphabet::Z, attestor().verifying_key().as_bytes())
}

pub fn listing_uri() -> String {
    format!("pubky://{SELLER}/pub/marketplace/v1/posts/{ID}")
}

pub fn file(owner: &str, hash: &str) -> String {
    format!("pubky://{owner}/pub/social/v1/files/{hash}.png")
}

pub const PHOTO: &str = "PZBQ010FF079VVZPQG1RNFN6DR";
pub const PHOTO_2: &str = "8Z8CWH8NVYQY39ZEBFGKQWWEKG";

pub fn usd(amount_minor: i64) -> Value {
    json!({ "amount_minor": amount_minor, "currency": "USD", "exponent": 2 })
}

/// A listing every rule accepts: a fixed price, shipped, two photos.
pub fn listing() -> Value {
    json!({
        "title": "Vintage Walkman", "description": "Works, with the original belt clip.",
        "state": "active", "taxonomy_version": 1, "category_id": "electronics-audio",
        "attributes": { "brand": "Sony", "colors": ["silver", "blue"] },
        "condition": "good", "condition_details": "Scratches on the lid.",
        "location": { "uri": "geo:46.01,8.96", "country_code": "CH", "region": "Ticino" },
        "variants": [{ "id": "only", "sku": "WM-2", "options": {}, "quantity": 1, "media": [file(SELLER, PHOTO)], "enabled": true }],
        "sale": { "format": "fixed_price", "unit_price": usd(4999), "accepts_offers": true },
        "fulfillment_methods": ["physical"],
        "package": { "weight_g": 400, "length_mm": 150, "width_mm": 100, "height_mm": 50 },
        "shipping_options": [{ "id": "post", "pricing": "flat", "label": "Swiss Post", "price": usd(900), "estimated_min_days": 1, "estimated_max_days": 3 }],
        "return_policy": { "accepts_returns": true, "return_window_days": 14, "buyer_pays_return_shipping": true },
        "adult_only": false
    })
}

/// A marketplace post of `kind` over `content`, the given attachments, no lock.
pub fn post(kind: &str, content: &Value, attachments: &[String]) -> Value {
    let attachments: Vec<Value> = attachments
        .iter()
        .map(|uri| json!({ "uri": uri }))
        .collect();
    json!({ "content": content.to_string(), "kind": kind, "parent": null, "embed": null, "attachments": attachments })
}

pub fn listing_post(content: &Value) -> Value {
    post(
        "listing",
        content,
        &[file(SELLER, PHOTO), file(SELLER, PHOTO_2)],
    )
}

/// The claims a buyer's purchase of the listing gets.
pub fn claims() -> Value {
    json!({
        "v": 1, "iss": attestor_pubky(), "sub": BUYER, "cpk": SELLER,
        "role": "buyer_reviewing_seller", "listing": listing_uri(), "order_ref": ORDER_REF,
        "completed_on": "2026-10-20", "price_decade": "USD:3", "iat": 1_792_500_000
    })
}

/// The compact JWS of `claims` under `header`, signed by `key`.
pub fn jws_with(header: &Value, claims: &Value, key: &SigningKey) -> String {
    let h = URL_SAFE_NO_PAD.encode(header.to_string());
    let c = URL_SAFE_NO_PAD.encode(claims.to_string());
    let signature = key.sign(format!("{h}.{c}").as_bytes());
    format!("{h}.{c}.{}", URL_SAFE_NO_PAD.encode(signature.to_bytes()))
}

pub fn jws(claims: &Value) -> String {
    jws_with(
        &json!({ "alg": "EdDSA", "typ": "pubky-purchase-attestation+v1" }),
        claims,
        &attestor(),
    )
}

/// A buyer's review of the listing: a social rating with `ext.marketplace`.
pub fn review(claims: &Value) -> Value {
    json!({
        "content": json!({ "rating": 9, "text": "As described, fast shipping." }).to_string(),
        "kind": "rating", "parent": listing_uri(), "embed": null, "attachments": [],
        "ext": { "marketplace": {
            "role": claims["role"], "listing": listing_uri(), "order_ref": ORDER_REF,
            "attestation": jws(claims), "item_accuracy": 10, "shipping": 8, "communication": 10
        } }
    })
}
