//! Reviews. A marketplace review is a social `rating`, the post every app's readers and the
//! indexer's counts already see, with the marketplace's additions in the post's
//! `ext.marketplace` member: the role, the listing, the order reference, the purchase
//! attestation and the sub-ratings. The social reader keeps `ext` as an unknown member; this
//! module checks it.
//!
//! - A buyer rates the listing: the rating's `parent` is the listing post's versionless URI.
//! - A seller rates the buyer: `parent` is the buyer's profile, and `ext.marketplace.listing` the
//!   listing they bought.
//!
//! The stars are social's half stars, 1 to 10 (the fork's 1 to 5 stars, doubled); the
//! sub-ratings take the same scale. A response to a review is a social reply whose `parent` is
//! the rating post, written by the review's subject ([`VerifiedReview::is_authorized_response`]).
//!
//! The attestation is the fork's purchase attestation unchanged, a compact JWS (RFC 7515) signed
//! with EdDSA (RFC 8037) by the transaction service's key, its pubky the `iss` claim; only its
//! `listing` claim names the listing post. Whether an `iss` is trusted is the reader's list,
//! never this crate's.

use crate::values::{check_int, is_lower_hex};
use crate::{MARKETPLACE_LIMITS, NAMESPACE};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use pubky_social_specs::subspec::{check_extra, check_known, parse_post_uri};
use pubky_social_specs::{PubkyId, PubkySocialPost, PubkySocialPostKind};
use serde::{Deserialize, Serialize};

/// The `typ` of a purchase attestation's header.
pub const PURCHASE_ATTESTATION_TYP: &str = "pubky-purchase-attestation+v1";

/// Who reviews whom.
#[derive(Serialize, Deserialize, Default, Debug, Clone, PartialEq)]
#[serde(from = "String", into = "String")]
pub enum ReviewRole {
    #[default]
    BuyerReviewingSeller,
    SellerReviewingBuyer,
    Unknown(String),
}
pubky_social_specs::subspec_names!(ReviewRole {
    BuyerReviewingSeller => "buyer_reviewing_seller",
    SellerReviewingBuyer => "seller_reviewing_buyer",
});

/// The `ext.marketplace` member of a rating post.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ReviewExt {
    pub role: ReviewRole,
    /// The versionless URI of the listing post the purchase was of.
    pub listing: String,
    /// The attestor's salted hash of the order, 64 lowercase hex digits.
    pub order_ref: String,
    /// The purchase attestation, a compact JWS.
    pub attestation: String,
    /// How well the item matched its listing, 1 to 10 half stars.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_accuracy: Option<i64>,
    /// The seller's shipping, 1 to 10 half stars; counted once per order.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shipping: Option<i64>,
    /// The other party's communication, 1 to 10 half stars; counted once per order.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub communication: Option<i64>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// The claims of a purchase attestation, as the fork defines them; closed, so a claim this
/// version does not know is refused.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PurchaseClaims {
    pub v: i64,
    /// The attestor's pubky, the key the signature verifies under.
    pub iss: String,
    /// The reviewer.
    pub sub: String,
    /// The counterparty, the review's subject.
    pub cpk: String,
    pub role: String,
    /// The listing post's versionless URI.
    pub listing: String,
    pub order_ref: String,
    /// The civil date the order completed, `YYYY-MM-DD`: a day on purpose.
    pub completed_on: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amount_band: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub price_decade: Option<String>,
    /// Issuance, integer seconds since the epoch, as JWS counts it.
    pub iat: i64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Header {
    alg: String,
    typ: String,
}

/// A review whose attestation verified and binds to it.
#[derive(Clone, Debug, PartialEq)]
pub struct VerifiedReview {
    pub ext: ReviewExt,
    pub claims: PurchaseClaims,
}

impl VerifiedReview {
    /// The reviewed party: the seller for a buyer's review, the buyer for a seller's.
    pub fn subject(&self) -> &str {
        &self.claims.cpk
    }

    /// Whether a reply by `responder` is the subject's response to this review.
    pub fn is_authorized_response(&self, responder: &PubkyId) -> bool {
        responder.as_ref() == self.subject()
    }

    /// The key a review counts under: once per attestor, order, role and listing, so each item
    /// of an order counts and a second rating of the same purchase does not.
    pub fn count_key(&self) -> String {
        let c = &self.claims;
        format!("{}:{}:{}:{}", c.iss, c.order_ref, c.role, c.listing)
    }
}

fn b64(field: &str, segment: &str) -> Result<Vec<u8>, String> {
    URL_SAFE_NO_PAD
        .decode(segment)
        .map_err(|_| format!("Validation Error: {field} is not unpadded base64url"))
}

