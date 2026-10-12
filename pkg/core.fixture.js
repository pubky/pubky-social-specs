// What the suites of the core share: two owners, a fixed instant, and the two ways a call is
// refused.

import assert from "assert";
import { ArgumentError, ValidationError } from "./dist/index.js";

export const OTTO = "8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto";
export const RIO = "dzswkfy7ek3bqnoc89jxuqqfbzhjrj6mi8qthgbxxcqkdugm3rio";
// 2026-09-22T16:53:20Z, inside the window every stored id has to be in
export const T0 = 1_790_000_000_000;

export const utf8 = (s) => new TextEncoder().encode(s);
export const text = (bytes) => new TextDecoder().decode(bytes);

// A rule of the data model: the reference's own message
export const refuses = (fn, message) =>
  assert.throws(fn, (e) => {
    assert.ok(e instanceof ValidationError, `expected a ValidationError, got ${e}`);
    message instanceof RegExp ? assert.match(e.message, message) : assert.strictEqual(e.message, message);
    return true;
  });

// A bug in the caller: the package's own words
export const misuse = (fn, pattern) =>
  assert.throws(fn, (e) => {
    // An engine TypeError, a property read on undefined, is a slip the contract excludes
    assert.ok(e instanceof ArgumentError, `expected an ArgumentError, got ${e}`);
    assert.match(e.message, pattern);
    return true;
  });

// What `fn` threw; a call that returns fails the test
export const caught = (fn) => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  assert.fail("no refusal");
};
