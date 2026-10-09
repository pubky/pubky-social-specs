// The clock and the mint guard. Both are per module instance: two copies of the package in
// one program mint independently, as two processes of the reference do.

let clock: (() => bigint) | null = null;
let lastMinted = 0n;

// A reading is taken as it is when ahead of the last one, or so far behind it that the clock was
// corrected: closer behind is jitter or a burst
const ROLLBACK_TOLERANCE = 1_000_000n;
const follows = (now: bigint, last: bigint) => now > last || last - now > ROLLBACK_TOLERANCE;

// The wall clock gives the millisecond and a random draw the microsecond inside it: a browser
// coarsens its monotonic clock to 100 us or more, so two copies of the package minting in one
// millisecond would read the same fraction. The draw only spreads ids, so Math.random serves.
// The guard keeps one copy's ids increasing; the reading itself never steps back inside a
// millisecond, so two `created_at` read in a row keep their order.
let lastWall = 0n;
function wallMicros(): bigint {
  const read = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
  if (follows(read, lastWall)) lastWall = read;
  return lastWall;
}

/** Microseconds since the epoch. */
export const nowMicros = (): bigint => (clock ? clock() : wallMicros());

/** A clock in microseconds and a guard as given, so an answer depends on its request alone. */
export function pin(now: (() => bigint) | null, last = 0n): void {
  clock = now;
  lastMinted = last;
}

/**
 * The guard read back, for the scoreboard, which replays the reference's answers under a given
 * clock and guard; nothing in the package reads it.
 * @internal
 */
export const lastMint = (): bigint => lastMinted;

/** Strictly increasing: a burst runs a microsecond ahead per mint, a corrected clock is followed. */
export function mintFrom(now: bigint): bigint {
  lastMinted = follows(now, lastMinted) ? now : lastMinted + 1n;
  return lastMinted;
}
