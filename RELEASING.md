# Releasing

One tag publishes the crate and both npm packages, `pubky-social-specs` (`pkg/`) and `pubky-social-migrator` (`migrator/`). Start from the current head of `v1`. Bump `version` in `Cargo.toml`, `pkg/package.json` and `migrator/package.json`, and the migrator's dependency on `pubky-social-specs`, and head the release's section with the version in `pkg/CHANGELOG.md` and `migrator/CHANGELOG.md` (between releases it is `## Unreleased`), all in the same commit, with the subject `chore: <version>`. `Cargo.lock` and `package-lock.json` have to follow. Pull request CI fails when `Cargo.toml` and `pkg/package.json` differ; the migrator's version and its dependency are compared only by the Release workflow, when the tag is pushed, and nothing checks the changelogs. Merge it into `v1` or `main`, then tag that commit and push the tag:

```bash
git tag v1.2.3 && git push origin v1.2.3
```

The Release workflow runs every CI workflow again and refuses a tag that does not match both versions or that is not on `v1` or `main`. Then it publishes to crates.io and npm, the core before the migrator, and opens a GitHub release with both npm tarballs attached. A version with a `-` in it goes out under the npm `next` tag and is marked as a prerelease; any other version goes to `latest`. There are no registry tokens anywhere, both registries trust this workflow through GitHub OIDC.

A prerelease tag like `v1.3.0-rc.1` waits for nothing, it goes out under `next`. The workflow moves `latest` only for a stable version, so until `v1.0.0` point it at each prerelease by hand, for both packages: `npm dist-tag add <package>@<version> latest`. A stable tag moves `latest`, so every new install gets it at once. For `v1.0.0`, the first stable release, that waits until the rollout is done: the indexer reads both epochs, the homeserver `/priv/` tier is verified, the per-user storage quota is raised for the migration, and the app has deployed its adoption. The workflow's CI and ancestry checks know none of that and nobody approves the run, so pushing the stable tag is the confirmation: check those first.

The crates.io and npm jobs run in parallel. If npm fails after the crate already went out, open the run and use Re-run failed jobs, which picks up the tarballs uploaded earlier in the same run and skips a package already published at that version. Re-run all jobs would not publish the crate twice either, the crate job skips a version already on crates.io, but it builds the tarballs again, so prefer Re-run failed jobs.

## After the tag

Check that the version is on crates.io and on npm for both packages, that docs.rs built the crate's docs, and that the GitHub release holds both tarballs. Before `v1.0.0`, move `latest` as above.

`js-native-reproducible.yml` rebuilds `dist` from the tag with the pinned toolchain and compares it with the tarballs npm serves. A release this workflow opens does not start it, because GitHub starts no workflow from an event made with a workflow's own token, so run it by hand: in Actions, pick it, then Run workflow with the tag. Like the rehearsal below, GitHub offers that only once the file is on the default branch.

A published version cannot be replaced on either registry. If one is bad, yank it on crates.io (`cargo yank --version <version> pubky-social-specs`), deprecate it on npm for both packages (`npm deprecate <package>@<version> "<reason>"`), move `latest` back if it pointed there, and release the next version.

## Rehearsing

In Actions, pick Release, then Run workflow on any branch or tag and leave `dry_run` checked. It runs all the checks and the build and uploads both npm tarballs as an artifact, but publishes nothing. GitHub offers Run workflow only once `release.yml` is on the default branch. Unchecking `dry_run` only publishes from a tag, on a branch the run fails.

Without it, rehearse locally from a clean checkout: `cargo publish --dry-run --locked` packages and builds the crate as crates.io would, and the commands under [Using a build that is not published yet](#using-a-build-that-is-not-published-yet) build both tarballs. [`TESTING.md`](TESTING.md) lists every suite CI runs.

## One-time setup

The repository has to be `pubky/pubky-social-specs` before anything else, so rename it first if it still has the old name. Until then the npm publish fails, because npm requires `repository.url` in each `package.json` to match the repository the workflow runs in.

Then create an environment called `release` in the repository settings, and under Deployment branches and tags pick Selected with the tag rule `v*`. It has no required reviewers, so a `v*` tag publishes as soon as it is pushed. A repository ruleset limiting who can create `v*` tags belongs next to it. The registries accept any run of `release.yml` in the `release` environment whatever ref it started from, so these rules are what keep someone with write access from publishing a modified workflow off a branch.

A trusted publisher can only be added to a package that already exists, on both registries, so the very first version of each goes out by hand from a clean checkout:

```bash
cargo publish --locked
npm ci && (cd pkg && npm run build)
(cd pkg && npm publish --access public --tag next)
(cd migrator && npm publish --access public --tag next)
```

A `v` tag for that version publishes nothing, the workflow skips a version a registry already has and only opens the GitHub release. After the bootstrap, add the trusted publisher on each registry, and on npm to each of the two packages. On crates.io it lives under the crate's Settings, Trusted Publishing, GitHub. On npmjs.com it is the package's Settings page, Trusted Publisher, GitHub Actions. Both take the same values:

| Field | Value |
| --- | --- |
| Owner / organization | `pubky` |
| Repository | `pubky-social-specs` |
| Workflow filename | `release.yml` |
| Environment | `release` |

On npmjs.com the same form has Allowed actions. `npm stage publish` is always allowed, and a trusted publisher created after September 3, 2026 allows only that by default. Enable `npm publish` there too, because the workflow publishes directly. With the default left in place the npm job fails, possibly after the crate already went out to crates.io.

npm expires a trusted publisher that has not published anything within 48 hours of being created, and the job then fails with `ENEEDAUTH`. Add it right before the first tagged release; an expired one has to be deleted and created again.

The hand-published first version takes npm's `latest` whatever `--tag` says. After it, `latest` moves by hand with each prerelease until `v1.0.0`, as described above.

Both registries match on the repository name, and npm also checks it against `repository.url` in each `package.json`. Renaming the GitHub repository again later means updating both entries and that field.

## Using a build that is not published yet

A git dependency cannot give you the npm packages, because `dist/`, the compiled modules and the migrator's wasm, is build output and never committed. Build the tarballs instead:

```bash
npm ci && (cd pkg && npm run build && npm pack) && (cd migrator && npm pack)
```

and point the consuming project at them, for example `"pubky-social-specs": "file:../pubky-social-specs-1.2.3.tgz"`, and the same for `pubky-social-migrator` when it migrates. A dry run of the Release workflow uploads the same tarballs as an artifact, if you would rather not build them yourself. The crate has no such problem: a Cargo git dependency builds from source.
