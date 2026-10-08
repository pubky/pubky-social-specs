# Security

## Reporting a vulnerability

Report it privately through GitHub: the **Report a vulnerability** button on the Security tab of
[pubky/pubky-social-specs](https://github.com/pubky/pubky-social-specs/security). Do not open a
public issue for it. Say which version, which entry (`.`, `/migration`, `/migration/pubky-sdk`,
`/client`, the CLI) and how to reproduce it.

## Supported versions

The latest release of the current major line gets fixes. Before 1.0.0, that is the latest
`1.0.0-beta` release; older betas are not patched.

## Verifying a release

Releases are published from GitHub Actions with npm provenance, `dist` is built only in CI from a
pinned toolchain, and a workflow rebuilds it from the tag and compares it with the published
tarball. `npm audit signatures` checks the provenance of an installed copy. The migration wasm is
embedded in `dist/migration/glue.js` with its SHA-256, which `init()` checks before compiling it.

## Threat model

What the package defends, against whom, and what it leaves to others.

### Trust boundaries

| boundary | trusted? | what crosses it |
|---|---|---|
| the caller's code | trusted to mean well, not to be careful | arguments of any JS shape |
| other users' data | untrusted | bytes from their homeserver, read with `decodeObject` |
| the owner's homeserver | trusted for availability, not for content | LIST pages, GET bodies, status codes |
| the migration port | untrusted | every answer, a lying or hostile one included |
| the pubky SDK and the session | trusted | the signed-in session, its capabilities |
| the published tarball | verified (provenance, reproducible build, wasm digest) | the code itself |

### What it guarantees

- **Canonical ids.** An id is derived from content or the clock exactly as the reference
  derives it; an alias spelling of an id is refused, so one object has one path.
- **Owner-confined paths.** Every path a builder, a plan or the migration writes is under
  `/pub/` or `/priv/` of the owner named, with every segment canonical. `buildUri` spells only
  what `parseUri` reads back. The engine derives each write URL from the write's kind and id and
  refuses a transform that names another; the engine and the SDK adapter share one check of
  every URL they touch.
- **The 0.x tree is never written** by the migration: no PUT and no DELETE under
  `/pub/pubky.app/`.
- **Hostile input is bounded.** A caller's argument is copied once, own data only, before any
  rule reads it; a value of the wrong shape is a `TypeError`, never a crash or a hang (the
  boundary harness checks every export). A 0.x object is read with a byte cap before the wasm
  sees it; a LIST is capped at about a million objects and the flag at 64 MiB.
- **A cleanup deletes only its own copy**: before deleting a copy whose source vanished, the
  engine reads it back and deletes it only when the bytes are the ones it wrote.
- **The CLI's secrets**: the passphrase is asked on the terminal with echo off or read once from
  an environment variable that is then removed; never from the arguments. A recovery file
  readable by others is refused; the file's bytes and a typed passphrase are zeroed after use;
  the session signs out at the end, on signals and on uncaught errors.

### What it does not defend

- **Create-only writes.** The homeserver does not honour `If-None-Match` on PUT, so `ifAbsent` is
  a HEAD then a PUT and a write landing between the two is overwritten. Two copies of the package
  minting in the same microsecond can mint the same id; the client re-mints on a taken path,
  within the same window.
- **References that render dangerously.** A reference may use any URI scheme the reference model
  accepts, `javascript:` and `data:` included. A renderer allow-lists schemes before making a
  link.
- **Look-alike text.** Labels and names are trimmed and ASCII-lowercased only; Unicode
  normalization and bidirectional controls are the renderer's concern.
- **A lost sign-out.** A process killed during the CLI's wait leaves its root grant active until
  it expires or is revoked from Ring; the SDK has no scoped, short-lived grant for this yet.
- **A deleted mute, bookmark or feed of a migrated account** can come back from its 0.x copy,
  which `deletionPaths` does not reach, if no finished migration recorded it.
- **A compromised SDK, homeserver operator or build machine.** The package trusts the session it
  is handed and the toolchain CI pins.
- **Denial of service by the owner's own homeserver**, beyond the caps above and the retries'
  backoff.

### Changes that need a security review

Path assembly (`src/path.ts`, `src/uri.ts`), the input funnel (`src/input.ts`), the engine's write
fence and cleanup (`src/migration/engine.ts`), the SDK adapter, the CLI, and the wasm loader.
