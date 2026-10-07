// The migration against a live homeserver: `npm run e2e`, with a pubky testnet up at
// PUBKY_TESTNET_HOST (localhost by default). Not part of `npm test`.

import assert from "assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pubky, Keypair, PublicKey } from "@synonymdev/pubky";
import { decodeObject } from "../dist/index.js";
import { init } from "../dist/migration/wasm.js";
import { runMigration, MemoryPort } from "../dist/migration/index.js";
import { sdkPort } from "../dist/migration/adapters/pubky-sdk.js";
import { legacyTree } from "../migration.fixture.js";

const HOST = process.env.PUBKY_TESTNET_HOST || "localhost";
// The testnet homeserver's fixed key; it signs anyone up
const HOMESERVER = "8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo";
const CLI = fileURLToPath(new URL("../bin/migrate.js", import.meta.url));
const encoder = new TextEncoder();

describe("migration against a testnet homeserver", function () {
  this.timeout(180_000);

  let keypair;
  let session;
  let owner;
  let port;
  let legacy;
  let memory;
  const url = (p) => `pubky://${owner}/${p}`;
  const flag = () => url("priv/social/v1/_migrated.json");

  // Every object under the prefixes, as the server stores it
  const read = async (...prefixes) => {
    const objects = new Map();
    for (const prefix of prefixes) {
      let cursor;
      do {
        const page = await port.list(url(prefix), cursor);
        for (const u of page.urls) objects.set(u, await port.get(u));
        cursor = page.next;
      } while (cursor);
    }
    return objects;
  };

  before(async () => {
    await init();
    const pubky = Pubky.testnet(HOST);
    keypair = Keypair.random();
    const signer = pubky.signer(keypair);
    await signer.signup(PublicKey.from(HOMESERVER), null);
    session = await signer.signin("pubky-social-specs-e2e");
    owner = session.info.publicKey.z32();
    port = sdkPort(session);

    const tree = legacyTree(owner);
    for (const [p, row] of tree) {
      if ("raw" in row) await session.storage.putBytes(`/${p}`, encoder.encode(row.raw));
      else await session.storage.putJson(`/${p}`, row.body);
    }
    legacy = await read("pub/pubky.app/");
    assert.strictEqual(legacy.size, tree.size);
  });

  it("migrates the tree to the report and the objects a MemoryPort run over the same bytes gives", async () => {
    memory = new MemoryPort();
    for (const [u, bytes] of legacy) memory.store.set(u, bytes);
    const expected = await runMigration({ owner, port: memory });

    // A short page walks the server's LIST cursor too
    const report = await runMigration({ owner, port: sdkPort(session, { pageSize: 7 }), caps: session.info.capabilities });
    assert.strictEqual(report.status, "done", JSON.stringify(report.error));
    assert.ok(report.counts.written > 0);
    for (const key of ["status", "done", "total", "counts", "dropped", "droppedValues", "skipped"]) {
      assert.deepStrictEqual(report[key], expected[key], key);
    }
  });

  it("every write reads back from the server as the MemoryPort run wrote it", async () => {
    const written = await read("pub/social/v1/", "priv/social/v1/");
    assert.ok(written.has(flag()));
    written.delete(flag());
    const want = [...memory.store.keys()].filter((u) => !legacy.has(u) && u !== flag()).sort();
    assert.deepStrictEqual([...written.keys()].sort(), want);
    for (const [u, bytes] of written) {
      assert.deepStrictEqual(decodeObject(u, bytes), decodeObject(u, memory.store.get(u)), u);
    }
  });

  it("a second run is already_migrated", async () => {
    const report = await runMigration({ owner, port });
    assert.strictEqual(report.status, "already_migrated");
    assert.strictEqual(report.done, 0);
  });

  it("leaves the 0.x tree byte for byte as it was", async () => {
    assert.deepStrictEqual(await read("pub/pubky.app/"), legacy);
  });

  it("the CLI signs in from a recovery file and rescans the tree as present", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pubky-social-migrate-"));
    try {
      const recovery = path.join(dir, "account.pkarr");
      writeFileSync(recovery, keypair.createRecoveryFile("e2e passphrase"));
      const run = spawnSync(
        process.execPath,
        [CLI, "--recovery", recovery, "--passphrase-env", "E2E_PASSPHRASE", "--testnet", HOST, "--rescan", "--dry-run", "--json"],
        { env: { ...process.env, E2E_PASSPHRASE: "e2e passphrase" }, encoding: "utf8", timeout: 120_000 },
      );
      assert.strictEqual(run.status, 0, run.stderr);
      const report = JSON.parse(run.stdout);
      assert.strictEqual(report.status, "done");
      assert.strictEqual(report.mode, "dry");
      assert.strictEqual(report.counts.written, 0);
      assert.ok(report.counts.already_present > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
