// The replica's testnet, and what seed, run and replay share: a homeserver on disk behind a
// Postgres, both in Docker volumes, and the replica's users with their keys.
//
// The testnet keeps its homeserver in memory unless it runs `persist`, so the replica runs
// persistent: the file store lives in the `replay-hs` volume and survives a restart, which the
// rate limit case needs to load another config. The DHT and the pkarr relay do not survive
// one, so every start publishes again the record of every user the seed signed up.

import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { Keypair, Pubky, PublicKey } from "@synonymdev/pubky";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

// The testnet's fixed homeserver key; the testnet derives it from a zero secret
export const HOMESERVER = "8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo";
export const HOST = process.env.PUBKY_TESTNET_HOST || "localhost";
const ADMIN = `http://${HOST}:6288`;
const ADMIN_PASSWORD = "replay";
const PG = { name: "replay-pg", volume: "replay-pg", port: 55432 };
const HS = { name: "replay-testnet", volume: "replay-hs", image: "synonymsoft/homeserver-testnet:v0.14.0" };

/** The homeserver config, with the rate limits a case asks for appended. */
export const config = (rateLimits = "") => `[general]
signup_mode = "open"
database_url = "postgres://postgres:postgres@localhost:${PG.port}/postgres"

[drive]
pubky_listen_socket = "0.0.0.0:6287"
icann_listen_socket = "0.0.0.0:6286"
${rateLimits}
[default_quotas]

[storage]
type = "file_system"

[admin]
enabled = true
listen_socket = "0.0.0.0:6288"
admin_password = "${ADMIN_PASSWORD}"

[metrics]
enabled = false

[pkdns]
public_ip = "127.0.0.1"
icann_domain = "localhost"
user_keys_republisher_interval = 0

[logging]
level = "warn"
`;

const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const dockerIn = (input, ...args) => execFileSync("docker", args, { input, encoding: "utf8" });
const exists = (name) => docker("ps", "-a", "--filter", `name=^${name}$`, "--format", "{{.Names}}") === name;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Writes the homeserver's config.toml into its volume; it takes effect at the next start. */
export const writeConfig = (text) =>
  dockerIn(text, "run", "--rm", "-i", "-v", `${HS.volume}:/data`, "alpine:3", "sh", "-c", "cat > /data/config.toml");

/**
 * Starts Postgres and the testnet unless they run, waits until the homeserver is reachable,
 * and publishes the records of the users `dataDir`'s seed signed up.
 */
export const up = async (dataDir) => {
  if (!exists(PG.name)) {
    // A replica is thrown away when it breaks, so the database skips the flushes each PUT waits on
    docker("run", "-d", "--name", PG.name, "--network", "host", "-e", "POSTGRES_PASSWORD=postgres",
      "-v", `${PG.volume}:/var/lib/postgresql`, "--log-opt", "max-size=10m", "postgres:18-alpine",
      "-p", String(PG.port), "-c", "listen_addresses=127.0.0.1", "-c", "fsync=off", "-c", "synchronous_commit=off",
      "-c", "full_page_writes=off");
  } else docker("start", PG.name);
  for (let i = 0; ; i++) {
    try {
      docker("exec", PG.name, "pg_isready", "-U", "postgres", "-h", "127.0.0.1", "-p", String(PG.port));
      break;
    } catch (error) {
      if (i > 60) throw error;
      await sleep(1000);
    }
  }
  if (!exists(HS.name)) {
    writeConfig(config());
    docker("run", "-d", "--name", HS.name, "--network", "host", "-v", `${HS.volume}:/data`,
      "--log-opt", "max-size=20m", "--log-opt", "max-file=2", HS.image, "homeserver", "persist", "/data");
  } else docker("start", HS.name);
  await ready();
  await republish(dataDir);
};

/** Restarts the homeserver, which reads its config again, and publishes the users' records. */
export const restart = async (dataDir) => {
  docker("restart", HS.name);
  await ready();
  await republish(dataDir);
};

