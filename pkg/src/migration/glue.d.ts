// The wasm-bindgen glue of the migrator, generated into dist/migration/glue.js by the build.

/** One run over an owner's 0.x tree. Opaque; `free()` it when the run ends. */
export class Migration {
  private constructor();
  free(): void;
}

/** A media id fed a chunk at a time. Opaque; `hasherFinish` consumes it. */
export class Hasher {
  private constructor();
  free(): void;
}

/**
 * The wasm: its bytes, or a `WebAssembly.Module` the bundler compiled ahead of time where the
 * runtime compiles none. Typed as an object, since a consumer's lib may not declare WebAssembly.
 */
export function __wbg_source(): Uint8Array | object;
/** The SHA-256 of the bytes as the build wrote them, lowercase hex. */
export const __wbg_sha256: string;
/** Compiles and starts what `__wbg_source` gave. Nothing below works before it resolves. */
export function __wbg_init(source: Uint8Array | object): Promise<void>;
export function createMigration(owner: string): Migration;
export function migrate(migration: Migration, v0Path: string, bytes: Uint8Array): unknown;
export function migrateBlob(migration: Migration, v0Path: string, size: number, hash: string): unknown;
export function hasherNew(): Hasher;
export function hasherUpdate(hasher: Hasher, chunk: Uint8Array): void;
export function hasherFinish(hasher: Hasher): string;
