// Reading what is stored at a URI: the path says which object, the object's own rules say
// whether these bytes are one.

import { fail } from "./errors.js";
import { readStored } from "./models/common.js";
import { feed } from "./models/feed.js";
import { checkFile } from "./models/file.js";
import { bookmark, follow, mute, tag } from "./models/graph.js";
import { checkReferences, post } from "./models/post.js";
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
    case "post": {
      if (parsed.editId === undefined) fail("a versionless post reference is never a stored object");
      const read = readStored(post, bytes, parsed.id, publicRoot);
      // The URI names the author, so the ownership rule can run here
      checkReferences(read.value, publicRoot, parsed.userId);
      return json("post", read);
    }
    case "follow":
      return json("follow", readStored(follow, bytes, parsed.id, publicRoot));
    case "mute":
      return json("mute", readStored(mute, bytes, parsed.id, publicRoot));
    case "tag":
      return json("tag", readStored(tag, bytes, parsed.id, publicRoot));
    case "bookmark":
      return json("bookmark", readStored(bookmark, bytes, parsed.id, publicRoot));
    case "feed":
      return json("feed", readStored(feed, bytes, parsed.id, publicRoot));
    case "file":
      checkFile(bytes, parsed.id);
      return { kind: "file", value: bytes, body: bytes };
    case "foreign":
      return fail("a foreign namespace is not a social object");
    case "unsupportedVersion":
      return fail("an unsupported epoch is a skip, not an object");
    case "unknown":
      return fail("Unrecognized resource Unknown");
  }
}
