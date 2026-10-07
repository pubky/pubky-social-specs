import { limits, skipReasons, transformRev } from "../data.js";
import { viewBytes } from "../bytes.js";
import { isCanonicalSegment } from "../canonicalize.js";
import { ValidationError } from "../errors.js";
import { legacyMediaKey, listPrefix, stableKey } from "../uri.js";
import { init, transforms } from "./wasm.js";
import type { Dropped, MigrateBlobResult, MigrateResult, MigratedWrite, Migration } from "./wasm.js";
import { portErrorKind } from "./port.js";
import type { MigrationPort, PortErrorKind } from "./port.js";
import { ordered } from "./order.js";
import type { Bucket } from "./order.js";
import type {
  AbortSignalLike,
  Counts,
  MigrationError,
  MigrationReport,
  Outcome,
  Phase,
  RunOptions,
} from "./types.js";

/**
 * The scopes the engine writes, and all it checks a session for: both 1.x roots. Reading and
 * listing the 0.x tree is anonymous.
 */
const ENGINE_CAPS = "/pub/social/v1/:rw,/priv/social/v1/:rw";

/**
 * The full session grant of a migrating pubky-app: `ENGINE_CAPS`, the app's own private
 * namespace, and the 0.x tree, which deleting a migrated object later still reaches. The
 * engine does not check it; it is what the app asks for when it upgrades a session.
 */
const MIGRATION_CAPS = `${ENGINE_CAPS},/priv/app.pubky/v1/:rw,/pub/pubky.app/:rw`;

const FLAG = "_migrated.json";
// The epoch this engine walks to; a later one needs its own discovery and sourcing
const DESTINATION_EPOCH = "social/v1/";
// Two objects in flight hide one GET behind the other's PUT; the homeserver is one origin
const IN_FLIGHT = 2;
const NETWORK_RETRIES = 3;
const FIRST_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
// Empty pages a LIST may answer in a row before the walk is called broken
const MAX_EMPTY_PAGES = 100;
// The largest 1.x object with every byte spelled as a six-byte escape: no 0.x object a client
// wrote is larger, and a larger one would hold wasm memory for the rest of the run
const LEGACY_OBJECT_MAX = 6 * limits.postMaxBytes;
const OUTCOMES: readonly string[] = [...skipReasons, "written", "already_present", "deleted_mid_run", "io_error", "put_rejected"];
const MESSAGES = {
  ALREADY_RUNNING: "A migration of this account is already running in another tab.",
  PRIV_UNSUPPORTED:
    "This homeserver has no private storage (/priv/), which the migration needs. Ask its operator to upgrade it, then run the migration again.",
  CAPS_MISSING: `The session cannot write everything the migration needs; it has to grant ${ENGINE_CAPS}.`,
  QUOTA: "The homeserver is out of space for this account.",
  SESSION_EXPIRED: "The session expired or lost its capabilities.",
  ABORTED: "The migration was stopped; run it again to resume.",
} as const;

/** Ends the run with a report instead of going on. */
class Stop extends Error {
  readonly error: MigrationError;

  constructor(error: MigrationError) {
    super(error.message);
    this.error = error;
  }
}

/** A port call that failed in a way the object absorbs, instead of stopping the run. */
interface Failure {
  failed: PortErrorKind;
  message: string;
  status?: number;
}

const isFailure = (value: unknown): value is Failure =>
  typeof value === "object" && value !== null && "failed" in value;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const decoder = new TextDecoder();

/** Whether every scope of `required` is granted, read and write alike, by one scope or several. */
const covers = (granted: string | string[], required: string): boolean => {
  const scopes = (caps: string | string[]) =>
    (Array.isArray(caps) ? caps : [caps])
      .flatMap((cap) => cap.split(","))
      .map((cap) => cap.trim())
      .filter(Boolean)
      .map((cap) => {
        const colon = cap.lastIndexOf(":");
        return { path: cap.slice(0, colon), actions: cap.slice(colon + 1) };
      });
  const have = scopes(granted);
  return scopes(required).every((need) =>
    [...need.actions].every((action) =>
      have.some(
        (cap) =>
          (cap.path === need.path || (cap.path.endsWith("/") && need.path.startsWith(cap.path))) &&
          cap.actions.includes(action),
      ),
    ),
  );
};

