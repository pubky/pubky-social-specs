// Reading and writing what is stored at a URI: the path says which object, the object's own
// rules say whether these bytes are one.

import { fail, misuse, nameOf } from "./errors.js";
import { type Model, readStored, validate } from "./models/common.js";
import { type Feed, feed } from "./models/feed.js";
import { checkFile } from "./models/file.js";
import { type Bookmark, bookmark, type Edge, follow, mute, type Tag, tag } from "./models/graph.js";
import { checkReferences, checkVersion, post, type Post } from "./models/post.js";
import { type User, user } from "./models/user.js";
import { utf8 } from "./text.js";
import { OBJECT_KINDS, type ObjectKind, type Root } from "./path.js";
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
function stored(parsed: Parsed, uri: string): { kind: ObjectKind; id: string; editId: string | null } {
  switch (parsed.kind) {
    case "foreign":
      return fail("path", "a foreign namespace is not a social object");
    case "unsupportedVersion":
      return fail("path", "an unsupported epoch is a skip, not an object");
    case "unknown":
      return fail("path", "the path names no social object");
    case "user":
      // `pubky://<pk>` is a reference to the user; their profile is stored at a path
      if (parsed.path === "") fail("path", `a bare owner URL names a user, not a stored object: ${uri}`);
      return { kind: "user", id: "", editId: null };
    case "post":
      if (parsed.editId === undefined) fail("path", "a versionless post reference is never a stored object");
      return { kind: "post", id: parsed.id, editId: parsed.editId };
  }
  return { kind: parsed.kind, id: parsed.id, editId: null };
}

function located(uri: string): { kind: ObjectKind; id: string; editId: string | null; root: Root; owner: string } {
  const parsed = parse(uri);
  const { kind, id, editId } = stored(parsed, uri);
  // Field by field: spreading the result of stored() made a decode about 10 us slower in V8
  return { kind, id, editId, root: parsed.root, owner: parsed.owner };
}

type Bytes = Uint8Array<ArrayBuffer>;

/** The object stored at `uri`, its kind and its value; for media the value is the bytes. */
export function read(uri: string, bytes: Uint8Array): { kind: ObjectKind; value: unknown } {
  const { kind, id, editId, root, owner } = located(uri);
  if (kind === "file") {
    checkFile(bytes, id);
    return { kind, value: bytes };
  }
  const publicRoot = root === "public";
  const value = readStored(modelOf(kind), bytes, id, publicRoot);
  if (editId !== null) checkVersion(id, editId);
  // The URI names the author, so the ownership rule can run here
  if (kind === "post") checkReferences(value as Post, publicRoot, owner);
  return { kind, value };
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
  if (!isStoredKind(nameOf(kind, "kind", OBJECT_KINDS))) misuse("kind", "an object kind");
  if (ArrayBuffer.isView(js)) misuse("object", `the decoded ${kind}, not its bytes`);
  const model = modelOf(kind);
  const value = model.codec.parse(js, kind);
  const body = validate(model, value, id, publicRoot);
  if (owner !== null && kind === "post") checkReferences(value as Post, publicRoot, owner);
  return utf8(body);
}
