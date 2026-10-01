//! Seeded fuzz of the v0 to v1 transforms over reader-shaped v0 objects with hostile content.
//!
//! Per case: no panic, the same result twice, every write reads back through the v1 reader and
//! re-serializes to the same bytes, a skip carries a published category, a success writes what
//! its kind writes, and no output reference keeps a v0 spelling of a profile or a follow.
//!
//! `QA_FUZZ_CASES` sets the cases per kind (200 by default), `QA_FUZZ_SEED` the base seed and
//! `QA_FUZZ_OUT` a file for the tallies. Run the campaign in release:
//! `QA_FUZZ_CASES=10000 cargo test --release --features migrator --test qa_transform_fuzz -- --nocapture`
#![cfg(feature = "migrator")]

use pubky_social_specs::legacy_v0;
use pubky_social_specs::legacy_v0::traits::{HashId as V0HashId, Validatable as V0Validatable};
use pubky_social_specs::migrate::{transform, Migrated, MigrationCtx, Skip, Skipped};
use pubky_social_specs::traits::HashId;
use pubky_social_specs::{PubkyId, PubkySocialFile, PubkySocialObject};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

const OWNER: &str = "operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo";
const OTHER: &str = "pxnu33x7jtpx9ar1ytsi4yxbp6a5o36gwhffs8zoxmbuptici1jy";
const OCT_2024: i64 = 1_727_740_800_000_000;
const TWO_HOURS: i64 = 2 * 60 * 60 * 1_000_000;

struct Rng {
    state: u64,
    /// Hostile content in values the 0.x reader takes, so most cases reach the transform
    mild: bool,
}

impl Rng {
    fn new(seed: u64) -> Self {
        let mut r = Rng {
            state: seed ^ 0x9E37_79B9_7F4A_7C15,
            mild: false,
        };
        for _ in 0..4 {
            r.next();
        }
        r.mild = r.chance(65);
        r
    }
    fn next(&mut self) -> u64 {
        let mut x = self.state;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.state = x;
        x
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    fn chance(&mut self, percent: u64) -> bool {
        self.next() % 100 < percent
    }
    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len())]
    }
}

fn now_micros() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_micros() as i64
}

/// A 0.x TimestampId for these microseconds.
fn tsid(micros: i64) -> String {
    base32::encode(base32::Alphabet::Crockford, &micros.to_be_bytes())
}

// ---- hostile text ----

/// One unit of each Unicode class the readers and builders see differently.
const UNITS: &[&str] = &[
    "a",
    "Z",
    "\u{202E}",  // RTL override
    "\u{05E9}",  // Hebrew letter
    "\u{0645}",  // Arabic letter
    "\u{200B}",  // zero-width space
    "\u{200D}",  // zero-width joiner
    "\u{FEFF}",  // BOM
    "e\u{0301}", // combining acute
    "a\u{0300}\u{0301}\u{0302}\u{0303}",
    "\u{D7FF}", // last before the surrogates
    "\u{E000}", // first after them
    "\u{FFFD}",
    "\u{10FFFF}",
    "\u{1F600}",
    "\u{1F469}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}", // family ZWJ
    "\u{1F3F3}\u{FE0F}\u{200D}\u{1F308}",                           // rainbow flag
    "\u{00A0}",
    "\u{2003}",
    "\u{3000}",
    "\u{0085}",
    "\u{2028}",
    "\t",
    "\n",
    " ",
    "\u{0000}",
    "\u{0001}",
    "\"",
    "\\",
    "\u{6F22}",
    "[DELETED]",
];

const WHITESPACE: &[&str] = &[
    " ", "\t", "\n", "\u{00A0}", "\u{2003}", "\u{3000}", "\u{0085}", "\u{2028}", "\u{FEFF}",
    "\u{200B}",
];

/// Exactly `chars` code points, cycling over one class.
fn exact(rng: &mut Rng, chars: usize) -> String {
    let unit = *rng.pick(&[
        "a",
        "\u{1F600}",
        "e\u{0301}",
        "\u{05E9}",
        "\u{3000}x",
        "\u{200B}b",
        "\u{1F469}\u{200D}\u{1F467}",
    ]);
    let mut s = String::new();
    let mut count = 0;
    while count < chars {
        for c in unit.chars() {
            if count == chars {
                break;
            }
            s.push(c);
            count += 1;
        }
    }
    s
}

