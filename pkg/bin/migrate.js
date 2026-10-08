#!/usr/bin/env node
// pubky-social-migrate: migrates the 0.x tree of the account in a recovery file to 1.x, on
// the homeserver the account lives on, through the pubky SDK.

import { readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const CLIENT_ID = "pubky-social-migrate";
const DEFAULT_PASSPHRASE_ENV = "PUBKY_PASSPHRASE";
const PROGRESS_EVERY = 50;
// From 0.11 the SDK signs in with a client id to a grant session, and its session storage is
// the one the adapter calls
const sdkSupported = (version) => {
  const minor = /^0\.(\d+)\.\d+/.exec(version)?.[1];
  return minor !== undefined && Number(minor) >= 11;
};

const USAGE = `Usage: pubky-social-migrate --recovery <file> [options]

Copies the account's pubky.app 0.x data to its pubky-social 1.x paths on its homeserver.
The 0.x data is never modified, and running again resumes an interrupted run.

Options:
  --recovery <file>         the account's recovery file
  --passphrase-env <VAR>    the environment variable holding the recovery passphrase
                            (default ${DEFAULT_PASSPHRASE_ENV}); without it the passphrase is asked
                            on the terminal, unechoed, and never read from the arguments
  --testnet [host]          use a pubky testnet at host (default localhost) instead of mainnet
  --dry-run                 read and count as a run does, write nothing
  --rescan                  walk the tree even when an earlier run finished it
  --json                    print the report as JSON
  -h, --help                show this help

Exit codes: 0 done or already migrated, 2 incomplete or paused (run again),
3 aborted, 1 usage or unexpected error.
Needs @synonymdev/pubky >=0.11 <1 installed next to this package.`;

class UsageError extends Error {}

const parseArgs = (argv) => {
  const args = { passphraseEnv: DEFAULT_PASSPHRASE_ENV, dryRun: false, rescan: false, json: false, help: false };
  const isFlag = (arg) => arg === undefined || arg.startsWith("-");
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (isFlag(argv[i + 1])) throw new UsageError(`${arg} needs a value`);
      return argv[++i];
    };
    switch (arg) {
      case "--recovery":
        args.recovery = value();
        break;
      case "--passphrase-env":
        args.passphraseEnv = value();
        break;
      case "--testnet":
        args.testnet = isFlag(argv[i + 1]) ? "localhost" : argv[++i];
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--rescan":
        args.rescan = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        throw new UsageError(`unknown argument ${arg}`);
    }
  }
  if (!args.help && args.recovery === undefined) throw new UsageError("--recovery is required");
  return args;
};

const EXIT = { done: 0, already_migrated: 0, incomplete: 2, paused: 2, aborted: 3 };

const exitCode = (report) => EXIT[report.status] ?? 1;

const progress = (write) => {
  let last;
  return (event) => {
    const step = event.pass ? `${event.phase} ${event.pass}` : event.phase;
    if (step === last && (event.done === 0 || event.done % PROGRESS_EVERY !== 0)) return;
    last = step;
    write(`${step}: ${event.done}/${event.total}`);
  };
};

const escaped = (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;

// Paths, flag contents and error messages come from the homeserver, so no control character
// reaches the terminal as one: C0, DEL and C1 are printed as escapes
const visible = (text) => String(text).replace(/\p{Cc}/gu, escaped);

const messageOf = (error) => (error instanceof Error ? error.message : String(error));

// JSON.stringify escapes C0 but writes DEL and C1 raw
const jsonText = (value) => JSON.stringify(value, null, 2).replace(/[\u007f-\u009f]/g, escaped);

const reportText = (report) => {
  const lines = [`${report.status} (${report.mode}): ${report.done}/${report.total} objects`];
  for (const [outcome, n] of Object.entries(report.counts)) if (n > 0) lines.push(`  ${visible(outcome)}: ${n}`);
  if (report.dropped > 0) lines.push(`  values left out: ${report.dropped}`);
  for (const [outcome, paths] of Object.entries(report.skipped)) {
    lines.push(`${visible(outcome)}:`, ...paths.map((p) => `  ${visible(p)}`));
  }
  if (report.notes.length > 0) lines.push("notes:", ...report.notes.map((n) => `  ${visible(n.path)}: ${visible(n.message)}`));
  if (report.error) {
    const need = report.error.needBytes === undefined ? "" : ` About ${report.error.needBytes} more bytes are needed.`;
    lines.push(`${report.error.code}: ${visible(report.error.message)}${need}`);
  }
  return lines.join("\n");
};

/**
 * The passphrase typed on the terminal with echo off, as bytes the caller zeroes, or null when
 * `input` is no terminal. Ctrl-C or Ctrl-D give up.
 */
const askPassphrase = (input, output) =>
  new Promise((resolve, reject) => {
    if (!input.isTTY || typeof input.setRawMode !== "function") return resolve(null);
    output.write("Recovery passphrase: ");
    let typed = Buffer.alloc(0);
    const done = (error) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
      output.write("\n");
      if (error) {
        typed.fill(0);
        reject(error);
      } else resolve(typed);
    };
    const onData = (chunk) => {
      for (const byte of chunk) {
        if (byte === 0x0d || byte === 0x0a) return done();
        if (byte === 0x03 || byte === 0x04) return done(new UsageError("no passphrase given"));
        const grown = byte === 0x7f || byte === 0x08 ? Buffer.from(typed.subarray(0, Math.max(0, typed.length - 1))) : Buffer.concat([typed, Buffer.from([byte])]);
        typed.fill(0);
        typed = grown;
      }
      chunk.fill(0);
    };
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });

