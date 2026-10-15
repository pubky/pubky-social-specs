// The one bit packer behind Crockford base32 ids and base64url bookmark ids.

/** Unpadded: `bits` bits a character from the top, the last one zero-filled. */
export function radix(bytes: Uint8Array, alphabet: string, bits: number): string {
  let out = "";
  let acc = 0;
  let held = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    held += 8;
    while (held >= bits) {
      held -= bits;
      out += alphabet.charAt((acc >> held) & ((1 << bits) - 1));
    }
    acc &= (1 << held) - 1;
  }
  if (held > 0) out += alphabet.charAt((acc << (bits - held)) & ((1 << bits) - 1));
  return out;
}
