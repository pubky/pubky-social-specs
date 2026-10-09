import { limits } from "../data.js";
import { fail } from "../errors.js";
import { checkHashId, checkPublicKey, hashId } from "../ids.js";
import { mimeToExt } from "../mime.js";
import { type Root, socialPath } from "../path.js";

/** Media is raw bytes with no JSON form: not empty, under the cap, named by its hash. */
export function checkFile(bytes: Uint8Array, id: string | null): string {
  if (bytes.length === 0) fail("blank", "File size cannot be zero", "bytes");
  // The reference's own words, which name the cap as text
  if (bytes.length > limits.maxFileSizeBytes) fail("size", "File size exceeds maximum limit of 100MB", "bytes", limits.maxFileSizeBytes);
  const hash = hashId(bytes);
  if (id !== null && hash !== id) fail("id", `Invalid ID: expected ${hash}, found ${id}`, "id");
  return hash;
}

/**
 * Where media goes, from its bytes or from an id hashed elsewhere. The declared type picks
 * the extension and is never stored.
 */
export function buildFile(owner: string, source: { bytes: Uint8Array } | { id: string }, declaredType: string, root: Root) {
  checkPublicKey(owner);
  let id: string;
  if ("bytes" in source) id = checkFile(source.bytes, null);
  else {
    id = source.id;
    checkHashId(id, "id");
  }
  return { id, path: socialPath(root, `files/${id}.${mimeToExt(declaredType)}`) };
}
