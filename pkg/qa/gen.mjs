// Seeded requests per family. A case is its family, its seed and its index, so a mismatch is
// replayed from three numbers.

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

const s = (value) => ({ s: value });
const request = (op, ...args) => ({ op, args, now: NOW, last: 0 });

export const families = {
  text: (r) => request(r.pick(["frozenTrim", "asciiFold", "codePointLen"]), s(str(r))),
  ids: (r) =>
    r.pick([
      () => request("publicKey", s(r.chance(0.5) ? spelled(r, ZBASE32, 52) : r.pick([OWNER, OTHER, str(r, 60)]))),
      () => request("timestampId", s(r.chance(0.5) ? spelled(r, CROCKFORD, 13) : timestampIdOf(NOW + r.below(1e9)))),
      () => request("hashId", s(spelled(r, CROCKFORD, 26))),
      () => request("mediaId", { b: Buffer.from(r.many(200, () => r.below(256))).toString("base64") }),
    ])(),
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
