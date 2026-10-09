import { nowMicros } from "../clock.js";
import { limits } from "../data.js";
import { type Each, fail, member, throwing } from "../errors.js";
import { checkHashId, checkPublicKey, hashText } from "../ids.js";
import { type Extra, i64, inputOf, inputReads, list, object, omitted, option, string } from "../json/schema.js";
import { asciiFold, codePointLen, compareBytes, frozenTrim } from "../text.js";
import { socialPath } from "../path.js";
import { checkExtra, checkSafeInt, type Model, validate } from "./common.js";
import { checkLabel, foldLabel } from "./label.js";
import { feedLayout, type FeedLayout, feedLayouts, feedReach, type FeedReach, feedReaches, feedSort, type FeedSort, feedSorts, isKnown, known, postKind, type PostKind, postKinds } from "./kinds.js";

export interface FeedConfig extends Extra {
  /** The tag labels a post must carry: at most 5, folded, deduplicated and sorted by code point; null for no tag filter. */
  tags: string[] | null;
  /** The domain labels a post's links must carry, with the rules of `tags`; null for no domain filter. */
  domain_tags: string[] | null;
  /** Whose posts the feed shows, one of `feedReaches`. A name this version does not know is refused on read. */
  reach: FeedReach;
  /** How the client lays the feed out, one of `feedLayouts`. A name this version does not know is refused on read. */
  layout: FeedLayout;
  /** The order of the posts, one of `feedSorts`. A name this version does not know is refused on read. */
  sort: FeedSort;
  /** The one post kind shown, one of `postKinds`, or a newer writer's name kept as written; null for every kind. */
  content: PostKind | null;
}

export interface Feed extends Extra {
  /** The filter, which is the whole identity of the feed: its id hashes these members. */
  feed: FeedConfig;
  /** The display name, trimmed by the builder: 1 to 100 code points, not blank. Outside the id. */
  name: string;
  /** 1 to 50 of a-z, 0-9 and `-`: a name for the client's icon set, not an emoji. */
  icon: string | null;
  /** Microseconds since the epoch. */
  created_at: bigint;
}

function checkTagList(tags: string[] | null, field: string): void {
  if (tags === null) return;
  if (tags.length === 0) fail("blank", `Feed config ${field} cannot be an empty list, omit it for no filter`, field);
  if (tags.length > limits.feedTagsMaxCount) fail("count", `Feed config cannot have more than ${limits.feedTagsMaxCount} ${field}`, field, limits.feedTagsMaxCount);
  for (const tag of tags) {
    if (tag !== foldLabel(tag)) fail("format", `Tag '${tag}' must be stored folded (trimmed, ASCII lowercase)`, field);
    checkLabel(tag, field);
  }
  for (let i = 1; i < tags.length; i++) {
    if (compareBytes(tags[i - 1] as string, tags[i] as string) >= 0) {
      fail("format", `Feed config ${field} must be stored deduplicated and sorted by code point`, field);
    }
  }
}

