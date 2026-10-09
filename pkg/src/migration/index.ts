// The migration engine: walks one owner's 0.x tree through a port and writes its 1.x copy.

import { ENGINE_CAPS, MIGRATION_CAPS, runMigration } from "./engine.js";
import { MigrationPortError, refusal } from "./port.js";
import { MemoryPort } from "./memory.js";
import { bucketOf } from "./order.js";
import { skipReasons, transformRev } from "../data.js";

export type { GetOptions, MigrationPort, PortErrorKind, PutOptions } from "./port.js";
export type { MemoryPortOptions, PortOp } from "./memory.js";
export type { Bucket } from "./order.js";
export type { AbortSignalLike, Counts, ErrorCode, MigrationError, MigrationLock, MigrationReport, Outcome, Phase, ProgressEvent, RunOptions } from "./types.js";

export type { Dropped, SkipReason } from "./wasm.js";

export { runMigration, ENGINE_CAPS, MIGRATION_CAPS, MigrationPortError, refusal, MemoryPort, bucketOf, skipReasons, transformRev };
