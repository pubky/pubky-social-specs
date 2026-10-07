// Unpadded base64url, the spelling of a bookmark target inside its id.

import { radix } from "./ids.js";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export const encode = (bytes: Uint8Array): string => radix(bytes, ALPHABET, 6);

/** The bytes of `text`, or null unless it is exactly what `encode` writes for them. */
export function decode(text: string): Uint8Array | null {
  if (text.length % 4 === 1) return null;
  const bytes = new Uint8Array(Math.floor((text.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let at = 0;
  for (const c of text) {
    const digit = ALPHABET.indexOf(c);
    if (digit < 0) return null;
    acc = (acc << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[at++] = (acc >> bits) & 0xff;
      acc &= (1 << bits) - 1;
    }
  }
  // Set trailing bits would name one target under a second id
  return acc === 0 ? bytes : null;
}
