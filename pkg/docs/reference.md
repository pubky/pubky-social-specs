# Reference

Generated from the package by `qa/docs.mjs`; `npm run docs:check` fails when it is stale. Every
text below is the doc an editor shows on hover.

## Limits

`limits`, exported from the package. A builder, a validator and `decodeObject` refuse past each
one with a `ValidationError` whose `code` is `length`, `count` or `size` and whose `limit` is
the value here. A length counts Unicode code points, not UTF-16 units and not bytes.

| name | value | unit | what it bounds |
|---|---|---|---|
| `articleBodyMaxLength` | 50000 | code points | The longest article body. |
| `articleContentMaxLength` | 104000 | code points | The longest `content` of an article post, the whole envelope as text. |
| `articleTitleMaxLength` | 100 | code points | The longest article title. |
| `attachmentAltMaxLength` | 1000 | code points | The longest `alt` text of an attachment. |
| `attachmentNameMaxLength` | 255 | code points | The longest `name` of an attachment. |
| `bookmarkTargetUriMaxBytes` | 187 | bytes | The longest target a primary bookmark spells in its filename; a longer one takes the overflow form, `~{hash}`. |
| `collectionContentMaxLength` | 40000 | code points | The longest `content` of a collection post, the whole envelope as text. |
| `collectionDescriptionMaxLength` | 500 | code points | The longest collection description. |
| `collectionItemNoteMaxLength` | 1000 | code points | The longest note on a collection item. |
| `collectionItemsMaxCount` | 100 | items | The most items in a collection. |
| `collectionNameMaxLength` | 100 | code points | The longest collection name. |
| `collectionNameMinLength` | 1 | code points | The shortest collection name. |
| `feedIconMaxLength` | 50 | code points | The longest feed icon name. |
| `feedNameMaxLength` | 100 | code points | The longest feed name. |
| `feedTagsMaxCount` | 5 | items | The most labels in a feed's `tags`, and in its `domain_tags`. |
| `imageUrlMaxLength` | 300 | code points | The longest profile `image` and article or collection `cover_image`. |
| `maxFileSizeBytes` | 104857600 | bytes | The largest media file, 100 MiB. |
| `objectMaxBytes` | 65536 | bytes | The largest stored object other than a post, as stored. |
| `postAllowedAttachmentProtocols` | `"pubky"` `"http"` `"https"` |  | The schemes an attachment URI may have. |
| `postAttachmentsMaxCount` | 10 | items | The most attachments on a post. |
| `postMaxBytes` | 524288 | bytes | The largest stored post, as stored. |
| `postNoteContentMaxLength` | 2000 | code points | The longest `content` of a post of any kind but an article or a collection. |
| `postSlugMaxLength` | 64 | code points | The longest slug of a post version. |
| `referenceUriMaxLength` | 1024 | code points | The longest reference: a `parent`, an `embed`, a `lock`, an attachment or a collection item. |
| `tagInvalidChars` | `","` `":"` `" "` `"\t"` `"\n"` `"\r"` |  | The characters a tag label may not hold. |
| `tagLabelMaxLength` | 20 | code points | The longest tag label. |
| `tagLabelMinLength` | 1 | code points | The shortest tag label. |
| `userBioMaxLength` | 160 | code points | The longest profile bio. |
| `userLinkTitleMaxLength` | 100 | code points | The longest title of a profile link. |
| `userLinkUrlMaxLength` | 300 | code points | The longest URL of a profile link. |
| `userLinksMaxCount` | 5 | items | The most links on a profile. |
| `userNameMaxLength` | 50 | code points | The longest profile name. |
| `userNameMinLength` | 3 | code points | The shortest profile name. |
| `userStatusMaxLength` | 50 | code points | The longest profile status. |

## Media types

The declared type of a file picks the extension of its path and is never stored. A type is
matched on its essence: the text before any `;`, ASCII-lowercased. Any type not below, an empty
one included, gets `.bin`.

| type | extension |
|---|---|
| `application/javascript` | `.js` |
| `application/json` | `.json` |
| `application/octet-stream` | `.bin` |
| `application/pdf` | `.pdf` |
| `application/x-www-form-urlencoded` | `.bin` |
| `application/xml` | `.xml` |
| `application/zip` | `.zip` |
| `audio/mpeg` | `.mp3` |
| `audio/wav` | `.wav` |
| `image/gif` | `.gif` |
| `image/jpeg` | `.jpg` |
| `image/png` | `.png` |
| `image/svg+xml` | `.svg` |
| `image/webp` | `.webp` |
| `multipart/form-data` | `.bin` |
| `text/css` | `.css` |
| `text/csv` | `.csv` |
| `text/html` | `.html` |
| `text/plain` | `.txt` |
| `text/xml` | `.xml` |
| `video/mp4` | `.mp4` |
| `video/mpeg` | `.mpeg` |

## Stored objects

