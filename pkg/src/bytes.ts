// Byte inputs, read through the intrinsic getters: bytes from another realm are bytes too, and
// a subclass may report a length or an offset its memory does not have.

const TypedArray = Object.getPrototypeOf(Uint8Array.prototype) as object;
const getter = (owner: object, name: string | symbol) => Object.getOwnPropertyDescriptor(owner, name)?.get as (this: unknown) => unknown;
const tagOf = getter(TypedArray, Symbol.toStringTag);
const bufferOf = getter(TypedArray, "buffer");
const offsetOf = getter(TypedArray, "byteOffset");
const lengthOf = getter(TypedArray, "byteLength");
const bufferLengthOf = getter(ArrayBuffer.prototype, "byteLength");
const SINGLE = ["Uint8Array", "Uint8ClampedArray", "Int8Array"];

/** A plain `Uint8Array` over the memory of a view of single bytes, or null; a detached one is null. */
export function viewBytes(value: unknown): Uint8Array<ArrayBuffer> | null {
  if (!SINGLE.includes(tagOf.call(value) as string)) return null;
  try {
    return new Uint8Array(bufferOf.call(value) as ArrayBuffer, offsetOf.call(value) as number, lengthOf.call(value) as number);
  } catch {
    return null;
  }
}

/** `viewBytes`, and an `ArrayBuffer` as the bytes it holds. */
export function plainBytes(value: unknown): Uint8Array<ArrayBuffer> | null {
  const view = viewBytes(value);
  if (view !== null) return view;
  try {
    bufferLengthOf.call(value);
    return new Uint8Array(value as ArrayBuffer);
  } catch {
    return null;
  }
}