/// The pubky as the 32 bytes of its Ed25519 key: z-base-32, 52 characters, spelled canonically.
fn key_bytes(pubky: &str) -> Option<[u8; 32]> {
    PubkyId::try_from(pubky).ok()?;
    let bytes = base32::decode(base32::Alphabet::Z, pubky)?;
    let key: [u8; 32] = bytes.get(..32)?.try_into().ok()?;
    (base32::encode(base32::Alphabet::Z, &key) == pubky).then_some(key)
}

fn is_civil_date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let num = |r: std::ops::Range<usize>| -> Option<u32> {
        let part = &s[r];
        part.bytes()
            .all(|c| c.is_ascii_digit())
            .then(|| part.parse().ok())
            .flatten()
    };
    let (Some(year), Some(month), Some(day)) = (num(0..4), num(5..7), num(8..10)) else {
        return false;
    };
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    year >= 1 && (1..=days).contains(&day)
}

/// `{CURRENCY}:{k}`: a currency as money spells it and a decade of 0 to 18.
fn is_band(s: &str) -> bool {
    let Some((currency, k)) = s.split_once(':') else {
        return false;
    };
    let c = currency.as_bytes();
    (3..=12).contains(&c.len())
        && c[0].is_ascii_uppercase()
        && c.iter()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
        && (1..=2).contains(&k.len())
        && k.bytes().all(|b| b.is_ascii_digit())
        && k.parse::<u8>().is_ok_and(|k| k <= 18)
        && !(k.len() == 2 && k.starts_with('0'))
}

/// Parses a purchase attestation and verifies its signature under the key its `iss` names. The
/// claims come back unbound; [`validate_review`] binds them to a review.
pub fn verify_attestation(jws: &str) -> Result<PurchaseClaims, String> {
    let l = &MARKETPLACE_LIMITS;
    let (min, max) = (l.attestation_min_length, l.attestation_max_length);
    if !(min..=max).contains(&jws.len())
        || !jws
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'~' | b'-'))
    {
        return Err(format!(
            "Validation Error: attestation must be {min} to {max} characters of A-Z, a-z, 0-9, ., _, ~ and -"
        ));
    }
    let parts: Vec<&str> = jws.split('.').collect();
    let [header_b64, claims_b64, signature_b64] = parts.as_slice() else {
        return Err("Validation Error: attestation must be a compact JWS of three segments".into());
    };
    let header: Header = serde_json::from_slice(&b64("attestation header", header_b64)?)
        .map_err(|_| "Validation Error: attestation header must be {alg, typ}".to_string())?;
    if header.alg != "EdDSA" || header.typ != PURCHASE_ATTESTATION_TYP {
        return Err(format!(
            "Validation Error: attestation header must be EdDSA with typ {PURCHASE_ATTESTATION_TYP}"
        ));
    }
    let claims: PurchaseClaims = serde_json::from_slice(&b64("attestation claims", claims_b64)?)
        .map_err(|e| format!("Validation Error: attestation claims: {e}"))?;
    if claims.v != 1 {
        return Err(format!(
            "Validation Error: attestation claims must be version 1: {}",
            claims.v
        ));
    }
    for (claim, value) in [
        ("iss", &claims.iss),
        ("sub", &claims.sub),
        ("cpk", &claims.cpk),
    ] {
        if PubkyId::try_from(value.as_str()).is_err() {
            return Err(format!(
                "Validation Error: attestation {claim} must be a pubky: {value}"
            ));
        }
    }
    if !is_lower_hex(&claims.order_ref, 64) {
        return Err(
            "Validation Error: attestation order_ref must be 64 lowercase hex digits".into(),
        );
    }
    if !is_civil_date(&claims.completed_on) {
        return Err(format!(
            "Validation Error: attestation completed_on must be a date YYYY-MM-DD: {}",
            claims.completed_on
        ));
    }
    for (claim, value) in [
        ("amount_band", &claims.amount_band),
        ("price_decade", &claims.price_decade),
    ] {
        if value.as_deref().is_some_and(|v| !is_band(v)) {
            return Err(format!(
                "Validation Error: attestation {claim} must be CURRENCY:k, k 0 to 18"
            ));
        }
    }
    check_int(
        "attestation iat",
        claims.iat,
        1,
        pubky_social_specs::MAX_SAFE_JSON_INT,
        "seconds",
    )?;
    let signature = b64("attestation signature", signature_b64)?;
    let signature: [u8; 64] = signature
        .try_into()
        .map_err(|_| "Validation Error: attestation signature must be 64 bytes".to_string())?;
    let key = key_bytes(&claims.iss)
        .and_then(|k| ed25519_dalek::VerifyingKey::from_bytes(&k).ok())
        .ok_or_else(|| {
            format!(
                "Validation Error: attestation iss is no Ed25519 key: {}",
                claims.iss
            )
        })?;
    let signed = format!("{header_b64}.{claims_b64}");
    key.verify_strict(
        signed.as_bytes(),
        &ed25519_dalek::Signature::from_bytes(&signature),
    )
    .map_err(|_| "Validation Error: attestation signature does not verify under iss".to_string())?;
    Ok(claims)
}