/// Text near the given limits, or a short hostile mix, sometimes padded with whitespace.
fn text(rng: &mut Rng, limits: &[usize]) -> String {
    let mode = if rng.mild {
        rng.below(8)
    } else {
        rng.below(10)
    };
    let core = match mode {
        0..=3 => {
            let n = 1 + rng.below(8);
            (0..n).map(|_| *rng.pick(UNITS)).collect::<String>()
        }
        4..=7 => {
            let limit = *rng.pick(limits);
            let len = match if rng.mild { rng.below(2) } else { rng.below(3) } {
                0 => limit.saturating_sub(1),
                1 => limit,
                _ => limit + 1,
            };
            exact(rng, len)
        }
        8 => (0..1 + rng.below(4))
            .map(|_| *rng.pick(WHITESPACE))
            .collect(),
        _ => format!("hello {}", rng.next() % 1000),
    };
    if !rng.mild && rng.chance(20) {
        format!("{}{core}{}", rng.pick(WHITESPACE), rng.pick(WHITESPACE))
    } else {
        core
    }
}

// ---- hostile URLs ----

fn hash_of(bytes: &[u8]) -> String {
    PubkySocialFile(bytes.to_vec()).create_id()
}

struct Fixture {
    /// File ids the context knows, with the blob each names.
    files: Vec<(String, String)>,
    blob_hashes: Vec<String>,
    now: i64,
}

fn url(rng: &mut Rng, fx: &Fixture) -> String {
    let id = tsid(OCT_2024 + (rng.next() % 1_000_000_000) as i64);
    let pk = if rng.chance(70) { OWNER } else { OTHER };
    let (file, blob) = rng.pick(&fx.files).clone();
    let long = "x".repeat(2000 + rng.below(200));
    let readable: Vec<String> = vec![
        "https://example.com/a?b=c#d".into(),
        "HTTPS://EXAMPLE.COM/Upper".into(),
        "https://user:pa%20ss@example.com/".into(),
        "https://[::1]:8080/x".into(),
        "https://example.com./trailing".into(),
        "https://exa%41mple.com/%7Euser/%2F".into(),
        "https://\u{4F8B}\u{3048}.jp/\u{30D1}\u{30B9}".into(),
        format!("pubky://{pk}/pub/pubky.app/posts/{id}"),
        format!("pubky://{pk}/pub/pubky.app/profile.json"),
        format!("pubky://{pk}/pub/pubky.app/follows/{OTHER}"),
        format!("pubky://{OWNER}/pub/pubky.app/files/{file}"),
        format!("pubky://{OWNER}/pub/pubky.app/blobs/{blob}"),
        format!("pubky://{pk}/pub/social/v1/posts/{id}"),
    ];
    if rng.mild {
        return rng.pick(&readable).clone();
    }
    let options: Vec<String> = vec![
        "https://example.com/a?b=c#d".into(),
        "HTTPS://EXAMPLE.COM/Upper".into(),
        "HtTp://Example.com".into(),
        "https://user:pa%20ss@example.com/".into(),
        "https://[::1]:8080/x".into(),
        "https://[2001:db8::1]/".into(),
        "https://example.com./trailing".into(),
        "https://exa%41mple.com/%7Euser/%2F".into(),
        format!("https://example.com/{long}"),
        "https://\u{4F8B}\u{3048}.jp/\u{30D1}\u{30B9}".into(),
        "https://xn--r8jz45g.jp".into(),
        " https://padded.example.com ".into(),
        "ftp://files.example.com/x".into(),
        "file:///etc/passwd".into(),
        "javascript:alert(1)".into(),
        "data:text/plain,hi".into(),
        "nostr:npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m".into(),
        "geo:47.1,8.5".into(),
        "mailto:a@example.com".into(),
        "urn:isbn:0451450523".into(),
        "/relative/path".into(),
        "".into(),
        "https://".into(),
        format!("pubky://{pk}/pub/pubky.app/posts/{id}"),
        format!("pubky://{pk}/pub/pubky.app/profile.json"),
        format!("pubky://{pk}/pub/pubky.app/follows/{OTHER}"),
        format!("pubky://{pk}/pub/pubky.app/follows/{OWNER}"),
        format!("pubky://{OWNER}/pub/pubky.app/files/{file}"),
        format!("pubky://{OWNER}/pub/pubky.app/blobs/{blob}"),
        format!(
            "pubky://{pk}/pub/pubky.app/tags/{}",
            legacy_v0::tag_id("https://example.com/", "x")
        ),
        format!("pubky://{pk}/pub/pubky.app/mutes/{OTHER}"),
        format!("pubky://{pk}/pub/pubky.app/last_read"),
        format!("pubky://{pk}/pub/pubky.app/unknown/x"),
        format!("pubky://{pk}/pub/social/v1/posts/{id}"),
        format!("PUBKY://{pk}/pub/pubky.app/profile.json"),
        format!("pubky://{}/pub/pubky.app/profile.json", pk.to_uppercase()),
        format!("pubky{pk}/pub/pubky.app/profile.json"),
        format!("pubky://{}/pub/pubky.app/profile.json", &pk[..51]),
        format!("pubky://{pk}x/pub/pubky.app/profile.json"),
        format!("pubky://{pk}/pub/pubky.app/posts/{id}/"),
        format!("pubky://{pk}/pub/pubky.app/posts/{id}?q=1#f"),
        format!("pubky://{pk}//pub/pubky.app/profile.json"),
        format!("pubky://{pk}/pub/pubky.app/./profile.json"),
        format!("pubky://{pk}/pub/pubky.app/posts/{}", id.to_lowercase()),
        format!("  pubky://{pk}/pub/pubky.app/follows/{OTHER}\n"),
        format!("pubky://{pk}"),
        format!("pubky://{pk}/"),
    ];
    let mut out = rng.pick(&options).clone();
    if rng.chance(5) {
        out.push_str(rng.pick(UNITS));
    }
    out
}

