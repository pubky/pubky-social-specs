//! The `drop` kind: a timed release of some of the seller's listings, first come first served.
//! The listings are references to the seller's own listing posts; the cover is
//! `attachments[0]`. The schedule and the counters a drop declares are the transaction service's
//! to enforce; the post says what the seller intends.

use crate::values::{check_instant, check_int, check_text};
use crate::{MarketplacePost, MARKETPLACE_LIMITS, NAMESPACE};
use pubky_social_specs::subspec::{
    check_extra, check_known, parse_content, parse_post_uri, trimmed_or_none,
};
use pubky_social_specs::{frozen_trim, PubkyId};
use serde::{Deserialize, Serialize};

/// How a drop sells: `fcfs`, first come first served. A new format is a new spelling, refused by
/// a reader that does not know it.
#[derive(Serialize, Deserialize, Default, Debug, Clone, PartialEq)]
#[serde(from = "String", into = "String")]
pub enum DropFormat {
    #[default]
    Fcfs,
    Unknown(String),
}
pubky_social_specs::subspec_names!(DropFormat { Fcfs => "fcfs" });

/// How much of the stock a drop shows: `exact`, `bands` or `hidden`.
#[derive(Serialize, Deserialize, Default, Debug, Clone, PartialEq)]
#[serde(from = "String", into = "String")]
pub enum StockDisplay {
    #[default]
    Exact,
    Bands,
    Hidden,
    Unknown(String),
}
pubky_social_specs::subspec_names!(StockDisplay {
    Exact => "exact",
    Bands => "bands",
    Hidden => "hidden",
});

/// Typed JSON envelope stored in a marketplace post's `content` when `kind == Drop`.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
pub struct DropContent {
    /// Trimmed by the builder; 1 to `drop_title_max_length`.
    pub title: String,
    /// Trimmed by the builder, a blank one absent; at most `drop_description_max_length`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub format: DropFormat,
    /// When it opens, integer microseconds since the epoch.
    pub starts_at: i64,
    /// When it closes, after `starts_at`; absent when it ends by selling out or by cancellation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ends_at: Option<i64>,
    /// 1 to `drop_listings_max_count` distinct versionless URIs of the seller's own listing posts.
    #[serde(default)]
    pub listings: Vec<String>,
    /// 1 to `drop_quantity_max` items in all.
    pub total_quantity: i64,
    /// 1 to `drop_per_buyer_max` items a buyer, at most `total_quantity`.
    pub per_buyer_limit: i64,
    pub stock_display: StockDisplay,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl DropContent {
    /// The builder trim: the title, and the description, a blank one absent.
    pub fn trimmed(self) -> Self {
        Self {
            title: frozen_trim(&self.title).to_string(),
            description: self.description.and_then(trimmed_or_none),
            ..self
        }
    }
}

pub(crate) fn parse_drop(post: &MarketplacePost) -> Option<DropContent> {
    serde_json::from_str(&post.content).ok()
}

/// The listing count, before any listing reference is read.
pub(crate) fn check_drop_counts(post: &MarketplacePost) -> Result<(), String> {
    let Some(drop) = parse_drop(post) else {
        return Ok(());
    };
    let max = MARKETPLACE_LIMITS.drop_listings_max_count;
    if !(1..=max).contains(&drop.listings.len()) {
        return Err(format!(
            "Validation Error: Drop must have 1 to {max} listings"
        ));
    }
    Ok(())
}

/// Validates a `kind = Drop` post, its envelope included. Every listing ran through the gate
/// before this, as a pubky reference.
pub(crate) fn validate_drop_post(post: &MarketplacePost) -> Result<(), String> {
    let l = &MARKETPLACE_LIMITS;
    if post.parent.is_some() || post.embed.is_some() {
        return Err("Validation Error: Drop posts cannot have parent or embed".into());
    }
    let drop: DropContent = parse_content("Drop", &post.content, l.drop_content_max_length)?;
    check_extra(
        &drop.extra,
        &[
            "title",
            "description",
            "format",
            "starts_at",
            "ends_at",
            "listings",
            "total_quantity",
            "per_buyer_limit",
            "stock_display",
        ],
    )?;
    check_text("Drop title", &drop.title, 1, l.drop_title_max_length)?;
    if let Some(description) = &drop.description {
        check_text(
            "Drop description",
            description,
            1,
            l.drop_description_max_length,
        )?;
    }
    check_known(
        "Drop format",
        drop.format.is_known(),
        DropFormat::KNOWN,
        drop.format.wire_name(),
    )?;
    check_instant("starts_at", drop.starts_at)?;
    if let Some(ends_at) = drop.ends_at {
        check_instant("ends_at", ends_at)?;
        if ends_at <= drop.starts_at {
            return Err("Validation Error: ends_at must be after starts_at".into());
        }
    }
    for (index, uri) in drop.listings.iter().enumerate() {
        let names_listing = parse_post_uri(NAMESPACE, uri).is_some_and(|p| p.version.is_none());
        if !names_listing {
            return Err(format!(
                "Validation Error: listings[{index}] must reference a marketplace post, versionless: {uri}"
            ));
        }
        if drop.listings[..index].contains(uri) {
            return Err(format!(
                "Validation Error: listings repeats the listing {uri}"
            ));
        }
    }
    check_int(
        "total_quantity",
        drop.total_quantity,
        1,
        l.drop_quantity_max as i64,
        "items",
    )?;
    check_int(
        "per_buyer_limit",
        drop.per_buyer_limit,
        1,
        l.drop_per_buyer_max as i64,
        "items",
    )?;
    if drop.per_buyer_limit > drop.total_quantity {
        return Err("Validation Error: per_buyer_limit must be at most total_quantity".into());
    }
    check_known(
        "Drop stock_display",
        drop.stock_display.is_known(),
        StockDisplay::KNOWN,
        drop.stock_display.wire_name(),
    )?;
    Ok(())
}

/// The rule a drop needs its author for: every listing is the seller's own.
pub(crate) fn check_drop_owner(post: &MarketplacePost, owner: &PubkyId) -> Result<(), String> {
    let Some(drop) = parse_drop(post) else {
        return Ok(());
    };
    let own = format!("pubky://{owner}/");
    for (index, uri) in drop.listings.iter().enumerate() {
        if !uri.starts_with(&own) {
            return Err(format!(
                "Validation Error: listings[{index}] must reference a listing of the same author: {uri}"
            ));
        }
    }
    Ok(())
}
