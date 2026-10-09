# 1. The package reads JSON with its own reader

Status: accepted.

## Context

Stored objects are JSON, and the crate reads them with serde_json. A reader decides more than
the value: which texts are refused, with what message, at which point of the text, and what a
number is. The package has to refuse exactly what the crate refuses, with the crate's words,
and write back the bytes a Rust client writes.

`JSON.parse` cannot do that. It reads every number as a double, so `9007199254740993` and
`1.0` come back changed; it keeps the last of two equal keys without a trace, where serde
refuses a duplicate field; it accepts what serde refuses (a lone surrogate escape, nesting past
128) and words its errors per engine. A reviver sees values after the damage is done.

## Decision

`src/json/read.ts` reads the bytes itself: integers as bigints, a double rounded as serde
rounds it (and correctly rounded for text the package wrote and must read back unchanged), a
duplicate key refused in the codec that knows the field, nesting capped at 128, and every
refusal worded as serde words it. `src/json/write.ts` spells numbers and escapes as serde does.
The recorded vectors of the `json` family and the round trip inside the `decode` operation hold
both to the crate.

## Consequences

About 450 lines that must track serde_json's behaviour; a serde upgrade that changes a message
shows up as a vector failure in the crate's own test first. `$unknown` is text for the same
reason: a caller's JSON value would lose the spelling the crate keeps.
