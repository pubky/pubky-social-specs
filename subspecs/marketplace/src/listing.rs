//! The `listing` kind: something for sale, as a post. The photos are the post's attachments, the
//! first the cover; the seller's keywords are social tags on the listing's URI; a digital good's
//! lock is the post's `lock`. Members are the marketplace fork's, spelled snake_case.

use crate::values::{
    check_entity_id, check_instant, check_int, check_location, check_money, check_optional_text,
    check_text, is_lower_hex, Amount, Location, Money,
};
use crate::{MarketplacePost, MARKETPLACE_LIMITS};
use pubky_social_specs::frozen_trim;
use pubky_social_specs::subspec::{check_extra, check_known, parse_content, trimmed_or_none};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Where a listing is in its life, as its seller says: `active`, `paused`, `ended` or `removed`.
/// What is in stock and what is paid is the transaction service's, never this record's.
#[derive(Serialize, Deserialize, Default, Debug, Clone, PartialEq)]
#[serde(from = "String", into = "String")]
pub enum ListingState {
    #[default]
    Active,
    Paused,
    Ended,
    Removed,
    Unknown(String),
}
pubky_social_specs::subspec_names!(ListingState {
    Active => "active",
    Paused => "paused",
    Ended => "ended",
    Removed => "removed",
});

/// The item's condition.
#[derive(Serialize, Deserialize, Default, Debug, Clone, PartialEq)]
#[serde(from = "String", into = "String")]
pub enum Condition {
    #[default]
    New,
    LikeNew,
    Excellent,
    Good,
    Fair,
    ForParts,
    Unknown(String),
}
pubky_social_specs::subspec_names!(Condition {
    New => "new",
    LikeNew => "like_new",
    Excellent => "excellent",
    Good => "good",
    Fair => "fair",
    ForParts => "for_parts",
});

/// How the buyer gets the item.
#[derive(Serialize, Deserialize, Default, Debug, Clone, PartialEq)]
#[serde(from = "String", into = "String")]
pub enum FulfillmentMethod {
    #[default]
    Physical,
    Digital,
    Pickup,
    Shipping,
    Unknown(String),
}
pubky_social_specs::subspec_names!(FulfillmentMethod {
    Physical => "physical",
    Digital => "digital",
    Pickup => "pickup",
    Shipping => "shipping",
});

/// How the item sells.
#[derive(Serialize, Deserialize, Default, Debug, Clone, PartialEq)]
#[serde(from = "String", into = "String")]
pub enum SaleFormat {
    #[default]
    FixedPrice,
    Auction,
    Unknown(String),
}
pubky_social_specs::subspec_names!(SaleFormat {
    FixedPrice => "fixed_price",
    Auction => "auction",
});

/// How a shipping option is priced.
#[derive(Serialize, Deserialize, Default, Debug, Clone, PartialEq)]
#[serde(from = "String", into = "String")]
pub enum ShippingPricing {
    #[default]
    Free,
    Flat,
    Calculated,
    Unknown(String),
}
pubky_social_specs::subspec_names!(ShippingPricing {
    Free => "free",
    Flat => "flat",
    Calculated => "calculated",
});

/// An attribute's value: one text, or a list of texts.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(untagged)]
pub enum AttributeValue {
    One(String),
    Many(Vec<String>),
}

/// One purchasable variant: a size, a colour, or the only one.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Variant {
    /// An id unique in the listing.
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sku: Option<String>,
    /// At most `variant_options_max_count` dimensions, as `{"size": "M"}`.
    #[serde(default)]
    pub options: BTreeMap<String, String>,
    /// A price of its own, in the asset of the sale's price.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub price_override: Option<Money>,
    /// The stock the seller intends, 0 to `variant_quantity_max`; the transaction service holds
    /// the real count.
    pub quantity: i64,
    /// The photos of this variant, each one of the post's attachment URIs.
    #[serde(default)]
    pub media: Vec<String>,
    #[serde(default = "enabled")]
    pub enabled: bool,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

fn enabled() -> bool {
    true
}

impl Variant {
    pub fn new(id: &str, quantity: i64) -> Self {
        Self {
            id: id.to_string(),
            sku: None,
            options: BTreeMap::new(),
            price_override: None,
            quantity,
            media: Vec::new(),
            enabled: true,
            extra: Default::default(),
        }
    }
}

