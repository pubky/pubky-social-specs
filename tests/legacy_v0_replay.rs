//! The frozen 0.x reader answers exactly what the 0.8.0 crate answered, and what 0.8.1
//! answered for the one value it added, the `cards` feed layout.
//!
//! `corpus.json` and `uris.json` are authored here; `verdicts.json` and `uri_verdicts.json`
//! were produced by running them through the 0.8.0 crate itself, so they are evidence rather
//! than an expectation someone typed. The `cards` row is the exception its note names: 0.8.0
//! rejects it, and its verdict came from the published 0.8.1. Regenerating a verdict means
//! building that crate again, which is the point: nobody edits one to make a change pass.
//!
//! Two entry points, because an indexer uses two: `PubkyAppObject::from_uri` for a stored
//! object and `ExtendedParsedUri` for a tag target, which may live under another app.
//!
//! Accept or reject is compared on every row, and an accepted object is compared on its
//! re-serialized bytes. A rejection message is recorded but not compared, because a few
//! rows cannot match: the public key in a path is checked by the crate's own id type (one
//! id type, or every consumer signature forks) and that type asks a format question where
//! 0.8.0 on native asked a curve question. Every other message is pinned by the copied 0.x
//! tests themselves.
//!
//! The two are not the same acceptance set, and
//! `a_z32_host_that_is_not_a_curve_point_is_accepted_here` and
//! `a_z32_host_with_nonzero_filler_bits_is_rejected_here` pin where they part.

use pubky_social_specs::legacy_v0::{
    try_parse_pubky_path, ExtendedParsedUri, PubkyAppObject, VALIDATION_LIMITS,
};
use pubky_social_specs::{resolve_deref, stable_id, StableId};
use serde_json::Value;

fn fixture(name: &str) -> Vec<Value> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/legacy_v0/");
    let bytes = std::fs::read(format!("{path}{name}")).expect("fixture");
    serde_json::from_slice(&bytes).expect("fixture json")
}

fn encode(object: &PubkyAppObject) -> Value {
    let (kind, value) = match object {
        PubkyAppObject::User(v) => ("User", serde_json::to_value(v)),
        PubkyAppObject::Post(v) => ("Post", serde_json::to_value(v)),
        PubkyAppObject::Follow(v) => ("Follow", serde_json::to_value(v)),
        PubkyAppObject::Mute(v) => ("Mute", serde_json::to_value(v)),
        PubkyAppObject::Bookmark(v) => ("Bookmark", serde_json::to_value(v)),
        PubkyAppObject::Tag(v) => ("Tag", serde_json::to_value(v)),
        PubkyAppObject::File(v) => ("File", serde_json::to_value(v)),
        PubkyAppObject::Blob(v) => ("Blob", serde_json::to_value(v)),
        PubkyAppObject::Feed(v) => ("Feed", serde_json::to_value(v)),
        PubkyAppObject::LastRead(v) => ("LastRead", serde_json::to_value(v)),
    };
    serde_json::json!({ "type": kind, "value": value.unwrap() })
}

#[test]
fn the_corpus_replays_to_the_v0_verdicts() {
    let corpus = fixture("corpus.json");
    let verdicts = fixture("verdicts.json");
    assert_eq!(corpus.len(), verdicts.len(), "corpus and verdicts disagree");
    assert!(corpus.len() >= 51, "the corpus lost rows");

    let (mut accepted, mut rejected) = (0, 0);
    for (input, verdict) in corpus.iter().zip(&verdicts) {
        let note = input["note"].as_str().unwrap();
        assert_eq!(input["uri"], verdict["uri"], "{note}");
        assert_eq!(input["blob"], verdict["blob"], "{note}");
        let uri = input["uri"].as_str().unwrap();
        let blob = input["blob"].as_str().unwrap().as_bytes();

        match PubkyAppObject::from_uri(uri, blob) {
            Ok(object) => {
                accepted += 1;
                assert!(
                    verdict["err"].is_null(),
                    "{note}: 0.8.0 rejected this with {}",
                    verdict["err"]
                );
                assert_eq!(
                    serde_json::to_string(&encode(&object)).unwrap(),
                    serde_json::to_string(&verdict["ok"]).unwrap(),
                    "{note}"
                );
            }
            Err(e) => {
                rejected += 1;
                assert!(
                    verdict["ok"].is_null(),
                    "{note}: 0.8.0 accepted this, we answered {e}"
                );
                assert!(!e.is_empty(), "{note}: a rejection with no reason");
            }
        }
    }
    assert_eq!((accepted, rejected), (23, 28), "the corpus balance moved");
}

