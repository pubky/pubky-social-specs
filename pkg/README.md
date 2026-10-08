# pubky-social-specs

The Pubky social data model for JavaScript and TypeScript: profiles, posts, tags, bookmarks, follows, mutes, feeds and media, as plain synchronous functions. A builder gives you where an object goes and the exact bytes to PUT there, and a decoder checks what a GET returned.

```bash
npm install pubky-social-specs
```

## Concepts

Every Pubky user has an **owner** key: 52 characters of z-base32, such as `8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto`. Written with a scheme, `pubky://<owner>`, it names the user. The user's data lives on a **homeserver**, as files in a tree that belongs to that key.

The tree has two **roots**. Files under `/pub/` are world-readable. Files under `/priv/` are read and written only by the owner and by the apps the owner granted access, which is where drafts, bookmarks, mutes and feeds go.

A client talks to the homeserver with four requests: **PUT** a file at a path, **GET** it, **DELETE** it, and **LIST** the files under a directory. This package performs none of them. It builds the bytes, checks what comes back and computes the paths, so it runs anywhere JavaScript runs. The requests are made by the Pubky SDK, [`@synonymdev/pubky`](https://www.npmjs.com/package/@synonymdev/pubky), or by any HTTP client you bring.

A post is a directory of **versions**: each edit writes a new file, `posts/{id}/{editId}.json`, and the version with the highest `editId` is the **head**, the post as it reads now. A reference to a post names the directory, so it survives every edit.

This package writes the **1.x** layout, under `/{root}/social/v1/`. Data written by pubky-app before it, the **0.x** layout under `/pub/pubky.app/`, is read only by the migration in `pubky-social-specs/migration`, which copies it into 1.x.

The reference implementation is the Rust crate of the same name. This package is held to it on every operation: the same stored bytes, the same ids and paths, and the same message when an object is refused.

## Quick start

Every block in this README runs as pasted. Each takes a signed-in `session` from [`docs/prelude.js`](docs/prelude.js), an in-memory stand-in for the SDK's; in an app that line is your sign-in.

```js
import { buildPost, decodeObject } from "pubky-social-specs";
import { owner, session } from "./docs/prelude.js"; // your SDK session and session.info.publicKey.z32()

// Build: where the post goes and the bytes to send
const { url, path, body } = buildPost(owner, { content: "Hello" });
await session.storage.putBytes(path, body);

// Read: what a GET returned, checked by the rules of the kind the URL names
const post = decodeObject(url, await session.storage.getBytes(path), "post");
console.log(post.content); // Hello
```

`body` is a `Uint8Array` that `fetch`, `Blob` and the SDK take as it is; `new TextDecoder().decode(body)` shows the JSON. [`example.js`](example.js) walks through every builder, an edit, a publish and a delete; from a project that installed the package, run it with `node node_modules/pubky-social-specs/example.js`.

## Four ways to name a place

Most first errors are one of these passed where another goes. Each has a branded type, so TypeScript refuses one passed for another before the code runs. A plain string is taken too; to check and brand one where it enters, from a form or a LIST, call `parseOwner`, `parsePubkyUrl`, `parseOwnerPath` or `parsePostRef`, or test it with `isPubkyUrl`.

| name | looks like | comes from | goes to |
|---|---|---|---|
| owner (`Owner`) | `8kkp...otto` | `session.info.publicKey.z32()` | the first argument of a builder |
| URL (`PubkyUrl`) | `pubky://<owner>/pub/social/v1/posts/<id>/<editId>.json` | `url` of a builder result, an entry of a LIST | `decodeObject`, `encodeObject`, `editPost`, `parseUri`, `toPath` |
| path (`OwnerPath`) | `/pub/social/v1/posts/<id>/<editId>.json` | `path` of a builder result, `toPath(url)` | the SDK's storage calls, every plan, `deletionPaths` |
| reference (`PostRef`) | `pubky://<owner>/pub/social/v1/posts/<id>` | `buildUri(author, "post", id)` | `parent`, `embed`, a tag, a bookmark, a collection item |

A URL names one stored file. A reference names a thing: for a post it leaves out the version, and the bare `pubky://<owner>` is the user. A LIST prefix, `listPrefix(owner, "public")`, ends with `/` and names a directory, so it has a type of its own.

## Create

Every builder of a stored object takes the owner first and returns a `Built<T>`: `id` (what the path names), `path`, `url`, `object` (the stored object, every known member present) and `body` (the bytes to PUT).

```js
import { buildBookmark, buildFeed, buildFollow, buildMute, buildPost, buildTag, buildUri, buildUser } from "pubky-social-specs";
import { friend, owner, session } from "./docs/prelude.js";

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

A builder trims display text (a name, a title, a post's content, a label) and lowercases the ASCII letters of a tag label. A reference is stored as written, so it must be canonical already: a pubky reference comes from `buildUri`, and a web URL starts with lowercase `http://` or `https://` and holds no whitespace. Absent and `null` mean the same in an input.

`buildPost` takes a note, an article or a collection, told apart by `kind`, and TypeScript refuses a member of another kind (a `title` on a note, a `parent` on a collection). Besides `article` and `collection` the kinds are `note` (the default), `image`, `video`, `link` and `file`, which all take `content`. It returns a `BuiltPost`, which adds the `editId` of the version; for a new post it equals `id`.

A slug gives a version a readable leaf, `{editId}-{slug}.json`: 1 to 64 of a-z, 0-9 and `-`. It carries no identity, so a renamed slug is the next edit, and it is allowed under both roots.

A feed's id is its filter (reach, layout, sort, content, tags, domain tags), so two feeds with one filter are one feed whatever their names. A tag label is trimmed and ASCII-lowercased and nothing more: `café` in NFC and in NFD are two labels with two ids.

### Media

Media is content addressed: its id is the hash of its bytes, and the declared type picks only the extension. A type the package does not map, an empty one included, gets `.bin`; the table is in [`docs/reference.md`](docs/reference.md#media-types). `buildFile` returns `{ id, path, url }`, with no `body`, since the bytes are yours to PUT.

```js
import { buildFile, buildPost, hashMedia } from "pubky-social-specs";
import { owner, session } from "./docs/prelude.js";

const file = new File([new Uint8Array([137, 80, 78, 71])], "cat.png", { type: "image/png" });
const bytes = new Uint8Array(await file.arrayBuffer());
const media = buildFile(owner, { bytes, type: file.type });
await session.storage.putBytes(media.path, bytes);

const post = buildPost(owner, { content: "A photo", attachments: [{ uri: media.url, name: file.name, alt: "A cat" }] });
await session.storage.putBytes(post.path, post.body);

// A large file: hash it a chunk at a time, so the page keeps running, and pass the id
const id = await hashMedia(file);
console.log(buildFile(owner, { id, type: file.type }).url === media.url); // true
```

Hashing is plain JavaScript, far slower than a native hash, so give `hashMedia` anything over a few megabytes; `createMediaHasher()` is the same hash fed by hand, for a worker. With an `id` the package never sees the bytes, so check `file.size` against `limits.maxFileSizeBytes` yourself. A media id is 128 bits of BLAKE3, as in the crate.

### Validating a form

A builder throws at the first refusal. `validateUser`, `validatePost`, `validateFeed` and `validateTag` run the same rules, collect every issue, and mint nothing; `userSchema`, `postSchema`, `feedSchema` and `tagSchema` are the same validators as Standard Schema objects, for react-hook-form, TanStack Form, tRPC or Hono as they are.

```js
import { postSchema, validatePost } from "pubky-social-specs";
import { owner } from "./docs/prelude.js";

const result = validatePost({ kind: "article", title: " ", body: "...", slug: "Not A Slug" }, owner);
if (!result.success) for (const issue of result.issues) console.log(issue.path.join("."), issue.code, issue.message);
// title blank Article title must contain non-whitespace characters
// slug format slug must be 1 to 64 chars of a-z, 0-9 and -: Not A Slug

const checked = postSchema["~standard"].validate({ content: "fine" });
console.log(checked.issues === undefined ? checked.value : checked.issues);
```

Each issue has a `path` into the input, a `code` (`invalid_type` for a value of the wrong JavaScript shape, else the [error code](#errors) of the rule), the `message`, and a `limit` for a length or a count. `validatePost(input, owner)` also runs the rule that a private draft references only its owner's private objects.

## Read and edit

`decodeObject(url, bytes, kind)` returns the object, typed, and refuses a URL that names another kind before it reads the bytes. Without the kind it returns `{ kind, object }`, or `{ kind: "file", bytes }` for media. Bytes that are no valid object at that URL throw a `ValidationError`; other people's data can be anything, so `tryDecodeObject` returns the refusal instead of throwing it.

### Reading a timeline

```js
import { buildPost, buildUri, idMicros, microsToDate, parseUri, tryDecodeObject } from "pubky-social-specs";
import { friend, friendSession, publicStorage } from "./docs/prelude.js";

// Someone posted, and edited once
const first = buildPost(friend, { content: "Hello from the other side", embed: "javascript:alert(1)" });
await friendSession.storage.putBytes(first.path, first.body);

// LIST their public posts: one URL per version. A directory with nothing in it answers 404
const listed = await publicStorage.list(`pubky://${friend}/pub/social/v1/posts/`).catch((e) => (e.data?.statusCode === 404 ? [] : Promise.reject(e)));

// The head of each post is its version with the highest editId
const heads = new Map();
for (const url of listed) {
  const at = parseUri(url);
  if (at.kind === "post" && at.editId !== undefined && !(heads.get(at.id)?.editId > at.editId)) heads.set(at.id, { url, editId: at.editId });
}

// Render only the schemes you link to; anything else is text
const linkable = (uri) => /^(pubky|https?):/.test(uri);
for (const [id, { url }] of heads) {
  const read = tryDecodeObject(url, await publicStorage.getBytes(url), "post");
  if (!read.ok) continue; // a bad object of someone else's is skipped, read.error says why
  const when = microsToDate(idMicros(id)).toISOString();
  console.log(when, read.value.content, read.value.embed && (linkable(read.value.embed) ? read.value.embed : "(not a link)"));
  console.log("reply to it with parent:", buildUri(friend, "post", id));
}
```

The data model takes any scheme in an `embed`, a `parent`, a tag, a bookmark or a collection item, `javascript:` and `data:` included; which ones become a link is the renderer's call. `idMicros(id)` gives the time a post id or an edit id was minted, in microseconds, the unit of every stored timestamp; `microsToDate` and `dateToMicros` convert.

### Editing an object

To change a stored object, decode it, change it, and encode it. Members a newer client added, which this version does not know, travel in `$unknown` and are written back.

```js
import { buildUser, decodeObject, encodeObject, toPath } from "pubky-social-specs";
import { owner, session } from "./docs/prelude.js";

const { url, path, body } = buildUser(owner, { name: "Alice" });
await session.storage.putBytes(path, body);

const profile = decodeObject(url, await session.storage.getBytes(toPath(url)), "user");
await session.storage.putBytes(toPath(url), encodeObject(url, { ...profile, status: "On holiday" }));
```

Pass `encodeObject` the `.object` with your changes, spread so `$unknown` stays on it. It also takes `{ kind, root? }` in place of a URL, for bytes that go somewhere the data model does not name. An edited feed filter moves the feed, since its id is the filter: write it at `buildUri(owner, "feed", feedId(feed))` and delete the old path.

### Articles and collections

The `content` of an article or a collection is itself JSON. Read and write it through the package, which spells it as the crate does.

```js
import { buildPost, decodeContent, editPost, encodeContent } from "pubky-social-specs";
import { owner } from "./docs/prelude.js";

const article = buildPost(owner, { kind: "article", title: "Title", body: "Body" });
const envelope = decodeContent(article.object); // { kind: "article", content: { title, body, cover_image } }, or null for a note
if (envelope?.kind !== "article") throw new Error("not an article");
const content = encodeContent({ ...envelope.content, title: "A better title" });
const edited = editPost(owner, article.url, { ...article.object, content });
console.log(edited.editId > article.editId); // true
```

`encodeContent` only spells the envelope; its rules run when the post reaches `editPost` or `encodeObject`.

## Delete

`deletionPaths({ kind, id, listings? })` gives the paths to DELETE for one object, in order, its 0.x copy first:

| kind | `id` | paths, in order | `listings` |
|---|---|---|---|
| `user` | `""` | `/pub/pubky.app/profile.json`, `/pub/social/v1/profile.json` | none |
| `follow` | the followee's key | `/pub/pubky.app/follows/<key>`, `/pub/social/v1/follows/<key>.json` | none |
| `mute` | the muted key | `/pub/pubky.app/mutes/<key>`, `/priv/social/v1/mutes/<key>.json` | none |
| `bookmark` | the filename | `/priv/social/v1/bookmarks/<id>.json` | none |
| `feed` | the hash id | `/pub/social/v1/feeds/<id>.json`, `/priv/social/v1/feeds/<id>.json` | none |
| `post` | the post id | the 0.x copy, then every listed version oldest first, public before private | every version path a LIST found |
| `file` | the hash | each 0.x File object, the 0.x blob, then each listed copy, public before private | the 1.x copies, and each 0.x File object with its `src` |
| `tag` | the hash id | each listed 0.x tag, then `/pub/social/v1/tags/<id>.json` | each 0.x tag with its `uri` and `label` |

A bookmark and a feed delete their 1.x copies only: their 0.x id hashes a target that the migration respells, so their own id cannot name the 0.x path. That copy stays readable under `/pub/pubky.app/`, and a later migration run does not copy it back (see [`MIGRATION.md`](MIGRATION.md)). Every listing is checked, and one that is not a copy of the object is refused with a `ValidationError` naming it.

```js
import { buildFollow, deletionPaths } from "pubky-social-specs";
import { friend, owner, session } from "./docs/prelude.js";

const follow = buildFollow(owner, friend);
await session.storage.putBytes(follow.path, follow.body);
// A path with nothing stored there deletes as a no-op
for (const path of deletionPaths({ kind: "follow", id: friend })) await session.storage.delete(path);
console.log(await session.storage.exists(follow.path)); // false
```

## Posts and the lifecycle

A post's versions sit under the public root or the private one. `editPost(owner, headUrl, post)` writes the next version above the head, in the owner's own tree, under the head's root unless you pass `{ root }`; an edit of another user's head is refused. A plan computes what to copy and delete and performs no I/O; every path it takes or returns is owner-relative.

```js
import { buildFile, buildPost, editPost, parseUri, planDelete, planPublish, planUnpublish } from "pubky-social-specs";
import { owner, session } from "./docs/prelude.js";

const copy = async ({ from, to }) => session.storage.putBytes(to, await session.storage.getBytes(from));

// A private draft with private media, and an edit of it
const picture = new Uint8Array([1, 2, 3]);
const media = buildFile(owner, { bytes: picture, type: "image/png", root: "private" });
await session.storage.putBytes(media.path, picture);
const draft = buildPost(owner, { content: "Draft", attachments: [{ uri: media.url }], root: "private", slug: "my-post" });
await session.storage.putBytes(draft.path, draft.body);
const edited = editPost(owner, draft.url, { ...draft.object, content: "Better draft" });
await session.storage.putBytes(edited.path, edited.body);

// Publish the head: its private media first, then the post, under the same leaf
const at = parseUri(edited.url);
const publish = planPublish(owner, { id: edited.id, editId: edited.editId, post: edited.object, slug: at.kind === "post" ? at.slug : null });
for (const step of publish.copies) await copy(step);
await session.storage.putBytes(publish.put.path, publish.put.body);

// Unpublish: copy back what the private tree lacks, then delete the public versions
const unpublish = planUnpublish({ id: edited.id, publicPaths: [publish.put.path], privateHead: edited.path });
for (const step of unpublish.copies) await copy(step);
for (const path of unpublish.deletes) await session.storage.delete(path);

// Delete everywhere, in an order that never leaves a reader a dangling post
const removal = planDelete(owner, {
  id: edited.id,
  copies: [draft, edited].map((v) => ({ root: "private", path: v.path })),
  versions: [draft.object, edited.object],
});
for (const path of removal.deletes) await session.storage.delete(path);
console.log(removal.mediaGcCandidates); // media the post referenced: delete it if nothing else does
```

`planPublish` keeps the slug the private version had, the `slug` of `parseUri(url)`, and respells private media references to public ones in the reference positions only. `planUnpublish` takes the paths of the public versions and of the newest private one, from a LIST. `planDelete` takes every stored version as `{ root, path }` and the versions it could read, whose media it returns as candidates to collect.

## Rules

1. **The package writes the bytes.** Never `JSON.stringify` an object yourself: unknown members have an order and numbers a spelling that only the package reproduces. Every builder returns `body`, and `encodeObject` gives the bytes of an object you edited.
2. **Unknown members are carried along.** A newer client may store members this version does not know. They come back in `$unknown`, as text; leave it on the object and it is written back untouched. A spread, `structuredClone` and a JSON round trip keep it, and copying an object field by field drops it, with the other client's data. A name this version does not know in a feed's `content` or a collection's `layout` is kept as written too.
3. **Every argument is read once.** The package copies what you pass, own members only, before it reads it. A member that is neither known nor inside `$unknown` is an error, so a typo is never stored or ignored, and whatever `Object.prototype` holds never becomes a member.
4. **Stored objects are spelled as stored.** `created_at`, `cover_image`, `domain_tags`: the same names in an input, in a decoded object and on the wire. Every known member is present in an object, `null` when it has no value. Integers are numbers, and `created_at` is microseconds since the epoch.

## Common mistakes

- An owner written as `pubky://<key>` is refused: `owner must be the bare public key`. `parseOwner` reads the key out of such a URL.
- A path passed where a URL goes is refused with `code: "path"`, and the message says it is a path.
- The `url` a builder returned names one version of a post. As a reference it is refused (`must be versionless`): use `buildUri(author, "post", id)`.
- The bare `pubky://<owner>` is the user, not the profile file. `decodeObject` refuses it; the profile is at `buildUri(owner, "user")`.
- `created_at` set from `Date.now()` is milliseconds. Outside a production build `encodeObject` warns; `dateToMicros(Date.now())` gives microseconds.
- An object copied field by field loses `$unknown`. Outside a production build `encodeObject` and `editPost` warn when an object read with unknown members is written without them.

## Errors

A value the data model refuses throws a `ValidationError`. A value of the wrong JavaScript type, or a member the input does not have, throws an `ArgumentError`, a `TypeError` naming the argument: a bug in the calling code, which TypeScript catches first. A string of the right type that the model refuses, such as an unknown kind or a path where a URL goes, is a `ValidationError`.

```js
import { ArgumentError, buildPost, buildUser, ValidationError } from "pubky-social-specs";
import { owner } from "./docs/prelude.js";

try {
  buildUser(owner, { name: "Al" });
} catch (e) {
  if (e instanceof ValidationError) console.log(e.code, e.field, e.limit); // length name 3
}
try {
  // @ts-expect-error a number is the wrong type for content
  buildPost(owner, { content: 42 });
} catch (e) {
  if (e instanceof ArgumentError) console.log(e.field); // input.content
}
```

A `ValidationError` has `message`, the reference text starting with `Validation Error: `; `reason`, the same text without the prefix; `code`, one of the set below, stable across releases where the text is not; `field`, the member or argument refused, absent when the whole object is; and `limit`, the bound a `size`, `length` or `count` refusal broke. `instanceof` holds across two installed copies of the package.

| `code` | the rule | `limit` |
|---|---|---|
| `json` | the bytes, or an envelope inside them, are not JSON of the stored shape | |
| `size` | an object or a file over its byte cap | bytes |
| `length` | text outside its bounds | code points |
| `count` | a list longer than its cap | items |
| `blank` | text, a list or a file that is empty or whitespace only | |
| `format` | text not spelled the one way the model accepts: a key, an id, a tag, a slug | |
| `id` | an id that does not match its object, or whose time is out of bounds | |
| `reference` | a URI in a reference position the model refuses | |
| `unknown_name` | a kind, reach, layout, sort or root this version does not know | |
| `unsafe_integer` | an integer a JavaScript number cannot hold exactly | |
| `path` | a URL or path that names no object of the kind asked for | |
| `conflict` | members or arguments that cannot go together | |
| `migration` | refused by the migrator; see the message | |

## Testing your code

The package is pure and synchronous, so tests call it for real. `setClock`, from `pubky-social-specs/testing`, fixes the clock in milliseconds, which fixes every id and `created_at`. With `node:test`, and the same with vitest or jest:

```js
import assert from "node:assert";
import { test } from "node:test";
import { buildFollow, decodeObject } from "pubky-social-specs";
import { fakeOwner, setClock } from "pubky-social-specs/testing";

test("a follow reads back", () => {
  setClock(() => 1_790_000_000_000);
  try {
    const { url, body } = buildFollow(fakeOwner(1), fakeOwner(2));
    assert.deepStrictEqual(decodeObject(url, body, "follow"), { created_at: 1_790_000_000_000_000 });
  } finally {
    setClock();
  }
});
```

`fakeOwner(n)` gives a well-formed key, the same for the same `n`, and `samplePost`, `sampleUser` and `sampleFeed` build a fixture from a partial input. Ids go up within one process, so two posts built in the same instant get different ids; `setClock` starts that guard over. Two copies of the package minting in the same millisecond rarely meet, and when they do the post ids are equal, so before PUTting a new post check that neither root holds a version of its id (the client does).

## The client

`pubky-social-specs/client` is the glue every app writes over a signed-in SDK session: it builds, PUTs the exact bytes, LISTs, picks the newest version and decodes. A stored object that does not decode comes back as a value with its error. The core stays free of I/O, and an app with its own transport ignores this entry.

```js
import { createSocialClient } from "pubky-social-specs/client";
import { friend, publicStorage, session } from "./docs/prelude.js";

const social = createSocialClient(session, { publicStorage });
const post = await social.posts.create({ content: "Hello" });
const head = await social.posts.head(social.owner, post.id);
if (head?.ok) await social.posts.edit(head, { ...head.object, content: "Hello, edited" });
for await (const read of social.posts.list(friend)) if (read.ok) console.log(read.object.content);
```

It covers `posts` (`create`, `head`, `edit`, `list`, `delete`), `profile` (`get`, `set`, `update`), `follows`, `mutes`, `tags`, `bookmarks` and `feeds` (`add`, `remove`, `list`), and `files` (`upload`, `get`). Reading another user's tree needs `publicStorage`, the SDK's `pubky.publicStorage`.

## Runtimes and tooling

- ESM only, with types. Node `^20.19.0 || >=22.12.0`, where `require()` of an ES module works too; Deno 2; Bun 1; browsers with ES2022. One dependency, [`@noble/hashes`](https://www.npmjs.com/package/@noble/hashes).
- TypeScript 5.7 or later. An older compiler fails on the import with `has no exported member`, where it would otherwise read every byte type as `any`. A CommonJS file compiled with TypeScript `module: node16` cannot import an ES module; 5.8 or later with `nodenext` can.
- jest runs it in ESM mode (`NODE_OPTIONS=--experimental-vm-modules` and `transform: {}`) or on Node 24.9 or later; vitest needs nothing.
- The main entry uses no host-specific global, so it runs in a worker, in Cloudflare Workers and during server rendering. The migration subpath picks a build of its wasm per runtime: inlined by default, read from its file under Node, and compiled at deploy time under the `workerd` condition Wrangler sets. Vercel Edge is untested for the migration.
- `decodeObject` pulls in every model, about 20 kB gzipped; `buildUri` alone is about 3 kB and the whole entry about 28 kB (`npm run size`: esbuild, minified, gzipped).
- The id guard and the clock belong to one copy of the package. A library that wraps this one should declare it a peer dependency, so a page holds one copy.

## Reference

- Hover any export in an editor: every one carries its doc and an example, which `npm run examples` compiles and runs.
- [`docs/reference.md`](docs/reference.md): the limits, the media types, every stored object member by member, and the error codes, generated from the package.
- [`MIGRATION.md`](MIGRATION.md): the 0.x to 1.x migration, its port contract, report and CLI.
- [`SECURITY.md`](SECURITY.md): what is attacker-controlled and what the package guarantees about it.
- [`CHANGELOG.md`](CHANGELOG.md): what a version promises about the API and about the stored bytes, separately.

The legacy 0.x layout is described in [`docs/SPEC_V0.md`](https://github.com/pubky/pubky-social-specs/blob/main/docs/SPEC_V0.md) of the repository; a JS consumer that has to read un-migrated data as such goes through a Rust service, since the frozen 0.x reader is Rust only.

## Migration

`pubky-social-specs/migration` migrates an owner's 0.x tree to 1.x, `pubky-social-specs/migration/pubky-sdk` is its port over an SDK session, and `pubky-social-migrate` runs it from a terminal. It is the only part of the package that loads a wasm. See [`MIGRATION.md`](MIGRATION.md).

## License

MIT