/// The terms of the sale. `format` says which members it takes: `unit_price` and
/// `accepts_offers` for a fixed price; `starting_price`, `minimum_increment`, `starts_at`,
/// `ends_at`, the optional `reserve_price` and `buy_now_price` and the anti-sniping window for an
/// auction.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
pub struct Sale {
    pub format: SaleFormat,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit_price: Option<Money>,
    /// A fixed price takes offers; false when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accepts_offers: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub starting_price: Option<Money>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reserve_price: Option<Money>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub buy_now_price: Option<Money>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minimum_increment: Option<Money>,
    /// When bidding opens, integer microseconds since the epoch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub starts_at: Option<i64>,
    /// When bidding closes, integer microseconds since the epoch, after `starts_at`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ends_at: Option<i64>,
    /// A bid this close to the end extends it, 0 to `anti_sniping_max_seconds` seconds; 0 when
    /// absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anti_sniping_window_s: Option<i64>,
    /// By how much, 0 to `anti_sniping_max_seconds` seconds; 0 when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anti_sniping_extension_s: Option<i64>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl Sale {
    /// A fixed price.
    pub fn fixed_price(unit_price: Money, accepts_offers: bool) -> Self {
        Self {
            format: SaleFormat::FixedPrice,
            unit_price: Some(unit_price),
            accepts_offers: Some(accepts_offers),
            ..Default::default()
        }
    }

    /// An auction between two instants, in microseconds.
    pub fn auction(
        starting_price: Money,
        minimum_increment: Money,
        starts_at: i64,
        ends_at: i64,
    ) -> Self {
        Self {
            format: SaleFormat::Auction,
            starting_price: Some(starting_price),
            minimum_increment: Some(minimum_increment),
            starts_at: Some(starts_at),
            ends_at: Some(ends_at),
            ..Default::default()
        }
    }

    /// The price that sets the listing's asset: the unit price, or the starting price.
    pub fn primary_price(&self) -> Option<&Money> {
        match self.format {
            SaleFormat::FixedPrice => self.unit_price.as_ref(),
            SaleFormat::Auction => self.starting_price.as_ref(),
            SaleFormat::Unknown(_) => None,
        }
    }
}

