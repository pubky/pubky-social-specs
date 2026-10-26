//! The values every marketplace kind shares: money, a location, an in-record id, and the text
//! and closed-set rules the kinds word alike.

use crate::MARKETPLACE_LIMITS;
use pubky_social_specs::places::check_place_reference;
use pubky_social_specs::subspec::check_extra;
use pubky_social_specs::{code_point_len, frozen_trim, MAX_SAFE_JSON_INT};
use serde::{Deserialize, Serialize};

/// An amount in the minor unit its `exponent` implies: cents for `USD`/2, satoshis for `BTC`/8 or
/// `SAT`/0. Two amounts are the same asset when `currency` and `exponent` are both equal.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Money {
    /// An integer count of the minor unit, within the JSON-safe range.
    pub amount_minor: i64,
    /// 3 to 12 characters: an ASCII uppercase letter, then uppercase letters or digits. Not held
    /// to ISO 4217, so `BTC` and `SAT` are currencies.
    pub currency: String,
    /// Decimal places between the minor and the major unit, 0 to 18.
    pub exponent: i64,
    /// Unknown members, preserved on rewrite.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl Money {
    pub fn new(amount_minor: i64, currency: &str, exponent: i64) -> Self {
        Self {
            amount_minor,
            currency: currency.to_string(),
            exponent,
            extra: Default::default(),
        }
    }

    /// Whether `other` counts in the same unit.
    pub fn same_asset(&self, other: &Money) -> bool {
        self.currency == other.currency && self.exponent == other.exponent
    }
}

/// Whether an amount may be zero (a flat shipping price) or must be positive (every price).
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Amount {
    Positive,
    NonNegative,
}

pub(crate) fn check_money(field: &str, money: &Money, amount: Amount) -> Result<(), String> {
    check_extra(&money.extra, &["amount_minor", "currency", "exponent"])?;
    let min = match amount {
        Amount::Positive => 1,
        Amount::NonNegative => 0,
    };
    if money.amount_minor < min || money.amount_minor > MAX_SAFE_JSON_INT {
        return Err(format!(
            "Validation Error: {field}.amount_minor must be {min} to {MAX_SAFE_JSON_INT}"
        ));
    }
    let c = money.currency.as_bytes();
    let (min, max) = (
        MARKETPLACE_LIMITS.currency_min_length,
        MARKETPLACE_LIMITS.currency_max_length,
    );
    if !(min..=max).contains(&c.len())
        || !c[0].is_ascii_uppercase()
        || !c
            .iter()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
    {
        return Err(format!(
            "Validation Error: {field}.currency must be {min} to {max} uppercase letters and digits, starting with a letter: {}",
            money.currency
        ));
    }
    let max = MARKETPLACE_LIMITS.money_exponent_max;
    if !(0..=max as i64).contains(&money.exponent) {
        return Err(format!(
            "Validation Error: {field}.exponent must be 0 to {max}"
        ));
    }
    Ok(())
}

/// Where a thing is: a place as a reference (an OpenStreetMap object, or a `geo:` pin as rough
/// as the seller likes), and optionally a country and a region for the coarse filters.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Location {
    /// A reference on the universal tier under the place conventions; it runs through the
    /// envelope's gate as `location.uri`.
    pub uri: String,
    /// ISO 3166-1 alpha-2, two ASCII uppercase letters; the code list is the reader's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub country_code: Option<String>,
    /// Free text, trimmed by the builder: 1 to `region_max_length` code points.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    /// Unknown members, preserved on rewrite.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl Location {
    pub fn new(uri: String, country_code: Option<String>, region: Option<String>) -> Self {
        Self {
            uri,
            country_code,
            region,
            extra: Default::default(),
        }
    }

    pub(crate) fn trimmed(self) -> Self {
        Self {
            region: self
                .region
                .and_then(pubky_social_specs::subspec::trimmed_or_none),
            ..self
        }
    }
}

/// The location rules, after the envelope's gate admitted `location.uri`.
pub(crate) fn check_location(location: &Location) -> Result<(), String> {
    check_extra(&location.extra, &["uri", "country_code", "region"])?;
    check_place_reference("location.uri", &location.uri)?;
    if let Some(code) = &location.country_code {
        if code.len() != 2 || !code.bytes().all(|b| b.is_ascii_uppercase()) {
            return Err(format!(
                "Validation Error: location.country_code must be two uppercase letters, ISO 3166-1 alpha-2: {code}"
            ));
        }
    }
    if let Some(region) = &location.region {
        check_text(
            "location.region",
            region,
            1,
            MARKETPLACE_LIMITS.region_max_length,
        )?;
    }
    Ok(())
}

/// Display text the builder trimmed, counted as stored: `min` to `max` code points, and not blank
/// when `min` is 1 or more.
pub(crate) fn check_text(field: &str, value: &str, min: usize, max: usize) -> Result<(), String> {
    let len = code_point_len(value);
    if (min > 0 && frozen_trim(value).is_empty()) || len < min || len > max {
        return Err(format!(
            "Validation Error: {field} must be {min} to {max} code points and not blank"
        ));
    }
    Ok(())
}

/// Optional display text: absent, or 1 to `max` code points and not blank.
pub(crate) fn check_optional_text(
    field: &str,
    value: &Option<String>,
    max: usize,
) -> Result<(), String> {
    match value {
        Some(text) => check_text(field, text, 1, max),
        None => Ok(()),
    }
}

/// An id a writer picks inside a record (a variant, a shipping option): 1 to `entity_id_max_length`
/// characters of `A-Z`, `a-z`, `0-9`, `_` and `-`.
pub(crate) fn check_entity_id(field: &str, id: &str) -> Result<(), String> {
    let max = MARKETPLACE_LIMITS.entity_id_max_length;
    if id.is_empty()
        || id.len() > max
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(format!(
            "Validation Error: {field} must be 1 to {max} characters of A-Z, a-z, 0-9, _ and -: {id}"
        ));
    }
    Ok(())
}

/// An integer member within `min..=max`, worded with its unit.
pub(crate) fn check_int(
    field: &str,
    value: i64,
    min: i64,
    max: i64,
    unit: &str,
) -> Result<(), String> {
    pubky_social_specs::subspec::check_range(field, value, min, max, unit)
}

/// An instant: integer microseconds since the epoch, positive and JSON-safe, as social's
/// `created_at` and timestamp ids count.
pub(crate) fn check_instant(field: &str, micros: i64) -> Result<(), String> {
    check_int(field, micros, 1, MAX_SAFE_JSON_INT, "microseconds")
}

/// `n` lowercase hex digits.
pub(crate) fn is_lower_hex(s: &str, n: usize) -> bool {
    s.len() == n
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
