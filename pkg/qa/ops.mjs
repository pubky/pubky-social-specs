// Each oracle operation as the package answers it, in the oracle's own shape: stored bytes as
// base64, a refusal as its message. Wherever the public entry has the function, that is what
// is called, so the scoreboard measures what a caller gets.

import * as api from "../dist/index.js";
import * as text from "../dist/text.js";
import * as ids from "../dist/ids.js";
import * as canon from "../dist/canonicalize.js";
import * as legacy from "../dist/legacy.js";
import { mimeToExt } from "../dist/mime.js";
import { JsonError, readJson } from "../dist/json/read.js";
import { writeJson } from "../dist/json/write.js";
import * as objects from "../dist/objects.js";
import * as graph from "../dist/models/graph.js";
import * as posts from "../dist/models/post.js";
import { feed } from "../dist/models/feed.js";
import { parse, readStored, validate } from "../dist/models/common.js";
import { rootOf } from "../dist/json/schema.js";
import { lastMint, pin } from "../dist/clock.js";
import { sameBytes } from "./lib.mjs";

const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const bytes = (arg) => ("j" in arg ? text.utf8(arg.j) : new Uint8Array(Buffer.from(arg.b, "base64")));
const json = (arg) => arg?.j ?? "null";
// A built object as the oracle reports it: no `object`, the body as base64
const built = ({ object, body, ...where }) => ({ ...where, body: b64(body) });
const SAFE = 2n ** 53n;
const unsafe = (v) => (typeof v === "bigint" ? v > SAFE || v < -SAFE : v !== null && typeof v === "object" && Object.values(v).some(unsafe));
// Stored text as a caller would hold it after a read. A number holds 2^53 exactly and no integer
// past it, so a request that needs one is a fault of the generator
function held(codec, arg) {
  const value = parse(codec, json(arg));
  if (unsafe(value)) throw new Error("qa: no caller holds an integer past 2^53");
  return codec.plain(value);
}
const plain =
  (f) =>
  (...args) =>
    f(...args.map((a) => a.s));

