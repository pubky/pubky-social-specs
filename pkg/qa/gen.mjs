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
};
