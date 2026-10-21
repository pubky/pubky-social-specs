// Seeded requests per family. A case is its family, its seed and its index, so a mismatch is
// replayed from three numbers.

import { hashId, hashText as hashOfText } from "../dist/ids.js";
import { limits } from "../dist/data.js";
import { NOW_MS, OTHER, OWNER, timestampIdOf } from "./lib.mjs";

// The ids of generated content come from the package's own encoders: a wrong one there makes
// the oracle refuse where the package accepts, which the scoreboard counts like any mismatch
const hashOfTag = (uri, label) => hashOfText(`${uri}:${label}`);

export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = {
    below: (n) => Math.floor(next() * n),
    chance: (p) => next() < p,
    pick: (items) => items[r.below(items.length)],
    many: (max, make) => Array.from({ length: r.below(max + 1) }, make),
  };
  return r;
}

// The oracle's clock is in microseconds
const NOW = NOW_MS * 1000;

// Where the engine and the reference could part: the frozen whitespace set and its
// neighbours, case pairs outside ASCII, controls, an astral character, a combining mark
const ODD = [
  "\t",
  "\n",
  "\u000b",
  "\u000c",
  "\r",
  " ",
  "\u0085",
  " ",
  " ",
  " ",
  " ",
  "​",
  " ",
  " ",
  " ",
  " ",
  "　",
  "﻿",
  "\u001f",
  "\u007f",
  "\u0000",
  "İ",
  "ß",
  "K",
  "é",
  "é",
  "😀",
  "𐐀",
  "Ａ",
  "%",
  "/",
  "?",
  "#",
  ":",
  "@",
  "\\",
  ".",
  "..",
  "-",
  "_",
  "~",
  '"',
  "{",
  "}",
  "[",
  ",",
];
const PLAIN = "abcxyzABCXYZ0189";