// ---- generators, one per kind ----

fn created_at(rng: &mut Rng, fx: &Fixture) -> Value {
    let candidates = [
        json!(0),
        json!(fx.now),
        json!(fx.now + TWO_HOURS),
        json!(i64::MAX),
        json!(i64::MIN),
        json!(-1),
        json!(9_007_199_254_740_991i64),
        json!(9_007_199_254_740_992i64),
        json!(OCT_2024),
    ];
    if rng.chance(50) {
        json!(fx.now - (rng.next() % 1_000_000_000_000) as i64)
    } else {
        rng.pick(&candidates).clone()
    }
}

/// A post or File id: mostly valid, sometimes at or past either clock bound.
fn timestamp_id(rng: &mut Rng, fx: &Fixture) -> String {
    let micros = match if rng.mild { 7 } else { rng.below(12) } {
        0 => 0,
        1 => i64::MAX,
        2 => OCT_2024,
        3 => OCT_2024 - 1,
        4 => fx.now,
        5 => fx.now + TWO_HOURS - 60_000_000,
        6 => fx.now + TWO_HOURS + 60_000_000,
        _ => OCT_2024 + (rng.next() % (fx.now - OCT_2024) as u64) as i64,
    };
    tsid(micros)
}

fn maybe<T>(rng: &mut Rng, percent: u64, f: impl FnOnce(&mut Rng) -> T) -> Option<T> {
    rng.chance(percent).then(|| f(rng))
}

fn gen_profile(rng: &mut Rng, fx: &Fixture) -> (String, Vec<u8>) {
    let name = if rng.chance(5) {
        "[DELETED]".to_string()
    } else {
        text(rng, &[3, 50])
    };
    let links = maybe(rng, 50, |rng| {
        (0..rng.below(7))
            .map(|_| json!({"title": text(rng, &[100]), "url": url(rng, fx)}))
            .collect::<Vec<_>>()
    });
    let body = json!({
        "name": name,
        "bio": maybe(rng, 60, |rng| text(rng, &[160])),
        "image": maybe(rng, 50, |rng| url(rng, fx)),
        "links": links,
        "status": maybe(rng, 40, |rng| text(rng, &[50])),
    });
    (
        "pub/pubky.app/profile.json".into(),
        serde_json::to_vec(&body).unwrap(),
    )
}

