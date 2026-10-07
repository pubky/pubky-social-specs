/**
 * Replaces the clock, for tests: `nowMs` gives milliseconds as `Date.now` does, so ids and
 * `created_at` are known in advance. Without an argument the engine's clock is back. Either
 * way the guard that keeps ids increasing starts over. The clock is per copy of the
 * package, so test workers that share one module instance share it too.
 */
export declare function setClock(nowMs?: () => number): void;
//# sourceMappingURL=testing.d.ts.map