// Each oracle operation as the package answers it, in the oracle's own shape: stored bytes as
// base64, a refusal as its message. An operation the package lacks is reported as missing, so
// the scoreboard counts it instead of crashing.

import * as text from "../dist/text.js";
import * as ids from "../dist/ids.js";

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
