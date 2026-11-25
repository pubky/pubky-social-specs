# Data model specification

> The Pubky social data model, **1.x**: the objects stored under `/pub/social/v1/` and
> `/priv/social/v1/`. The legacy 0.x layout under `/pub/pubky.app/` is described in
> [`docs/SPEC_V0.md`](docs/SPEC_V0.md).

## Table of Contents

- [Introduction](#introduction)
- [Concepts](#concepts)
- [Conventions](#conventions)
- [Data Models](#data-models)
  - [User](#user)
  - [Post](#post)
    - [Article content](#article-content)
    - [Collection content](#collection-content)
  - [File (media)](#file-media)
  - [Tag](#tag)
  - [Bookmark](#bookmark)
  - [Follow](#follow)
  - [Mute](#mute)
  - [Feed](#feed)
- [Identifiers](#identifiers)
- [References](#references)
- [URI Grammar](#uri-grammar)
- [Client Rules](#client-rules)
- [Relationship to 0.x](#relationship-to-0x)
- [License](#license)

---

## Introduction

This document specifies the objects Pubky social applications read and write on a homeserver:
where each one is stored, its fields, how its id is derived, and the rules a valid object obeys.
It is intended for developers building compatible clients, indexers and libraries.

The reference implementation is the [`pubky-social-specs`](https://crates.io/crates/pubky-social-specs)
Rust crate, with the npm package of the same name held equal to it. The committed conformance
vectors under [`vectors/`](vectors/) are its executable form. Where this document and the crate
disagree, the crate is right and this document has a bug.

**Stability.** Within 1.x the stored models only grow. A path under `social/v1/` keeps its shape:
it may gain optional members, and it never loses one, retypes one or changes what one means. Every
1.x release reads what any earlier 1.x release wrote and derives every id the same way. A change
that cannot be made that way (a re-pinned id function, a resource moving to another root, changed
content semantics, a break in the path grammar) goes to a new epoch, `social/v2`, which is a
separate subtree and never overwrites `social/v1`.

---

## Concepts

- **Owner**: every user is a public key, written as 52 characters of z-base32. The user's data is
  a tree of files on a homeserver that belongs to that key.
- **Root**: the first path segment. `pub` is readable by anyone; `priv` is readable and writable
  only by the owner and the apps the owner granted, and never appears in the homeserver's public
  event feed. Profiles, tags and follows are public; bookmarks and mutes are private; posts, media
  and feeds may live under either root.
- **Namespace and epoch**: `social/v1`. `social` is shared by every application, and `v1` is the
  data format version. Objects an application defines for itself live in its own namespace, never
  under `social`.
- **Timestamp ids** name posts and post versions; they encode the time they were minted.
- **Hash ids** name content-addressed objects (tags, media, feeds); they are the hash of the
  object's identity.
- **Versions**: a post is a directory of immutable version files. An edit writes a new version,
  and references to the post name the directory, so they survive every edit.
- **Forward compatibility**: a reader ignores members it does not know and writes them back
  untouched, so an older client never destroys a newer client's data.

A user's tree at a glance:

```text
pubky://<owner>/
├── pub/social/v1/
│   ├── profile.json
│   ├── posts/{postId}/{postId}.json            the first version
│   ├── posts/{postId}/{editId}.json            an edit; references still name posts/{postId}
│   ├── files/{hash}.jpg                        media, raw bytes
│   ├── tags/{tagId}.json
│   ├── follows/{followee}.json
│   └── feeds/{feedId}.json                     a published feed (copy of the private one)
└── priv/social/v1/
    ├── posts/{postId}/{postId}-my-draft.json   a draft, with a readable label
    ├── files/{hash}.png                        private media
    ├── bookmarks/{filename}.json
    ├── mutes/{mutee}.json
    └── feeds/{feedId}.json
```

---

## Conventions

These apply to every JSON object below.

- **Encoding.** Every object other than media is a UTF-8 JSON object stored with a `.json`
  extension.
- **Lengths** count Unicode code points, not bytes or UTF-16 units, unless a rule says bytes.
- **Whitespace** means the 25 code points of the frozen whitespace set: U+0009 to U+000D, U+0020,
  U+0085, U+00A0, U+1680, U+2000 to U+200A, U+2028, U+2029, U+202F, U+205F and U+3000. It is the
  Unicode 15.1 `White_Space` property and never follows a newer Unicode version. **Trim** removes
  these code points from both ends; nothing else. **Blank** means empty after a trim.
- **ASCII control** means U+0000 to U+001F and U+007F.
- **Writers canonicalize, readers never rewrite.** A writer trims display text and folds tags
  before it writes. A reader accepts the stored bytes as written or rejects the object; it never
  repairs a value, so the bytes on the homeserver and every id derived from them agree.
- **Optional members.** A reader treats an absent member and a `null` one alike. Each table below
  states how the reference writer spells "no value": as `null`, or by omitting the member. Two
  lists are the exception: a post's `attachments` and a collection's `items` read as `[]` when
  absent and are invalid as `null`.
- **Integers** must be within ±(2^53 − 1), the range every JSON engine reads exactly. This holds
  for declared members and for any integer inside an unknown member, at any depth.
- **`created_at`** is an integer number of microseconds since the Unix epoch.
- **Size caps.** A stored post is at most 524288 bytes (512 KiB) and every other JSON object at
  most 65536 bytes (64 KiB), measured on the stored bytes. A reader checks the cap before parsing.
- **Unknown members** are kept, not just tolerated. A reader ignores members it does not know and
  a client rewriting an object writes them back with their values (member order and escape
  spelling may change). An object that repeats a declared member is invalid.
  Deliberate extensions should nest under the reserved member `ext`, as
  `"ext": {"badge": {...}}`; everything under `ext` is third-party data this specification
  validates no further than the integer range and the size cap above, and readers treat it as
  untrusted input.
- **Unknown enum values.** Every enum is an open string. An unknown value in an object's primary
  enum (`post.kind`, `feed.reach`, `feed.layout`, `feed.sort`) makes the object invalid, and a
  reader skips it. An unknown value in a secondary enum (`feed.content`, `collection.layout`)
  means "no constraint". Parsing never fails on an unknown value; it is kept as written.

---

## Data Models

### User

**Description:** A user's profile. One per owner, public.

**URI:** `/pub/social/v1/profile.json`

| **Field** | **Type**       | **No value** | **Validation Rules**                                                              |
| --------- | -------------- | ------------ | --------------------------------------------------------------------------------- |
| `name`    | String         | (required)   | 3 to 50 code points, not blank.                                                   |
| `bio`     | String         | `null`       | At most 160 code points, not blank.                                               |
| `image`   | String         | `null`       | A pubky or web [reference](#references) of at most 300 code points, never private. |
| `links`   | Array of Link  | `null`       | At most 5 links.                                                                  |
| `status`  | String         | `null`       | At most 50 code points, not blank.                                                |

**Link**

| **Field** | **Type** | **Validation Rules**                                                 |
| --------- | -------- | -------------------------------------------------------------------- |
| `title`   | String   | 1 to 100 code points, not blank.                                     |
| `url`     | String   | A web (`http`, `https`) [reference](#references), at most 300 code points. |

**Validation Notes:**

- Writers trim `name`, `bio`, `status` and each link `title`, and write a blank `bio` or `status`
  as `null`. A stored value is counted as stored, padding included.
- `[DELETED]` is an ordinary name with no special meaning. How a deleted account is shown is up to
  the client.

**Example**

```json
{
  "name": "Alice",
  "bio": "Building on Pubky",
  "image": "pubky://8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto/pub/social/v1/files/YNYX9PB7DV1H21M7D63XQVCKN4.png",
  "links": [
    {
      "title": "Site",
      "url": "https://example.com"
    }
  ],
  "status": "Exploring"
}
```

---

### Post

**Description:** A note, an article, a collection or a media post. A post is a directory of
versions under either root: a public post, or a private draft or note.

**URI:** `/{pub|priv}/social/v1/posts/{postId}/{editId}.json`, or
`/{pub|priv}/social/v1/posts/{postId}/{editId}-{label}.json`

A reference to the post is versionless: `pubky://<owner>/{pub|priv}/social/v1/posts/{postId}`.

| **Field**     | **Type**            | **No value** | **Validation Rules**                                                                 |
| ------------- | ------------------- | ------------ | ------------------------------------------------------------------------------------ |
| `content`     | String              | (required)   | Depends on `kind`, see below.                                                        |
| `kind`        | String              | (required)   | One of `note`, `article`, `image`, `video`, `link`, `file`, `collection`.            |
| `parent`      | String              | `null`       | The thing this post replies to: any-scheme [reference](#references), at most 1024 code points. |
| `embed`       | String              | `null`       | The thing this post quotes: any-scheme reference, at most 1024 code points.          |
| `attachments` | Array of Attachment | `[]`         | At most 10.                                                                          |
| `lock`        | String              | omitted      | A pubky reference, at most 1024 code points, to what gates the post (a payment or a membership). Readers that do not honour it show the post as it is. |

**Attachment**

| **Field** | **Type** | **No value** | **Validation Rules**                                                       |
| --------- | -------- | ------------ | -------------------------------------------------------------------------- |
| `uri`     | String   | (required)   | The media: a pubky or web reference, at most 1024 code points.             |
| `alt`     | String   | omitted      | Text describing the media for a screen reader, at most 1000 code points.   |
| `name`    | String   | omitted      | The file name shown, 1 to 255 code points, not blank. Writers trim it.     |

**Content by kind:**

| **Kind**                                | **`content`**                                                                                                  |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `note`, `image`, `video`, `link`, `file` | Text, at most 2000 code points; writers trim it. The post must have non-blank `content`, an `embed`, or at least one attachment. |
| `article`                               | An [article envelope](#article-content), as a JSON string of at most 104000 code points.                       |
| `collection`                            | A [collection envelope](#collection-content), as a JSON string of at most 40000 code points. `parent` and `embed` must be `null` and `attachments` empty: the items are in the envelope. |

**Versions:**

- `{postId}` is a [timestamp id](#identifiers) minted when the post is created. The first version
  reuses it: `{editId}` equals `{postId}`.
- An edit writes a new version whose `{editId}` is a timestamp id strictly greater than the
  current newest one. An `{editId}` is never smaller than `{postId}`.
- The **head**, the post as it reads now, is the version with the greatest `{editId}`. Ids of one
  length in one alphabet sort chronologically as plain strings.
- A version file is written once and never changed.
- The optional `-{label}` is a readable decoration: 1 to 64 characters of `a-z`, `0-9` and `-`.
  The library's builders call it the `slug`. It carries no identity: `{editId}.json` and `{editId}-{label}.json` are the same version, so a
  writer creates only one of them. The leaf is split at its first `-`.
- When a post is read, its `{postId}` and `{editId}` must be on or after 2024-10-01T00:00:00Z and
  at most two hours ahead of the reader's clock.

**Validation Notes:**

- Every reference in a post, envelope covers and collection items included, obeys the
  [reference rules](#references).

**Example: a reply with an image**

`/pub/social/v1/posts/0034GTJ9NFM00/0034GTJ9NFM00.json`

```json
{
  "content": "Hello, Pubky!",
  "kind": "note",
  "parent": "pubky://pxnu33x7jtpx9ar1ytsi4yxbp6a5o36gwhffs8zoxmbuptici1jy/pub/social/v1/posts/0034GNHBTJ400",
  "embed": null,
  "attachments": [
    {
      "uri": "pubky://8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto/pub/social/v1/files/YNYX9PB7DV1H21M7D63XQVCKN4.png",
      "alt": "A cat",
      "name": "cat.png"
    }
  ]
}
```

Its edit, an hour later and with a label, is stored next to it at
`/pub/social/v1/posts/0034GTJ9NFM00/0034GTS07Y600-hello-pubky.json`.

**Example: a link post quoting a web page**

```json
{
  "content": "Worth a read",
  "kind": "link",
  "parent": null,
  "embed": "https://example.com/post",
  "attachments": []
}
```

#### Article content

The `content` of an `article` post is a JSON object, serialized as a string. An article may also
carry `parent`, `embed` and `attachments`.

| **Field**     | **Type** | **No value** | **Validation Rules**                                                                                 |
| ------------- | -------- | ------------ | ---------------------------------------------------------------------------------------------------- |
| `title`       | String   | (required)   | 1 to 100 code points, not blank. No ASCII control but tab, line feed and carriage return. Writers trim it. |
| `body`        | String   | (required)   | At most 50000 code points. The same control-character rule.                                          |
| `cover_image` | String   | omitted      | A pubky or web reference, at most 300 code points.                                                   |

`body` is CommonMark. Renderers may honour the GFM table, strikethrough, task list and autolink
extensions and render anything else as text. Renderers never execute raw HTML, and link only to
`http`, `https`, `pubky` and `mailto` destinations.

By convention, `![alt](attachment:{n})` in the `body` shows the post's `attachments[n]`, whatever
its media type. `n` counts from zero and is written in decimal digits, with no sign and no
leading zero. The cover is `cover_image`, not one of the `attachments`. The data model checks
none of this: what a reader shows for a slot that is not there is the app's to decide.

**Example**

`/pub/social/v1/posts/0034GZK7GD400/0034GZK7GD400-on-pubky.json`

```json
{
  "content": "{\"title\":\"On Pubky\",\"body\":\"# Hello\\n\\nMarkdown body.\",\"cover_image\":\"pubky://8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto/pub/social/v1/files/YNYX9PB7DV1H21M7D63XQVCKN4.png\"}",
  "kind": "article",
  "parent": null,
  "embed": null,
  "attachments": []
}
```

#### Collection content

The `content` of a `collection` post is a JSON object, serialized as a string: an ordered list
of anything, posts, web pages or other URIs, under a name.

| **Field**     | **Type**       | **No value** | **Validation Rules**                                                                   |
| ------------- | -------------- | ------------ | -------------------------------------------------------------------------------------- |
| `name`        | String         | (required)   | 1 to 100 code points, not blank. Writers trim it.                                      |
| `description` | String         | omitted      | At most 500 code points, not blank. Writers trim it.                                   |
| `items`       | Array of Item  | `[]`         | At most 100, in the curator's order.                                                   |
| `cover_image` | String         | omitted      | A pubky or web reference, at most 300 code points.                                     |
| `layout`      | String         | omitted      | How the creator would show it: `grid`, `list` or `visual`. Any other value means the reader's choice. |

**Item**

| **Field** | **Type** | **No value** | **Validation Rules**                                                |
| --------- | -------- | ------------ | ------------------------------------------------------------------- |
| `uri`     | String   | (required)   | Any-scheme reference, at most 1024 code points.                     |
| `note`    | String   | omitted      | The curator's note, 1 to 1000 code points, not blank. Writers trim it. |

**Example**

```json
{
  "content": "{\"name\":\"Reading list\",\"description\":\"Posts worth a second look\",\"items\":[{\"uri\":\"pubky://pxnu33x7jtpx9ar1ytsi4yxbp6a5o36gwhffs8zoxmbuptici1jy/pub/social/v1/posts/0034GNHBTJ400\",\"note\":\"start here\"},{\"uri\":\"https://example.com/essay\"}],\"layout\":\"list\"}",
  "kind": "collection",
  "parent": null,
  "embed": null,
  "attachments": []
}
```

---

### File (media)

**Description:** Uploaded media: the raw bytes, stored as they are and never wrapped in JSON. It
may live under either root. Posts, profiles and covers reference it.

**URI:** `/{pub|priv}/social/v1/files/{hash}.{ext}`

**Validation Notes:**

- The body is 1 byte to 104857600 bytes (100 MiB).
- `{hash}` is the [hash id](#identifiers) of the bytes. Identical bytes have one id, and
  different bytes are a different object at a different path, so media never changes under a
  reference: replacing an image means uploading the new one and editing what references it.
- `{ext}` comes from the type declared at upload and is never stored or hashed, so the same
  bytes declared under two types are one object at two paths. The type is matched on its
  essence, the text before any `;`, ASCII-lowercased; any type not below, an empty one
  included, gets `bin`.

  | **Type**                                   | **`ext`** |
  | ------------------------------------------ | --------- |
  | `image/jpeg`                               | `jpg`     |
  | `image/png`                                | `png`     |
  | `image/gif`                                | `gif`     |
  | `image/webp`                               | `webp`    |
  | `image/svg+xml`                            | `svg`     |
  | `video/mp4`                                | `mp4`     |
  | `video/mpeg`                               | `mpeg`    |
  | `audio/mpeg`                               | `mp3`     |
  | `audio/wav`                                | `wav`     |
  | `application/pdf`                          | `pdf`     |
  | `application/json`                         | `json`    |
  | `application/xml`, `text/xml`              | `xml`     |
  | `application/zip`                          | `zip`     |
  | `application/javascript`                   | `js`      |
  | `text/css`                                 | `css`     |
  | `text/csv`                                 | `csv`     |
  | `text/html`                                | `html`    |
  | `text/plain`                               | `txt`     |
  | anything else                              | `bin`     |

  The table only grows; a row is never changed or removed.
- A file name belongs to the reference, as an attachment's `name`, so the same bytes can be
  attached under different names.

---

### Tag

**Description:** A label one user puts on something: a post, a profile, another application's
object, or any URI.

**URI:** `/pub/social/v1/tags/{tagId}.json`

| **Field**    | **Type** | **Validation Rules**                                                                                |
| ------------ | -------- | --------------------------------------------------------------------------------------------------- |
| `uri`        | String   | What is tagged: any-scheme [reference](#references), at most 1024 code points, never private.       |
| `label`      | String   | 1 to 20 code points, stored folded (trimmed and ASCII-lowercased). No whitespace, `,` or `:`.       |
| `created_at` | Integer  | Microseconds since the Unix epoch.                                                                  |

**Validation Notes:**

- `{tagId}` is the [hash id](#identifiers) of `{uri}:{label}`, the stored values joined by a
  colon. A label can never contain `:`, which keeps that join unambiguous.
- Folding lowercases ASCII letters only: `Café` folds to `café`, and two spellings of one non-ASCII
  letter are two labels.
- One target and label have exactly one address, so tagging the same thing twice overwrites the
  same file, and every application tags under `pub/social/v1/tags/`.

**Example**

`/pub/social/v1/tags/0XRYYYD13BK70HPG08T1A9RM2W.json`, the hash id of
`pubky://pxnu33x7jtpx9ar1ytsi4yxbp6a5o36gwhffs8zoxmbuptici1jy/pub/social/v1/posts/0034GNHBTJ400:rust`

```json
{
  "uri": "pubky://pxnu33x7jtpx9ar1ytsi4yxbp6a5o36gwhffs8zoxmbuptici1jy/pub/social/v1/posts/0034GNHBTJ400",
  "label": "rust",
  "created_at": 1768471200000000
}
```

---

### Bookmark

**Description:** Something a user saved for later. Private.

**URI:** `/priv/social/v1/bookmarks/{filename}.json`

The target is spelled in the filename, so one LIST of the directory reads every bookmark.

- **Primary form**, for a target of at most 187 UTF-8 bytes: `{filename}` is the target in
  unpadded base64url (`A-Z`, `a-z`, `0-9`, `-`, `_`). The 187-byte bound keeps the leaf within
  the homeserver's 255-character segment limit.
- **Overflow form**, for a longer target: `{filename}` is `~` followed by the
  [hash id](#identifiers) of the target, and the target is stored in the object.

| **Field**    | **Type** | **No value** | **Validation Rules**                                                       |
| ------------ | -------- | ------------ | -------------------------------------------------------------------------- |
| `created_at` | Integer  | (required)   | Microseconds since the Unix epoch.                                         |
| `target`     | String   | omitted      | Present in the overflow form only, where it is required; absent in the primary form. |

**Validation Notes:**

- The target is any-scheme [reference](#references) of at most 1024 code points, never a `/priv/`
  object, since whoever opens the bookmark must be able to open the target.
- A reader checks the whole filename: the base64url decodes to valid UTF-8 and re-encodes to the
  same filename, the target it spells is canonical and at most 187 bytes, and an overflow hash
  matches the stored `target`, which is longer than 187 bytes.
- Bookmarking the same target twice overwrites the same file.

**Example: primary form**

`/priv/social/v1/bookmarks/cHVia3k6Ly9weG51MzN4N2p0cHg5YXIxeXRzaTR5eGJwNmE1bzM2Z3doZmZzOHpveG1idXB0aWNpMWp5L3B1Yi9zb2NpYWwvdjEvcG9zdHMvMDAzNEdOSEJUSjQwMA.json`

```json
{
  "created_at": 1768471200000000
}
```

---

### Follow

**Description:** One user following another. Public: the social graph.

**URI:** `/pub/social/v1/follows/{followee}.json`, where `{followee}` is the followed user's key.

| **Field**    | **Type** | **Validation Rules**               |
| ------------ | -------- | ---------------------------------- |
| `created_at` | Integer  | Microseconds since the Unix epoch. |

**Example:** `{"created_at": 1768471200000000}` at
`/pub/social/v1/follows/pxnu33x7jtpx9ar1ytsi4yxbp6a5o36gwhffs8zoxmbuptici1jy.json`

---

### Mute

**Description:** A user the owner muted. Private: only the owner's own client reads it.

**URI:** `/priv/social/v1/mutes/{mutee}.json`, where `{mutee}` is the muted user's key.

| **Field**    | **Type** | **Validation Rules**               |
| ------------ | -------- | ---------------------------------- |
| `created_at` | Integer  | Microseconds since the Unix epoch. |

---

### Feed

**Description:** A saved feed: a filter over posts, with a name and an icon. Private by default;
the owner publishes it by copying the same bytes under `/pub/`.

**URI:** `/priv/social/v1/feeds/{feedId}.json`, and `/pub/social/v1/feeds/{feedId}.json` when
published.

| **Field**    | **Type**    | **No value** | **Validation Rules**                                                                 |
| ------------ | ----------- | ------------ | ------------------------------------------------------------------------------------ |
| `feed`       | Feed config | (required)   | The filter, which is the whole identity of the feed. See below.                      |
| `name`       | String      | (required)   | 1 to 100 code points, not blank. Writers trim it.                                    |
| `icon`       | String      | omitted      | 1 to 50 characters of `a-z`, `0-9` and `-`: a name in the client's icon set. Writers always set it; feeds from before the field existed have none. |
| `created_at` | Integer     | (required)   | Microseconds since the Unix epoch.                                                   |

**Feed config**

| **Field**     | **Type**        | **No value** | **Validation Rules**                                                                    |
| ------------- | --------------- | ------------ | --------------------------------------------------------------------------------------- |
| `tags`        | Array of String | `null`       | The labels a post must carry: 1 to 5 [tag labels](#tag), folded, deduplicated and sorted by code point. `null` is no tag filter; an empty array is invalid. |
| `domain_tags` | Array of String | omitted      | The domain labels a post's links must carry, with the rules of `tags`.                 |
| `reach`       | String          | (required)   | `following`, `followers`, `friends`, `all`, `wot` or `me`.                              |
| `layout`      | String          | (required)   | `columns`, `wide`, `visual`, `list` or `cards`.                                         |
| `sort`        | String          | (required)   | `recent` or `popularity`.                                                               |
| `content`     | String          | `null`       | The one post kind shown. `null`, or a kind the reader does not know, shows every kind.  |

**Validation Notes:**

- `{feedId}` is the [hash id](#identifiers) of the config, written as six segments joined by `:`:
  `{reach}:{layout}:{sort}:{content}:{tags}:{domain_tags}`, where a list is its labels joined by
  `,` and an absent value is the empty string. `name`, `icon` and `created_at` are outside the
  id, so two feeds with one filter are one feed, and renaming a feed does not move it.
- A reader recomputes the id from the stored config, keeping the spelling of any value it does
  not know, and rejects a feed whose path does not match.

**Example**

`/priv/social/v1/feeds/CGQYMXV87HKPBXNR35T9DXSSNR.json`, the hash id of
`following:columns:recent:article:bitcoin,rust:`

```json
{
  "feed": {
    "tags": [
      "bitcoin",
      "rust"
    ],
    "reach": "following",
    "layout": "columns",
    "sort": "recent",
    "content": "article"
  },
  "name": "Rust and Bitcoin",
  "icon": "bitcoin",
  "created_at": 1768471200000000
}
```

---

## Identifiers

Every id is valid if and only if re-encoding its decoded bytes gives back the same string. There
are no alias spellings: lowercase letters, `O` for `0` and set padding bits are all invalid.

**Crockford base32** below is the alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, uppercase only,
bits taken most significant first, with zero padding bits at the end and no padding characters.

| **Id**           | **Encoding**                                                                                     | **Length** | **Final character**                    |
| ---------------- | ------------------------------------------------------------------------------------------------ | ---------- | -------------------------------------- |
| Timestamp id     | Microseconds since the Unix epoch, as a 64-bit big-endian integer, in Crockford base32            | 13         | one of `0 2 4 6 8 A C E G J M P R T W Y` |
| Hash id          | The first 16 bytes of the BLAKE3 hash of the input, in Crockford base32                           | 26         | one of `0 4 8 C G M R W`                 |
| Owner key        | The 32-byte public key in z-base32 (`ybndrfg8ejkmcpqxot1uwisza345h769`)                           | 52         | `y` or `o`                             |

**What each hash id hashes:**

| **Object** | **Input**                                                          |
| ---------- | ------------------------------------------------------------------ |
| Tag        | `{uri}:{label}`, the stored values, as UTF-8                       |
| Feed       | the six-segment config string, as UTF-8                            |
| Media      | the file's bytes                                                   |
| Bookmark (overflow form) | the target, as UTF-8                                  |

No id hashes serialized JSON, so member order and whitespace never change an id.

**Minting timestamp ids.** A writer mints a post id from its clock. Ids minted by one writer
strictly increase, even within one clock tick, so two posts never share a path. Copying,
publishing and migrating reuse an existing id and never mint one.

---

## References

A reference is a URI stored in a field: `parent`, `embed`, `lock`, an attachment, a cover, a
collection item, a tag or bookmark target, a profile image or link. Each field accepts a set of
schemes:

| **Field**                                                       | **Schemes**   | **Max code points** |
| --------------------------------------------------------------- | ------------- | ------------------- |
| `post.parent`, `post.embed`, collection `items[].uri`, tag `uri`, bookmark target | any           | 1024 |
| `post.lock`                                                     | pubky         | 1024                |
| `attachments[].uri`                                             | pubky, web    | 1024                |
| `user.image`, article and collection `cover_image`              | pubky, web    | 300                 |
| `user.links[].url`                                              | web           | 300                 |

A value is dispatched on its prefix: `pubky` to the pubky gate, `http://` or `https://` to the
web gate, anything else to the opaque gate.

- **Pubky gate.** A canonical pubky URI as defined in [URI Grammar](#uri-grammar), always the full
  `pubky://` form.
- **Web gate.** `http://` or `https://`, lowercase, followed by an authority whose host is not
  empty (the authority runs to the first `/`, `?` or `#`; the host follows any userinfo and
  precedes any port). No whitespace and no ASCII control anywhere. The rest is kept as written.
- **Opaque gate**, for every other scheme (`nostr:`, `geo:`, `ipfs:`, `did:`, ...): a scheme of
  an ASCII letter followed by ASCII letters, digits, `+`, `.` or `-`, in lowercase, then `:`, then
  at least one character. No whitespace and no ASCII control anywhere. The part after the colon is
  opaque and kept as written. `pubky`-prefixed schemes, `http` and `https` never pass this gate.

Then, for every reference:

1. **Stored canonical.** The stored value is exactly its canonical form. Nothing is trimmed,
   decoded or rewritten on read, so `http://x.com` and `http://x.com/` are two different targets.
   An uppercase scheme is invalid. Host case is not checked, so writers should lowercase the
   host.
2. **Root rule.** An object stored under `/pub/`, and every tag and bookmark target, never
   references a `/priv/` pubky URI.
3. **Ownership rule.** A `/priv/` pubky URI names only the author's own objects; one of another
   user is invalid in any object.
4. **Versionless posts.** A pubky reference to a post names `posts/{postId}`, never a version.

**Web targets.** A writer should fold a web tag or bookmark target before it stores it: the
scheme and the host to ASCII lowercase, a port of digits without leading zeros, no default port
(80 for `http`, 443 for `https`), no empty port, no userinfo, no fragment, and `/` for an empty
path. The path and the query stay as written. `fold_web_target` (`foldWebTarget` in the npm
package) is this fold, and [`vectors/web_target.json`](vectors/web_target.json) pins it. The
added `/` can take a target at the length cap one code point past it. It is a writer rule only:
validation does not require it, a reader never rewrites a stored target, and a target an earlier
writer stored unfolded stays valid and a different target, with its own id.

A user is referenced by the URL of their profile, `pubky://<owner>/pub/social/v1/profile.json`.
The bare `pubky://<owner>` is also valid but is a different target, so writers use the profile
URL.

---

## URI Grammar

This section governs paths: where objects live and how a pubky URI is classified. It is
engine-free: no URL library takes part, and the rules below are the whole of it.

**Forms.** `pubky://<owner>[/<path>]`, and the short form `pubky<owner>[/<path>]` that the SDK
prints. The scheme is case-sensitive. The canonical form is always `pubky://`.

**Canonicalization.** The host is a valid [owner key](#identifiers), with no `@` and no `:`. The
path, split on `/`, has no empty segment (so no trailing `/` and no `//`), no `.` or `..`
segment, and no segment containing `%`, `?`, `#`, an ASCII control or whitespace. There is no
percent-decoding, no case folding and no normalization. A bare `pubky://<owner>` is valid.

A path is `<root>/<namespace>/<rest>`. A URI that fails canonicalization, or whose root is
neither `pub` nor `priv`, is an **error**. Every other URI is classified, never rejected:

1. A bare owner is the **user**.
2. A namespace other than `social` is **foreign**: another application's data, valid and skipped
   by social readers. Its version, when the next segment looks like `v[0-9]+`, is surfaced.
3. `social` followed by an epoch other than `v1` is an **unsupported version**: a newer format,
   the reader's signal to upgrade.
4. A root alone, `social` alone, and `social` followed by anything that is not an epoch are
   **unknown**.
5. `social/v1` followed by one of the rows below is that **resource**. Anything else, including a
   valid resource under the wrong root, a non-canonical id, and a leaf starting with `_` (reserved
   for client-private files), is **unknown**.

| **Resource**       | **Path after `/{root}/social/v1/`**  | **Roots** | **Leaf rule**                                                                                  |
| ------------------ | ------------------------------------ | --------- | ---------------------------------------------------------------------------------------------- |
| User               | `profile.json`                       | pub       |                                                                                                |
| Post reference     | `posts/{postId}`                     | both      | `{postId}` is a timestamp id; no extension                                                     |
| Post version       | `posts/{postId}/{editId}[-{label}].json` | both  | strip `.json`, split at the first `-`; `{editId}` is a timestamp id, the label 1 to 64 of `a-z0-9-` |
| File               | `files/{hash}.{ext}`                 | both      | strip one extension, case-sensitively, only if it is in the media table; `{hash}` is a hash id |
| Tag                | `tags/{tagId}.json`                  | pub       | `{tagId}` is a hash id                                                                         |
| Follow             | `follows/{key}.json`                 | pub       | `{key}` is an owner key                                                                        |
| Mute               | `mutes/{key}.json`                   | priv      | `{key}` is an owner key                                                                        |
| Bookmark           | `bookmarks/{filename}.json`          | priv      | the form only: unpadded base64url of at most 250 characters, of a length base64 can produce (not 4n+1), not starting with `_`; or `~` and a hash id |
| Feed               | `feeds/{feedId}.json`                | both      | `{feedId}` is a hash id                                                                        |

`.json` is stripped exactly once: `follows/<key>.json.json` is unknown. Time bounds are never
checked while parsing, only canonical form; an object's own rules check them when it is read.

**Examples** (`<pk>` any owner key):

| **URI**                                                       | **Classification**                                 |
| ------------------------------------------------------------- | -------------------------------------------------- |
| `pubky://<pk>`                                                | User                                               |
| `pubky<pk>/pub/social/v1/posts/0034GTJ9NFM00`                 | Public post reference (short form accepted)        |
| `pubky://<pk>/priv/social/v1/posts/0034GTJ9NFM00/0034GTJ9NFM00.json` | Private post version                        |
| `pubky://<pk>/pub/social/v1/posts/0034GTJ9NFM00/0034GTS07Y600-a-b.json` | Post version `0034GTS07Y600`, label `a-b` |
| `pubky://<pk>/pub/social/v1/posts/0034GTJ9NFM00/0034GTS07Y600-Hello.json` | Unknown (labels are lowercase)          |
| `pubky://<pk>/pub/social/v1/files/YNYX9PB7DV1H21M7D63XQVCKN4.png` | Public file                                    |
| `pubky://<pk>/pub/social/v1/files/YNYX9PB7DV1H21M7D63XQVCKN4.PNG` | Unknown (extensions are case-sensitive)        |
| `pubky://<pk>/pub/social/v1/mutes/<pk>.json`                  | Unknown (mutes are private)                        |
| `pubky://<pk>/pub/social/v2/posts/0034GTJ9NFM00`              | Unsupported version                                |
| `pubky://<pk>/pub/pubky.app/posts/0034GTJ9NFM00`              | Foreign                                            |
| `Pubky://<pk>/pub/social/v1/profile.json`                     | Error (scheme case)                                |
| `pubky://user@<pk>/pub/social/v1/profile.json`                | Error (userinfo)                                   |
| `pubky://<pk>/pub/social/v1/posts/../profile.json`            | Error (`..`)                                       |
| `pubky://<pk>/dav/social/v1/profile.json`                     | Error (unknown root)                               |

---

## Client Rules

A library can check that an object is valid. These rules need I/O, ordering or state a library
never sees, so they bind clients directly.

**Reading**

1. Skip what you do not recognise: foreign, unknown and unsupported-version paths, and objects
   that fail validation, are skipped one by one, never failing a whole listing.
2. A user who has not migrated keeps their 0.x data: a client reads its own user's 0.x and 1.x
   trees together.

**Writing**

3. Write a version file once. An edit is a new `{editId}`, and a version gets one spelling,
   labelled or not.
4. Read an object from the homeserver before rewriting it, never from an indexer's view, which
   may be stale or partial, and write back the members you did not change, unknown ones included.
5. GET a tag's address before PUTting it. Another application may have enriched the same tag.
6. If a rewrite cannot fit the size cap while keeping unknown members, fail the write and say so.
   Never drop members silently; the user may choose to discard them.
7. Request the narrowest capability you use, such as `/pub/social/v1/tags/:rw` for an application
   that only tags, and build paths with the specification's builders rather than by hand.

**Publishing a post** copies it; the private original stays.

8. Copy the private media the version references in `attachments` and in its envelope's
   `cover_image` to the same path under `/pub/`, then PUT the version under `/pub/`, at the same
   leaf, label included, with those media references respelled from `/priv/` to `/pub/`.
   Nothing else is rewritten, and any other `/priv/` reference makes the publish fail: publish
   the referenced object first or remove the reference.
9. Unpublishing copies back to `/priv/` every public version newer than the private head (the
   newest public version, when there is no private copy), then deletes the post's 0.x copy and
   every public version. Public media stays.

**Publishing a feed** PUTs the private file's bytes at the public path; unpublishing deletes the
public copy.

**Deleting**

10. Delete only on the user's request.
11. Deleting a public object removes every copy, under both roots and in every epoch: a copy left
    in the 0.x tree would come back when an indexer rebuilds. A missing path is not an error.

    | **Object** | **Paths, in order**                                                                                     |
    | ---------- | ------------------------------------------------------------------------------------------------------- |
    | User       | `/pub/pubky.app/profile.json`, then `/pub/social/v1/profile.json`                                       |
    | Post       | `/pub/pubky.app/posts/{postId}`, then every version oldest first, the public copy before the private one |
    | File       | the 0.x File objects whose `src` is this hash, `/pub/pubky.app/blobs/{hash}`, then every 1.x copy        |
    | Tag        | the 0.x tags of the same target and label, then `/pub/social/v1/tags/{tagId}.json`                       |
    | Follow     | `/pub/pubky.app/follows/{key}`, then `/pub/social/v1/follows/{key}.json`                                |
    | Mute       | `/pub/pubky.app/mutes/{key}`, then `/priv/social/v1/mutes/{key}.json`                                   |
    | Bookmark   | `/priv/social/v1/bookmarks/{filename}.json`                                                             |
    | Feed       | `/pub/social/v1/feeds/{feedId}.json`, then `/priv/social/v1/feeds/{feedId}.json`                        |

12. Deleting a post never deletes its media: the same file may be referenced by other posts.
    Unreferenced media is reclaimed in a separate pass, with the user's confirmation.

**Indexers** deduplicate an object across epochs and roots by its owner, resource type and
stable id (below), rank posts by the time their id encodes, and treat an object as deleted only
when no public copy of it survives.

---

## Relationship to 0.x

0.x data lives under `/pub/pubky.app/`, described in [`docs/SPEC_V0.md`](docs/SPEC_V0.md). Under
1.x it is classified as foreign: a 1.x reader reads it through the frozen 0.x reader, and the
[`pubky-social-migrator`](https://www.npmjs.com/package/pubky-social-migrator) copies it into
`social/v1`. Migration copies and never deletes; removing the 0.x tree is a later step the user
confirms.

| **0.x**                                   | **1.x**                                                    |
| ----------------------------------------- | ---------------------------------------------------------- |
| `/pub/pubky.app/profile.json`             | `/pub/social/v1/profile.json`                              |
| `/pub/pubky.app/posts/{id}`, overwritten on edit | `/{pub\|priv}/social/v1/posts/{id}/{editId}.json`   |
| kinds `short`, `long`                     | `note`, `article`                                          |
| `embed: {kind, uri}`                      | `embed: "<uri>"`                                           |
| `attachments: ["<uri>"]`                  | `attachments: [{uri, alt?, name?}]`                        |
| `/pub/pubky.app/files/{id}` + `blobs/{hash}` | `/{pub\|priv}/social/v1/files/{hash}.{ext}`             |
| `/pub/pubky.app/tags/{id}`                | `/pub/social/v1/tags/{id}.json`, id from canonical inputs  |
| `/pub/pubky.app/bookmarks/{id}`, public   | `/priv/social/v1/bookmarks/{filename}.json`                |
| `/pub/pubky.app/follows/{key}`            | `/pub/social/v1/follows/{key}.json`                        |
| `/pub/pubky.app/mutes/{key}`, public      | `/priv/social/v1/mutes/{key}.json`                         |
| `/pub/pubky.app/feeds/{id}`, public       | `/priv/social/v1/feeds/{id}.json`, id from its config, published by copy |
| `last_read`, `settings.json`              | removed (application data)                                 |

**Stable id.** One object keeps one key across epochs and roots, so an indexer does not count a
migrated object twice. It is the resource and its id: `profile`, `posts/{postId}` (for every
version and both roots), `files/{hash}`, `follows/{key}`, `mutes/{key}`, `tags/{tagId}`,
`bookmarks/{filename}`, `feeds/{feedId}`. Posts, media, follows, mutes and the profile keep their
id across epochs; a 0.x File object keys through the blob its `src` names. Tags, bookmarks and
feeds do not, because their 0.x id hashed different input, so an indexer matches those by
target.

---

## License

This specification is released under the MIT License.
