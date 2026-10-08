// Reading and writing what is stored at a URI: the path says which object, the object's own
// rules say whether these bytes are one.

import { fail, misuse } from "./errors.js";
import { type Model, readStored, validate } from "./models/common.js";
import { type Feed, feed } from "./models/feed.js";
import { checkFile } from "./models/file.js";
import { type Bookmark, bookmark, type Edge, follow, mute, type Tag, tag } from "./models/graph.js";
import { checkReferences, post, type Post } from "./models/post.js";
import { type User, user } from "./models/user.js";
import { utf8 } from "./text.js";
import type { ObjectKind, Root } from "./path.js";
import { parse, type Parsed } from "./uri.js";

interface Models {
  user: User;
  post: Post;
  follow: Edge;
  mute: Edge;
  bookmark: Bookmark;
  tag: Tag;
  feed: Feed;
}

/** The model of each stored kind, typed by its own value: a model of another kind does not compile. */
const models: { [K in keyof Models]: Model<Models[K]> } = { user, post, follow, mute, bookmark, tag, feed };

/** The model of a kind known only at run time, its value type erased at this one place. */
export const modelOf = (kind: Exclude<ObjectKind, "file">): Model<unknown> => models[kind];
const isStoredKind = (kind: string): kind is keyof Models => Object.hasOwn(models, kind);

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

function located(uri: string): { kind: ObjectKind; id: string; root: Root; owner: string } {
  const parsed = parse(uri);
  const { kind, id } = stored(parsed);
  // Field by field: spreading the result of stored() made a decode about 10 us slower in V8
  return { kind, id, root: parsed.root, owner: parsed.owner };
}

type Bytes = Uint8Array<ArrayBuffer>;

/** The object stored at `uri`: its kind, its value and its bytes as the package writes them. */
export function read(uri: string, bytes: Uint8Array): { kind: ObjectKind; value: unknown; body: Bytes } {
  const { kind, id, root, owner } = located(uri);
  if (kind === "file") {
    checkFile(bytes, id);
    return { kind, value: bytes, body: bytes as Bytes };
  }
  const publicRoot = root === "public";
  const { value, body } = readStored(modelOf(kind), bytes, id, publicRoot);
  // The URI names the author, so the ownership rule can run here
  if (kind === "post") checkReferences(value as Post, publicRoot, owner);
  return { kind, value, body: utf8(body) };
}

/**
 * The bytes of a caller's object, checked as `read` checks them at `at`. Without a URI the
 * object is checked by the rules that need no id and no author.
 */
export function write(at: string | { kind: ObjectKind; root: Root }, js: unknown): Bytes {
  const { kind, id, root, owner } = typeof at === "string" ? located(at) : { kind: at.kind, id: null, root: at.root, owner: null };
  const publicRoot = root === "public";
  if (kind === "file") {
    if (!(js instanceof Uint8Array)) return misuse("object", "the bytes of the media");
    checkFile(js, id);
    return js as Bytes;
  }
  if (!isStoredKind(kind)) misuse("kind", "an object kind");
  if (ArrayBuffer.isView(js)) misuse("object", `the decoded ${kind}, not its bytes`);
  const model = modelOf(kind);
  const value = model.codec.parse(js, kind);
  const body = validate(model, value, id, publicRoot);
  if (owner !== null && kind === "post") checkReferences(value as Post, publicRoot, owner);
  return utf8(body);
}
