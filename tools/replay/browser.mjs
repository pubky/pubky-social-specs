// Migrates replica users in a real browser: the harness page (`browser/`) loads the package's
// ESM build and the SDK's browser build, and runs the migration as a web app would, Web Locks
// included. One browser at a time, a fresh one per user.
//
//   node browser.mjs [--data data] [--only <pk>]... [--sample <n>] [--browser chromium|firefox]
//                    [--reports data/reports-<browser>] [--actual data/actual-<browser>]
//                    [--mode run|dry] [--rescan] [--no-dump]
//
// `--sample <n>` takes the sample `sampleUsers` picks (the heaviest user, one past a LIST page,
// the largest blob's owner and n more). Writes `<reports>/<pk>.json` in the record shape of
// `run.mjs`, plus the browser, its timings and memory peaks, and `<reports>/summary.json`; after
// a run it dumps the user's tree to `<actual>/<pk>.ndjson` exactly as `run.mjs` does, so
// `replay_verify --reports <reports> --actual <actual>` checks a browser pass as it checks a
// Node one. An error some code in the page reports, logged or thrown, fails the user.
//
// Browsers install into node_modules: `PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium`.

import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { HOST, atomicWrite, dumpTree, replicaUsers, sampleUsers, seedEpoch, summarizeReports, tally } from "./testnet.mjs";
import { serve } from "./browser/serve.mjs";

const { values: args } = parseArgs({
  options: {
    data: { type: "string", default: "data" },
    only: { type: "string", multiple: true },
    sample: { type: "string" },
    browser: { type: "string", default: "chromium" },
    reports: { type: "string" },
    actual: { type: "string" },
    mode: { type: "string", default: "run" },
    rescan: { type: "boolean", default: false },
    dump: { type: "boolean", default: true },
  },
  allowNegative: true,
});
if (!["chromium", "firefox"].includes(args.browser)) throw new Error(`--browser is chromium or firefox, not ${args.browser}`);
if (args.mode !== "run" && args.mode !== "dry") throw new Error(`--mode is run or dry, not ${args.mode}`);

// Where `npx playwright install` put them with the same setting
process.env.PLAYWRIGHT_BROWSERS_PATH ??= "0";
const { [args.browser]: browserType } = await import("playwright");
const reportsDir = args.reports ?? path.join(args.data, `reports-${args.browser}`);
const actualDir = args.actual ?? path.join(args.data, `actual-${args.browser}`);
const ATTEMPTS = 3;
const SIGN_IN_FAILED = "Sign-in failed:";
const FINAL = new Set(["done", "already_migrated"]);
const PROGRESS_EVERY_MS = 60_000;
const MEMORY_EVERY_MS = 250;
const epoch = seedEpoch(args.data);
if (epoch === null) throw new Error(`no seed epoch in ${args.data}/seed-state.json: seed first`);

/** The page's renderer process; Chromium on Linux only, where its peak can be read. */
const rendererPid = async (browser) => {
  if (args.browser !== "chromium" || process.platform !== "linux") return null;
  const cdp = await browser.newBrowserCDPSession();
  const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
  return processInfo.find((p) => p.type === "renderer")?.id ?? null;
};

/** A process's peak resident set so far, Linux's VmHWM; null once it is gone. */
const peakRss = (pid) => {
  try {
    return Number(/VmHWM:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))[1]) * 1024;
  } catch {
    return null;
  }
};