const republish = async (dataDir) => {
  const statePath = path.join(dataDir, "seed-state.json");
  if (!existsSync(statePath)) return 0;
  const signedUp = new Set(Object.entries(JSON.parse(readFileSync(statePath, "utf8")).users ?? {}).filter(([, u]) => u.signedUp).map(([pk]) => pk));
  const users = replicaUsers(dataDir).filter((u) => signedUp.has(u.pk));
  await pool(users, 8, (u) => retrying(() => pubky().signer(keypairOf(u.secret)).pkdns.publishHomeserverForce(homeserver())));
  return users.length;
};

/** The seed the testnet holds now: every report and dump carries it, so a reseed voids them. */
export const seedEpoch = (dataDir) => {
  const statePath = path.join(dataDir, "seed-state.json");
  return existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")).epoch ?? null) : null;
};

/** Removes both containers and their volumes. */
export const down = () => {
  for (const name of [HS.name, PG.name]) if (exists(name)) docker("rm", "-f", name);
  for (const volume of [HS.volume, PG.volume]) {
    try {
      docker("volume", "rm", volume);
    } catch {
      // already gone
    }
  }
};

/** Bytes on disk of each volume that exists, from `du -s` blocks inside it. */
export const volumeBytes = () => {
  const sizes = {};
  const existing = new Set(docker("volume", "ls", "-q").split("\n"));
  for (const volume of [HS.volume, PG.volume].filter((v) => existing.has(v))) {
    const kb = docker("run", "--rm", "-v", `${volume}:/v:ro`, "alpine:3", "du", "-sk", "/v").split(/\s/)[0];
    sizes[volume] = Number(kb) * 1024;
  }
  return sizes;
};

// The ports open before the homeserver publishes its record, and a signup before that fails
const ready = async () => {
  const deadline = Date.now() + 180_000;
  for (;;) {
    try {
      const record = await fetch(`http://${HOST}:15411/${HOMESERVER}`);
      const hs = await fetch(`http://${HOST}:6286/`);
      if (record.ok && hs.status < 500) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`the testnet did not come up within 180 s:\n${docker("logs", "--tail", "30", HS.name)}`);
    await sleep(1000);
  }
};

