//! Serialized bytes of every retained wire model, pinned as literals so a rename or refactor that
//! changes a serde attribute fails here before it reaches a homeserver. Captured from the 0.8.0
//! crate (commit 3eebe18), before the rename. `{PK}` stands in for the host key.
#![cfg(not(target_arch = "wasm32"))]

use pubky_social_specs::{
    create_bookmark, ParsedUri, PubkyId, PubkySocialAttachment, PubkySocialBookmark,
    PubkySocialCollectionContent, PubkySocialCollectionItem, PubkySocialCollectionLayout,
    PubkySocialFeed, PubkySocialFeedConfig, PubkySocialFeedLayout, PubkySocialFeedReach,
    PubkySocialFeedSort, PubkySocialFollow, PubkySocialMute, PubkySocialPost, PubkySocialPostKind,
    PubkySocialTag, PubkySocialUser, PubkySocialUserLink, Resource, Visibility, VALIDATION_LIMITS,
};
use serde::Serialize;

const PK: &str = "operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo";
const TS: i64 = 1_727_740_800_000_000;
/// base64url of a canonical pubky post reference: a primary bookmark filename.
const B64: &str = "cHVia3k6Ly9vcGVycnI4d3NicHIzdWU5ZDRxajQxZ2Uxa2NjNnI3ZmRpeTZvM3VnanJyaGk0eTc3cmRvL3B1Yi9zb2NpYWwvdjEvcG9zdHMvMDAzMlNTTjdRNEVWRw";

fn json<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap()
}

/// The link url is spelled with its trailing slash: the pinned bytes date from when a URL
/// normalizer added it on the way in. References are stored verbatim now, so the fixture
/// writes the exact bytes it pins and the pin itself never moved.
fn user() -> PubkySocialUser {
    PubkySocialUser::new(
        "Alice".into(),
        Some("bio".into()),
        Some(format!("pubky://{PK}/pub/pubky.app/files/0032SSN7Q4EVG")),
        Some(vec![PubkySocialUserLink::new(
            "site".into(),
            "https://example.com/".into(),
        )]),
        Some("here".into()),
    )
}

/// The post shape took its v1 form with the wire break: `note`/`article` kinds, a plain
/// `embed` string, attachment objects that are always present. The first deliberate change
/// to this fixture; the feed entry below moved with it because a feed config pins a kind.
fn post_full() -> PubkySocialPost {
    PubkySocialPost::new_with_lock(
        "hello".into(),
        PubkySocialPostKind::Note,
        Some(format!("pubky://{PK}/pub/pubky.app/posts/0032SSN7Q4EVG")),
        Some(format!("pubky://{PK}/pub/pubky.app/posts/0034A0X7NJ52G")),
        vec![PubkySocialAttachment::new(
            format!("pubky://{PK}/pub/pubky.app/files/0032SSN7Q4EVG"),
            Some("a cat".into()),
            Some("cat.jpg".into()),
        )],
        Some(format!("pubky://{PK}/pub/app.locks/0032SSN7Q4EVG.json")),
    )
}

fn post_minimal() -> PubkySocialPost {
    PubkySocialPost::new(
        "hello".into(),
        PubkySocialPostKind::Article,
        None,
        None,
        vec![],
    )
}

fn tag() -> PubkySocialTag {
    let mut t = PubkySocialTag::new(
        format!("pubky://{PK}/pub/pubky.app/posts/0032SSN7Q4EVG"),
        "rust".into(),
    );
    t.created_at = TS;
    t
}

/// The bookmark content lost `uri` with the filename move: the target is the filename, so the
/// primary form carries the timestamp alone. Only the overflow form, whose filename is a
/// one-way hash, still spells the target out.
fn bookmark() -> PubkySocialBookmark {
    let mut b = create_bookmark(&format!("pubky://{PK}/pub/pubky.app/posts/0032SSN7Q4EVG"))
        .unwrap()
        .bookmark;
    b.created_at = TS;
    b
}

