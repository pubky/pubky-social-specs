import { blake3 } from "@noble/hashes/blake3.js";
import { fail } from "./errors.js";
import { radix } from "./radix.js";
import { utf8, utf8Len } from "./text.js";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ZBASE32 = "ybndrfg8ejkmcpqxot1uwisza345h769";

const crockford = (bytes: Uint8Array): string => radix(bytes, CROCKFORD, 5);

// An id is valid only spelled as the encoder spells it: an alias (`O` for `0`, lowercase)
// would name the same object under another homeserver key. `spare` is the mask of the bits
// the last character holds beyond the value.
function idFault(id: string, chars: number, spare: number): string | null {
  if (utf8Len(id) !== chars) return `Invalid ID length: must be ${chars} ASCII characters`;
  for (const c of id) if (!CROCKFORD.includes(c)) return "non-canonical Crockford character";
  if (CROCKFORD.indexOf(id[chars - 1] as string) & spare) return `non-canonical ID (dangling bit${spare > 1 ? "s" : ""} set)`;
  return null;
}

export const timestampIdFault = (id: string): string | null => idFault(id, 13, 1);
export const hashIdFault = (id: string): string | null => idFault(id, 26, 3);

/** Format only: 52 z-base32 characters whose four spare bits are zero. No curve check. */
function publicKeyFault(key: string): string | null {
  if (utf8Len(key) !== 52) return "the string is not 52 ASCII characters";
  for (const c of key) if (!ZBASE32.includes(c)) return "invalid public key encoding";
  return key.endsWith("y") || key.endsWith("o") ? null : "invalid public key encoding";
}

export const isPublicKey = (key: string): boolean => publicKeyFault(key) === null;

const checked = (fault: (value: string) => string | null) => (value: string, field?: string) => {
  const found = fault(value);
  if (found !== null) fail("format", found, field);
};
export const checkHashId = checked(hashIdFault);
export const checkPublicKey = checked(publicKeyFault);

/** The microseconds a canonical TimestampId spells. No time bound: that is the object's rule. */
export function timestampIdMicros(id: string, field?: string): bigint {
  checked(timestampIdFault)(id, field);
  let acc = 0n;
  for (const c of id) acc = (acc << 5n) | BigInt(CROCKFORD.indexOf(c));
  return BigInt.asIntN(64, acc >> 1n);
}

export function timestampId(micros: bigint): string {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt.asUintN(64, micros));
  return crockford(bytes);
}

/** The one content-addressed id: the first half of a blake3 digest. */
export const hashId = (data: Uint8Array): string => crockford(blake3(data).subarray(0, 16));
export const hashText = (text: string): string => hashId(utf8(text));

/** A media id fed a chunk at a time, for bytes too large to hold twice or to hash in one go. */
export function createMediaHasher(): { update(chunk: Uint8Array): void; id(): string } {
  const hasher = blake3.create();
  return {
    update: (chunk) => void hasher.update(chunk),
    // A clone, so the id can be read and the feed go on
    id: () => crockford(hasher.clone().digest().subarray(0, 16)),
  };
}
