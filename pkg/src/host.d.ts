// The only globals the package may use: the ones browsers, Node, Deno and Bun share. It
// compiles against these instead of a DOM or Node lib, so a host-only global does not compile.

declare class TextEncoder {
  encode(input?: string): Uint8Array<ArrayBuffer>;
}

declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
  decode(input?: Uint8Array): string;
}

declare const performance: { readonly timeOrigin: number; now(): number };

declare const crypto: { getRandomValues<T extends Uint16Array>(array: T): T };

declare function setTimeout(handler: () => void, ms: number): unknown;
declare function clearTimeout(id: unknown): void;
