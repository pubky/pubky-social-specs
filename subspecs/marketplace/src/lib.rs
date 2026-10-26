//! The marketplace sub-spec, a draft for the marketplace team to adopt: the kinds a marketplace
//! writes that no other app must read, on the shared [`PostEnvelope`] under
//! `/{pub,priv}/marketplace/v1/posts/{id}/{editId}.json`.
//!
//! Three kinds: `listing`, something for sale; `drop`, a timed release of listings; `shop`, a
//! seller's storefront. Everything else is a shared primitive the marketplace never copies: a
//! review is a social `rating` with the purchase attestation in `ext.marketplace` ([`review`]), a
//! response to it a reply, the watchlist the buyer's private bookmarks, a listing's keywords
//! social tags on its URI. Instants are integer microseconds, money integer minor units. The
//! model is the fork `BitcoinErrorLog/pubky-app-specs` at `v0.6.2-marketplace.16`, and
//! `README.md` lists every change from it.

use pubky_social_specs::subspec::{self, SubspecPostRef};
use pubky_social_specs::traits::{Root, ValidationCtx};
use pubky_social_specs::{
    AllowedSchemes, ContentReference, MintedVersion, ParsedUri, PostEnvelope, PostKind, PubkyId,
    PubkySocialAttachment, Resource, VALIDATION_LIMITS,
};
use serde::{Deserialize, Serialize};

pub mod drop;
pub mod listing;
pub mod review;
pub mod shop;
pub mod values;

pub use drop::{DropContent, DropFormat, StockDisplay};
pub use listing::{
    AttributeValue, Condition, DigitalLock, FulfillmentMethod, ListingContent, ListingState,
    Package, ReturnPolicy, Sale, SaleFormat, ShippingOption, ShippingPricing, Variant,
};
pub use review::{
    validate_review, verify_attestation, PurchaseClaims, ReviewExt, ReviewRole, VerifiedReview,
};
pub use shop::ShopContent;
pub use values::{Location, Money};

/// The namespace segment every path of this sub-spec carries, and the key of its `ext` members.
pub const NAMESPACE: &str = "marketplace";

/// The kinds an indexer forwards as feed lines only, without a graph node. None: listings,
/// drops and shops are durable posts people tag, rate, bookmark and collect.
pub const FEED_ONLY_KINDS: &[&str] = &[];

/// The kinds of the marketplace sub-spec. `Unknown` is the forwards-compat catch-all: a kind a
/// newer writer used reads, and fails validation.
#[derive(Serialize, Deserialize, Default, Debug, Clone, PartialEq)]
#[serde(from = "String", into = "String")]
#[non_exhaustive]
pub enum MarketplacePostKind {
    #[default]
    Listing,
    Drop,
    Shop,
    Unknown(String),
}

pubky_social_specs::subspec_names!(MarketplacePostKind {
    Listing => "listing",
    Drop => "drop",
    Shop => "shop",
});

impl MarketplacePostKind {
    /// Whether an indexer forwards this kind as a feed line only, see [`FEED_ONLY_KINDS`].
    pub fn is_feed_only(&self) -> bool {
        FEED_ONLY_KINDS.contains(&self.wire_name())
    }

    fn content_cap(&self) -> Option<(&'static str, usize)> {
        let l = &MARKETPLACE_LIMITS;
        match self {
            MarketplacePostKind::Listing => Some(("Listing", l.listing_content_max_length)),
            MarketplacePostKind::Drop => Some(("Drop", l.drop_content_max_length)),
            MarketplacePostKind::Shop => Some(("Shop", l.shop_content_max_length)),
            MarketplacePostKind::Unknown(_) => None,
        }
    }
}

/// A marketplace post: the shared envelope with the marketplace kinds.
pub type MarketplacePost = PostEnvelope<MarketplacePostKind>;

