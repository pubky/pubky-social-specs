// Each oracle operation as the package answers it, in the oracle's own shape: stored bytes as
// base64, a refusal as its message. An operation the package lacks is reported as missing, so
// the scoreboard counts it instead of crashing.

import * as text from "../dist/text.js";
import * as ids from "../dist/ids.js";
import * as canon from "../dist/canonicalize.js";
import * as uri from "../dist/uri.js";
import { mimeToExt } from "../dist/mime.js";

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
};

export const implemented = (op) => op in ops;

/** `{ok, last}` or `{err, last}`, as the oracle answers the same request. */
export function answer({ op, args = [], now, last }) {
  if (!(op in ops)) return { missing: op };
  try {
    return { ok: ops[op](...args) ?? null, last };
  } catch (e) {
    if (e?.name !== "ValidationError") throw e;
    return { err: e.message, last };
  }
}
