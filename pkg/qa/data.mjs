// Writes src/data.ts, and the migrator's src/data.ts, from the oracle: the limits, the MIME
// tables and the migration's skip reasons are the crate's, so each package carries them as
// generated source and never as a hand-typed copy.
//
//   node qa/data.mjs [--check]

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { flags } from "./lib.mjs";
import { ask } from "./oracle.mjs";

const args = flags({ check: { type: "boolean", default: false } });

const [{ ok: data }] = await ask([{ op: "data", now: 0, last: 0 }]);
// The same literal, frozen at every level: a caller cannot change a limit under the package
const frozen = (value, indent = "") => {
  if (Array.isArray(value)) return `/* @__PURE__ */ Object.freeze([${value.map((item) => frozen(item)).join(", ")}] as const)`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  const members = Object.entries(value).map(([key, member]) => `${indent}  ${key}: ${frozen(member, `${indent}  `)},`);
  return `Object.freeze({\n${members.join("\n")}\n${indent}})`;
};
// What each limit bounds; the unit comes from the name. A limit the crate adds without a line
// here fails the build, so every member a caller hovers says what it measures
const LIMIT_DOCS = {
  articleBodyMaxLength: "The longest article body",
  articleContentMaxLength: "The longest `content` of an article post, the whole envelope as text",
  articleTitleMaxLength: "The longest article title",
  attachmentAltMaxLength: "The longest `alt` text of an attachment",
  attachmentNameMaxLength: "The longest `name` of an attachment",
  bookmarkTargetUriMaxBytes: "The longest target a primary bookmark spells in its filename; a longer one takes the overflow form, `~{hash}`",
  collectionContentMaxLength: "The longest `content` of a collection post, the whole envelope as text",
  collectionDescriptionMaxLength: "The longest collection description",
  collectionItemNoteMaxLength: "The longest note on a collection item",
  collectionItemsMaxCount: "The most items in a collection",
  collectionNameMaxLength: "The longest collection name",
  collectionNameMinLength: "The shortest collection name",
  feedIconMaxLength: "The longest feed icon name",
  feedNameMaxLength: "The longest feed name",
  feedTagsMaxCount: "The most labels in a feed's `tags`, and in its `domain_tags`",
  imageUrlMaxLength: "The longest profile `image` and article or collection `cover_image`",
  maxFileSizeBytes: "The largest media file, 100 MiB",
  objectMaxBytes: "The largest stored object other than a post, as stored",
  postAllowedAttachmentProtocols: "The schemes an attachment URI may have",
  postAttachmentsMaxCount: "The most attachments on a post",
  postMaxBytes: "The largest stored post, as stored",
  postNoteContentMaxLength: "The longest `content` of a post of any kind but an article or a collection",
  postSlugMaxLength: "The longest slug of a post version",
  referenceUriMaxLength: "The longest reference: a `parent`, an `embed`, a `lock`, an attachment or a collection item",
  tagInvalidChars: "The characters a tag label may not hold",
  tagLabelMaxLength: "The longest tag label",
  tagLabelMinLength: "The shortest tag label",
  userBioMaxLength: "The longest profile bio",
  userLinkTitleMaxLength: "The longest title of a profile link",
  userLinkUrlMaxLength: "The longest URL of a profile link",
  userLinksMaxCount: "The most links on a profile",
  userNameMaxLength: "The longest profile name",
  userNameMinLength: "The shortest profile name",
  userStatusMaxLength: "The longest profile status",
  eventTitleMaxLength: "The longest event title",
  eventDescriptionMaxLength: "The longest event description",
  eventContentMaxLength: "The longest `content` of an event post, the whole envelope as text",
  eventTimeZoneMaxLength: "The longest IANA time zone name, an event's or an availability's `timeZone`",
  eventDurationMaxSeconds: "The longest `duration` of an event or an availability block, one leap year",
  eventLocationsMaxCount: "The most `locations` on an event",
  eventLocationNameMaxLength: "The longest `name` of an event location",
  eventLinksMaxCount: "The most `links` on an event",
  eventLinkTitleMaxLength: "The longest `title` of an event link",
  eventLinkUrlMaxLength: "The longest `url` of an event link",
  eventCapacityMaxPeople: "The largest `attendance.capacity` of an event",
  eventRecurrenceRulesMaxCount: "The most `recurrenceRules` on an event or an availability block",
  eventRecurrenceMaxOccurrences: "The largest `count` of a recurrence rule, where the occurrence generator stops too",
  eventRecurrenceMaxSpanYears: "The furthest a recurrence rule's `until` may lie after the start, where the occurrence generator stops too",
  eventRecurrenceIntervalMaxPeriods: "The largest `interval` of a recurrence rule",
  eventRecurrenceByMaxCount: "The most entries in each `by*` list of a recurrence rule",
  eventExcludedDatesMaxCount: "The most `excludedDates` on an event or an availability block",
  rsvpGuestsMaxPeople: "The most `guests` on an rsvp",
  rsvpNoteMaxLength: "The longest `note` of an rsvp",
  rsvpContentMaxLength: "The longest `content` of an rsvp post, the whole envelope as text",
  availabilityHorizonMaxDays: "The furthest ahead an availability's `horizonDays` reaches, one leap year",
  availabilityBlocksMaxCount: "The most blocks in each of an availability's `available` and `busy`",
  availabilityBlockTitleMaxLength: "The longest `title` of an available block",
  availabilityCapacityMaxUnits: "The largest `capacity` of an available block, the units free in it",
  availabilityContentMaxLength: "The longest `content` of an availability post, the whole envelope as text",
  ratingMinHalfStars: "The lowest `rating`, one half star",
  ratingMaxHalfStars: "The highest `rating`, five stars",
  ratingTextMaxLength: "The longest `text` of a rating",
  ratingContentMaxLength: "The longest `content` of a rating post, the whole envelope as text",
  geoFractionMaxDigits: "The most fraction digits of a `geo:` coordinate, about a metre",
};
// The unit a limit's name ends in
const UNITS = {
  Bytes: "bytes",
  Count: "items",
  Length: "code points",
  Seconds: "seconds",
  Days: "days",
  Years: "years",
  People: "people",
  Units: "units",
  Occurrences: "occurrences",
  Periods: "periods",
  Digits: "digits",
  HalfStars: "half stars",
};
const unitOf = (name) => Object.entries(UNITS).find(([suffix]) => name.endsWith(suffix))?.[1] ?? null;
const undocumented = Object.keys(data.limits).filter((name) => !Object.hasOwn(LIMIT_DOCS, name));
if (undocumented.length > 0) {
  console.error(`limits with no line in qa/data.mjs LIMIT_DOCS: ${undocumented.join(", ")}`);
  process.exit(1);
}
const limitsSource = `Object.freeze({\n${Object.entries(data.limits)
  .map(([name, value]) => {
    const unit = unitOf(name);
    return `  /** ${LIMIT_DOCS[name]}${unit === null ? "." : `, in ${unit}: ${value}.`} */\n  ${name}: ${frozen(value, "  ")},`;
  })
  .join("\n")}\n})`;

