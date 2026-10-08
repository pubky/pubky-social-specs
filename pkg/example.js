// A tour of pubky-social-specs. Run it with `npm run example`; it performs no I/O.

import assert from "node:assert";
import {
  buildBookmark,
  buildFeed,
  buildFile,
  buildFollow,
  buildPost,
  buildTag,
  buildUri,
  buildUser,
  createMediaHasher,
  decodeContent,
  decodeObject,
  deletionPaths,
  editPost,
  encodeContent,
  encodeObject,
  limits,
  listPrefix,
  parseUri,
  planDelete,
  planPublish,
  ValidationError,
} from "pubky-social-specs";

const me = "8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto";
const them = "dzswkfy7ek3bqnoc89jxuqqfbzhjrj6mi8qthgbxxcqkdugm3rio";
const text = (bytes) => new TextDecoder().decode(bytes);
const show = (title, value) => console.log(`\n${title}\n`, value);

// A builder gives where the object goes and the bytes to PUT there
const profile = buildUser(me, { name: " Alice ", bio: "Building on Pubky", links: [{ title: "Site", url: "https://example.com" }] });
show("A profile", { path: profile.path, body: text(profile.body) });

// Media is named by the hash of its bytes; a large file can be hashed a chunk at a time
const picture = new TextEncoder().encode("not really a png");
const file = buildFile(me, { bytes: picture, type: "image/png", root: "private" });
const hasher = createMediaHasher();
hasher.update(picture.subarray(0, 4));
hasher.update(picture.subarray(4));
assert.strictEqual(hasher.id(), file.id);

// A private draft that references the private picture
const draft = buildPost(me, { content: "A first draft", attachments: [{ uri: file.url, name: "cat.png" }], root: "private" });
show("A draft", { path: draft.path, id: draft.id });

// What a GET returns is read back, and an edit is a new version above the head
const read = decodeObject(draft.url, draft.body);
assert.strictEqual(read.kind, "post");
const edited = editPost(draft.url, { ...read.object, content: "A better draft" });
show("An edit", { path: edited.path, editId: edited.editId });

// Publishing is a plan: copy the private media, then PUT the post with its references made public
const plan = planPublish(me, { id: edited.id, editId: edited.editId, post: edited.object });
show("Publishing", { copies: plan.copies, put: plan.put.path, attachments: plan.put.object.attachments });

// An article keeps its fields in an envelope the package reads and writes
const article = buildPost(me, { kind: "article", title: "On plain functions", body: "No init, no handles.", slug: "plain-functions" });
const envelope = decodeContent(article.object);
article.object.content = encodeContent({ ...envelope.content, title: "On plain, synchronous functions" });
show("An article", { path: article.path, content: article.object.content });

// What a newer client stored survives an edit by this one, in `$unknown`
const stored = new TextEncoder().encode('{"name":"Alice","bio":null,"image":null,"links":null,"status":null,"pronouns":"she/her","since":2024.0}');
const newer = decodeObject(profile.url, stored);
newer.object.status = "On holiday";
show("Unknown members kept", text(encodeObject(profile.url, newer.object)));

// The social graph, tags and bookmarks are named by what they point at
const post = buildUri(them, "post", draft.id);
show("Paths", [buildFollow(me, them).path, buildTag(me, post, " Rust ").path, buildBookmark(me, post).path]);
show("A bookmark's id carries its target", parseUri(buildBookmark(me, post).url).target);

// A feed is named by its filter
show("A feed", buildFeed(me, { name: "Rust", icon: "star", reach: "all", layout: "columns", sort: "recent", tags: ["Rust", "wasm"] }).object.feed);

// Deleting spans both epochs and both roots
show("Deleting a follow", deletionPaths({ kind: "follow", id: them }));
show(
  "Deleting a post",
  planDelete(me, {
    id: draft.id,
    copies: [
      { root: "private", path: draft.path },
      { root: "private", path: edited.path },
    ],
    versions: [edited.object],
  }),
);
show("LIST prefixes", [listPrefix(me, "public"), listPrefix(me, "private"), listPrefix(me, "legacy")]);

// A value the data model refuses is a ValidationError with the reference message
try {
  buildPost(me, { content: "x".repeat(limits.postNoteContentMaxLength + 1) });
} catch (e) {
  assert.ok(e instanceof ValidationError);
  show("Refused", e.message);
}