/// The second entry point. `ExtendedParsedUri` is what an indexer puts a tag target through,
/// so it reads paths `PubkyAppObject::from_uri` never sees: another app's tag, and whatever
/// else arrives at that boundary. Same evidence rule as the corpus, and here the accepted
/// side carries the three answers a caller actually reads.
#[test]
fn the_uri_corpus_replays_to_the_v0_verdicts() {
    let corpus = fixture("uris.json");
    let verdicts = fixture("uri_verdicts.json");
    assert_eq!(corpus.len(), verdicts.len(), "corpus and verdicts disagree");
    assert!(corpus.len() >= 12, "the uri corpus lost rows");

    let (mut accepted, mut rejected) = (0, 0);
    for (input, verdict) in corpus.iter().zip(&verdicts) {
        let note = input["note"].as_str().unwrap();
        assert_eq!(input["uri"], verdict["uri"], "{note}");
        let uri = input["uri"].as_str().unwrap();

        match ExtendedParsedUri::try_from(uri) {
            Ok(parsed) => {
                accepted += 1;
                assert!(
                    verdict["err"].is_null(),
                    "{note}: 0.8.0 rejected this with {}",
                    verdict["err"]
                );
                let (uri_str, uri_str_err) = match parsed.try_to_uri_str() {
                    Ok(s) => (Value::String(s), Value::Null),
                    Err(e) => (Value::Null, Value::String(e)),
                };
                let ours = serde_json::json!({
                    "app": parsed.app(),
                    "tag_id": parsed.tag_id(),
                    "uri_str": uri_str,
                    "uri_str_err": uri_str_err,
                });
                assert_eq!(
                    serde_json::to_string(&ours).unwrap(),
                    serde_json::to_string(&verdict["ok"]).unwrap(),
                    "{note}"
                );
            }
            Err(e) => {
                rejected += 1;
                assert!(
                    verdict["ok"].is_null(),
                    "{note}: 0.8.0 accepted this, we answered {e}"
                );
                assert!(!e.is_empty(), "{note}: a rejection with no reason");
            }
        }
    }
    assert_eq!((accepted, rejected), (5, 7), "the uri corpus balance moved");
}

