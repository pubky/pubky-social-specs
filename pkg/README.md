# pubky-social-specs

[![npm version](https://img.shields.io/npm/v/pubky-social-specs)](https://www.npmjs.com/package/pubky-social-specs)
[![crates.io](https://img.shields.io/crates/v/pubky-social-specs)](https://crates.io/crates/pubky-social-specs)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

The Pubky social data model for JavaScript and TypeScript: profiles, posts, tags, bookmarks, follows, mutes, feeds and media, as plain synchronous functions. A builder gives you where an object goes and the exact bytes to PUT there, and a decoder checks what a GET returned.

It is a native TypeScript implementation of the Rust crate [`pubky-social-specs`](https://crates.io/crates/pubky-social-specs), with the same bytes, ids, paths and error messages. It loads no wasm and needs no `init()`. It replaces [`pubky-app-specs`](https://www.npmjs.com/package/pubky-app-specs): the guide maps [every old call to its new one](docs/guide.md#coming-from-pubky-app-specs).

## Why use this package instead of hand-written JSON?

- **Validation consistency:** the same rules as [Pubky indexers](https://github.com/pubky/pubky-nexus), so what you write is what they accept.
- **Ids and paths:** post ids, content-addressed media, tag and feed ids, and every path and URL, computed the one way the data model allows.
- **Forward compatible:** members a newer client added are carried along and written back untouched.
- **Typed:** keys, URLs, paths and references each have their own type, so TypeScript refuses one passed for another.

## Installation

```bash
npm install pubky-social-specs
```

## Concepts

- Every user is an **owner** key, and their data is a tree of files on a **homeserver**. Files under `/pub/` are world-readable; files under `/priv/` are only for the owner and the apps they granted, which is where drafts, bookmarks, mutes and feeds go. This package writes under `social/v1/` in both.
- This package makes no requests. It builds the bytes, checks what comes back and computes the paths; the Pubky SDK, [`@synonymdev/pubky`](https://www.npmjs.com/package/@synonymdev/pubky), or any HTTP client does the PUT, GET, DELETE and LIST.
- A post is a directory of **versions**, `posts/{postId}/{editId}.json`. Each edit writes a new one, the highest `editId` is the post as it reads now, and a reference to the post names the directory, so it survives every edit.

## Quick start

Every block in this README runs as pasted: `memoryHomeserver()` stands in for a signed-in SDK session, and in an app `owner` is `session.info.publicKey.z32()`.

```js
import { buildPost, decodeObject } from "pubky-social-specs";
import { memoryHomeserver } from "pubky-social-specs/testing";
const { owner, session } = memoryHomeserver(); // your SDK session and session.info.publicKey.z32()

// Build: where the post goes and the bytes to send
const { url, path, body } = buildPost(owner, { content: "Hello" });
await session.storage.putBytes(path, body);

// Read: what a GET returned, checked by the rules of the kind the URL names
const post = decodeObject(url, await session.storage.getBytes(path), "post");
console.log(post.content); // Hello
```

## Building objects

Every builder takes the owner first and returns `id`, `path` and `url`; all but `buildFile` also return `object` (the stored object) and `body` (the bytes to PUT).

```js
import { buildBookmark, buildFeed, buildFollow, buildMute, buildPost, buildTag, buildUri, buildUser } from "pubky-social-specs";
import { memoryHomeserver } from "pubky-social-specs/testing";
const { friend, owner, session } = memoryHomeserver();

const theirPost = buildUri(friend, "post", "0035QZPT4QG00"); // a reference: the post, not one version

const writes = [
  buildUser(owner, { name: "Alice", bio: "Hi", links: [{ title: "Site", url: "https://example.com" }] }),
  buildPost(owner, { content: "A reply", parent: theirPost }),
  buildPost(owner, { kind: "article", title: "On Pubky", body: "Markdown body", slug: "on-pubky" }),
  buildPost(owner, { kind: "collection", name: "Reading list", items: [{ uri: theirPost, note: "start here" }], layout: "grid" }),
  buildPost(owner, { content: "A draft", root: "private" }),
  buildTag(owner, theirPost, "rust"),
  buildBookmark(owner, theirPost),
  buildFollow(owner, friend),
  buildMute(owner, friend),
  buildFeed(owner, { name: "Rust", icon: "crab", reach: "all", layout: "columns", sort: "recent", tags: ["rust"] }),
];
for (const { path, body } of writes) await session.storage.putBytes(path, body);
console.log(writes.map((w) => w.path));
```

`buildPost` takes a `kind`: `note` (the default), `image`, `video`, `link` and `file` take `content`, an `article` takes `title` and `body`, and a `collection` takes `name` and `items`. `buildFile` gives the path for media.

## Reading and writing back

- `decodeObject(url, bytes, kind)` returns the object, typed, or throws a `ValidationError`. Other people's data can be anything, so `tryDecodeObject` returns the error instead of throwing it.
- To change an object, decode it, change it, and write `encodeObject(url, object)`. Never `JSON.stringify` it yourself: members a newer client added travel in `$unknown`, and only the package writes them back as they were.
- A post is the exception. A version file is written once and never changed, so an edit goes through `editPost`, which writes a new version at a new path. The guide covers both under [Editing an object](docs/guide.md#editing-an-object).
- `validatePost`, `validateUser`, `validateFeed` and `validateTag` check a form and return every issue; `postSchema` and the other `*Schema` exports are the same checks as [Standard Schema](https://standardschema.dev) objects.

## The client

`pubky-social-specs/client` does the requests too, over a signed-in SDK session: it builds, PUTs, LISTs, picks the newest version and decodes.

```js
import { createSocialClient } from "pubky-social-specs/client";
import { memoryHomeserver } from "pubky-social-specs/testing";
const { publicStorage, session } = memoryHomeserver();

const social = createSocialClient(session, { publicStorage });
const post = await social.posts.create({ content: "Hello" });
// The newest version, read and decoded, or null; `ok` is false when it does not decode
const newest = await social.posts.head(social.owner, post.id);
if (newest?.ok) await social.posts.edit(newest, { ...newest.object, content: "Hello, edited" });
for await (const read of social.posts.list(social.owner)) if (read.ok) console.log(read.object.content); // Hello, edited
```

It covers posts, the profile, follows, mutes, tags, bookmarks, feeds and files. Reading another user's tree needs `publicStorage`, the SDK's `pubky.publicStorage`.

## Runtimes

ESM only, with types. Node `^20.19.0 || >=22.12.0`, Deno 2, Bun 1 and browsers with ES2022; TypeScript 5.7 or later. One dependency, [`@noble/hashes`](https://www.npmjs.com/package/@noble/hashes), and no wasm, so it runs in workers, Cloudflare Workers and server rendering too.

## Documentation

- [`docs/guide.md`](docs/guide.md): coming from `pubky-app-specs`, keys, URLs, paths and references, form validation, media, timelines, editing, deleting, publishing, the client, errors, testing and tooling.
- [`docs/reference.md`](docs/reference.md): the limits, the media types and every stored object, field by field.
- [`SPEC.md`](https://github.com/pubky/pubky-social-specs/blob/v1/SPEC.md): the data model specification.
- [`example.js`](example.js): every builder, an edit, a publish and a delete, runnable with `node node_modules/pubky-social-specs/example.js`.
- Every export carries its doc and an example, shown when you hover it in an editor.
- [`CHANGELOG.md`](CHANGELOG.md) and [`SECURITY.md`](SECURITY.md).

## Migrating from 0.x

Data written by `pubky-app-specs`, under `/pub/pubky.app/`, is moved to 1.x by [`pubky-social-migrator`](https://www.npmjs.com/package/pubky-social-migrator), a separate package released with this one at the same version.

## License

MIT
