//! Builds the npm package into `pkg/dist`: the TypeScript sources through tsc, and the
//! migrator's wasm through wasm-pack and `patch.mjs`.

use std::env;
use std::fs;
use std::io;
use std::path::Path;
use std::process::{Command, ExitStatus};

// If the process hangs, try `cargo clean` to remove all locks.

fn main() {
    let root = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR not set");
    let pkg = Path::new(&root).join("pkg");

    // A module renamed or removed since the last build would otherwise ship stale
    match fs::remove_dir_all(pkg.join("dist")) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => panic!("cannot clear pkg/dist: {e}"),
        _ => {}
    }

    // A failed step must fail the build, or a stale glue from an earlier run ships
    check(
        "tsc (is `npm install` done in pkg/?)",
        Command::new("npx")
            .args(["--no", "--", "tsc", "-p", "."])
            .current_dir(&pkg)
            .status(),
    );
    check(
        "wasm-pack",
        Command::new("wasm-pack")
            .args(["build", &root, "--release", "--target", "nodejs"])
            .args(["--out-dir", "pkg/nodejs", "--no-pack"])
            // The wasm is the migrator and nothing else
            .args(["--", "--features", "migrator", "--locked"])
            .status(),
    );
    check(
        "patch.mjs",
        Command::new("node")
            .arg(format!("{root}/src/bin/patch.mjs"))
            .status(),
    );
    println!("pubky-social-specs: built into pkg/dist");
}

fn check(step: &str, status: io::Result<ExitStatus>) {
    match status {
        Ok(status) if status.success() => {}
        Ok(status) => {
            eprintln!("{step} failed: {status}");
            std::process::exit(1);
        }
        Err(e) => {
            eprintln!("{step} did not run: {e}");
            std::process::exit(1);
        }
    }
}