/// One object, its v0 path and its v1 path, keying onto one row. These are the resources
/// whose id survives the migration, so the two spellings really are the same object.
#[test]
fn a_v0_path_and_its_v1_counterpart_key_the_same() {
    let owner = "pxnu33x7jtpx9ar1ytsi4yxbp6a5o36gwhffs8zoxmbuptici1jy";
    let hash = "PZBQ010FF079VVZPQG1RNFN6DR";
    let pairs: &[(&str, &str, &str)] = &[
        (
            "pub/pubky.app/profile.json",
            "pub/social/v1/profile.json",
            "profile",
        ),
        (
            "pub/pubky.app/posts/0032SSN7Q4EVG",
            "pub/social/v1/posts/0032SSN7Q4EVG/0034A0X7NJ52A-first.json",
            "posts/0032SSN7Q4EVG",
        ),
        (
            &format!("pub/pubky.app/follows/{owner}"),
            &format!("pub/social/v1/follows/{owner}.json"),
            &format!("follows/{owner}"),
        ),
        (
            &format!("pub/pubky.app/mutes/{owner}"),
            &format!("priv/social/v1/mutes/{owner}.json"),
            &format!("mutes/{owner}"),
        ),
        (
            // v0 stored the bytes under blobs/ and their metadata under files/; the bytes
            // are what v1 calls a file, and the hash is carried over unchanged.
            &format!("pub/pubky.app/blobs/{hash}"),
            &format!("priv/social/v1/files/{hash}.png"),
            &format!("files/{hash}"),
        ),
    ];
    for (legacy, v1, expected) in pairs {
        let want = Some(StableId::Key((*expected).to_string()));
        assert_eq!(stable_id(legacy), want, "{legacy}");
        assert_eq!(stable_id(v1), want, "{v1}");
    }

    // last_read leaves this library in v1, so only the legacy spelling keys, for the migrator.
    assert_eq!(
        stable_id("pub/pubky.app/last_read"),
        Some(StableId::Key("last_read".to_string()))
    );
    assert_eq!(stable_id("pub/social/v1/last_read.json"), None);
}

/// `tags`, `bookmarks` and `feeds` re-derive their id in the migration, so a v0 path and
/// the v1 path of the same object carry different ids and cannot key alike. What holds for
/// them is only that the grammar collapses: feed one id to both spellings and one key comes
/// back. Collapsing the two real ids is the indexer's job, not this function's.
#[test]
fn a_re_derived_id_keys_the_same_under_either_epoch_spelling() {
    let id = "86805FC1CSFZD4W6HZ09S24QWG";
    // Each under the root the v1 grammar binds it to; a tag under `priv/` is no object.
    for (segment, root) in [("tags", "pub"), ("bookmarks", "priv"), ("feeds", "priv")] {
        let want = Some(StableId::Key(format!("{segment}/{id}")));
        assert_eq!(stable_id(&format!("pub/pubky.app/{segment}/{id}")), want);
        assert_eq!(
            stable_id(&format!("{root}/social/v1/{segment}/{id}.json")),
            want
        );
    }
}

/// The v0 media object is the one reference a path alone cannot key: the bytes live
/// somewhere else and only the object's own `src` says where.
#[test]
fn a_legacy_media_reference_completes_through_the_file_object() {
    let corpus = fixture("corpus.json");
    let file = corpus
        .iter()
        .find(|e| e["note"] == "file, pointing at its blob")
        .expect("the corpus carries a v0 File");
    let src: Value = serde_json::from_str(file["blob"].as_str().unwrap()).unwrap();
    let src = src["src"].as_str().unwrap();

    let owner_relative = file["uri"]
        .as_str()
        .unwrap()
        .split_once("/pub/")
        .map(|(_, tail)| format!("pub/{tail}"))
        .unwrap();
    let StableId::NeedsDeref { tsid } = stable_id(&owner_relative).unwrap() else {
        panic!("a v0 files/ path must ask for its object");
    };

    let key = resolve_deref(&tsid, src).expect("a canonical blob src completes");
    assert_eq!(key, "files/PZBQ010FF079VVZPQG1RNFN6DR");
    assert_eq!(
        stable_id("priv/social/v1/files/PZBQ010FF079VVZPQG1RNFN6DR.png"),
        Some(StableId::Key(key)),
        "the completed key is the migrated object's key"
    );
}