/// The caps of the marketplace kinds, the fork's values wherever the fork had one. Every
/// `*_length` counts code points (an id or a currency counts ASCII characters); the others are
/// named by their unit.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceLimits {
    pub listing_content_max_length: usize,
    pub listing_title_min_length: usize,
    pub listing_title_max_length: usize,
    pub listing_description_max_length: usize,
    pub taxonomy_version_max: u64,
    pub category_id_max_length: usize,
    pub listing_attributes_max_count: usize,
    pub attribute_key_max_length: usize,
    pub attribute_value_max_length: usize,
    pub attribute_values_max_count: usize,
    pub condition_details_max_length: usize,
    pub listing_variants_max_count: usize,
    pub sku_max_length: usize,
    pub variant_options_max_count: usize,
    pub option_key_max_length: usize,
    pub option_value_max_length: usize,
    pub variant_quantity_max: u64,
    pub shipping_options_max_count: usize,
    pub shipping_label_max_length: usize,
    pub shipping_provider_max_length: usize,
    pub shipping_service_code_max_length: usize,
    pub delivery_estimate_max_days: u64,
    pub package_weight_max_grams: u64,
    pub package_dimension_max_millimetres: u64,
    pub return_window_max_days: u64,
    pub return_details_max_length: usize,
    pub anti_sniping_max_seconds: u64,
    pub minimum_confirmations_max: u64,
    pub entity_id_max_length: usize,
    pub currency_min_length: usize,
    pub currency_max_length: usize,
    pub money_exponent_max: u64,
    pub region_max_length: usize,
    pub drop_content_max_length: usize,
    pub drop_title_max_length: usize,
    pub drop_description_max_length: usize,
    pub drop_listings_max_count: usize,
    pub drop_quantity_max: u64,
    pub drop_per_buyer_max: u64,
    pub shop_content_max_length: usize,
    pub shop_name_max_length: usize,
    pub shop_bio_max_length: usize,
    pub shop_policy_max_length: usize,
    pub transaction_service_max_length: usize,
    pub shop_term_max_days: u64,
    pub attestation_min_length: usize,
    pub attestation_max_length: usize,
}

pub const MARKETPLACE_LIMITS: MarketplaceLimits = MarketplaceLimits {
    listing_content_max_length: 100_000,
    listing_title_min_length: 3,
    listing_title_max_length: 80,
    listing_description_max_length: 10_000,
    taxonomy_version_max: 1_000_000,
    category_id_max_length: 120,
    listing_attributes_max_count: 20,
    attribute_key_max_length: 40,
    attribute_value_max_length: 80,
    attribute_values_max_count: 10,
    condition_details_max_length: 1000,
    listing_variants_max_count: 100,
    sku_max_length: 64,
    variant_options_max_count: 3,
    option_key_max_length: 40,
    option_value_max_length: 80,
    variant_quantity_max: 1_000_000,
    shipping_options_max_count: 20,
    shipping_label_max_length: 100,
    shipping_provider_max_length: 50,
    shipping_service_code_max_length: 100,
    delivery_estimate_max_days: 365,
    package_weight_max_grams: 1_000_000,
    package_dimension_max_millimetres: 100_000,
    return_window_max_days: 365,
    return_details_max_length: 4000,
    anti_sniping_max_seconds: 3600,
    minimum_confirmations_max: 6,
    entity_id_max_length: 128,
    currency_min_length: 3,
    currency_max_length: 12,
    money_exponent_max: 18,
    region_max_length: 100,
    drop_content_max_length: 10_000,
    drop_title_max_length: 120,
    drop_description_max_length: 2000,
    drop_listings_max_count: 20,
    drop_quantity_max: 1_000_000,
    drop_per_buyer_max: 100,
    shop_content_max_length: 20_000,
    shop_name_max_length: 60,
    shop_bio_max_length: 1000,
    shop_policy_max_length: 4000,
    transaction_service_max_length: 300,
    shop_term_max_days: 60,
    attestation_min_length: 32,
    attestation_max_length: 4096,
};

impl PostKind for MarketplacePostKind {
    fn is_known(&self) -> bool {
        MarketplacePostKind::is_known(self)
    }

