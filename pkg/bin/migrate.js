#!/usr/bin/env node
// pubky-social-migrate: migrates the 0.x tree of the account in a recovery file to 1.x, on
// the homeserver the account lives on, through the pubky SDK.

import { readFileSync, realpathSync } from "node:fs";
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
                            (default ${DEFAULT_PASSPHRASE_ENV}); it is never read from the arguments
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

const reportText = (report) => {
  const lines = [`${report.status} (${report.mode}): ${report.done}/${report.total} objects`];
  for (const [outcome, n] of Object.entries(report.counts)) if (n > 0) lines.push(`  ${outcome}: ${n}`);
  if (report.dropped > 0) lines.push(`  values left out: ${report.dropped}`);
  for (const [outcome, paths] of Object.entries(report.skipped)) {
    lines.push(`${outcome}:`, ...paths.map((p) => `  ${p}`));
  }
  if (report.notes.length > 0) lines.push("notes:", ...report.notes.map((n) => `  ${n.path}: ${n.message}`));
  if (report.error) {
    const need = report.error.needBytes === undefined ? "" : ` About ${report.error.needBytes} more bytes are needed.`;
    lines.push(`${report.error.code}: ${report.error.message}${need}`);
  }
  return lines.join("\n");
};

const main = async (argv, env) => {
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
  const passphrase = env[args.passphraseEnv];
  if (passphrase === undefined) {
    console.error(`Put the recovery passphrase in the environment variable ${args.passphraseEnv}.`);
    return 1;
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

  const keypair = sdk.Keypair.fromRecoveryFile(readFileSync(args.recovery), passphrase);
  const pubky = args.testnet === undefined ? new sdk.Pubky() : sdk.Pubky.testnet(args.testnet);
  let session;
  try {
    session = await pubky.signer(keypair).signin(CLIENT_ID);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Sign-in failed: ${message}\n${signinHint(message)}`);
    return 1;
  }
  // The session holds a root grant, which must not outlive the run
  try {
    const owner = session.info.publicKey.z32();
    console.error(`Migrating pubky${owner}${args.dryRun ? " (dry run)" : ""}`);

    // The first Ctrl-C, or a SIGTERM, stops the run after the objects in flight and reaches
    // the sign-out below, best effort: a supervisor that kills the process during that wait
    // leaves the grant active. A second Ctrl-C kills it
    const controller = new AbortController();
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => controller.abort());
    const report = await runMigration({
      owner,
      port: sdkPort(session),
      caps: session.info.capabilities,
      mode: args.dryRun ? "dry" : "run",
      rescan: args.rescan,
      signal: controller.signal,
      onProgress: progress((line) => console.error(line)),
    });
    console.log(args.json ? JSON.stringify(report, null, 2) : reportText(report));
    return exitCode(report);
  } finally {
    // The run's grant is root and lives for years unless revoked here or from Ring, so a
    // failed revocation is worth a line
    await session.signout().catch((error) => {
      console.error(`warning: could not sign out, the grant stays active until it expires: ${error?.message ?? error}`);
    });
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
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  });
}

export { parseArgs, exitCode, progress, sdkSupported, UsageError, USAGE };
