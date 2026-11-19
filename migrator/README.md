# pubky-social-migrator

[![npm version](https://img.shields.io/npm/v/pubky-social-migrator)](https://www.npmjs.com/package/pubky-social-migrator)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Migrates a Pubky user's 0.x social data, written by `pubky-app-specs` under `/pub/pubky.app/`, to the 1.x data model of [`pubky-social-specs`](https://www.npmjs.com/package/pubky-social-specs), under `/pub/social/v1/` and `/priv/social/v1/`.

The migration copies: it never modifies or deletes the 0.x tree. A run can be interrupted and resumed, and running it again is safe, since an object already in 1.x is never written twice.

## Installation

```bash
npm install pubky-social-migrator
```

It is released with `pubky-social-specs` at the same version and depends on exactly that version. It is a separate package so that an app that never migrates loads no wasm: the transforms are the reference Rust crate compiled to wasm, loaded on the first `runMigration`.

## Usage

The engine makes every request through a **port**, an object with the storage calls it needs, so it runs in pubky-app, in a web tool or under Node. `pubky-social-migrator/pubky-sdk` is the port over a pubky SDK session.

```js
import { runMigration } from "pubky-social-migrator";
import { sdkPort } from "pubky-social-migrator/pubky-sdk";
import { memoryHomeserver } from "pubky-social-specs/testing";
const { owner, session } = memoryHomeserver(); // your SDK session

const controller = new AbortController();
const report = await runMigration({
  owner,
  port: sdkPort(session), // or your own adapter over the homeserver client, below
  caps: session.info.capabilities, // optional, a string or a list of scopes
  // optional: one run per owner across a browser's tabs
  lock: globalThis.navigator?.locks ? (name, fn) => navigator.locks.request(name, { ifAvailable: true }, fn) : undefined,
  onProgress: (event) => console.log(event.phase, event.done, event.total),
  signal: controller.signal,
});
console.log(report.status); // done: an empty 0.x tree migrates at once
```

`runMigration` resolves with a report in every case. It rejects only on a programming error, such as an owner that is not a pubky key or a port that answers a GET with something other than bytes.

## What a run does

1. With `caps` given, checks that the session covers `ENGINE_CAPS` (exported by `pubky-social-specs`), and aborts with `CAPS_MISSING` otherwise. It never prompts.
2. Checks that the homeserver has `/priv/`, and aborts with `PRIV_UNSUPPORTED` if not.
3. Reads the flag `priv/social/v1/_migrated.json`, and returns `already_migrated` when it records the current `transformRev` or a later one (unless `rescan: true`).
4. Lists the 1.x tree, so whatever is already there, including edits made since an earlier run, is never written again.
5. Walks the 0.x tree and copies each object through the transforms, with create-only writes.
6. Writes the flag. A run that hit I/O errors writes none and ends `incomplete`, so the next run walks again.

`mode: "dry"` reads and counts exactly as a run does, and writes nothing.

**A rescan does not repair.** `rescan: true`, `--rescan` on the CLI, walks the 0.x tree of a finished migration again and copies what an earlier run skipped. It never rewrites a 1.x object that already exists, so an object an older release migrated differently keeps the bytes that release wrote, and an object the owner deleted since is not brought back.

## The report

- `status`: `done`, `already_migrated`, `incomplete` (run again), `paused` or `aborted`.
- `counts`: one number per outcome, `written`, `already_present` and every reason in `skipReasons`.
- `skipped`: the 0.x paths of each outcome that did not land. Show them to the user: a skipped blob leaves references to it dangling.
- `dropped` and `droppedValues`: values the 1.x rules refused inside an object that still migrated, such as a profile image.
- `error`: `{ code, message }`. `QUOTA` pauses the run, with `needBytes` to free; `CAPS_MISSING` carries the scopes to ask for in `caps`.

`onProgress` gets the phase and the counts after every object.

## Running it from Node

`pubky-social-migrator/pubky-sdk` works with [`@synonymdev/pubky`](https://www.npmjs.com/package/@synonymdev/pubky) `>=0.11 <1`. Install the SDK next to this package to use the adapter or the CLI; the package does not depend on it, so the engine never loads it.

<!-- no-run: needs a homeserver and a recovery file -->
```js
import { readFile } from "node:fs/promises";
import { Pubky, Keypair } from "@synonymdev/pubky";
import { runMigration } from "pubky-social-migrator";
import { sdkPort } from "pubky-social-migrator/pubky-sdk";

const passphrase = "the passphrase of the recovery file";
const keypair = Keypair.fromRecoveryFile(await readFile("alice.pkarr"), passphrase);
const session = await new Pubky().signer(keypair).signin("my-app");
const report = await runMigration({
  owner: session.info.publicKey.z32(),
  port: sdkPort(session),
  caps: session.info.capabilities,
});
```

Or from a terminal, with a recovery file:

```bash
chmod 600 ./account.pkarr
npx -p pubky-social-migrator -p @synonymdev/pubky@^0.14 pubky-social-migrate --recovery ./account.pkarr
```

The CLI asks for the passphrase with echo off and signs out when the run ends. `--dry-run` writes nothing, `--rescan` walks a finished tree again, `--json` prints the report as JSON, and `--testnet` points it at a local testnet. It exits 0 when done, 2 when it should run again, 3 when it aborted and 1 on a usage error.

## Your own port

```ts
interface MigrationPort {
  list(prefixUrl: string, cursor?: string): Promise<{ urls: string[]; next?: string }>;
  get(url: string, options?: { maxBytes?: number }): Promise<Uint8Array | null>;
  head(url: string): Promise<boolean>;
  putJson(url: string, object: unknown, options?: { ifAbsent?: boolean }): Promise<void>;
  putBytes(url: string, bytes: Uint8Array, options?: { ifAbsent?: boolean }): Promise<void>;
  delete(url: string): Promise<void>;
}
```

Every URL is a full `pubky://` URL, and every failure is a thrown `MigrationPortError` whose `kind` tells the engine whether to retry, pause or abort. `refusal(status)` maps an HTTP status to it, and `MemoryPort` is a port over a `Map`, for tests. The contract in full is under [The port](docs/engine.md#the-port).

## Documentation

- [`docs/engine.md`](docs/engine.md): what a run does to each object, what it never does, the report, the port contract, the SDK adapter, the CLI and the live test.
- [`ARCHITECTURE.md`](https://github.com/pubky/pubky-social-specs/blob/v1/migrator/ARCHITECTURE.md): the design.
- [`SECURITY.md`](SECURITY.md) and [`CHANGELOG.md`](CHANGELOG.md).
- [`SPEC.md`](https://github.com/pubky/pubky-social-specs/blob/v1/SPEC.md): the 1.x data model it writes, and how each 0.x path maps to it.

## License

MIT
