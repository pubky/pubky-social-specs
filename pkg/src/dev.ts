// Development only: warn when an object read with members another client added is written back
// without them, which is what copying it field by field does. A bundler replaces
// `process.env.NODE_ENV`, so a production build folds this to nothing; outside Node, with no
// bundler, there is no `process` and no warning.

declare const process: { env: Record<string, string | undefined> } | undefined;
declare const console: { warn(message: string): void };

// In this shape a bundler's define folds it to false, and the warning's code goes with it
const development = typeof process === "undefined" ? false : process.env.NODE_ENV !== "production";

// The most URLs remembered; the oldest is forgotten first
const REMEMBERED = 1000;
const unknownAt = new Map<string, number>();

/** How many `$unknown` members an object read holds, nested ones included. */
function countUnknown(value: unknown, depth = 0): number {
  if (typeof value !== "object" || value === null || depth > 8) return 0;
  if (Array.isArray(value)) return value.reduce((n: number, item) => n + countUnknown(item, depth + 1), 0);
  let n = Object.hasOwn(value, "$unknown") ? 1 : 0;
  for (const member of Object.values(value)) n += countUnknown(member, depth + 1);
  return n;
}

/** Notes what the latest decode at `url` carried beyond the known members. */
export function rememberUnknown(url: string, object: unknown): void {
  if (!development) return;
  const n = countUnknown(object);
  // The latest read at a URL is the one an edit starts from
  unknownAt.delete(url);
  if (n === 0) return;
  if (unknownAt.size >= REMEMBERED) unknownAt.delete(unknownAt.keys().next().value as string);
  unknownAt.set(url, n);
}

/** Warns when `object`, written for what was read at `url`, carries fewer of those members. */
export function warnIfUnknownDropped(url: string, object: unknown, call: string): void {
  if (!development) return;
  const before = unknownAt.get(url);
  if (before === undefined) return;
  const now = countUnknown(object);
  if (now < before) {
    console.warn(
      `pubky-social-specs: ${call} for ${url} carries ${now} of the ${before} $unknown members the object was read with, so what another client added is lost. Spread the decoded object, { ...read, content }, instead of copying it field by field. (Shown outside production only.)`,
    );
  }
}
