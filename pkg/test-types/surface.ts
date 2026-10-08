// Type tests: this file only has to compile. `@ts-expect-error` marks what must not.

import {
  buildBookmark,
  buildFile,
  buildFollow,
  buildPost,
  buildTag,
  buildUri,
  buildUser,
  parseEditId,
  parseOwner,
  parsePostId,
  parsePostRef,
  parsePubkyUrl,
  planDelete,
  decodeContent,
  decodeObject,
  deletionPaths,
  editPost,
  encodeObject,
  isPubkyUrl,
  listPrefix,
  tryDecodeObject,
  ArgumentError,
  type ErrorCode,
  feedReaches,
  limits,
  parseUri,
  planPublish,
  planUnpublish,
  toPath,
  ValidationError,
  type Built,
  type BuiltFile,
  type BuiltPost,
  type Bytes,
  type Decoded,
  type Feed,
  type FeedReach,
  type KnownFeedReach,
  type KnownPostKind,
  type NewPost,
  type OwnerPath,
  type ParsedUri,
  type Post,
  type PubkyUrl,
  type User,
  type EditId,
  type Owner,
  type PostId,
  type PostRef,
} from "pubky-social-specs";
import { setClock } from "pubky-social-specs/testing";
import { runMigration, type MigrationPort, type MigrationReport } from "pubky-social-specs/migration";
import { sdkPort } from "pubky-social-specs/migration/pubky-sdk";

declare const owner: string;
declare const port: MigrationPort;

// A body goes straight into fetch and Blob
const built: BuiltPost = buildPost(owner, { content: "hello" });
void fetch(built.url, { method: "PUT", body: built.body });
new Blob([built.body]);
const bytes: Bytes = built.body;
const user: Built<User> = buildUser(owner, { name: "Alice", bio: null });

// One input per kind
buildPost(owner, { kind: "article", title: "t", body: "b", cover_image: null, slug: "s" });
buildPost(owner, { kind: "collection", name: "n", items: [{ uri: "u" }], layout: "grid", root: "private" });
buildPost(owner, { kind: "image", content: "c", attachments: [{ uri: "u", alt: "a" }] });
// @ts-expect-error a collection takes no parent
buildPost(owner, { kind: "collection", name: "n", parent: "x" });
// @ts-expect-error an article has a title, not content
buildPost(owner, { kind: "article", content: "x" });
// @ts-expect-error "unknown" is what a reader meets, never what a builder takes
buildPost(owner, { kind: "unknown", content: "x" });
// @ts-expect-error a typo is not a member
buildUser(owner, { name: "Alice", nmae: "x" });
const input: NewPost = { content: "x" };
void input;

// A decoded object narrows by kind
const decoded: Decoded = decodeObject(built.url, bytes);
if (decoded.kind === "post") {
  const post: Post = decoded.object;
  post.content = "edited";
  // @ts-expect-error a stored post has no such member; unknown ones travel in $unknown
  post.contnet = "typo";
  const again: BuiltPost = editPost(owner, built.url, post, { slug: "edited" });
  const envelope = decodeContent(post);
  if (envelope?.kind === "article") envelope.content.title.toUpperCase();
  encodeObject(again.url, post) satisfies Bytes;
  planPublish(owner, { id: again.id, editId: again.editId, post }).put.body satisfies Bytes;
} else if (decoded.kind === "file") {
  decoded.bytes satisfies Bytes;
  // @ts-expect-error media has no object
  decoded.object;
} else if (decoded.kind === "follow") {
  decoded.object.created_at satisfies number;
}

// The kind expected narrows the result, and a stored kind is never "unknown"
const expected: Post = decodeObject(built.url, bytes, "post");
expected.kind satisfies KnownPostKind;
decodeObject(built.url, bytes, "file") satisfies Bytes;
decodeObject(built.url, new ArrayBuffer(0), "feed") satisfies Feed;
declare const feed: Feed;
// @ts-expect-error a feed whose reach is unknown is refused on read
feed.feed.reach = "unknown";
feed.feed.content = "unknown";

// A URL and a path are told apart at compile time
const path: OwnerPath = built.path;
const at: PubkyUrl = built.url;
// @ts-expect-error a path is no URL
decodeObject(path, bytes);
// @ts-expect-error a URL is no path
planUnpublish({ id: built.id, publicPaths: [at] });
declare const listed: string[];
deletionPaths({ kind: "post", id: built.id, listings: listed.map(toPath) }) satisfies OwnerPath[];
const media: BuiltFile = buildFile(owner, { bytes: new ArrayBuffer(1), type: "image/png" });
void [media, setClock];

