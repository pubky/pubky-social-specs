// The package entry. Every function here is the wasm export of the same name behind three
// checks: the wasm is loaded, each argument has the type its slot takes, and every string
// argument is well-formed UTF-16. A Rust string cannot hold a lone surrogate, and the boundary
// would replace one silently, so a value would be validated and stored as something the caller
// never wrote. Objects cross as JSON.stringify text, whose parser refuses a lone surrogate.
//
// index.cjs is generated from this file at build time: keep relative imports of `.js` files
// and one closing `export { ... };`.

import * as glue from "./pubky_social_specs.js";
import { validationLimits } from "./validationLimits.js";
import { validMimeTypes, mimeToExtTable } from "./mimeTypes.js";
import { skipReasons, transformRev } from "./migrationData.js";

const MALFORMED = "Validation Error: text must be well-formed UTF-16";

let ready = false;
let loading = null;

/** Loads the wasm. Call once and await it before anything else; later calls are free. */
function init() {
  if (!loading) {
    loading = glue.__wbg_init().then(
      () => {
        ready = true;
      },
      (error) => {
        // A failed load can be retried
        loading = null;
        throw error;
      },
    );
  }
  return loading;
}

function wellFormed(text) {
  if (typeof text.isWellFormed === "function") return text.isWellFormed();
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xdc00 && unit <= 0xdfff) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    }
  }
  return true;
}

// What each argument slot takes. A value of another type never reaches the wasm, where a
// non-string in a string slot reads memory it does not own.
// A typed array or a DataView is an object too, and its JSON form is one member per byte
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v) && !ArrayBuffer.isView(v);
// The glue allocates what `length` reports and copies what the view holds, so a subclass whose
// getter lies would write past its allocation: the view's own length has to agree with it
const TypedArray = Object.getPrototypeOf(Uint8Array.prototype);
const intrinsicLength = Object.getOwnPropertyDescriptor(TypedArray, "length").get;
const intrinsicBuffer = Object.getOwnPropertyDescriptor(TypedArray, "buffer").get;
// Any realm's Uint8Array (or a Buffer): a view of single bytes
const isBytes = (v) => {
  if (!ArrayBuffer.isView(v) || v.BYTES_PER_ELEMENT !== 1) return false;
  try {
    // A detached buffer reads as empty but fails the glue's copy; a view over it throws here
    new Uint8Array(intrinsicBuffer.call(v), 0, 0);
    return intrinsicLength.call(v) === v.length;
  } catch {
    return false; // a DataView has no intrinsic length
  }
};
const KINDS = {
  string: [(v) => typeof v === "string", "a string"],
  "string?": [(v) => v === undefined || v === null || typeof v === "string", "a string or absent"],
  bytes: [isBytes, "a Uint8Array"],
  object: [isObject, "an object"],
  "object?": [(v) => v === undefined || v === null || isObject(v), "an object or absent"],
  array: [(v) => Array.isArray(v), "an array"],
  // Array.from visits the holes of a sparse array, which every() skips
  strings: [
    (v) => Array.isArray(v) && Array.from(v).every((s) => typeof s === "string"),
    "an array of strings",
  ],
  // A JS number the wasm reads as a size: a fraction or a negative would be converted silently
  size: [(v) => Number.isSafeInteger(v) && v >= 0, "a non-negative integer"],
  // A live handle this glue made: one from the other entry holds a pointer into another
  // instance, and a freed or finished one holds none
  hasher: [(v) => v instanceof glue.Hasher && v.__wbg_ptr !== 0, "a Hasher handle"],
  migration: [(v) => v instanceof glue.Migration && v.__wbg_ptr !== 0, "a Migration handle"],
};

// A string argument, and each string of a `strings` slot, reaches the wasm as it is
function wellFormedArgument(slot, value) {
  if (typeof value === "string") return wellFormed(value);
  return slot !== "strings" || value.every(wellFormed);
}

// The longest string any object holds is a post's content, so a longer argument can only be
// refused; refusing it here keeps it out of linear memory, which never shrinks. A `strings`
// slot lists paths or URIs, so each entry is bounded like a reference
const STRING_CAP = validationLimits.postMaxBytes;
const ENTRY_CAP = validationLimits.referenceUriMaxLength;
function overCap(slot, value) {
  if (typeof value === "string") return value.length > STRING_CAP ? `is over ${STRING_CAP} characters` : undefined;
  if (slot !== "strings") return undefined;
  return value.some((s) => s.length > ENTRY_CAP) ? `has an entry over ${ENTRY_CAP} characters` : undefined;
}

function wrap(name, ...slots) {
  const inner = glue[name];
  if (typeof inner !== "function") throw new Error(`pubky-social-specs: the build lacks ${name}`);
  return (...args) => {
    if (!ready) {
      throw new Error(`pubky-social-specs: await init() before calling ${name}()`);
    }
    if (args.length > slots.length) {
      throw new Error(`Validation Error: ${name}() takes at most ${slots.length} arguments`);
    }
    slots.forEach((slot, i) => {
      const [accepts, what] = KINDS[slot];
      // The wasm reads an array again after the check, element by element, so it gets a plain
      // copy made here: a throwing iterator or getter is this slot's error, never an exception
      // unwinding through the wasm
      if ((slot === "strings" || slot === "array") && Array.isArray(args[i])) {
        try {
          args[i] = Array.from(args[i]);
        } catch {
          throw new Error(`Validation Error: ${name}() argument ${i + 1} must be ${what}`);
        }
      }
      if (!accepts(args[i])) {
        throw new Error(`Validation Error: ${name}() argument ${i + 1} must be ${what}`);
      }
      const over = overCap(slot, args[i]);
      if (over !== undefined) throw new Error(`Validation Error: ${name}() argument ${i + 1} ${over}`);
      if (!wellFormedArgument(slot, args[i])) throw new Error(MALFORMED);
    });
    return inner(...args);
  };
}

