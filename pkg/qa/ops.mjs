// Each oracle operation as the package answers it, in the oracle's own shape: stored bytes as
// base64, a refusal as its message. Wherever the public entry has the function, that is what
// is called, so the scoreboard measures what a caller gets. The URI builders are the one
// exception: the reference spells any id, and the public `buildUri` refuses one its parser
// would not read back, so the spelling is scored on the package's own unchecked builder.

import * as api from "../dist/index.js";
import * as text from "../dist/text.js";
import * as ids from "../dist/ids.js";
import * as canon from "../dist/canonicalize.js";
import * as uri from "../dist/uri.js";
import { mimeToExt } from "../dist/mime.js";
import { JsonError, readJson } from "../dist/json/read.js";
import { writeJson } from "../dist/json/write.js";
import * as objects from "../dist/objects.js";
import * as graph from "../dist/models/graph.js";
import * as posts from "../dist/models/post.js";
import { feed } from "../dist/models/feed.js";
import { parse, readStored } from "../dist/models/common.js";
import { lastMint, pin } from "../dist/clock.js";

const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const bytes = (arg) => ("j" in arg ? text.utf8(arg.j) : new Uint8Array(Buffer.from(arg.b, "base64")));
const json = (arg) => arg?.j ?? "null";
const same = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i]);
// A built object as the oracle reports it: no `object`, the body as base64
const built = ({ object, body, ...where }) => ({ ...where, body: b64(body) });
// Stored text as a caller would hold it after a read
const held = (codec, arg) => codec.plain(parse(codec, json(arg)));
const plain = (f) => (...args) => f(...args.map((a) => a.s));

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
  stableKey: plain(uri.stableKey),
  legacyMediaKey: plain(uri.legacyMediaKey),

  // The reader's answer, and on top of it what a caller gets: read, then written back
  // untouched, has to give the same bytes
  decode(a, stored) {
    const read = objects.read(a.s, bytes(stored));
    const decoded = api.decodeObject(a.s, bytes(stored));
    const again = api.encodeObject(a.s, decoded.kind === "file" ? decoded.bytes : decoded.object);
    if (!same(again, read.body)) throw new Error(`a round trip changed the bytes: ${text.utf8Text(again)}`);
    return { kind: read.kind, body: b64(read.body) };
  },
  encodeKind: (kind, root, stored) => b64(api.encodeObject({ kind: kind.s, root: JSON.parse(json(root)) }, held(objects.models[kind.s].codec, stored))),
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
  createTag: (a, b, c) => built(api.buildTag(a.s, b.s, c.s)),
  createBookmark: (a, b) => built(api.buildBookmark(a.s, b.s)),
  bookmarkTarget(a, content) {
    const blank = { created_at: 0n, target: null, extra: new Map() };
    return graph.targetOf(a.s, json(content) === "null" ? blank : readStored(graph.bookmark, text.utf8(content.j), a.s, false).value);
  },
  createFollow: (a, b) => built(api.buildFollow(a.s, b.s)),
  createMute: (a, b) => built(api.buildMute(a.s, b.s)),
  createFile: (a, data, type, root) => api.buildFile(a.s, { bytes: bytes(data), type: type.s, root: JSON.parse(json(root)) }),

  planPublish(a, version) {
    ids.checkPublicKey(a.s);
    const { id, editId, post } = JSON.parse(version.j);
    const plan = api.planPublish(a.s, { id, editId, post: held(posts.post.codec, { j: JSON.stringify(post) }) });
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
  userUri: (a) => api.buildUri(a.s, "user"),
  postUri: (a, b) => uri.build(a.s, "post", b.s),
  followUri: (a, b) => uri.build(a.s, "follow", b.s),
  muteUri: (a, b) => uri.build(a.s, "mute", b.s),
  bookmarkUri: (a, b) => uri.build(a.s, "bookmark", b.s),
  tagUri: (a, b) => uri.build(a.s, "tag", b.s),
  fileUri: (a, b) => uri.build(a.s, "file", b.s),
  feedUri: (a, b) => uri.build(a.s, "feed", b.s),
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
