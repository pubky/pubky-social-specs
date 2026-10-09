# pubky-social-specs

[![crates.io](https://img.shields.io/crates/v/pubky-social-specs)](https://crates.io/crates/pubky-social-specs)
[![docs.rs](https://img.shields.io/docsrs/pubky-social-specs)](https://docs.rs/pubky-social-specs)
[![npm](https://img.shields.io/npm/v/pubky-social-specs)](https://www.npmjs.com/package/pubky-social-specs)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Rust types, builders, and validation for Pubky social data models. The builders trim text and fold tokens; reading an object back never rewrites it. Use this crate to build JSON that matches what [Pubky indexers](https://github.com/pubky/pubky-nexus) expect.

## Installation

**Rust** ([crates.io](https://crates.io/crates/pubky-social-specs)):

```bash
cargo add pubky-social-specs
```

**JavaScript / TypeScript** ([npm](https://www.npmjs.com/package/pubky-social-specs)): see [`pkg/README.md`](https://github.com/pubky/pubky-social-specs/blob/main/pkg/README.md). The package is a native TypeScript implementation of this crate's 1.x surface, held to it by the surface oracle (feature `surface`, see [`TESTING.md`](https://github.com/pubky/pubky-social-specs/blob/main/TESTING.md)); only its migration subpath is this crate compiled to wasm.

## Rust quick start

```rust
use pubky_social_specs::{
    traits::{HasPath, Validatable},
    PubkySocialUser,
};
use serde_json::to_vec;

// Create a user profile
let user = PubkySocialUser::new("Alice".into(), None, None, None, None);
let path = PubkySocialUser::create_path(); // /pub/social/v1/profile.json
let json = to_vec(&user).unwrap();

// Parse and validate JSON from storage
let profile = PubkySocialUser::try_from(&json, "", &PUB_CTX).unwrap();
```

For a full homeserver flow, see [`examples/create_user.rs`](https://github.com/pubky/pubky-social-specs/blob/main/examples/create_user.rs).

## Why use this crate

- **Validation consistency:** same validation rules as Pubky indexers, and the same canonical forms on the wire.
- **Auto IDs and paths:** generates IDs, paths, and URLs according to Pubky standards.
- **Single source of truth:** the Rust models drive native consumers and the WASM bindings.
- **No silent rewrites:** builders canonicalize (an attachment name is trimmed there), and after that a value is stored as written and counted as written, so reading never repairs what a writer stored.

## Features

| Feature    | Purpose                        |
| ---------- | ------------------------------ |
| `openapi`  | OpenAPI schemas via `utoipa`   |
| `migrator` | The 0.x to v1 transforms       |

```toml
pubky-social-specs = { version = "1.0.0-alpha.5", features = ["openapi"] }
```

`migrator` adds the `migrate` module: functions that take one owner's `pub/pubky.app/` objects as bytes and return the `social/v1` objects to write, with references rewritten, media dereferenced through the 0.x File objects, content-addressed ids re-derived, and every output read back through the v1 reader before it is returned. An object that cannot migrate is skipped with a counted category, never repaired. Every transform works from the object the frozen 0.x reader stores for the path at its own id, and an object is skipped when the frozen 0.x reader refuses it; a skip carries what the refusing parser or reader said as its `note`. The functions are pure but for one clock: the 0.x reader bounds a TimestampId by the time, so an object refused for a future id on one run is accepted on a later run. Only a client that runs the migration needs it, so it is off by default for the crate; the npm package is built with it, since that package is what the browser migrator runs.

- **MSRV:** 1.89 (see `rust-version` in `Cargo.toml`)
- **API docs:** [docs.rs/pubky-social-specs](https://docs.rs/pubky-social-specs)

## Models

| Rust type           | Purpose                                  |
| ------------------- | ---------------------------------------- |
| `PubkySocialUser`      | User profile information                 |
| `PubkySocialFile`      | Media bytes                              |
| `PubkySocialPost`      | Posts, replies, embeds, and collections  |
| `PubkySocialTag`       | Tags applied to Pubky URIs               |
| `PubkySocialBookmark`  | Private bookmarks, target in the filename |
| `PubkySocialFollow`    | Follow relationships                     |
| `PubkySocialFeed`      | Feed configurations                      |
| `PubkySocialMute`      | Muted users                              |

`PubkySocialPost` is `PostEnvelope<PubkySocialPostKind>`. The envelope carries what every post
shares (parent, embed, attachments, lock, the preserved `extra` map, the byte cap, the id mint
and the versioned `posts/{id}/{editId}.json` layout under a namespace); the `PostKind` type
parameter carries one namespace's kind vocabulary and its per-kind content rules. An app that
needs its own kinds instantiates the same envelope under its own namespace, with the same wire
shape, and never touches the social kind set. Every refusal the npm package throws for the data model and every
`Validatable` rejection starts with `Validation Error: `; a `PostKind::validate_content` returns
its messages with that prefix already, the envelope hands them through unchanged.

## Reading 0.x data

`legacy_v0` is the 0.x reader, frozen at the 0.8.0 pin. It carries that release's parser, read models and validation copied unchanged, so an object 0.x accepted or rejected keeps the same answer forever, and none of it is edited to match the 1.x rules. Hand its object enum a stored URI and the bytes and it answers what 0.8.0 answered.

`stable_id` keys a stored path the same under either epoch, so a migrated object indexes in place rather than twice:

```rust
use pubky_social_specs::stable_id;

assert_eq!(
    stable_id("pub/pubky.app/posts/0RDX5H0000000"),
    stable_id("pub/social/v1/posts/0RDX5H0000000/0RDX5J0000002.json"),
);
```

## Specification

The 1.x design is in [`docs/rfc-v1-social-specs.md`](https://github.com/pubky/pubky-social-specs/blob/main/docs/rfc-v1-social-specs.md). The legacy 0.x layout is in [`docs/SPEC_V0.md`](https://github.com/pubky/pubky-social-specs/blob/main/docs/SPEC_V0.md), for reading un-migrated data.

## Releasing

One tag publishes both the crate and the npm package. Bump `version` in `Cargo.toml` and `pkg/package.json` in the same commit (CI fails when they differ, and `Cargo.lock` has to follow), with the subject `chore: <version>`. Merge it into `v1` or `main`, then tag that commit and push the tag:

```bash
git tag v1.0.0-alpha.5 && git push origin v1.0.0-alpha.5
```

The Release workflow runs every CI workflow again and refuses a tag that does not match both versions or that is not on `v1` or `main`. Then it publishes to crates.io and npm and opens a GitHub release with the npm tarball attached. A version with a `-` in it goes out under the npm `next` tag and is marked as a prerelease; any other version goes to `latest`. There are no registry tokens anywhere, both registries trust this workflow through GitHub OIDC.

A prerelease tag like `v1.0.0-alpha.5` needs nothing beyond this, it goes out under `next`. The stable `v1.0.0` tag moves `latest`, so it waits until the rollout is done: the indexer reads both epochs, the homeserver `/priv/` tier is verified, and the app has deployed its adoption. The workflow's CI and ancestry checks know none of that. Whoever approves the `release` environment has to confirm those before approving a stable tag.

The crates.io and npm jobs run in parallel. If npm fails after the crate already went out, open the run and use Re-run failed jobs, which picks up the tarball uploaded earlier in the same run. Re-run all jobs would fail trying to publish the crate a second time.

### Rehearsing

In Actions, pick Release, then Run workflow on any branch or tag and leave `dry_run` checked. It runs all the checks and the build and uploads the npm tarball as an artifact, but publishes nothing. Unchecking `dry_run` only publishes from a tag, on a branch the run fails.

### One-time setup

The repository has to be `pubky/pubky-social-specs` before anything else, so rename it first if it still has the old name. Until then the npm publish fails, because npm requires `repository.url` in `pkg/package.json` to match the repository the workflow runs in.

Then create an environment called `release` in the repository settings. Add required reviewers to it, and under Deployment branches and tags pick Selected with the tag rule `v*`. A repository ruleset limiting who can create `v*` tags belongs next to it. The registries accept any run of `release.yml` in the `release` environment whatever ref it started from, so these rules are what keep someone with write access from publishing a modified workflow off a branch.

A trusted publisher can only be added to a package that already exists, on both registries, so the very first version of each goes out by hand from a clean checkout:

```bash
cargo publish --locked
cd pkg && npm run build && npm publish --access public --tag next
```

Do not push a `v` tag for that version, the workflow would try to publish it again. After the bootstrap, add the trusted publisher on each registry. On crates.io it lives under the crate's Settings, Trusted Publishing, GitHub. On npmjs.com it is the package's Settings page, Trusted Publisher, GitHub Actions. Both take the same values:

| Field | Value |
| --- | --- |
| Owner / organization | `pubky` |
| Repository | `pubky-social-specs` |
| Workflow filename | `release.yml` |
| Environment | `release` |

On npmjs.com the same form has Allowed actions. `npm stage publish` is always allowed, and a trusted publisher created after September 3, 2026 allows only that by default. Enable `npm publish` there too, because the workflow publishes directly. With the default left in place the npm job fails, possibly after the crate already went out to crates.io.

Both registries match on the repository name, and npm also checks it against `repository.url` in `pkg/package.json`. Renaming the GitHub repository again later means updating both entries and that field.

### Using a build that is not published yet

A git dependency cannot give you the npm package, because `dist/`, the compiled modules and the migrator's wasm, is build output and never committed. Build a tarball instead:

```bash
cd pkg && npm run build && npm pack
```

and point the consuming project at it, for example `"pubky-social-specs": "file:../pubky-social-specs-1.0.0-alpha.5.tgz"`. A dry run of the Release workflow uploads the same tarball as an artifact, if you would rather not build it yourself. The crate has no such problem: a Cargo git dependency builds from source.

## License

MIT