    fn validate_content(&self, post: &MarketplacePost, _ctx: &ValidationCtx) -> Result<(), String> {
        match self {
            MarketplacePostKind::Listing => listing::validate_listing_post(post),
            MarketplacePostKind::Drop => drop::validate_drop_post(post),
            MarketplacePostKind::Shop => shop::validate_shop_post(post),
            // The envelope refused an unknown kind before it dispatched
            MarketplacePostKind::Unknown(_) => Err("Validation Error: post kind is unknown".into()),
        }
    }

    /// The raw content cap, then the lists whose items are read: a listing's variants, shipping
    /// options and attributes, a drop's listings.
    fn check_counts(&self, post: &MarketplacePost) -> Result<(), String> {
        if let Some((name, max)) = self.content_cap() {
            subspec::check_content_cap(name, &post.content, max)?;
        }
        match self {
            MarketplacePostKind::Listing => listing::check_listing_counts(post),
            MarketplacePostKind::Drop => drop::check_drop_counts(post),
            _ => Ok(()),
        }
    }

    fn content_references(&self, post: &MarketplacePost) -> Vec<ContentReference> {
        let max = VALIDATION_LIMITS.reference_uri_max_length;
        let reference = |field: String, uri: String, schemes, max_code_points| ContentReference {
            field,
            uri,
            schemes,
            max_code_points,
        };
        let mut refs = Vec::new();
        match self {
            MarketplacePostKind::Listing => {
                if let Some(place) = listing::parse_listing(post).and_then(|l| l.location) {
                    refs.push(reference(
                        "location.uri".into(),
                        place.uri,
                        AllowedSchemes::Universal,
                        max,
                    ));
                }
            }
            MarketplacePostKind::Drop => {
                if let Some(drop) = drop::parse_drop(post) {
                    for (index, uri) in drop.listings.into_iter().enumerate() {
                        refs.push(reference(
                            format!("listings[{index}]"),
                            uri,
                            AllowedSchemes::PubkyOnly,
                            max,
                        ));
                    }
                }
            }
            MarketplacePostKind::Shop => {
                if let Some(shop) = shop::parse_shop(post) {
                    if let Some(place) = shop.location {
                        refs.push(reference(
                            "location.uri".into(),
                            place.uri,
                            AllowedSchemes::Universal,
                            max,
                        ));
                    }
                    if let Some(service) = shop.transaction_service {
                        refs.push(reference(
                            "transaction_service".into(),
                            service,
                            AllowedSchemes::HttpHttps,
                            MARKETPLACE_LIMITS.transaction_service_max_length,
                        ));
                    }
                }
            }
            MarketplacePostKind::Unknown(_) => {}
        }
        refs
    }

    /// The rules that need the author: a listing's photos are the seller's own files, a drop's
    /// listings the seller's own listings.
    fn check_owner(&self, post: &MarketplacePost, owner: &PubkyId) -> Result<(), String> {
        match self {
            MarketplacePostKind::Listing => {
                for (index, attachment) in post.attachments.iter().enumerate() {
                    let own_file = ParsedUri::try_from(attachment.uri.as_str()).is_ok_and(|p| {
                        &p.user_id == owner && matches!(p.resource, Resource::File(_))
                    });
                    if !own_file {
                        return Err(format!(
                            "Validation Error: attachments[{index}].uri must be a file of the seller: {}",
                            attachment.uri
                        ));
                    }
                }
                Ok(())
            }
            MarketplacePostKind::Drop => drop::check_drop_owner(post, owner),
            _ => Ok(()),
        }
    }
}

fn post_of(
    content: String,
    kind: MarketplacePostKind,
    attachments: Vec<PubkySocialAttachment>,
    lock: Option<String>,
) -> MarketplacePost {
    MarketplacePost::new_with_lock(content, kind, None, None, attachments, lock)
}

/// Builds the listing envelope into `content` and wraps it in a `kind = Listing` post: the
/// photos are `attachments`, the first the cover, each the seller's own file; `lock` is the lock
/// a digital good is released by. Applies the builder trims of [`ListingContent::trimmed`].
/// Infallible; callers validate before writing.
pub fn new_listing(
    listing: ListingContent,
    attachments: Vec<PubkySocialAttachment>,
    lock: Option<String>,
) -> MarketplacePost {
    let content = serde_json::to_string(&listing.trimmed())
        .expect("an envelope of strings, integers and booleans always serializes");
    post_of(content, MarketplacePostKind::Listing, attachments, lock)
}