fn check_half_stars(field: &str, value: Option<i64>) -> Result<(), String> {
    match value {
        Some(v) => check_int(
            field,
            v,
            pubky_social_specs::VALIDATION_LIMITS.rating_min_half_stars as i64,
            pubky_social_specs::VALIDATION_LIMITS.rating_max_half_stars as i64,
            "half stars",
        ),
        None => Ok(()),
    }
}

/// The `ext.marketplace` member of a post, when it has one; the error when it has one that does
/// not read.
pub fn review_ext(post: &PubkySocialPost) -> Option<Result<ReviewExt, String>> {
    let member = post.extra.get("ext")?.get(NAMESPACE)?;
    Some(
        serde_json::from_value(member.clone())
            .map_err(|e| format!("Validation Error: ext.marketplace: {e}")),
    )
}

/// Checks a marketplace review: `post` is a social rating (validated as social validates it,
/// by the caller) by `author`, its `ext.marketplace` reads, its attestation verifies, and the
/// attestation binds to the post: the reviewer is the author, the role, the listing and the
/// order are the review's, and the `parent` is what the role rates.
pub fn validate_review(post: &PubkySocialPost, author: &PubkyId) -> Result<VerifiedReview, String> {
    if post.kind != PubkySocialPostKind::Rating {
        return Err(format!(
            "Validation Error: a marketplace review is a rating post, not {}",
            post.kind
        ));
    }
    let ext = review_ext(post).ok_or_else(|| {
        "Validation Error: a marketplace review carries ext.marketplace".to_string()
    })??;
    check_extra(
        &ext.extra,
        &[
            "role",
            "listing",
            "order_ref",
            "attestation",
            "item_accuracy",
            "shipping",
            "communication",
        ],
    )?;
    check_known(
        "ext.marketplace.role",
        ext.role.is_known(),
        ReviewRole::KNOWN,
        ext.role.wire_name(),
    )?;
    let Some(listing) = parse_post_uri(NAMESPACE, &ext.listing).filter(|p| p.version.is_none())
    else {
        return Err(format!(
            "Validation Error: ext.marketplace.listing must reference a marketplace post, versionless: {}",
            ext.listing
        ));
    };
    if !is_lower_hex(&ext.order_ref, 64) {
        return Err(
            "Validation Error: ext.marketplace.order_ref must be 64 lowercase hex digits".into(),
        );
    }
    check_half_stars("ext.marketplace.item_accuracy", ext.item_accuracy)?;
    check_half_stars("ext.marketplace.shipping", ext.shipping)?;
    check_half_stars("ext.marketplace.communication", ext.communication)?;
    let claims = verify_attestation(&ext.attestation)?;
    let bind = |what: &str, ok: bool| {
        if ok {
            Ok(())
        } else {
            Err(format!(
                "Validation Error: the attestation's {what} is not the review's"
            ))
        }
    };
    bind("sub", claims.sub == author.as_ref())?;
    bind("role", claims.role == ext.role.wire_name())?;
    bind("listing", claims.listing == ext.listing)?;
    bind("order_ref", claims.order_ref == ext.order_ref)?;
    let parent = post.parent.as_deref().unwrap_or("");
    let seller = listing.owner.as_ref();
    match ext.role {
        ReviewRole::BuyerReviewingSeller => {
            bind("cpk", claims.cpk == seller)?;
            if parent != ext.listing {
                return Err(format!(
                    "Validation Error: a buyer's review rates the listing: parent must be {}",
                    ext.listing
                ));
            }
        }
        ReviewRole::SellerReviewingBuyer => {
            if author.as_ref() != seller {
                return Err(format!(
                    "Validation Error: a seller's review is by the listing's seller: {}",
                    ext.listing
                ));
            }
            let profile = format!("pubky://{}/pub/social/v1/profile.json", claims.cpk);
            if parent != profile {
                return Err(format!(
                    "Validation Error: a seller's review rates the buyer: parent must be {profile}"
                ));
            }
        }
        ReviewRole::Unknown(_) => unreachable!("refused above"),
    }
    Ok(VerifiedReview { ext, claims })
}