/** Why a recovery file must not be used, or null: it holds the key, so only its owner reads it. */
const recoveryFault = (file, platform = process.platform) => {
  let stat;
  try {
    stat = statSync(file);
  } catch (error) {
    return `cannot read the recovery file ${file}: ${error.code ?? error.message}`;
  }
  if (!stat.isFile()) return `the recovery file ${file} is not a file`;
  // Windows has no group and other bits to read
  if (platform !== "win32" && (stat.mode & 0o077) !== 0) {
    return `the recovery file ${file} is readable by other users (mode ${(stat.mode & 0o777).toString(8)}); run chmod 600 on it first`;
  }
  return null;
};

const main = async (argv, env, io = { stdin: process.stdin, stderr: process.stderr }) => {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`${error.message}\n\n${USAGE}`);
    return 1;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  let passphrase = env[args.passphraseEnv];
  // Not left for anything this process starts or prints its environment from
  delete env[args.passphraseEnv];
  const fault = recoveryFault(args.recovery);
  if (fault !== null) {
    console.error(visible(fault));
    return 1;
  }
  if (passphrase === undefined) {
    let typed;
    try {
      typed = await askPassphrase(io.stdin, io.stderr);
    } catch (error) {
      if (!(error instanceof UsageError)) throw error;
      console.error(error.message);
      return 1;
    }
    if (typed === null) {
      console.error(`No terminal to ask the passphrase on: put it in the environment variable ${args.passphraseEnv}.`);
      return 1;
    }
    // The SDK takes a string, which cannot be wiped; the bytes it came from are
    passphrase = typed.toString("utf8");
    typed.fill(0);
  }

  let version;
  try {
    version = createRequire(import.meta.url)("@synonymdev/pubky/package.json").version;
  } catch {
    console.error("pubky-social-migrate needs the pubky SDK: npm install @synonymdev/pubky@^0.14");
    return 1;
  }
  if (!sdkSupported(version)) {
    console.error(`pubky-social-migrate needs @synonymdev/pubky >=0.11 <1, and ${version} is installed.`);
    return 1;
  }
  const sdk = await import("@synonymdev/pubky");
  const { runMigration } = await import("../dist/migration/index.js");
  const { sdkPort } = await import("../dist/migration/adapters/pubky-sdk.js");

  const recovery = readFileSync(args.recovery);
  let keypair;
  try {
    keypair = sdk.Keypair.fromRecoveryFile(recovery, passphrase);
  } finally {
    recovery.fill(0);
    passphrase = undefined;
  }
  const pubky = args.testnet === undefined ? new sdk.Pubky() : sdk.Pubky.testnet(args.testnet);
  let session;
  try {
    session = await pubky.signer(keypair).signin(CLIENT_ID);
  } catch (error) {
    const message = messageOf(error);
    console.error(`Sign-in failed: ${visible(message)}\n${signinHint(message)}`);
    return 1;
  } finally {
    // The secret key lives in the SDK's wasm memory until the keypair is freed
    keypair.free?.();
  }
  const signout = () =>
    session.signout().catch((error) => {
      console.error(`warning: could not sign out, the grant stays active until it expires: ${visible(error?.message ?? error)}`);
    });
  // An error thrown outside the run's own promise still signs out before the process ends
  const fatal = (error) => {
    console.error(visible(messageOf(error)));
    void signout().finally(() => process.exit(1));
  };
  process.once("uncaughtException", fatal);
  process.once("unhandledRejection", fatal);
  // The session holds a root grant, which must not outlive the run
  try {
    const owner = session.info.publicKey.z32();
    console.error(`Migrating pubky${owner}${args.dryRun ? " (dry run)" : ""}`);

    // The first Ctrl-C, a SIGTERM or a closed terminal stops the run after the objects in
    // flight and reaches the sign-out below, best effort: a supervisor that kills the process
    // during that wait leaves the grant active. A second Ctrl-C kills it
    const controller = new AbortController();
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, () => controller.abort());
    const report = await runMigration({
      owner,
      port: sdkPort(session),
      caps: session.info.capabilities,
      mode: args.dryRun ? "dry" : "run",
      rescan: args.rescan,
      signal: controller.signal,
      onProgress: progress((line) => console.error(line)),
    });
    console.log(args.json ? jsonText(report) : reportText(report));
    return exitCode(report);
  } finally {
    process.removeListener("uncaughtException", fatal);
    process.removeListener("unhandledRejection", fatal);
    // The run's grant is root and lives for years unless revoked here or from Ring, so a
    // failed revocation is worth a line
    await signout();
  }
};

// Grant sign-in shipped in the same homeserver release as /priv/, so a refusal of the route
// points at an older homeserver; a clock or a resolution failure never reached it
const signinHint = (message) => {
  if (/PoP timestamp/i.test(message)) return "The homeserver refused this device's clock: check the time on this machine.";
  if (/could not resolve|resolve query|no responses/i.test(message)) {
    return "The homeserver record did not resolve: check the network, or --testnet for a local one.";
  }
  return "If the homeserver answered, it is probably older than /priv/, which the migration needs.";
};

const invoked = process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invoked) {
  process.exitCode = await main(process.argv.slice(2), process.env).catch((error) => {
    console.error(visible(messageOf(error)));
    return 1;
  });
}

export { parseArgs, exitCode, progress, sdkSupported, UsageError, USAGE, reportText, jsonText, main, askPassphrase, recoveryFault };
