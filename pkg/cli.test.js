import assert from "assert";
import { parseArgs, exitCode, progress, sdkSupported, UsageError, reportText, jsonText, main } from "./bin/migrate.js";

describe("pubky-social-migrate arguments", () => {
  const defaults = { passphraseEnv: "PUBKY_PASSPHRASE", dryRun: false, rescan: false, json: false, help: false };

  it("reads every flag", () => {
    assert.deepStrictEqual(parseArgs(["--recovery", "a.pkarr"]), { ...defaults, recovery: "a.pkarr" });
    assert.deepStrictEqual(
      parseArgs(["--dry-run", "--recovery", "a.pkarr", "--passphrase-env", "PASS", "--testnet", "docker-host", "--rescan", "--json"]),
      { ...defaults, recovery: "a.pkarr", passphraseEnv: "PASS", testnet: "docker-host", dryRun: true, rescan: true, json: true },
    );
  });

  it("takes --testnet with or without a host", () => {
    assert.strictEqual(parseArgs(["--recovery", "a", "--testnet"]).testnet, "localhost");
    assert.strictEqual(parseArgs(["--testnet", "--recovery", "a"]).testnet, "localhost");
    assert.strictEqual(parseArgs(["--testnet", "10.0.0.2", "--recovery", "a"]).testnet, "10.0.0.2");
    assert.strictEqual(parseArgs(["--recovery", "a"]).testnet, undefined);
  });

  it("asks for help without a recovery file", () => {
    assert.strictEqual(parseArgs(["--help"]).help, true);
    assert.strictEqual(parseArgs(["-h"]).help, true);
  });

  it("refuses a missing recovery file, a flag without its value, and anything it does not know", () => {
    const refused = [
      [[], /--recovery is required/],
      [["--json"], /--recovery is required/],
      [["--recovery"], /--recovery needs a value/],
      [["--recovery", "--json"], /--recovery needs a value/],
      [["--recovery", "a", "--passphrase-env"], /--passphrase-env needs a value/],
      // The passphrase never goes through the arguments, where the process list shows it
      [["--recovery", "a", "--passphrase", "secret"], /unknown argument --passphrase/],
      [["--recovery", "a", "extra"], /unknown argument extra/],
    ];
    for (const [argv, message] of refused) {
      assert.throws(() => parseArgs(argv), (e) => e instanceof UsageError && message.test(e.message), argv.join(" "));
    }
  });

  it("exits 0 when done, 2 when a run has to go again, 3 when aborted", () => {
    const codes = ["done", "already_migrated", "incomplete", "paused", "aborted"].map((status) => exitCode({ status }));
    assert.deepStrictEqual(codes, [0, 0, 2, 2, 3]);
  });

  it("takes the pubky SDK from 0.11 up to 1", () => {
    for (const version of ["0.11.0", "0.11.3", "0.14.0", "0.14.1-rc.1", "0.99.0"]) assert.ok(sdkSupported(version), version);
    for (const version of ["0.8.0", "0.10.9", "1.0.0", "0.x", "", undefined]) assert.ok(!sdkSupported(version), String(version));
  });

  it("prints a line per phase or pass, and one every 50 objects", () => {
    const lines = [];
    const print = progress((line) => lines.push(line));
    const event = (phase, done, pass) => ({ phase, done, total: 120, ...(pass ? { pass } : {}) });
    print(event("probe", 0));
    print(event("listing", 0));
    for (let done = 1; done <= 110; done++) print(event("migrating", done, done <= 60 ? "posts" : "tags"));
    print(event("flag", 120));
    print(event("done", 120));
    assert.deepStrictEqual(lines, [
      "probe: 0/120",
      "listing: 0/120",
      "migrating posts: 1/120",
      "migrating posts: 50/120",
      "migrating tags: 61/120",
      "migrating tags: 100/120",
      "flag: 120/120",
      "done: 120/120",
    ]);
  });

  it("prints what the homeserver sent with every control character escaped, in text and in JSON", () => {
    const report = {
      status: "already_migrated", mode: "run", done: 0, total: 0, counts: { written: 0 }, dropped: 0, droppedValues: {},
      skipped: { "\u001b]0;x\u0007": ["\u001b[2J", "a\u009bb\u007f"] },
      notes: [{ path: "p\u0085", message: "m\u001b[31m" }],
      error: { code: "IO_ERROR", message: "e\r\n\u001b" },
    };
    for (const out of [reportText(report), jsonText(report)]) {
      assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(out), JSON.stringify(out));
    }
    assert.deepStrictEqual(JSON.parse(jsonText(report)), report);
    assert.match(reportText(report), /\\u001b\[2J/);
  });

  it("takes the passphrase out of the environment before anything else runs", async () => {
    const env = { PUBKY_PASSPHRASE: "secret", OTHER: "kept" };
    const code = await main(["--recovery", "/nonexistent/recovery.pkarr"], env).catch(() => 1);
    assert.strictEqual(code, 1);
    assert.ok(!("PUBKY_PASSPHRASE" in env));
    assert.strictEqual(env.OTHER, "kept");
  });
});
