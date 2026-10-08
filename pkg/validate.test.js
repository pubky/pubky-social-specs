// The validators: every issue at once, through the builders' own rules, and the Standard Schema
// interface a form library calls.

import assert from "assert";
import fc from "fast-check";
import { buildFeed, buildPost, buildTag, buildUser, feedSchema, postSchema, tagSchema, userSchema, validateFeed, validatePost, validateTag, validateUser, ValidationError } from "./dist/index.js";
import { setClock } from "./dist/testing.js";
import { OTTO, RIO, T0 } from "./core.fixture.js";
fc.configureGlobal({ seed: Number(process.env.FC_SEED ?? 20261008), numRuns: Number(process.env.FC_RUNS ?? 200) });

const refusalOf = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof ValidationError) return e.reason;
    // A shape is named by the argument it came in, which differs between the two calls
    if (e instanceof TypeError && e.message.startsWith("pubky-social-specs: ")) return "shape";
    throw e;
  }
};

describe("validators", function () {
  this.timeout(120_000);
  beforeEach(() => setClock(() => T0));
  after(() => setClock());

  it("report every issue of an input, each with its path, code and message", () => {
    const result = validateUser({ name: "", links: [{ title: " ", url: "ftp://x" }], status: 3 });
    assert.strictEqual(result.success, false);
    assert.deepStrictEqual(
      result.issues.map(({ path, code }) => [path, code]),
      [
        [["status"], "invalid_type"],
        [["name"], "invalid"],
        [["links", 0, "title"], "invalid"],
        [["links", 0, "url"], "invalid"],
      ],
    );
    assert.strictEqual(result.issues[1].message, "name must not be blank");
  });

  it("collect the rules of a post's kind, its references and its envelope together", () => {
    const result = validatePost({ kind: "article", title: "", body: "b", parent: "not a uri", attachments: [{ uri: "https://x.com/a", name: " " }], slug: "Bad Slug" });
    assert.deepStrictEqual(result.issues.map((i) => i.path.join(".")).sort(), ["attachments.0.name", "parent", "slug", "title"]);
  });

  it("with an owner, refuse a private draft's reference to another user's private object", () => {
    const input = { content: "x", root: "private", attachments: [{ uri: `pubky://${RIO}/priv/social/v1/files/0000000000000000000000000G.png` }] };
    assert.strictEqual(validatePost(input).success, true);
    assert.match(validatePost(input, OTTO).issues[0].message, /of another user/);
  });

  it("never mint: a validated post leaves the next id where it was", () => {
    buildPost(OTTO, { content: "a" });
    for (let i = 0; i < 5; i++) validatePost({ content: "b" });
    const after = buildPost(OTTO, { content: "c" }).id;
    setClock(() => T0);
    buildPost(OTTO, { content: "a" });
    assert.strictEqual(buildPost(OTTO, { content: "c" }).id, after);
  });

  it("give back the checked copy as plain data, read once", () => {
    let reads = 0;
    const input = {
      get name() {
        reads++;
        return "Alice";
      },
    };
    const result = validateUser(input);
    assert.deepStrictEqual(result, { success: true, value: { name: "Alice" } });
    assert.strictEqual(Object.getPrototypeOf(result.value), Object.prototype);
    assert.strictEqual(reads, 1);
  });

  it("an input that is no object is one issue at the root", () => {
    for (const validate of [validateUser, validatePost, validateFeed, validateTag]) {
      assert.deepStrictEqual(validate(null).issues, [{ path: [], code: "invalid_type", message: "pubky-social-specs: input must be an object" }]);
    }
    assert.deepStrictEqual(
      validateTag({ uri: "https://x.com", label: "ok", extra: 1 }).issues.map((i) => i.path),
      [["extra"]],
    );
  });

  it("stop at a hundred issues, so a hostile input costs no more than a form", () => {
    const started = Date.now();
    const result = validateUser(new Uint8Array(1 << 20));
    assert.strictEqual(result.issues.length, 100);
    assert.ok(Date.now() - started < 1000);
  });

  it("implement Standard Schema version 1", () => {
    for (const schema of [userSchema, postSchema, feedSchema, tagSchema]) {
      assert.strictEqual(schema["~standard"].version, 1);
      assert.strictEqual(schema["~standard"].vendor, "pubky-social-specs");
    }
    assert.deepStrictEqual(userSchema["~standard"].validate({ name: "Alice" }), { value: { name: "Alice" } });
    const failed = feedSchema["~standard"].validate({ name: "F", icon: "star", reach: "nope", layout: "list", sort: "recent" });
    assert.deepStrictEqual(
      failed.issues.map((i) => i.path),
      [["reach"]],
    );
    assert.ok(!("value" in failed));
  });

  describe("agree with the builders", () => {
    const text = fc.oneof(fc.string({ maxLength: 30 }), fc.constantFrom("", " ", "ok", "https://example.com/a", "javascript:x"), fc.integer());
    const maybe = fc.option(text, { nil: undefined });

    it("an input passes exactly when its builder takes it, and a refusal is one of the issues", () => {
      const check = (validate, build) => (input) => {
        const refusal = refusalOf(() => build(input));
        const result = validate(input);
        assert.strictEqual(result.success, refusal === null, `${JSON.stringify(input)}: ${refusal}`);
        if (refusal !== null)
          assert.ok(
            result.issues.some((i) => (refusal === "shape" ? i.code === "invalid_type" : i.message === refusal)),
            `${refusal} not in ${JSON.stringify(result.issues)}`,
          );
      };
      fc.assert(
        fc.property(
          fc.record(
            { name: text, bio: maybe, image: maybe, status: maybe, links: fc.option(fc.array(fc.record({ title: text, url: text }), { maxLength: 2 }), { nil: undefined }) },
            { requiredKeys: [] },
          ),
          check(validateUser, (i) => buildUser(OTTO, i)),
        ),
      );
      fc.assert(
        fc.property(
          fc.oneof(
            fc.record(
              {
                content: text,
                kind: fc.option(fc.constantFrom("note", "image", "bogus"), { nil: undefined }),
                parent: maybe,
                embed: maybe,
                slug: maybe,
                root: fc.option(fc.constantFrom("public", "private", "x"), { nil: undefined }),
              },
              { requiredKeys: [] },
            ),
            fc.record({ kind: fc.constant("article"), title: text, body: text, cover_image: maybe }, { requiredKeys: ["kind"] }),
            fc.record(
              { kind: fc.constant("collection"), name: text, description: maybe, items: fc.option(fc.array(fc.record({ uri: text, note: maybe }), { maxLength: 2 }), { nil: undefined }) },
              { requiredKeys: ["kind"] },
            ),
          ),
          check(
            (i) => validatePost(i, OTTO),
            (i) => buildPost(OTTO, i),
          ),
        ),
      );
      fc.assert(
        fc.property(
          fc.record(
            {
              name: text,
              icon: text,
              reach: fc.constantFrom("all", "me", "x"),
              layout: fc.constantFrom("list", "x"),
              sort: fc.constantFrom("recent", 1),
              tags: fc.option(fc.array(text, { maxLength: 3 }), { nil: undefined }),
            },
            { requiredKeys: [] },
          ),
          check(validateFeed, (i) => buildFeed(OTTO, i)),
        ),
      );
      fc.assert(
        fc.property(
          fc.record({ uri: text, label: text }, { requiredKeys: [] }),
          check(validateTag, (i) => buildTag(OTTO, i.uri, i.label)),
        ),
      );
    });
  });
});
