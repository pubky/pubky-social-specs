// Byte views read through the intrinsic getters: bytes from another realm are bytes too, and a
// subclass may report a length or an offset its memory does not have, which the glue would copy
// past.

const TypedArray = Object.getPrototypeOf(Uint8Array.prototype) as object;
// eslint-disable-next-line @typescript-eslint/unbound-method -- an intrinsic getter, only ever called through .call
const getter = (owner: object, name: string | symbol) => Object.getOwnPropertyDescriptor(owner, name)?.get as (this: unknown) => unknown;
const tagOf = getter(TypedArray, Symbol.toStringTag);
const bufferOf = getter(TypedArray, "buffer");
const offsetOf = getter(TypedArray, "byteOffset");
const lengthOf = getter(TypedArray, "byteLength");
const bufferLengthOf = getter(ArrayBuffer.prototype, "byteLength");
const SINGLE = ["Uint8Array", "Uint8ClampedArray", "Int8Array"];

// The ArrayBuffer getter refuses a SharedArrayBuffer, which a host may not even define
function isShared(buffer: unknown): boolean {
  try {
    bufferLengthOf.call(buffer);
    return false;
  } catch {
    return true;
  }
}

/**
 * A plain `Uint8Array` over the memory of a view of single bytes, or null; a detached one is
 * null. Shared memory is copied, so another thread cannot change the bytes between two reads.
 */
export function viewBytes(value: unknown): Uint8Array<ArrayBuffer> | null {
  if (!SINGLE.includes(tagOf.call(value) as string)) return null;
  try {
    const buffer = bufferOf.call(value) as ArrayBuffer;
    const view = new Uint8Array(buffer, offsetOf.call(value) as number, lengthOf.call(value) as number);
    return isShared(buffer) ? new Uint8Array(view) : view;
  } catch {
    return null;
  }
}
