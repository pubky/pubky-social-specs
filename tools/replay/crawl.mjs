// Copies every user's public `pub/pubky.app/` tree from production, read-only and anonymous:
// LIST and GET, no session. JSON objects are all fetched; blob bytes only for a sample chosen
// from the File objects once the JSON is in.
//
//   node crawl.mjs [--users data/users.json] [--out data] [--only <pk>]...
//                  [--blob-budget-bytes 1000000000] [--no-resume]
//
// Writes <out>/corpus/<pk>/<owner-relative path>, <out>/manifest.json and
// <out>/crawl-report.json. A rerun resumes from the manifest and never fetches again what it
// holds. `--blob-budget-bytes 0` skips the blob sample.

import { Pubky } from "@synonymdev/pubky";
import { blake3 } from "@noble/hashes/blake3.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    users: { type: "string", default: "data/users.json" },
    out: { type: "string", default: "data" },
    only: { type: "string", multiple: true },
    "blob-budget-bytes": { type: "string", default: String(1_000_000_000) },
    resume: { type: "boolean", default: true },
  },
  allowNegative: true,
});

const ROOT = "pub/pubky.app/";
const USERS_IN_PARALLEL = 4;
const REQUESTS_IN_FLIGHT = 8;
const PAGE = 1000;
const MAX_ATTEMPTS = 7;
const BLOB_BUDGET = Number(args["blob-budget-bytes"]);
const HEAVIEST_USER_CAP = 150_000_000;
const MIN_SAMPLED_USERS = 20;
// v0 capped a blob at 100 MB; a stream past this is not a v0 blob
const MAX_BLOB_BYTES = 110_000_000;

const corpusDir = path.join(args.out, "corpus");
const manifestPath = path.join(args.out, "manifest.json");
const stats = { requests: 0, status429: 0, status5xx: 0, retries: 0, fetchedObjects: 0, fetchedBytes: 0 };
const started = Date.now();

const manifest =
  args.resume && existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf8"))
    : { version: 1, users: {} };

let users = JSON.parse(readFileSync(args.users, "utf8"));
if (args.only) {
  const only = new Set(args.only);
  users = users.filter((u) => only.has(u.id));
  for (const pk of only) if (!users.some((u) => u.id === pk)) users.push({ id: pk, hs: null });
}

