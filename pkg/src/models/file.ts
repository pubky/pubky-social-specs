import { limits } from "../data.js";
import { fail } from "../errors.js";
import { checkPublicKey, hashId } from "../ids.js";
import { mimeToExt } from "../mime.js";
import { type Root, socialPath } from "../uri.js";

/** Media is raw bytes with no JSON form: not empty, under the cap, named by its hash. */
export function checkFile(bytes: Uint8Array, id: string | null): string {
  if (bytes.length === 0) fail("File size cannot be zero");
  if (bytes.length > limits.maxFileSizeBytes) fail("File size exceeds maximum limit of 100MB");
  const hash = hashId(bytes);
  if (id !== null && hash !== id) fail(`Invalid ID: expected ${hash}, found ${id}`);
  return hash;
}

/** Where media goes. The declared type picks the extension and is never stored. */
export function buildFile(owner: string, bytes: Uint8Array, declaredType: string, root: Root) {
  checkPublicKey(owner);
  const id = checkFile(bytes, null);
  return { id, path: socialPath(root, `files/${id}.${mimeToExt(declaredType)}`) };
}
