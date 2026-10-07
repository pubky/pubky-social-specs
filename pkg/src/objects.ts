// Reading and writing what is stored at a URI: the path says which object, the object's own
// rules say whether these bytes are one.

import { fail, misuse } from "./errors.js";
import { type Model, readStored, validate } from "./models/common.js";
import { feed } from "./models/feed.js";
import { checkFile } from "./models/file.js";
import { bookmark, follow, mute, tag } from "./models/graph.js";
import { checkReferences, post, type Post } from "./models/post.js";
import { user } from "./models/user.js";
import { utf8 } from "./text.js";
import { type ObjectKind, parse, type Parsed, type Root } from "./uri.js";

export const models: Record<Exclude<ObjectKind, "file">, Model<any>> = { user, post, follow, mute, bookmark, tag, feed };

// What a path names that is no stored object
function stored(parsed: Parsed): { kind: ObjectKind; id: string } {
  switch (parsed.kind) {
    case "foreign":
      return fail("a foreign namespace is not a social object");
    case "unsupportedVersion":
      return fail("an unsupported epoch is a skip, not an object");
    case "unknown":
      return fail("Unrecognized resource Unknown");
    case "user":
      return { kind: "user", id: "" };
    case "post":
      if (parsed.editId === undefined) fail("a versionless post reference is never a stored object");
  }
  return { kind: parsed.kind, id: parsed.id };
}

type Bytes = Uint8Array<ArrayBuffer>;

/** The object stored at `uri`: its kind, its value and its bytes as the package writes them. */
export function read(uri: string, bytes: Uint8Array): { kind: ObjectKind; value: unknown; body: Bytes } {
  const parsed = parse(uri);
  const { kind, id } = stored(parsed);
  if (kind === "file") {
    checkFile(bytes, id);
    return { kind, value: bytes, body: bytes as Bytes };
  }
  const publicRoot = parsed.root === "public";
  const { value, body } = readStored(models[kind], bytes, id, publicRoot);
  // The URI names the author, so the ownership rule can run here
  if (kind === "post") checkReferences(value as Post, publicRoot, parsed.owner);
  return { kind, value, body: utf8(body) };
}

/**
 * The bytes of a caller's object, checked as `read` checks them at `at`. Without a URI the
 * object is checked by the rules that need no id and no author.
 */
export function write(at: string | { kind: ObjectKind; root?: Root }, js: unknown): Bytes {
  const where = typeof at === "string" ? parse(at) : null;
  const { kind, id } = where ? stored(where) : { kind: (at as { kind: ObjectKind }).kind, id: null };
  const publicRoot = (where?.root ?? (at as { root?: Root }).root ?? "public") === "public";
  if (kind === "file") {
    if (!(js instanceof Uint8Array)) misuse("object", "the bytes of the media");
    checkFile(js, id);
    return js as Bytes;
  }
  if (!Object.hasOwn(models, kind)) misuse("kind", "an object kind");
  const model = models[kind];
  const value = model.codec.parse(js, kind);
  const body = validate(model, value, id, publicRoot);
  if (where && kind === "post") checkReferences(value as Post, publicRoot, where.owner);
  return utf8(body);
}