/// One way to ship. `pricing` says which members it takes: `price` for `flat`, `provider` and
/// `service_code` for `calculated`, neither for `free`.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
pub struct ShippingOption {
    pub id: String,
    pub pricing: ShippingPricing,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub price: Option<Money>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_code: Option<String>,
    /// Days to arrive at the earliest, 0 to `delivery_estimate_max_days`.
    pub estimated_min_days: i64,
    /// Days to arrive at the latest, at least `estimated_min_days`.
    pub estimated_max_days: i64,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// The parcel of a physical item.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq, Eq)]
pub struct Package {
    /// Grams, 1 to `package_weight_max_grams`.
    pub weight_g: i64,
    /// Millimetres, 1 to `package_dimension_max_millimetres` each.
    pub length_mm: i64,
    pub width_mm: i64,
    pub height_mm: i64,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// What a buyer may send back.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq, Eq)]
pub struct ReturnPolicy {
    pub accepts_returns: bool,
    /// Days to return, 1 to `return_window_max_days`; set exactly when returns are accepted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub return_window_days: Option<i64>,
    pub buyer_pays_return_shipping: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// What the lock at the post's `lock` checks before it releases a digital good.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq, Eq)]
pub struct DigitalLock {
    /// The criterion of the lock's policy that the purchase meets.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub criterion_id: Option<String>,
    /// The BLAKE3 of the released resource, 64 lowercase hex digits.
    pub resource_hash: String,
    /// On-chain confirmations the payment needs, 0 to `minimum_confirmations_max`.
    pub minimum_confirmations: i64,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// Typed JSON envelope stored in a marketplace post's `content` when `kind == Listing`.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
pub struct ListingContent {
    /// Trimmed by the builder; `listing_title_min_length..=listing_title_max_length`.
    pub title: String,
    /// Trimmed by the builder; 1 to `listing_description_max_length`.
    pub description: String,
    pub state: ListingState,
    /// The version of the category tree `category_id` is read in, 1 to `taxonomy_version_max`.
    pub taxonomy_version: i64,
    /// A kebab-case category of that tree, as `electronics-audio`.
    pub category_id: String,
    /// At most `listing_attributes_max_count` keys, as `{"size": "M", "colors": ["red", "blue"]}`.
    #[serde(default)]
    pub attributes: BTreeMap<String, AttributeValue>,
    pub condition: Condition,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub condition_details: Option<String>,
    /// Where the item is; absent for a digital good.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<Location>,
    /// 1 to `listing_variants_max_count`.
    #[serde(default)]
    pub variants: Vec<Variant>,
    pub sale: Sale,
    /// 1 to 4 distinct methods.
    #[serde(default)]
    pub fulfillment_methods: Vec<FulfillmentMethod>,
    /// Required with `physical`, refused without it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub package: Option<Package>,
    /// At least one with `physical`, none without it; at most `shipping_options_max_count`.
    #[serde(default)]
    pub shipping_options: Vec<ShippingOption>,
    pub return_policy: ReturnPolicy,
    /// With the post's `lock` only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub digital_lock: Option<DigitalLock>,
    #[serde(default)]
    pub adult_only: bool,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl ListingContent {
    /// The builder trim: the title, the description, the condition details (a blank one
    /// absent), the region, each attribute value, each variant's sku and options, each shipping
    /// option's texts and the return details. Ids, URIs, categories and currencies pass through.
    pub fn trimmed(self) -> Self {
        let trim = |s: String| frozen_trim(&s).to_string();
        Self {
            title: trim(self.title),
            description: trim(self.description),
            condition_details: self.condition_details.and_then(trimmed_or_none),
            location: self.location.map(Location::trimmed),
            attributes: self
                .attributes
                .into_iter()
                .map(|(k, v)| {
                    let v = match v {
                        AttributeValue::One(s) => AttributeValue::One(trim(s)),
                        AttributeValue::Many(list) => {
                            AttributeValue::Many(list.into_iter().map(trim).collect())
                        }
                    };
                    (k, v)
                })
                .collect(),
            variants: self
                .variants
                .into_iter()
                .map(|v| Variant {
                    sku: v.sku.and_then(trimmed_or_none),
                    options: v
                        .options
                        .into_iter()
                        .map(|(k, val)| (trim(k), trim(val)))
                        .collect(),
                    ..v
                })
                .collect(),
            shipping_options: self
                .shipping_options
                .into_iter()
                .map(|o| ShippingOption {
                    label: trim(o.label),
                    provider: o.provider.map(trim),
                    service_code: o.service_code.map(trim),
                    ..o
                })
                .collect(),
            return_policy: ReturnPolicy {
                details: self.return_policy.details.and_then(trimmed_or_none),
                ..self.return_policy
            },
            ..self
        }
    }

    /// The location's place, the envelope's one reference position.
    pub fn place(&self) -> Option<&str> {
        self.location.as_ref().map(|l| l.uri.as_str())
    }
}

/// The envelope when it parses; the kind's validation words the failure.
pub(crate) fn parse_listing(post: &MarketplacePost) -> Option<ListingContent> {
    serde_json::from_str(&post.content).ok()
}

/// The list caps, before any item of a list is read.
pub(crate) fn check_listing_counts(post: &MarketplacePost) -> Result<(), String> {
    let Some(listing) = parse_listing(post) else {
        return Ok(());
    };
    let l = &MARKETPLACE_LIMITS;
    if !(1..=l.listing_variants_max_count).contains(&listing.variants.len()) {
        return Err(format!(
            "Validation Error: Listing must have 1 to {} variants",
            l.listing_variants_max_count
        ));
    }
    if listing.shipping_options.len() > l.shipping_options_max_count {
        return Err(format!(
            "Validation Error: Listing cannot have more than {} shipping options",
            l.shipping_options_max_count
        ));
    }
    if listing.attributes.len() > l.listing_attributes_max_count {
        return Err(format!(
            "Validation Error: Listing cannot have more than {} attributes",
            l.listing_attributes_max_count
        ));
    }
    Ok(())
}

/// `[a-z0-9]+` parts joined by any of `separators`.
fn is_slug(s: &str, separators: &[char]) -> bool {
    !s.is_empty()
        && s.split(|c| separators.contains(&c)).all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}

/// Validates a `kind = Listing` post, its envelope included. The location ran through the
/// envelope's gate before this; the place conventions run here.
pub(crate) fn validate_listing_post(post: &MarketplacePost) -> Result<(), String> {
    let l = &MARKETPLACE_LIMITS;
    if post.parent.is_some() || post.embed.is_some() {
        return Err("Validation Error: Listing posts cannot have parent or embed".into());
    }
    if post.attachments.is_empty() {
        return Err(
            "Validation Error: Listing posts must have at least one photo in attachments".into(),
        );
    }
    let listing: ListingContent =
        parse_content("Listing", &post.content, l.listing_content_max_length)?;
    check_extra(
        &listing.extra,
        &[
            "title",
            "description",
            "state",
            "taxonomy_version",
            "category_id",
            "attributes",
            "condition",
            "condition_details",
            "location",
            "variants",
            "sale",
            "fulfillment_methods",
            "package",
            "shipping_options",
            "return_policy",
            "digital_lock",
            "adult_only",
        ],
    )?;
    check_text(
        "Listing title",
        &listing.title,
        l.listing_title_min_length,
        l.listing_title_max_length,
    )?;
    check_text(
        "Listing description",
        &listing.description,
        1,
        l.listing_description_max_length,
    )?;
    check_known(
        "Listing state",
        listing.state.is_known(),
        ListingState::KNOWN,
        listing.state.wire_name(),
    )?;
    check_int(
        "taxonomy_version",
        listing.taxonomy_version,
        1,
        l.taxonomy_version_max as i64,
        "versions",
    )?;
    if listing.category_id.len() > l.category_id_max_length
        || !is_slug(&listing.category_id, &['-'])
    {
        return Err(format!(
            "Validation Error: category_id must be 1 to {} characters of a-z and 0-9 in parts joined by -: {}",
            l.category_id_max_length, listing.category_id
        ));
    }
    for (key, value) in &listing.attributes {
        if key.len() > l.attribute_key_max_length || !is_slug(key, &['-', '_']) {
            return Err(format!(
                "Validation Error: attributes key must be 1 to {} characters of a-z and 0-9 in parts joined by - or _: {key}",
                l.attribute_key_max_length
            ));
        }
        let field = format!("attributes.{key}");
        match value {
            AttributeValue::One(text) => check_text(&field, text, 1, l.attribute_value_max_length)?,
            AttributeValue::Many(list) => {
                if !(1..=l.attribute_values_max_count).contains(&list.len()) {
                    return Err(format!(
                        "Validation Error: {field} must have 1 to {} values",
                        l.attribute_values_max_count
                    ));
                }
                for (i, text) in list.iter().enumerate() {
                    check_text(
                        &format!("{field}[{i}]"),
                        text,
                        1,
                        l.attribute_value_max_length,
                    )?;
                    if list[..i].contains(text) {
                        return Err(format!(
                            "Validation Error: {field} repeats the value {text}"
                        ));
                    }
                }
            }
        }
    }
    check_known(
        "Listing condition",
        listing.condition.is_known(),
        Condition::KNOWN,
        listing.condition.wire_name(),
    )?;
    check_optional_text(
        "condition_details",
        &listing.condition_details,
        l.condition_details_max_length,
    )?;
    if let Some(location) = &listing.location {
        check_location(location)?;
    }
    validate_sale(&listing)?;
    validate_variants(post, &listing)?;
    validate_fulfillment(post, &listing)?;
    Ok(())
}

fn validate_sale(listing: &ListingContent) -> Result<(), String> {
    let l = &MARKETPLACE_LIMITS;
    let sale = &listing.sale;
    check_extra(
        &sale.extra,
        &[
            "format",
            "unit_price",
            "accepts_offers",
            "starting_price",
            "reserve_price",
            "buy_now_price",
            "minimum_increment",
            "starts_at",
            "ends_at",
            "anti_sniping_window_s",
            "anti_sniping_extension_s",
        ],
    )?;
    check_known(
        "sale.format",
        sale.format.is_known(),
        SaleFormat::KNOWN,
        sale.format.wire_name(),
    )?;
    let fixed_members = sale.unit_price.is_some() || sale.accepts_offers.is_some();
    let auction_members = sale.starting_price.is_some()
        || sale.reserve_price.is_some()
        || sale.buy_now_price.is_some()
        || sale.minimum_increment.is_some()
        || sale.starts_at.is_some()
        || sale.ends_at.is_some()
        || sale.anti_sniping_window_s.is_some()
        || sale.anti_sniping_extension_s.is_some();
    match sale.format {
        SaleFormat::FixedPrice => {
            if auction_members {
                return Err(
                    "Validation Error: a fixed_price sale carries no auction members".into(),
                );
            }
            let Some(price) = &sale.unit_price else {
                return Err("Validation Error: a fixed_price sale needs sale.unit_price".into());
            };
            check_money("sale.unit_price", price, Amount::Positive)?;
        }
        SaleFormat::Auction => {
            if fixed_members {
                return Err(
                    "Validation Error: an auction carries no unit_price or accepts_offers".into(),
                );
            }
            let (Some(start), Some(increment), Some(starts_at), Some(ends_at)) = (
                &sale.starting_price,
                &sale.minimum_increment,
                sale.starts_at,
                sale.ends_at,
            ) else {
                return Err("Validation Error: an auction needs sale.starting_price, sale.minimum_increment, sale.starts_at and sale.ends_at".into());
            };
            check_money("sale.starting_price", start, Amount::Positive)?;
            check_money("sale.minimum_increment", increment, Amount::Positive)?;
            let mut same = vec![("sale.minimum_increment", increment)];
            if let Some(reserve) = &sale.reserve_price {
                check_money("sale.reserve_price", reserve, Amount::Positive)?;
                same.push(("sale.reserve_price", reserve));
            }
            if let Some(buy_now) = &sale.buy_now_price {
                check_money("sale.buy_now_price", buy_now, Amount::Positive)?;
                same.push(("sale.buy_now_price", buy_now));
            }
            for (field, money) in same {
                if !money.same_asset(start) {
                    return Err(format!(
                        "Validation Error: {field} must be in the asset of the sale's price"
                    ));
                }
            }
            if sale
                .reserve_price
                .as_ref()
                .is_some_and(|r| r.amount_minor < start.amount_minor)
            {
                return Err(
                    "Validation Error: sale.reserve_price must be at least sale.starting_price"
                        .into(),
                );
            }
            if sale
                .buy_now_price
                .as_ref()
                .is_some_and(|b| b.amount_minor <= start.amount_minor)
            {
                return Err(
                    "Validation Error: sale.buy_now_price must be above sale.starting_price".into(),
                );
            }
            check_instant("sale.starts_at", starts_at)?;
            check_instant("sale.ends_at", ends_at)?;
            if ends_at <= starts_at {
                return Err("Validation Error: sale.ends_at must be after sale.starts_at".into());
            }
            let max = l.anti_sniping_max_seconds as i64;
            for (field, value) in [
                ("sale.anti_sniping_window_s", sale.anti_sniping_window_s),
                (
                    "sale.anti_sniping_extension_s",
                    sale.anti_sniping_extension_s,
                ),
            ] {
                if let Some(value) = value {
                    check_int(field, value, 0, max, "seconds")?;
                }
            }
            if listing.variants.len() != 1 {
                return Err("Validation Error: an auction sells exactly one variant".into());
            }
        }
        SaleFormat::Unknown(_) => unreachable!("refused above"),
    }
    Ok(())
}

fn validate_variants(post: &MarketplacePost, listing: &ListingContent) -> Result<(), String> {
    let l = &MARKETPLACE_LIMITS;
    let primary = listing.sale.primary_price();
    let mut seen_ids: Vec<&str> = Vec::new();
    let mut seen_skus: Vec<&str> = Vec::new();
    for (index, variant) in listing.variants.iter().enumerate() {
        let at = format!("variants[{index}]");
        check_extra(
            &variant.extra,
            &[
                "id",
                "sku",
                "options",
                "price_override",
                "quantity",
                "media",
                "enabled",
            ],
        )?;
        check_entity_id(&format!("{at}.id"), &variant.id)?;
        if seen_ids.contains(&variant.id.as_str()) {
            return Err(format!(
                "Validation Error: {at}.id repeats the id {}",
                variant.id
            ));
        }
        seen_ids.push(&variant.id);
        if let Some(sku) = &variant.sku {
            check_text(&format!("{at}.sku"), sku, 1, l.sku_max_length)?;
            if seen_skus.contains(&sku.as_str()) {
                return Err(format!("Validation Error: {at}.sku repeats the sku {sku}"));
            }
            seen_skus.push(sku);
        }
        if variant.options.len() > l.variant_options_max_count {
            return Err(format!(
                "Validation Error: {at}.options cannot have more than {} dimensions",
                l.variant_options_max_count
            ));
        }
        for (key, value) in &variant.options {
            check_text(
                &format!("{at}.options key"),
                key,
                1,
                l.option_key_max_length,
            )?;
            check_text(
                &format!("{at}.options.{key}"),
                value,
                1,
                l.option_value_max_length,
            )?;
        }
        if let Some(price) = &variant.price_override {
            let field = format!("{at}.price_override");
            check_money(&field, price, Amount::Positive)?;
            if primary.is_some_and(|p| !p.same_asset(price)) {
                return Err(format!(
                    "Validation Error: {field} must be in the asset of the sale's price"
                ));
            }
        }
        check_int(
            &format!("{at}.quantity"),
            variant.quantity,
            0,
            l.variant_quantity_max as i64,
            "items",
        )?;
        for (i, uri) in variant.media.iter().enumerate() {
            if !post.attachments.iter().any(|a| &a.uri == uri) {
                return Err(format!(
                    "Validation Error: {at}.media[{i}] must be one of the post's attachments: {uri}"
                ));
            }
        }
    }
    if listing.state == ListingState::Active
        && !listing.variants.iter().any(|v| v.enabled && v.quantity > 0)
    {
        return Err("Validation Error: an active listing needs an enabled variant in stock".into());
    }
    Ok(())
}

fn validate_fulfillment(post: &MarketplacePost, listing: &ListingContent) -> Result<(), String> {
    let l = &MARKETPLACE_LIMITS;
    let methods = &listing.fulfillment_methods;
    if !(1..=4).contains(&methods.len()) {
        return Err("Validation Error: Listing must have 1 to 4 fulfillment_methods".into());
    }
    for (index, method) in methods.iter().enumerate() {
        check_known(
            &format!("fulfillment_methods[{index}]"),
            method.is_known(),
            FulfillmentMethod::KNOWN,
            method.wire_name(),
        )?;
        if methods[..index].contains(method) {
            return Err(format!(
                "Validation Error: fulfillment_methods repeats {method}"
            ));
        }
    }
    let physical = methods.contains(&FulfillmentMethod::Physical);
    match (&listing.package, physical) {
        (None, true) => {
            return Err("Validation Error: a physical listing needs a package".into());
        }
        (Some(_), false) => {
            return Err("Validation Error: only a physical listing carries a package".into());
        }
        (Some(package), true) => {
            check_extra(
                &package.extra,
                &["weight_g", "length_mm", "width_mm", "height_mm"],
            )?;
            check_int(
                "package.weight_g",
                package.weight_g,
                1,
                l.package_weight_max_grams as i64,
                "grams",
            )?;
            for (field, value) in [
                ("package.length_mm", package.length_mm),
                ("package.width_mm", package.width_mm),
                ("package.height_mm", package.height_mm),
            ] {
                check_int(
                    field,
                    value,
                    1,
                    l.package_dimension_max_millimetres as i64,
                    "millimetres",
                )?;
            }
        }
        (None, false) => {}
    }
    if physical == listing.shipping_options.is_empty() {
        return Err(if physical {
            "Validation Error: a physical listing needs a shipping option".into()
        } else {
            "Validation Error: only a physical listing carries shipping options".into()
        });
    }
    let primary = listing.sale.primary_price();
    let mut seen: Vec<&str> = Vec::new();
    for (index, option) in listing.shipping_options.iter().enumerate() {
        let at = format!("shipping_options[{index}]");
        check_extra(
            &option.extra,
            &[
                "id",
                "pricing",
                "label",
                "price",
                "provider",
                "service_code",
                "estimated_min_days",
                "estimated_max_days",
            ],
        )?;
        check_entity_id(&format!("{at}.id"), &option.id)?;
        if seen.contains(&option.id.as_str()) {
            return Err(format!(
                "Validation Error: {at}.id repeats the id {}",
                option.id
            ));
        }
        seen.push(&option.id);
        check_known(
            &format!("{at}.pricing"),
            option.pricing.is_known(),
            ShippingPricing::KNOWN,
            option.pricing.wire_name(),
        )?;
        check_text(
            &format!("{at}.label"),
            &option.label,
            1,
            l.shipping_label_max_length,
        )?;
        let calculated = option.provider.is_some() || option.service_code.is_some();
        match option.pricing {
            ShippingPricing::Free => {
                if option.price.is_some() || calculated {
                    return Err(format!(
                        "Validation Error: {at} is free and carries no price, provider or service_code"
                    ));
                }
            }
            ShippingPricing::Flat => {
                let Some(price) = &option.price else {
                    return Err(format!("Validation Error: {at} is flat and needs a price"));
                };
                if calculated {
                    return Err(format!(
                        "Validation Error: {at} is flat and carries no provider or service_code"
                    ));
                }
                check_money(&format!("{at}.price"), price, Amount::NonNegative)?;
                if primary.is_some_and(|p| !p.same_asset(price)) {
                    return Err(format!(
                        "Validation Error: {at}.price must be in the asset of the sale's price"
                    ));
                }
            }
            ShippingPricing::Calculated => {
                let (Some(provider), Some(code)) = (&option.provider, &option.service_code) else {
                    return Err(format!(
                        "Validation Error: {at} is calculated and needs a provider and a service_code"
                    ));
                };
                if option.price.is_some() {
                    return Err(format!(
                        "Validation Error: {at} is calculated and carries no price"
                    ));
                }
                check_text(
                    &format!("{at}.provider"),
                    provider,
                    1,
                    l.shipping_provider_max_length,
                )?;
                check_text(
                    &format!("{at}.service_code"),
                    code,
                    1,
                    l.shipping_service_code_max_length,
                )?;
            }
            ShippingPricing::Unknown(_) => unreachable!("refused above"),
        }
        let max = l.delivery_estimate_max_days as i64;
        check_int(
            &format!("{at}.estimated_min_days"),
            option.estimated_min_days,
            0,
            max,
            "days",
        )?;
        check_int(
            &format!("{at}.estimated_max_days"),
            option.estimated_max_days,
            0,
            max,
            "days",
        )?;
        if option.estimated_max_days < option.estimated_min_days {
            return Err(format!(
                "Validation Error: {at}.estimated_max_days must be at least estimated_min_days"
            ));
        }
    }
    let policy = &listing.return_policy;
    check_extra(
        &policy.extra,
        &[
            "accepts_returns",
            "return_window_days",
            "buyer_pays_return_shipping",
            "details",
        ],
    )?;
    match (policy.accepts_returns, policy.return_window_days) {
        (true, Some(days)) => check_int(
            "return_policy.return_window_days",
            days,
            1,
            l.return_window_max_days as i64,
            "days",
        )?,
        (true, None) => {
            return Err(
                "Validation Error: a return policy that accepts returns needs return_window_days"
                    .into(),
            )
        }
        (false, Some(_)) => return Err(
            "Validation Error: a return policy that accepts no returns has no return_window_days"
                .into(),
        ),
        (false, None) => {}
    }
    check_optional_text(
        "return_policy.details",
        &policy.details,
        l.return_details_max_length,
    )?;
    let digital = methods.contains(&FulfillmentMethod::Digital);
    if post.lock.is_some() && !digital {
        return Err("Validation Error: only a digital listing carries a lock".into());
    }
    if let Some(lock) = &listing.digital_lock {
        if post.lock.is_none() {
            return Err(
                "Validation Error: digital_lock describes the post's lock, which is absent".into(),
            );
        }
        check_extra(
            &lock.extra,
            &["criterion_id", "resource_hash", "minimum_confirmations"],
        )?;
        if let Some(criterion) = &lock.criterion_id {
            check_entity_id("digital_lock.criterion_id", criterion)?;
        }
        if !is_lower_hex(&lock.resource_hash, 64) {
            return Err(format!(
                "Validation Error: digital_lock.resource_hash must be 64 lowercase hex digits: {}",
                lock.resource_hash
            ));
        }
        check_int(
            "digital_lock.minimum_confirmations",
            lock.minimum_confirmations,
            0,
            l.minimum_confirmations_max as i64,
            "confirmations",
        )?;
    }
    Ok(())
}