/** What a finished run recorded, or rev 0 and nothing for a flag this build cannot read. */
const readFlag = (bytes: Uint8Array): Flag => {
  const unread: Flag = { transformRev: 0, skipped: {}, migrated: new Set() };
  const strings = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === "string");
  let flag: unknown;
  try {
    flag = JSON.parse(decoder.decode(bytes));
  } catch {
    return unread;
  }
  if (typeof flag !== "object" || flag === null || Array.isArray(flag)) return unread;
  const own = (key: string): unknown => (Object.hasOwn(flag, key) ? (flag as Record<string, unknown>)[key] : undefined);
  const rev = own("transform_rev");
  const skipped = own("skipped") ?? {};
  const migrated = own("migrated") ?? [];
  if (typeof skipped !== "object" || skipped === null || Array.isArray(skipped) || !strings(migrated)) return unread;
  const kept: Partial<Record<Outcome, string[]>> = {};
  for (const [outcome, paths] of Object.entries(skipped)) {
    if (!OUTCOMES.includes(outcome) || !strings(paths)) return unread;
    kept[outcome as Outcome] = paths;
  }
  return { transformRev: Number.isSafeInteger(rev) ? (rev as number) : 0, skipped: kept, migrated: new Set(migrated) };
};

/** Whether `url` names an object under one of `roots`, by canonical segments only. */
const fenced = (url: string, roots: string[]): boolean =>
  roots.some((root) => url.startsWith(root) && url.slice(root.length).split("/").every(isCanonicalSegment));

/** Resolves after `ms`, or as soon as `signal` aborts. */
const timer = (ms: number, signal?: AbortSignalLike) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(id);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const id = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

