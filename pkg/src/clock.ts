// The clock and the mint guard. Both are per module instance: two copies of the package in
// one program mint independently, as two processes of the reference do.

let clock: (() => bigint) | null = null;
let lastMinted = 0n;

// The wall clock gives the millisecond and the monotonic one the microseconds inside it, so two
// instances minting in one millisecond rarely meet. Only the fraction is taken from the
// monotonic clock, which can fall behind the wall clock across a suspend.
const wallMicros = (): bigint => BigInt(Date.now()) * 1000n + BigInt(Math.floor((performance.now() % 1) * 1000));

/** Microseconds since the epoch. */
export const nowMicros = (): bigint => (clock ? clock() : wallMicros());

/** A clock in microseconds and a guard as given, so an answer depends on its request alone. */
export function pin(now: (() => bigint) | null, last = 0n): void {
  clock = now;
  lastMinted = last;
}

// The guard read back and the `last` of `pin` are for the scoreboard, which replays the
// reference's answers under a given clock and guard; nothing in the package reads them
export const lastMint = (): bigint => lastMinted;

// A clock this far behind the last mint is a correction, not a burst
const ROLLBACK_TOLERANCE = 1_000_000n;

/** Strictly increasing: a burst runs a microsecond ahead per mint, a corrected clock is followed. */
export function mintFrom(now: bigint): bigint {
  lastMinted = now > lastMinted || lastMinted - now > ROLLBACK_TOLERANCE ? now : lastMinted + 1n;
  return lastMinted;
}
