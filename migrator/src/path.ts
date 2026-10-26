import { toPath } from "pubky-social-specs";

/**
 * The owner-relative path of `url` when it is `pubky://<owner>/` and then a canonical path under
 * `pub/` or `priv/`, so no dot segment, empty segment, `%` or control resolves anywhere else;
 * null otherwise. A directory, with `directory`, may end in `/`. The one check the engine's write
 * fence and the SDK adapter share.
 */
export function ownedPath(url: string, owner: string, directory = false): string | null {
  if (!url.startsWith(`pubky://${owner}/`)) return null;
  const tail = directory && url.endsWith("/");
  let path: string;
  try {
    path = toPath(tail ? url.slice(0, -1) : url);
  } catch {
    // toPath throws nothing but a ValidationError for a string
    return null;
  }
  // A root alone names nothing to read or write
  return path.indexOf("/", 1) > 0 ? (tail ? `${path}/` : path) : null;
}