function checkIcon(icon: string | null): void {
  if (icon === null) return;
  const length = codePointLen(icon);
  if (length < 1 || length > limits.feedIconMaxLength) fail("length", `Feed icon '${icon}' must be 1 to ${limits.feedIconMaxLength} characters`, "icon", limits.feedIconMaxLength);
  for (const c of icon) if (!/^[a-z0-9-]$/.test(c)) fail("format", `Feed icon '${icon}' contains invalid character: ${c}`, "icon");
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
  check(value, id, _publicRoot, each) {
    const f = value.feed;
    // reach, layout and sort define the feed; an unknown content filter only means no filter
    each(() => {
      if (!isKnown(feedReaches, f.reach)) fail("unknown_name", "feed reach is unknown", "reach");
    });
    each(() => {
      if (!isKnown(feedLayouts, f.layout)) fail("unknown_name", "feed layout is unknown", "layout");
    });
    each(() => {
      if (!isKnown(feedSorts, f.sort)) fail("unknown_name", "feed sort is unknown", "sort");
    });
    each(() => checkExtra(f.extra, "feed."));
    each(() => checkTagList(f.tags, "tags"));
    each(() => checkTagList(f.domain_tags, "domain_tags"));
    each(() => checkExtra(value.extra));
    each(() => {
      if (frozenTrim(value.name) === "") fail("blank", "Feed name cannot be empty", "name");
      if (codePointLen(value.name) > limits.feedNameMaxLength) fail("length", `Feed name exceeds maximum length of ${limits.feedNameMaxLength} characters`, "name", limits.feedNameMaxLength);
    });
    each(() => checkIcon(value.icon));
    each(() => checkSafeInt(value.created_at, "created_at"));
    if (id !== null)
      each(() => {
        checkHashId(id, "id");
        const expected = idOf(value);
        if (expected !== id) fail("id", `Invalid ID: expected ${expected}, found ${id}`, "id");
      });
  },
};

/** The id of a feed object, so an edited feed finds its new path with its unknown members kept. */
export function feedId(value: Feed): string {
  validate(feed, value, null, false);
  return idOf(value);
}

function filter(tags: string[] | null, field: string): string[] | null {
  if (tags === null) return null;
  if (tags.length === 0) fail("blank", `${field} must not be an empty list; leave it out for no filter`, field);
  if (tags.some((tag) => foldLabel(tag) === "")) fail("blank", `${field} must not contain a blank label`, field);
  return [...new Set(tags.map(foldLabel))].sort(compareBytes);
}

/** A feed at its private path. The builder folds and sorts the filter and trims the name. */
export function buildFeed(owner: string | null, input: unknown, each: Each = throwing) {
  if (owner !== null) checkPublicKey(owner);
  const { str, opt, items } = inputReads(each);
  const i = inputOf(input, "input", ["tags", "domain_tags", "reach", "layout", "sort", "content", "name", "icon"], each);
  const tag = (js: unknown, at: string) => string.parse(js, at);
  const givenTags = items(i.tags, "input.tags", tag);
  const givenDomainTags = items(i.domain_tags, "input.domain_tags", tag);
  const name = str(i.name, "input.name");
  const icon = str(i.icon, "input.icon");
  // Every member's shape before any name is judged: the reference reads the whole input first
  const contentName = opt(i.content, "input.content", "note");
  const reachName = str(i.reach, "input.reach", "all");
  const layoutName = str(i.layout, "input.layout", "columns");
  const sortName = str(i.sort, "input.sort", "recent");
  const content = contentName === null ? null : member<PostKind | null>(each, () => known(postKinds, "content kind", contentName, "content"), null);
  const reach = member<FeedReach>(each, () => known(feedReaches, "feed reach", reachName, "reach"), "all");
  const layout = member<FeedLayout>(each, () => known(feedLayouts, "feed layout", layoutName, "layout"), "columns");
  const sort = member<FeedSort>(each, () => known(feedSorts, "feed sort", sortName, "sort"), "recent");
  const tags = member(each, () => filter(givenTags, "tags"), null);
  const domainTags = member(each, () => filter(givenDomainTags, "domain_tags"), null);
  // The config is checked as the builder makes it, before the feed's own rules run it again:
  // the reference builds the config first, so its refusal is the first one
  each(() => checkTagList(tags, "tags"));
  each(() => checkTagList(domainTags, "domain_tags"));
  const value: Feed = {
    feed: { tags, domain_tags: domainTags, reach, layout, sort, content, extra: new Map() },
    name: frozenTrim(name),
    icon: asciiFold(frozenTrim(icon)),
    created_at: nowMicros(),
    extra: new Map(),
  };
  const body = validate(feed, value, null, false, each);
  const id = idOf(value);
  return { id, path: socialPath("private", `feeds/${id}.json`), value, body };
}
