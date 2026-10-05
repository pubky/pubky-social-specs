//! Native timing of the transforms over the inputs `pkg/qa/bench.mjs --dump` writes, so the
//! cost of the wasm boundary reads as the difference from the JS numbers. Does nothing unless
//! `QA_BENCH_INPUT` names that file:
//! `QA_BENCH_INPUT=inputs.json cargo test --release --features migrator --test qa_transform_bench -- --nocapture`
#![cfg(feature = "migrator")]

use base64::Engine;
use pubky_social_specs::migrate::MigrationCtx;
use pubky_social_specs::PubkyId;
use serde_json::{json, Value};
use std::time::Instant;

fn decode(value: &Value) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD
        .decode(value.as_str().unwrap())
        .unwrap()
}

#[test]
fn transform_throughput_per_kind() {
    let Ok(file) = std::env::var("QA_BENCH_INPUT") else {
        return;
    };
    let input: Value = serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap();
    let owner = PubkyId::try_from(input["owner"].as_str().unwrap()).unwrap();
    let mut results = serde_json::Map::new();
    for (kind, cases) in input["kinds"].as_object().unwrap() {
        let cases: Vec<(String, Vec<u8>)> = cases
            .as_array()
            .unwrap()
            .iter()
            .map(|c| (c[0].as_str().unwrap().to_string(), decode(&c[1])))
            .collect();
        let mut ctx = MigrationCtx::new(owner.clone());
        let file = &input["file"];
        ctx.migrate(file[0].as_str().unwrap(), &decode(&file[1]))
            .expect("the File reads");
        for (path, bytes) in cases.iter().take(100) {
            let _ = ctx.migrate(path, bytes);
        }
        let rounds = 5;
        let mut skipped = 0;
        let started = Instant::now();
        for _ in 0..rounds {
            for (path, bytes) in &cases {
                if ctx.migrate(path, bytes).is_err() {
                    skipped += 1;
                }
            }
        }
        let us = started.elapsed().as_secs_f64() * 1e6 / (rounds * cases.len()) as f64;
        results.insert(
            kind.clone(),
            json!({"usPer": (us * 10.0).round() / 10.0, "perSec": (1e6 / us).round(), "skipped": skipped / rounds}),
        );
    }
    let out = json!(results);
    if let Ok(path) = std::env::var("QA_BENCH_OUT") {
        std::fs::write(path, serde_json::to_vec_pretty(&out).unwrap()).unwrap();
    }
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
}
