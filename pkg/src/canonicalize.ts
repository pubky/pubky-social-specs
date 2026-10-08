// The URI canonicalizers. No `URL` here: an engine parser repairs junk into acceptance
// (userinfo stripped, `..` collapsed, query ignored) and differs between engines and versions.

import { limits } from "./data.js";
import { fail } from "./errors.js";
import { isPublicKey } from "./ids.js";
import { asciiFold, codePointLen, frozenTrim, hasControlOrWhitespace } from "./text.js";
import { isCanonicalSegment, isPrivatePath, parsePath, splitPubky } from "./path.js";

/** The full form `pubky://<pk>[/<path>]` of either spelling, or null. */
export function canonicalPubky(raw: string): string | null {
  // The scheme is case-sensitive; the SDK short form has no `://`
  const split = splitPubky(raw.startsWith("pubky") && !raw.startsWith("pubky://") ? `pubky://${raw.slice(5)}` : raw);
  if (split === null || !isPublicKey(split.owner)) return null;
  if (split.path === null) return `pubky://${split.owner}`;
  return split.path.split("/").every(isCanonicalSegment) ? `pubky://${split.owner}/${split.path}` : null;
}

/** The stored form of a web reference is the trimmed raw string. */
export function canonicalWeb(raw: string): string | null {
  const s = frozenTrim(raw);
  if (hasControlOrWhitespace(s)) return null;
  const rest = s.startsWith("http://") ? s.slice(7) : s.startsWith("https://") ? s.slice(8) : null;
  return rest && !/^[/?#]/.test(rest) ? s : null;
}

/** Any other scheme: the scheme folds, the rest is opaque. */
export function canonicalExternal(raw: string): string | null {
  const s = frozenTrim(raw);
  if (hasControlOrWhitespace(s)) return null;
  const colon = s.indexOf(":");
  if (colon <= 0 || colon + 1 === s.length) return null;
  const scheme = s.slice(0, colon);
  if (!/^[A-Za-z][A-Za-z0-9+.-]*$/.test(scheme)) return null;
  const folded = asciiFold(scheme);
  if (folded.startsWith("pubky") || folded === "http" || folded === "https") return null;
  return folded + s.slice(colon);
}

/** Dispatch on the untrimmed string, so a pasted leading space defeats it on purpose. */
export function canonicalUniversal(raw: string): string | null {
  const canonical = raw.startsWith("pubky") ? canonicalPubky(raw) : raw.startsWith("http://") || raw.startsWith("https://") ? canonicalWeb(raw) : canonicalExternal(raw);
  return canonical !== null && codePointLen(canonical) <= limits.referenceUriMaxLength ? canonical : null;
}

type Schemes = "pubky" | "pubky or web" | "web" | "";

/**
 * The one reference gate: the canonical form under `schemes` and the cap, then for a pubky
 * value the root rule, the ownership rule and the versionless rule. Returns the canonical
 * form, or the fragment of the refusal that follows the field name.
 */
export function reference(uri: string, schemes: Schemes, max: number, publicRoot: boolean, owner: string | null): { canonical: string } | { refusal: string } {
  const shape = { refusal: `must be a canonical${schemes && " "}${schemes} URI of at most ${max} code points: ${uri}` };
  const isPubky = uri.startsWith("pubky");
  let canonical: string | null;
  if (isPubky) canonical = schemes === "web" ? null : canonicalPubky(uri);
  else if (uri.startsWith("http://") || uri.startsWith("https://")) canonical = schemes === "pubky" ? null : canonicalWeb(uri);
  else canonical = schemes === "" ? canonicalExternal(uri) : null;
  if (canonical === null || codePointLen(canonical) > max) return shape;
  if (!isPubky) return { canonical };
  const { owner: host, path } = splitPubky(canonical) as { owner: string; path: string | null };
  if (isPrivatePath(path)) {
    if (publicRoot) return { refusal: `must not reference a private object: ${uri}` };
    if (owner !== null && host !== owner) return { refusal: `must not reference a private object of another user: ${uri}` };
  }
  const parsed = parsePath(path);
  if (parsed?.kind === "post" && parsed.editId !== undefined) return { refusal: `must be versionless: ${uri}` };
  return { canonical };
}

/** A stored reference is the fixed point of its canonical spelling. */
export function checkReference(field: string, uri: string, schemes: Schemes, max: number, publicRoot: boolean, owner: string | null): void {
  const result = reference(uri, schemes, max, publicRoot, owner);
  if ("refusal" in result) fail(`${field} ${result.refusal}`, field);
  if (result.canonical !== uri) fail(`${field} must be spelled in canonical form: ${uri}`, field);
}
