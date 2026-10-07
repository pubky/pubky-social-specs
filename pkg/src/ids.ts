import { blake3 } from "@noble/hashes/blake3.js";
import { fail } from "./errors.js";
import { utf8Len } from "./text.js";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ZBASE32 = "ybndrfg8ejkmcpqxot1uwisza345h769";

/** Unpadded: five bits a character from the top, the last one zero-filled. */
export function crockford(bytes: Uint8Array): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(acc >> bits) & 31];
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += CROCKFORD[(acc << (5 - bits)) & 31];
  return out;
}

// An id is valid only spelled as the encoder spells it: an alias (`O` for `0`, lowercase)
// would name the same object under another homeserver key
function canonicalDigits(id: string, chars: number): number[] {
  if (utf8Len(id) !== chars) fail(`Invalid ID length: must be ${chars} ASCII characters`);
  const digits: number[] = [];
  for (const c of id) {
    const digit = CROCKFORD.indexOf(c);
    if (digit < 0) fail("non-canonical Crockford character");
    digits.push(digit);
  }
  return digits;
}

/** The microseconds a canonical TimestampId spells. No time bound: that is the object's rule. */
export function timestampIdMicros(id: string): bigint {
  const digits = canonicalDigits(id, 13);
  if ((digits[12] as number) & 1) fail("non-canonical ID (dangling bit set)");
  let acc = 0n;
  for (const digit of digits) acc = (acc << 5n) | BigInt(digit);
  return BigInt.asIntN(64, acc >> 1n);
}

export function timestampId(micros: bigint): string {
  const bytes = new Uint8Array(8);
  let rest = BigInt.asUintN(64, micros);
  for (let i = 7; i >= 0; i--) {
    bytes[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return crockford(bytes);
}

export function checkHashId(id: string): void {
  const digits = canonicalDigits(id, 26);
  if ((digits[25] as number) & 0b11) fail("non-canonical ID (dangling bits set)");
}

/** The first half of a blake3 digest, the one content-addressed id body. */
export function hashIdOf(digest: Uint8Array): string {
  return crockford(digest.subarray(0, 16));
}

export function hashId(data: Uint8Array): string {
  return hashIdOf(blake3(data));
}

/** A media id fed a chunk at a time, for bytes too large to hold twice. */
export function mediaHasher(): { update(chunk: Uint8Array): void; id(): string } {
  const hasher = blake3.create();
  return {
    update: (chunk) => void hasher.update(chunk),
    // A clone, so the id can be read and the feed go on
    id: () => hashIdOf(hasher.clone().digest()),
  };
}

/** Format only: 52 z-base32 characters whose four dangling bits are zero. No curve check. */
export function checkPublicKey(key: string): void {
  if (utf8Len(key) !== 52) fail("the string is not 52 ASCII characters");
  for (const c of key) if (!ZBASE32.includes(c)) fail("invalid public key encoding");
  if (!key.endsWith("y") && !key.endsWith("o")) fail("invalid public key encoding");
}
