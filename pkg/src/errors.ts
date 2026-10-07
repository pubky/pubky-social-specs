/** Every refusal of the package. The message is the reference text, prefix included. */
export class ValidationError extends Error {
  override name = "ValidationError";
}

export function fail(message: string): never {
  throw new ValidationError(`Validation Error: ${message}`);
}
