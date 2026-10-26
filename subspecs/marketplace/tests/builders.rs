//! The builders as a seller's client calls them: trim, mint under the marketplace namespace,
//! read back byte for byte.

mod common;

use common::*;
use pubky_marketplace_specs::*;
use pubky_social_specs::traits::Root;
use pubky_social_specs::{PubkyId, PubkySocialAttachment};

fn seller() -> PubkyId {
    PubkyId::try_from(SELLER).unwrap()
}

fn photo(owner: &str) -> PubkySocialAttachment {
    PubkySocialAttachment::new(file(owner, PHOTO), Some("The front".into()), None)
}

fn walkman() -> ListingContent {
    let mut variant = Variant::new("only", 1);
    variant.sku = Some("  WM-2 ".into());
    variant.media = vec![file(SELLER, PHOTO)];
    ListingContent {
        title: "  Vintage Walkman ".into(),
        description: "Works.\n".into(),
        category_id: "electronics-audio".into(),
        taxonomy_version: 1,
        condition: Condition::Good,
        condition_details: Some(" ".into()),
        location: Some(Location::new(
            "geo:46.01,8.96".into(),
            Some("CH".into()),
            Some(" Ticino ".into()),
        )),
        variants: vec![variant],
        sale: Sale::fixed_price(Money::new(4999, "USD", 2), false),
        fulfillment_methods: vec![FulfillmentMethod::Pickup],
        ..Default::default()
    }
}

#[test]
fn a_listing_builds_trimmed_mints_and_reads_back() {
    let post = new_listing(walkman(), vec![photo(SELLER)], None);
    let content: ListingContent = serde_json::from_str(&post.content).unwrap();
    assert_eq!(content.title, "Vintage Walkman");
    assert_eq!(content.description, "Works.");
    assert_eq!(content.condition_details, None);
    assert_eq!(content.variants[0].sku.as_deref(), Some("WM-2"));
    assert_eq!(content.location.unwrap().region.as_deref(), Some("Ticino"));
    let minted = create_version(&post, Root::Pub, &seller(), Some("walkman")).unwrap();
    assert!(
        minted.path.starts_with("/pub/marketplace/v1/posts/"),
        "{}",
        minted.path
    );
    assert!(minted.path.ends_with("-walkman.json"));
    let bytes = serde_json::to_vec(&post).unwrap();
    assert_eq!(
        read_version(&bytes, &minted.id, Root::Pub, &seller()).unwrap(),
        post
    );
    let edit = edit_version(
        &post,
        &minted.id,
        &minted.edit_id,
        Root::Pub,
        &seller(),
        None,
    )
    .unwrap();
    assert!(edit.edit_id > minted.edit_id);
    let uri = post_uri(&seller(), Root::Pub, &minted.id);
    assert_eq!(parse_post_uri(&uri).unwrap().id, minted.id);
    assert_eq!(
        version_path(Root::Pub, &minted.id, &minted.id),
        format!("/pub/marketplace/v1/posts/{0}/{0}.json", minted.id)
    );
}

#[test]
fn the_owner_rules_run_at_mint() {
    // another user's photo: plain validation has no author and lets it pass, the builder does not
    let mut listing = walkman();
    listing.variants[0].media = vec![file(BUYER, PHOTO)];
    let post = new_listing(listing, vec![photo(BUYER)], None);
    assert!(create_version(&post, Root::Pub, &seller(), None)
        .unwrap_err()
        .contains("must be a file of the seller"));
    let drop = DropContent {
        title: "Spring".into(),
        format: DropFormat::Fcfs,
        starts_at: 1_792_000_000_000_000,
        listings: vec![format!("pubky://{BUYER}/pub/marketplace/v1/posts/{ID}")],
        total_quantity: 1,
        per_buyer_limit: 1,
        stock_display: StockDisplay::Hidden,
        ..Default::default()
    };
    assert!(
        create_version(&new_drop(drop, vec![]), Root::Pub, &seller(), None)
            .unwrap_err()
            .contains("same author")
    );
    // the social namespace is not the marketplace's to write
    let shop = new_shop(
        ShopContent {
            name: "S".into(),
            ..Default::default()
        },
        vec![],
    );
    assert!(shop
        .create_version_under("social", Root::Pub, &seller(), None)
        .unwrap_err()
        .contains("reserved"));
    assert!(create_version(&shop, Root::Pub, &seller(), None).is_ok());
}