fn bookmark_overflow() -> PubkySocialBookmark {
    // One byte past the primary form: 188 bytes no longer fit the 255-character segment
    let long = format!("https://example.com/{}", "a".repeat(168));
    let mut b = create_bookmark(&long).unwrap().bookmark;
    b.created_at = TS;
    b
}

fn follow() -> PubkySocialFollow {
    let mut f = PubkySocialFollow::new();
    f.created_at = TS;
    f
}

fn mute() -> PubkySocialMute {
    let mut m = PubkySocialMute::new();
    m.created_at = TS;
    m
}

fn feed_config() -> PubkySocialFeedConfig {
    PubkySocialFeedConfig {
        tags: Some(vec!["rust".into()]),
        domain_tags: Some(vec!["dev".into()]),
        reach: PubkySocialFeedReach::Wot,
        layout: PubkySocialFeedLayout::Columns,
        sort: PubkySocialFeedSort::Recent,
        content: Some(PubkySocialPostKind::Note),
        extra: Default::default(),
    }
}

fn feed_with_icon() -> PubkySocialFeed {
    let mut f = PubkySocialFeed::new(feed_config(), "Rust".into(), "code".into());
    f.created_at = TS;
    f
}

fn feed_legacy() -> PubkySocialFeed {
    PubkySocialFeed {
        feed: PubkySocialFeedConfig {
            tags: None,
            domain_tags: None,
            reach: PubkySocialFeedReach::All,
            layout: PubkySocialFeedLayout::List,
            sort: PubkySocialFeedSort::Popularity,
            content: None,
            extra: Default::default(),
        },
        name: "All".into(),
        icon: None,
        created_at: TS,
        extra: Default::default(),
    }
}

// Media has no entry here any more: the v0 File-metadata JSON model is deleted (its `name`
// relocated to attachment `name`, its `content_type`, `src` and `size` dissolved), and the one
// media object's wire form is raw bytes with no JSON serialization surface, so there is nothing
// left to pin.

fn collection_with_layout() -> PubkySocialCollectionContent {
    PubkySocialCollectionContent {
        name: "Photos".into(),
        description: Some("mine".into()),
        // Items became objects with the collection rework; this entry changed deliberately
        items: vec![PubkySocialCollectionItem::new(
            format!("pubky://{PK}/pub/pubky.app/posts/0032SSN7Q4EVG"),
            Some("first".into()),
        )],
        cover_image: Some(format!("pubky://{PK}/pub/pubky.app/files/0032SSN7Q4EVG")),
        layout: Some(PubkySocialCollectionLayout::Visual),
        extra: Default::default(),
    }
}

fn collection_legacy() -> PubkySocialCollectionContent {
    PubkySocialCollectionContent {
        name: "Photos".into(),
        description: None,
        items: vec![],
        cover_image: None,
        layout: None,
        extra: Default::default(),
    }
}

/// The parse types took their v1 shape with the path epoch (visibility, the post version and
/// label, the Foreign and UnsupportedVersion categories); these pins hold from that change on.
fn parsed_uri() -> ParsedUri {
    ParsedUri {
        user_id: PubkyId::try_from(PK).unwrap(),
        visibility: Visibility::Public,
        resource: Resource::Post {
            id: "0032SSN7Q4EVG".into(),
            version: None,
            label: None,
        },
    }
}