// A parsed URI narrows by kind
const parsed: ParsedUri = parseUri(built.url);
if (parsed.kind === "post") parsed.editId satisfies string | undefined;
if (parsed.kind === "bookmark") parsed.target satisfies string | undefined;
if (parsed.kind === "file") buildUri(owner, "file", parsed.filename);
// @ts-expect-error the profile has no id
if (parsed.kind === "user") parsed.id;
buildUri(owner, "user");
buildUri(owner, "post", "id");
// @ts-expect-error every kind but the profile needs an id
buildUri(owner, "post");

// The name tuples give the unions, and work as a schema's enum
const reach: KnownFeedReach = feedReaches[0];
const read: FeedReach = "unknown";
const max: 2000 = limits.postNoteContentMaxLength;
void [user, reach, read, max];
buildFile(owner, { bytes, type: "image/png" });
buildFile(owner, { id: "h", type: "image/png", root: "private" });

try {
  buildUser(owner, { name: "" });
} catch (e) {
  if (e instanceof ValidationError) e.message satisfies string;
}

// The migration subpaths
const report: Promise<MigrationReport> = runMigration({ owner, port });
void [report, sdkPort];

// Brands: one kind of value cannot pass for another, a plain string passes for any
const ref: PostRef = buildUri(owner, "post", built.id);
buildTag(owner, ref, "t");
buildTag(owner, "https://example.com", "t");
buildTag(owner, user.url, "t");
// @ts-expect-error the url of a version is no reference to the post
buildTag(owner, built.url, "t");
// @ts-expect-error the url of a version is no reference to the post
buildBookmark(owner, built.url);
buildPost(owner, { content: "re", parent: ref, embed: "https://example.com" });
// @ts-expect-error the url of a version is no reference to the post
buildPost(owner, { content: "re", parent: built.url });
// @ts-expect-error not as an attachment either
buildPost(owner, { kind: "image", content: "c", attachments: [{ uri: built.url }] });
// @ts-expect-error nor as a collection item
buildPost(owner, { kind: "collection", name: "n", items: [{ uri: built.url }] });
// @ts-expect-error a reference names no stored object
decodeObject(ref, bytes);
const postId: PostId = built.id;
const editId: EditId = built.editId;
planDelete(owner, { id: postId });
// @ts-expect-error a version id is no post id
planDelete(owner, { id: editId });
// @ts-expect-error nor the other way round
planPublish(owner, { id: postId, editId: postId, post: expected });
planPublish(owner, { id: "plain", editId: "strings", post: expected });
const alice: Owner = parseOwner("key");
buildFollow(alice, buildFollow(owner, alice).id);
// @ts-expect-error a post id is no owner
buildFollow(postId, alice);
parsePubkyUrl("pubky://x") satisfies PubkyUrl;
void [parsePostId("i") satisfies PostId, parseEditId("i") satisfies EditId, parsePostRef("pubky://x") satisfies PostRef];
declare const someKind: Exclude<import("pubky-social-specs").ObjectKind, "user">;
buildUri(owner, someKind, "id") satisfies string;
// @ts-expect-error a version id names no post
buildUri(owner, "post", editId);
// @ts-expect-error not through the kind-agnostic form either
buildUri(owner, someKind, editId);

// A string from elsewhere becomes a URL through a guard, no cast
const handed: string = "pubky://x/pub/social/v1/profile.json";
if (isPubkyUrl(handed)) decodeObject(handed, bytes);
// @ts-expect-error a LIST prefix names no stored object
decodeObject(listPrefix(owner, "public"), bytes);
// The members of another kind do not compile on a post input
// @ts-expect-error a note has no title
buildPost(owner, { content: "x", title: "T" });
// @ts-expect-error an article has no content member
buildPost(owner, { kind: "article", title: "T", body: "b", content: "x" });
// @ts-expect-error a file is given its bytes or its id, not both
buildFile(owner, { bytes: new Uint8Array(1), id: "x", type: "image/png" });
// The object goes with the kind it is encoded as
declare const someUser: User;
encodeObject({ kind: "user" }, someUser);
// @ts-expect-error a post is no user
encodeObject({ kind: "user" }, expected);
// A refusal returned, its code a closed set
const tried = tryDecodeObject(built.url, bytes, "post");
if (!tried.ok) tried.error.code satisfies ErrorCode;
else tried.value satisfies Post;
declare const thrown: unknown;
if (thrown instanceof ArgumentError) thrown.field satisfies string;

// A client read keeps the kind it read, so its URL is the one that kind's code takes
import { createSocialClient } from "pubky-social-specs/client";
declare const social: ReturnType<typeof createSocialClient>;
for await (const follow of social.follows.list()) if (follow.ok) follow.url satisfies PubkyUrl<"follow">;
for await (const feed of social.feeds.list()) if (feed.ok) feed.object satisfies Feed;
const profile = await social.profile.get();
if (profile?.ok) profile.url satisfies PubkyUrl<"user">;