const saveManifest = () => {
  mkdirSync(args.out, { recursive: true });
  const tmp = `${manifestPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(manifest));
  renameSync(tmp, manifestPath);
};

let inFlight = 0;
const waiting = [];
const slot = async (fn) => {
  if (inFlight >= REQUESTS_IN_FLIGHT) await new Promise((resolve) => waiting.push(resolve));
  inFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
    waiting.shift()?.();
  }
};

const statusOf = (error) => error?.data?.statusCode;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const request = async (fn) => {
  for (let attempt = 1; ; attempt++) {
    try {
      stats.requests++;
      return await slot(fn);
    } catch (error) {
      const status = statusOf(error);
      if (status === 429) stats.status429++;
      if (status >= 500) stats.status5xx++;
      const transient = !error?.final && (status === undefined || status === 429 || status >= 500);
      if (!transient || attempt === MAX_ATTEMPTS) throw error;
      stats.retries++;
      await sleep(Math.min(60_000, 1000 * 2 ** (attempt - 1)) * (0.5 + Math.random()));
    }
  }
};

const pubky = new Pubky();
const storage = pubky.publicStorage;
const address = (pk, rel) => `pubky${pk}/${rel}`;

// A listed path could otherwise escape the user's directory
const relativeOf = (pk, url) => {
  const prefix = `pubky://${pk}/`;
  if (!url.startsWith(prefix)) throw new Error(`listed a foreign URL ${url}`);
  const rel = url.slice(prefix.length);
  const segments = rel.split("/");
  if (segments.some((s) => s === "" || s === "." || s === ".." || s.includes("\\"))) {
    throw new Error(`unsafe path ${rel}`);
  }
  return rel;
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const crockford = (bytes) => {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out;
};

const blobIdOf = (hasher) => crockford(hasher.digest().slice(0, 16));

// The remap hard-links unchanged files into the replica, so a file is replaced, never
// truncated in place
const writeFile = (pk, rel, bytes) => {
  const file = path.join(corpusDir, pk, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, file);
};

const listAll = async (pk) => {
  const urls = [];
  let cursor = null;
  for (;;) {
    let page;
    try {
      page = await request(() => storage.list(address(pk, ROOT), cursor, false, PAGE, false));
    } catch (error) {
      if (statusOf(error) === 404) return urls;
      throw error;
    }
    // A server may cap a page below the size asked, so only an empty page ends the walk
    if (page.length === 0) return urls;
    urls.push(...page);
    cursor = page[page.length - 1];
  }
};

const errorText = (error) => `${error?.name ?? "Error"}: ${error?.message ?? error}`;

const crawlUser = async ({ id: pk, hs }) => {
  const entry = (manifest.users[pk] ??= { hs, complete: false, objects: {}, blobs: {}, files: {}, errors: [] });
  if (entry.complete) return;
  entry.hs = hs;
  entry.errors = [];
  let urls;
  try {
    urls = await listAll(pk);
  } catch (error) {
    entry.errors.push({ path: ROOT, error: errorText(error) });
    return;
  }
  const listed = new Set();
  await Promise.all(
    urls.map(async (url) => {
      let rel;
      try {
        rel = relativeOf(pk, url);
      } catch (error) {
        entry.errors.push({ path: url, error: errorText(error) });
        return;
      }
      listed.add(rel);
      if (rel.startsWith(`${ROOT}blobs/`)) {
        entry.blobs[rel.slice(`${ROOT}blobs/`.length)] ??= { fetched: false };
        return;
      }
      if (entry.objects[rel] && existsSync(path.join(corpusDir, pk, rel))) return;
      try {
        const bytes = await request(() => storage.getBytes(address(pk, rel)));
        writeFile(pk, rel, bytes);
        const object = { size: bytes.length, sha256: sha256(bytes) };
        try {
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        } catch {
          object.json = false;
        }
        entry.objects[rel] = object;
        stats.fetchedObjects++;
        stats.fetchedBytes += bytes.length;
      } catch (error) {
        entry.errors.push({ path: rel, status: statusOf(error), error: errorText(error) });
      }
    }),
  );
  // What the server no longer lists is not part of the copy
  for (const rel of Object.keys(entry.objects)) {
    if (listed.has(rel)) continue;
    delete entry.objects[rel];
    rmSync(path.join(corpusDir, pk, rel), { force: true });
  }
  entry.files = filesOf(pk, entry);
  entry.complete = entry.errors.length === 0;
  saveManifest();
};

const filesOf = (pk, entry) => {
  const files = {};
  const own = `pubky://${pk}/${ROOT}blobs/`;
  for (const rel of Object.keys(entry.objects)) {
    if (!rel.startsWith(`${ROOT}files/`)) continue;
    const tsid = rel.slice(`${ROOT}files/`.length);
    let file;
    try {
      file = JSON.parse(readFileSync(path.join(corpusDir, pk, rel), "utf8"));
    } catch {
      files[tsid] = { unreadable: true };
      continue;
    }
    const src = typeof file.src === "string" ? file.src.trim() : null;
    files[tsid] = {
      size: file.size ?? null,
      content_type: file.content_type ?? null,
      src,
      blob: src?.startsWith(own) ? src.slice(own.length) : null,
    };
  }
  for (const file of Object.values(files)) {
    const blob = file.blob && entry.blobs[file.blob];
    if (!blob) continue;
    // The blob's size and type as its Files declare them; the first File wins a disagreement
    blob.declared_size ??= file.size;
    blob.content_type ??= file.content_type;
  }
  return files;
};

const pool = async (items, n, fn) => {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (queue.length) await fn(queue.shift());
    }),
  );
};

const sampleBlobs = () => {
  const pks = new Set(users.map((u) => u.id));
  const candidates = [];
  for (const [pk, entry] of Object.entries(manifest.users)) {
    if (!pks.has(pk)) continue;
    for (const [hash, blob] of Object.entries(entry.blobs)) {
      if (Number.isSafeInteger(blob.declared_size) && blob.declared_size > 0) {
        candidates.push({ pk, hash, size: blob.declared_size, type: blob.content_type, blob });
      }
    }
  }
  if (candidates.length === 0) return [];
  // The manifest's order follows which user finished first, so the sample would too
  candidates.sort((a, b) => (a.pk === b.pk ? (a.hash < b.hash ? -1 : 1) : a.pk < b.pk ? -1 : 1));
  const bytesOf = new Map();
  for (const c of candidates) bytesOf.set(c.pk, (bytesOf.get(c.pk) ?? 0) + c.size);
  const heaviest = [...bytesOf].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];

  const chosen = new Map();
  let total = 0;
  let heaviestTotal = 0;
  const take = (c) => {
    if (!c || chosen.has(`${c.pk}/${c.hash}`)) return;
    if (total + c.size > BLOB_BUDGET) return;
    if (c.pk === heaviest && heaviestTotal + c.size > HEAVIEST_USER_CAP) return;
    chosen.set(`${c.pk}/${c.hash}`, c);
    total += c.size;
    if (c.pk === heaviest) heaviestTotal += c.size;
  };
  const bySize = (list) =>
    [...list].sort((a, b) => a.size - b.size || (a.hash === b.hash ? (a.pk < b.pk ? -1 : 1) : a.hash < b.hash ? -1 : 1));
  const spread = (list) => {
    const sorted = bySize(list);
    return [sorted[0], sorted[Math.floor(sorted.length / 2)], sorted[sorted.length - 1]];
  };

  take(bySize(candidates).at(-1));
  const types = new Map();
  for (const c of candidates) types.set(c.type, [...(types.get(c.type) ?? []), c]);
  for (const list of types.values()) spread(list).forEach(take);
  spread(candidates.filter((c) => c.pk === heaviest)).forEach(take);
  // Then one mid-sized blob per user, in an order that does not follow the key space
  const others = [...new Set(candidates.map((c) => c.pk))].sort((a, b) =>
    sha256(a) < sha256(b) ? -1 : 1,
  );
  const sampledUsers = () => new Set([...chosen.values()].map((c) => c.pk)).size;
  for (const pk of others) {
    if (sampledUsers() >= MIN_SAMPLED_USERS) break;
    const list = bySize(candidates.filter((c) => c.pk === pk));
    take(list[Math.floor(list.length / 2)]);
  }
  return { chosen: [...chosen.values()], heaviest, total };
};