function str(r, max = 12) {
  return r.many(max, () => (r.chance(0.35) ? r.pick(ODD) : r.pick([...PLAIN]))).join("");
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ZBASE32 = "ybndrfg8ejkmcpqxot1uwisza345h769";

/** `length` characters of `alphabet`, sometimes broken the way a real one breaks. */
function spelled(r, alphabet, length) {
  let id = Array.from({ length }, () => r.pick([...alphabet])).join("");
  if (r.chance(0.25)) id = id.slice(0, -1) + r.pick([...alphabet]);
  if (r.chance(0.08)) id = id.slice(r.below(2), id.length - r.below(2));
  if (r.chance(0.08)) id = id.slice(0, r.below(id.length)) + r.pick(["O", "o", "I", "l", "é", "u", "L", " "]) + id.slice(r.below(id.length));
  if (r.chance(0.05)) id = id.toLowerCase();
  return id;
}

const hashIdText = (r) => Array.from({ length: 25 }, () => r.pick([...CROCKFORD])).join("") + r.pick([..."048CGMRW"]);
const base64url = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const EXTENSIONS = ["png", "jpg", "bin", "json", "JPG", "exe", "tar.gz", ""];

/** An owner-relative path: mostly one the parser names, sometimes one it almost does. */
function path(r) {
  const id = timestampIdOf(NOW - r.below(1e12));
  const root = r.pick(["pub", "pub", "priv", "priv", "public", ""]);
  const namespace = r.pick(["social", "social", "social", "pubky.app", "pubky.app", "other.app", "Social"]);
  const epoch = namespace === "pubky.app" ? null : r.pick(["v1", "v1", "v1", "v2", "v01", "V1", "v", "x"]);
  const leaf = r.pick([
    () => "profile.json",
    () => `posts/${id}`,
    () => `posts/${id}/${timestampIdOf(NOW)}${r.pick(["", "-a-slug", "-", "-UP", "-" + "s".repeat(64), "-" + "s".repeat(65)])}${r.pick([".json", ".json", ""])}`,
    () => `files/${hashIdText(r)}${r.pick(["", "."])}${r.pick(EXTENSIONS)}`,
    () => `blobs/${hashIdText(r)}`,
    () => `${r.pick(["feeds", "tags", "bookmarks"])}/${r.pick([hashIdText(r), "~" + hashIdText(r), spelled(r, base64url, r.below(12)), "_x"])}${r.pick([".json", ".json", ""])}`,
    () => `${r.pick(["follows", "mutes"])}/${r.pick([OWNER, OTHER, spelled(r, ZBASE32, 52)])}${r.pick([".json", ".json", ""])}`,
    () => r.pick(["last_read", "settings", "last_read.json", "settings/x.json", "profile.json/x", ""]),
    () => r.many(4, () => str(r, 4)).join("/"),
  ])();
  let out = [root, namespace, epoch, leaf].filter((part) => part !== null).join("/");
  if (r.chance(0.12)) {
    // By code point: a cut inside a surrogate pair is text the reference cannot hold
    const points = [...out];
    out = points.slice(0, r.below(points.length + 1)).join("") + r.pick(ODD) + points.slice(r.below(points.length + 1)).join("");
  }
  if (r.chance(0.06)) out = out.replace("/", "//");
  if (r.chance(0.06)) out += "/";
  // A segment the pubky form refuses as written, where it is the first bad one
  if (r.chance(0.04)) out = out.replace(/\/[^/]*$/, `/${r.pick(["..", ".", "%2e", "a?b", "a#b"])}$&`);
  return out;
}

/** Containers nested around the recursion limit: arrays, objects, or both in turn. */
function nested(r) {
  const n = r.pick([126, 127, 128, 129]);
  const shape = r.pick(["array", "object", "mixed"]);
  const arrays = Array.from({ length: n }, (_, i) => shape === "array" || (shape === "mixed" && i % 2 === 0));
  const opens = arrays.map((array) => (array ? "[" : '{"a":')).join("");
  // Sometimes one closer short, which the parser meets only after the depth
  const closes = arrays
    .map((array) => (array ? "]" : "}"))
    .reverse()
    .slice(r.chance(0.2) ? 1 : 0)
    .join("");
  return opens + "1" + closes;
}

/** Stored text as bytes with an invalid UTF-8 sequence inside a string, which only the byte channel can carry. */
function notUtf8(r, text) {
  const bytes = Buffer.from(text, "utf8");
  const quote = bytes.indexOf(0x22, r.below(bytes.length));
  const at = quote < 0 ? bytes.length : quote + 1;
  const bad = Buffer.from(r.pick([[0xff], [0xc3], [0xed, 0xa0, 0x80], [0xf8, 0x88, 0x80, 0x80, 0x80], [0xc0, 0xaf]]));
  return { b: Buffer.concat([bytes.subarray(0, at), bad, bytes.subarray(at)]).toString("base64") };
}

/** A reference as a user could store one: pubky in both forms, web, any other scheme, or noise; `arm` picks one. */
function uri(r, arm = r.below(4)) {
  const host = r.pick([OWNER, OWNER, OTHER, spelled(r, ZBASE32, 52), `u:p@${OWNER}`, `${OWNER}:80`, OWNER.toUpperCase()]);
  let out = [
    () => `${r.pick(["pubky://", "pubky://", "pubky://", "pubky", "PUBKY://", "pubky:", "pubky:/", "Pubky://"])}${host}${r.pick(["/", "/", "/", ""])}${r.chance(0.9) ? path(r) : ""}`,
    () =>
      `${r.pick(["http://", "https://", "HTTP://", "https:/", "http://?", "https://#"])}${r.pick(["example.com", "é.example", "a b", "", ":", ":443", "u@", "u:p@:80", "u@Example.COM", "[::1]:8080", "example.com:8080", "u@v@example.com"])}${r.pick(["", "/", "/p?q=1#f", "/" + str(r, 6)])}`,
    () => `${r.pick(["nostr", "geo", "IPFS", "did", "magnet", "pubkyx", "http", "1a", "a+b.c-d", "é", ""])}:${str(r, 8)}`,
    () => str(r, 20),
  ][arm]();
  if (r.chance(0.1)) out = r.pick([" ", "\t", "\u00a0", "\u200b", "\n"]) + out;
  if (r.chance(0.1)) out += r.pick([" ", "\u3000", "\ufeff", "\r"]);
  if (r.chance(0.03)) out += "x".repeat(r.pick([900, 1000, 1100]));
  // The short pubky form at the cap, which it passes only before it is spelled in full
  if (r.chance(0.02)) out = `pubky${OWNER}/${"x".repeat(r.pick([963, 964, 965, 966]))}`;
  return out;
}

const NUMBERS = [
  "0",
  "-0",
  "1",
  "-1",
  "9007199254740991",
  "9007199254740992",
  "-9007199254740993",
  "18446744073709551615",
  "18446744073709551616",
  "-9223372036854775808",
  "-9223372036854775809",
  "123456789012345678901234567890",
  "1.0",
  "2.50",
  "0.1",
  "1e30",
  "1E+30",
  "1e-7",
  "1e16",
  "1e15",
  "123456789012345680000",
  "0.000001",
  "0.00001234",
  "1.7976931348623157e308",
  "1e309",
  "5e-324",
  "2.5e-324",
  "1e-400",
  "0e999999999999",
  "1e999999999999",
  "0.30000000000000004",
  "9007199254740993.0",
  "4.35",
  "1.2345678901234567890123",
  "123456789.123456789e-5",
  "01",
  "-",
  "1.",
  ".5",
  "1e",
  "1e+",
  "+1",
  "0x10",
  "1.e3",
  "--1",
  "1.0e-0",
];
const digits = (r, max) => r.many(max, () => r.below(10)).join("");

function number(r) {
  if (r.chance(0.45)) return r.pick(NUMBERS);
  const integer = r.chance(0.5) ? String(r.below(1000)) : r.below(9) + 1 + digits(r, 24);
  return `${r.pick(["", "", "-"])}${integer}${r.chance(0.5) ? "." + digits(r, 22) + r.below(10) : ""}${r.chance(0.4) ? r.pick(["e", "E"]) + r.pick(["", "+", "-"]) + r.below(r.pick([5, 30, 330])) : ""}`;
}

const ESCAPES = [
  "\\n",
  '\\"',
  "\\\\",
  "\\/",
  "\\u0041",
  "\\u00e9",
  "\\ud83d\\ude00",
  "\\ud83d",
  "\\ude00",
  "\\ud83d\\u0041",
  "\\ud83dx",
  "\\ud83d\\n",
  "\\u12",
  "\\u12g4",
  "\\x",
  "\\u0000",
  "\\u001f",
  "\\uD83D\\uDE00",
  "\\b\\f\\r\\t",
];

function jsonString(r) {
  const inner = r.many(6, () => (r.chance(0.3) ? r.pick(ESCAPES) : r.chance(0.2) ? r.pick(["\t", "\n", "\u007f", "é", "😀", "\u2028", "\ue000", "\uffff", "__proto__"]) : r.pick([...PLAIN])));
  return `"${inner.join("")}"`;
}

/** JSON text: mostly well formed, with the numbers, keys and escapes two parsers read apart. */
function json(r, depth = 3) {
  const kind = r.below(depth > 0 ? 10 : 6);
  let out;
  if (kind < 2) out = number(r);
  else if (kind < 4) out = jsonString(r);
  else if (kind < 6) out = r.pick(["null", "true", "false", "nul", "tru", "falsy", "", "undefined", "NaN"]);
  else if (kind < 8) out = `[${r.many(4, () => json(r, depth - 1)).join(r.chance(0.93) ? "," : r.pick([" , ", ",,", " ", ";"]))}${r.chance(0.04) ? "," : ""}]`;
  else {
    const key = () => (r.chance(0.9) ? r.pick([jsonString(r), '"a"', '"b"', '"é"', '"\ue000"', '"😀"', '"__proto__"', '"10"', '"9"']) : r.pick(["a", "1", "null", ""]));
    out = `{${r.many(4, () => `${key()}${r.chance(0.95) ? ":" : r.pick(["", "=", "::"])}${json(r, depth - 1)}`).join(r.chance(0.93) ? "," : r.pick([";", " ", ",,"]))}${r.chance(0.04) ? "," : ""}}`;
  }
  if (r.chance(0.03)) out = [...out].slice(0, r.below(out.length + 1)).join("");
  if (r.chance(0.05)) out = r.pick([" ", "\n", "\t\r", "\ufeff", "\u00a0", "\u000c"]) + out;
  if (r.chance(0.05)) out += r.pick([" ", "\n", "x", ",", "]", "}", "1"]);
  return out;
}

const WRONG = ["null", "1", "1.5", "-0", "true", '"x"', "[]", "{}", '["a","b"]', '{"a":1}', "18446744073709551616", "1e400", "nul"];

/**
 * The JSON text of `object`, mostly as it is and sometimes broken one way: a member missing,
 * unknown, doubled or of another type, the array form, a cut.
 */
function spoil(r, object) {
  const entries = Object.entries(object).map(([key, value]) => [key, JSON.stringify(value)]);
  const roll = r.below(100);
  if (roll < 6 && entries.length) entries.splice(r.below(entries.length), 1);
  else if (roll < 12) entries.splice(r.below(entries.length + 1), 0, [r.pick(["zzz", "extra", "é", "__proto__", "😀", "\ue000", "10", "created_at", "kind"]), r.pick([...WRONG, json(r, 2)])]);
  else if (roll < 20 && entries.length) entries[r.below(entries.length)][1] = r.pick(WRONG);
  else if (roll < 24 && entries.length) entries.push([...r.pick(entries)]);
  else if (roll < 26)
    return `[${entries
      .map(([, value]) => value)
      .slice(0, r.below(entries.length + 2))
      .join(",")}${r.pick(["", "", ",1", ","])}]`;
  else if (roll < 28) return r.pick(WRONG);
  let text = `{${entries.map(([key, value]) => `${JSON.stringify(key)}:${value}`).join(",")}}`;
  if (roll >= 28 && roll < 30) text = [...text].slice(0, r.below(text.length)).join("");
  if (roll >= 30 && roll < 32) text += r.pick([" ", ",", "x", "{}"]);
  return text;
}

const words = (r, max) => r.many(max, () => r.pick(["Ann", "bob", " ", "\u00a0", "\u3000", "\u200b", "é", "😀", "x".repeat(r.below(60)), "\t", "\n", "\u0000", "A"])).join("");
const text = (r, max = 6) => words(r, max);

/** A reference for a field: the right tier most of the time. */
function ref(r) {
  return r.pick([
    () =>
      `pubky://${r.pick([OWNER, OTHER])}/${r.pick(["pub", "pub", "priv"])}/social/v1/${r.pick([`posts/${timestampIdOf(NOW - 5e9)}`, `posts/${timestampIdOf(NOW - 5e9)}/${timestampIdOf(NOW - 4e9)}.json`, `files/${hashIdText(r)}.png`, "profile.json"])}`,
    () => `pubky://${OTHER}`,
    () => `pubky${OTHER}/pub/social/v1/profile.json`,
    () => `https://example.com/${r.pick(["", "a.png", "x".repeat(r.pick([10, 280, 300, 1100]))])}`,
    () => r.pick(["nostr:note1abc", "geo:1,2", "IPFS:Qm", " https://example.com", "https://example.com ", "http://", "x"]),
    () => uri(r),
  ])();
}

function userInput(r) {
  const o = { name: r.pick(["Ann", " Ann ", "ab", "x".repeat(r.pick([3, 50, 51])), text(r), "😀😀😀"]) };
  if (r.chance(0.6)) o.bio = r.pick([null, "bio", "  ", " padded ", "b".repeat(r.pick([160, 161])), text(r)]);
  if (r.chance(0.5)) o.image = r.pick([null, ref(r)]);
  if (r.chance(0.6)) o.links = r.pick([null, r.many(6, () => ({ title: r.pick(["Site", " ", " t ", "t".repeat(r.pick([100, 101])), text(r)]), url: ref(r) }))]);
  if (r.chance(0.5)) o.status = r.pick([null, "ok", " ", "s".repeat(r.pick([50, 51])), text(r)]);
  return o;
}

// A spoiled member that is still JSON, so it can sit inside a larger object
function spoilSafe(r, object) {
  for (;;) {
    const candidate = spoil(r, object);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {}
  }
}

const EXTRA = [
  '"x":1',
  '"x":9007199254740992',
  '"x":-9007199254740992',
  '"x":1.0',
  '"x":{"b":[1,{"a":18446744073709551615}],"a":1e30}',
  '"é":"é","\ue000":1,"😀":2',
  '"__proto__":{"a":1}',
  '"x":null,"x":2',
  '"n":123456789012345678901234567890',
];

/** A stored object: `object` spoiled, sometimes carrying members no version knows. */
function stored(r, object, max = limits.objectMaxBytes) {
  let out = spoil(r, object);
  if (!out.endsWith("}") || out.length <= 2) return out;
  if (r.chance(0.3)) return `${out.slice(0, -1)},${r.pick(EXTRA)}}`;
  // No field reaches the byte cap, so a padding member lands on either side of it
  if (r.chance(0.02)) return `${out.slice(0, -1)},"pad":"${"p".repeat(Math.max(0, max + r.pick([-1, 0, 1]) - Buffer.byteLength(out) - 9))}"}`;
  return out;
}

const LINK_EXTRA = [{ rel: "me" }, { n: { toJSON: undefined, raw: "9007199254740992" } }, { é: "é", a: [1, { b: null }] }];

const storedUser = (r) => {
  const o = userInput(r);
  const links = Array.isArray(o.links) ? o.links.map((link) => (r.chance(0.2) ? { ...link, ...r.pick(LINK_EXTRA) } : link)) : (o.links ?? null);
  return { name: o.name, bio: o.bio ?? null, image: o.image ?? null, links, status: o.status ?? null };
};

const key = (r) => r.pick([OWNER, OTHER, OTHER, spelled(r, ZBASE32, 52)]);
const stamp = (r) => r.pick([NOW, NOW, NOW, NOW, NOW, NOW, NOW, NOW, 0, -1, 9007199254740991, "9007199254740992", "-9007199254740992", 1.5, "x", null]);
const raw = (value) => (typeof value === "string" && /^-?[0-9]+$/.test(value) ? { toJSON: undefined, raw: value } : value);
// A number too large for a double has to be spelled into the text by hand
const withRaw = (text) => text.replace(/\{"raw":"(-?[0-9]+)"\}/g, "$1");
const longRef = (r) => `https://example.com/${"p".repeat(r.pick([150, 167, 168, 169, 400]))}`;
const b64url = (text) => Buffer.from(text).toString("base64url");
const tagUri = (r) => r.pick([ref(r), ref(r), `pubky://${OTHER}/pub/social/v1/posts/${timestampIdOf(NOW - 5e9)}`]);
const label = (r) => r.pick(["rust", "Rust", " rust ", "a,b", "a:b", "a b", "", "x".repeat(r.pick([20, 21])), "é", "😀", "RÉSUMÉ", "a\u00a0b", "a\u200bb", "a\tb", "a\nb", "a\rb"]);

const tagList = (r) =>
  r.pick([null, [], ["rust"], ["b", "a"], ["Rust", "rust", " go "], ["a", "b", "c", "d", "e", "f"], [" "], ["a,b"], ["é", "\ue000", "😀"], ["x".repeat(r.pick([20, 21]))], r.many(4, () => label(r))]);
const feedInput = (r) => {
  const o = {
    reach: r.pick(["all", "all", "following", "followers", "friends", "wot", "me", "galaxy", "unknown"]),
    layout: r.pick(["columns", "columns", "wide", "list", "visual", "cards", "grid"]),
    sort: r.pick(["recent", "recent", "recent", "popularity", "random"]),
    name: r.pick(["Feed", "Feed", "Feed", " Feed ", " ", "n".repeat(r.pick([100, 101])), text(r)]),
    icon: r.pick(["star", "star", "star", " Star ", "a-b-1", "", "i".repeat(r.pick([50, 51])), "st@r", "é", "A"]),
  };
  if (r.chance(0.5)) o.tags = tagList(r);
  if (r.chance(0.3)) o.domain_tags = tagList(r);
  if (r.chance(0.4)) o.content = r.pick([null, "note", "article", "collection", "short", "unknown"]);
  return o;
};
const feedIdText = (f) => {
  try {
    return feedIdOfText(f);
  } catch {
    return "0".repeat(26);
  }
};
const feedIdOfText = (f) => hashOfText(`${f.feed.reach}:${f.feed.layout}:${f.feed.sort}:${f.feed.content ?? ""}:${(f.feed.tags ?? []).join(",")}:${(f.feed.domain_tags ?? []).join(",")}`);
const storedFeed = (r) => {
  const i = feedInput(r);
  const sorted = (tags) => (tags && r.chance(0.8) ? [...new Set(tags.map((t) => t.trim().toLowerCase()))].sort() : tags);
  const f = { feed: { tags: sorted(i.tags ?? null), reach: i.reach, layout: i.layout, sort: i.sort, content: i.content ?? null }, name: i.name, created_at: raw(stamp(r)) };
  if (i.domain_tags !== undefined) f.feed.domain_tags = sorted(i.domain_tags);
  if (r.chance(0.8)) f.icon = i.icon;
  if (r.chance(0.2)) f.feed = JSON.parse(spoilSafe(r, f.feed));
  return f;
};

const postId = (r) => timestampIdOf(NOW - r.pick([5e9, 5e9, 5e9, 1e3, 0, -1e9, -7.3e9, 1e17]));
const attachmentOf = (r) => {
  const a = { uri: r.pick([ref(r), `pubky://${OWNER}/${r.pick(["pub", "priv"])}/social/v1/files/${hashIdText(r)}.png`]) };
  if (r.chance(0.3)) a.alt = r.pick(["alt", "", "a".repeat(r.pick([1000, 1001])), null]);
  if (r.chance(0.3)) a.name = r.pick(["pic.png", " pic ", " ", "n".repeat(r.pick([255, 256])), null]);
  return a;
};
const articleEnvelope = (r) => {
  const e = { title: r.pick(["Title", " Title ", " ", "t".repeat(r.pick([100, 101])), "a\u0000b", text(r)]), body: r.pick(["Body", "", "line\nline\ttab", "b\u0001", text(r, 12)]) };
  if (r.chance(0.4)) e.cover_image = r.pick([ref(r), null]);
  return e;
};
const collectionEnvelope = (r) => {
  const e = { name: r.pick(["List", " List ", " ", "", "n".repeat(r.pick([100, 101])), text(r)]) };
  if (r.chance(0.4)) e.description = r.pick(["about", " ", "d".repeat(r.pick([500, 501])), null]);
  if (r.chance(0.8)) e.items = r.many(r.pick([3, 3, 3, 101]), () => (r.chance(0.7) ? { uri: ref(r) } : { uri: ref(r), note: r.pick(["note", " ", "n".repeat(r.pick([1000, 1001])), null]) }));
  if (r.chance(0.3)) e.cover_image = r.pick([ref(r), null]);
  if (r.chance(0.3)) e.layout = r.pick(["grid", "list", "visual", "mosaic", null]);
  return e;
};
const PLACE = (r) =>
  r.pick([
    "geo:46.00547,8.95186",
    "geo:46,8",
    "geo:46.0,8",
    "geo:-0,8",
    "geo:91,8",
    "geo:46,8;u=35",
    "https://www.openstreetmap.org/way/481516234",
    "https://www.openstreetmap.org/node/1",
    "https://www.openstreetmap.org/way/481516234/",
    "https://openstreetmap.org/way/1",
    "https://osm.org/node/1",
    "https://www.openstreetmap.org/?mlat=46&mlon=8",
    "https://meet.jit.si/room",
    ref(r),
  ]);
const LOCAL = (r) =>
  r.pick([
    "2026-10-14T18:30:00",
    "2026-10-14T18:30:00",
    "2026-02-29T00:00:00",
    "2024-02-29T23:59:59",
    "2026-10-14T24:00:00",
    "2026-10-14T18:30:00Z",
    "2026-10-14",
    "soon",
    "2026-13-01T00:00:00",
    text(r, 2),
  ]);
const DURATION = (r) => r.pick(["PT2H30M", "PT2H30M", "P1D", "P2W", "PT0S", "P1DT1H1M1S", "PT90M", "P366D", "P367D", "P1W1D", "PT", "PT1.5S", "2h", "P1Y", "-PT1H", "PT1000000000S"]);
const ZONE = (r) =>
  r.pick(["Europe/Zurich", "Europe/Zurich", "UTC", "Etc/GMT+2", "America/Argentina/Buenos_Aires", "+02:00", "Europe/", "Europe/Zürich", "Zurich time", "", "a".repeat(r.pick([64, 65]))]);
const rule = (r) => {
  const o = { frequency: r.pick(["weekly", "monthly", "daily", "yearly", "hourly", "Weekly"]) };
  if (r.chance(0.3)) o.interval = r.pick([1, 2, 1000, 1001, 0, -1]);
  if (r.chance(0.2)) o.firstDayOfWeek = r.pick(["mo", "su", "monday"]);
  if (r.chance(0.4))
    o.byDay = r.many(r.pick([2, 2, 32]), () => (r.chance(0.6) ? { day: r.pick(["mo", "tu", "we", "th", "fr", "sa", "su", "Mo", "x"]) } : { day: "tu", nthOfPeriod: r.pick([2, -1, 53, 54, 0, -53]) }));
  if (r.chance(0.2)) o.byMonthDay = r.many(3, () => r.pick([14, -1, 31, 32, 0]));
  if (r.chance(0.2)) o.byMonth = r.many(3, () => r.pick(["10", "1", "12", "13", "01", "0", "1L"]));
  if (r.chance(0.15)) o.bySetPosition = r.many(3, () => r.pick([1, -1, 366, 367, 0]));
  if (r.chance(0.3)) o.count = r.pick([1, 52, 1000, 1001, 0]);
  if (r.chance(0.3)) o.until = r.pick(["2029-10-14T18:30:00", "2029-10-14T18:30:01", "2026-10-14T18:30:00", "2026-01-01T00:00:00", "tomorrow"]);
  return o;
};
const eventEnvelope = (r) => {
  const e = { title: r.pick(["Evening", " Evening ", " ", "t".repeat(r.pick([100, 101])), "a\u0000b", text(r)]), start: LOCAL(r), timeZone: ZONE(r) };
  if (r.chance(0.85)) e.duration = DURATION(r);
  if (r.chance(0.3)) e.showWithoutTime = r.chance(0.8);
  if (r.chance(0.4)) e.description = r.pick(["Monthly meetup.", " ", "", "d".repeat(r.pick([50000, 50001])), text(r, 12)]);
  if (r.chance(0.3)) e.status = r.pick(["confirmed", "tentative", "cancelled", "maybe"]);
  if (r.chance(0.5)) e.locations = r.many(r.pick([2, 2, 11]), () => (r.chance(0.6) ? { uri: PLACE(r) } : { uri: PLACE(r), name: r.pick(["Hub", " Hub ", " ", "n".repeat(r.pick([100, 101])), null]) }));
  if (r.chance(0.4)) {
    const a = { policy: r.pick(["open", "approval", "invite", "ticket", "rsvp"]) };
    if (r.chance(0.6)) a.capacity = r.pick([50, 1, 1000000, 1000001, 0, -1, null]);
    if (r.chance(0.5)) a.waitlist = r.chance(0.5);
    e.attendance = a;
  }
  if (r.chance(0.4))
    e.links = r.many(r.pick([2, 2, 11]), () => ({
      name: r.pick(["Website", " Site ", " ", "n".repeat(r.pick([100, 101]))]),
      url: r.pick(["https://planb.network/", "http://example.com", `https://e.com/${"a".repeat(r.pick([286, 287]))}`, ref(r)]),
    }));
  if (r.chance(0.4)) e.recurrenceRules = r.many(r.pick([1, 1, 1, 2]), () => rule(r));
  if (r.chance(0.3)) e.excludedDates = r.many(r.pick([2, 2, 101]), () => LOCAL(r));
  if (r.chance(0.15)) {
    e.recurrenceOf = r.pick([
      `pubky://${OWNER}/pub/social/v1/posts/${timestampIdOf(NOW - 5e9)}`,
      `pubky://${OTHER}/pub/social/v1/posts/${timestampIdOf(NOW - 5e9)}`,
      `pubky://${OWNER}/pub/social/v1/profile.json`,
      ref(r),
    ]);
    if (r.chance(0.85)) e.recurrenceId = LOCAL(r);
    if (r.chance(0.6)) e.recurrenceRules = [];
  }
  return e;
};
const rsvpEnvelope = (r) => {
  const e = { status: r.pick(["accepted", "requested", "declined", "tentative", "going"]) };
  if (r.chance(0.4)) e.recurrenceId = LOCAL(r);
  if (r.chance(0.5)) e.guests = r.pick([0, 1, 100, 101, -1]);
  if (r.chance(0.5)) e.note = r.pick(["bringing cake", " padded ", " ", "", "n".repeat(r.pick([2000, 2001])), null]);
  return e;
};
const blockOf = (r, titled) => {
  const b = { start: LOCAL(r), duration: DURATION(r) };
  if (titled && r.chance(0.5)) b.title = r.pick(["Office hours", " ", "t".repeat(r.pick([100, 101])), null]);
  if (!titled && r.chance(0.1)) b.title = "Dentist";
  if (r.chance(0.3)) b.recurrenceRules = r.many(r.pick([1, 1, 2]), () => rule(r));
  if (r.chance(0.2)) b.excludedDates = r.many(r.pick([2, 101]), () => LOCAL(r));
  return b;
};
const availabilityEnvelope = (r) => {
  const e = { timeZone: ZONE(r), horizonDays: r.pick([60, 1, 366, 367, 0, -1]) };
  if (r.chance(0.4)) e.for = r.pick([ref(r), `pubky://${OWNER}/pub/shop/v1/listings/${timestampIdOf(NOW - 5e9)}`, null]);
  if (r.chance(0.7)) e.available = r.many(r.pick([3, 3, 101]), () => blockOf(r, true));
  if (r.chance(0.6)) e.busy = r.many(r.pick([3, 3, 101]), () => blockOf(r, false));
  return e;
};
const ratingEnvelope = (r) => {
  const e = { rating: r.pick([7, 1, 10, 0, 11, -1]) };
  if (r.chance(0.6)) e.text = r.pick(["great coffee", " padded ", " ", "", "t".repeat(r.pick([2000, 2001])), null]);
  return e;
};
const routeEnvelope = (r) => {
  const e = {
    name: r.pick(["Lakeside loop", " Loop ", " ", "n".repeat(r.pick([100, 101])), text(r)]),
    activity: r.pick(["running", "Hiking", "e-bike", "trail run", "a,b", "", "x".repeat(r.pick([20, 21]))]),
    waypoints: r.many(r.pick([4, 4, 4, 1, 101]), () => (r.chance(0.6) ? { uri: PLACE(r) } : { uri: PLACE(r), name: r.pick(["Start", " ", "n".repeat(r.pick([100, 101])), null]) })),
    polyline: {
      encoded: r.pick(["_p~iF~ps|U_ulLnnqC_mqNvxq`@", "?~", "", "über", "a b", "x".repeat(r.pick([100000, 100001]))]),
      engine: r.pick(["valhalla", " Valhalla ", " ", "e".repeat(r.pick([50, 51]))]),
      profile: r.pick(["pedestrian", "bicycle", "auto", " "]),
      precision: r.pick([6, 5, 4, 7, 0]),
    },
    distance_m: r.pick([5200, 0, 100000000, 100000001, -1]),
    duration_s: r.pick([1800, 0, 315360000, 315360001, -1]),
  };
  if (r.chance(0.4)) e.description = r.pick(["Flat, along the shore.", " ", "", "d".repeat(r.pick([2000, 2001])), null]);
  if (r.chance(0.3)) e.elevation_gain_m = r.pick([12, 0, 100000, 100001, -1, null]);
  if (r.chance(0.3)) e.elevation_loss_m = r.pick([12, 100001, null]);
  if (r.chance(0.4))
    e.steps = r.many(r.pick([2, 2, 501]), () => ({
      instruction: r.pick(["Head south", " ", "i".repeat(r.pick([200, 201]))]),
      ...(r.chance(0.5) ? { distance_m: r.pick([400, -1, null]) } : {}),
      ...(r.chance(0.3) ? { duration_s: r.pick([150, 315360001]) } : {}),
    }));
  return e;
};
const TYPED = { event: eventEnvelope, rsvp: rsvpEnvelope, availability: availabilityEnvelope, rating: ratingEnvelope, route: routeEnvelope };

const envelopeText = (r, envelope) =>
  r.pick([() => JSON.stringify(envelope), () => JSON.stringify(envelope), () => stored(r, envelope), () => r.pick(["", "{", "[]", "null", "x".repeat(40001), "not json"])])();

/**
 * A post every rule accepts, then at most one late rule broken: the random draws refuse early
 * so often that the late rules and the accepted shapes would be reached only by chance.
 */
function cleanPost(r) {
  const kind = r.pick(["note", "article", "collection", "event", "rsvp", "availability", "rating", "route"]);
  const own = (root, leaf) => `pubky://${OWNER}/${seg(root)}/social/v1/${leaf}`;
  const media = () => own(r.pick(["public", "public", "private"]), `files/${hashIdText(r)}.png`);
  const item = () => ({ uri: own("public", `posts/${timestampIdOf(NOW - 5e9)}`), ...(r.chance(0.5) ? { note: "note" } : {}) });
  const place = () => r.pick(["geo:46.00547,8.95186", "https://www.openstreetmap.org/way/481516234"]);
  const clean = {
    article: () => ({ title: "Title", body: "Body" }),
    collection: () => ({ name: "List", description: "about", items: [item(), item()] }),
    event: () => ({
      title: "Evening",
      start: "2026-10-14T18:30:00",
      timeZone: "Europe/Zurich",
      duration: "PT2H30M",
      locations: [{ uri: place(), name: "Hub" }],
      recurrenceRules: [{ frequency: "monthly", byDay: [{ day: "tu", nthOfPeriod: 2 }] }],
    }),
    rsvp: () => ({ status: "accepted", guests: 1 }),
    availability: () => ({
      timeZone: "UTC",
      horizonDays: 30,
      available: [{ start: "2026-10-19T09:00:00", duration: "PT8H", title: "Office" }],
      busy: [{ start: "2026-10-21T14:00:00", duration: "PT1H" }],
    }),
    rating: () => ({ rating: 7, text: "great" }),
    route: () => ({
      name: "Loop",
      activity: "running",
      waypoints: [{ uri: place() }, { uri: place() }],
      polyline: { encoded: "_p~iF", engine: "valhalla", profile: "pedestrian", precision: 6 },
      distance_m: 5200,
      duration_s: 1800,
    }),
  };
  const envelope = kind === "note" ? null : clean[kind]();
  if ((kind === "article" || kind === "collection") && r.chance(0.5)) envelope.cover_image = media();
  const p = { content: "hello", kind, parent: kind === "rsvp" || kind === "rating" ? own("public", `posts/${timestampIdOf(NOW - 5e9)}`) : null, embed: null };
  if (r.chance(0.5)) p.attachments = [{ uri: media(), alt: "alt", name: "pic.png" }];
  const attachment = () => (p.attachments ??= [{ uri: media() }])[0];
  const breaks = {
    article: [
      () => (envelope.title = "t".repeat(101)),
      () => (envelope.body = "b".repeat(r.pick([50000, 50001]))),
      // Each control character is six code points once escaped, so the content cap is reached
      // with a body under its own
      () => (envelope.body = "\u0001".repeat(r.pick([17300, 17400]))),
    ],
    collection: [
      () => (envelope.items = Array.from({ length: r.pick([100, 101]) }, item)),
      () => (envelope.name = r.pick(["", " ", "n".repeat(r.pick([100, 101]))])),
      () => (envelope.description = r.pick([" ", "d".repeat(r.pick([500, 501]))])),
      () => (envelope.items[0].note = r.pick([" ", "n".repeat(r.pick([1000, 1001]))])),
    ],
    note: [() => (p.content = "c".repeat(r.pick([2000, 2001])))],
    event: [
      () => (envelope.title = "t".repeat(r.pick([100, 101]))),
      () => (envelope.description = "d".repeat(r.pick([50000, 50001]))),
      () => (envelope.locations = Array.from({ length: r.pick([10, 11]) }, () => ({ uri: place() }))),
      () => (envelope.recurrenceRules[0].count = r.pick([1000, 1001])),
      () => (envelope.recurrenceRules[0].until = r.pick(["2029-10-14T18:30:00", "2029-10-14T18:30:01"])),
      () => (envelope.attendance = { policy: "ticket", capacity: r.pick([1000000, 1000001]), waitlist: true }),
      () => (envelope.links = [{ name: "Site", url: r.pick(["https://x.y", "http://x.y"]) }]),
      () => (envelope.status = r.pick(["cancelled", "maybe"])),
      () => (envelope.excludedDates = Array.from({ length: r.pick([100, 101]) }, () => "2026-11-10T18:30:00")),
    ],
    rsvp: [() => (envelope.guests = r.pick([100, 101])), () => (envelope.note = "n".repeat(r.pick([2000, 2001]))), () => (p.parent = null)],
    availability: [
      () => (envelope.horizonDays = r.pick([366, 367])),
      () => (envelope.available = Array.from({ length: r.pick([100, 101]) }, () => ({ start: "2026-10-19T09:00:00", duration: "PT1H" }))),
      () => (envelope.busy[0].title = "Dentist"),
    ],
    rating: [() => (envelope.rating = r.pick([10, 11])), () => (envelope.text = "t".repeat(r.pick([2000, 2001]))), () => (p.parent = null)],
    route: [
      () => (envelope.waypoints = Array.from({ length: r.pick([100, 101]) }, () => ({ uri: place() }))),
      () => (envelope.polyline.encoded = "?".repeat(r.pick([100000, 100001]))),
      () => (envelope.distance_m = r.pick([100000000, 100000001])),
      () => (envelope.steps = Array.from({ length: r.pick([500, 501]) }, () => ({ instruction: "go" }))),
      () => (envelope.activity = "x".repeat(r.pick([20, 21]))),
    ],
  }[kind];
  const any = [
    () => (attachment().alt = "a".repeat(r.pick([1000, 1001]))),
    () => (p.attachments = Array.from({ length: r.pick([10, 11]) }, () => ({ uri: media() }))),
    () => (p.parent = own("private", `posts/${timestampIdOf(NOW - 5e9)}`)),
  ];
  // an rsvp and an availability carry no media, so a media break is no clean post of theirs
  const media_free = kind === "rsvp" || kind === "availability";
  if (media_free) delete p.attachments;
  if (r.chance(0.6)) r.pick([...breaks, ...(media_free ? [] : any)])();
  if (envelope) p.content = JSON.stringify(envelope);
  return p;
}

/** A post as stored: any kind, references of every tier, sometimes what a newer writer adds. */
function storedPost(r) {
  if (r.chance(0.35)) return cleanPost(r);
  const kind = r.pick([
    "note",
    "note",
    "note",
    "article",
    "article",
    "collection",
    "collection",
    "image",
    "link",
    "podcast",
    "unknown",
    "event",
    "event",
    "rsvp",
    "availability",
    "rating",
    "route",
    "route",
  ]);
  const p = {
    content:
      kind === "article"
        ? envelopeText(r, articleEnvelope(r))
        : kind === "collection"
          ? envelopeText(r, collectionEnvelope(r))
          : kind in TYPED
            ? envelopeText(r, TYPED[kind](r))
            : r.pick(["hello", " padded ", "", "c".repeat(r.pick([2000, 2001])), text(r)]),
    kind,
    parent: null,
    embed: null,
  };
  // the reply kinds mostly have the parent they need
  if (r.chance(kind === "rsvp" || kind === "rating" ? 0.85 : 0.3)) p.parent = ref(r);
  if (r.chance(0.3)) p.embed = ref(r);
  if (r.chance(0.5)) p.attachments = r.many(r.pick([2, 2, 2, 11]), () => attachmentOf(r));
  if (r.chance(0.2)) p.lock = r.pick([ref(r), `pubky://${OTHER}/pub/social/v1/profile.json`, null]);
  return p;
}

function postInput(r) {
  const kind = r.pick(["note", "note", undefined, "article", "collection", "image", "podcast", "unknown", "event", "event", "rsvp", "availability", "rating", "route", "route"]);
  let o;
  if (kind in TYPED) {
    // The members a builder takes, the envelope's own and the post's; a reply kind's parent
    o = { kind, ...TYPED[kind](r) };
    for (const [member, value] of Object.entries(o)) if (value === null && r.chance(0.5)) delete o[member];
    // A reply kind's parent is a required member: absent, the shape is refused before any rule
    if (kind === "rsvp" || kind === "rating") o.parent = ref(r);
    if (kind === "route" && r.chance(0.3)) o.embed = ref(r);
    if ((kind === "event" || kind === "rating" || kind === "route") && r.chance(0.4)) o.attachments = r.many(3, () => attachmentOf(r));
    if (kind === "event" && r.chance(0.15)) o.lock = ref(r);
    if (r.chance(0.4)) o.root = r.pick(["public", "private", null]);
    if (r.chance(0.3)) o.slug = r.pick(["a-slug", "", "UP", "s".repeat(r.pick([64, 65])), null]);
    return o;
  }
  if (kind === "article") {
    const e = articleEnvelope(r);
    o = { kind, title: e.title, body: e.body };
    if ("cover_image" in e) o.cover_image = e.cover_image;
  } else if (kind === "collection") {
    const e = collectionEnvelope(r);
    o = { kind, name: e.name };
    if ("description" in e) o.description = e.description;
    if ("items" in e) o.items = e.items;
    if ("cover_image" in e) o.cover_image = e.cover_image;
    if ("layout" in e) o.layout = e.layout;
  } else {
    o = { content: r.pick(["hello", " padded ", "", "c".repeat(r.pick([2000, 2001])), text(r)]) };
    if (kind !== undefined) o.kind = kind;
  }
  if (kind !== "collection") {
    if (r.chance(0.25)) o.parent = ref(r);
    if (r.chance(0.25)) o.embed = ref(r);
    if (r.chance(0.4)) o.attachments = r.many(3, () => attachmentOf(r));
    if (r.chance(0.15)) o.lock = ref(r);
  }
  if (r.chance(0.4)) o.root = r.pick(["public", "private", null]);
  if (r.chance(0.3)) o.slug = r.pick(["a-slug", "", "UP", "s".repeat(r.pick([64, 65])), null]);
  return o;
}

// Clocks around a head: past it, behind it, and too far behind to leave room
const env = (r) => ({ now: NOW + r.pick([0, 0, 0, -6e9, -7.3e9, -1e10, 1e6]), last: r.pick([0, 0, NOW - 1, NOW, NOW + 5, NOW + 2e6, NOW - 2e6]) });

const seg = (root) => (root === "private" ? "priv" : "pub");
const versionPath = (r, root, id, editId) =>
  `/${r.pick([seg(root), seg(root), seg(root), seg(root), seg(root), seg(root), seg(root), "pub", "priv", "x"])}/social/v1/posts/${id}/${editId}${r.pick(["", "", "", "", "", "-a-slug", "-BAD"])}${r.pick([".json", ".json", ".json", ".json", ".json", ".json", ".json", "", "/x"])}`;
const editIds = (r) => r.many(4, () => timestampIdOf(NOW - r.pick([1e9, 2e9, 3e9, 4e9, 4e9])));
const legacyPosts = (r, id) => r.pick([[], [], [`/pub/pubky.app/posts/${id}`], [`/pub/pubky.app/posts/${id}`, `/pub/pubky.app/posts/${timestampIdOf(NOW)}`], ["/pub/pubky.app/posts/"]]);
const ownMedia = (r, root) => `pubky://${OWNER}/${seg(root)}/social/v1/files/${r.pick(["0000000000000000000000000G", "ZZZZZZZZZZZZZZZZZZZZZZZZZW"])}.${r.pick(["png", "png", "exe"])}`;

/** A private version about to be published: its media mostly the owner's own private files. */
function draft(r) {
  const p = r.chance(0.5) ? cleanPost(r) : storedPost(r);
  const media = () => r.pick([ownMedia(r, "private"), ownMedia(r, "private"), ownMedia(r, "public"), ref(r), `pubky://${OWNER}/priv/social/v1/posts/${postId(r)}`]);
  if (r.chance(0.6)) p.attachments = r.many(3, () => ({ uri: media() }));
  if (p.kind === "article" && r.chance(0.7)) p.content = JSON.stringify({ title: "T", body: "B", cover_image: media(), ...(r.chance(0.2) ? { z: r.pick([1, "x", 9007199254740991]), a: [1] } : {}) });
  if (p.kind === "collection" && r.chance(0.7)) p.content = JSON.stringify({ name: "List", items: r.many(2, () => ({ uri: ref(r) })), ...(r.chance(0.5) ? { cover_image: media() } : {}) });
  return p;
}

const v0TagPath = (uri, label) => `/pub/pubky.app/tags/${hashOfText(`${uri}:${label}`)}`;
const BLOB = "0000000000000000000000000G";

function deletion(r) {
  const id = postId(r);
  return r.pick([
    () => ({ kind: "post", id, listings: [...legacyPosts(r, id), ...editIds(r).map((e) => versionPath(r, r.pick(["public", "private"]), id, e))] }),
    () => ({ kind: "post", id, listings: [{ path: `/pub/pubky.app/files/${id}`, src: "x" }] }),
    () => ({ kind: "post", id, listings: [r.pick(["/priv", "/pub", "/priv/", `/privx/social/v1/posts/${id}/${id}.json`])] }),
    () => {
      const hash = r.pick([BLOB, BLOB, hashIdText(r), "x"]);
      const listings = r.many(4, () =>
        r.pick([
          `/pub/pubky.app/blobs/${hash}`,
          `/${r.pick(["pub", "priv"])}/social/v1/files/${r.pick([hash, hash, hashIdText(r)])}.${r.pick(["png", "bin", "exe"])}`,
          { path: `/pub/pubky.app/files/${r.pick([id, id, "x"])}`, src: `pubky://${OWNER}/pub/pubky.app/blobs/${r.pick([hash, hash, hashIdText(r)])}` },
          { path: "/pub/pubky.app/tags/x", uri: "https://example.com", label: "a" },
        ]),
      );
      return { kind: "file", id: hash, listings };
    },
    () => {
      const label = r.pick(["rust", "Rust", " rust "]);
      const target = r.pick([
        { uri: `pubky://${OTHER}/pub/pubky.app/posts/${id}`, v1: `pubky://${OTHER}/pub/social/v1/posts/${id}` },
        { uri: `pubky://${OTHER}/pub/pubky.app/profile.json`, v1: `pubky://${OTHER}/pub/social/v1/profile.json` },
        { uri: "https://example.com/a", v1: "https://example.com/a" },
        { uri: `pubky://${OTHER}/pub/pubky.app/files/${id}`, v1: `pubky://${OTHER}/pub/social/v1/files/${BLOB}.png`, src: `pubky://${OTHER}/pub/pubky.app/blobs/${BLOB}`, contentType: "image/png" },
        { uri: "nostr:note1", v1: "nostr:note1" },
        { uri: `pubky://${OTHER}`, v1: `pubky://${OTHER}` },
        { uri: "pubky:/x", v1: "" },
        { uri: "http://", v1: "" },
        { uri: `pubky://${OTHER}/pub/pubky.app/files/${id}`, v1: "", src: "x", contentType: "image/png" },
      ]);
      const listing = { path: r.chance(0.85) ? v0TagPath(target.uri, label) : "/pub/pubky.app/tags/x", uri: target.uri, label };
      if (target.src && r.chance(0.8)) listing.src = target.src;
      if (target.contentType && r.chance(0.8)) listing.contentType = target.contentType;
      const tagId = r.chance(0.85) ? hashOfText(`${target.v1}:${label.trim().toLowerCase()}`) : hashIdText(r);
      return { kind: "tag", id: tagId, listings: r.pick([[listing], [listing, listing], [], ["/pub/x"]]) };
    },
    () => ({
      kind: r.pick(["user", "follow", "mute", "bookmark", "feed"]),
      id: r.pick(["", key(r), hashIdText(r), "~" + hashIdText(r), "aGk", "_x"]),
      ...(r.chance(0.2) ? { listings: r.pick([[], ["/pub/x"], null]) } : {}),
    }),
  ])();
}

const s = (value) => ({ s: value });
const request = (op, ...args) => ({ op, args, now: NOW, last: 0 });

/**
 * Fixed requests, recorded as they are and never fuzzed: the edges a seeded draw would reach
 * only by a list too long to record 400 times. Each is a 1.1 envelope whose list is past its
 * cap and ends in a private reference, so the answer says which ran first, the cap or the
 * reference gate, at the planner and at the reader; then 1.0 posts past a cap with a private
 * reference, whose answer is the one 1.0 gave, the reference.
 */
export const fixed = {
  bounds: () => {
    const id = timestampIdOf(NOW - 5e9);
    const privatePost = `pubky://${OWNER}/priv/social/v1/posts/${id}`;
    const list = (n) => [...Array.from({ length: n - 1 }, () => ({ uri: "geo:0,0" })), { uri: privatePost }];
    const event = (n, pad = 0) => ({ title: "t", start: "2026-10-14T18:30:00", timeZone: "UTC", duration: "PT1H", locations: list(n), ...(pad > 0 ? { description: "d".repeat(pad) } : {}) });
    const route = (n) => ({
      name: "n",
      activity: "running",
      waypoints: list(n),
      polyline: { encoded: "_p~iF", engine: "valhalla", profile: "pedestrian", precision: 6 },
      distance_m: 1,
      duration_s: 1,
    });
    const post = (kind, envelope) => ({ content: JSON.stringify(envelope), kind, parent: null, embed: null, attachments: [] });
    const publish = (p) => request("planPublish", s(OWNER), { j: JSON.stringify({ id, editId: id, post: p }) });
    const decode = (root, p) => request("decode", s(`pubky://${OWNER}/${root}/social/v1/posts/${id}/${id}.json`), { j: JSON.stringify(p) });
    const cap = limits.eventContentMaxLength;
    return [
      // within the caps: the reference gate refuses the private item
      publish(post("event", event(10))),
      publish(post("route", route(100))),
      // past a list cap: the cap, no item read
      publish(post("event", event(11))),
      publish(post("route", route(101))),
      // past the raw content cap: the cap, nothing parsed
      publish(post("event", event(11, cap))),
      // past the byte cap of the written form: that cap, first
      publish(post("event", event(25_000))),
      publish(post("route", route(25_000))),
      // the reader: the raw cap before the list cap, under either root
      decode("priv", post("event", event(11, cap))),
      decode("pub", post("event", event(11, cap))),
      decode("priv", post("route", route(101))),
      // 1.0 kinds keep 1.0's planner order: the private reference, not the cap
      publish({ content: JSON.stringify({ name: "c", items: Array.from({ length: 101 }, () => ({ uri: privatePost })) }), kind: "collection", parent: null, embed: null, attachments: [] }),
      publish({ content: "n", kind: "note", parent: privatePost, embed: null, attachments: Array.from({ length: 11 }, () => ({ uri: "https://example.com/a.png" })) }),
    ];
  },
};

export const families = {
  text: (r) =>
    request(
      r.pick(["frozenTrim", "asciiFold", "codePointLen", "debug"]),
      s(
        r.chance(0.2)
          ? String.fromCodePoint(
              ...r.many(6, () =>
                r.pick([r.below(0x300), r.below(0x3000), 0xe000 + r.below(0x2000), 0x10000 + r.below(0x20000), 0x30000 + r.below(0xb0000), 0xe0000 + r.below(0x200), 0xf0000 + r.below(0x20000)]),
              ),
            )
          : str(r),
      ),
    ),
  graph: (r) =>
    r.pick([
      () => request(r.pick(["createFollow", "createMute"]), s(key(r)), s(key(r))),
      () => request("createTag", s(key(r)), s(tagUri(r)), s(label(r))),
      () => {
        const target = r.pick([ref(r), longRef(r)]);
        return request("createBookmark", s(key(r)), s(target));
      },
      () =>
        request("decode", s(`pubky://${OWNER}/${r.pick(["pub", "pub", "priv"])}/social/v1/${r.pick(["follows", "follows", "mutes"])}/${key(r)}.json`), {
          j: withRaw(stored(r, { created_at: raw(stamp(r)) })),
        }),
      () => {
        const uri = tagUri(r);
        const l = r.pick(["rust", "rust", "pubky", label(r)]);
        const id = r.chance(0.85) ? hashOfTag(uri, l) : hashIdText(r);
        return request("decode", s(`pubky://${OWNER}/${r.pick(["pub", "pub", "pub", "priv"])}/social/v1/tags/${id}.json`), { j: withRaw(stored(r, { uri, label: l, created_at: raw(stamp(r)) })) });
      },
      () => {
        const target = r.pick([ref(r), longRef(r), `pubky://${OTHER}/pub/social/v1/profile.json`]);
        const id = r.pick([
          b64url(target),
          b64url(target),
          "~" + hashOfText(target),
          "~" + hashIdText(r),
          "~" + hashOfText(longRef(r)),
          "~" + hashOfText(`https://example.com/${"p".repeat(167)}`),
          b64url(target) + "=",
          b64url(target).slice(0, -1) + "B",
          spelled(r, base64url, 8),
          b64url("\u00ff\u00fe").replace("w7", "_w"),
        ]);
        const content = { created_at: raw(stamp(r)) };
        if (r.chance(0.5)) content.target = r.pick([target, target, ref(r), null]);
        const text = withRaw(stored(r, content));
        return r.chance(0.6)
          ? request("decode", s(`pubky://${OWNER}/${r.pick(["priv", "priv", "priv", "pub"])}/social/v1/bookmarks/${id}.json`), { j: text })
          : request("bookmarkTarget", s(id), ...(r.chance(0.3) ? [] : [{ j: text }]));
      },
    ])(),
  post: (r) =>
    r.pick([
      () => ({ ...request("createPost", s(key(r)), { j: JSON.stringify(postInput(r)) }), ...env(r) }),
      () => ({ ...request("createPost", s(OWNER), { j: JSON.stringify(postInput(r)) }), ...env(r) }),
      () => {
        const id = postId(r);
        const head = r.pick([id, id, timestampIdOf(NOW - 4e9), timestampIdOf(NOW + 1e9), timestampIdOf(NOW + 7.1e9), timestampIdOf(NOW - 9e9), "x"]);
        const at = { id, head };
        if (r.chance(0.4)) at.root = r.pick(["public", "private"]);
        if (r.chance(0.3)) at.slug = r.pick(["edited", "Bad Slug"]);
        return { ...request("editPost", s(key(r)), { j: stored(r, storedPost(r)) }, { j: JSON.stringify(at) }), ...env(r) };
      },
      () => {
        const id = postId(r);
        const leaf = r.pick([`${id}/${id}.json`, `${id}/${timestampIdOf(NOW - 4e9)}-a-slug.json`, id, `${id}/${timestampIdOf(NOW + r.pick([7.1e9, 7.3e9]))}.json`]);
        return request("decode", s(`pubky://${r.pick([OWNER, OWNER, OTHER])}/${r.pick(["pub", "pub", "priv"])}/social/v1/posts/${leaf}`), { j: stored(r, storedPost(r), limits.postMaxBytes) });
      },
    ])(),
  maps: (r) => {
    const coordinate = (bound) =>
      r.pick([
        () => r.below(2 * bound * 1000) / 1000 - bound,
        () => bound,
        () => -bound,
        () => bound + 0.000005,
        () => bound + 0.000004,
        () => 0,
        () => 0.125,
        () => -0.125,
        () => 1e-7,
        () => 46.00547,
        () => 1e300,
        () => -1e-320,
      ]);
    return r.pick([
      () => request("isGeoUri", s(r.pick([PLACE(r), `geo:${coordinate(90)()},${coordinate(180)()}`, `geo:${str(r, 6)},${str(r, 6)}`, str(r, 12)]))),
      () =>
        request(
          "parseOsmUrl",
          s(
            r.pick([
              PLACE(r),
              `https://www.openstreetmap.org/${r.pick(["node", "way", "relation", "Way", "user", ""])}/${r.pick([String(r.below(1e6)), "0", "007", "1".repeat(r.pick([18, 19])), "-1", ""])}${r.pick(["", "", "/", "?x", "#y"])}`,
              str(r, 20),
            ]),
          ),
        ),
      () => request("geoUri", { j: JSON.stringify([coordinate(90)(), coordinate(180)(), r.pick([5, 5, 5, 3, 2, 0, 6])]) }),
    ])();
  },
  plan: (r) => {
    const id = postId(r);
    const owner = () => (r.chance(0.8) ? OWNER : key(r));
    return r.pick([
      () =>
        request("planPublish", s(owner()), {
          j: JSON.stringify({
            id,
            editId: r.pick([id, id, timestampIdOf(NOW - 4e9), timestampIdOf(NOW - 9e9), "x"]),
            post: draft(r),
            ...(r.chance(0.3) ? { slug: r.pick(["my-post", "a", "Bad", "x".repeat(65)]) } : {}),
          }),
        }),
      () => {
        const post = { id: r.pick([id, id, id, "x"]), publicPaths: editIds(r).map((e) => versionPath(r, "public", id, e)) };
        if (r.chance(0.5)) post.legacyPaths = legacyPosts(r, id);
        if (r.chance(0.5)) post.privateHead = r.pick([versionPath(r, "private", id, timestampIdOf(NOW - 2.5e9)), null]);
        return request("planUnpublish", { j: JSON.stringify(post) });
      },
      () => {
        const post = { id: r.pick([id, id, id, "x"]) };
        if (r.chance(0.5)) post.legacyPaths = legacyPosts(r, id);
        if (r.chance(0.8))
          post.copies = editIds(r).map((e) => {
            const root = r.pick(["public", "private"]);
            return { root, path: versionPath(r, root, id, e) };
          });
        if (r.chance(0.6)) post.versions = r.many(3, () => draft(r));
        return request("planDelete", s(owner()), { j: JSON.stringify(post) });
      },
      () => request("deletionPaths", { j: JSON.stringify(deletion(r)) }),
    ])();
  },
  loose: (r) => {
    // Past 2^53 too, which only the text can hold
    const at = () => raw(r.chance(0.15) ? r.pick(["9007199254740993", "-9007199254740993", "9007199254740995", "9223372036854775807", "-9223372036854775808"]) : stamp(r));
    const [kind, object] = r.pick([
      () => ["user", storedUser(r)],
      () => ["post", storedPost(r)],
      () => [r.pick(["follow", "mute"]), { created_at: at() }],
      () => ["bookmark", { created_at: at(), ...(r.chance(0.5) ? { target: r.pick([ref(r), longRef(r)]) } : {}) }],
      () => ["tag", { uri: tagUri(r), label: label(r), created_at: at() }],
      () => ["feed", storedFeed(r)],
    ])();
    return request("encodeKind", s(kind), { j: JSON.stringify(r.pick(["public", "private", null])) }, { j: withRaw(stored(r, object, kind === "post" ? limits.postMaxBytes : undefined)) });
  },
  feed: (r) =>
    r.pick([
      () => request("createFeed", s(key(r)), { j: JSON.stringify(feedInput(r)) }),
      () => request("feedPaths", s(r.pick([hashIdText(r), hashIdText(r), "~" + hashIdText(r), "_x", ""]))),
      () => {
        const f = storedFeed(r);
        const id = r.chance(0.85) && f.feed && typeof f.feed === "object" ? feedIdText(f) : hashIdText(r);
        const text = withRaw(stored(r, f));
        return r.chance(0.7) ? request("decode", s(`pubky://${OWNER}/${r.pick(["priv", "priv", "pub"])}/social/v1/feeds/${id}.json`), { j: text }) : request("feedId", { j: text });
      },
    ])(),
  file: (r) => {
    const data = Buffer.from(r.many(r.pick([0, 0, 3, 40, 300]), () => r.below(256)));
    const b = { b: data.toString("base64") };
    return r.chance(0.5)
      ? request(
          "createFile",
          s(key(r)),
          b,
          s(r.pick(["image/png", "IMAGE/JPEG", "video/mp4; codecs=x", "", "application/octet-stream", str(r, 6)])),
          ...(r.chance(0.5) ? [{ j: JSON.stringify(r.pick(["public", "private", null])) }] : []),
        )
      : request("decode", s(`pubky://${OWNER}/${r.pick(["pub", "priv"])}/social/v1/files/${r.chance(0.7) ? hashId(data) : hashIdText(r)}.${r.pick(["png", "bin", "jpg"])}`), b);
  },
  user: (r) =>
    r.chance(0.5)
      ? request("createUser", s(r.chance(0.95) ? OWNER : r.pick([str(r, 4), `pubky://${OWNER}`, `pubky${OWNER}`, key(r), `l${OWNER.slice(1)}`])), { j: JSON.stringify(userInput(r)) })
      : request(
          "decode",
          s(
            r.chance(0.1)
              ? r.pick([`pubky://${OWNER}`, `pubky${OWNER}`, `pubky${OWNER}/pub/social/v1/profile.json`, "/pub/social/v1/profile.json"])
              : `pubky://${OWNER}/${r.pick(["pub", "pub", "pub", "priv"])}/social/v1/profile.json`,
          ),
          r.chance(0.05) ? notUtf8(r, withRaw(stored(r, storedUser(r)))) : { j: withRaw(stored(r, storedUser(r))) },
        ),
  ids: (r) =>
    r.pick([
      () => request("publicKey", s(r.chance(0.5) ? spelled(r, ZBASE32, 52) : r.pick([OWNER, OTHER, str(r, 60)]))),
      () => request("timestampId", s(r.chance(0.5) ? spelled(r, CROCKFORD, 13) : timestampIdOf(NOW + r.below(1e9)))),
      () => request("hashId", s(spelled(r, CROCKFORD, 26))),
      () => request("mediaId", { b: Buffer.from(r.many(200, () => r.below(256))).toString("base64") }),
    ])(),
  json: (r) => request("json", { j: r.chance(0.04) ? nested(r) : json(r) }),
  canonical: (r) => {
    const op = r.pick(["canonicalPubky", "canonicalWeb", "canonicalExternal", "canonicalUniversal", "canonicalUniversal"]);
    // Mostly a reference of the arm's own scheme, so its rules past the prefix are reached
    const arm = { canonicalPubky: 0, canonicalWeb: 1, canonicalExternal: 2 }[op];
    return request(op, s(arm !== undefined && r.chance(0.7) ? uri(r, arm) : uri(r)));
  },
  uri: (r) =>
    r.pick([
      () => request("parseUri", s(uri(r))),
      () => request("parseUri", s(`pubky://${OWNER}/${path(r)}`)),
      () => request("stableKey", s(r.pick(["", "/", "/"]) + path(r))),
      () =>
        request(
          "stableKey",
          s(
            `/${r.pick(["pub", "priv"])}/${r.pick(["social/v1", "pubky.app"])}/${r.pick([`posts/${timestampIdOf(NOW - r.below(1e12))}`, `tags/${hashIdText(r)}`, `files/${hashIdText(r)}.png`, `blobs/${hashIdText(r)}`, `follows/${OTHER}.json`, "profile.json", "last_read", "settings"])}`,
          ),
        ),
      () =>
        request(
          "legacyMediaKey",
          s(
            r.pick([
              uri(r),
              `pubky://${OWNER}/pub/pubky.app/blobs/${str(r, 6)}`,
              `${r.pick(["pubky", "PuBkY"])}://${r.pick(["", "u@", "u:p@", "@@"])}${OWNER}${r.pick(["", ":", ":80", ":65536", ":8x", ":080"])}/${r.pick(["", "./", "x/../", "%2e/", "%2E%2e/", "a/b/../../"])}pub/pubky.app/blobs/${r.pick(["h", "a b", "é", "%zz", "..", ".", "x/..", "x/.", "x?q", "x#f", "a\\b", "a|b^c", "a\tb", "{x}", "\u0060", "'", "[", "~"])}${r.pick(["", "/", "/more"])}`,
            ]),
          ),
        ),
      () => request("listPrefix", s(r.pick([OWNER, str(r, 8)])), { j: JSON.stringify(r.pick(["public", "private", "legacy"])) }),
      () => {
        const kind = r.pick(["user", "post", "follow", "mute", "bookmark", "tag", "file", "feed"]);
        // Mostly an id of the kind, so the reparse gate is reached past the spelling
        const ids = {
          user: () => "",
          post: () => timestampIdOf(NOW - r.below(1e12)),
          follow: () => key(r),
          mute: () => key(r),
          bookmark: () => r.pick(["~" + hashIdText(r), spelled(r, base64url, r.below(12)), "_x"]),
          tag: () => hashIdText(r),
          file: () => `${hashIdText(r)}${r.pick(["", "."])}${r.pick(EXTENSIONS)}`,
          feed: () => hashIdText(r),
        };
        const id = r.chance(0.7) ? ids[kind]() : r.pick([str(r, 8), `${ids[kind]()}/x`, `${ids[kind]()}.json`, "", spelled(r, CROCKFORD, 13)]);
        return request("buildUri", s(r.pick([OWNER, OWNER, spelled(r, ZBASE32, 52)])), s(kind), s(id));
      },
      () =>
        request(
          "mimeToExt",
          s(
            r.pick([
              "image/png",
              "IMAGE/JPEG; q=1",
              " image/png",
              "text/xml",
              "application/octet-stream",
              "image/svg+xml",
              "Image/SVG+XML; charset=utf-8",
              "application/ld+json",
              "application/vnd.ms-excel",
              "a!#$&^_.+-/b",
              "image/sv g",
              "a/b/c",
              "/",
              "image/",
              str(r, 8),
            ]),
          ),
        ),
    ])(),
};
