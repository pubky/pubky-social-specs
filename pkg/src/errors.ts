const BRAND = Symbol.for("pubky-social-specs.ValidationError");
const PREFIX = "Validation Error: ";

/**
 * A value the data model refuses. The message is the reference text, "Validation Error: "
 * included; `reason` is the same text without it. `field` names the member or argument
 * refused (`content`, `attachments[0].uri`, `owner`) where the refusal is about one.
 * `instanceof` holds across two copies of the package in one program.
 *
 * @example
 * ```ts
 * import { buildUser, ValidationError } from "pubky-social-specs";
 * const owner = "8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto";
 * try {
 *   buildUser(owner, { name: "" });
 * } catch (e) {
 *   if (e instanceof ValidationError) console.log(e.field, e.reason);
 * }
 * ```
 */
export class ValidationError extends Error {
  override name = "ValidationError";
  readonly reason: string;
  readonly field?: string;
  readonly [BRAND] = true;

  constructor(reason: string, field?: string, options?: ErrorOptions) {
    super(PREFIX + reason, options);
    this.reason = reason;
    if (field !== undefined) this.field = field;
  }

  static override [Symbol.hasInstance](value: unknown): boolean {
    // Own, so a polluted prototype does not make every object one
    return typeof value === "object" && value !== null && Object.hasOwn(value, BRAND);
  }
}

export function fail(reason: string, field?: string): never {
  throw new ValidationError(reason, field);
}

// The argument or member each shape refusal names, for a validator to report as a path
const shapes = new WeakMap<TypeError, string>();

/** A caller's value of the wrong shape: a bug in the caller, not a rule of the data model. */
export function misuse(what: string, expected: string): never {
  const error = new TypeError(`pubky-social-specs: ${what} must be ${expected}`);
  shapes.set(error, what);
  throw error;
}

/** What a shape refusal of this package names, or undefined for any other error. */
export const shapeOf = (error: unknown): string | undefined => (error instanceof TypeError ? shapes.get(error) : undefined);

/**
 * How the rules of a check run, each one a closure. Throwing, the first refusal is the error,
 * in the reference's order. A validator passes one that keeps each refusal and runs the next.
 */
export type Each = (rule: () => void) => void;
export const throwing: Each = (rule) => rule();

/** A member parsed under `each`: what `parse` gives, or `fallback` when a collecting `each` kept its refusal. */
export function member<T>(each: Each, parse: () => T, fallback: T): T {
  let out = fallback;
  each(() => {
    out = parse();
  });
  return out;
}
