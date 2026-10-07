const BRAND = Symbol.for("pubky-social-specs.ValidationError");

/**
 * A value the data model refuses. The message is the reference text, "Validation Error: "
 * included. `instanceof` holds across two copies of the package in one program.
 */
export class ValidationError extends Error {
  override name = "ValidationError";
  readonly [BRAND] = true;

  static override [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === "object" && value !== null && BRAND in value;
  }
}

export function fail(message: string): never {
  throw new ValidationError(`Validation Error: ${message}`);
}

/** A caller's value of the wrong shape: a bug in the caller, not a rule of the data model. */
export function misuse(what: string, expected: string): never {
  throw new TypeError(`pubky-social-specs: ${what} must be ${expected}`);
}
