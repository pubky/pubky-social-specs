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
Under the `workerd` condition the bundler compiles the shipped `dist/migration/glue.wasm` at deploy
time, so the module arrives compiled and the digest check, which needs bytes, is the bundler's.

Each release runs the differential fuzz against the reference (`npm run score -- --fuzz N`, 0
mismatches) and the hostile-input benchmark (`npm run hostile`, every shape linear and under its
ceiling). The release notes state both.

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
  rule reads it, and an array in it is refused past 10,000 items before it is walked. Bytes in
  shared memory are copied first, so another thread cannot change them between two reads. A
  value of the wrong JS type is an `ArgumentError` (a `TypeError`) and a value the model refuses
  a `ValidationError`, never a crash, a hang or another error type (the boundary harness checks
  every export). A 0.x object is read with a byte cap before the wasm sees it; a LIST is capped
  at about a million objects and the flag at 64 MiB.
- **Linear time on stored bytes.** Decoding takes time linear in the input whatever its shape,
  under 1 µs a byte, so the largest object, 512 KB, decodes within half a second.
  `qa/hostile.mjs` times each adversarial shape (nesting at the depth limit, many keys, long
  digit runs, escapes, error messages that quote the input) from 64 to 512 KB and fails on a
  shape that grows faster or crosses the ceiling. An error quoting a long string costs a few
  steps per character.
- **No prototype reaches a rule or a byte.** No lookup table the package owns resolves a key
  through a prototype, and a parsed object holds its members in a `Map`. A test pollutes
  `Object.prototype` with every one-character and numeric key and checks that no byte written
  and no value read changes.
- **Round trips hold.** An object read and written back gives the bytes the reference writes,
  and reading those gives the same object again. A name this version does not know (a newer
  post kind in a feed filter, a newer collection layout) is written back with its spelling, and
  a number in an unknown member reads back to itself over any number of rewrites.
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
- **A deleted bookmark or feed of a migrated account** can come back from its 0.x copy, which
  `deletionPaths` does not reach, if no finished migration recorded it. Their 0.x ids hash a
  target the migration respells, so the 1.x id cannot name the 0.x path. A mute deletes its 0.x
  copy, since its id is the same key in both trees.
- **A compromised SDK, homeserver operator or build machine.** The package trusts the session it
  is handed and the toolchain CI pins.
- **Denial of service by the owner's own homeserver**, beyond the caps above and the retries'
  backoff.

### Trade-offs, as designed

- **Clock-derived ids.** A clock set back more than one second, or `setClock` in a test, resets
  the mint guard, so an id can repeat. Decoding a post reads the clock for its upper time bound:
  a version more than two hours ahead is refused until the reader's clock catches up.
- **Exact text.** Web URLs are not normalized, NFC and NFD spellings of a label are two tags, and
  lowercasing is ASCII only, since ids hash the exact text.
- **Media types map to extensions** the host serves; `.html`, `.svg` and `.js` among them. What a
  host serves with which header is its policy.
- **Hashing is plain JS**, roughly 10 to 20 MB/s; a 100 MB file blocks for seconds. `hashMedia`
  reads a `Blob` or a stream in chunks.
- **Display text may hold invisible and bidirectional characters**, and a path segment odd but
  inert ones, as long as they only ever parse as `unknown` or `foreign`.
- **Two equal keys in stored JSON**: the last one wins, as in the reference.
- **An error message quotes the input it refuses in full**, as the reference's does; `field`,
  `code` and `limit` carry what a program needs without it.
- **An error a caller's own getter or Proxy throws** while its argument is copied propagates as
  it is.

### Changes that need a security review

Path assembly (`src/path.ts`, `src/uri.ts`, `src/legacy.ts`), the input funnel (`src/input.ts`,
`src/bytes.ts`), the JSON reader (`src/json/read.ts`), the engine's write
fence and cleanup (`src/migration/engine.ts`), the SDK adapter, the CLI, and the wasm loader.
