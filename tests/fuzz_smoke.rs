//! Seeded smoke over every model. Random valid instances built through the builders must read
//! back through ingest unchanged, and the same instance with one field broken must not read.
//! The seed and the counts are fixed, so a failure reproduces from the same run of choices.

use pubky_social_specs::traits::HashId;
use pubky_social_specs::*;
use serde_json::{json, Value};

const SEED: u64 = 0x5EED_2026_0923_0001;
const PER_MODEL: usize = 64;
const OWNER: &str = "operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo";
const OTHER: &str = "8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo";
const TS: &str = "0032SSN7Q4EVG";
const HASH: &str = "PZBQ010FF079VVZPQG1RNFN6DR";

/// xorshift64, enough to spread choices without a dependency.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }

    /// Inclusive on both ends.
    fn range(&mut self, lo: usize, hi: usize) -> usize {
        lo + self.below(hi - lo + 1)
    }

    fn coin(&mut self) -> bool {
        self.next() & 1 == 1
    }

    fn pick<T: Clone>(&mut self, items: &[T]) -> T {
        items[self.below(items.len())].clone()
    }

    fn string_of(&mut self, alphabet: &[char], len: usize) -> String {
        (0..len).map(|_| self.pick(alphabet)).collect()
    }

    /// `lo..=hi` code points with no whitespace at either end, so it is its own trim.
    fn text(&mut self, lo: usize, hi: usize) -> String {
        const EDGE: &[char] = &['a', 'Z', '7', 'é', 'ß', '中', '😀', '\u{200B}', '.'];
        const INNER: &[char] = &['a', 'q', 'Z', '0', 'é', '中', '😀', ' ', '\u{3000}', '-'];
        let len = self.range(lo, hi);
        let mut out = String::new();
        for i in 0..len {
            let alphabet = if i == 0 || i + 1 == len { EDGE } else { INNER };
            out.push(self.pick(alphabet));
        }
        out
    }

    /// Frozen whitespace around `core`, which the builders are expected to trim away.
    fn padded(&mut self, core: &str) -> String {
        const PAD: &[char] = &[' ', '\t', '\n', '\u{00A0}', '\u{3000}', '\u{2028}'];
        let (left, right) = (self.below(3), self.below(3));
        let left = self.string_of(PAD, left);
        let right = self.string_of(PAD, right);
        format!("{left}{core}{right}")
    }

    fn slug(&mut self, lo: usize, hi: usize) -> String {
        const SLUG: &[char] = &['a', 'b', 'k', 'x', 'z', '0', '4', '9'];
        let len = self.range(lo, hi);
        self.string_of(SLUG, len)
    }

    fn opt<T>(&mut self, make: impl FnOnce(&mut Self) -> T) -> Option<T> {
        self.coin().then(|| make(self))
    }
}

fn uri(pk: &str, path: &str) -> String {
    format!("pubky://{pk}{path}")
}

fn post_ref(rng: &mut Rng) -> String {
    let pk = rng.pick(&[OWNER, OTHER]);
    uri(pk, &format!("/pub/social/v1/posts/{TS}"))
}

fn web(rng: &mut Rng) -> String {
    let leaf = rng.slug(1, 12);
    format!("https://example.com/{leaf}")
}

fn media_ref(rng: &mut Rng) -> String {
    if rng.coin() {
        uri(OWNER, &format!("/pub/social/v1/files/{HASH}.png"))
    } else {
        format!("{}.png", web(rng))
    }
}

fn universal_ref(rng: &mut Rng) -> String {
    match rng.below(3) {
        0 => post_ref(rng),
        1 => uri(OTHER, "/pub/social/v1/profile.json"),
        _ => web(rng),
    }
}

/// One field broken: why that must reject, a substring of the error it must reject with, and
/// the edit.
type Break = (&'static str, &'static str, fn(&mut Value));