/** One run of the harness in a browser of its own. */
const attempt = async (user, origin) => {
  const browser = await browserType.launch(args.browser === "chromium" ? { args: ["--enable-precise-memory-info"] } : {});
  const errors = [];
  let ticker;
  let sampler;
  // Sampled while the run goes, so a renderer that dies still leaves its numbers
  const memory = { jsHeapPeak: null, wasm: {}, rendererPeakRss: null };
  try {
    const page = await browser.newPage();
    // The browser logs every 4xx as a console error with the resource as its location; those are
    // the port's to answer, and a script's own errors come from the page's origin
    page.on("console", (message) => {
      if (message.type() === "error" && message.location().url.startsWith(origin)) errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/`);
    await page.waitForFunction(() => window.replay !== undefined);
    const pid = await rendererPid(browser);
    sampler = setInterval(async () => {
      if (pid !== null) memory.rendererPeakRss = peakRss(pid) ?? memory.rendererPeakRss;
      Object.assign(memory, await page.evaluate(() => window.replay.memory()).catch(() => ({})));
    }, MEMORY_EVERY_MS);
    ticker = setInterval(async () => {
      const last = await page.evaluate(() => window.replay.progress.at(-1)).catch(() => undefined);
      if (last) console.error(`${user.pk.slice(0, 8)} ${last.phase}${last.kind ? ` ${last.kind}` : ""}: ${last.done}/${last.total}`);
    }, PROGRESS_EVERY_MS);
    // The secret reaches the page as an argument, never in a URL
    const result = await page.evaluate((options) => window.replay.run(options), {
      secretHex: user.secret,
      testnetHost: HOST,
      mode: args.mode,
      rescan: args.rescan,
    });
    clearInterval(sampler);
    Object.assign(memory, result.memory);
    if (pid !== null) memory.rendererPeakRss = peakRss(pid) ?? memory.rendererPeakRss;
    return { ...result, memory, errors, browserVersion: browser.version() };
  } catch (error) {
    return { thrown: error.message, memory, errors, browserVersion: browser.version() };
  } finally {
    clearInterval(sampler);
    clearInterval(ticker);
    await browser.close();
  }
};

const results = [];
const migrateUser = async (user, origin) => {
  const failures = [];
  let run;
  let ms;
  for (let i = 0; i < ATTEMPTS; i++) {
    const t0 = Date.now();
    run = await attempt(user, origin);
    ms = Date.now() - t0;
    if (!run.thrown?.includes(SIGN_IN_FAILED)) break;
    failures.push(run.thrown);
  }
  const result = {
    pk: user.pk,
    seedEpoch: epoch,
    browser: args.browser,
    browserVersion: run.browserVersion,
    mode: args.mode,
    rescan: args.rescan,
    ms,
    report: run.report ?? null,
    timings: run.timings,
    memory: run.memory,
    ...(run.errors.length ? { errors: run.errors } : {}),
    ...(run.thrown ? { thrown: run.thrown } : {}),
    ...(failures.length ? { failures } : {}),
  };
  if (args.dump && args.mode === "run" && result.report) {
    const t1 = Date.now();
    result.dumped = await dumpTree(user, path.join(actualDir, `${user.pk}.ndjson`), epoch);
    result.dumpMs = Date.now() - t1;
  }
  atomicWrite(path.join(reportsDir, `${user.pk}.json`), JSON.stringify(result, null, 1));
  results.push(result);
  const peak = (bytes) => (bytes == null ? "n/a" : `${Math.round(bytes / 1e6)} MB`);
  console.error(
    `${user.pk} ${result.report?.status ?? run.thrown} in ${ms} ms, heap peak ${peak(result.memory?.jsHeapPeak)}, renderer peak ${peak(result.memory?.rendererPeakRss)}` +
      (run.errors.length ? `, ${run.errors.length} page errors` : ""),
  );
};

const started = Date.now();
mkdirSync(reportsDir, { recursive: true });
const users = args.sample === undefined ? replicaUsers(args.data, args.only) : sampleUsers(args.data, Number(args.sample));
const server = await serve();
try {
  for (const user of users) await migrateUser(user, server.origin);
} finally {
  await server.close();
}

const failed = (r) => !FINAL.has(r.report?.status) || r.errors?.length > 0;
const session = {
  startedAt: new Date(started).toISOString(),
  wallSeconds: Math.round((Date.now() - started) / 100) / 10,
  browser: args.browser,
  mode: args.mode,
  rescan: args.rescan,
  users: results.length,
  ...tally(results),
  pageErrors: results.filter((r) => r.errors?.length).map((r) => ({ pk: r.pk, errors: r.errors.slice(0, 5) })),
  peaks: results.map((r) => ({ pk: r.pk, ms: r.ms, objects: r.report?.total, jsHeapPeak: r.memory?.jsHeapPeak ?? null, rendererPeakRss: r.memory?.rendererPeakRss ?? null, wasm: r.memory?.wasm })),
};
const summary = summarizeReports(reportsDir, epoch, session);
atomicWrite(path.join(reportsDir, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
if (results.some(failed)) process.exitCode = 2;
