// The 0.x tree, read only to join it to the 1.x one: where it kept things, the key one object
// has under both epochs, and the media reference a 0.x File object completes. Nothing else in
// the core knows the 0.x layout.

import { isPublicKey } from "./ids.js";
import { isCanonicalSegment, jsonStem, parsePath } from "./path.js";
import { trimWhere, utf8 } from "./text.js";

/** The 0.x namespace, and where the 0.x tree kept everything, public only. */
export const LEGACY_NAMESPACE = "pubky.app";
export const LEGACY_ROOT = `/pub/${LEGACY_NAMESPACE}/`;

const stripJson = (leaf: string) => jsonStem(leaf) ?? leaf;

/**
 * The key one object has under both epochs of a tree, from its owner-relative path:
 * `{key}`, or `{needsDeref}` for a legacy media reference that its 0.x File object
 * completes through `legacyMediaKey`, or null for a path that is no object.
 */
export function stableKey(ownerRelativePath: string): { key: string } | { needsDeref: string } | null {
  const path = ownerRelativePath.startsWith("/") ? ownerRelativePath.slice(1) : ownerRelativePath;
  const [root, namespace, ...rest] = path.split("/");
  if ((root !== "pub" && root !== "priv") || namespace === undefined || rest.length === 0) return null;
  if (namespace === "social") {
    if (!path.split("/").every(isCanonicalSegment)) return null;
    const parsed = parsePath(path);
    if (parsed === null) return null;
    if (parsed.kind === "user") return { key: "profile" };
    return "id" in parsed ? { key: `${parsed.kind}s/${parsed.id}` } : null;
  }
  // The 0.x tree was public only, so a private path is never one of its objects
  if (namespace !== LEGACY_NAMESPACE || root !== "pub") return null;
  // The 0.x reader matched `[resource, id, ..]` and ignored what follows
  const [segment, leaf] = rest as [string, string | undefined];
  const hasLeaf = rest.length > 1 && rest.slice(1).join("/") !== "";
  if (hasLeaf && leaf === "") return null;
  if (!hasLeaf) {
    if (segment === "profile.json") return { key: "profile" };
    const name = stripJson(segment);
    return name === "last_read" || name === "settings" ? { key: name } : null;
  }
  const id = leaf as string;
  if (segment === "posts") return { key: `posts/${id}` };
  if (segment === "files") return { needsDeref: id };
  if (segment === "blobs") return { key: `files/${id}` };
  if (["tags", "follows", "mutes", "bookmarks", "feeds", "last_read", "settings"].includes(segment)) {
    const stripped = stripJson(id);
    return stripped === "" ? null : { key: `${segment}/${stripped}` };
  }
  return null;
}

const DOT = /^(\.|%2e)$/i;
const DOT_DOT = /^(\.|%2e){2}$/i;

// What a URL parser percent-encodes in the path of a non-special scheme: controls, space,
// `"#<>?\`{}` and non-ASCII. A backslash is no separator there and stays as it is
function encodeSegment(segment: string): string {
  let out = "";
  for (const byte of utf8(segment)) {
    const c = String.fromCharCode(byte);
    out += byte <= 0x20 || byte >= 0x7f || '"#<>?`{}'.includes(c) ? `%${byte.toString(16).toUpperCase().padStart(2, "0")}` : c;
  }
  return out;
}

/**
 * Completes a legacy media key from the `src` of a 0.x File object
 * (`pubky://<pk>/pub/pubky.app/blobs/<hash>`): `files/<hash>`, or null when the src is no
 * legacy blob reference.
 *
 * The 0.x reader accepted a src on a URL parser's terms, so this reads one the same way for
 * the one scheme it can carry: surrounding controls and spaces dropped, tabs and newlines
 * removed anywhere, the scheme in any case, userinfo and a port ignored, the path
 * percent-encoded and its dot segments resolved.
 */
export function legacyMediaKey(v0FileSrc: string): string | null {
  const input = trimWhere(v0FileSrc, (unit) => unit <= 0x20).replace(/[\t\n\r]/g, "");
  const scheme = /^pubky:\/\//i.exec(input);
  if (!scheme) return null;
  const rest = input.slice(scheme[0].length);
  const end = rest.search(/[/?#]/);
  const authority = end < 0 ? rest : rest.slice(0, end);
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  const colon = hostPort.indexOf(":");
  const host = colon < 0 ? hostPort : hostPort.slice(0, colon);
  const port = colon < 0 ? "" : hostPort.slice(colon + 1);
  if (!/^[0-9]*$/.test(port) || Number(port) > 65535 || !isPublicKey(host)) return null;
  if (end < 0 || rest[end] !== "/") return null;
  const raw = rest.slice(end + 1).split(/[?#]/, 1)[0] as string;
  const segments: string[] = [];
  const parts = raw.split("/");
  parts.forEach((part, i) => {
    const encoded = encodeSegment(part);
    const last = i === parts.length - 1;
    if (DOT_DOT.test(encoded)) {
      segments.pop();
      if (last) segments.push("");
    } else if (DOT.test(encoded)) {
      if (last) segments.push("");
    } else segments.push(encoded);
  });
  const [root, app, kind, id] = segments;
  return root === "pub" && app === "pubky.app" && kind === "blobs" && id ? `files/${id}` : null;
}