fn attachments(rng: &mut Rng, fx: &Fixture) -> Option<Vec<String>> {
    maybe(rng, 60, |rng| {
        let n = if rng.mild {
            rng.below(4)
        } else {
            rng.below(12)
        };
        (0..n)
            .map(|_| {
                if rng.chance(50) {
                    let (file, _) = rng.pick(&fx.files).clone();
                    format!("pubky://{OWNER}/pub/pubky.app/files/{file}")
                } else {
                    url(rng, fx)
                }
            })
            .collect()
    })
}

fn embed(rng: &mut Rng, fx: &Fixture) -> Option<Value> {
    maybe(
        rng,
        30,
        |rng| json!({"kind": rng.pick(&["short", "long", "image", "video", "link", "file", "collection", "weird"]), "uri": url(rng, fx)}),
    )
}

fn gen_post(rng: &mut Rng, fx: &Fixture, kind: &str) -> (String, Vec<u8>) {
    let id = timestamp_id(rng, fx);
    let content = match kind {
        "long" => match rng.below(4) {
            0 | 1 => {
                let mut env = serde_json::Map::new();
                env.insert("title".into(), json!(text(rng, &[100, 120])));
                env.insert("body".into(), json!(text(rng, &[50_000, 2000])));
                if rng.chance(50) {
                    env.insert("cover_image".into(), json!(url(rng, fx)));
                }
                serde_json::to_string(&env).unwrap()
            }
            2 => format!("{}\n{}", text(rng, &[100, 101]), text(rng, &[49_000])),
            _ => text(rng, &[50_000]),
        },
        "collection" => {
            let count = if rng.chance(80) {
                rng.below(6)
            } else {
                rng.below(102)
            };
            let items: Vec<String> = (0..count)
                .map(|_| {
                    let pk = if rng.chance(70) { OWNER } else { OTHER };
                    if rng.mild || rng.chance(98) {
                        format!("pubky://{pk}/pub/pubky.app/posts/{}", timestamp_id(rng, fx))
                    } else {
                        url(rng, fx)
                    }
                })
                .collect();
            let mut env = serde_json::Map::new();
            env.insert("name".into(), json!(text(rng, &[1, 100])));
            if rng.chance(50) {
                env.insert("description".into(), json!(text(rng, &[500])));
            }
            env.insert("items".into(), json!(items));
            if rng.chance(40) {
                env.insert("cover_image".into(), json!(url(rng, fx)));
            }
            if rng.chance(40) {
                env.insert(
                    "layout".into(),
                    json!(rng.pick(&["grid", "list", "visual", "mosaic"])),
                );
            }
            serde_json::to_string(&env).unwrap()
        }
        _ => text(rng, &[2000]),
    };
    let collection = kind == "collection";
    let mut body = json!({
        "content": content,
        "kind": kind,
        "parent": if collection && rng.chance(95) { None } else { maybe(rng, 30, |rng| url(rng, fx)) },
        "embed": if collection && rng.chance(95) { None } else { embed(rng, fx) },
        "attachments": if collection && rng.chance(95) { None } else { attachments(rng, fx) },
    });
    if rng.chance(15) {
        let lock = if rng.chance(70) {
            format!(
                "pubky://{OWNER}/pub/pubky.app/posts/{}",
                timestamp_id(rng, fx)
            )
        } else {
            url(rng, fx)
        };
        body["lock"] = json!(lock);
    }
    if kind == "long" && rng.chance(40) {
        // The first attachment an image File, the cover by convention
        let (file, _) = fx.files[0].clone();
        let mut list = body["attachments"].as_array().cloned().unwrap_or_default();
        list.insert(
            0,
            json!(format!("pubky://{OWNER}/pub/pubky.app/files/{file}")),
        );
        body["attachments"] = json!(list);
    }
    (
        format!("pub/pubky.app/posts/{id}"),
        serde_json::to_vec(&body).unwrap(),
    )
}

