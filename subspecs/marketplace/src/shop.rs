//! The `shop` kind: a seller's storefront, one current post per author, the newest version
//! winning. The name and the picture people know a seller by are the social profile's; the shop
//! carries what only a buyer needs: the policies, the service that takes orders, the terms. The
//! banner is `attachments[0]`.

use crate::values::{check_int, check_location, check_optional_text, check_text, Location};
use crate::{MarketplacePost, MARKETPLACE_LIMITS};
use pubky_social_specs::subspec::{check_extra, parse_content, trimmed_or_none};
use pubky_social_specs::{code_point_len, frozen_trim};
use serde::{Deserialize, Serialize};

/// Typed JSON envelope stored in a marketplace post's `content` when `kind == Shop`.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
pub struct ShopContent {
    /// Trimmed by the builder; 1 to `shop_name_max_length`.
    pub name: String,
    /// Trimmed by the builder, a blank one absent; at most `shop_bio_max_length`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bio: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<Location>,
    /// Trimmed by the builder, a blank one absent; at most `shop_policy_max_length`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shipping_policy: Option<String>,
    /// Trimmed by the builder, a blank one absent; at most `shop_policy_max_length`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub return_policy: Option<String>,
    /// The shop is paused.
    #[serde(default)]
    pub vacation_mode: bool,
    /// The https service a client sends this shop's checkout, offers, bids and orders to: no
    /// query, no fragment, no user; at most `transaction_service_max_length`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transaction_service: Option<String>,
    /// Days after shipment when delivery is assumed, 1 to `shop_term_max_days`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery_assume_days: Option<i64>,
    /// Days after delivery until an order completes unless a return opens, 1 to
    /// `shop_term_max_days`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_complete_days: Option<i64>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl ShopContent {
    /// The builder trim: the name, and the bio, the policies and the region, a blank one absent.
    pub fn trimmed(self) -> Self {
        Self {
            name: frozen_trim(&self.name).to_string(),
            bio: self.bio.and_then(trimmed_or_none),
            location: self.location.map(Location::trimmed),
            shipping_policy: self.shipping_policy.and_then(trimmed_or_none),
            return_policy: self.return_policy.and_then(trimmed_or_none),
            ..self
        }
    }
}

pub(crate) fn parse_shop(post: &MarketplacePost) -> Option<ShopContent> {
    serde_json::from_str(&post.content).ok()
}

/// Validates a `kind = Shop` post, its envelope included. The location and the transaction
/// service ran through the envelope's gate before this.
pub(crate) fn validate_shop_post(post: &MarketplacePost) -> Result<(), String> {
    let l = &MARKETPLACE_LIMITS;
    if post.parent.is_some() || post.embed.is_some() {
        return Err("Validation Error: Shop posts cannot have parent or embed".into());
    }
    let shop: ShopContent = parse_content("Shop", &post.content, l.shop_content_max_length)?;
    check_extra(
        &shop.extra,
        &[
            "name",
            "bio",
            "location",
            "shipping_policy",
            "return_policy",
            "vacation_mode",
            "transaction_service",
            "delivery_assume_days",
            "auto_complete_days",
        ],
    )?;
    check_text("Shop name", &shop.name, 1, l.shop_name_max_length)?;
    check_optional_text("Shop bio", &shop.bio, l.shop_bio_max_length)?;
    if let Some(location) = &shop.location {
        check_location(location)?;
    }
    check_optional_text(
        "shipping_policy",
        &shop.shipping_policy,
        l.shop_policy_max_length,
    )?;
    check_optional_text(
        "return_policy",
        &shop.return_policy,
        l.shop_policy_max_length,
    )?;
    if let Some(service) = &shop.transaction_service {
        // The gate admitted a canonical web URL of at most the cap; a service is https, with
        // nothing a client would carry along to it
        let host_and_path = service.strip_prefix("https://");
        let plain = host_and_path.is_some_and(|rest| {
            let authority = rest.split('/').next().unwrap_or("");
            !rest.contains(['?', '#']) && !authority.contains('@')
        });
        if !plain || code_point_len(service) > l.transaction_service_max_length {
            return Err(format!(
                "Validation Error: transaction_service must be an https URL with no user, query or fragment: {service}"
            ));
        }
    }
    let max = l.shop_term_max_days as i64;
    for (field, value) in [
        ("delivery_assume_days", shop.delivery_assume_days),
        ("auto_complete_days", shop.auto_complete_days),
    ] {
        if let Some(days) = value {
            check_int(field, days, 1, max, "days")?;
        }
    }
    Ok(())
}