const source = `// Generated by qa/data.mjs from the crate's constants. Do not edit.

/**
 * The data model's limits, in the units their names say: code points for a \`Length\`, bytes for
 * \`Bytes\`, items for a \`Count\`. A builder, a validator and \`decodeObject\` refuse past them
 * with a \`ValidationError\` whose \`code\` is \`length\`, \`size\` or \`count\` and whose \`limit\`
 * is the value here.
 *
 * @example
 * \`\`\`ts
 * import { limits } from "pubky-social-specs";
 * console.log(limits.postNoteContentMaxLength, limits.maxFileSizeBytes);
 * \`\`\`
 */
export const limits = /* @__PURE__ */ ${limitsSource};

export const MIME_TO_EXT = ${frozen(data.mimeToExt)};

/**
 * The media types the data model names. Most map to an extension; \`application/octet-stream\`,
 * \`application/x-www-form-urlencoded\` and \`multipart/form-data\` map to \`.bin\`, as does any
 * type not listed. The table is in docs/reference.md.
 *
 * @example
 * \`\`\`ts
 * import { validMimeTypes } from "pubky-social-specs";
 * console.log(validMimeTypes.includes("image/png"));
 * \`\`\`
 */
export const validMimeTypes = ${frozen(data.validMimeTypes)};

/**
 * The code points the reference spells as \\u{..} when an error quotes text, as inclusive
 * ranges laid end to end. It follows the Unicode tables the reference was built with.
 */
export const DEBUG_ESCAPED: readonly number[] = [${data.debugEscaped.flat().join(",")}];
`;
// The extensions a media file name may carry are the mapped ones and the fallback; the package
// derives them, so a reference that ever stripped another one has to be met here first
const derived = [...new Set([...data.mimeToExt.map(([, ext]) => ext), "bin"])].sort();
if (JSON.stringify(derived) !== JSON.stringify([...data.stripSet].sort())) {
  console.error(`the reference strips ${data.stripSet.join(", ")}, not the mapped extensions and bin`);
  process.exit(1);
}
const migration = `// Generated by pkg/qa/data.mjs from the crate's constants. Do not edit.

/**
 * Why the migration leaves a 0.x object behind: the keys of a report's \`skipped\`.
 *
 * @example
 * \`\`\`ts
 * import { skipReasons } from "pubky-social-migrator";
 * console.log(skipReasons.join(", "));
 * \`\`\`
 */
export const skipReasons = ${frozen(data.skipReasons)};

/**
 * The revision of the migration's transforms: a flag recorded under a lower one is walked again.
 *
 * @example
 * \`\`\`ts
 * import { transformRev } from "pubky-social-migrator";
 * console.log(transformRev);
 * \`\`\`
 */
export const transformRev: number = ${data.transformRev};
`;
let stale = false;
// The debug escape table follows the Unicode tables of the rustc that built the oracle
const withoutEscapes = (text) => text.replace(/^export const DEBUG_ESCAPED: .*$/m, "");
for (const [path, text] of [
  ["../src/data.ts", source],
  ["../../migrator/src/data.ts", migration],
]) {
  const file = fileURLToPath(new URL(path, import.meta.url));
  if (!args.check) fs.writeFileSync(file, text);
  else if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== text) {
    const escapesOnly = fs.existsSync(file) && withoutEscapes(fs.readFileSync(file, "utf8")) === withoutEscapes(text);
    console.error(
      escapesOnly
        ? `${path.slice(3)} differs from this oracle in DEBUG_ESCAPED alone: build the oracle with the pinned Rust (RUST_TOOLCHAIN in .github/workflows/js-native.yml) and check again`
        : `${path.slice(3)} is stale: run node pkg/qa/data.mjs`,
    );
    stale = true;
  }
}
if (stale) process.exit(1);