// Reading
const parseUri = wrap("parseUri", "string");
const stableId = wrap("stableId", "string");
const resolveDeref = wrap("resolveDeref", "string", "string");
const readObject = wrap("readObject", "string", "bytes");
const validate = wrap("validate", "string", "object");
// Profile and posts
const createUser = wrap("createUser", "string", "object");
const createPost = wrap("createPost", "string", "object");
const createArticlePost = wrap("createArticlePost", "string", "object");
const createCollectionPost = wrap("createCollectionPost", "string", "object");
const createVersion = wrap("createVersion", "string", "object", "object?");
const editVersion = wrap("editVersion", "string", "object", "object");
const planPublish = wrap("planPublish", "string", "string", "string", "object");
const planUnpublish = wrap("planUnpublish", "string", "strings", "strings", "string?");
const planDelete = wrap("planDelete", "string", "string", "strings", "array", "array");
// Feeds
const createFeed = wrap("createFeed", "string", "object");
const feedId = wrap("feedId", "object");
const feedPaths = wrap("feedPaths", "string");
const feedLifecycle = wrap("feedLifecycle", "string");
// Tags, bookmarks, graph
const createTag = wrap("createTag", "string", "string", "string");
const createBookmark = wrap("createBookmark", "string", "string");
const bookmarkFilename = wrap("bookmarkFilename", "string");
const bookmarkTarget = wrap("bookmarkTarget", "string", "object?");
const createFollow = wrap("createFollow", "string", "string");
const createMute = wrap("createMute", "string", "string");
// Media
const createFile = wrap("createFile", "string", "bytes", "string", "string?");
const Hasher = glue.Hasher;
const hasherNew = wrap("hasherNew");
const hasherUpdate = wrap("hasherUpdate", "hasher", "bytes");
const hasherFinish = wrap("hasherFinish", "hasher");
const mimeToExt = wrap("mimeToExt", "string");
const essence = wrap("essence", "string");
// Deletion, prefixes and URIs
const deletionPathsPlain = wrap("deletionPaths", "object");
// The wasm reads `listings` one copy at a time and the rest as JSON, so the input is made plain
// here first: `toJSON` applies to the whole value, as JSON.stringify would, and `listings` is
// copied; anything that throws on the way is the argument's error, not an exception inside the
// wasm
const deletionPaths = (input, ...rest) => {
  let plain = input;
  try {
    if (isObject(plain) && typeof plain.toJSON === "function") plain = plain.toJSON("");
    if (isObject(plain)) {
      plain = { ...plain };
      if (Array.isArray(plain.listings)) plain.listings = Array.from(plain.listings);
    }
  } catch {
    throw new Error("Validation Error: deletionPaths() argument 1 must be an object");
  }
  return deletionPathsPlain(plain, ...rest);
};
const listPrefix = wrap("listPrefix", "string", "string");
const legacyListPrefix = wrap("legacyListPrefix", "string");
const userUriBuilder = wrap("userUriBuilder", "string");
const postUriBuilder = wrap("postUriBuilder", "string", "string");
const followUriBuilder = wrap("followUriBuilder", "string", "string");
const muteUriBuilder = wrap("muteUriBuilder", "string", "string");
const bookmarkUriBuilder = wrap("bookmarkUriBuilder", "string", "string");
const tagUriBuilder = wrap("tagUriBuilder", "string", "string");
const fileUriBuilder = wrap("fileUriBuilder", "string", "string");
const feedUriBuilder = wrap("feedUriBuilder", "string", "string");
// Migration; the package is built with the transforms, so the exports are always there
const Migration = glue.Migration;
const createMigration = wrap("createMigration", "string");
const migrate = wrap("migrate", "migration", "string", "bytes");
const migrateBlob = wrap("migrateBlob", "migration", "string", "size", "string");

export {
  init,
  validationLimits,
  validMimeTypes,
  mimeToExtTable,
  skipReasons,
  transformRev,
  parseUri,
  stableId,
  resolveDeref,
  readObject,
  validate,
  createUser,
  createPost,
  createArticlePost,
  createCollectionPost,
  createVersion,
  editVersion,
  planPublish,
  planUnpublish,
  planDelete,
  createFeed,
  feedId,
  feedPaths,
  feedLifecycle,
  createTag,
  createBookmark,
  bookmarkFilename,
  bookmarkTarget,
  createFollow,
  createMute,
  createFile,
  Hasher,
  hasherNew,
  hasherUpdate,
  hasherFinish,
  mimeToExt,
  essence,
  deletionPaths,
  listPrefix,
  legacyListPrefix,
  userUriBuilder,
  postUriBuilder,
  followUriBuilder,
  muteUriBuilder,
  bookmarkUriBuilder,
  tagUriBuilder,
  fileUriBuilder,
  feedUriBuilder,
  Migration,
  createMigration,
  migrate,
  migrateBlob,
};
