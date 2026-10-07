// Seeded requests per family. A case is its family, its seed and its index, so a mismatch is
// replayed from three numbers.

import { blake3 } from "@noble/hashes/blake3.js";

const crock = (bytes) => {
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  bits <<= 2n;
  let out = "";
  for (let i = 0; i < 26; i++) {
    out = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[Number(bits & 31n)] + out;
    bits >>= 5n;
  }
  return out;
};
// The id of a hashed object, computed here so a generated path can name its own content
export const hashOfText = (text) => crock(blake3(new TextEncoder().encode(text)).subarray(0, 16));
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

export const OWNER = "8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo";
export const OTHER = "pxnu33x7jtpx9ar1ytsi4yxbp6a5o36gwhffs8zoxmbuptici1jy";
// 2026-09-22, inside every time bound
export const NOW = 1_790_000_000_000_000;

// Where the engine and the reference could part: the frozen whitespace set and its
// neighbours, case pairs outside ASCII, controls, an astral character, a combining mark
const ODD = [
  "\t", "\n", "\u000b", "\u000c", "\r", " ", "\u0085", " ", " ", " ", " ",
  "​", " ", " ", " ", " ", "　", "﻿", "\u001f", "\u007f",
  "\u0000", "İ", "ß", "K", "é", "é", "😀", "𐐀", "Ａ", "%", "/", "?", "#", ":", "@", "\\",
  ".", "..", "-", "_", "~", "\"", "{", "}", "[", ",",
];
const PLAIN = "abcxyzABCXYZ0189";