fn label(rng: &mut Rng) -> String {
    match rng.below(6) {
        0 => "Hello World".into(),
        1 => "MiXeD".into(),
        2 => format!(" {} ", text(rng, &[20])),
        3 => text(rng, &[20, 21]),
        4 => "a,b".into(),
        _ => text(rng, &[5]),
    }
}

fn gen_tag(rng: &mut Rng, fx: &Fixture) -> (String, Vec<u8>) {
    let body = json!({"uri": url(rng, fx), "label": label(rng), "created_at": created_at(rng, fx)});
    let id = match serde_json::from_value::<legacy_v0::V0Tag>(body.clone()) {
        Ok(tag) if rng.chance(95) => {
            let tag = tag.sanitize();
            legacy_v0::tag_id(&tag.uri, &tag.label)
        }
        _ => legacy_v0::tag_id("https://example.com/", "other"),
    };
    (
        format!("pub/pubky.app/tags/{id}"),
        serde_json::to_vec(&body).unwrap(),
    )
}

fn pk_segment(rng: &mut Rng) -> String {
    match rng.below(10) {
        0 => OTHER[..51].into(),
        1 => format!("{OTHER}y"),
        2 => OTHER.to_uppercase(),
        3 => OWNER.into(),
        4 => format!("{}u", &OTHER[..51]), // filler bits set
        _ => OTHER.into(),
    }
}

fn gen_follow(rng: &mut Rng, fx: &Fixture, segment: &str) -> (String, Vec<u8>) {
    let body = if rng.chance(5) {
        json!({"created_at": "soon"})
    } else {
        json!({"created_at": created_at(rng, fx)})
    };
    (
        format!("pub/pubky.app/{segment}/{}", pk_segment(rng)),
        serde_json::to_vec(&body).unwrap(),
    )
}

fn gen_bookmark(rng: &mut Rng, fx: &Fixture) -> (String, Vec<u8>) {
    let uri = url(rng, fx);
    let bookmark = legacy_v0::V0Bookmark {
        uri: uri.clone(),
        created_at: 0,
    };
    let id = V0HashId::create_id(&bookmark);
    let body = json!({"uri": uri, "created_at": created_at(rng, fx)});
    (
        format!("pub/pubky.app/bookmarks/{id}"),
        serde_json::to_vec(&body).unwrap(),
    )
}

fn gen_feed(rng: &mut Rng, fx: &Fixture) -> (String, Vec<u8>) {
    let tags = |rng: &mut Rng| {
        maybe(rng, 60, |rng| {
            (0..rng.below(7)).map(|_| label(rng)).collect::<Vec<_>>()
        })
    };
    let mut config = json!({
        "tags": tags(rng),
        "reach": rng.pick(&["following", "followers", "friends", "all", "wot", "me"]),
        "layout": rng.pick(&["columns", "wide", "visual", "list"]),
        "sort": rng.pick(&["recent", "popularity"]),
        "content": maybe(rng, 50, |rng| *rng.pick(&["short", "long", "image", "video", "link", "file", "collection", "weird"])),
    });
    if rng.chance(40) {
        config["domain_tags"] = json!(tags(rng));
    }
    let mut body = json!({"feed": config, "name": text(rng, &[100, 101, 300]), "created_at": created_at(rng, fx)});
    if rng.chance(80) {
        body["icon"] = json!(match rng.below(5) {
            0 => "Rocket".to_string(),
            1 => "a".repeat(50 + rng.below(2)),
            2 => " star ".into(),
            3 => "\u{0130}con".into(),
            _ => text(rng, &[10]),
        });
    }
    let id = match serde_json::from_value::<legacy_v0::V0Feed>(body.clone()) {
        Ok(feed) => V0HashId::create_id(&feed.sanitize()),
        Err(_) => legacy_v0::tag_id("x", "y"),
    };
    (
        format!("pub/pubky.app/feeds/{id}"),
        serde_json::to_vec(&body).unwrap(),
    )
}