/// A model's name and its random valid instance.
type Model = (&'static str, fn(&mut Rng) -> Case);

struct Case {
    uri: String,
    object: Value,
    breaks: &'static [Break],
    /// For a content-addressed model, where the broken object itself lives, so a break is
    /// judged by its own rule and never by an id mismatch against the unbroken object.
    rehome: Option<fn(&Value) -> String>,
}

/// The inner envelope of an article or collection post, edited in place.
fn envelope(v: &mut Value, edit: impl FnOnce(&mut Value)) {
    let mut inner: Value = serde_json::from_str(v["content"].as_str().unwrap()).unwrap();
    edit(&mut inner);
    v["content"] = json!(inner.to_string());
}

fn user(rng: &mut Rng) -> Case {
    let name = rng.text(VALIDATION_LIMITS.user_name_min_length, 20);
    let links = rng.opt(|rng| {
        (0..rng.below(4))
            .map(|_| {
                let title = rng.text(1, 20);
                PubkySocialUserLink::new(rng.padded(&title), web(rng))
            })
            .collect()
    });
    let object = PubkySocialUser::new(
        rng.padded(&name),
        rng.opt(|rng| {
            let bio = rng.text(1, 60);
            rng.padded(&bio)
        }),
        rng.opt(media_ref),
        links,
        rng.opt(|rng| rng.text(1, 20)),
    );
    assert_eq!(object.name, name, "the builder trims");
    Case {
        uri: user_uri_builder(OWNER.into()),
        object: serde_json::to_value(&object).unwrap(),
        breaks: &[
            ("blank name", "name must not be blank", |v| {
                v["name"] = json!(" \u{3000} ")
            }),
            (
                "name over the cap",
                "name must be 3 to 50 code points",
                |v| v["name"] = json!("a".repeat(51)),
            ),
            ("empty bio", "bio must not be blank", |v| {
                v["bio"] = json!("")
            }),
            ("blank status", "status must not be blank", |v| {
                v["status"] = json!("\t")
            }),
            (
                "short-form image",
                "image must be spelled in canonical form",
                |v| v["image"] = json!(format!("pubky{OWNER}/pub/social/v1/files/{HASH}.png")),
            ),
            (
                "padded link url",
                "links[0].url must be a canonical web URI",
                |v| v["links"] = json!([{"title": "site", "url": " https://example.com"}]),
            ),
        ],
        rehome: None,
    }
}

fn attachments(rng: &mut Rng) -> Vec<PubkySocialAttachment> {
    (0..rng.below(3))
        .map(|_| {
            let alt = rng.opt(|rng| rng.text(0, 30));
            let name = rng.opt(|rng| {
                let name = rng.text(1, 20);
                rng.padded(&name)
            });
            PubkySocialAttachment::new(media_ref(rng), alt, name)
        })
        .collect()
}

fn mint(post: &PubkySocialPost) -> String {
    let owner = PubkyId::try_from(OWNER).unwrap();
    let version = post.create_version(Root::Pub, &owner, None).unwrap();
    uri(OWNER, &version.path)
}

fn note(rng: &mut Rng) -> Case {
    let content = rng.text(1, 80);
    let kind = rng.pick(&[
        PubkySocialPostKind::Note,
        PubkySocialPostKind::Image,
        PubkySocialPostKind::Video,
        PubkySocialPostKind::Link,
        PubkySocialPostKind::File,
    ]);
    let post = PubkySocialPost::new(
        rng.padded(&content),
        kind,
        rng.opt(universal_ref),
        rng.opt(universal_ref),
        attachments(rng),
    );
    assert_eq!(post.content, content, "the builder trims");
    Case {
        uri: mint(&post),
        object: serde_json::to_value(&post).unwrap(),
        breaks: &[
            (
                "blank content and nothing else",
                "must have content, an embed, or attachments",
                |v| {
                    v["content"] = json!(" \u{3000} ");
                    v["embed"] = Value::Null;
                    v["attachments"] = json!([]);
                },
            ),
            ("unknown kind", "post kind is unknown", |v| {
                v["kind"] = json!("hologram")
            }),
            ("versioned parent", "parent must be versionless", |v| {
                v["parent"] = json!(uri(OWNER, &format!("/pub/social/v1/posts/{TS}/{TS}.json")))
            }),
            (
                "private parent",
                "parent must not reference a private object",
                |v| v["parent"] = json!(uri(OWNER, &format!("/priv/social/v1/posts/{TS}"))),
            ),
            ("padded embed", "embed must be a canonical URI", |v| {
                v["embed"] = json!(" https://example.com/x")
            }),
            (
                "blank attachment name",
                "attachments[0].name must be",
                |v| v["attachments"] = json!([{"uri": "https://example.com/a.png", "name": " "}]),
            ),
        ],
        rehome: None,
    }
}

fn article(rng: &mut Rng) -> Case {
    let title = rng.text(1, 40);
    let post = PubkySocialPost::new_article(
        rng.padded(&title),
        rng.text(0, 200),
        rng.opt(media_ref),
        rng.opt(universal_ref),
        rng.opt(universal_ref),
        attachments(rng),
        None,
    );
    Case {
        uri: mint(&post),
        object: serde_json::to_value(&post).unwrap(),
        breaks: &[
            (
                "blank title",
                "Article title must contain non-whitespace",
                |v| envelope(v, |e| e["title"] = json!("  ")),
            ),
            (
                "content that is not an envelope",
                "Article content must be a valid JSON envelope",
                |v| v["content"] = json!("just text"),
            ),
            (
                "short-form cover",
                "cover_image must be spelled in canonical form",
                |v| {
                    envelope(v, |e| {
                        e["cover_image"] =
                            json!(format!("pubky{OWNER}/pub/social/v1/files/{HASH}.png"))
                    })
                },
            ),
        ],
        rehome: None,
    }
}

fn collection(rng: &mut Rng) -> Case {
    let name = rng.text(1, 40);
    let items = (0..rng.below(5))
        .map(|_| {
            let note = rng.opt(|rng| rng.text(1, 30));
            PubkySocialCollectionItem::new(universal_ref(rng), note)
        })
        .collect();
    // A blank description is the builder's to drop, so it is in the draw on purpose
    let description = match rng.below(3) {
        0 => None,
        1 => Some(rng.padded("")),
        _ => {
            let description = rng.text(1, 80);
            Some(rng.padded(&description))
        }
    };
    let layout = rng.opt(|rng| {
        rng.pick(&[
            PubkySocialCollectionLayout::Grid,
            PubkySocialCollectionLayout::List,
            PubkySocialCollectionLayout::Visual,
        ])
    });
    let post = PubkySocialPost::new_collection(
        rng.padded(&name),
        description,
        items,
        rng.opt(media_ref),
        layout,
    );
    Case {
        uri: mint(&post),
        object: serde_json::to_value(&post).unwrap(),
        breaks: &[
            (
                "empty description",
                "Collection description must not be blank",
                |v| envelope(v, |e| e["description"] = json!("")),
            ),
            (
                "whitespace description",
                "Collection description must not be blank",
                |v| envelope(v, |e| e["description"] = json!(" \t\u{3000}")),
            ),
            (
                "blank name",
                "Collection name must contain non-whitespace",
                |v| envelope(v, |e| e["name"] = json!("\n")),
            ),
            ("blank item note", "items[0].note must be", |v| {
                envelope(v, |e| {
                    e["items"] = json!([{"uri": "https://example.com/i", "note": " "}])
                })
            }),
            (
                "parent on a collection",
                "cannot have parent or embed",
                |v| v["parent"] = json!(uri(OWNER, &format!("/pub/social/v1/posts/{TS}"))),
            ),
        ],
        rehome: None,
    }
}

fn tag(rng: &mut Rng) -> Case {
    const LABEL: &[char] = &['a', 'B', 'c', 'X', '1', '9', '-', '_', 'é', '中'];
    let len = rng.range(1, VALIDATION_LIMITS.tag_label_max_length);
    let label = rng.string_of(LABEL, len);
    let tag = PubkySocialTag::new(universal_ref(rng), rng.padded(&label));
    assert_eq!(tag.label, ascii_fold(&label), "the builder trims and folds");
    Case {
        uri: tag_uri_builder(OWNER.into(), tag.create_id()),
        object: serde_json::to_value(&tag).unwrap(),
        breaks: &[
            ("unfolded label", "must be stored folded", |v| {
                v["label"] = json!("Rust")
            }),
            ("padded uri", "uri must be a canonical URI", |v| {
                v["uri"] = json!(" https://example.com/t")
            }),
            ("label with a colon", "contains invalid character: :", |v| {
                v["label"] = json!("a:b")
            }),
        ],
        rehome: Some(|v| {
            let tag: PubkySocialTag = serde_json::from_value(v.clone()).unwrap();
            tag_uri_builder(OWNER.into(), tag.create_id())
        }),
    }
}

/// A target past the primary filename's byte cap, so it names no primary entry.
fn long_target() -> String {
    format!("https://example.com/{}", "z".repeat(200))
}

fn bookmark_case(target: &str, breaks: &'static [Break]) -> Case {
    let created = create_bookmark(target).unwrap();
    Case {
        uri: bookmark_uri_builder(OWNER.into(), created.filename),
        object: serde_json::to_value(&created.bookmark).unwrap(),
        breaks,
        rehome: None,
    }
}

fn bookmark(rng: &mut Rng) -> Case {
    bookmark_case(
        &universal_ref(rng),
        &[
            ("unsafe created_at", "outside the JSON-safe range", |v| {
                v["created_at"] = json!(MAX_SAFE_JSON_INT + 1)
            }),
            (
                "a target in the content of a primary entry",
                "carries its target in the filename",
                |v| v["target"] = json!(long_target()),
            ),
        ],
    )
}

fn overflow_bookmark(rng: &mut Rng) -> Case {
    let tail = rng.slug(170, 250);
    bookmark_case(
        &format!("https://example.com/{tail}"),
        &[
            ("unsafe created_at", "outside the JSON-safe range", |v| {
                v["created_at"] = json!(MAX_SAFE_JSON_INT + 1)
            }),
            (
                "a target the filename does not hash",
                "does not hash its target",
                |v| v["target"] = json!(long_target()),
            ),
            (
                "no target in an overflow entry",
                "requires target in the content",
                |v| {
                    v.as_object_mut().unwrap().remove("target");
                },
            ),
        ],
    )
}

fn follow(_: &mut Rng) -> Case {
    Case {
        uri: follow_uri_builder(OWNER.into(), OTHER.into()),
        object: serde_json::to_value(PubkySocialFollow::new()).unwrap(),
        breaks: &[
            ("unsafe created_at", "outside the JSON-safe range", |v| {
                v["created_at"] = json!(MAX_SAFE_JSON_INT + 1)
            }),
            ("created_at not a number", "invalid type: string", |v| {
                v["created_at"] = json!("now")
            }),
        ],
        rehome: None,
    }
}

fn mute(_: &mut Rng) -> Case {
    Case {
        uri: mute_uri_builder(OWNER.into(), OTHER.into()),
        object: serde_json::to_value(PubkySocialMute::new()).unwrap(),
        breaks: &[
            ("unsafe created_at", "outside the JSON-safe range", |v| {
                v["created_at"] = json!(MAX_SAFE_JSON_INT + 1)
            }),
            ("created_at not a number", "invalid type: string", |v| {
                v["created_at"] = json!("now")
            }),
        ],
        rehome: None,
    }
}

fn feed(rng: &mut Rng) -> Case {
    fn labels(rng: &mut Rng) -> Vec<String> {
        (0..rng.range(1, VALIDATION_LIMITS.feed_tags_max_count))
            .map(|_| {
                let len = rng.range(1, 8);
                let label = rng.string_of(&['a', 'B', 'q', '3', '-'], len);
                rng.padded(&label)
            })
            .collect()
    }
    let config = PubkySocialFeedConfig::new(
        rng.opt(labels),
        rng.opt(labels),
        rng.pick(&[
            PubkySocialFeedReach::Following,
            PubkySocialFeedReach::Followers,
            PubkySocialFeedReach::Friends,
            PubkySocialFeedReach::All,
            PubkySocialFeedReach::Wot,
            PubkySocialFeedReach::Me,
        ]),
        rng.pick(&[
            PubkySocialFeedLayout::Columns,
            PubkySocialFeedLayout::Wide,
            PubkySocialFeedLayout::Visual,
            PubkySocialFeedLayout::List,
        ]),
        rng.pick(&[PubkySocialFeedSort::Recent, PubkySocialFeedSort::Popularity]),
        rng.opt(|rng| {
            rng.pick(&[
                PubkySocialPostKind::Note,
                PubkySocialPostKind::Article,
                PubkySocialPostKind::Image,
            ])
        }),
    )
    .unwrap();
    let name = rng.text(1, 40);
    let len = rng.range(1, 20);
    let icon = rng.string_of(&['a', 'Z', 'm', '2', '-'], len);
    let feed = PubkySocialFeed::new(config, rng.padded(&name), rng.padded(&icon));
    Case {
        uri: feed_uri_builder(OWNER.into(), feed.create_id()),
        object: serde_json::to_value(&feed).unwrap(),
        breaks: &[
            ("blank name", "Feed name cannot be empty", |v| {
                v["name"] = json!("\u{3000}")
            }),
            ("icon with a space", "contains invalid character", |v| {
                v["icon"] = json!("bad icon")
            }),
            ("unknown reach", "feed reach is unknown", |v| {
                v["feed"]["reach"] = json!("nearby")
            }),
            ("unfolded tag", "must be stored folded", |v| {
                v["feed"]["tags"] = json!(["Rust"])
            }),
        ],
        rehome: Some(|v| {
            let feed: PubkySocialFeed = serde_json::from_value(v.clone()).unwrap();
            feed_uri_builder(OWNER.into(), feed.create_id())
        }),
    }
}

/// The object `from_uri` read, as JSON, to compare with what was written.
fn read_back(object: &PubkySocialObject) -> Value {
    match object {
        PubkySocialObject::User(o) => serde_json::to_value(o),
        PubkySocialObject::Post(o) => serde_json::to_value(o),
        PubkySocialObject::Follow(o) => serde_json::to_value(o),
        PubkySocialObject::Mute(o) => serde_json::to_value(o),
        PubkySocialObject::Bookmark(o) => serde_json::to_value(o),
        PubkySocialObject::Tag(o) => serde_json::to_value(o),
        PubkySocialObject::Feed(o) => serde_json::to_value(o),
        PubkySocialObject::File(_) => unreachable!("media has no JSON form"),
    }
    .unwrap()
}

#[test]
fn built_objects_read_back_and_broken_ones_do_not() {
    let models: &[Model] = &[
        ("user", user),
        ("note", note),
        ("article", article),
        ("collection", collection),
        ("tag", tag),
        ("bookmark", bookmark),
        ("overflow bookmark", overflow_bookmark),
        ("follow", follow),
        ("mute", mute),
        ("feed", feed),
    ];
    let mut rng = Rng(SEED);
    for (model, build) in models {
        for n in 0..PER_MODEL {
            let case = build(&mut rng);
            let bytes = serde_json::to_vec(&case.object).unwrap();
            let read = PubkySocialObject::from_uri(&case.uri, &bytes)
                .unwrap_or_else(|e| panic!("{model} #{n} rejected: {e}\n{}", case.object));
            assert_eq!(
                read_back(&read),
                case.object,
                "{model} #{n} rewritten on read"
            );

            // Cycled rather than drawn, so every break runs
            let (why, expected, break_it) = case.breaks[n % case.breaks.len()];
            let mut broken = case.object.clone();
            break_it(&mut broken);
            let at = case
                .rehome
                .map_or(case.uri.clone(), |rehome| rehome(&broken));
            let bytes = serde_json::to_vec(&broken).unwrap();
            match PubkySocialObject::from_uri(&at, &bytes) {
                Ok(_) => panic!("{model} #{n} accepted with {why}: {broken}"),
                Err(e) => assert!(
                    e.contains(expected),
                    "{model} #{n} with {why} rejected for another reason: {e}"
                ),
            }
        }
    }
}

#[test]
fn built_files_read_back_and_altered_bytes_do_not() {
    let mut rng = Rng(SEED ^ 0xF11E);
    for n in 0..PER_MODEL {
        let len = rng.range(1, 256);
        let bytes: Vec<u8> = (0..len).map(|_| rng.next() as u8).collect();
        let declared = rng.pick(&["image/png", "image/jpeg", "text/plain", "x/unknown"]);
        let created = PubkySocialFile::create_file(bytes.clone(), declared, Root::Pub).unwrap();
        let file_uri = uri(OWNER, &created.path);
        assert!(
            PubkySocialObject::from_uri(&file_uri, &bytes).is_ok(),
            "file #{n} rejected"
        );
        let mut altered = bytes;
        let at = rng.below(altered.len());
        altered[at] ^= 1 << rng.below(8);
        assert!(
            PubkySocialObject::from_uri(&file_uri, &altered).is_err(),
            "file #{n} accepted with a flipped bit"
        );
    }
}