/// The one place this module is wider than 0.8.0 on native. That build ran the host through
/// pubky and required an Ed25519 curve point; the wasm32 build of the same release checked
/// the encoding only, and so does the crate's single id type. Pinned here so the widening
/// stays visible instead of being discovered by a consumer.
#[test]
fn a_z32_host_that_is_not_a_curve_point_is_accepted_here() {
    // 52 z-base32 characters ending in `y`, so the trailing bits are zero and the string
    // decodes to 32 bytes. Those bytes are not a point on the curve, and 0.8.0 on native
    // answered "Cannot decompress Edwards point" to every one of these.
    let host = "operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77yyy";
    assert_eq!(host.len(), 52);

    let uri = format!("pubky://{host}/pub/pubky.app/follows/{host}");
    let path = try_parse_pubky_path(&uri).expect("accepted as a URI host");
    assert_eq!(path.user_id.as_ref(), host);
    assert_eq!(path.segments, ["follows", host]);

    let object = PubkyAppObject::from_uri(&uri, br#"{"created_at":1627849723}"#)
        .expect("accepted as a Follow id");
    assert!(matches!(object, PubkyAppObject::Follow(_)));
}

/// The one place this module is stricter than 0.8.0. That release decoded the host ignoring
/// the 4 filler bits of the last character, so every spelling of one key passed. Here only
/// the standard spelling does, or one user would hold several keys.
#[test]
fn a_z32_host_with_nonzero_filler_bits_is_rejected_here() {
    // `t` and `o` share their data bit and differ only in the filler bits, so this decodes
    // to the same curve point as the real key ending in `o`, which 0.8.0 accepted.
    let canonical = "operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo";
    let alias = "operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdt";
    assert_eq!(alias.len(), 52);

    let accepted = format!("pubky://{canonical}/pub/pubky.app/follows/{canonical}");
    assert!(try_parse_pubky_path(&accepted).is_ok());

    for uri in [
        format!("pubky://{alias}/pub/pubky.app/follows/{canonical}"),
        format!("pubky://{canonical}/pub/pubky.app/follows/{alias}"),
        format!("pubky://{canonical}/pub/pubky.app/mutes/{alias}"),
    ] {
        assert!(
            PubkyAppObject::from_uri(&uri, br#"{"created_at":1627849723}"#).is_err(),
            "{uri}"
        );
    }
    assert!(try_parse_pubky_path(&format!("pubky://{alias}/pub/pubky.app/profile.json")).is_err());
}

/// Nexus reads these names. A rename here is a downstream break, not a refactor.
#[test]
fn the_v0_limits_keep_their_v0_names_and_values() {
    assert_eq!(VALIDATION_LIMITS.post_short_content_max_length, 2000);
    assert_eq!(VALIDATION_LIMITS.post_long_content_max_length, 50_000);
    assert_eq!(VALIDATION_LIMITS.user_image_url_max_length, 300);
    assert_eq!(VALIDATION_LIMITS.file_src_max_length, 1024);
    assert_eq!(VALIDATION_LIMITS.max_blob_size_bytes, 100 * (1 << 20));
    assert_eq!(VALIDATION_LIMITS.feed_tags_max_count, 5);
    assert_eq!(VALIDATION_LIMITS.feed_icon_max_length, 50);
    assert_eq!(VALIDATION_LIMITS.collection_items_max_count, 100);

    let wire = serde_json::to_value(VALIDATION_LIMITS).unwrap();
    let mut keys: Vec<&str> = wire
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "collectionContentMaxLength",
            "collectionDescriptionMaxLength",
            "collectionItemsMaxCount",
            "collectionNameMaxLength",
            "collectionNameMinLength",
            "feedIconMaxLength",
            "feedTagsMaxCount",
            "fileNameMaxLength",
            "fileNameMinLength",
            "fileSrcMaxLength",
            "maxBlobSizeBytes",
            "maxFileSizeBytes",
            "postAllowedAttachmentProtocols",
            "postAttachmentUrlMaxLength",
            "postAttachmentsMaxCount",
            "postLongContentMaxLength",
            "postShortContentMaxLength",
            "tagInvalidChars",
            "tagLabelMaxLength",
            "tagLabelMinLength",
            "userBioMaxLength",
            "userImageUrlMaxLength",
            "userLinkTitleMaxLength",
            "userLinkUrlMaxLength",
            "userLinksMaxCount",
            "userNameMaxLength",
            "userNameMinLength",
            "userStatusMaxLength",
        ]
    );
}