const ops = {
  frozenTrim: plain(text.frozenTrim),
  asciiFold: plain(text.asciiFold),
  codePointLen: plain(text.codePointLen),
  debug: plain(text.debugQuote),
  publicKey: (a) => (ids.checkPublicKey(a.s), a.s),
  timestampId: (a) => ids.timestampIdMicros(a.s).toString(),
  hashId: (a) => (ids.checkHashId(a.s), null),
  mediaId: (a) => ids.hashId(bytes(a)),
  canonicalPubky: plain(canon.canonicalPubky),
  canonicalWeb: plain(canon.canonicalWeb),
  canonicalExternal: plain(canon.canonicalExternal),
  canonicalUniversal: plain(canon.canonicalUniversal),
  json: (a) => b64(text.utf8(writeJson(readJson(a.j)))),
  mimeToExt: plain(mimeToExt),
  stableKey: plain(legacy.stableKey),
  legacyMediaKey: plain(legacy.legacyMediaKey),

  // The reader's answer, and on top of it what a caller gets: read, then written back
  // untouched, gives the same bytes, or the cap's refusal when the members the reader filled in
  // carry the written form over it, as the reference's validate does
  decode(a, stored) {
    const read = objects.read(a.s, bytes(stored));
    const body = read.kind === "file" ? read.value : text.utf8(objects.modelOf(read.kind).codec.write(read.value));
    const decoded = api.decodeObject(a.s, bytes(stored));
    try {
      const again = api.encodeObject(a.s, decoded.kind === "file" ? decoded.bytes : decoded.object);
      if (!sameBytes(again, body)) throw new Error(`a round trip changed the bytes: ${text.utf8Text(again)}`);
    } catch (e) {
      if (!(e instanceof api.ValidationError && e.code === "size" && body.length > e.limit)) throw e;
    }
    return { kind: read.kind, body: b64(body) };
  },
  encodeKind(kind, root, stored) {
    const model = objects.modelOf(kind.s);
    const value = parse(model.codec, json(stored));
    // Checked by the rules encodeObject runs once it has parsed, on the exact integer a caller
    // could not have handed over
    if (unsafe(value)) return b64(text.utf8(validate(model, value, null, rootOf(JSON.parse(json(root)), "at.root") === "public")));
    return b64(api.encodeObject({ kind: kind.s, root: JSON.parse(json(root)) }, model.codec.plain(value)));
  },
  // `filename` is the package's addition, so `buildUri` takes back what this gives
  parseUri: (a) => (({ filename: _, ...parsed }) => parsed)(api.parseUri(a.s)),

  createUser: (a, input) => built(api.buildUser(a.s, JSON.parse(input.j))),
  createPost: (a, input) => built(api.buildPost(a.s, JSON.parse(input.j))),
  editPost(a, stored, at) {
    ids.checkPublicKey(a.s);
    const value = parse(posts.post.codec, json(stored));
    const { id, head, root, slug } = JSON.parse(at.j);
    const made = posts.editPost(a.s, value, id, head, root ?? "public", slug ?? null);
    return { id: made.id, editId: made.editId, path: made.path, url: `pubky://${a.s}${made.path}`, body: b64(text.utf8(made.body)) };
  },
  createFeed: (a, input) => built(api.buildFeed(a.s, JSON.parse(input.j))),
  feedId: (a) => api.feedId(held(feed.codec, a)),
  feedPaths: (a) => api.feedPaths(a.s),
  createTag: (a, b, c) => built(api.buildTag(a.s, b.s, c.s)),
  createBookmark: (a, b) => built(api.buildBookmark(a.s, b.s)),
  bookmarkTarget(a, content) {
    const blank = { created_at: 0n, target: null, extra: new Map() };
    return graph.targetOf(a.s, json(content) === "null" ? blank : readStored(graph.bookmark, text.utf8(content.j), a.s, false));
  },
  createFollow: (a, b) => built(api.buildFollow(a.s, b.s)),
  createMute: (a, b) => built(api.buildMute(a.s, b.s)),
  createFile: (a, data, type, root) => api.buildFile(a.s, { bytes: bytes(data), type: type.s, root: JSON.parse(json(root)) }),

  planPublish(a, version) {
    ids.checkPublicKey(a.s);
    const { id, editId, post, slug } = JSON.parse(version.j);
    const plan = api.planPublish(a.s, { id, editId, post: held(posts.post.codec, { j: JSON.stringify(post) }), slug });
    return { copies: plan.copies, put: built(plan.put) };
  },
  planUnpublish: (post) => api.planUnpublish(JSON.parse(post.j)),
  planDelete(a, post) {
    ids.checkPublicKey(a.s);
    const given = JSON.parse(post.j);
    const versions = given.versions?.map((version) => held(posts.post.codec, { j: JSON.stringify(version) }));
    return api.planDelete(a.s, { ...given, versions });
  },
  deletionPaths: (target) => api.deletionPaths(JSON.parse(target.j)),

  listPrefix: (a, tree) => api.listPrefix(a.s, JSON.parse(tree.j)),
  buildUri: (a, b, c) => api.buildUri(a.s, b.s, c.s),
};

/** `{ok, last}` or `{err, last}`, as the oracle answers the same request. */
export function answer({ op, args = [], now, last }) {
  if (!(op in ops)) return { missing: op };
  pin(() => BigInt(now), BigInt(last));
  const after = () => Number(lastMint());
  try {
    return { ok: ops[op](...args) ?? null, last: after() };
  } catch (e) {
    if (e instanceof JsonError) return { err: `Validation Error: ${e.message}`, last: after() };
    // Anything else, a TypeError included, is a fault of the package or of the generator
    if (!(e instanceof api.ValidationError)) throw e;
    return { err: e.message, last: after() };
  }
}
