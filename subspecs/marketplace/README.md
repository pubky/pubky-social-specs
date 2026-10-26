# pubky-marketplace-specs

The marketplace sub-spec of Pubky social, **a draft for the marketplace team to adopt when they
choose to**. Nothing here changes their code or their data. It models what the fork
[`BitcoinErrorLog/pubky-app-specs`](https://github.com/BitcoinErrorLog/pubky-app-specs) holds at
tag `v0.6.2-marketplace.16` (commit `5ef6e31`) on the shared post envelope, and follows
[`docs/SUBSPECS.md`](../../docs/SUBSPECS.md). Every change from the fork's model is listed
[below](#changes-from-the-forks-model), so the team can judge each one.

## Paths

| what | path |
| --- | --- |
| a version of a listing, a drop or a shop | `/{pub,priv}/marketplace/v1/posts/{id}/{editId}[-{slug}].json` |
| the post, as a reference names it | `pubky://{owner}/{pub,priv}/marketplace/v1/posts/{id}` |
| a review | a social rating, `/pub/social/v1/posts/{id}/{editId}.json`, by the reviewer |
| a watched listing | a social bookmark, `/priv/social/v1/bookmarks/{base64url(listing URI)}.json` |
| a keyword of a listing | a social tag, `/pub/social/v1/tags/{hash(listing URI:label)}.json` |

`version_path`, `post_uri` and `parse_post_uri` build and read the marketplace paths;
`create_version`, `edit_version` and `read_version` mint, edit and read a version as social does,
with the owner rules run with the author.

## Kinds

| kind | what | feed-only |
| --- | --- | --- |
| `listing` | something for sale: variants, a sale (fixed price or auction), fulfillment, shipping, returns | no |
| `drop` | a timed first-come-first-served release of some of the seller's listings | no |
| `shop` | the seller's storefront: policies, terms, the transaction service; one current post per seller | no |

`FEED_ONLY_KINDS` is empty: listings, drops and shops are durable, and people tag, rate, bookmark
and collect them. Every cap is in `MARKETPLACE_LIMITS`, the fork's values wherever the fork had one.

### `listing`

`parent` and `embed` are refused. The photos are the post's `attachments`, 1 to 10, each a file of
the seller (`pubky://{seller}/{pub,priv}/social/v1/files/…`), `attachments[0]` the cover. `lock`
is the lock a digital good is released by.

```json
{
  "title": "Vintage Walkman", "description": "Works, with the original belt clip.",
  "state": "active", "taxonomy_version": 1, "category_id": "electronics-audio",
  "attributes": { "brand": "Sony", "colors": ["silver", "blue"] },
  "condition": "good", "condition_details": "Scratches on the lid.",
  "location": { "uri": "geo:46.01,8.96", "country_code": "CH", "region": "Ticino" },
  "variants": [{ "id": "only", "sku": "WM-2", "options": {}, "quantity": 1,
                 "media": ["pubky://<seller>/pub/social/v1/files/<hash>.png"], "enabled": true }],
  "sale": { "format": "fixed_price", "unit_price": { "amount_minor": 4999, "currency": "USD", "exponent": 2 }, "accepts_offers": true },
  "fulfillment_methods": ["physical"],
  "package": { "weight_g": 400, "length_mm": 150, "width_mm": 100, "height_mm": 50 },
  "shipping_options": [{ "id": "post", "pricing": "flat", "label": "Swiss Post",
                         "price": { "amount_minor": 900, "currency": "USD", "exponent": 2 },
                         "estimated_min_days": 1, "estimated_max_days": 3 }],
  "return_policy": { "accepts_returns": true, "return_window_days": 14, "buyer_pays_return_shipping": true },
  "adult_only": false
}
```

| member | rule |
| --- | --- |
| `title` | trimmed; 3 to 80 code points |
| `description` | trimmed; 1 to 10000 code points |
| `state` | `active`, `paused`, `ended` or `removed`; an active listing needs an enabled variant with stock |
| `taxonomy_version`, `category_id` | 1 to 1000000; a kebab-case category of that tree, at most 120 characters |
| `attributes` | at most 20 keys of `[a-z0-9]` parts joined by `-` or `_`, at most 40 characters; a value is a text of 1 to 80 code points or 1 to 10 distinct texts |
| `condition` | `new`, `like_new`, `excellent`, `good`, `fair` or `for_parts`; `condition_details` at most 1000 code points |
| `location` | optional; `uri` a place reference under the place conventions (an OpenStreetMap object, a `geo:` pin as rough as the seller likes), `country_code` ISO 3166-1 alpha-2, `region` 1 to 100 code points |
| `variants[]` | 1 to 100: `id` unique, 1 to 128 of `A-Za-z0-9_-`; `sku` unique, 1 to 64; `options` at most 3, keys 1 to 40, values 1 to 80; `price_override` positive, in the sale's asset; `quantity` 0 to 1000000, the seller's intent; `media` attachment URIs of the post; `enabled`, true when absent |
| `sale` | `format` `fixed_price` (`unit_price` required, `accepts_offers` false when absent) or `auction` (`starting_price`, `minimum_increment`, `starts_at`, `ends_at` required; `reserve_price` at least the start, `buy_now_price` above it, all in one asset; `anti_sniping_window_s` and `anti_sniping_extension_s` 0 to 3600, 0 when absent; exactly one variant). A format's members are refused on the other |
| `fulfillment_methods` | 1 to 4 distinct of `physical`, `digital`, `pickup`, `shipping` |
| `package` | required with `physical`, refused without: `weight_g` 1 to 1000000, `length_mm`, `width_mm`, `height_mm` 1 to 100000 |
| `shipping_options[]` | at least one with `physical`, none without, at most 20: `id` unique; `pricing` `free`, `flat` (`price`, zero allowed, in the sale's asset) or `calculated` (`provider` 1 to 50, `service_code` 1 to 100); `label` 1 to 100; `estimated_min_days` 0 to 365, `estimated_max_days` at least that |
| `return_policy` | `accepts_returns`, `buyer_pays_return_shipping`; `return_window_days` 1 to 365 exactly when returns are accepted; `details` at most 4000 |
| `digital_lock` | with the post's `lock` only, and a lock only with `digital`: `resource_hash` 64 lowercase hex, `minimum_confirmations` 0 to 6, `criterion_id` optional |
| `adult_only` | false when absent |

Money is `{ amount_minor, currency, exponent }`: an integer of the minor unit (positive, or zero
for a flat shipping price), a currency of 3 to 12 uppercase letters and digits starting with a
letter (not held to ISO 4217: `BTC` and `SAT` are currencies), an exponent 0 to 18. The raw content
is bounded at 100000 code points before it is parsed; the variant, shipping option and attribute
counts are checked before any item is read.

### `drop`

```json
{ "title": "Spring drop", "description": "Ten numbered prints.", "format": "fcfs",
  "starts_at": 1792000000000000, "ends_at": 1792086400000000,
  "listings": ["pubky://<seller>/pub/marketplace/v1/posts/0032SSN7Q4EVG"],
  "total_quantity": 10, "per_buyer_limit": 2, "stock_display": "bands" }
```

`title` 1 to 120, `description` at most 2000; `format` `fcfs`; `starts_at` and the optional
`ends_at` (after it) integer microseconds; `listings` 1 to 20 distinct versionless URIs of the
seller's own listing posts, references through the gate; `total_quantity` 1 to 1000000;
`per_buyer_limit` 1 to 100 and at most the total; `stock_display` `exact`, `bands` or `hidden`.
The cover is `attachments[0]`. The schedule and the counters are the transaction service's to
enforce; the post says what the seller intends.

### `shop`

```json
{ "name": "Lugano Vintage", "bio": "Old electronics, tested.",
  "location": { "uri": "https://www.openstreetmap.org/relation/1685013", "country_code": "CH" },
  "shipping_policy": "Ships within two days.", "return_policy": "14 days.", "vacation_mode": false,
  "transaction_service": "https://shop.example.com/api", "delivery_assume_days": 14, "auto_complete_days": 7 }
```

`name` 1 to 60; `bio` at most 1000; `shipping_policy` and `return_policy` at most 4000;
`transaction_service` an https URL of at most 300 characters with no user, query or fragment, a
reference through the gate, where a client sends this shop's checkout, offers, bids and orders;
`delivery_assume_days` and `auto_complete_days` 1 to 60. The banner is `attachments[0]`; the
picture and name a seller is known by are their social profile's. A seller keeps one shop post and
edits it; a reader takes the newest version.

## Reviews

A review is a social `rating`, so every app's readers and the indexer's counts see it, with the
marketplace's additions in the post's `ext.marketplace`:

```json
{ "kind": "rating", "parent": "pubky://<seller>/pub/marketplace/v1/posts/0032SSN7Q4EVG",
  "content": "{\"rating\":9,\"text\":\"As described, fast shipping.\"}",
  "ext": { "marketplace": {
    "role": "buyer_reviewing_seller", "listing": "pubky://<seller>/pub/marketplace/v1/posts/0032SSN7Q4EVG",
    "order_ref": "<64 hex>", "attestation": "<compact JWS>",
    "item_accuracy": 10, "shipping": 8, "communication": 10 } } }
```

- A buyer rates the listing: `parent` is the listing post. A seller rates the buyer: `parent` is
  the buyer's profile, `pubky://<buyer>/pub/social/v1/profile.json`, and `ext.marketplace.listing`
  the listing bought.
- The stars are social's half stars, 1 to 10; `item_accuracy`, `shipping` and `communication` take
  the same scale.
- `attestation` is the fork's purchase attestation: a compact JWS, header
  `{"alg":"EdDSA","typ":"pubky-purchase-attestation+v1"}`, the claims `v`, `iss`, `sub`, `cpk`,
  `role`, `listing`, `order_ref`, `completed_on`, `amount_band?`, `price_decade?`, `iat` closed,
  signed by the transaction service's key whose pubky is `iss`.
- `validate_review(post, author)` verifies the signature and binds it: `sub` is the author, `role`,
  `listing` and `order_ref` are the review's, `cpk` is the seller (a buyer's review) or the buyer
  whose profile is the `parent` (a seller's). Whether an `iss` is trusted is the reader's own
  list. `VerifiedReview::count_key` is `iss:order_ref:role:listing`, the key a review counts
  under, and `is_authorized_response` says whether a reply is the subject's response.
- A response to a review is a social post whose `parent` is the rating post, by the review's
  subject.

## What the marketplace uses instead of its own copies

| the fork's | here |
| --- | --- |
| `PubkyAppMarketplaceReview` | a social `rating` with `ext.marketplace` |
| `PubkyAppReviewResponse` | a social reply to the rating |
| `PubkyAppWatchlist` | the buyer's private social bookmarks of listing URIs |
| `listing.tags` | social tags on the listing's URI |
| `digitalLock.policyUri` | the post's `lock` |
| listing and drop `media` | the post's `attachments`, social files |
| a drop's bundle | stays a kind (it adds a schedule and counters); a plain list of listings is a social `collection` |

## Changes from the fork's model

**Where things are**

1. Paths: `/pub/pubky.app/marketplace/v1/{listings,drops}/{id}` and `…/shop.json` become posts
   under `/pub/marketplace/v1/posts/{id}/{editId}.json`: the namespace is `marketplace`, not
   ADR 0027's `app.marketplace`.
2. Ids: a listing's and a drop's id is the post's timestamp id and an edit is a new `editId`; the
   seller-chosen `listingId` and `dropId` (32 hex in practice) go, as ADR 0027 planned.
3. The base fields go: `schemaVersion` is the `v1` in the path, `recordType` the kind, `ownerPubky`
   the path's owner (so it can no longer disagree with the URI), `revision` and `updatedAt` the
   `editId`, `createdAt` the post id.
4. The shop is a `shop` post, one current per seller, not a singleton file. `avatarUrl` goes (the
   social profile's image is the seller's picture), `bannerUrl` is `attachments[0]`. `bio`,
   `shipping_policy`, `return_policy` and `location` are optional, a blank one absent, where the
   fork required them, possibly empty.

**Spelling and units**

5. Members are snake_case, the sub-spec rule when no outside standard names them:
   `taxonomyVersion` → `taxonomy_version`, `categoryId` → `category_id`, `conditionDetails` →
   `condition_details`, `priceOverride` → `price_override`, `unitPrice` → `unit_price`,
   `acceptsOffers` → `accepts_offers`, `startingPrice` → `starting_price`, `reservePrice` →
   `reserve_price`, `buyNowPrice` → `buy_now_price`, `minimumIncrement` → `minimum_increment`,
   `fulfillmentMethods` → `fulfillment_methods`, `shippingOptions` → `shipping_options`,
   `serviceCode` → `service_code`, `estimatedMinDays` → `estimated_min_days`,
   `estimatedMaxDays` → `estimated_max_days`, `returnPolicy` → `return_policy`, `acceptsReturns`
   → `accepts_returns`, `returnWindowDays` → `return_window_days`, `buyerPaysReturnShipping` →
   `buyer_pays_return_shipping`, `digitalLock` → `digital_lock`, `criterionId` → `criterion_id`,
   `resourceHash` → `resource_hash`, `minimumConfirmations` → `minimum_confirmations`,
   `adultOnly` → `adult_only`, `amountMinor` → `amount_minor` (as the fork's receipt attestation v2
   already spells money), `countryCode` → `country_code`, `vacationMode` → `vacation_mode`,
   `transactionService` → `transaction_service`, `deliveryAssumeDays` → `delivery_assume_days`,
   `autoCompleteDays` → `auto_complete_days`, `totalQuantity` → `total_quantity`,
   `perBuyerLimit` → `per_buyer_limit`, `stockDisplay` → `stock_display`.
6. Instants are integer microseconds: an auction's and a drop's `startsAt`/`endsAt` ISO strings
   become `starts_at`/`ends_at`.
7. Durations carry their unit: `antiSnipingWindowSeconds` → `anti_sniping_window_s`,
   `antiSnipingExtensionSeconds` → `anti_sniping_extension_s` (0 when absent, where the fork
   required them); `weightGrams` → `weight_g`, `lengthMillimeters`, `widthMillimeters`,
   `heightMillimeters` → `length_mm`, `width_mm`, `height_mm`. Days keep `_days`.
8. `accepts_offers` is false when absent, where the fork required it. A variant's `enabled` is true
   when absent, as in the fork.

**Location, media, keywords, locks**

9. A location is a place URI in a reference position (`location.uri`: an OpenStreetMap object or a
   `geo:` pin, under social's place conventions) with an optional `country_code` and `region`. The
   fork's location was `{countryCode, region?}`, required on a listing; here it is optional, for a
   digital good.
10. Listing media are the post's `attachments`, social files: the content hash is the file's id,
    the MIME type the file's, the alt text the attachment's `alt`. At most 10 (social's attachment
    cap), where the fork took 12 images and 1 video; the envelope cannot see a file's type, so the
    image and video counts are the client's. `width`, `height` and `durationMs` have no home on a
    social attachment yet (the fork's request R9); a client may keep them as unknown members of an
    attachment, which readers preserve. A variant's `mediaIds` become `media`, attachment URIs.
    The rule that media are the seller's own stays: an attachment is a file of the seller.
11. The seller's keywords (`tags`, 1 to 40 characters, case and spaces kept) become social tags on
    the listing's URI, with social's label rules (1 to 20, lowercased, no whitespace): community
    tags and the seller's own tags are one primitive, told apart by who wrote them.
12. A digital lock's `policyUri` is the post's `lock`, any pubky reference (the fork hardcoded
    `locks.app`); the rest is `digital_lock`. `criterion_id` is absent rather than defaulting to
    `criterion-1`.

**Reading**

13. Unknown members are preserved on rewrite everywhere (the fork's Rust read them and dropped them
    when it wrote the record again).
14. A closed set (`state`, `condition`, a sale's `format`, `pricing`, `stock_display`, a review's
    `role`) keeps a name this version does not know with its spelling, and refuses it, as social's
    1.1 sets do: the fork failed to parse such a record, and its R3 asks for a fallback value. The
    tagged unions (`sale` by `format`, a shipping option by `pricing`) are records with the tag as a
    member, so an unknown tag reads, is refused and is written back.
15. Display text is trimmed by the builder with social's frozen whitespace set and counted as stored
    by the reader, never trimmed on read (the fork trimmed with `str::trim()` on every read).
16. A drop's `listingIds` (bare ids, the owner implied) become `listings`, versionless URIs of the
    seller's listing posts, held to the same author when the author is in scope. Its `media` URIs
    become `attachments`; `description` is optional.

**Reviews**

17. A review is a social `rating` by the reviewer (the fork: `/reviews/{hash id}` of its own),
    `parent` the listing post or the buyer's profile. `subjectPubky`, `listingOwnerPubky` and
    `listingId` are read from the `parent` and from `ext.marketplace.listing`; `eligibilityAttestation`
    is `attestation`; `orderRef` is `order_ref`, now required (the legacy unscoped review goes).
18. Stars: the fork's 1 to 5 for `overall`, `itemAccuracy`, `shipping` and `communication` become
    social's 1 to 10 half stars, the rating's own `rating` and the three sub-ratings: a fork value
    doubles.
19. The review text is the rating's `text`, at most 2000 code points, social's cap; the fork took
    5000.
20. Identity: the fork addressed one review per (listing, subject, role, order) by a hash id. A
    social rating is a timestamp-id post, one per author per target, the newest version winning;
    a marketplace reader counts by `VerifiedReview::count_key` (`iss:order_ref:role:listing`), as
    the fork's item count key does, and a buyer who buys a listing twice edits one rating.
21. The purchase attestation keeps its header, claims and signature; only its `listing` claim names
    the listing post (`pubky://<seller>/pub/marketplace/v1/posts/{id}`). This crate verifies the
    signature and the binding; the price weight table (the fork's counting rules v2) is a reader's
    counting policy and is not here.
22. A review response is a social reply to the rating post, its subject rule
    (`is_authorized_response`) a reader's check, as in the fork.
23. The watchlist is the buyer's private social bookmarks of listing URIs: one file per watched
    listing, deleted to unwatch, in place of the merged document with tombstones.

**Not covered by this draft**

24. Order receipts and their attestations, drop edition attestations, the attestor's profile and
    annotations, the sealed `pubky-priv-aead` storage and the badge checkpoints stay as the
    marketplace keeps them: private records and service-signed artifacts are app data, outside the
    social namespace and outside this sub-spec. The attestor's public profile and annotations are
    the likeliest to become marketplace kinds later, since verifiers read them.

## Tests and vectors

`cargo test -p pubky-marketplace-specs` runs the unit tests, the builders and four vector files,
one JSON document per line `{ name, url, body, verdict }`:

- `vectors/listing.jsonl`, `vectors/drop.jsonl`, `vectors/shop.jsonl`: each rule of the three
  kinds, read as a stored version is read;
- `vectors/review.jsonl`: ratings read as an indexer reads them (the social reader by URI, then
  `validate_review`), signed with a test attestor key of 32 bytes of 7, the fork's test key.

`RECORD_VECTORS=1 cargo test -p pubky-marketplace-specs` rewrites them after a deliberate change.