/// Builds the drop envelope into `content` and wraps it in a `kind = Drop` post, the cover
/// `attachments[0]`. Infallible; callers validate before writing.
pub fn new_drop(drop: DropContent, attachments: Vec<PubkySocialAttachment>) -> MarketplacePost {
    let content = serde_json::to_string(&drop.trimmed())
        .expect("an envelope of strings and integers always serializes");
    post_of(content, MarketplacePostKind::Drop, attachments, None)
}

/// Builds the shop envelope into `content` and wraps it in a `kind = Shop` post, the banner
/// `attachments[0]`. A seller keeps one shop post and edits it. Infallible; callers validate
/// before writing.
pub fn new_shop(shop: ShopContent, attachments: Vec<PubkySocialAttachment>) -> MarketplacePost {
    let content = serde_json::to_string(&shop.trimmed())
        .expect("an envelope of strings, integers and booleans always serializes");
    post_of(content, MarketplacePostKind::Shop, attachments, None)
}

/// Creation: mints the post id, validates under `root` with the author in scope, returns
/// `/{root}/marketplace/v1/posts/{id}/{id}[-{slug}].json`.
pub fn create_version(
    post: &MarketplacePost,
    root: Root,
    owner: &PubkyId,
    slug: Option<&str>,
) -> Result<MintedVersion, String> {
    post.create_version_under(NAMESPACE, root, owner, slug)
}

/// An edit of post `id` whose newest version is `head`: an editId strictly above it.
pub fn edit_version(
    post: &MarketplacePost,
    id: &str,
    head: &str,
    root: Root,
    owner: &PubkyId,
    slug: Option<&str>,
) -> Result<MintedVersion, String> {
    post.edit_version_under(NAMESPACE, id, head, root, owner, slug)
}

/// Reads one stored version: the bytes as written, the rules under `root`, the ownership rules
/// with the author the URI names.
pub fn read_version(
    blob: &[u8],
    id: &str,
    root: Root,
    owner: &PubkyId,
) -> Result<MarketplacePost, String> {
    subspec::read_version(blob, id, root, owner)
}

/// `/{root}/marketplace/v1/posts/{id}/{editId}.json`.
pub fn version_path(root: Root, id: &str, edit_id: &str) -> String {
    subspec::version_path(NAMESPACE, root, id, edit_id)
}

/// `pubky://{owner}/{root}/marketplace/v1/posts/{id}`, the versionless reference to a listing,
/// a drop or a shop: what a rating's `parent`, a tag, a bookmark or a collection item names.
pub fn post_uri(owner: &PubkyId, root: Root, id: &str) -> String {
    subspec::post_uri(owner, NAMESPACE, root, id)
}

/// Classifies `uri` as a marketplace post, versionless or stored; `None` for anything else.
pub fn parse_post_uri(uri: &str) -> Option<SubspecPostRef> {
    subspec::parse_post_uri(NAMESPACE, uri)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_namespace_is_a_namespace() {
        assert_eq!(subspec::validate_namespace(NAMESPACE), Ok(()));
        for kind in MarketplacePostKind::KNOWN {
            assert!(
                !MarketplacePostKind::from(kind.to_string()).is_feed_only(),
                "{kind}"
            );
        }
    }

    #[test]
    fn kinds_read_and_write_by_their_names() {
        for (kind, name) in [
            (MarketplacePostKind::Listing, "listing"),
            (MarketplacePostKind::Drop, "drop"),
            (MarketplacePostKind::Shop, "shop"),
        ] {
            assert_eq!(serde_json::to_string(&kind).unwrap(), format!("\"{name}\""));
        }
        let review: MarketplacePostKind = serde_json::from_str(r#""review""#).unwrap();
        assert_eq!(review, MarketplacePostKind::Unknown("review".into()));
    }
}
