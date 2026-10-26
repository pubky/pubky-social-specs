//! Reviews: a social rating with `ext.marketplace`, its purchase attestation verified and bound.
//! `vectors/review.jsonl` records each rule's verdict, read as an indexer reads a rating: through
//! the social reader by URI, then `validate_review` with the author the URI names.
//! `RECORD_VECTORS=1 cargo test -p pubky-marketplace-specs --test review` rewrites it.

mod common;

use common::*;
use ed25519_dalek::SigningKey;
use pubky_marketplace_specs::{validate_review, verify_attestation};
use pubky_social_specs::{PubkyId, PubkySocialObject};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;

fn url(author: &str) -> String {
    format!("pubky://{author}/pub/social/v1/posts/{ID}/{ID}.json")
}

/// What an indexer concludes of a rating at `url`: the social read, then the marketplace rules.
fn verdict(url: &str, body: &str) -> String {
    let post = match PubkySocialObject::from_uri(url, body.as_bytes()) {
        Ok(PubkySocialObject::Post(post)) => post,
        Ok(_) => return "Validation Error: not a post".into(),
        Err(e) => return e,
    };
    let author = PubkyId::try_from(&url["pubky://".len()..][..52]).unwrap();
    match validate_review(&post, &author) {
        Ok(review) => format!("ok: counts as {}", review.count_key()),
        Err(e) => e,
    }
}

#[derive(Serialize, Deserialize, PartialEq, Debug)]
struct Vector {
    name: String,
    url: String,
    body: String,
    verdict: String,
}

fn seller_claims() -> Value {
    let mut c = claims();
    c["sub"] = SELLER.into();
    c["cpk"] = BUYER.into();
    c["role"] = "seller_reviewing_buyer".into();
    c
}

#[test]
fn the_attestor_key_is_spelled_as_pubky_spells_it() {
    let keypair = pubky::Keypair::from_secret(&ATTESTOR_SECRET);
    assert_eq!(attestor_pubky(), keypair.public_key().to_z32());
}

#[test]
fn an_attestation_verifies_and_its_claims_come_back() {
    let claims = verify_attestation(&jws(&claims())).unwrap();
    assert_eq!(claims.iss, attestor_pubky());
    assert_eq!(claims.listing, listing_uri());
    let bytes = review(&common::claims()).to_string();
    let PubkySocialObject::Post(post) =
        PubkySocialObject::from_uri(url(BUYER), bytes.as_bytes()).unwrap()
    else {
        unreachable!("a rating is a post")
    };
    let review = validate_review(&post, &PubkyId::try_from(BUYER).unwrap()).unwrap();
    assert_eq!(review.subject(), SELLER);
    assert!(review.is_authorized_response(&PubkyId::try_from(SELLER).unwrap()));
    assert!(!review.is_authorized_response(&PubkyId::try_from(BUYER).unwrap()));
    assert_eq!(review.ext.shipping, Some(8));
}

