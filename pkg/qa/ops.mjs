// Each oracle operation as the package answers it, in the oracle's own shape: stored bytes as
// base64, a refusal as its message. An operation the package lacks is reported as missing, so
// the scoreboard counts it instead of crashing.

import * as text from "../dist/text.js";
import * as ids from "../dist/ids.js";
import * as canon from "../dist/canonicalize.js";
import * as uri from "../dist/uri.js";
import { mimeToExt } from "../dist/mime.js";
import { JsonError, readJson } from "../dist/json/read.js";
import { writeJson } from "../dist/json/write.js";
import { debugQuote } from "../dist/text.js";
import { DEBUG_ESCAPED } from "../dist/data.js";
import { readObject } from "../dist/objects.js";
import { buildUser } from "../dist/models/user.js";
import * as graph from "../dist/models/graph.js";
import * as feeds from "../dist/models/feed.js";
import * as posts from "../dist/models/post.js";
import { buildFile } from "../dist/models/file.js";
import { variant } from "../dist/json/schema.js";

const root = variant(["public", "private"]);
import { parse } from "../dist/models/common.js";
import { lastMint, pin } from "../dist/clock.js";

const utf8 = (text) => new TextEncoder().encode(text);
const version = (owner, m) => ({ id: m.id, editId: m.editId, path: m.path, url: `pubky://${owner}${m.path}`, body: b64(utf8(m.body)) });
const made = (owner, m) => created(owner, m.id, m);
const readStoredText = (model, text, id) => {
  const bytes = utf8(text);
  if (bytes.length > model.maxBytes) throw Object.assign(new Error(`Validation Error: object exceeds ${model.maxBytes} bytes`), { name: "ValidationError" });
  const value = parse(model.codec, bytes);
  const body = model.codec.write(value);
  if (utf8(body).length > model.maxBytes) throw Object.assign(new Error(`Validation Error: object exceeds ${model.maxBytes} bytes`), { name: "ValidationError" });
  model.check(value, id, false);
  return { value };
};
const created = (owner, id, made) => ({ id, path: made.path, url: `pubky://${owner}${made.path}`, body: b64(utf8(made.body)) });

const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const bytes = (arg) => ("j" in arg ? new TextEncoder().encode(arg.j) : new Uint8Array(Buffer.from(arg.b, "base64")));

const ops = {
  frozenTrim: (a) => text.frozenTrim(a.s),
  asciiFold: (a) => text.asciiFold(a.s),
  codePointLen: (a) => text.codePointLen(a.s),
  publicKey: (a) => (ids.checkPublicKey(a.s), a.s),
  timestampId: (a) => ids.timestampIdMicros(a.s).toString(),
  hashId: (a) => (ids.checkHashId(a.s), null),
  mediaId: (a) => ids.hashId(bytes(a)),
  canonicalPubky: (a) => canon.canonicalPubky(a.s),
  canonicalWeb: (a) => canon.canonicalWeb(a.s),
  canonicalExternal: (a) => canon.canonicalExternal(a.s),
  canonicalUniversal: (a) => canon.canonicalUniversal(a.s),
  parseUri: (a) => uri.parseUri(a.s),
  stableKey: (a) => uri.stableKey(a.s),
  legacyMediaKey: (a) => uri.legacyMediaKey(a.s),
  listPrefix: (a, tree) => uri.listPrefix(a.s, JSON.parse(tree.j)),
  userUri: (a) => uri.userUri(a.s),
  postUri: (a, b) => uri.postUri(a.s, b.s),
  followUri: (a, b) => uri.followUri(a.s, b.s),
  muteUri: (a, b) => uri.muteUri(a.s, b.s),
  bookmarkUri: (a, b) => uri.bookmarkUri(a.s, b.s),
  tagUri: (a, b) => uri.tagUri(a.s, b.s),
  fileUri: (a, b) => uri.fileUri(a.s, b.s),
  feedUri: (a, b) => uri.feedUri(a.s, b.s),
  mimeToExt: (a) => mimeToExt(a.s),
  json: (a) => b64(new TextEncoder().encode(writeJson(readJson(a.j)))),
  debug: (a) => debugQuote(a.s, DEBUG_ESCAPED),
  decode: (a, body) => {
    const read = readObject(a.s, bytes(body));
    return { kind: read.kind, body: b64(read.body) };
  },
  createUser: (a, input) => created(a.s, "", buildUser(a.s, input?.j ?? "null")),
  createFollow: (a, b) => made(a.s, graph.buildFollow(a.s, b.s)),
  createMute: (a, b) => made(a.s, graph.buildMute(a.s, b.s)),
  createTag: (a, b, c) => made(a.s, graph.buildTag(a.s, b.s, c.s)),
  createBookmark: (a, b) => made(a.s, graph.buildBookmark(a.s, b.s)),
  bookmarkId: (a) => graph.bookmarkId(a.s),
  createPost: (a, input) => version(a.s, posts.buildPost(a.s, input?.j ?? "null")),
  editPost: (a, post, at) => version(a.s, posts.buildEdit(a.s, post?.j ?? "null", at?.j ?? "null")),
  createFeed: (a, input) => made(a.s, feeds.buildFeed(a.s, input?.j ?? "null")),
  feedId: (a) => feeds.feedIdOf(a?.j ?? "null"),
  feedPaths: (a) => feeds.feedPaths(a.s),
  createFile: (a, data, type, r) => {
    ids.checkPublicKey(a.s);
    const m = buildFile(a.s, bytes(data), type.s, parse({ read: (reader) => (reader.peekToken() === 0x6e ? (reader.pos++, reader.ident("ull"), null) : root.read(reader)) }, r?.j ?? "null") ?? "public");
    return { id: m.id, path: m.path, url: `pubky://${a.s}${m.path}` };
  },
  bookmarkTarget: (a, content) => {
    const text = content?.j ?? "null";
    if (text === "null") return graph.targetOf(a.s, { created_at: 0n, target: null, extra: new Map() });
    const { value } = readStoredText(graph.bookmark, text, a.s);
    return graph.targetOf(a.s, value);
  },
};

export const implemented = (op) => op in ops;

/** `{ok, last}` or `{err, last}`, as the oracle answers the same request. */
export function answer({ op, args = [], now, last }) {
  if (!(op in ops)) return { missing: op };
  pin(BigInt(now), BigInt(last));
  const after = () => Number(lastMint());
  try {
    return { ok: ops[op](...args) ?? null, last: after() };
  } catch (e) {
    if (e instanceof JsonError) return { err: `Validation Error: ${e.message}`, last: after() };
    if (e?.name !== "ValidationError") throw e;
    return { err: e.message, last: after() };
  }
}
