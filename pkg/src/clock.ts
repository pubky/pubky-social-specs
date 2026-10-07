// The clock and the mint guard. Both are per module instance: two copies of the package in
// one program mint independently, as two processes of the reference do.

let clock: (() => bigint) | null = null;
let lastMinted = 0n;

/** Microseconds since the epoch. The engine's clock ticks in milliseconds. */
export const nowMicros = (): bigint => (clock ? clock() : BigInt(Date.now()) * 1000n);

/** A clock in microseconds and a guard as given, so an answer depends on its request alone. */
export function pin(now: (() => bigint) | null, last = 0n): void {
  clock = now;
  lastMinted = last;
}

export const lastMint = (): bigint => lastMinted;

// A clock this far behind the last mint is a correction, not a burst
const ROLLBACK_TOLERANCE = 1_000_000n;

/** Strictly increasing: a burst runs a microsecond ahead per mint, a corrected clock is followed. */
export function mintFrom(now: bigint): bigint {
  lastMinted = now > lastMinted || lastMinted - now > ROLLBACK_TOLERANCE ? now : lastMinted + 1n;
  return lastMinted;
}