Each object as `decodeObject` gives it and `encodeObject` takes it. Every known member is
present, `null` when it has no value, and `$unknown` carries members a newer writer added, as
text. Integers are numbers; `created_at` is microseconds since the epoch.

### User

A profile, stored at `/pub/social/v1/profile.json`: one per owner, public.

| member | type | null | meaning |
|---|---|---|---|
| `links` | `UserLink[]` | yes | At most 5 links shown on the profile; null for none. |
| `name` | `string` |  | The display name, trimmed by the builder: 3 to 50 code points, not blank. |
| `bio` | `string` | yes | A short description, trimmed by the builder: at most 160 code points; null for none. |
| `image` | `string` | yes | The avatar: a canonical pubky or web URI of at most 300 code points, never under the private root; null for none. |
| `status` | `string` | yes | A status line, trimmed by the builder: at most 50 code points; null for none. |
| `$unknown` (optional) | `string` |  | The members a newer writer added, as the text they were read with. Carry it along. |

### UserLink

One link on a profile.

| member | type | null | meaning |
|---|---|---|---|
| `title` | `string` |  | The link's label, trimmed by the builder: 1 to 100 code points, not blank. |
| `url` | `string` |  | A canonical `http://` or `https://` URL, stored as written: at most 300 code points. |
| `$unknown` (optional) | `string` |  | The members a newer writer added, as the text they were read with. Carry it along. |

### Post

One version of a post, stored at `posts/{id}/{editId}[-slug].json` under the public or the private root. `id` and `editId` are in the path, not in the object.

| member | type | null | meaning |
|---|---|---|---|
| `kind` | `"image" \| "note" \| "article" \| "video" \| "link" \| "file" \| "collection"` |  | What the post is, one of `postKinds`: a kind this version does not know is refused on read. It decides what `content` holds. |
| `attachments` | `Attachment[]` |  | At most 10 media references; empty for none. A collection carries none: its items are in its envelope. |
| `content` | `string` |  | Text for an untyped kind; for an article or a collection, the envelope `decodeContent` reads. |
| `parent` | `string` | yes | The post this one replies to: a versionless reference of at most 1024 code points; null for none. |
| `embed` | `string` | yes | The post or URI this one quotes: a versionless reference of at most 1024 code points; null for none. |
| `lock` | `string` | yes | A pubky reference to what gates the post (a payment or a membership), at most 1024 code points; null for none. Readers that do not honour it show the post as it is. |
| `$unknown` (optional) | `string` |  | The members a newer writer added, as the text they were read with. Carry it along. |

### Attachment

One media reference of a post.

| member | type | null | meaning |
|---|---|---|---|
| `uri` | `string` |  | The media: a canonical `pubky`, `http` or `https` URI of at most 1024 code points, under the post's root rules. |
| `alt` | `string` | yes | Text describing the media for a screen reader: at most 1000 code points; null for none. |
| `name` | `string` | yes | The file name shown, trimmed by the builder: 1 to 255 code points, not blank; null for none. |
| `$unknown` (optional) | `string` |  | The members a newer writer added, as the text they were read with. Carry it along. |

### ArticleContent

The envelope of an article, inside its post's `content`: read it with `decodeContent`.

| member | type | null | meaning |
|---|---|---|---|
| `title` | `string` |  | The title, trimmed by the builder: 1 to 100 code points, not blank, no control character but tab, newline and carriage return. |
| `body` | `string` |  | The text, Markdown by convention: at most 50000 code points, no control character but tab, newline and carriage return. |
| `cover_image` | `string` | yes | A canonical `pubky`, `http` or `https` URI of an image, at most 300 code points; null for none. |
| `$unknown` (optional) | `string` |  | The members a newer writer added, as the text they were read with. Carry it along. |

### CollectionContent

The envelope of a collection, inside its post's `content`: read it with `decodeContent`.

| member | type | null | meaning |
|---|---|---|---|
| `items` | `CollectionItem[]` |  | At most 100 items, in the curator's order; empty for none. |
| `name` | `string` |  | The collection's name, trimmed by the builder: 1 to 100 code points, not blank. |
| `cover_image` | `string` | yes | A canonical `pubky`, `http` or `https` URI of an image, at most 300 code points; null for none. |
| `description` | `string` | yes | What it gathers, trimmed by the builder: at most 500 code points, not blank; null for none. |
| `layout` | `CollectionLayout` | yes | How the creator would show it, one of `collectionLayouts`, or a newer writer's name kept as written; null for the reader's choice. |
| `$unknown` (optional) | `string` |  | The members a newer writer added, as the text they were read with. Carry it along. |

### CollectionItem

One entry of a collection.

| member | type | null | meaning |
|---|---|---|---|
| `uri` | `string` |  | What is curated: a versionless reference of any scheme (a pubky URL, a web URL or another scheme), at most 1024 code points. |
| `note` | `string` | yes | The curator's note, trimmed by the builder: 1 to 1000 code points, not blank; null for none. |
| `$unknown` (optional) | `string` |  | The members a newer writer added, as the text they were read with. Carry it along. |

