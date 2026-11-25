//! Replays `vectors/web_target.json`: the writer fold of a web reference, read by the npm
//! package's tests too. Every `out` is a fixed point of the fold and passes the web gate as
//! written; every `refused` input folds to nothing.

use pubky_social_specs::{
    canonicalize_web_uri, fold_web_target, validate_reference, AllowedSchemes, PUB_CTX,
    VALIDATION_LIMITS,
};
use serde_json::Value;

fn corpus() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/vectors/web_target.json");
    serde_json::from_slice(&std::fs::read(path).expect("vectors")).expect("vectors json")
}

fn text<'a>(row: &'a Value, key: &str) -> &'a str {
    row[key]
        .as_str()
        .unwrap_or_else(|| panic!("{key} in {row}"))
}

#[test]
fn every_fold_vector() {
    let corpus = corpus();
    let rows = corpus["fold"].as_array().unwrap();
    assert!(!rows.is_empty());
    for row in rows {
        let (input, want) = (text(row, "in"), text(row, "out"));
        assert_eq!(fold_web_target(input).as_deref(), Ok(want), "{row}");
        assert_eq!(
            fold_web_target(want).as_deref(),
            Ok(want),
            "idempotent: {row}"
        );
        assert_eq!(
            canonicalize_web_uri(want).as_deref(),
            Ok(want),
            "gate: {row}"
        );
    }
}

#[test]
fn every_refused_vector() {
    let corpus = corpus();
    let rows = corpus["refused"].as_array().unwrap();
    assert!(!rows.is_empty());
    for row in rows {
        assert_eq!(fold_web_target(text(row, "in")), Err(()), "{row}");
    }
}

/// The fold accepts what the gate accepts: whatever the gate stores, the fold maps to a value
/// the gate stores unchanged, and the fold never takes a value the gate refuses but for an
/// uppercase scheme.
#[test]
fn the_fold_and_the_gate_agree_on_what_is_a_web_reference() {
    let corpus = corpus();
    let inputs = corpus["fold"]
        .as_array()
        .unwrap()
        .iter()
        .chain(corpus["refused"].as_array().unwrap())
        .map(|row| text(row, "in").to_string());
    for input in inputs {
        let lowered = match input.find("://") {
            Some(i) => [&input[..i].to_ascii_lowercase(), &input[i..]].concat(),
            None => input.clone(),
        };
        let gate = canonicalize_web_uri(&lowered).is_ok();
        assert_eq!(fold_web_target(&input).is_ok(), gate, "{input:?}");
    }
}

/// The `/` of an empty path is the one code point the fold can add: a target at the reference
/// cap folds to one past it, which the gate keeps and the cap refuses.
#[test]
fn the_fold_can_take_a_target_one_past_the_cap() {
    let max = VALIDATION_LIMITS.reference_uri_max_length;
    let at_cap = format!("https://{}", "a".repeat(max - "https://".len()));
    let folded = fold_web_target(&at_cap).unwrap();
    assert_eq!(folded, format!("{at_cap}/"));
    assert_eq!(folded.chars().count(), max + 1);
    assert_eq!(
        canonicalize_web_uri(&folded).as_deref(),
        Ok(folded.as_str())
    );
    let target =
        |uri: &str| validate_reference(uri, AllowedSchemes::Universal, max, &PUB_CTX, None);
    assert!(target(&at_cap).is_ok());
    assert!(target(&folded).is_err());
}
