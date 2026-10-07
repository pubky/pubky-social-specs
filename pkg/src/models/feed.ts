import { nowMicros } from "../clock.js";
import { limits } from "../data.js";
import { fail } from "../errors.js";
import { checkHashId, checkPublicKey, hashId } from "../ids.js";
import { closed, type Extra, i64, list, open, option, string } from "../json/schema.js";
import { compareKeys } from "../json/write.js";
import { asciiFold, codePointLen, frozenTrim } from "../text.js";
import { socialPath } from "../uri.js";
import { checkExtra, checkSafeInt, type Model, parse, SIZES, validate } from "./common.js";
import { checkLabel, foldLabel } from "./graph.js";
import { feedLayout, type FeedLayout, feedLayouts, feedReach, type FeedReach, feedReaches, feedSort, type FeedSort, feedSorts, known, postKind, type PostKind, postKinds } from "./kinds.js";

export interface FeedConfig extends Extra {
  tags: string[] | null;
  domain_tags: string[] | null;
  reach: FeedReach;
  layout: FeedLayout;
  sort: FeedSort;
  content: PostKind | null;
}

export interface Feed extends Extra {
  feed: FeedConfig;
  name: string;
  icon: string | null;
  created_at: bigint;
}

const encoder = new TextEncoder();

function checkTagList(tags: string[] | null, field: string): void {
  if (tags === null) return;
  if (tags.length === 0) fail(`Feed config ${field} cannot be an empty list, omit it for no filter`);
  if (tags.length > limits.feedTagsMaxCount) fail(`Feed config cannot have more than ${limits.feedTagsMaxCount} ${field}`);
  for (const tag of tags) {
    if (tag !== foldLabel(tag)) fail(`Tag '${tag}' must be stored folded (trimmed, ASCII lowercase)`);
    checkLabel(tag);
  }
  for (let i = 1; i < tags.length; i++) {
    if (compareKeys(tags[i - 1] as string, tags[i] as string) >= 0) {
      fail(`Feed config ${field} must be stored deduplicated and sorted by code point`);
    }
  }
}

function checkIcon(icon: string | null): void {
  if (icon === null) return;
  const length = codePointLen(icon);
  if (length < 1 || length > limits.feedIconMaxLength) fail(`Feed icon '${icon}' must be 1 to ${limits.feedIconMaxLength} characters`);
  for (const c of icon) if (!/^[a-z0-9-]$/.test(c)) fail(`Feed icon '${icon}' contains invalid character: ${c}`);
}

// The id is the filter alone, so name and icon change without moving the feed
function idOf(value: Feed): string {
  const f = value.feed;
  const joined = (tags: string[] | null) => tags?.join(",") ?? "";
  return hashId(encoder.encode(`${f.reach}:${f.layout}:${f.sort}:${f.content ?? ""}:${joined(f.tags)}:${joined(f.domain_tags)}`));
}

const config = open<FeedConfig>("PubkySocialFeedConfig", {
  tags: { codec: option(list(string)) },
  domain_tags: { codec: option(list(string)), absent: () => null, skipNull: true },
  reach: { codec: feedReach },
  layout: { codec: feedLayout },
  sort: { codec: feedSort },
  content: { codec: option(postKind) },
});

export const feed: Model<Feed> = {
  codec: open<Feed>("PubkySocialFeed", {
    feed: { codec: config },
    name: { codec: string },
    icon: { codec: option(string), absent: () => null, skipNull: true },
    created_at: { codec: i64 },
  }),
  maxBytes: SIZES.object,
  check(value, id) {
    const f = value.feed;
    // reach, layout and sort define the feed; an unknown content filter only means no filter
    if (f.reach === "unknown") fail("feed reach is unknown");
    if (f.layout === "unknown") fail("feed layout is unknown");
    if (f.sort === "unknown") fail("feed sort is unknown");
    checkExtra(f.extra);
    checkTagList(f.tags, "tags");
    checkTagList(f.domain_tags, "domain_tags");
    checkExtra(value.extra);
    if (frozenTrim(value.name) === "") fail("Feed name cannot be empty");
    if (codePointLen(value.name) > limits.feedNameMaxLength) fail(`Feed name exceeds maximum length of ${limits.feedNameMaxLength} characters`);
    checkIcon(value.icon);
    checkSafeInt(value.created_at);
    if (id !== null) {
      checkHashId(id);
      // A reader that does not know the content filter cannot rebuild the writer's id input
      if (f.content !== "unknown") {
        const expected = idOf(value);
        if (expected !== id) fail(`Invalid ID: expected ${expected}, found ${id}`);
      }
    }
  },
};

/** The id of a feed object, so an edited feed finds its new path with its unknown members kept. */
export function feedId(value: Feed): string {
  validate(feed, value, null, false);
  if (value.feed.content === "unknown") fail("a feed carrying an unknown content kind has no derivable id; keep the id it was read under");
  return idOf(value);
}

export const feedIdOf = (feedJson: string) => feedId(parse(feed.codec, feedJson));

/** A feed lives at `private`; its published copy is the same bytes at `public`. */
export function feedPaths(id: string): { private: string; public: string } {
  checkHashId(id);
  return { private: socialPath("private", `feeds/${id}.json`), public: socialPath("public", `feeds/${id}.json`) };
}

interface FeedInput {
  tags: string[] | null;
  domainTags: string[] | null;
  reach: string;
  layout: string;
  sort: string;
  content: string | null;
  name: string;
  icon: string;
}

const none = { absent: () => null };
const input = closed<FeedInput>("FeedInput", {
  tags: { codec: option(list(string)), ...none },
  domainTags: { codec: option(list(string)), ...none },
  reach: { codec: string },
  layout: { codec: string },
  sort: { codec: string },
  content: { codec: option(string), ...none },
  name: { codec: string },
  icon: { codec: string },
});

function filter(tags: string[] | null, field: string): string[] | null {
  if (tags === null) return null;
  if (tags.length === 0) fail(`${field} must not be an empty list; pass None for no filter`);
  if (tags.some((tag) => foldLabel(tag) === "")) fail(`${field} must not contain a blank label`);
  return [...new Set(tags.map(foldLabel))].sort(compareKeys);
}

/** A feed at its private path, from the JSON text of its input. The builder folds and sorts. */
export function buildFeed(owner: string, inputJson: string) {
  checkPublicKey(owner);
  const i = parse(input, inputJson);
  const content = i.content === null ? null : known(postKinds, "content kind", i.content);
  const reach = known(feedReaches, "feed reach", i.reach);
  const layout = known(feedLayouts, "feed layout", i.layout);
  const sort = known(feedSorts, "feed sort", i.sort);
  const tags = filter(i.tags, "tags");
  const domainTags = filter(i.domainTags, "domain_tags");
  checkTagList(tags, "tags");
  checkTagList(domainTags, "domain_tags");
  const value: Feed = {
    feed: { tags, domain_tags: domainTags, reach, layout, sort, content, extra: new Map() },
    name: frozenTrim(i.name),
    icon: asciiFold(frozenTrim(i.icon)),
    created_at: nowMicros(),
    extra: new Map(),
  };
  const body = validate(feed, value, null, false);
  const id = idOf(value);
  return { id, path: socialPath("private", `feeds/${id}.json`), value, body };
}
