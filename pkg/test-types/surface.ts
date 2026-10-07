// Type tests: this file only has to compile. `@ts-expect-error` marks what must not.

import {
  buildFile, buildPost, buildUri, buildUser, decodeContent, decodeObject, editPost, encodeObject, feedReaches, limits, parseUri, planPublish, ValidationError,
  type Built, type BuiltPost, type Bytes, type Decoded, type FeedReach, type KnownFeedReach, type NewPost, type ParsedUri, type Post, type User,
} from "pubky-social-specs";
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
  const again: BuiltPost = editPost(built.url, post, { slug: "edited" });
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

// A parsed URI narrows by kind
const parsed: ParsedUri = parseUri(built.url);
if (parsed.kind === "post") parsed.editId satisfies string | undefined;
if (parsed.kind === "bookmark") parsed.target satisfies string | undefined;
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
