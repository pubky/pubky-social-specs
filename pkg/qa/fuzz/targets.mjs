// The fuzz targets. Each takes the fuzzer's bytes and holds the package to the guarantees a
// caller relies on for untrusted input: it returns or throws a ValidationError or an
// ArgumentError, nothing else, and what it reads it writes back to a fixed point. A broken
// guarantee throws a plain Error, which the fuzzer reports as a crash.

import * as api from "../../dist/index.js";

export const OWNER = "8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto";
const ID = "0035QZPT4QG00";
// One stored object of every kind the bytes may claim to be, chosen by the first byte
export const URLS = [
  `pubky://${OWNER}/pub/social/v1/posts/${ID}/${ID}.json`,
  `pubky://${OWNER}/priv/social/v1/posts/${ID}/${ID}-a-slug.json`,
  `pubky://${OWNER}/pub/social/v1/profile.json`,
  `pubky://${OWNER}/pub/social/v1/follows/dzswkfy7ek3bqnoc89jxuqqfbzhjrj6mi8qthgbxxcqkdugm3rio.json`,
  `pubky://${OWNER}/priv/social/v1/mutes/dzswkfy7ek3bqnoc89jxuqqfbzhjrj6mi8qthgbxxcqkdugm3rio.json`,
  `pubky://${OWNER}/pub/social/v1/tags/8Z8CWH8NVYQY39ZEBFGKQWWEKG.json`,
  `pubky://${OWNER}/priv/social/v1/bookmarks/~8Z8CWH8NVYQY39ZEBFGKQWWEKG.json`,
  `pubky://${OWNER}/priv/social/v1/feeds/8Z8CWH8NVYQY39ZEBFGKQWWEKG.json`,
];

const decoder = new TextDecoder();
const same = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i]);

/** Only the package's two error types may leave a call; anything else is a fault. */
function expected(e) {
  if (e instanceof api.ValidationError || e instanceof api.ArgumentError) return;
  throw new Error(`a call threw ${e?.name}: ${e?.message}`, { cause: e });
}

/** Stored bytes at a URL: refused, or read back to a fixed point by encode then decode. */
export function decode(data) {
  if (data.length === 0) return;
  const url = URLS[data[0] % URLS.length];
  const bytes = data.subarray(1);
  let read;
  try {
    read = api.decodeObject(url, bytes);
  } catch (e) {
    return expected(e);
  }
  const once = api.encodeObject(url, read.object);
  const again = api.decodeObject(url, once);
  const twice = api.encodeObject(url, again.object);
  if (!same(once, twice)) throw new Error(`the bytes are no fixed point: ${decoder.decode(once)}`);
  if (read.kind === "post") {
    try {
      api.decodeContent(again.object);
    } catch (e) {
      expected(e);
    }
  }
}

/** Any string as a URI: classified or refused, and a stored object's URL spelled back unchanged. */
export function uri(data) {
  const text = decoder.decode(data);
  let parsed;
  try {
    parsed = api.parseUri(text);
  } catch (e) {
    return expected(e);
  }
  if (!api.isPubkyUrl(text)) return;
  const back = api.parsePubkyUrl(text);
  if (back !== text) throw new Error(`a canonical URL came back as ${back}`);
  if (api.toPath(text) !== parsed.path) throw new Error(`toPath and parseUri disagree on ${text}`);
}

/** Any JSON as a builder's input: built or refused, and what is built decodes to what it holds. */
export function build(data) {
  if (data.length === 0) return;
  let input;
  try {
    input = JSON.parse(decoder.decode(data.subarray(1)));
  } catch {
    return;
  }
  const builders = [
    () => api.buildPost(OWNER, input),
    () => api.buildUser(OWNER, input),
    () => api.buildFeed(OWNER, input),
    () => api.buildTag(OWNER, String(input?.uri ?? ""), String(input?.label ?? "")),
    () => api.buildBookmark(OWNER, String(input?.uri ?? "")),
  ];
  const which = builders[data[0] % builders.length];
  let built;
  try {
    built = which();
  } catch (e) {
    return expected(e);
  }
  const read = api.decodeObject(built.url, built.body);
  if (!same(api.encodeObject(built.url, read.object), built.body)) throw new Error(`a built object reads back to other bytes: ${built.url}`);
}
