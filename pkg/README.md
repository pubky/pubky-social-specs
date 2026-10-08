# pubky-social-specs

The Pubky social data model for JavaScript and TypeScript: profiles, posts, tags, bookmarks, follows, mutes, feeds and media, as plain synchronous functions.

A builder gives you where an object goes and the exact bytes to PUT there. A decoder reads what a GET returns. Nothing is loaded first and nothing performs I/O, so the same calls work in a browser, in Node, in a worker and during server rendering.

The reference implementation is the Rust crate of the same name. This package is a native TypeScript implementation of it, checked against the crate on every operation: the same stored bytes, the same ids and paths, and the same message when an object is refused.

## Installation

```bash
npm install pubky-social-specs
```

ESM only, with types (TypeScript 5.7 or later). Node 20.19 or later, Deno 2, Bun 1, and browsers from 2022 on (Safari 15.4). One dependency, [`@noble/hashes`](https://www.npmjs.com/package/@noble/hashes).

## Quick start

```js
import { buildPost, decodeObject } from "pubky-social-specs";

const owner = session.info.publicKey.z32(); // the bare key: 52 characters, no "pubky://"

// Build: where the post goes and the bytes to send
const { url, path, body } = buildPost(owner, { content: "Hello" });
await session.storage.putBytes(path, body);

// Read: what a GET returned, checked by the rules of the kind the URL names
const post = decodeObject(url, await session.storage.getBytes(path), "post");
console.log(post.content);
```

`body` is a `Uint8Array` that `fetch`, `Blob` and the Pubky SDK take as it is; `new TextDecoder().decode(body)` shows it.

### Common mistakes

Four spellings of a place run through the whole surface, and most first errors are one passed where another goes. Each has a branded type (`Owner`, `PubkyUrl`, `OwnerPath`, `PostRef`, and the ids `PostId`, `EditId`, `MediaId`), so TypeScript refuses one passed for another before it runs: the `url` of a post version as a `parent`, an `editId` as a post id. A plain string is still taken anywhere; to brand one where it enters, from a form or a LIST, call `parseOwner`, `parsePostId`, `parseEditId`, `parseMediaId`, `parsePubkyUrl`, `parseOwnerPath` or `parsePostRef`, each of which throws a `ValidationError` for a string that is not one.

| | looks like | comes from | goes to |
|---|---|---|---|
| owner | `8kkp...otto` | the session | the first argument of a builder |
| URL | `pubky://<owner>/pub/social/v1/posts/<id>/<editId>.json` | `url` of a builder result | `decodeObject`, `encodeObject`, `editPost`, `parseUri`, `toPath` |
| path | `/pub/social/v1/posts/<id>/<editId>.json` | `path` of a builder result, `toPath(url)` of a LIST entry | the SDK's storage calls, every plan, `deletionPaths` |
| reference | `pubky://<owner>/pub/social/v1/posts/<id>` | `buildUri(owner, "post", id)` | `parent`, `embed`, a tag, a bookmark, a collection item |

- An owner with `pubky://` in front is refused as `the string is not 52 ASCII characters`, with `field: "owner"`.
- A path passed where a URL goes is a `TypeError` that says so.
- The `url` a builder returned names one version of a post. As a reference it is refused (`must be versionless`): use `buildUri(author, "post", id)`.

## The rules of the surface

1. **The package writes the bytes.** Never `JSON.stringify` an object yourself: unknown members have an order and numbers a spelling that only the package reproduces. Every builder returns `body`, and `encodeObject` gives the bytes of an object you edited.
2. **Unknown members are carried, not read.** A newer client may store members this version does not know. They come back in `$unknown`, as text; leave it on the object and it is written back untouched. It is an ordinary string member, so a spread, `structuredClone` and a JSON round trip keep it; copying an object field by field drops it, and with it the other client's data. A member that is neither known nor inside `$unknown` is an error, in an input, an object and an options bag alike, so a typo is never stored or ignored. Every argument is copied once on entry, own members only, and only the copy is read: whatever `Object.prototype` holds never becomes a member, and a getter or a Proxy is asked once.
3. **Two kinds of error.** A value the data model refuses throws a `ValidationError`. Its `message` is the reference text and starts with `Validation Error: `; `reason` is that text without the prefix, and `field` names the member or argument refused (`content`, `attachments[0].uri`, `owner`) when the refusal is about one. Recognise it with `instanceof ValidationError`, which holds across two installed copies of the package. A value of the wrong JavaScript shape (a number where a string goes, a missing or misspelled member) throws a `TypeError` naming the argument: that is a bug in the calling code, and TypeScript catches most of them first.
4. **Stored objects are spelled as stored.** `created_at`, `cover_image`, `domain_tags`: the same names in an input, in a decoded object and on the wire. In an object every known member is present, `null` when it has no value (the bytes leave some of those out). Integers are numbers, and `created_at` is microseconds since the epoch.

## Builders

Every builder of a stored object takes the owner first and returns a `Built<T>`:

```ts
interface Built<T> {
  id: string;       // what the path names: "" for the profile, the followee for a follow
  path: OwnerPath;  // owner-relative, as the SDK's storage calls take it
  url: PubkyUrl;    // the full pubky:// URL
  object: T;        // the stored object, for your local state
  body: Uint8Array; // the bytes to PUT
}
```

```js
import { buildUser, buildPost, buildTag, buildBookmark, buildFollow, buildMute, buildFeed, buildUri } from "pubky-social-specs";

const postUrl = buildUri(other, "post", postId); // a reference: the post, not one version

buildUser(owner, { name: "Alice", bio: "Hi", links: [{ title: "Site", url: "https://example.com" }] });

buildPost(owner, { content: "A note", parent: postUrl });
buildPost(owner, { kind: "article", title: "Title", body: "Markdown body", cover_image: imageUrl, slug: "title" });
buildPost(owner, { kind: "collection", name: "Reading list", items: [{ uri: postUrl, note: "start here" }], layout: "grid" });
buildPost(owner, { content: "A draft", root: "private" });

buildTag(owner, postUrl, "rust");
buildBookmark(owner, postUrl);
buildFollow(owner, other);
buildMute(owner, other);
buildFeed(owner, { name: "Rust", icon: "star", reach: "all", layout: "columns", sort: "recent", tags: ["rust"] });
```

A builder trims display text (a name, a title, a post's content, a label) and lowercases the ASCII letters of a tag label. A reference is stored as written, so it must be canonical already and you trim it yourself: a pubky reference comes from `buildUri`, and a web URL starts with lowercase `http://` or `https://` and holds no whitespace. Absent and `null` mean the same in an input.

`buildPost` returns a `BuiltPost`, a `Built<Post>` with the `editId` of the version; for a new post it equals `id`. The input is told apart by `kind`, so a collection with a `parent` does not compile. Besides `article` and `collection` the kinds are `note` (the default), `image`, `video`, `link` and `file`, which all take `content`.

A feed's id is its filter (reach, layout, sort, content, tags): two feeds with one filter are one feed whatever their names. `icon` is a name from the client's icon set, 1 to 50 of a-z, 0-9 and `-`.

A tag label is trimmed and ASCII-lowercased and nothing more, as in the crate: `café` in NFC and in NFD are two labels with two ids.

### Media

Media is content addressed: its id is the hash of its bytes, and the declared type only picks the extension of the path. A type the package does not map, an empty one included, gets `.bin`. `buildFile` returns a `BuiltFile`, `{ id, path, url }`. The bytes are yours to PUT, so there is no `body`.

```js
const bytes = new Uint8Array(await file.arrayBuffer());
const { url, path } = buildFile(owner, { bytes, type: file.type });
await session.storage.putBytes(path, bytes);
buildPost(owner, { content: "A photo", attachments: [{ uri: url, name: file.name, alt: "A cat" }] });
```

Hashing is plain JavaScript, on the order of 10 to 20 MB a second. For a large file, `hashMedia` reads a `Blob` or a stream a chunk at a time, so the page keeps running between chunks; hand its id to `buildFile`:

```js
const id = await hashMedia(file);
const { url, path } = buildFile(owner, { id, type: file.type });
```

`createMediaHasher()` is the same hash fed by hand, for a worker. `limits.maxFileSizeBytes` is the cap; with an `id` the package never sees the bytes, so check `file.size` yourself. `validMimeTypes` lists the types the model knows by name, and `MimeType` is their union. A media id is 128 bits of BLAKE3, as in the crate: 64 bits of collision resistance, plenty to deduplicate one owner's media and no proof that two parties hold the same file.

## Validating a form

A builder throws at the first refusal. To show a user everything wrong with an input at once,
validate it first: `validateUser`, `validatePost`, `validateFeed` and `validateTag` run the
builder's own rules, collect every issue, and mint nothing.

```ts
import { validatePost, postSchema } from "pubky-social-specs";

const result = validatePost({ kind: "article", title: "", body: "..." }, owner);
if (!result.success) for (const issue of result.issues) console.log(issue.path.join("."), issue.code, issue.message);
// title invalid Article title must contain non-whitespace characters

// Standard Schema, for react-hook-form, TanStack Form, tRPC or Hono as they are
const checked = postSchema["~standard"].validate(formValues);
```

Each issue has a `path` into the input (`["attachments", 0, "uri"]`), a `code` (`invalid_type` for a
value of the wrong JavaScript shape, `invalid` for a rule of the data model) and the `message`,
the reference text for a rule. On success `value` is the input as checked, plain data, ready for
the builder. A member of the wrong shape is reported once and the rules about it are skipped; the
rules on the other members still run. `validatePost(input, owner)` also runs the rule that a
private draft references only its owner's private objects. `userSchema`, `postSchema`,
`feedSchema` and `tagSchema` are the same validators as Standard Schema objects.

## Reading and editing

`decodeObject(url, bytes)` returns `{ kind, object }`, or `{ kind: "file", bytes }` for media. Given the kind you expect, `decodeObject(url, bytes, "post")` returns the object itself, typed, and refuses a URL that names another kind before it reads the bytes. It throws a `ValidationError` for bytes that are not a valid object at that URL, with the reason. Other people's data can be anything, so decode it inside a `try`. That includes a post of a kind this version does not know, and a feed whose reach, layout or sort it does not know: those carry rules it cannot check, so it refuses them. Only a feed's `content` filter and a collection's `layout` read as `"unknown"`, and the types say so: `Post.kind` is a `KnownPostKind`, `FeedConfig.content` a `PostKind`.

To change a stored object, decode it, change it, and encode it. Whatever this version does not know stays in `$unknown` and is written back:

```js
const profile = decodeObject(profileUrl, bytes, "user");
profile.status = "On holiday";
await session.storage.putBytes(toPath(profileUrl), encodeObject(profileUrl, profile));
```

Pass `encodeObject` the `.object`, not the result that holds it and not an object you parsed from the bytes yourself. It also takes `{ kind, root? }` in place of a URL, for bytes that go somewhere the data model does not name; the object is then checked by every rule that needs no path.

An edited filter moves a feed, since its id is the filter: write it at `buildUri(owner, "feed", feedId(feed))` and delete the old path.

### Articles and collections

The `content` of an article or a collection is itself JSON. Read and write it through the package, for the same reason as rule 1:

```js
const post = decodeObject(headUrl, bytes, "post");
const envelope = decodeContent(post); // { kind: "article", content: { title, body, cover_image } }, or null for a note
if (envelope?.kind !== "article") throw new Error("not an article");
post.content = encodeContent({ ...envelope.content, title: "A better title" });
const edited = editPost(headUrl, post);
```

`encodeContent` only spells the envelope; its rules run when the post reaches `editPost` or `encodeObject`.

### Rendering references

The data model takes any scheme in an `embed`, a `parent`, a tag, a bookmark or a collection item, `javascript:` and `data:` included. It stores references, and which schemes become a link is the renderer's call. Before you turn one into an `href` or an `src`, allow the schemes you render (`pubky`, `https`, `http`) and show anything else as text.

## Posts: versions, drafts and the lifecycle

A post is a directory of versions, `posts/{id}/{editId}[-slug].json`, under the public root or the private one. The newest `editId` is the post as it reads now.

```js
// Edit: a new version above the head, under the head's root unless you say otherwise.
// `post` is the decoded object with its changes; `headUrl` the URL of the newest version.
const edited = editPost(headUrl, { ...post, content: "Fixed a typo" });

// Publish a private version: copy its private media first, then PUT the post
const publish = planPublish(owner, { id: edited.id, editId: edited.editId, post: edited.object });
for (const { from, to } of publish.copies) await copy(from, to);
await session.storage.putBytes(publish.put.path, publish.put.body);

// Unpublish: copy back what the private tree lacks, then delete the public versions
const unpublish = planUnpublish({ id, publicPaths, privateHead });

// Delete everywhere, in the order that never leaves a reader a dangling post
const removal = planDelete(owner, { id, legacyPaths, copies: stored, versions });
for (const path of removal.deletes) await session.storage.delete(path);
```

Every path a plan takes or returns is owner-relative (`/pub/...`), never a `pubky://` URL; `toPath` turns a URL a LIST gave into one. `publicPaths` are the public versions of the post and `privateHead` its newest private version. `stored` is every version found, as `{ root, path }`; that is not the `{ from, to }` list another plan returns. `removal.mediaGcCandidates` is media the deleted versions referenced, to delete only if nothing else of yours references it. A published version carries no slug, as the crate defines: the slug decorates a draft, and the public leaf is `{editId}.json`.

A plan performs no I/O. A reference to a post is versionless (`buildUri(author, "post", id)`), so it survives every edit.

## URIs

```js
buildUri(owner, "user");                 // pubky://<owner>/pub/social/v1/profile.json
buildUri(owner, "post", postId);         // the versionless reference
buildUri(owner, "file", `${hash}.png`);  // a file takes its full name
listPrefix(owner, "public");             // pubky://<owner>/pub/social/v1/ , for a LIST
listPrefix(owner, "legacy");             // the 0.x tree, pubky://<owner>/pub/pubky.app/
toPath(url);                             // /pub/social/v1/... , the path of a URL

const parsed = parseUri(uri);
// { owner, root, path, kind: "user" }
// { owner, root, path, kind: "post", id, editId?, slug? }
// { owner, root, path, kind: "bookmark", id, target? }       target when the id carries it
// { owner, root, path, kind: "file", id, filename }          id is the hash, filename what buildUri takes
// { owner, root, path, kind: "follow" | "mute" | "tag" | "feed", id }
// { ..., kind: "foreign", namespace, version?, rest }          another app's path, the 0.x tree included
// { ..., kind: "unsupportedVersion", version } and { ..., kind: "unknown" }
```

`parseUri` throws only for a string that is not a pubky URI with a clean path under `pub` or `priv`; what it cannot name is a kind, not an error. It never reads the clock, so what a path names does not change with time. `buildUri` checks the owner and the id. An id its kind cannot have (`../x`, a slash, a file's hash without its extension) is a `ValidationError` with `field: "id"`, so the only URIs that come out are ones `parseUri` reads back as that object.

## Deleting

`deletionPaths({ kind, id, listings? })` gives the paths to DELETE for one object, legacy first:

```js
deletionPaths({ kind: "follow", id: followee });
deletionPaths({ kind: "file", id: hash, listings: [...v1Paths, { path: v0FilePath, src }] });
```

What the id alone gives is derived: the profile and a follow in both epochs, and the 1.x path of a mute, a bookmark and a feed. A mute, a bookmark or a feed leaves its 0.x copy in place, as the crate defines, and a later migration walk does not copy it back (see [`MIGRATION.md`](MIGRATION.md)). For a post, a file and a tag the other copies come only from `listings`: the owner-relative paths you found by LIST, and for a 0.x File object or tag, what proves it belongs to this object. Each is checked, and one that does not belong is an error naming it. A post with no listings gives an empty list.

## Limits and names

```js
import { limits, postKinds, feedReaches, feedLayouts, feedSorts, collectionLayouts } from "pubky-social-specs";

limits.postNoteContentMaxLength; // 2000
z.enum(feedReaches);             // with zod: the name tuples work as a schema's enum
```

Lengths are in Unicode code points unless the name says bytes. The tables are frozen. Each tuple has two types: `KnownPostKind` is what a builder takes, and `PostKind` adds `"unknown"`, which a read gives where the stored name is newer than this version and the object is still usable (a feed's `content`, a collection's `layout`).

## Testing your code

The package is pure and synchronous, so tests can call it for real. `setClock`, from `pubky-social-specs/testing`, fixes the clock, which fixes every id and `created_at`. With vitest or jest:

```js
import { buildFollow, decodeObject } from "pubky-social-specs";
import { setClock } from "pubky-social-specs/testing";

beforeEach(() => setClock(() => 1_790_000_000_000)); // milliseconds, as Date.now()
afterAll(() => setClock());

const { url, body } = buildFollow(me, them);
expect(decodeObject(url, body, "follow")).toEqual({ created_at: 1_790_000_000_000_000 });
```

Ids go up within one process, so two posts built in the same instant get different ids; `setClock` starts that guard over. The clock reads microseconds, so two copies of the package minting in the same millisecond rarely meet. A clock corrected backwards by more than a second is followed, as the crate's mint is, and ids continue from it: one minted after such a correction can repeat one minted before it in the same process.

## What to know

- `decodeObject` pulls in every model, about 20 kB gzipped. `buildUri` alone is under 3 kB, `parseUri` about 16 kB (it reads a bookmark's target), and the whole entry about 27 kB.
- The id guard and the clock are per copy of the package. Two copies in one page mint independently, so a library that wraps this one should declare it a peer dependency.
- An edit through `$unknown` writes the bytes a Rust client writes for the same edit. A name this version reads as `"unknown"` is written back as `"unknown"`, in this package and in the crate alike: the newer name is lost on an edit by an older client.
- `editPost` reads the owner from the head URL. Pass a URL in the caller's own storage.

## Exports

From `pubky-social-specs`:

| name | what it is |
|---|---|
| `buildUser`, `buildPost`, `buildTag`, `buildBookmark`, `buildFollow`, `buildMute`, `buildFeed` | a new object: where it goes and its bytes |
| `buildFile`, `hashMedia`, `createMediaHasher` | where media goes, and its id from bytes, a Blob or chunks |
| `editPost`, `planPublish`, `planUnpublish`, `planDelete` | the post lifecycle |
| `decodeObject`, `encodeObject`, `decodeContent`, `encodeContent` | reading and writing stored objects and envelopes |
| `feedId` | the id an edited feed moves to |
| `buildUri`, `parseUri`, `listPrefix`, `toPath`, `deletionPaths` | places: references, LIST prefixes, paths |
| `parseOwner`, `parsePostId`, `parseEditId`, `parseMediaId`, `parsePubkyUrl`, `parseOwnerPath`, `parsePostRef` | a string checked once and branded |
| `validateUser`, `validatePost`, `validateFeed`, `validateTag`, and `userSchema`, `postSchema`, `feedSchema`, `tagSchema` | every issue of an input, plain and as Standard Schema; types `Issue`, `Validation`, `StandardSchemaV1` |
| `limits`, `validMimeTypes`, `postKinds`, `feedReaches`, `feedLayouts`, `feedSorts`, `collectionLayouts` | the data model's constants |
| `ValidationError` | a refusal of the data model |
| `User`, `Post`, `Tag`, `Bookmark`, `Follow`, `Mute`, `Feed`, `FeedConfig`, `UserLink`, `Attachment`, `ArticleContent`, `CollectionContent`, `CollectionItem`, `Stored` | the stored objects |
| `Built`, `BuiltPost`, `BuiltFile`, `Decoded`, `ParsedUri`, `Copy`, `StoredCopy`, `Listing` | results and plan entries |
| `NewUser`, `NewPost`, `NewNote`, `NewArticle`, `NewCollection`, `NewAttachment`, `NewFeed`, `NewFile`, `MediaSource`, `BlobLike`, `ByteStream`, `CheckedPost` | builder inputs |
| `Owner`, `PostId`, `EditId`, `MediaId`, `PubkyUrl`, `OwnerPath`, `PostRef`, `Reference`, `Brand`, `Given`, `UrlArg`, `PathArg` | the branded places and ids, and the argument types that take them or a plain string |
| `Bytes`, `Root`, `ObjectKind`, `MimeType`, `PostKind`, `KnownPostKind` and the other name unions | the vocabulary |

From `pubky-social-specs/testing`: `setClock`. From `pubky-social-specs/migration` and `pubky-social-specs/migration/pubky-sdk`: the migration, in [`MIGRATION.md`](MIGRATION.md).

## Migration

The package carries the whole 0.x to 1.x migration as `pubky-social-specs/migration`: the transforms, which are the reference crate compiled to wasm, and the engine that walks a tree with them. It is the only part of the package that loads a wasm, on the first `runMigration`.

```js
import { runMigration } from "pubky-social-specs/migration";

const report = await runMigration({ owner, port, caps: session.capabilities, onProgress, signal });
```

`pubky-social-specs/migration/pubky-sdk` is the port over a pubky SDK session, and the `pubky-social-migrate` CLI runs the whole migration from a terminal. What a run does, the port contract, the report and the CLI are in [`MIGRATION.md`](MIGRATION.md).

## Reading 0.x data

The frozen 0.x reader is Rust only. This package exposes the 1.x surface and the migration; a JS consumer that has to read un-migrated data as such goes through a Rust service.

## Specification

The 1.x design is in [`docs/rfc-v1-social-specs.md`](https://github.com/pubky/pubky-social-specs/blob/main/docs/rfc-v1-social-specs.md). The legacy 0.x layout is in [`docs/SPEC_V0.md`](https://github.com/pubky/pubky-social-specs/blob/main/docs/SPEC_V0.md), for reading un-migrated data.

## Building from source

The package builds from `pkg/src` with `tsc`. The wasm of the migrator also needs Rust, the `wasm32-unknown-unknown` target and [`wasm-pack`](https://rustwasm.github.io/wasm-pack/).

```bash
cd pkg
npm ci
npm run build      # tsc, then the migrator's wasm, into dist/
npm test           # tsc, the tests, the recorded vectors and the generated tables
npm run types      # the declarations, compiled as a consumer compiles them
npm run api        # every entry's declarations against the committed ones in api/
npm run size       # bundle size, tree-shaking and cold start
```

`npm test` checks `src/data.ts` against the crate through the surface oracle, built with `cargo build --release --features surface --bin surface_oracle` at the repository root. How the package is checked against the crate is in [`TESTING.md`](https://github.com/pubky/pubky-social-specs/blob/main/TESTING.md). Releases are cut from a git tag, and a build that is not on npm yet can be installed from an `npm pack` tarball; both are described in [Releasing](https://github.com/pubky/pubky-social-specs#releasing).

## License

MIT