/** Runs `work` over `items` with `width` in flight; the first throw stops new work and is rethrown. */
const pool = async <T>(
  items: T[],
  width: number,
  work: (item: T) => Promise<void>,
  stopped: () => boolean,
): Promise<void> => {
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async () => {
    while (!failure && !stopped() && next < items.length) {
      const item = items[next++] as T;
      try {
        await work(item);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  if (failure) throw failure.error;
};

/** The dedup key of an owner-relative path; a path with none is its own key. */
const keyOf = (path: string): string => {
  const id = stableKey(path);
  return id !== null && "key" in id ? id.key : path;
};

/**
 * What a write is present as. Media by its exact URL: a private copy, or one under another
 * extension, does not serve the public references this run writes. Anything else by its
 * key, which spans both roots, so a post unpublished to a draft is not copied back.
 */
const claimKey = (write: MigratedWrite): string =>
  write.kind === "file" ? write.meta.url : keyOf(write.meta.path);


/**
 * A blob's writes carry the bytes the run already holds, so its copy is the one PUT of that
 * array and its read-back is the hash that named the destination.
 */
const blobResult = (result: MigrateBlobResult, bytes: Uint8Array): MigrateResult =>
  "skip" in result
    ? result
    : {
        writes: result.writes.map((write) => ({ ...write, object: { bytes } })),
        dropped: result.dropped,
      };

const LANDED = Promise.resolve(true);

const equalBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, i) => byte === b[i]);

// The same JSON value, whatever the member order the port wrote it in
const sameJson = (a: unknown, b: unknown): boolean => {
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.hasOwn(b, key) && sameJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
};

interface Flag {
  transformRev: number;
  skipped: Partial<Record<Outcome, string[]>>;
  /** The 0.x paths an earlier run copied or found present. */
  migrated: Set<string>;
}

/** A claim this object holds on a key: settle it once, with whether its copy exists. */
interface Claim {
  write: MigratedWrite;
  settle: (landed: boolean) => void;
}

class Run {
  readonly #options: RunOptions;
  readonly #port: MigrationPort;
  readonly #dry: boolean;
  readonly #ownerPrefix: string;
  /** The two 1.x roots, the only places the run writes to or deletes from. */
  #roots: string[] = [];
  #handle?: Migration;
  #phase: Phase = "probe";
  #kind?: Bucket;
  #done = 0;
  #total = 0;
  #dropped = 0;
  readonly #counts = Object.fromEntries(
    [...skipReasons, "written", "already_present", "deleted_mid_run", "io_error", "put_rejected"].map(
      (outcome) => [outcome, 0],
    ),
  ) as Counts;
  #skipped: Partial<Record<Outcome, string[]>> = {};
  /**
   * The 0.x paths a finished run copied or found present. A later walk leaves them alone: a
   * copy missing now was deleted by its owner, and a delete leaves some 0.x copies in place.
   */
  #before: Set<string> = new Set();
  readonly #migrated: string[] = [];
  readonly #notes: { path: string; message: string }[] = [];
  readonly #droppedValues: Record<string, Dropped[]> = {};
  /**
   * Keys whose copy exists or is being made, each with whether it landed. A copy that did not
   * land drops its claim before settling, so the next object folding to the key writes it.
   */
  readonly #claims = new Map<string, Promise<boolean>>();
  /** Blob key to the size its File object declares. */
  readonly #blobSizes = new Map<string, number>();
  /** Blobs the walk has not yet copied or found present, for the space a paused run needs. */
  readonly #pendingBlobs = new Set<string>();

  constructor(options: RunOptions) {
    this.#options = options;
    this.#port = options.port;
    this.#dry = options.mode === "dry";
    this.#ownerPrefix = `pubky://${options.owner}/`;
  }

  async execute(): Promise<MigrationReport> {
    const { owner, rescan, caps } = this.#options;
    try {
      this.#checkAbort();
      const publicPrefix = listPrefix(owner, "public");
      if (!publicPrefix.endsWith(DESTINATION_EPOCH)) {
        throw new Stop({
          code: "UNSUPPORTED_EPOCH",
          message: `This build writes under ${publicPrefix}; the engine migrates to ${DESTINATION_EPOCH} only.`,
        });
      }
      // Local and first, so a session that cannot write 1.x is told so before any request
      if (caps !== undefined && !covers(caps, ENGINE_CAPS)) {
        throw new Stop({ code: "CAPS_MISSING", message: MESSAGES.CAPS_MISSING, caps: ENGINE_CAPS });
      }
      this.#emit();
      const privatePrefix = listPrefix(owner, "private");
      const flagUrl = privatePrefix + FLAG;
      this.#roots = [publicPrefix, privatePrefix];
      const flag = await this.#probe(flagUrl);
      if (flag && !rescan && flag.transformRev >= transformRev) {
        this.#skipped = flag.skipped;
        return this.#finish("already_migrated");
      }
      if (flag) this.#before = flag.migrated;

      this.#phase = "listing";
      this.#emit();
      for (const prefix of [publicPrefix, privatePrefix]) {
        for (const url of await this.#listAll(prefix)) {
          const id = stableKey(this.#relative(url));
          if (id === null || !("key" in id)) continue;
          this.#claims.set(id.key.startsWith("files/") ? url : id.key, LANDED);
        }
      }
      const legacyPrefix = listPrefix(owner, "legacy");
      const legacy = await this.#listAll(legacyPrefix);
      this.#total = legacy.length;
      const { passes, rest } = ordered(legacy, (url) => url.slice(legacyPrefix.length));
      for (const [bucket, urls] of passes) {
        if (bucket !== "blobs") continue;
        for (const url of urls) this.#pendingBlobs.add(keyOf(this.#relative(url)));
      }

      this.#phase = "migrating";
      this.#handle = transforms.createMigration(owner);
      for (const [bucket, urls] of passes) {
        this.#kind = bucket;
        await pool(urls, IN_FLIGHT, (url) => this.#object(bucket, url), () => this.#aborted());
        this.#checkAbort();
      }
      this.#kind = undefined;
      // settings.json, last_read and anything else no 1.x type takes
      for (const url of rest) {
        this.#count("not_migrated", this.#relative(url));
        this.#done++;
        this.#emit(url);
      }

      // Only a walk where every object reached an outcome of its own is recorded as done
      if (this.#counts.io_error > 0) return this.#finish("incomplete");
      if (!this.#dry) {
        this.#phase = "flag";
        this.#emit();
        const flagObject = {
          migrated_at: Date.now() * 1000,
          transform_rev: transformRev,
          skipped: this.#skippedSorted(),
          migrated: [...this.#migrated].sort(),
        };
        const put = await this.#attempt(() => this.#port.putJson(flagUrl, flagObject));
        if (isFailure(put)) {
          throw new Stop({ code: "IO_ERROR", message: `writing ${FLAG}: ${put.message}` });
        }
      }
      return this.#finish("done");
    } catch (error) {
      if (!(error instanceof Stop)) throw error;
      return this.#finish(error.error.code === "QUOTA" ? "paused" : "aborted", error.error);
    } finally {
      this.#handle?.free();
    }
  }

  /** The report of a run that could not start. */
  refuse(code: "ALREADY_RUNNING"): MigrationReport {
    return this.#finish("aborted", { code, message: MESSAGES[code] });
  }

  /** The flag, when this homeserver has a private root and a run has finished before. */
  async #probe(flagUrl: string): Promise<Flag | null> {
    const exists = await this.#attempt(() => this.#port.head(flagUrl));
    if (isFailure(exists)) {
      if (exists.failed === "not_found") return null;
      if (exists.failed === "unsupported") {
        throw new Stop({ code: "PRIV_UNSUPPORTED", message: MESSAGES.PRIV_UNSUPPORTED });
      }
      throw new Stop({ code: "IO_ERROR", message: `probing ${FLAG}: ${exists.message}` });
    }
    if (!exists) return null;
    const bytes = await this.#attempt(() => this.#port.get(flagUrl));
    if (isFailure(bytes)) {
      if (bytes.failed === "not_found") return null;
      throw new Stop({ code: "IO_ERROR", message: `reading ${FLAG}: ${bytes.message}` });
    }
    if (bytes === null) return null;
    // A flag this build cannot read is treated as older, so the tree is walked again
    const view = viewBytes(bytes);
    return view === null ? readFlag(new Uint8Array()) : readFlag(view);
  }

  async #listAll(prefix: string): Promise<string[]> {
    const urls: string[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    let emptyPages = 0;
    for (;;) {
      this.#checkAbort();
      const page = await this.#attempt(() => this.#port.list(prefix, cursor));
      if (isFailure(page)) {
        throw new Stop({ code: "IO_ERROR", message: `listing ${prefix}: ${page.message}` });
      }
      // Every key below is derived from the URL, so another spelling of it would skew them all
      const stray = page.urls.find((url) => !url.startsWith(prefix));
      if (stray !== undefined) {
        throw new Stop({ code: "IO_ERROR", message: `listing ${prefix} returned ${stray}` });
      }
      urls.push(...page.urls);
      if (!page.next) return urls;
      // A cursor is opaque, so only a repeat, or empty pages without end, tell a walk that
      // would never finish; either is the port's fault and the run must not record a flag
      emptyPages = page.urls.length === 0 ? emptyPages + 1 : 0;
      if (seen.has(page.next) || emptyPages > MAX_EMPTY_PAGES) {
        throw new Stop({ code: "IO_ERROR", message: `listing ${prefix}: the cursor ${page.next} does not advance` });
      }
      seen.add(page.next);
      cursor = page.next;
    }
  }

  async #object(bucket: Bucket, url: string): Promise<void> {
    const path = this.#relative(url);
    const outcome = await this.#migrateOne(bucket, url, path);
    this.#done++;
    // A blob that failed to copy still needs its space when the run resumes
    if (bucket === "blobs" && outcome !== "io_error") this.#pendingBlobs.delete(keyOf(path));
    this.#emit(url);
  }

  async #migrateOne(bucket: Bucket, url: string, path: string): Promise<Outcome | undefined> {
    // A File object writes nothing and feeds the run, so it is read on every walk. A blob's
    // destination carries the extension its File declares, so only its write can tell whether
    // a copy is present.
    if (bucket !== "files" && this.#before.has(path)) return this.#count("already_present", path);
    const present = bucket !== "files" && bucket !== "blobs" && (await this.#landed(keyOf(path)));
    if (present) return this.#count("already_present", path);
    const max = bucket === "blobs" ? limits.maxFileSizeBytes : LEGACY_OBJECT_MAX;
    const got = await this.#attempt(() => this.#port.get(url, { maxBytes: max }));
    if (isFailure(got) && got.failed === "too_large") return this.#count("oversize", path);
    if (isFailure(got) && got.failed !== "not_found") {
      // Every later blob and post reads the Files; migrating them without one would bake a
      // wrong extension or media URL into copies no later run rewrites
      if (bucket === "files") {
        throw new Stop({ code: "IO_ERROR", message: `reading ${path}: ${got.message}` });
      }
      return this.#count("io_error", path, got.message);
    }
    if (got === null || isFailure(got)) return this.#count("deleted_mid_run", path);
    const bytes = viewBytes(got);
    if (bytes === null) throw new TypeError(`pubky-social-specs/migration: the port's get() gave no Uint8Array for ${url}`);
    // A port may not bound its read; the cap still holds before the wasm sees anything
    if (bytes.length > max) return this.#count("oversize", path);

    let result: MigrateResult;
    try {
      // A blob never enters the wasm: a copy there would stay for the rest of the run
      result =
        bucket === "blobs"
          ? blobResult(transforms.migrateBlob(this.#handle!, url, bytes.length, transforms.mediaId(bytes)), bytes)
          : transforms.migrate(this.#handle!, url, bytes);
    } catch (error) {
      // The rules refused the object; anything else is a fault of the port or of this package
      if (!(error instanceof ValidationError)) throw error;
      return this.#count("invalid", path, error.message);
    }
    if ("skip" in result) return this.#count(result.skip, path, result.note);
    // The port can write the whole tree, the 0.x one included, which the run must never touch
    for (const write of result.writes) {
      if (!fenced(write.meta.url, this.#roots)) {
        throw new Error(`pubky-social-specs/migration: a write to ${write.meta.url}, outside ${this.#roots.join(" and ")}`);
      }
    }
    if (bucket === "files") {
      this.#learnFile(path, bytes);
      return undefined;
    }

    const claims: Claim[] = [];
    try {
      for (const write of result.writes) {
        const settle = await this.#claim(claimKey(write));
        if (settle) claims.push({ write, settle });
      }
      if (claims.length === 0) return this.#count("already_present", path);
      if (this.#dry) {
        claims.forEach((claim) => claim.settle(true));
        return this.#written(path, result.dropped);
      }
      return await this.#copy(url, path, claims, result.dropped);
    } finally {
      // A stop or a fault mid-copy must not leave another object waiting on a claim
      claims.forEach((claim) => claim.settle(false));
    }
  }

  /** PUTs the claimed writes, then re-checks the source; settles every claim it holds. */
  async #copy(url: string, path: string, claims: Claim[], dropped: Dropped[]): Promise<Outcome> {
    const made: Claim[] = [];
    for (const claim of claims) {
      const { write } = claim;
      const put = await this.#attempt(() =>
        write.kind === "file"
          ? this.#port.putBytes(write.meta.url, write.object.bytes, { ifAbsent: true })
          : this.#port.putJson(write.meta.url, write.object, { ifAbsent: true }),
      );
      if (!isFailure(put)) {
        made.push(claim);
      } else if (put.failed === "exists") {
        // Written by someone else since the LIST: theirs stays, and it is not this run's to delete
        claim.settle(true);
      } else {
        made.forEach((m) => m.settle(true));
        const outcome = put.failed === "network" ? "io_error" : "put_rejected";
        return this.#count(outcome, path, put.message);
      }
    }
    if (made.length === 0) return this.#count("already_present", path);

    // The owner may have deleted the source while it was being copied; the copy goes too. A
    // copy the re-check could not vouch for goes as well, and the next run copies it again.
    const stillThere = await this.#attempt(() => this.#port.head(url));
    if (!isFailure(stillThere) && stillThere) {
      made.forEach((m) => m.settle(true));
      return this.#written(path, dropped);
    }
    for (const [i, claim] of made.entries()) {
      // Over a check-then-write port another device may have written there since; theirs stays
      const ours = await this.#holds(claim.write);
      const deleted = ours === true ? await this.#attempt(() => this.#port.delete(claim.write.meta.url)) : ours;
      if (isFailure(deleted) && deleted.failed !== "not_found") {
        // The copies before this one are gone, this one and the rest are still there
        made.forEach((m, j) => m.settle(j >= i));
        return this.#count("io_error", path, `deleting ${claim.write.meta.url}: ${deleted.message}`);
      }
    }
    made.forEach((m) => m.settle(false));
    if (isFailure(stillThere)) {
      return this.#count("io_error", path, `re-check after copy: ${stillThere.message}`);
    }
    return this.#count("deleted_mid_run", path);
  }

  /**
   * Whether what is stored at the write's URL is what this run wrote there: `false` for
   * something else or nothing, a failure when the GET failed.
   */
  async #holds(write: MigratedWrite): Promise<boolean | Failure> {
    const stored = await this.#attempt(() => this.#port.get(write.meta.url));
    if (isFailure(stored)) return stored.failed === "not_found" ? false : stored;
    const bytes = stored === null ? null : viewBytes(stored);
    if (bytes === null) return false;
    if (write.kind === "file") return equalBytes(bytes, write.object.bytes);
    try {
      return sameJson(JSON.parse(decoder.decode(bytes)), write.object);
    } catch {
      return false;
    }
  }

  /** Whether a copy under `key` exists, waiting for one being made to land or not. */
  async #landed(key: string): Promise<boolean> {
    for (;;) {
      const claim = this.#claims.get(key);
      if (claim === undefined) return false;
      if (await claim) return true;
    }
  }

  /** Claims `key` for a write, or `null` when a copy exists or another object's landed. */
  async #claim(key: string): Promise<Claim["settle"] | null> {
    for (;;) {
      if (await this.#landed(key)) return null;
      if (this.#claims.has(key)) continue;
      let resolve!: (landed: boolean) => void;
      const claim = new Promise<boolean>((r) => (resolve = r));
      this.#claims.set(key, claim);
      let settled = false;
      return (landed) => {
        if (settled) return;
        settled = true;
        if (!landed && this.#claims.get(key) === claim) this.#claims.delete(key);
        resolve(landed);
      };
    }
  }

  /** Keeps what a File object declares about its blob's size, for a paused run's estimate. */
  #learnFile(path: string, bytes: Uint8Array): void {
    try {
      const { src, size } = JSON.parse(decoder.decode(bytes));
      const key = typeof src === "string" ? legacyMediaKey(src) : null;
      if (key !== null && Number.isSafeInteger(size) && size >= 0) this.#blobSizes.set(key, size);
    } catch {
      // The run already read it; only the estimate misses it
    }
  }

  /**
   * One port call with the retries the run owes it: a rate limit waits and calls again, a
   * network failure is retried. A full homeserver and a lost session stop the run; any other
   * failure comes back for the object to count.
   */
  async #attempt<T>(call: () => Promise<T>): Promise<T | Failure> {
    let backoff = FIRST_BACKOFF_MS;
    let retries = 0;
    for (;;) {
      try {
        return await call();
      } catch (error) {
        const kind = portErrorKind(error);
        if (kind === "quota") {
          throw new Stop({ code: "QUOTA", message: MESSAGES.QUOTA });
        }
        if (kind === "unauthorized") {
          throw new Stop({ code: "SESSION_EXPIRED", message: MESSAGES.SESSION_EXPIRED });
        }
        if (kind === "rate_limited" || (kind === "network" && retries++ < NETWORK_RETRIES)) {
          await this.#wait(backoff);
          backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
          continue;
        }
        const status = (error as { status?: unknown } | null)?.status;
        return {
          failed: kind,
          message: messageOf(error),
          ...(typeof status === "number" ? { status } : {}),
        };
      }
    }
  }

  async #wait(ms: number): Promise<void> {
    this.#checkAbort();
    const { sleep, signal } = this.#options;
    await (sleep ? sleep(ms, signal) : timer(ms, signal));
    this.#checkAbort();
  }

  #aborted(): boolean {
    return this.#options.signal?.aborted ?? false;
  }

  #checkAbort(): void {
    if (this.#aborted()) throw new Stop({ code: "ABORTED", message: MESSAGES.ABORTED });
  }

  #relative(url: string): string {
    return url.startsWith(this.#ownerPrefix) ? url.slice(this.#ownerPrefix.length) : url;
  }

  #written(path: string, dropped: Dropped[]): Outcome {
    if (dropped.length > 0) {
      this.#dropped += dropped.length;
      this.#droppedValues[path] = dropped;
    }
    return this.#count("written", path);
  }

  // Objects reach their outcome in a racy order, two at a time; the flag and the report list
  // them sorted so two runs over one tree write the same bytes
  #skippedSorted(): Partial<Record<Outcome, string[]>> {
    return Object.fromEntries(Object.entries(this.#skipped).map(([outcome, paths]) => [outcome, [...paths].sort()]));
  }

  #count(outcome: Outcome, path: string, note?: string): Outcome {
    this.#counts[outcome]++;
    if (outcome === "written" || outcome === "already_present") this.#migrated.push(path);
    if (outcome !== "written" && outcome !== "already_present") {
      (this.#skipped[outcome] ??= []).push(path);
    }
    if (note !== undefined) this.#notes.push({ path, message: note });
    return outcome;
  }

  #emit(current?: string, error?: MigrationError): void {
    this.#options.onProgress?.({
      phase: this.#phase,
      ...(this.#kind ? { kind: this.#kind } : {}),
      done: this.#done,
      total: this.#total,
      counts: { ...this.#counts },
      dropped: this.#dropped,
      ...(current !== undefined ? { current } : {}),
      ...(error ? { error } : {}),
    });
  }

  #finish(status: MigrationReport["status"], error?: MigrationError): MigrationReport {
    if (error?.code === "QUOTA" && this.#pendingBlobs.size > 0) {
      let needBytes = 0;
      for (const key of this.#pendingBlobs) needBytes += this.#blobSizes.get(key) ?? 0;
      error = { ...error, needBytes };
    }
    this.#phase = status === "already_migrated" ? "done" : status;
    this.#kind = undefined;
    this.#emit(undefined, error);
    return {
      status,
      mode: this.#dry ? "dry" : "run",
      done: this.#done,
      total: this.#total,
      counts: { ...this.#counts },
      dropped: this.#dropped,
      droppedValues: this.#droppedValues,
      skipped: this.#skippedSorted(),
      notes: this.#notes,
      ...(error ? { error } : {}),
    };
  }
}

/**
 * Migrates `owner`'s 0.x tree to 1.x through `port`. Resumable: the 1.x tree is the journal,
 * so an interrupted run resumes by running again, and nothing that exists is overwritten.
 * The 0.x tree is never modified. Resolves with a report in every case but a programming
 * error, which rejects.
 */
const runMigration = async (options: RunOptions): Promise<MigrationReport> => {
  const mode = options.mode ?? "run";
  if (mode !== "run" && mode !== "dry") {
    throw new Error(`pubky-social-specs/migration: mode must be "run" or "dry", not ${String(mode)}`);
  }
  await init();
  const { lock, owner } = options;
  if (!lock) return new Run(options).execute();
  return lock(`pubky-social-specs:migration:${owner}`, (held) =>
    held === null
      ? Promise.resolve(new Run(options).refuse("ALREADY_RUNNING"))
      : new Run(options).execute(),
  );
};

export { ENGINE_CAPS, MIGRATION_CAPS, runMigration };
