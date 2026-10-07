// The reference answers: requests piped to the native oracle, one JSON document per line.
//
//   cargo build --release --features surface --bin surface_oracle

import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const target = process.env.CARGO_TARGET_DIR ?? `${root}target`;
// SURFACE_ORACLE names a binary outright, for a build kept apart from the one in use
const binary =
  process.env.SURFACE_ORACLE ??
  ["release", "debug"].map((profile) => `${target}/${profile}/surface_oracle`).find((path) => fs.existsSync(path));

/** Answers `requests` in order. One process per batch: its stdin closes when the batch ends. */
export function ask(requests) {
  if (!binary) throw new Error("build the oracle first: cargo build --features surface --bin surface_oracle");
  return new Promise((resolve, reject) => {
    const child = spawn(binary, { stdio: ["pipe", "pipe", "inherit"] });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`the oracle exited with ${code}`));
      const lines = Buffer.concat(chunks).toString("utf8").split("\n").filter(Boolean);
      if (lines.length !== requests.length) return reject(new Error("the oracle lost a request"));
      resolve(lines.map((line) => JSON.parse(line)));
    });
    child.stdin.on("error", reject);
    child.stdin.end(requests.map((request) => JSON.stringify(request)).join("\n") + "\n");
  });
}