/** Calls the homeserver's admin API. */
export const admin = async (method, route, body) => {
  const response = await fetch(`${ADMIN}${route}`, {
    method,
    headers: { "X-Admin-Password": ADMIN_PASSWORD, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`admin ${method} ${route}: ${response.status} ${await response.text()}`);
  return response.headers.get("content-type")?.includes("json") ? response.json() : response.text();
};

export const pubky = () => Pubky.testnet(HOST);
export const homeserver = () => PublicKey.from(HOMESERVER);

/** The replica's users, `{pk, secret}`, smallest tree first unless `only` orders them. */
export const replicaUsers = (dataDir, only) => {
  const keys = JSON.parse(readFileSync(path.join(dataDir, "keys.json"), "utf8"));
  const replica = path.join(dataDir, "replica");
  let pks = readdirSync(replica).filter((pk) => keys[pk] !== undefined);
  if (only?.length) {
    const wanted = new Set(only);
    pks = pks.filter((pk) => wanted.has(pk));
  }
  return pks.sort().map((pk) => ({ pk, secret: keys[pk] }));
};

export const keypairOf = (secretHex) => Keypair.fromSecret(Uint8Array.from(Buffer.from(secretHex, "hex")));

/** Every file under `dir`, as a path relative to it with `/` separators. */
export const walk = (dir) => {
  const out = [];
  const visit = (sub) => {
    for (const entry of readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const rel = sub ? `${sub}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(rel);
      else out.push(rel);
    }
  };
  if (existsSync(dir)) visit("");
  return out.sort();
};

/** Every path under an owner's directory `prefix` (`/pub/`), deep, 1000 a page. */
export const listAll = async (storage, prefix) => {
  const paths = [];
  let cursor = null;
  let pages = 0;
  for (;;) {
    let urls;
    try {
      urls = await storage.list(prefix, cursor, false, 1000, false);
    } catch (error) {
      // The homeserver answers a LIST of a directory holding nothing with 404
      if (statusOf(error) !== 404) throw error;
      urls = [];
    }
    pages++;
    if (urls.length === 0) return { paths, pages };
    for (const url of urls) paths.push(decodeURIComponent(url.slice(url.indexOf("/", "pubky://".length) + 1)));
    cursor = urls[urls.length - 1];
  }
};

/** Runs `work` over `items` with `width` in flight. */
export const pool = async (items, width, work) => {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await work(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
};

/** A bounded pool of request slots, shared by every caller. */
export const slots = (width) => {
  let inFlight = 0;
  const waiting = [];
  return async (fn) => {
    if (inFlight >= width) await new Promise((resolve) => waiting.push(resolve));
    inFlight++;
    try {
      return await fn();
    } finally {
      inFlight--;
      waiting.shift()?.();
    }
  };
};

export const statusOf = (error) => error?.data?.statusCode;

/** Retries a call on 429, 5xx and transport errors, backing off exponentially. */
export const retrying = async (fn, attempts = 7) => {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (error) {
      const status = statusOf(error);
      const transient = status === undefined || status === 429 || status >= 500;
      if (!transient || i + 1 >= attempts) throw error;
      await sleep(Math.min(250 * 2 ** i, 15_000));
    }
  }
};

const SKIPS = ["malformed", "shape", "unsafe_integer", "tombstone", "empty_title", "unknown_post_kind",
  "unknown_feed_content", "oversize", "invalid", "not_migrated", "deleted_mid_run", "io_error", "put_rejected"];

/** Status, counts and skips over a list of per-user records. */
export const tally = (records) => {
  const status = {};
  const counts = {};
  const skips = {};
  for (const r of records) {
    const key = r.report?.status ?? (r.signal ? `killed:${r.signal}` : `exit:${r.exit}`);
    status[key] = (status[key] ?? 0) + 1;
    for (const [outcome, n] of Object.entries(r.report?.counts ?? {})) {
      counts[outcome] = (counts[outcome] ?? 0) + n;
      if (n > 0 && SKIPS.includes(outcome)) skips[outcome] = (skips[outcome] ?? 0) + n;
    }
  }
  return { status, counts, skips };
};

/**
 * A pass over `reportsDir`: every per-user record of this seed, and the wall time of every
 * session that wrote them, from the sessions its `summary.json` keeps. A pass that resumed
 * spans several sessions, and its wall time is their sum.
 */
export const summarizeReports = (reportsDir, epoch, session) => {
  const summaryPath = path.join(reportsDir, "summary.json");
  const previous = existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, "utf8")) : null;
  const sessions = [...(previous?.seedEpoch === epoch ? (previous.sessions ?? []) : []), ...(session ? [session] : [])];
  const records = readdirSync(reportsDir)
    .filter((f) => f.endsWith(".json") && f !== "summary.json")
    .map((f) => JSON.parse(readFileSync(path.join(reportsDir, f), "utf8")))
    .filter((r) => r.seedEpoch === epoch);
  const times = records.map((r) => r.ms).sort((a, b) => a - b);
  const heaviest = records.reduce((a, b) => (b.ms > (a?.ms ?? -1) ? b : a), null);
  return {
    seedEpoch: epoch,
    users: records.length,
    wallSeconds: Math.round(sessions.reduce((sum, s) => sum + s.wallSeconds, 0) * 10) / 10,
    sessions,
    ...tally(records),
    perUserMs: { p50: percentile(times, 50), p90: percentile(times, 90), max: times.at(-1) ?? 0, sum: times.reduce((a, b) => a + b, 0) },
    retried: records.filter((r) => r.failures?.length).map((r) => ({ pk: r.pk, failures: r.failures })),
    heaviest: heaviest && { pk: heaviest.pk, ms: heaviest.ms, objects: heaviest.report?.total },
  };
};

export const percentile = (sorted, p) => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]);

/** Deletes a user's whole 1.x tree, flag included, so the next run starts from nothing. */
export const resetV1 = async ({ secret }) => {
  const session = await retrying(() => pubky().signer(keypairOf(secret)).signin("pubky-social-replay"));
  try {
    let deleted = 0;
    for (const root of ["/pub/social/v1/", "/priv/social/v1/"]) {
      const { paths } = await retrying(() => listAll(session.storage, root));
      for (const p of paths) {
        await retrying(() => session.storage.delete(`/${p}`));
        deleted++;
      }
    }
    return deleted;
  } finally {
    await session.signout().catch(() => {});
  }
};

/**
 * A deterministic sample of the replica: the user with the most objects, the lightest other
 * one past a LIST page (1000), the owner of the largest blob, and `n` more spread evenly in key
 * order.
 */
export const sampleUsers = (dataDir, n) => {
  const users = replicaUsers(dataDir).map((u) => {
    const tree = path.join(dataDir, "replica", u.pk);
    const blobs = path.join(tree, "pub/pubky.app/blobs");
    const largestBlob = Math.max(0, ...walk(blobs).map((b) => statSync(path.join(blobs, b)).size));
    return { ...u, objects: walk(tree).length, largestBlob };
  });
  const picked = new Map();
  const pick = (u) => u && picked.set(u.pk, u);
  const byObjects = [...users].sort((a, b) => a.objects - b.objects);
  pick(byObjects.at(-1));
  pick(byObjects.find((u) => u.objects > 1000 && !picked.has(u.pk)));
  pick([...users].filter((u) => u.largestBlob > 0).sort((a, b) => b.largestBlob - a.largestBlob)[0]);
  const rest = users.filter((u) => !picked.has(u.pk));
  for (let i = 0; i < Math.min(n, rest.length); i++) pick(rest[Math.floor((i * rest.length) / n)]);
  return [...picked.values()].sort((a, b) => (a.pk < b.pk ? -1 : 1)).map(({ pk, secret }) => ({ pk, secret }));
};

export const atomicWrite = (file, text) => {
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
};

const dumpSlot = slots(8);
const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Writes the user's whole tree, both roots, as the server holds it now, to `file`: a first line
 * naming the seed, then a line per object with its size and blake3, and the text of every 1.x
 * object but media, which is what `replay_verify` reads. Resolves with the object count.
 */
export const dumpTree = async ({ pk, secret }, file, epoch) => {
  const session = await retrying(() => pubky().signer(keypairOf(secret)).signin("pubky-social-replay"));
  try {
    const lines = [];
    for (const root of ["/pub/", "/priv/"]) {
      const { paths } = await retrying(() => listAll(session.storage, root));
      const rows = await Promise.all(
        paths.map((p) =>
          dumpSlot(async () => {
            const bytes = await retrying(() => session.storage.getBytes(`/${p}`));
            const row = { path: p, size: bytes.length, blake3: bytesToHex(blake3(bytes)) };
            if (p.includes("/social/v1/") && !p.startsWith("pub/social/v1/files/")) {
              try {
                row.text = decoder.decode(bytes);
              } catch {
                row.utf8 = false;
              }
            }
            return row;
          }),
        ),
      );
      lines.push(...rows.map((row) => JSON.stringify(row)));
    }
    mkdirSync(path.dirname(file), { recursive: true });
    atomicWrite(file, [JSON.stringify({ seed_epoch: epoch }), ...lines].join("\n") + "\n");
    return lines.length;
  } finally {
    await session.signout().catch(() => {});
  }
};
