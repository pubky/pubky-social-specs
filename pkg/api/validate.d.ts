import type * as T from "./types.js";
/** One thing wrong with an input. */
export interface Issue {
    /** Where, as the input spells it: `["attachments", 0, "uri"]`; empty for the input as a whole. */
    readonly path: (string | number)[];
    /** `invalid_type` for a value of the wrong JavaScript shape, `invalid` for a rule of the data model. */
    readonly code: "invalid_type" | "invalid";
    /** The reference's text for a rule, the package's for a shape. */
    readonly message: string;
}
export type Validation<T> = {
    success: true;
    value: T;
} | {
    success: false;
    issues: Issue[];
};
/** The Standard Schema interface, version 1, as a form library reads it. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
    readonly "~standard": {
        readonly version: 1;
        readonly vendor: string;
        readonly validate: (value: unknown) => {
            value: Output;
            issues?: undefined;
        } | {
            issues: readonly Issue[];
        };
        readonly types?: {
            readonly input: Input;
            readonly output: Output;
        };
    };
}
/**
 * Every issue of a profile input, as `buildUser` would refuse it.
 *
 * @example
 * ```ts
 * import { validateUser } from "pubky-social-specs";
 * const result = validateUser({ name: "", bio: "Hi" });
 * if (!result.success) for (const issue of result.issues) console.log(issue.path.join("."), issue.message);
 * ```
 */
export declare function validateUser(input: unknown): Validation<T.NewUser>;
/**
 * Every issue of a post input, as `buildPost` would refuse it, without minting an id. With
 * `owner`, the rule that a private draft references only its owner's private objects runs too.
 *
 * @example
 * ```ts
 * import { validatePost } from "pubky-social-specs";
 * const owner = "8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto";
 * const result = validatePost({ kind: "article", title: "", body: "..." }, owner);
 * console.log(result.success ? "ok" : result.issues.map((i) => i.message));
 * ```
 */
export declare function validatePost(input: unknown, owner?: string): Validation<T.NewPost>;
/**
 * Every issue of a feed input, as `buildFeed` would refuse it.
 *
 * @example
 * ```ts
 * import { validateFeed } from "pubky-social-specs";
 * const result = validateFeed({ name: "Rust", icon: "crab!", reach: "all", layout: "columns", sort: "recent" });
 * console.log(result.success);
 * ```
 */
export declare function validateFeed(input: unknown): Validation<T.NewFeed>;
/**
 * Every issue of a tag, `{ uri, label }`, as `buildTag` would refuse it.
 *
 * @example
 * ```ts
 * import { validateTag } from "pubky-social-specs";
 * console.log(validateTag({ uri: "https://example.com", label: "no spaces" }));
 * ```
 */
export declare function validateTag(input: unknown): Validation<{
    uri: string;
    label: string;
}>;
/**
 * `validateUser` as a Standard Schema.
 *
 * @example
 * ```ts
 * import { userSchema } from "pubky-social-specs";
 * const checked = userSchema["~standard"].validate({ name: "Alice" });
 * console.log(checked.issues === undefined);
 * ```
 */
export declare const userSchema: StandardSchemaV1<T.NewUser>;
/**
 * `validatePost` as a Standard Schema, without an owner.
 *
 * @example
 * ```ts
 * import { postSchema } from "pubky-social-specs";
 * const checked = postSchema["~standard"].validate({ content: "" });
 * if (checked.issues) console.log(checked.issues[0]?.message);
 * ```
 */
export declare const postSchema: StandardSchemaV1<T.NewPost>;
/**
 * `validateFeed` as a Standard Schema.
 *
 * @example
 * ```ts
 * import { feedSchema } from "pubky-social-specs";
 * console.log(feedSchema["~standard"].vendor);
 * ```
 */
export declare const feedSchema: StandardSchemaV1<T.NewFeed>;
/**
 * `validateTag` as a Standard Schema.
 *
 * @example
 * ```ts
 * import { tagSchema } from "pubky-social-specs";
 * console.log(tagSchema["~standard"].validate({ uri: "https://example.com", label: "rust" }));
 * ```
 */
export declare const tagSchema: StandardSchemaV1<{
    uri: string;
    label: string;
}>;
//# sourceMappingURL=validate.d.ts.map