const partOf = ({ pk, hash }) => path.join(args.out, "tmp", `${pk}-${hash}.part`);

const fetchBlob = async (c) => {
  const { pk, hash, blob } = c;
  const rel = `${ROOT}blobs/${hash}`;
  const file = path.join(corpusDir, pk, rel);
  if (blob.fetched && existsSync(file)) return;
  mkdirSync(path.dirname(file), { recursive: true });
  // Kept outside the corpus, so a killed run never leaves a partial blob in it
  const tmp = partOf(c);
  mkdirSync(path.dirname(tmp), { recursive: true });
  await request(async () => {
    const response = await storage.get(address(pk, rel));
    const hasher = blake3.create();
    const sha = createHash("sha256");
    const handle = await open(tmp, "w");
    let bytes = 0;
    try {
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > MAX_BLOB_BYTES) throw Object.assign(new Error(`blob exceeds ${MAX_BLOB_BYTES} bytes`), { final: true });
        hasher.update(chunk);
        sha.update(chunk);
        await handle.write(chunk);
      }
    } finally {
      await handle.close();
    }
    renameSync(tmp, file);
    const id = blobIdOf(hasher);
    Object.assign(blob, {
      fetched: true,
      size: bytes,
      sha256: sha.digest("hex"),
      status: id === hash ? "ok" : "hash_mismatch",
      ...(id === hash ? {} : { blake3_id: id }),
    });
    stats.fetchedBytes += bytes;
  });
};

await pool(users, USERS_IN_PARALLEL, crawlUser);
saveManifest();

let sample = null;
const blobErrors = [];
if (BLOB_BUDGET > 0) {
  sample = sampleBlobs();
  let done = 0;
  await pool(sample.chosen ?? [], 2, async (c) => {
    try {
      await fetchBlob(c);
    } catch (error) {
      rmSync(partOf(c), { force: true });
      c.blob.error = errorText(error);
      blobErrors.push({ pk: c.pk, hash: c.hash, error: c.blob.error });
    }
    if (++done % 10 === 0) saveManifest();
  });
  saveManifest();
}

const summary = { users: 0, complete: 0, objects: 0, bytes: 0, notJson: 0, files: 0, blobsListed: 0 };
const blobs = { fetched: 0, fetchedBytes: 0, hashMismatch: 0, declaredBytes: 0, noFile: 0 };
const errors = [];
// A user whose root could not be listed has no copy at all; one listed but cut short has part
const coverage = { users: users.length, withData: 0, empty: 0, unreachable: 0, partial: 0 };
for (const u of users) {
  const entry = manifest.users[u.id];
  const held = entry ? Object.keys(entry.objects).length + Object.keys(entry.blobs).length : 0;
  if (!entry || (!entry.complete && held === 0)) coverage.unreachable++;
  else if (!entry.complete) coverage.partial++;
  else if (held === 0) coverage.empty++;
  if (held > 0) coverage.withData++;
  if (!entry) continue;
  summary.users++;
  if (entry.complete) summary.complete++;
  for (const o of Object.values(entry.objects)) {
    summary.objects++;
    summary.bytes += o.size;
    if (o.json === false) summary.notJson++;
  }
  summary.files += Object.keys(entry.files).length;
  for (const b of Object.values(entry.blobs)) {
    summary.blobsListed++;
    if (b.declared_size === undefined) blobs.noFile++;
    else blobs.declaredBytes += b.declared_size ?? 0;
    if (b.fetched) {
      blobs.fetched++;
      blobs.fetchedBytes += b.size;
      if (b.status === "hash_mismatch") blobs.hashMismatch++;
    }
  }
  for (const e of entry.errors) errors.push({ pk: u.id, ...e });
}
const report = {
  coverage,
  ...summary,
  blobs,
  sample: sample && { chosen: sample.chosen?.length ?? 0, bytes: sample.total ?? 0, heaviest: sample.heaviest },
  thisRun: { ...stats, seconds: Math.round((Date.now() - started) / 1000) },
  errors: errors.length + blobErrors.length,
  firstErrors: [...errors, ...blobErrors].slice(0, 20).map((e) => ({ ...e, error: e.error?.slice(0, 300) })),
};
writeFileSync(path.join(args.out, "crawl-report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
