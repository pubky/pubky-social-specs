import { nowMicros } from "../clock.js";
import { limits } from "../data.js";
import { fail } from "../errors.js";
import { checkHashId, checkPublicKey, hashText } from "../ids.js";
import { type Extra, i64, inputOf, list, object, omitted, option, string } from "../json/schema.js";
import { asciiFold, codePointLen, compareBytes, frozenTrim } from "../text.js";
import { socialPath } from "../uri.js";
import { checkExtra, checkSafeInt, type Model, validate } from "./common.js";
import { checkLabel, foldLabel } from "./label.js";
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
  /** 1 to 50 of a-z, 0-9 and `-`: a name for the client's icon set, not an emoji. */
  icon: string | null;
  /** Microseconds since the epoch. */
  created_at: bigint;
}

function checkTagList(tags: string[] | null, field: string): void {
  if (tags === null) return;
  if (tags.length === 0) fail(`Feed config ${field} cannot be an empty list, omit it for no filter`, field);
  if (tags.length > limits.feedTagsMaxCount) fail(`Feed config cannot have more than ${limits.feedTagsMaxCount} ${field}`, field);
  for (const tag of tags) {
    if (tag !== foldLabel(tag)) fail(`Tag '${tag}' must be stored folded (trimmed, ASCII lowercase)`, field);
    checkLabel(tag, field);
  }
  for (let i = 1; i < tags.length; i++) {
    if (compareBytes(tags[i - 1] as string, tags[i] as string) >= 0) {
      fail(`Feed config ${field} must be stored deduplicated and sorted by code point`, field);
    }
  }
}

function checkIcon(icon: string | null): void {
  if (icon === null) return;
  const length = codePointLen(icon);
  if (length < 1 || length > limits.feedIconMaxLength) fail(`Feed icon '${icon}' must be 1 to ${limits.feedIconMaxLength} characters`, "icon");
  for (const c of icon) if (!/^[a-z0-9-]$/.test(c)) fail(`Feed icon '${icon}' contains invalid character: ${c}`, "icon");
}

// The id is the filter alone, so name and icon change without moving the feed
function idOf(value: Feed): string {
  const f = value.feed;
  const joined = (tags: string[] | null) => tags?.join(",") ?? "";
  return hashText(`${f.reach}:${f.layout}:${f.sort}:${f.content ?? ""}:${joined(f.tags)}:${joined(f.domain_tags)}`);
}

const config = object<FeedConfig>("PubkySocialFeedConfig", {
  tags: option(list(string)),
  domain_tags: omitted(list(string)),
  reach: feedReach,
  layout: feedLayout,
  sort: feedSort,
  content: option(postKind),
});

export const feed: Model<Feed> = {
  codec: object<Feed>("PubkySocialFeed", { feed: config, name: string, icon: omitted(string), created_at: i64 }),
  maxBytes: limits.objectMaxBytes,
  check(value, id) {
    const f = value.feed;
    // reach, layout and sort define the feed; an unknown content filter only means no filter
    if (f.reach === "unknown") fail("feed reach is unknown", "reach");
    if (f.layout === "unknown") fail("feed layout is unknown", "layout");
    if (f.sort === "unknown") fail("feed sort is unknown", "sort");
    checkExtra(f.extra);
    checkTagList(f.tags, "tags");
    checkTagList(f.domain_tags, "domain_tags");
    checkExtra(value.extra);
    if (frozenTrim(value.name) === "") fail("Feed name cannot be empty", "name");
    if (codePointLen(value.name) > limits.feedNameMaxLength) fail(`Feed name exceeds maximum length of ${limits.feedNameMaxLength} characters`, "name");
    checkIcon(value.icon);
    checkSafeInt(value.created_at);
    if (id !== null) {
      checkHashId(id, "id");
      // A reader that does not know the content filter cannot rebuild the writer's id input
      if (f.content !== "unknown") {
        const expected = idOf(value);
        if (expected !== id) fail(`Invalid ID: expected ${expected}, found ${id}`, "id");
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

const tagList = option(list(string));

function filter(tags: string[] | null, field: string): string[] | null {
  if (tags === null) return null;
  if (tags.length === 0) fail(`${field} must not be an empty list; pass None for no filter`, field);
  if (tags.some((tag) => foldLabel(tag) === "")) fail(`${field} must not contain a blank label`, field);
  return [...new Set(tags.map(foldLabel))].sort(compareBytes);
}

/** A feed at its private path. The builder folds and sorts the filter and trims the name. */
export function buildFeed(owner: string, input: unknown) {
  checkPublicKey(owner);
  const i = inputOf(input, "input", ["tags", "domain_tags", "reach", "layout", "sort", "content", "name", "icon"]);
  const given = { tags: tagList.parse(i.tags, "input.tags"), domain: tagList.parse(i.domain_tags, "input.domain_tags") };
  const name = string.parse(i.name, "input.name");
  const icon = string.parse(i.icon, "input.icon");
  const content = i.content === null || i.content === undefined ? null : known(postKinds, "content kind", i.content, "content");
  const reach = known(feedReaches, "feed reach", i.reach, "reach");
  const layout = known(feedLayouts, "feed layout", i.layout, "layout");
  const sort = known(feedSorts, "feed sort", i.sort, "sort");
  const tags = filter(given.tags, "tags");
  const domainTags = filter(given.domain, "domain_tags");
  checkTagList(tags, "tags");
  checkTagList(domainTags, "domain_tags");
  const value: Feed = {
    feed: { tags, domain_tags: domainTags, reach, layout, sort, content, extra: new Map() },
    name: frozenTrim(name),
    icon: asciiFold(frozenTrim(icon)),
    created_at: nowMicros(),
    extra: new Map(),
  };
  const body = validate(feed, value, null, false);
  const id = idOf(value);
  return { id, path: socialPath("private", `feeds/${id}.json`), value, body };
}