fn gen_file(rng: &mut Rng, fx: &Fixture) -> (String, Vec<u8>) {
    let blob = rng.pick(&fx.blob_hashes).clone();
    let src = match rng.below(5) {
        0 => url(rng, fx),
        1 => format!("pubky://{OTHER}/pub/pubky.app/blobs/{blob}"),
        _ => format!("pubky://{OWNER}/pub/pubky.app/blobs/{blob}"),
    };
    let max = 100usize << 20;
    let body = json!({
        "name": text(rng, &[1, 255, 256]),
        "created_at": created_at(rng, fx),
        "src": src,
        "content_type": rng.pick(&["image/png", "IMAGE/PNG; charset=x", " image/jpeg ", "text/plain", "application/x-unknown", "image/", "video/mp4", "image/svg+xml"]),
        "size": *rng.pick(&[0usize, 1, 20, max, max + 1]),
    });
    (
        format!("pub/pubky.app/files/{}", timestamp_id(rng, fx)),
        serde_json::to_vec(&body).unwrap(),
    )
}

fn gen_blob(rng: &mut Rng, fx: &Fixture) -> (String, Vec<u8>) {
    let len = *rng.pick(&[0usize, 1, 2, 17, 1024, 4096, 65_537]);
    let bytes: Vec<u8> = (0..len).map(|_| rng.next() as u8).collect();
    let hash = match rng.below(10) {
        0 => rng.pick(&fx.blob_hashes).clone(),
        1 => hash_of(&bytes).to_lowercase(),
        _ => hash_of(&bytes),
    };
    (format!("pub/pubky.app/blobs/{hash}"), bytes)
}

// ---- the checks ----

fn reserialized(object: &PubkySocialObject) -> Vec<u8> {
    match object {
        PubkySocialObject::User(o) => serde_json::to_vec(o).unwrap(),
        PubkySocialObject::Post(o) => serde_json::to_vec(o).unwrap(),
        PubkySocialObject::Follow(o) => serde_json::to_vec(o).unwrap(),
        PubkySocialObject::Mute(o) => serde_json::to_vec(o).unwrap(),
        PubkySocialObject::Bookmark(o) => serde_json::to_vec(o).unwrap(),
        PubkySocialObject::Tag(o) => serde_json::to_vec(o).unwrap(),
        PubkySocialObject::File(o) => o.0.clone(),
        PubkySocialObject::Feed(o) => serde_json::to_vec(o).unwrap(),
    }
}

/// Every string in a JSON value, envelopes in `content` included.
fn strings(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(s) => {
            if let Ok(inner @ Value::Object(_)) = serde_json::from_str::<Value>(s) {
                strings(&inner, out);
            }
            out.push(s.clone());
        }
        Value::Array(items) => items.iter().for_each(|v| strings(v, out)),
        Value::Object(map) => map.values().for_each(|v| strings(v, out)),
        _ => {}
    }
}

#[derive(Default)]
struct Tally {
    cases: u64,
    ok: u64,
    writes: u64,
    dropped: u64,
    skips: BTreeMap<String, u64>,
    invalid_without_note: u64,
    invalid_without_note_examples: Vec<String>,
    legacy_post_refs: u64,
    legacy_post_ref_examples: Vec<String>,
    micros: u128,
}

struct Failure {
    kind: &'static str,
    case: u64,
    seed: u64,
    what: String,
    input: String,
}

fn preview(path: &str, bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let cut: String = text.chars().take(400).collect();
    format!("{path} {cut}")
}

