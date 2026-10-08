// The one place a caller's value is read. Everything after works on the copy this makes:
// plain data, own members only, each read once, so an inherited member, a getter that answers
// differently on a second read, a Proxy trap or a typed array lying about its length cannot
// reach a rule.

import { plainBytes } from "./bytes.js";
import { misuse } from "./errors.js";

// No list of the model, and no history a caller walks, comes near this
const MAX_ITEMS = 1 << 20;
// The deepest input, a version inside a plan with its attachments, is five levels down
const MAX_DEPTH = 32;

/**
 * A caller's value as plain data: arrays dense, with a hole read as absent; objects as records
 * with no prototype holding their own enumerable members; bytes as a plain `Uint8Array` over
 * the memory the intrinsic getters report. A shared object is copied once and stays shared.
 * Primitives and functions pass as they are; the rules refuse what is not data.
 */
export function snapshot(value: unknown, at: string): unknown {
  const copies = new Map<object, unknown>();
  const open = new Set<object>();
  const copy = (js: unknown, where: string, depth: number): unknown => {
    if (typeof js !== "object" || js === null) return js;
    const done = copies.get(js);
    if (done !== undefined) return done;
    if (open.has(js)) misuse(where, "plain data, not a structure that contains itself");
    if (depth > MAX_DEPTH) misuse(where, `plain data nested at most ${MAX_DEPTH} deep`);
    const bytes = plainBytes(js);
    if (bytes !== null) return bytes;
    open.add(js);
    let out: unknown;
    if (Array.isArray(js)) {
      // Checked before it is walked: a length is free to claim
      const length = js.length;
      if (length > MAX_ITEMS) misuse(where, `an array of at most ${MAX_ITEMS} items`);
      // A hole reads as absent, never as what a polluted prototype holds at that index
      out = Array.from({ length }, (_, index) => (Object.hasOwn(js, index) ? copy(js[index], `${where}[${index}]`, depth + 1) : undefined));
    } else {
      const record = Object.create(null) as Record<string, unknown>;
      for (const key of Object.keys(js)) record[key] = copy((js as Record<string, unknown>)[key], `${where}.${key}`, depth + 1);
      out = record;
    }
    open.delete(js);
    copies.set(js, out);
    return out;
  };
  return copy(value, at, 0);
}
