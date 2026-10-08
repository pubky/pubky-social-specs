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
/** Every issue of a profile input, as `buildUser` would refuse it. */
export declare function validateUser(input: unknown): Validation<T.NewUser>;
/**
 * Every issue of a post input, as `buildPost` would refuse it, without minting an id. With
 * `owner`, the rule that a private draft references only its owner's private objects runs too.
 */
export declare function validatePost(input: unknown, owner?: string): Validation<T.NewPost>;
/** Every issue of a feed input, as `buildFeed` would refuse it. */
export declare function validateFeed(input: unknown): Validation<T.NewFeed>;
/** Every issue of a tag, `{ uri, label }`, as `buildTag` would refuse it. */
export declare function validateTag(input: unknown): Validation<{
    uri: string;
    label: string;
}>;
/** `validateUser` as a Standard Schema. */
export declare const userSchema: StandardSchemaV1<T.NewUser>;
/** `validatePost` as a Standard Schema, without an owner. */
export declare const postSchema: StandardSchemaV1<T.NewPost>;
/** `validateFeed` as a Standard Schema. */
export declare const feedSchema: StandardSchemaV1<T.NewFeed>;
/** `validateTag` as a Standard Schema. */
export declare const tagSchema: StandardSchemaV1<{
    uri: string;
    label: string;
}>;
//# sourceMappingURL=validate.d.ts.map