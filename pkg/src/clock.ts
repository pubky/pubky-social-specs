// The clock and the mint guard. Both are per module instance: two bundles of the package in
// one page mint independently, as two processes of the reference do.

let clock: (() => bigint) | null = null;
let lastMinted = 0n;

/** Microseconds since the epoch. The engine's clock ticks in milliseconds. */
export function nowMicros(): bigint {
  return clock ? clock() : BigInt(Date.now()) * 1000n;
}

/**
 * Replaces the clock, for tests: `nowMicros` gives the time in microseconds. Without an
 * argument the engine's clock is back. Either way the mint guard starts over.
 */
export function setClock(now?: () => number | bigint): void {
  clock = now ? () => BigInt(now()) : null;
  lastMinted = 0n;
}

/** A clock and a guard as given, so an answer depends on its request alone. */
export function pin(now: bigint, last: bigint): void {
  clock = () => now;
  lastMinted = last;
}

export function lastMint(): bigint {
  return lastMinted;
}

// A clock this far behind the last mint is a correction, not a burst
const ROLLBACK_TOLERANCE = 1_000_000n;

/** Strictly increasing: a burst runs a microsecond ahead per mint, a corrected clock is followed. */
export function mintFrom(now: bigint): bigint {
  lastMinted = now > lastMinted || lastMinted - now > ROLLBACK_TOLERANCE ? now : lastMinted + 1n;
  return lastMinted;
}