export function str(r, max = 12) {
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

export const timestampIdOf = (micros) => {
  let bits = BigInt(micros) << 1n;
  let id = "";
  for (let i = 0; i < 13; i++) {
    id = CROCKFORD[Number(bits & 31n)] + id;
    bits >>= 5n;
  }
  return id;
};

const hashIdText = (r) => Array.from({ length: 25 }, () => r.pick([...CROCKFORD])).join("") + r.pick([..."048CGMRW"]);
const base64url = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const EXTENSIONS = ["png", "jpg", "bin", "json", "JPG", "exe", "tar.gz", ""];

/** An owner-relative path: mostly one the parser names, sometimes one it almost does. */
export function path(r) {
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
  return out;
}

/** A reference as a user could store one: pubky in both forms, web, any other scheme. */
export function uri(r) {
  const host = r.pick([OWNER, OWNER, OTHER, spelled(r, ZBASE32, 52), `u:p@${OWNER}`, `${OWNER}:80`, OWNER.toUpperCase()]);
  let out = r.pick([
    () => `${r.pick(["pubky://", "pubky://", "pubky://", "pubky", "PUBKY://", "pubky:", "pubky:/", "Pubky://"])}${host}${r.pick(["/", "/", "/", ""])}${r.chance(0.9) ? path(r) : ""}`,
    () => `${r.pick(["http://", "https://", "HTTP://", "https:/", "http://?", "https://#"])}${r.pick(["example.com", "é.example", "a b", ""])}${r.pick(["", "/", "/p?q=1#f", "/" + str(r, 6)])}`,
    () => `${r.pick(["nostr", "geo", "IPFS", "did", "magnet", "pubkyx", "http", "1a", "a+b.c-d", "é", ""])}:${str(r, 8)}`,
    () => str(r, 20),
  ])();
  if (r.chance(0.1)) out = r.pick([" ", "\t", "\u00a0", "\u200b", "\n"]) + out;
  if (r.chance(0.1)) out += r.pick([" ", "\u3000", "\ufeff", "\r"]);
  if (r.chance(0.03)) out += "x".repeat(r.pick([900, 1000, 1100]));
  return out;
}

const NUMBERS = [
  "0", "-0", "1", "-1", "9007199254740991", "9007199254740992", "-9007199254740993", "18446744073709551615",
  "18446744073709551616", "-9223372036854775808", "-9223372036854775809", "123456789012345678901234567890",
  "1.0", "2.50", "0.1", "1e30", "1E+30", "1e-7", "1e16", "1e15", "123456789012345680000", "0.000001", "0.00001234",
  "1.7976931348623157e308", "1e309", "5e-324", "2.5e-324", "1e-400", "0e999999999999", "1e999999999999",
  "0.30000000000000004", "9007199254740993.0", "4.35", "1.2345678901234567890123", "123456789.123456789e-5",
  "01", "-", "1.", ".5", "1e", "1e+", "+1", "0x10", "1.e3", "--1", "1.0e-0",
];
const digits = (r, max) => r.many(max, () => r.below(10)).join("");

function number(r) {
  if (r.chance(0.45)) return r.pick(NUMBERS);
  const integer = r.chance(0.5) ? String(r.below(1000)) : (r.below(9) + 1) + digits(r, 24);
  return `${r.pick(["", "", "-"])}${integer}${r.chance(0.5) ? "." + digits(r, 22) + r.below(10) : ""}${r.chance(0.4) ? r.pick(["e", "E"]) + r.pick(["", "+", "-"]) + r.below(r.pick([5, 30, 330])) : ""}`;
}

const ESCAPES = ['\\n', '\\"', "\\\\", "\\/", "\\u0041", "\\u00e9", "\\ud83d\\ude00", "\\ud83d", "\\ude00", "\\ud83d\\u0041", "\\ud83dx", "\\ud83d\\n", "\\u12", "\\u12g4", "\\x", "\\u0000", "\\u001f", "\\uD83D\\uDE00", "\\b\\f\\r\\t"];

function jsonString(r) {
  const inner = r.many(6, () => (r.chance(0.3) ? r.pick(ESCAPES) : r.chance(0.2) ? r.pick(["\t", "\n", "\u007f", "é", "😀", "\u2028", "\ue000", "\uffff", "__proto__"]) : r.pick([...PLAIN])));
  return `"${inner.join("")}"`;
}

/** JSON text: mostly well formed, with the numbers, keys and escapes two parsers read apart. */
export function json(r, depth = 3) {
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
export function spoil(r, object) {
  const entries = Object.entries(object).map(([key, value]) => [key, JSON.stringify(value)]);
  const roll = r.below(100);
  if (roll < 6 && entries.length) entries.splice(r.below(entries.length), 1);
  else if (roll < 12) entries.splice(r.below(entries.length + 1), 0, [r.pick(["zzz", "extra", "é", "__proto__", "😀", "\ue000", "10", "created_at", "kind"]), r.pick([...WRONG, json(r, 2)])]);
  else if (roll < 20 && entries.length) entries[r.below(entries.length)][1] = r.pick(WRONG);
  else if (roll < 24 && entries.length) entries.push([...r.pick(entries)]);
  else if (roll < 26) return `[${entries.map(([, value]) => value).slice(0, r.below(entries.length + 2)).join(",")}${r.pick(["", "", ",1", ","])}]`;
  else if (roll < 28) return r.pick(WRONG);
  let text = `{${entries.map(([key, value]) => `${JSON.stringify(key)}:${value}`).join(",")}}`;
  if (roll >= 28 && roll < 30) text = [...text].slice(0, r.below(text.length)).join("");
  if (roll >= 30 && roll < 32) text += r.pick([" ", ",", "x", "{}"]);
  return text;
}

const words = (r, max) => r.many(max, () => r.pick(["Ann", "bob", " ", "\u00a0", "\u3000", "\u200b", "é", "😀", "x".repeat(r.below(60)), "\t", "\n", "\u0000", "A"])).join("");
const text = (r, max = 6) => words(r, max);

/** A reference for a field: the right tier most of the time. */
export function ref(r) {
  return r.pick([
    () => `pubky://${r.pick([OWNER, OTHER])}/${r.pick(["pub", "pub", "priv"])}/social/v1/${r.pick([`posts/${timestampIdOf(NOW - 5e9)}`, `posts/${timestampIdOf(NOW - 5e9)}/${timestampIdOf(NOW - 4e9)}.json`, `files/${hashIdText(r)}.png`, "profile.json"])}`,
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
  if (r.chance(0.6)) o.links = r.pick([null, r.many(6, () => r.chance(0.9) ? { title: r.pick(["Site", " ", " t ", "t".repeat(r.pick([100, 101])), text(r)]), url: ref(r) } : JSON.parse(spoilSafe(r, { title: "t", url: "https://example.com" })))]);
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

const EXTRA = ['"x":1', '"x":9007199254740992', '"x":-9007199254740992', '"x":1.0', '"x":{"b":[1,{"a":18446744073709551615}],"a":1e30}', '"é":"é","\ue000":1,"😀":2', '"__proto__":{"a":1}', '"x":null,"x":2', '"n":123456789012345678901234567890'];

/** A stored object: `object` spoiled, sometimes carrying members no version knows. */
function stored(r, object) {
  let out = spoil(r, object);
  if (r.chance(0.3) && out.endsWith("}") && out.length > 2) out = `${out.slice(0, -1)},${r.pick(EXTRA)}}`;
  return out;
}

const storedUser = (r) => {
  const o = userInput(r);
  return { name: o.name, bio: o.bio ?? null, image: o.image ?? null, links: o.links ?? null, status: o.status ?? null };
};

const key = (r) => r.pick([OWNER, OTHER, OTHER, spelled(r, ZBASE32, 52)]);
const stamp = (r) => r.pick([NOW, NOW, 0, -1, 9007199254740991, "9007199254740992", "-9007199254740992", 1.5, "x", null]);
const raw = (value) => (typeof value === "string" && /^-?[0-9]+$/.test(value) ? { toJSON: undefined, raw: value } : value);
// A number too large for a double has to be spelled into the text by hand
const withRaw = (text) => text.replace(/\{"raw":"(-?[0-9]+)"\}/g, "$1");
const longRef = (r) => `https://example.com/${"p".repeat(r.pick([150, 167, 168, 169, 400]))}`;
const b64url = (text) => Buffer.from(text).toString("base64url");
const tagUri = (r) => r.pick([ref(r), ref(r), `pubky://${OTHER}/pub/social/v1/posts/${timestampIdOf(NOW - 5e9)}`]);
const label = (r) => r.pick(["rust", "Rust", " rust ", "a,b", "a:b", "a b", "", "x".repeat(r.pick([20, 21])), "é", "😀", "RÉSUMÉ", "a\u00a0b", "a\u200bb"]);

const s = (value) => ({ s: value });
const request = (op, ...args) => ({ op, args, now: NOW, last: 0 });

export const families = {
  text: (r) => request(r.pick(["frozenTrim", "asciiFold", "codePointLen", "debug"]), s(r.chance(0.2) ? String.fromCodePoint(...r.many(6, () => r.pick([r.below(0x300), r.below(0x3000), 0xe000 + r.below(0x2000), 0x10000 + r.below(0x20000), 0xe0000 + r.below(0x200)]))) : str(r))),
  graph: (r) =>
    r.pick([
      () => request(r.pick(["createFollow", "createMute"]), s(key(r)), s(key(r))),
      () => request("createTag", s(key(r)), s(tagUri(r)), s(label(r))),
      () => {
        const target = r.pick([ref(r), longRef(r)]);
        return r.chance(0.5) ? request("createBookmark", s(key(r)), s(target)) : request("bookmarkId", s(target));
      },
      () => request("decode", s(`pubky://${OWNER}/${r.pick(["pub", "pub", "priv"])}/social/v1/${r.pick(["follows", "follows", "mutes"])}/${key(r)}.json`), { j: withRaw(stored(r, { created_at: raw(stamp(r)) })) }),
      () => {
        const uri = tagUri(r);
        const l = r.pick(["rust", "rust", "pubky", label(r)]);
        const id = r.chance(0.85) ? hashOfTag(uri, l) : hashIdText(r);
        return request("decode", s(`pubky://${OWNER}/${r.pick(["pub", "pub", "pub", "priv"])}/social/v1/tags/${id}.json`), { j: withRaw(stored(r, { uri, label: l, created_at: raw(stamp(r)) })) });
      },
      () => {
        const target = r.pick([ref(r), longRef(r), `pubky://${OTHER}/pub/social/v1/profile.json`]);
        const id = r.pick([b64url(target), b64url(target), "~" + hashOfText(target), "~" + hashIdText(r), b64url(target) + "=", b64url(target).slice(0, -1) + "B", spelled(r, base64url, 8), b64url("\u00ff\u00fe").replace("w7", "_w")]);
        const content = { created_at: raw(stamp(r)) };
        if (r.chance(0.5)) content.target = r.pick([target, target, ref(r), null]);
        const text = withRaw(stored(r, content));
        return r.chance(0.6)
          ? request("decode", s(`pubky://${OWNER}/${r.pick(["priv", "priv", "priv", "pub"])}/social/v1/bookmarks/${id}.json`), { j: text })
          : request("bookmarkTarget", s(id), ...(r.chance(0.3) ? [] : [{ j: text }]));
      },
    ])(),
  user: (r) =>
    r.chance(0.5)
      ? request("createUser", s(r.chance(0.97) ? OWNER : str(r, 4)), { j: spoil(r, userInput(r)) })
      : request("decode", s(`pubky://${OWNER}/${r.pick(["pub", "pub", "pub", "priv"])}/social/v1/profile.json`), { j: stored(r, storedUser(r)) }),
  ids: (r) =>
    r.pick([
      () => request("publicKey", s(r.chance(0.5) ? spelled(r, ZBASE32, 52) : r.pick([OWNER, OTHER, str(r, 60)]))),
      () => request("timestampId", s(r.chance(0.5) ? spelled(r, CROCKFORD, 13) : timestampIdOf(NOW + r.below(1e9)))),
      () => request("hashId", s(spelled(r, CROCKFORD, 26))),
      () => request("mediaId", { b: Buffer.from(r.many(200, () => r.below(256))).toString("base64") }),
    ])(),
  json: (r) => request("json", { j: r.chance(0.02) ? "[".repeat(r.pick([126, 127, 128, 129])) + "]".repeat(r.pick([126, 127, 128])) : json(r) }),
  canonical: (r) =>
    request(r.pick(["canonicalPubky", "canonicalWeb", "canonicalExternal", "canonicalUniversal", "canonicalUniversal"]), s(uri(r))),
  uri: (r) =>
    r.pick([
      () => request("parseUri", s(uri(r))),
      () => request("parseUri", s(`pubky://${OWNER}/${path(r)}`)),
      () => request("stableKey", s(r.pick(["", "/", "/"]) + path(r))),
      () => request("legacyMediaKey", s(r.pick([uri(r), `pubky://${OWNER}/pub/pubky.app/blobs/${str(r, 6)}`, `${r.pick(["pubky", "PuBkY"])}://${r.pick(["", "u@", "u:p@", "@@"])}${OWNER}${r.pick(["", ":", ":80", ":65536", ":8x", ":080"])}/${r.pick(["", "./", "x/../", "%2e/", "%2E%2e/", "a/b/../../"])}pub/pubky.app/blobs/${r.pick(["h", "a b", "é", "%zz", "..", ".", "x/..", "x/.", "x?q", "x#f", "a\\b", "a|b^c", "a\tb", "{x}", "\u0060", "'", "[", "~"])}${r.pick(["", "/", "/more"])}`]))),
      () => request("listPrefix", s(r.pick([OWNER, str(r, 8)])), { j: JSON.stringify(r.pick(["public", "private", "legacy", "pub", str(r, 4)])) }),
      () => request("userUri", s(r.pick([OWNER, OTHER, spelled(r, ZBASE32, 52)]))),
      () => request(r.pick(["postUri", "followUri", "muteUri", "bookmarkUri", "tagUri", "fileUri", "feedUri"]), s(r.pick([OWNER, spelled(r, ZBASE32, 52)])), s(str(r, 8))),
      () => request("mimeToExt", s(r.pick(["image/png", "IMAGE/JPEG; q=1", " image/png", "text/xml", "application/octet-stream", "a/b/c", "/", "image/", str(r, 8)]))),
    ])(),
};