/// The parse types are not stored objects, but they derive serde, so their names are pinned too.
#[rustfmt::skip]
fn pinned() -> Vec<(&'static str, String, &'static str)> {
    vec![
        (
            "user",
            json(&user()),
            r#"{"name":"Alice","bio":"bio","image":"pubky://{PK}/pub/pubky.app/files/0032SSN7Q4EVG","links":[{"title":"site","url":"https://example.com/"}],"status":"here"}"#,
        ),
        (
            "post_full",
            json(&post_full()),
            r#"{"content":"hello","kind":"note","parent":"pubky://{PK}/pub/pubky.app/posts/0032SSN7Q4EVG","embed":"pubky://{PK}/pub/pubky.app/posts/0034A0X7NJ52G","attachments":[{"uri":"pubky://{PK}/pub/pubky.app/files/0032SSN7Q4EVG","alt":"a cat","name":"cat.jpg"}],"lock":"pubky://{PK}/pub/app.locks/0032SSN7Q4EVG.json"}"#,
        ),
        (
            "post_minimal",
            json(&post_minimal()),
            r#"{"content":"hello","kind":"article","parent":null,"embed":null,"attachments":[]}"#,
        ),
        (
            "tag",
            json(&tag()),
            r#"{"uri":"pubky://{PK}/pub/pubky.app/posts/0032SSN7Q4EVG","label":"rust","created_at":1727740800000000}"#,
        ),
        (
            "bookmark",
            json(&bookmark()),
            r#"{"created_at":1727740800000000}"#,
        ),
        (
            "bookmark_overflow",
            json(&bookmark_overflow()),
            r#"{"created_at":1727740800000000,"target":"https://example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#,
        ),
        (
            "follow",
            json(&follow()),
            r#"{"created_at":1727740800000000}"#,
        ),
        ("mute", json(&mute()), r#"{"created_at":1727740800000000}"#),
        (
            "feed_with_icon",
            json(&feed_with_icon()),
            r#"{"feed":{"tags":["rust"],"domain_tags":["dev"],"reach":"wot","layout":"columns","sort":"recent","content":"note"},"name":"Rust","icon":"code","created_at":1727740800000000}"#,
        ),
        (
            "feed_legacy",
            json(&feed_legacy()),
            r#"{"feed":{"tags":null,"reach":"all","layout":"list","sort":"popularity","content":null},"name":"All","created_at":1727740800000000}"#,
        ),
        (
            "collection_with_layout",
            json(&collection_with_layout()),
            r#"{"name":"Photos","description":"mine","items":[{"uri":"pubky://{PK}/pub/pubky.app/posts/0032SSN7Q4EVG","note":"first"}],"cover_image":"pubky://{PK}/pub/pubky.app/files/0032SSN7Q4EVG","layout":"visual"}"#,
        ),
        (
            "collection_legacy",
            json(&collection_legacy()),
            r#"{"name":"Photos","items":[]}"#,
        ),
        (
            "parsed_uri",
            json(&parsed_uri()),
            r#"{"user_id":"{PK}","visibility":"public","resource":{"Post":{"id":"0032SSN7Q4EVG","version":null,"label":null}}}"#,
        ),
    ]
}

#[test]
fn wire_bytes_are_unchanged() {
    for (name, actual, expected) in pinned() {
        assert_eq!(actual, expected.replace("{PK}", PK), "{name}");
    }
}

fn pk() -> PubkyId {
    PubkyId::try_from(PK).unwrap()
}

/// Every variant of every serde enum, so a rename that touches a variant name fails here.
#[rustfmt::skip]
fn pinned_variants() -> Vec<(String, &'static str)> {
    use PubkySocialCollectionLayout as C;
    use PubkySocialFeedLayout as L;
    use PubkySocialFeedReach as R;
    use PubkySocialFeedSort as S;
    use PubkySocialPostKind as K;
    let h = "8Z8CWH8NVYQY39ZEBFGKQWWEKG".to_string();
    vec![
        (json(&Resource::User), r#""User""#),
        (json(&Resource::Post { id: "0032SSN7Q4EVG".into(), version: None, label: None }),
            r#"{"Post":{"id":"0032SSN7Q4EVG","version":null,"label":null}}"#),
        (json(&Resource::Post { id: "0032SSN7Q4EVG".into(), version: Some("0034A0X7NJ52G".into()), label: Some("hello".into()) }),
            r#"{"Post":{"id":"0032SSN7Q4EVG","version":"0034A0X7NJ52G","label":"hello"}}"#),
        (json(&Resource::Foreign { namespace: "pubky.app".into(), version: Some("v1".into()), rest: vec!["X".into()] }),
            r#"{"Foreign":{"namespace":"pubky.app","version":"v1","rest":["X"]}}"#),
        (json(&Resource::UnsupportedVersion { version: "v2".into() }),
            r#"{"UnsupportedVersion":{"version":"v2"}}"#),
        (json(&Visibility::Public), r#""public""#),
        (json(&Visibility::Private), r#""private""#),
        (json(&Resource::Follow(pk())), r#"{"Follow":"{PK}"}"#),
        (json(&Resource::Mute(pk())), r#"{"Mute":"{PK}"}"#),
        (json(&Resource::Bookmark(B64.into())), r#"{"Bookmark":"cHVia3k6Ly9vcGVycnI4d3NicHIzdWU5ZDRxajQxZ2Uxa2NjNnI3ZmRpeTZvM3VnanJyaGk0eTc3cmRvL3B1Yi9zb2NpYWwvdjEvcG9zdHMvMDAzMlNTTjdRNEVWRw"}"#),
        (json(&Resource::Tag(h.clone())), r#"{"Tag":"8Z8CWH8NVYQY39ZEBFGKQWWEKG"}"#),
        (json(&Resource::File(format!("{h}.svg"))), r#"{"File":"8Z8CWH8NVYQY39ZEBFGKQWWEKG.svg"}"#),
        (json(&Resource::Feed(h)), r#"{"Feed":"8Z8CWH8NVYQY39ZEBFGKQWWEKG"}"#),
        (json(&Resource::Unknown), r#""Unknown""#),
        (json(&K::Note), r#""note""#), (json(&K::Article), r#""article""#), (json(&K::Image), r#""image""#),
        (json(&K::Video), r#""video""#), (json(&K::Link), r#""link""#), (json(&K::File), r#""file""#),
        (json(&K::Collection), r#""collection""#), (json(&K::Unknown("podcast".into())), r#""podcast""#),
        (json(&R::Following), r#""following""#), (json(&R::Followers), r#""followers""#),
        (json(&R::Friends), r#""friends""#), (json(&R::All), r#""all""#), (json(&R::Wot), r#""wot""#),
        (json(&R::Me), r#""me""#),
        (json(&L::Columns), r#""columns""#), (json(&L::Wide), r#""wide""#), (json(&L::Visual), r#""visual""#),
        (json(&L::List), r#""list""#),
        (json(&S::Recent), r#""recent""#), (json(&S::Popularity), r#""popularity""#),
        (json(&C::Grid), r#""grid""#), (json(&C::List), r#""list""#), (json(&C::Visual), r#""visual""#),
        (json(&C::Unknown("carousel".into())), r#""carousel""#),
    ]
}

#[test]
fn every_enum_variant_serializes_as_before() {
    for (actual, expected) in pinned_variants() {
        assert_eq!(actual, expected.replace("{PK}", PK));
    }
}

/// The limits table ships to npm as `validationLimits.json`, so its keys are wire too. This is
/// the 1.0 table: renamed, added and removed rows are deliberate and consumers adopt them with 1.0.
#[test]
fn validation_limits_wire_keys_are_pinned() {
    assert_eq!(
        json(&VALIDATION_LIMITS),
        r#"{"maxFileSizeBytes":104857600,"tagLabelMinLength":1,"tagLabelMaxLength":20,"tagInvalidChars":[",",":"," ","\t","\n","\r"],"userNameMinLength":3,"userNameMaxLength":50,"userBioMaxLength":160,"imageUrlMaxLength":300,"userLinksMaxCount":5,"userLinkTitleMaxLength":100,"userLinkUrlMaxLength":300,"userStatusMaxLength":50,"postNoteContentMaxLength":2000,"articleTitleMaxLength":100,"articleBodyMaxLength":50000,"articleContentMaxLength":104000,"postAttachmentsMaxCount":10,"attachmentAltMaxLength":1000,"attachmentNameMaxLength":255,"referenceUriMaxLength":1024,"postAllowedAttachmentProtocols":["pubky","http","https"],"collectionContentMaxLength":40000,"collectionNameMinLength":1,"collectionNameMaxLength":100,"collectionDescriptionMaxLength":500,"collectionItemsMaxCount":100,"collectionItemNoteMaxLength":1000,"feedTagsMaxCount":5,"feedNameMaxLength":100,"feedIconMaxLength":50,"bookmarkTargetUriMaxBytes":187,"postSlugMaxLength":64,"postMaxBytes":524288,"objectMaxBytes":65536}"#
    );
}
