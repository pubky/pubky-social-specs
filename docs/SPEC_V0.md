# Data model specification

> Legacy 0.x layout: the `pub/pubky.app` tree written by pubky-app-specs 0.x, up to 0.8.0 (commit
> `3eebe18`). Kept for reading un-migrated data. The 1.x design is in `docs/rfc-v1-social-specs.md`.

## Table of Contents

- [Data model specification](#data-model-specification)
  - [Table of Contents](#table-of-contents)
  - [Introduction](#introduction)
  - [Quick Start](#quick-start)
    - [Concepts:](#concepts)
  - [Data Models](#data-models)
    - [PubkyAppUser](#pubkyappuser)
    - [PubkyAppFile](#pubkyappfile)
    - [PubkyAppPost](#pubkyapppost)
    - [PubkyAppTag](#pubkyapptag)
    - [PubkyAppBookmark](#pubkyappbookmark)
    - [PubkyAppFollow](#pubkyappfollow)
    - [PubkyAppMute](#pubkyappmute)
    - [PubkyAppBlob](#pubkyappblob)
    - [PubkyAppLastRead](#pubkyapplastread)
    - [PubkyAppFeed](#pubkyappfeed)
      - [`feed` object (`PubkyAppFeedConfig`)](#feed-object-pubkyappfeedconfig)
  - [Validation Rules](#validation-rules)
    - [Common Rules](#common-rules)
  - [License](#license)

---

## Introduction

This document specifies the data models and validation rules for the **Pubky.app** clients interactions. It defines the structure of data entities, their properties, and the validation rules to ensure data integrity and consistency. This is intended for developers building compatible libraries or clients.

This document is a faithful representation of the [Rust models at 0.8.0](https://github.com/pubky/pubky-social-specs/tree/3eebe18/src).

---

## Quick Start

Pubky.app models are designed for decentralized content sharing. The system uses a combination of timestamp-based IDs and Blake3-hashed IDs encoded in Crockford Base32 to ensure unique identifiers for each entity.

### Concepts:

- **Timestamp IDs** for sequential objects like posts and files.
- **Hash IDs** for content-based uniqueness (e.g., tags and bookmarks).
- **Validation Rules** ensure consistent and interoperable data formats.

---

## Data Models

### PubkyAppUser

**Description:** Represents a user's profile information.

**URI:** `/pub/pubky.app/profile.json`

| **Field** | **Type** | **Description**                         | **Validation Rules**                                                                         |
| --------- | -------- | --------------------------------------- | -------------------------------------------------------------------------------------------- |
| `name`    | String   | User's name.                            | Required. Length: 3–50 characters. Cannot be `"[DELETED]"`.                                  |
| `bio`     | String   | Short biography.                        | Optional. Maximum length: 160 characters.                                                    |
| `image`   | String   | URL to the user's profile image.        | Optional. Valid URL. Maximum length: 300 characters.                                         |
| `links`   | Array    | List of associated links (title + URL). | Optional. Maximum of 5 links, each with title (100 chars max) and valid URL (300 chars max). |
| `status`  | String   | User's current status.                  | Optional. Maximum length: 50 characters.                                                     |

**Validation Notes:**

- Reserved keyword `[DELETED]` cannot be used for `name`.
- Each `UserLink` in `links` must have a valid title and URL.

**Example: Valid User**

```json
{
  "name": "Alice",
  "bio": "Toxic maximalist.",
  "image": "pubky://user_id/pub/pubky.app/files/0000000000000",
  "links": [
    {
      "title": "GitHub",
      "url": "https://github.com/alice"
    }
  ],
  "status": "Exploring decentralized tech."
}
```

---

### PubkyAppFile

**Description:** Represents a file uploaded by the user, containing its metadata, including a reference to the actual blob of the file in `src` property.

**URI:** `/pub/pubky.app/files/:file_id`

| **Field**      | **Type** | **Description**             | **Validation Rules**                           |
| -------------- | -------- | --------------------------- | ---------------------------------------------- |
| `name`         | String   | Name of the file.           | Required. Must be 1-255 characters             |
| `created_at`   | Integer  | Unix timestamp of creation. | Required.                                      |
| `src`          | String   | File blob URL               | Required. must be a valid URL. Max length 1024 |
| `content_type` | String   | MIME type of the file.      | Required. Valid IANA mime types                |
| `size`         | Integer  | Size of the file in bytes.  | Required. Positive integer. Max size is 10Mb   |

**Validation Notes:**

- The `file_id` in the URI must be a valid **Timestamp ID**.

---

### PubkyAppPost

**Description:** Represents a user's post.

**URI:** `/pub/pubky.app/posts/:post_id`

| **Field**     | **Type** | **Description**                      | **Validation Rules**                                                       |
| ------------- | -------- | ------------------------------------ | -------------------------------------------------------------------------- |
| `content`     | String   | Content of the post.                 | Required. Max length: 2000 (short), 50000 (long). Cannot be `"[DELETED]"`. |
| `kind`        | String   | Type of post.                        | Required. Must be a valid `PubkyAppPostKind` value.                        |
| `parent`      | String   | URI of the parent post (if a reply). | Optional. Must be a valid URI if present.                                  |
| `embed`       | Object   | Reposted content (type + URI).       | Optional. URI must be valid if present.                                    |
| `attachments` | Array    | List of attachment URIs.             | Optional. Each must be a valid URI.                                        |
| `lock`        | String   | Lock server URL for protected posts. | Optional. If present, must be a valid `pubky://` URL with a host, up to 200 characters. Missing or `null` means unlocked. |

**Post Kinds:**

- `short`
- `long`
- `image`
- `video`
- `link`
- `file`
- `collection`

**Example: Valid Post**

```json
{
  "content": "Hello world! This is my first post.",
  "kind": "short",
  "parent": null,
  "embed": {
    "kind": "short",
    "uri": "pubky://user_id/pub/pubky.app/posts/0000000000000"
  },
  "attachments": ["pubky://user_id/pub/pubky.app/files/0000000000000"],
  "lock": "pubky://lock_server_id/pub/locks/0000000000000"
}
```

**Locking:**

Posts are unlocked by default. A post may include `lock` to advertise that the full post is protected behind a lock server. When present, `lock` must be a valid `pubky://` URL with a host, up to 200 characters. Consumers that receive JSON without `lock`, or JSON with `"lock": null`, must treat the post as a regular unlocked post.

**Note on `kind = collection`:**

Collection posts use a typed JSON envelope as their `content`. The envelope shape is:

```json
{
  "name": "AI papers",
  "description": "Best stuff",
  "cover_image": "pubky://userA/pub/pubky.app/files/0034A0X7NJ52C",
  "layout": "visual",
  "items": [
    "pubky://userA/pub/pubky.app/posts/0034A0X7NJ52A",
    "pubky://userB/pub/pubky.app/posts/0034A0X7NJ52B"
  ]
}
```

- `name`: required, 1 to 100 unicode scalars, non-whitespace-only.
- `description`: optional, max 500 scalars.
- `cover_image`: optional hero/cover image URL (max 200 chars). Validated as a general attachment URL — protocol must be `pubky`, `http`, or `https`.
- `layout`: optional, one of `grid`, `list`, `visual`; the creator's default layout for experiencing the collection. Absent = `grid`. Consumers must treat unrecognized values as `grid`.
- `items`: ordered list of pubky.app post URIs (max 100). Each URI must be in exact canonical form `pubky://<pubky-id>/pub/pubky.app/posts/<post-id>` (94 chars); any deviation (extra path segments, query, fragment, userinfo, etc.) is rejected.

For `kind = collection`, `parent`, `embed`, and `post.attachments` must be unset. The `content` field is bounded by 40000 scalars instead of the regular short/long caps.

---

### PubkyAppTag

**Description:** Represents a tag applied to a URI.

**URI:** `/pub/pubky.app/tags/:tag_id`

| **Field**    | **Type** | **Description**             | **Validation Rules**                                     |
| ------------ | -------- | --------------------------- | -------------------------------------------------------- |
| `uri`        | String   | URI of the tagged object.   | Required. Must be a valid URI.                           |
| `label`      | String   | Label for the tag.          | Required. Trimmed, lowercase. Max length: 20 characters. |
| `created_at` | Integer  | Unix timestamp of creation. | Required.                                                |

**Validation Notes:**

- The `tag_id` is a **Hash ID** derived from the `uri` and `label`.

---

### PubkyAppBookmark

**Description:** Represents a bookmark to a URI.

**URI:** `/pub/pubky.app/bookmarks/:bookmark_id`

| **Field**    | **Type** | **Description**        | **Validation Rules**           |
| ------------ | -------- | ---------------------- | ------------------------------ |
| `uri`        | String   | URI of the bookmark.   | Required. Must be a valid URI. |
| `created_at` | Integer  | Timestamp of creation. | Required.                      |

**Validation Notes:**

- The `bookmark_id` is a **Hash ID** derived from the `uri`.

---

### PubkyAppFollow

**Description:** Represents a follow relationship.

**URI:** `/pub/pubky.app/follows/:user_id`

| **Field**    | **Type** | **Description**        | **Validation Rules** |
| ------------ | -------- | ---------------------- | -------------------- |
| `created_at` | Integer  | Timestamp of creation. | Required.            |

---

### PubkyAppMute

**Description:** Represents a mute relationship (a user the author has muted).

**URI:** `/pub/pubky.app/mutes/:user_id`

| **Field**    | **Type** | **Description**        | **Validation Rules** |
| ------------ | -------- | ---------------------- | -------------------- |
| `created_at` | Integer  | Timestamp of creation. | Required.            |

**Validation Notes:**

- The `user_id` in the URI is the **Pubky ID** of the muted user (same pattern as follows).

---

### PubkyAppBlob

**Description:** Raw binary data backing an uploaded file. Stored as bytes on the homeserver, not as a JSON object.

**URI:** `/pub/pubky.app/blobs/:blob_id`

| **Field** | **Type** | **Description**              | **Validation Rules**                          |
| --------- | -------- | ---------------------------- | --------------------------------------------- |
| *(body)*  | Bytes    | Raw file content.            | Required. Non-empty. Max size 100 MB.         |

**Validation Notes:**

- The `blob_id` is a **Hash ID** derived from the Blake3 hash of the blob bytes.
- Unlike other models, the homeserver body is the raw byte payload itself (not JSON).

---

### PubkyAppLastRead

**Description:** Tracks the last-read notification timestamp for a user.

**URI:** `/pub/pubky.app/last_read`

| **Field**   | **Type** | **Description**                              | **Validation Rules**        |
| ----------- | -------- | -------------------------------------------- | --------------------------- |
| `timestamp` | Integer  | Last-read time (Unix epoch, **milliseconds**). | Required. Positive integer. |

**Validation Notes:**

- Single resource per user (no ID segment in the path).
- `timestamp` uses **milliseconds**, unlike `created_at` on other models which use microseconds.

---

### PubkyAppFeed

**Description:** Represents a feed configuration.

**URI:** `/pub/pubky.app/feeds/:feed_id`

| **Field**      | **Type**  | **Description**             | **Validation Rules**                    |
| -------------- | --------- | --------------------------- | --------------------------------------- |
| `feed`         | Object    | Feed filter/sort settings.  | Required. See `feed` object below.      |
| `name`         | String    | Display name of the feed.   | Required. Non-empty after trim.         |
| `icon`         | String    | Lucide icon name.           | Required on new feeds; may be missing or `null` on older ones. Max 50 chars. Only `a-z`, `0-9`, `-`. |
| `created_at`   | Integer   | Unix timestamp of creation. | Required.                               |

#### `feed` object (`PubkyAppFeedConfig`)

| **Field**   | **Type** | **Description**                    | **Validation Rules**                                      |
| ----------- | -------- | ---------------------------------- | --------------------------------------------------------- |
| `tags`      | Array    | Tags for filtering.                | Optional. Max 5 tags. Each tag follows tag label rules.     |
| `domain_tags` | Array  | Domain tags for filtering.         | Optional. Max 5 tags. Each tag follows tag label rules.   |
| `reach`     | String   | Feed visibility scope.             | Required. One of: `following`, `followers`, `friends`, `all`, `wot`, `me`. |
| `layout`    | String   | Feed layout style.                 | Required. One of: `columns`, `wide`, `visual`, `list`, and since 0.8.1 `cards`. |
| `sort`      | String   | Sort order.                        | Required. One of: `recent`, `popularity`.                   |
| `content`   | String   | Post kind to filter by.            | Optional. A valid `PubkyAppPostKind` value.               |

**Validation Notes:**

- The `feed_id` is a **Hash ID** derived from the serialized `feed` object. `name` and `icon` are not part of it, so both can change without recreating the feed.
- Tags and domain tags are trimmed, lowercased, and empty entries are removed on sanitize.
- `icon` names a [Lucide](https://lucide.dev/icons) icon; the spec does not enumerate the allowed names, and clients fall back to their default icon for names they do not know. It is trimmed and lowercased on sanitize.
- Every newly created feed must carry an `icon`. It stays optional in the schema only so that feeds written before the field existed remain valid when the field is missing or `null`; an `icon` that is present but empty is rejected.

**Example: Valid Feed**

```json
{
  "feed": {
    "tags": ["crab", "rust"],
    "domain_tags": ["synonym"],
    "reach": "wot",
    "layout": "columns",
    "sort": "recent",
    "content": "video"
  },
  "name": "My Feed",
  "icon": "bitcoin",
  "created_at": 1700000000
}
```

---

## Validation Rules

### Common Rules

1. **Timestamp IDs:** 13-character Crockford Base32 strings derived from timestamps (in microseconds).
2. **Hash IDs:** First half of the bytes from the resulting Blake3-hashed strings encoded in Crockford Base32.
3. **URLs:** All URLs must pass standard validation.

---

## License

This specification is released under the MIT License.
