declare const BRAND: unique symbol;
/** What the reference prefixes every refusal of its rules with. */
export declare const PREFIX = "Validation Error: ";
/**
 * What kind of rule a `ValidationError` names, stable across releases where the message text is
 * not:
 * - `json`: the bytes, or an envelope inside them, are not JSON of the stored shape;
 * - `size`: an object or a file is over its byte cap, `limit` in bytes;
 * - `length`: text is outside its bounds, `limit` the bound it broke, in code points;
 * - `count`: a list has more items than `limit`;
 * - `blank`: text, a list or a file is empty or whitespace only;
 * - `format`: text is not spelled the one way the model accepts (a key, an id, a tag, a slug);
 * - `id`: an id does not match its object, or its time is out of bounds;
 * - `reference`: a URI in a reference position is refused;
 * - `unknown_name`: a kind, reach, layout or sort this version does not know;
 * - `unsafe_integer`: an integer a JS number cannot hold exactly;
 * - `path`: a URL or path names no object of the kind asked for;
 * - `conflict`: members or arguments that cannot go together;
 * - `migration`: refused by the migrator, see the message.
 */
export type ErrorCode = "json" | "size" | "length" | "count" | "blank" | "format" | "id" | "reference" | "unknown_name" | "unsafe_integer" | "path" | "conflict" | "migration";
/**
 * A value the data model refuses. The message is the reference text, "Validation Error: "
 * included, and `reason` the same text without it; `code` says which kind of rule, for a
 * program to act on. `field` names the member or argument refused (`content`,
 * `attachments[0].uri`, `owner`), absent when the refusal is about the object as a whole.
 * `limit` is the bound a `size`, `length` or `count` refusal broke. `instanceof` holds across
 * two copies of the package in one program.
 *
 * @example
 * ```ts
 * import { buildUser, ValidationError } from "pubky-social-specs";
 * const owner = "8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto";
 * try {
 *   buildUser(owner, { name: "Al" });
 * } catch (e) {
 *   if (e instanceof ValidationError) console.log(e.code, e.field, e.limit); // length name 3
 * }
 * ```
 */
export declare class ValidationError extends Error {
    /** `"ValidationError"`, as a stack trace and a log print it. */
    name: string;
    /** Which kind of rule refused: a member of the closed `ErrorCode` set, stable across releases. */
    readonly code: ErrorCode;
    /** The reference text without the `Validation Error: ` prefix the `message` carries. */
    readonly reason: string;
    /** The member or argument refused, as the input spells it: `content`, `attachments[0].uri`, `owner`. Absent when the whole object is refused. */
    readonly field?: string;
    /** The bound a `size` (bytes), `length` (code points) or `count` (items) refusal broke: the value in `limits`. */
    readonly limit?: number;
    readonly [BRAND] = true;
    constructor(code: ErrorCode, reason: string, field?: string, limit?: number, options?: {
        cause?: unknown;
    });
    static [Symbol.hasInstance](value: unknown): boolean;
}
export declare function fail(code: ErrorCode, reason: string, field?: string, limit?: number): never;
/**
 * A caller's value of the wrong shape: a bug in the caller, not a rule of the data model.
 * `field` names the argument or member, as the message does.
 *
 * @example
 * ```ts
 * import { buildPost, ArgumentError } from "pubky-social-specs";
 * try {
 *   buildPost("8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto", { content: 1 } as never);
 * } catch (e) {
 *   if (e instanceof ArgumentError) console.log(e.field); // input.content
 * }
 * ```
 */
export declare class ArgumentError extends TypeError {
    /** `"ArgumentError"`, as a stack trace and a log print it. */
    name: string;
    /** The argument or member of the wrong shape, as the message names it: `input.attachments[0].uri`. */
    readonly field: string;
    constructor(field: string, message: string);
}
export declare function misuse(what: string, expected: string): never;
/** A name a caller passes as an argument: one of `names`, another string refused, anything else a TypeError. */
export declare function nameOf<T extends string>(js: unknown, at: string, names: readonly T[]): T;
/**
 * How the rules of a check run, each one a closure. Throwing, the first refusal is the error,
 * in the reference's order. A validator passes one that keeps each refusal and runs the next.
 */
export type Each = (rule: () => void) => void;
export declare const throwing: Each;
/** A member parsed under `each`: what `parse` gives, or `fallback` when a collecting `each` kept its refusal. */
export declare function member<T>(each: Each, parse: () => T, fallback: T): T;
export {};
//# sourceMappingURL=errors.d.ts.map