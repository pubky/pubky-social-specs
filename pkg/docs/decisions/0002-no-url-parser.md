# 2. No `URL` in the core

Status: accepted.

## Context

References (`parent`, `embed`, attachments, a tag's target) are stored as strings, and the
crate defines when one is canonical: `pubky://<key>/<segments>` with every segment canonical,
`http(s)://` trimmed and free of whitespace, any other scheme folded and opaque. A reference is
valid only when it is already spelled canonically, so the same object has one spelling and one
id.

The WHATWG `URL` parser repairs instead of refusing. It strips userinfo, collapses `..` and
`.`, percent-encodes what it dislikes, lowercases hosts, drops default ports and ignores what
it cannot place; and its output differs between engines and engine versions. Accepting what
`URL` accepts would accept junk the crate refuses, and canonicalizing through it would make an
id depend on the JavaScript engine.

## Decision

`src/canonicalize.ts` and `src/path.ts` implement the crate's rules on the raw string: split on
`/`, check each segment, refuse rather than repair. The one place that must read a URL the way
a URL parser does, the `src` of a 0.x File object (the 0.x reader used one), does it by hand in
`legacyMediaKey` for the one scheme it can carry, and the vectors pin it.

## Consequences

A caller who wants a display URL builds it with `URL` from a reference the package accepted.
The canonicalizers' behaviour is the crate's and is checked by the `canonical` and `uri`
vector families on every engine the CI matrix runs.
