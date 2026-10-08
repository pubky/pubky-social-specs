//! The recorded surface answers (`vectors/js/*.jsonl`) are what the crate answers now.
//!
//! The TypeScript package is tested against these files, so a change of behaviour here that
//! leaves them stale would pass on both sides. Regenerate with
//! `cd pkg && node qa/score.mjs --record`.
#![cfg(feature = "surface")]

use pubky_social_specs::surface::{call, Arg, Env};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
struct Request {
    op: String,
    args: Vec<Arg>,
    #[serde(flatten)]
    env: Env,
}

#[derive(Deserialize)]
struct Row {
    q: Request,
    a: Value,
}

#[test]
fn recorded_answers_are_current() {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/vectors/js");
    let mut rows = 0;
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        for (n, line) in std::fs::read_to_string(&path).unwrap().lines().enumerate() {
            let Row { mut q, a } = serde_json::from_str(line).unwrap();
            let answer = match call(&q.op, &q.args, &mut q.env) {
                Ok(ok) => json!({ "ok": ok, "last": q.env.last }),
                Err(err) => json!({ "err": err, "last": q.env.last }),
            };
            assert_eq!(answer, a, "{}:{} ({})", path.display(), n + 1, q.op);
            rows += 1;
        }
    }
    assert!(rows > 0, "no vectors under {dir}");
}

/// A call pins the clock and the mint guard for itself only: the process gets its own back.
#[test]
fn a_call_leaves_the_process_clock_as_it_found_it() {
    let before = pubky_social_specs::mint_timestamp_micros();
    let mut env = Env { now: 1, last: 0 };
    call("frozenTrim", &[Arg::S(" x ".into())], &mut env).unwrap();
    let after = pubky_social_specs::mint_timestamp_micros();
    // The wall clock, past the mint before the call, never the pinned instant
    assert!(after > before && after > 1_700_000_000_000_000, "{after}");
}
