// pubky-social-specs/testing: what a test of code built on the package needs and an app never
// does. Kept off the main entry so a production import cannot freeze every id.

import * as clock from "./clock.js";
import { misuse } from "./errors.js";

/**
 * Replaces the clock, for tests: `nowMs` gives milliseconds as `Date.now` does, so ids and
 * `created_at` are known in advance. Without an argument the engine's clock is back. Either
 * way the guard that keeps ids increasing starts over. The clock is per copy of the
 * package, so test workers that share one module instance share it too.
 */
export function setClock(nowMs?: () => number): void {
  if (nowMs === undefined) return clock.pin(null);
  if (typeof nowMs !== "function") misuse("nowMs", "a function giving milliseconds, as Date.now does");
  clock.pin(() => {
    const now = nowMs();
    if (!Number.isSafeInteger(now)) misuse("the clock given to setClock", "returning an integer of milliseconds");
    return BigInt(now) * 1000n;
  });
}
