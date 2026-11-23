# pubky-social-specs

[![crates.io](https://img.shields.io/crates/v/pubky-social-specs)](https://crates.io/crates/pubky-social-specs)
[![docs.rs](https://img.shields.io/docsrs/pubky-social-specs)](https://docs.rs/pubky-social-specs)
[![npm](https://img.shields.io/npm/v/pubky-social-specs)](https://www.npmjs.com/package/pubky-social-specs)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/pubky/pubky-social-specs/blob/v1/LICENSE)

Rust types, builders, and validation for the Pubky social data model: profiles, posts, tags, bookmarks, follows, mutes, feeds and media. Use this crate to build the exact JSON, ids and paths that [Pubky indexers](https://github.com/pubky/pubky-nexus) expect, and to check what you read back.

This is the **1.x** data model. Objects live under `/pub/social/v1/`, readable by anyone, and `/priv/social/v1/`, readable by the owner and the apps the owner granted. It replaces the 0.x layout of [`pubky-app-specs`](https://crates.io/crates/pubky-app-specs), under `/pub/pubky.app/`.

> **Stability:** within 1.x the stored models only grow. Every 1.x release reads what any earlier 1.x release wrote, derives every id the same way, and writes back the members a newer writer added untouched. A change that cannot be made that way goes to `social/v2`.

## Installation

```bash
cargo add pubky-social-specs serde_json
```

`serde_json` is for the examples below.

## Quick start

```rust
use pubky_social_specs::{
    traits::{HasPath, Validatable},
    PubkySocialUser, PUB_CTX,
};
use serde_json::to_vec;

// Create a user profile
let user = PubkySocialUser::new("Alice".into(), None, None, None, None);
let path = PubkySocialUser::create_path(); // /pub/social/v1/profile.json
let json = to_vec(&user).unwrap();

// Parse and validate JSON from storage. Fully qualified, since the name clashes with
// std's `TryFrom`; "" is the id from the path, which a profile does not have.
let profile = <PubkySocialUser as Validatable>::try_from(&json, "", &PUB_CTX).unwrap();
```

For a full homeserver flow, see [`examples/create_user.rs`](https://github.com/pubky/pubky-social-specs/blob/v1/examples/create_user.rs).

## Why use this crate

- **Single source of truth:** the Rust models are the reference, and the [npm package](https://www.npmjs.com/package/pubky-social-specs) is held equal to them by recorded vectors and a differential fuzz.
- **No silent rewrites:** builders trim text and fold tokens. After that a value is stored as written, and reading an object never repairs what a writer stored.

## Features

| Feature    | Purpose                        |
| ---------- | ------------------------------ |
| `openapi`  | OpenAPI schemas via `utoipa`   |
| `migrator` | The 0.x to 1.x transforms      |

```bash
cargo add pubky-social-specs --features openapi
```

`migrator` adds the `migrate` module: I/O-free functions that take one owner's `/pub/pubky.app/` objects as bytes and return the `social/v1` objects to write. Every output is read back through the 1.x reader before it is returned, and an object that cannot migrate is skipped with a counted reason, never repaired. Only a client that runs the migration needs it, so it is off by default; [`pubky-social-migrator`](https://www.npmjs.com/package/pubky-social-migrator) is that client, built from this crate to wasm.

- **MSRV:** 1.91 (see `rust-version` in `Cargo.toml`)
- **API docs:** [docs.rs/pubky-social-specs](https://docs.rs/pubky-social-specs)

## Models

| Rust type             | Stored at                                         | Purpose                                         |
| --------------------- | ------------------------------------------------- | ----------------------------------------------- |
| `PubkySocialUser`     | `/pub/social/v1/profile.json`                     | User profile                                    |
| `PubkySocialPost`     | `/{pub\|priv}/social/v1/posts/{postId}/{editId}.json` | Notes, replies, articles and collections    |
| `PubkySocialFile`     | `/{pub\|priv}/social/v1/files/{hash}.{ext}`       | Media bytes, content addressed                  |
| `PubkySocialTag`      | `/pub/social/v1/tags/{tagId}.json`                | Tags applied to URIs                            |
| `PubkySocialBookmark` | `/priv/social/v1/bookmarks/{filename}.json`       | Private bookmarks, target in the filename       |
| `PubkySocialFollow`   | `/pub/social/v1/follows/{followee}.json`          | Follow relationships                            |
| `PubkySocialMute`     | `/priv/social/v1/mutes/{mutee}.json`              | Muted users                                     |
| `PubkySocialFeed`     | `/priv/social/v1/feeds/{feedId}.json`             | Feed configurations, published by a copy under `/pub/` |

A post is a directory of versions: each edit writes a new `{editId}.json` (or `{editId}-{label}.json`), and a reference to the post names the directory, so it survives every edit. Posts and media live under either root, so a draft stays private until it is published. Compared with 0.x, the File object and its blob are one content-addressed file, and settings and last-read markers are no longer part of this library.

`PubkySocialPost` is `PostEnvelope<PubkySocialPostKind>`. The envelope holds what every post shares (parent, embed, attachments, lock, the preserved unknown members, the id mint and the versioned layout), and the `PostKind` parameter holds one namespace's kinds and their content rules. An app that needs its own kinds instantiates the same envelope under its own namespace and never touches the social kind set.

Every `Validatable` rejection starts with `Validation Error: `, and the npm package throws the same message for the same input.

## Reading 0.x data

`legacy_v0` is the 0.x reader, frozen at the 0.8.0 pin: that release's parser, read models and validation, copied with the few differences its module documentation lists. Apart from those, an object 0.x accepted or rejected keeps the same answer forever: hand `legacy_v0::PubkyAppObject::from_uri` a stored URI and the bytes and it answers what 0.8.0 answered. The 0.x layout is described in [`docs/SPEC_V0.md`](https://github.com/pubky/pubky-social-specs/blob/v1/docs/SPEC_V0.md).

`stable_id` keys a stored path the same under either epoch, so a migrated object indexes in place rather than twice. Tags, bookmarks and feeds are the exception, see [Relationship to 0.x](https://github.com/pubky/pubky-social-specs/blob/v1/SPEC.md#relationship-to-0x):

```rust
use pubky_social_specs::stable_id;

assert_eq!(
    stable_id("pub/pubky.app/posts/0RDX5H0000000"),
    stable_id("pub/social/v1/posts/0RDX5H0000000/0RDX5J0000002.json"),
);
```

## Specification

See the [data model specification](https://github.com/pubky/pubky-social-specs/blob/v1/SPEC.md) for the URI layout, examples, and validation rules.

## Contributing

[`TESTING.md`](https://github.com/pubky/pubky-social-specs/blob/v1/TESTING.md) covers the test suites and the QA harnesses, and [`RELEASING.md`](https://github.com/pubky/pubky-social-specs/blob/v1/RELEASING.md) how a version is published.

## License

MIT
