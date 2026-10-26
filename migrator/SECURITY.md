# Security

## Reporting a vulnerability

Report it privately through GitHub: the **Report a vulnerability** button on the Security tab of
[pubky/pubky-social-specs](https://github.com/pubky/pubky-social-specs/security). Do not open a
public issue for it. Say which version, which entry (`.`, `/pubky-sdk`, the CLI) and how to
reproduce it.

## Supported versions

The release that matches the latest `pubky-social-specs` gets fixes; the two are released together
at one version.

## Verifying a release

Releases are published from GitHub Actions with npm provenance, `dist` is built only in CI from a
pinned toolchain, and a workflow rebuilds it from the tag and compares it with the published
tarball. `npm audit signatures` checks the provenance of an installed copy. The wasm is embedded
in `dist/glue.js` with its SHA-256, which the loader (`src/wasm.ts`) checks before compiling it.
Under the `workerd` condition the bundler compiles the shipped `dist/glue.wasm` at deploy time, so
the module arrives compiled and the digest check, which needs bytes, is the bundler's.

## Threat model

The data model's guarantees (canonical ids, owner-confined paths, bounded hostile input, linear
decoding) are `pubky-social-specs`'s, in its `SECURITY.md`. This is what the migration adds.

### Trust boundaries

| boundary | trusted? | what crosses it |
|---|---|---|
| the migration port | untrusted | every answer, a lying or hostile one included |
| the owner's homeserver | trusted for availability, not for content | LIST pages, GET bodies, status codes |
| the pubky SDK and the session | trusted | the signed-in session, its capabilities |
| the published tarball | verified (provenance, reproducible build, wasm digest) | the code itself |

### What it guarantees

- **Owner-confined writes.** The engine derives each write URL from the write's kind and id with
  the core's `buildUri` and refuses a transform that names another; the engine and the SDK adapter
  share one check of every URL they touch, the core's `toPath` and the session's owner.
- **The 0.x tree is never written**: no PUT and no DELETE under `/pub/pubky.app/`.
- **Bounded input.** A 0.x object is read with a byte cap before the wasm sees it; a LIST is
  capped at about a million objects and the flag at 64 MiB. A byte view handed to the wasm is
  read through the intrinsic getters, so a subclass that lies about its length cannot make the
  glue copy past its memory.
- **A cleanup deletes only a copy it read back as its own**: before deleting a copy whose source
  vanished, the engine reads it back and deletes it only when the bytes are the ones it wrote.
  The read and the DELETE are two requests (see the conditional writes below).
- **The CLI's secrets**: the passphrase is asked on the terminal with echo off or read once from
  an environment variable that is then removed; never from the arguments. A recovery file
  readable by others is refused; the file's bytes and a typed passphrase are zeroed after use;
  the session signs out at the end, on signals and on uncaught errors.

### What it does not defend

- **Conditional writes.** The homeserver honours neither `If-None-Match` on PUT nor `If-Match` on
  DELETE. So `ifAbsent` is a HEAD then a PUT, and a write landing between the two is overwritten.
  And the cleanup of a copy whose 0.x source the owner deleted mid-run is a read-back then a
  DELETE: a different write to that path landing between the two is deleted with it. An identical
  one is the same deleted source copied by another run, which should go too. Leaving the copy
  instead would bring back, as a 1.x object, something the owner deleted.
- **A lost sign-out.** A process killed during the CLI's wait leaves its root grant active until
  it expires or is revoked from Ring; the SDK has no scoped, short-lived grant for this yet.
- **A compromised SDK, homeserver operator or build machine.**

### Changes that need a security review

The engine's write fence and cleanup (`src/engine.ts`), the shared URL check (`src/path.ts`), the
byte views (`src/bytes.ts`), the SDK adapter, the CLI, and the wasm loader.
