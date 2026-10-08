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

/** The embedded wasm's bytes. */
export function __wbg_bytes(): Uint8Array;
/** The SHA-256 of those bytes as the build wrote them, lowercase hex. */
export const __wbg_sha256: string;
/** Compiles and starts `bytes`. Nothing below works before it resolves. */
export function __wbg_init(bytes: Uint8Array): Promise<void>;
export function createMigration(owner: string): Migration;
export function migrate(migration: Migration, v0Path: string, bytes: Uint8Array): unknown;
export function migrateBlob(migration: Migration, v0Path: string, size: number, hash: string): unknown;
export function hasherNew(): Hasher;
export function hasherUpdate(hasher: Hasher, chunk: Uint8Array): void;
export function hasherFinish(hasher: Hasher): string;
