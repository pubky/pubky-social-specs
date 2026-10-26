//! Builds both npm packages: `pkg/dist` (pubky-social-specs) through tsc, and `migrator/dist`
//! (pubky-social-migrator) through tsc, then its wasm through wasm-pack and `patch.mjs`.

use std::env;
use std::fs;
use std::io;
use std::path::Path;
use std::process::{Command, ExitStatus};

fn main() {
    let root = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR not set");

    for package in ["pkg", "migrator"] {
        // A module renamed or removed since the last build would otherwise ship stale
        let dist = Path::new(&root).join(package).join("dist");
        match fs::remove_dir_all(&dist) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => {
                panic!("cannot clear {package}/dist: {e}")
            }
            _ => {}
        }
    }

    // A failed step must fail the build, or a stale glue from an earlier run ships. The
    // migrator compiles against the core's declarations, so the core goes first
    for package in ["pkg", "migrator"] {
        check(
            &format!("tsc in {package}/ (is `npm install` done at the repository root?)"),
            Command::new("npx")
                .args(["--no", "--", "tsc", "-p", "."])
                .current_dir(Path::new(&root).join(package))
                .status(),
        );
    }
    check(
        "wasm-pack",
        Command::new("wasm-pack")
            .args(["build", &root, "--release", "--target", "nodejs"])
            .args(["--out-dir", "migrator/nodejs", "--no-pack"])
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
    println!("built pkg/dist and migrator/dist");
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
