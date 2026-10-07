// Reading what is stored at a URI: the path says which object, the object's own rules say
// whether these bytes are one.

import { fail } from "./errors.js";
import { readStored } from "./models/common.js";
import { user } from "./models/user.js";
import { parseUri } from "./uri.js";

const encoder = new TextEncoder();

/** The kind of the object at `uri` and its bytes as the package writes them back. */
export function readObject(uri: string, bytes: Uint8Array): { kind: string; value: unknown; body: Uint8Array } {
  const parsed = parseUri(uri);
  const publicRoot = parsed.root === "public";
  const json = <T>(kind: string, read: { value: T; body: string }) => ({ kind, value: read.value, body: encoder.encode(read.body) });
  switch (parsed.kind) {
    case "user":
      return json("user", readStored(user, bytes, "", publicRoot));
    case "foreign":
      return fail("a foreign namespace is not a social object");
    case "unsupportedVersion":
      return fail("an unsupported epoch is a skip, not an object");
    case "unknown":
      return fail("Unrecognized resource Unknown");
    default:
      throw new Error(`unported kind ${parsed.kind}`);
  }
}