#[test]
fn recorded_verdicts_are_current() {
    let other_key = SigningKey::from_bytes(&[9; 32]);
    let header = json!({ "alg": "EdDSA", "typ": "pubky-purchase-attestation+v1" });
    let with_ext = |edit: &dyn Fn(&mut Value)| {
        let mut r = review(&claims());
        edit(&mut r["ext"]["marketplace"]);
        r
    };
    let with_claims = |edit: &dyn Fn(&mut Value)| {
        let mut c = claims();
        edit(&mut c);
        let mut r = review(&claims());
        r["ext"]["marketplace"]["attestation"] = jws(&c).into();
        r
    };
    let cases: Vec<(&str, String, Value)> = vec![
        (
            "a buyer's review of the listing",
            url(BUYER),
            review(&claims()),
        ),
        ("a seller's review of the buyer", url(SELLER), {
            let mut r = review(&seller_claims());
            r["parent"] = format!("pubky://{BUYER}/pub/social/v1/profile.json").into();
            r["ext"]["marketplace"]["role"] = "seller_reviewing_buyer".into();
            r
        }),
        (
            "a seller's review whose parent is the listing",
            url(SELLER),
            {
                let mut r = review(&seller_claims());
                r["ext"]["marketplace"]["role"] = "seller_reviewing_buyer".into();
                r
            },
        ),
        (
            "unknown members kept",
            url(BUYER),
            with_ext(&|m| m["photos_ok"] = true.into()),
        ),
        ("no ext.marketplace", url(BUYER), {
            let mut r = review(&claims());
            r.as_object_mut().unwrap().remove("ext");
            r
        }),
        ("another app's ext only", url(BUYER), {
            let mut r = review(&claims());
            r["ext"] = json!({ "music": { "x": 1 } });
            r
        }),
        (
            "the buyer's attestation in another user's rating",
            url(SELLER),
            review(&claims()),
        ),
        ("a parent other than the listing", url(BUYER), {
            let mut r = review(&claims());
            r["parent"] = "https://www.openstreetmap.org/way/481516234".into();
            r
        }),
        (
            "a listing that is no marketplace post",
            url(BUYER),
            with_ext(&|m| {
                m["listing"] = format!("pubky://{SELLER}/pub/social/v1/posts/{ID}").into()
            }),
        ),
        (
            "another order_ref than the attestation's",
            url(BUYER),
            with_ext(&|m| m["order_ref"] = "0".repeat(64).into()),
        ),
        (
            "a role this version does not know",
            url(BUYER),
            with_ext(&|m| m["role"] = "buyer_reviewing_buyer".into()),
        ),
        (
            "a sub-rating of 11 half stars",
            url(BUYER),
            with_ext(&|m| m["shipping"] = 11.into()),
        ),
        (
            "a sub-rating of 0",
            url(BUYER),
            with_ext(&|m| m["item_accuracy"] = 0.into()),
        ),
        ("an attestation signed by another key", url(BUYER), {
            let mut r = review(&claims());
            r["ext"]["marketplace"]["attestation"] =
                jws_with(&header, &claims(), &other_key).into();
            r
        }),
        ("claims edited after signing", url(BUYER), {
            let mut r = review(&claims());
            let signed = jws(&claims());
            let parts: Vec<&str> = signed.split('.').collect();
            let mut forged = claims();
            forged["price_decade"] = "USD:5".into();
            let body = base64::Engine::encode(
                &base64::engine::general_purpose::URL_SAFE_NO_PAD,
                forged.to_string(),
            );
            r["ext"]["marketplace"]["attestation"] =
                format!("{}.{body}.{}", parts[0], parts[2]).into();
            r
        }),
        ("another typ", url(BUYER), {
            let mut r = review(&claims());
            r["ext"]["marketplace"]["attestation"] = jws_with(
                &json!({ "alg": "EdDSA", "typ": "pubky-order-receipt+v1" }),
                &claims(),
                &attestor(),
            )
            .into();
            r
        }),
        (
            "a claim this version does not know",
            url(BUYER),
            with_claims(&|c| c["amount"] = 4999.into()),
        ),
        (
            "claims of version 2",
            url(BUYER),
            with_claims(&|c| c["v"] = 2.into()),
        ),
        (
            "a completion date with a time",
            url(BUYER),
            with_claims(&|c| c["completed_on"] = "2026-10-20T10:00:00Z".into()),
        ),
        (
            "an amount band past 18",
            url(BUYER),
            with_claims(&|c| c["amount_band"] = "SAT:19".into()),
        ),
        (
            "the fork's listing URI in the claims",
            url(BUYER),
            with_claims(&|c| {
                c["listing"] = format!("pubky://{SELLER}/pub/pubky.app/marketplace/v1/listings/2577a25c412e44a7bc56118c91d98623").into()
            }),
        ),
        (
            "an attestation that is no JWS",
            url(BUYER),
            with_ext(&|m| m["attestation"] = "not-a-jws-but-long-enough-to-pass-the-length".into()),
        ),
        ("a note carrying the ext", url(BUYER), {
            let mut r = review(&claims());
            r["kind"] = "note".into();
            r["content"] = "great seller".into();
            r
        }),
        ("eleven half stars on the rating itself", url(BUYER), {
            let mut r = review(&claims());
            r["content"] = json!({ "rating": 11 }).to_string().into();
            r
        }),
    ];
    let fresh: Vec<Vector> = cases
        .into_iter()
        .map(|(name, url, body)| {
            let body = body.to_string();
            Vector {
                name: name.into(),
                verdict: verdict(&url, &body),
                url,
                body,
            }
        })
        .collect();
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("vectors/review.jsonl");
    if std::env::var("RECORD_VECTORS").as_deref() == Ok("1") {
        let lines: Vec<String> = fresh
            .iter()
            .map(|v| serde_json::to_string(v).unwrap())
            .collect();
        std::fs::write(&file, lines.join("\n") + "\n").unwrap();
        return;
    }
    let recorded: Vec<Vector> = std::fs::read_to_string(&file)
        .expect("record with RECORD_VECTORS=1")
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(recorded.len(), fresh.len(), "record with RECORD_VECTORS=1");
    for (want, got) in recorded.iter().zip(&fresh) {
        assert_eq!(
            (&want.name, &want.url, &want.body),
            (&got.name, &got.url, &got.body),
            "case {} changed",
            want.name
        );
        assert_eq!(
            verdict(&want.url, &want.body),
            want.verdict,
            "{}",
            want.name
        );
    }
}
