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

/**
 * The stored form of a web reference is the trimmed raw string: no host folding and no
 * normalization, since an id hashes the exact text. Its host, past any userinfo and before any
 * port, must not be empty.
 */
export function canonicalWeb(raw: string): string | null {
  const s = frozenTrim(raw);
  if (hasControlOrWhitespace(s)) return null;
  const rest = s.startsWith("http://") ? s.slice(7) : s.startsWith("https://") ? s.slice(8) : null;
  if (rest === null) return null;
  const end = rest.search(/[/?#]/);
  const authority = end < 0 ? rest : rest.slice(0, end);
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  const host = hostPort.startsWith("[") ? hostPort : (hostPort.split(":")[0] as string);
  return host === "" ? null : s;
}

/**
 * The writer fold of a web reference, or null for a value the web gate refuses, an uppercase
 * scheme aside: scheme and host to ASCII lowercase, a port of digits without leading zeros, no
 * default or empty port, no userinfo, no fragment, an empty path as `/`. The path and the query
 * are kept as written.
 */
export function foldWeb(raw: string): string | null {
  const s = frozenTrim(raw);
  const lower = asciiFold(s.slice(0, 8));
  const scheme = lower.startsWith("http://") ? "http" : lower.startsWith("https://") ? "https" : null;
  if (scheme === null) return null;
  const rest = s.slice(scheme.length + 3);
  if (canonicalWeb(`${scheme}://${rest}`) === null) return null;
  const end = rest.search(/[/?#]/);
  const authority = end < 0 ? rest : rest.slice(0, end);
  const tail = end < 0 ? "" : rest.slice(end);
  const path = tail.includes("#") ? tail.slice(0, tail.indexOf("#")) : tail;
  const { host, port } = splitHostPort(authority.slice(authority.lastIndexOf("@") + 1));
  // A port of digits is a number: no leading zeros, and none at all when it is the default
  const value = port === null ? "" : /^[0-9]+$/.test(port) ? port.replace(/^0+(?=.)/, "") : port;
  const kept = value === "" || value === (scheme === "http" ? "80" : "443") ? "" : `:${value}`;
  return `${scheme}://${asciiFold(host)}${kept}${path.startsWith("/") ? "" : "/"}${path}`;
}

/** A bracketed IPv6 literal runs to its `]`, any other host to the first `:`. */
function splitHostPort(hostPort: string): { host: string; port: string | null } {
  if (hostPort.startsWith("[")) {
    const close = hostPort.indexOf("]");
    const after = close < 0 ? "" : hostPort.slice(close + 1);
    return after.startsWith(":") ? { host: hostPort.slice(0, close + 1), port: after.slice(1) } : { host: hostPort, port: null };
  }
  const colon = hostPort.indexOf(":");
  return colon < 0 ? { host: hostPort, port: null } : { host: hostPort.slice(0, colon), port: hostPort.slice(colon + 1) };
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
  const shape = () => ({ refusal: `must be a canonical${schemes && " "}${schemes} URI of at most ${max} code points: ${uri}` });
  const isPubky = uri.startsWith("pubky");
  let canonical: string | null;
  if (isPubky) canonical = schemes === "web" ? null : canonicalPubky(uri);
  else if (uri.startsWith("http://") || uri.startsWith("https://")) canonical = schemes === "pubky" ? null : canonicalWeb(uri);
  else canonical = schemes === "" ? canonicalExternal(uri) : null;
  if (canonical === null || codePointLen(canonical) > max) return shape();
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
  if ("refusal" in result) fail("reference", `${field} ${result.refusal}`, field);
  if (result.canonical !== uri) fail("format", `${field} must be spelled in canonical form: ${uri}`, field);
}