### Tag

A label on an object, stored at `/pub/social/v1/tags/{id}.json`; the id hashes the target and the label.

| member | type | null | meaning |
|---|---|---|---|
| `uri` | `string` |  | What is tagged: a reference of any scheme (a pubky URL, a web URL or another scheme), at most 1024 code points. A post is named versionless. |
| `label` | `string` |  | The label as stored: trimmed and ASCII-lowercased, 1 to 20 code points, no whitespace, `,` or `:`. |
| `created_at` | `number` |  | Microseconds since the epoch. |
| `$unknown` (optional) | `string` |  | The members a newer writer added, as the text they were read with. Carry it along. |

### Bookmark

A saved reference, private, stored at `/priv/social/v1/bookmarks/{filename}.json`; the filename spells the target.

| member | type | null | meaning |
|---|---|---|---|
| `created_at` | `number` |  | Microseconds since the epoch. |
| `target` | `string` | yes | What is bookmarked, only on the overflow form (`~{hash}`), whose filename cannot spell a target over 187 bytes; null on the primary form, whose filename is the target in base64url. |
| `$unknown` (optional) | `string` |  | The members a newer writer added, as the text they were read with. Carry it along. |

### Follow

A follow, stored at `/pub/social/v1/follows/{followee}.json`: the path holds the followee.

| member | type | null | meaning |
|---|---|---|---|
| `created_at` | `number` |  | Microseconds since the epoch. |
| `$unknown` (optional) | `string` |  | The members a newer writer added, as the text they were read with. Carry it along. |

### Mute

A mute, private, stored at `/priv/social/v1/mutes/{mutee}.json`: the path holds the muted key.

| member | type | null | meaning |
|---|---|---|---|
| `created_at` | `number` |  | Microseconds since the epoch. |
| `$unknown` (optional) | `string` |  | The members a newer writer added, as the text they were read with. Carry it along. |

### Feed

A saved feed, private, stored at `/priv/social/v1/feeds/{id}.json`; its published copy is the same leaf under `/pub/`.

| member | type | null | meaning |
|---|---|---|---|
| `feed` | `FeedConfig` |  | The filter, which is the whole identity of the feed: its id hashes these members. |
| `name` | `string` |  | The display name, trimmed by the builder: 1 to 100 code points, not blank. Outside the id. |
| `created_at` | `number` |  | Microseconds since the epoch. |
| `icon` | `string` | yes | 1 to 50 of a-z, 0-9 and `-`: a name for the client's icon set, not an emoji. |
| `$unknown` (optional) | `string` |  | The members a newer writer added, as the text they were read with. Carry it along. |

### FeedConfig

The filter of a feed, which is its identity.

| member | type | null | meaning |
|---|---|---|---|
| `reach` | `"following" \| "followers" \| "friends" \| "all" \| "wot" \| "me"` |  | Whose posts the feed shows, one of `feedReaches`: `all`, the owner's `following` or `followers`, mutual `friends`, the `wot` (web of trust) or `me`. |
| `layout` | `"list" \| "visual" \| "columns" \| "wide"` |  | How the client lays the feed out, one of `feedLayouts`: `columns`, `wide`, `visual` (media first) or `list`. |
| `sort` | `"recent" \| "popularity"` |  | The order of the posts, one of `feedSorts`: `recent` or `popularity`. |
| `content` | `PostKind` | yes | The one post kind shown, one of `postKinds`, or a newer writer's name kept as written; null for every kind. |
| `tags` | `string[]` | yes | The tag labels a post must carry: at most 5, folded, deduplicated and sorted by code point; null for no tag filter. |
| `domain_tags` | `string[]` | yes | The domain labels a post's links must carry, with the rules of `tags`; null for no domain filter. |
| `$unknown` (optional) | `string` |  | The members a newer writer added, as the text they were read with. Carry it along. |

## Error codes

The `code` of a `ValidationError`. The message text may change between releases; the code of a
rule does not.

| code | the rule |
|---|---|
| `json` | the bytes, or an envelope inside them, are not JSON of the stored shape |
| `size` | an object or a file is over its byte cap, `limit` in bytes |
| `length` | text is outside its bounds, `limit` the bound it broke, in code points |
| `count` | a list has more items than `limit` |
| `blank` | text, a list or a file is empty or whitespace only |
| `format` | text is not spelled the one way the model accepts (a key, an id, a tag, a slug) |
| `id` | an id does not match its object, or its time is out of bounds |
| `reference` | a URI in a reference position is refused |
| `unknown_name` | a kind, reach, layout or sort this version does not know |
| `unsafe_integer` | an integer a JS number cannot hold exactly |
| `path` | a URL or path names no object of the kind asked for |
| `conflict` | members or arguments that cannot go together |
| `migration` | refused by the migrator, see the message |