fn check_case(
    kind: &'static str,
    case: u64,
    seed: u64,
    path: &str,
    bytes: &[u8],
    ctx: &MigrationCtx,
    tally: &mut Tally,
    failures: &mut Vec<Failure>,
) {
    let mut fail = |what: String| {
        failures.push(Failure {
            kind,
            case,
            seed,
            what,
            input: preview(path, bytes),
        });
    };
    let started = Instant::now();
    let first = catch_unwind(AssertUnwindSafe(|| {
        if kind == "file" {
            ctx.clone().migrate(path, bytes)
        } else {
            transform(path, bytes, ctx)
        }
    }));
    tally.micros += started.elapsed().as_micros();
    tally.cases += 1;
    let first = match first {
        Ok(result) => result,
        Err(panic) => {
            let message = panic
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_default();
            return fail(format!("panic: {message}"));
        }
    };
    let second = if kind == "file" {
        ctx.clone().migrate(path, bytes)
    } else {
        transform(path, bytes, ctx)
    };
    if first != second {
        fail("not deterministic".into());
    }
    match &first {
        Ok(Migrated { writes, dropped }) => {
            tally.ok += 1;
            tally.writes += writes.len() as u64;
            tally.dropped += dropped.len() as u64;
            let expected = if kind == "file" { 0 } else { 1 };
            if writes.len() != expected {
                fail(format!("{} writes, expected {expected}", writes.len()));
            }
            for (out_path, out_bytes) in writes {
                let uri = format!("pubky://{OWNER}/{out_path}");
                match PubkySocialObject::from_uri(&uri, out_bytes) {
                    Err(e) => fail(format!("write {out_path} fails the v1 reader: {e}")),
                    Ok(object) => {
                        if &reserialized(&object) != out_bytes {
                            fail(format!(
                                "write {out_path} does not re-serialize to its bytes"
                            ));
                        }
                    }
                }
                if kind == "blob" {
                    let size = bytes.len() as u64;
                    match ctx.blob_destination(path, size, &hash_of(bytes)) {
                        Ok(p) if &p == out_path => {}
                        other => fail(format!(
                            "blob_destination {other:?} disagrees with {out_path}"
                        )),
                    }
                    continue;
                }
                let Ok(value) = serde_json::from_slice::<Value>(out_bytes) else {
                    fail(format!("write {out_path} is not JSON"));
                    continue;
                };
                let mut all = vec![];
                strings(&value, &mut all);
                for s in all {
                    // What the frozen parser still calls a profile, follow or post is a v0 reference
                    let v0 = legacy_v0::ParsedUri::try_from(s.as_str()).map(|p| p.resource);
                    if matches!(
                        v0,
                        Ok(legacy_v0::Resource::User | legacy_v0::Resource::Follow(_))
                    ) {
                        fail(format!("write {out_path} keeps a v0 reference {s}"));
                    }
                    if matches!(v0, Ok(legacy_v0::Resource::Post(_))) {
                        tally.legacy_post_refs += 1;
                        if tally.legacy_post_ref_examples.len() < 5 {
                            tally
                                .legacy_post_ref_examples
                                .push(s.chars().take(200).collect());
                        }
                    }
                }
            }
        }
        Err(Skipped { skip, note }) => {
            *tally.skips.entry(skip.as_str().to_string()).or_default() += 1;
            if !Skip::ALL.contains(skip) {
                fail(format!("skip {skip} outside Skip::ALL"));
            }
            if *skip == Skip::Invalid && note.is_none() {
                tally.invalid_without_note += 1;
                if tally.invalid_without_note_examples.len() < 8 {
                    tally
                        .invalid_without_note_examples
                        .push(preview(path, bytes));
                }
            }
            if kind == "blob" {
                // The bytes-free door gives the same verdict
                let door = ctx.blob_destination(path, bytes.len() as u64, &hash_of(bytes));
                if let Err(Skipped {
                    skip: door_skip, ..
                }) = &door
                {
                    if door_skip != skip {
                        fail(format!(
                            "blob_destination skips {door_skip}, transform {skip}"
                        ));
                    }
                } else {
                    fail(format!(
                        "blob_destination {door:?}, transform skipped {skip}"
                    ));
                }
            }
        }
    }
}

