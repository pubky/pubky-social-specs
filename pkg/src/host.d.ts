// The only globals the package may use: present in every browser, Node, Deno and Bun.
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean });
  decode(input?: Uint8Array): string;
}