#[test]
fn transforms_survive_hostile_v0_objects() {
    let cases: u64 = std::env::var("QA_FUZZ_CASES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(200);
    let base: u64 = std::env::var("QA_FUZZ_SEED")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0x5EED);
    let now = now_micros();

    // A context with a few Files: an image, a text file, one naming another tree's blob
    let blob_bytes: Vec<Vec<u8>> = (0u8..4).map(|i| vec![i + 1; 20 + i as usize]).collect();
    let blob_hashes: Vec<String> = blob_bytes.iter().map(|b| hash_of(b)).collect();
    let owner = PubkyId::try_from(OWNER).unwrap();
    let mut ctx = MigrationCtx::new(owner);
    let mut files = vec![];
    for (i, (ty, blob, host)) in [
        ("image/png", 0, OWNER),
        ("text/plain", 1, OWNER),
        ("image/jpeg", 2, OTHER),
        ("video/mp4", 3, OWNER),
    ]
    .into_iter()
    .enumerate()
    {
        let tsid = tsid(OCT_2024 + 1_000_000 * (i as i64 + 1));
        let body = json!({"name": format!("file {i}"), "created_at": OCT_2024, "src": format!("pubky://{host}/pub/pubky.app/blobs/{}", blob_hashes[blob]), "content_type": ty, "size": 20});
        ctx.read_v0_file(&tsid, &serde_json::to_vec(&body).unwrap())
            .expect("fixture File");
        files.push((tsid, blob_hashes[blob].clone()));
    }
    let fx = Fixture {
        files,
        blob_hashes,
        now,
    };

    type Gen = fn(&mut Rng, &Fixture) -> (String, Vec<u8>);
    let kinds: Vec<(&'static str, Gen)> = vec![
        ("profile", gen_profile),
        ("post_short", |r, f| gen_post(r, f, "short")),
        ("post_media", |r, f| {
            let kind = *r.pick(&["image", "video", "link", "file"]);
            gen_post(r, f, kind)
        }),
        ("post_long", |r, f| gen_post(r, f, "long")),
        ("post_collection", |r, f| gen_post(r, f, "collection")),
        ("tag", gen_tag),
        ("follow", |r, f| gen_follow(r, f, "follows")),
        ("mute", |r, f| gen_follow(r, f, "mutes")),
        ("bookmark", gen_bookmark),
        ("feed", gen_feed),
        ("file", gen_file),
        ("blob", gen_blob),
    ];

    let mut failures = vec![];
    let mut report = serde_json::Map::new();
    for (index, (kind, gen)) in kinds.iter().enumerate() {
        let mut tally = Tally::default();
        for case in 0..cases {
            let seed = base ^ ((index as u64) << 40) ^ case;
            let mut rng = Rng::new(seed);
            let (path, bytes) = gen(&mut rng, &fx);
            check_case(
                kind,
                case,
                seed,
                &path,
                &bytes,
                &ctx,
                &mut tally,
                &mut failures,
            );
        }
        report.insert(
            kind.to_string(),
            json!({
                "cases": tally.cases,
                "ok": tally.ok,
                "writes": tally.writes,
                "dropped": tally.dropped,
                "skips": tally.skips,
                "invalid_without_note": tally.invalid_without_note,
                "invalid_without_note_examples": tally.invalid_without_note_examples,
                "legacy_post_refs": tally.legacy_post_refs,
                "legacy_post_ref_examples": tally.legacy_post_ref_examples,
                "mean_micros_per_transform": tally.micros as f64 / tally.cases.max(1) as f64,
            }),
        );
    }
    let failure_list: Vec<Value> = failures
        .iter()
        .take(50)
        .map(|f| json!({"kind": f.kind, "case": f.case, "seed": f.seed, "what": f.what, "input": f.input}))
        .collect();
    let mut by_what: BTreeMap<String, u64> = BTreeMap::new();
    for f in &failures {
        let head: String = f.what.chars().take(60).collect();
        *by_what.entry(format!("{}: {head}", f.kind)).or_default() += 1;
    }
    let out = json!({
        "base_seed": base,
        "cases_per_kind": cases,
        "kinds": report,
        "failures": failures.len(),
        "failures_by_what": by_what,
        "failure_examples": failure_list,
    });
    if let Ok(file) = std::env::var("QA_FUZZ_OUT") {
        std::fs::write(file, serde_json::to_vec_pretty(&out).unwrap()).unwrap();
    }
    println!(
        "{}",
        serde_json::to_string_pretty(
            &json!({"failures": failures.len(), "failures_by_what": by_what})
        )
        .unwrap()
    );
    assert!(
        failures.is_empty(),
        "{} failing cases, first: {} case {} seed {}: {} on {}",
        failures.len(),
        failures[0].kind,
        failures[0].case,
        failures[0].seed,
        failures[0].what,
        failures[0].input
    );
}
