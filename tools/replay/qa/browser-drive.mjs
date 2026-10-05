// One user through the harness page in Chromium, with what browser.mjs does not do: a network
// throttled through CDP, and runs cut short by a reload or a closed tab before the run that is
// let finish. Writes that last run's record in browser.mjs's shape, and dumps the tree.
//
//   node qa/browser-drive.mjs --only <pk> --reports <dir> --actual <dir>
//        [--throttle slow3g] [--cut reload:<ms>] [--cut close:<ms>]... [--timeout <s>]

import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { HOST, replicaUsers, seedEpoch } from "../testnet.mjs";
import { serve } from "../browser/serve.mjs";
import { dump, record } from "./lib.mjs";

const { values: args } = parseArgs({
  options: {
    data: { type: "string", default: "data" },
    only: { type: "string" },
    reports: { type: "string" },
    actual: { type: "string" },
    throttle: { type: "string" },
    "throttle-after-signin": { type: "boolean", default: false },
    cut: { type: "string", multiple: true, default: [] },
    timeout: { type: "string", default: "3600" },
    rescan: { type: "boolean", default: false },
  },
});
process.env.PLAYWRIGHT_BROWSERS_PATH ??= "0";
const { chromium } = await import("playwright");
// DevTools' "Slow 3G" preset
const PROFILES = { slow3g: { offline: false, latency: 2000, downloadThroughput: (500 * 1024) / 8 * 0.8, uploadThroughput: (500 * 1024) / 8 * 0.8 } };

const user = replicaUsers(args.data, [args.only])[0];
if (!user) throw new Error("--only names no replica user");
const server = await serve();
const browser = await chromium.launch({ args: ["--enable-precise-memory-info"] });
const context = await browser.newContext();
const log = (m) => console.error(`${user.pk.slice(0, 8)} ${m}`);

const openPage = async () => {
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error" && m.location().url.startsWith(server.origin)) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${server.origin}/`);
  await page.waitForFunction(() => window.replay !== undefined);
  // After the page loaded: the run's requests are what the throttle is for
  const throttle = async () => {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", PROFILES[args.throttle]);
  };
  if (args.throttle && !args["throttle-after-signin"]) await throttle();
  return { page, errors, throttle };
};
const runIn = (page) =>
  page.evaluate((o) => window.replay.run(o), { secretHex: user.secret, testnetHost: HOST, mode: "run", rescan: args.rescan });
const lastProgress = (page) => page.evaluate(() => window.replay.progress.at(-1)).catch(() => null);

const cuts = [];
try {
  for (const cut of args.cut) {
    const [how, ms] = cut.split(":");
    const { page } = await openPage();
    const running = runIn(page).then((r) => ({ finished: r.report?.status }), (e) => ({ thrown: e.message.split("\n")[0] }));
    const outcome = await Promise.race([running, new Promise((r) => setTimeout(() => r(null), Number(ms)))]);
    const progress = await lastProgress(page);
    if (how === "reload") {
      await page.reload();
      await page.waitForFunction(() => window.replay !== undefined);
      await page.close();
    } else await page.close();
    const ended = await running;
    cuts.push({ how, afterMs: Number(ms), finishedBefore: outcome?.finished ?? null, progress, ended });
    log(`${how} after ${ms} ms at ${progress?.phase} ${progress?.kind ?? ""} ${progress?.done}/${progress?.total}`);
  }
  const { page, errors, throttle } = await openPage();
  const t0 = Date.now();
  const running = runIn(page);
  // The first progress event comes after the sign-in
  if (args.throttle && args["throttle-after-signin"]) {
    await page.waitForFunction(() => window.replay.progress.length > 0, null, { polling: 20, timeout: 120_000 });
    await throttle();
  }
  const result = await Promise.race([
    running,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`no report within ${args.timeout} s`)), Number(args.timeout) * 1000)),
  ]).catch(async (e) => ({ thrown: e.message, progress: await lastProgress(page) }));
  const ms = Date.now() - t0;
  const rec = record(args.data, args.reports, user, { exit: null, signal: null, ms, report: result.report ?? null }, {
    browser: "chromium",
    browserVersion: browser.version(),
    throttle: args.throttle ?? null,
    timings: result.timings,
    memory: result.memory,
    cuts,
    ...(errors.length ? { errors } : {}),
    ...(result.thrown ? { thrown: result.thrown, lastProgress: result.progress } : {}),
  });
  if (rec.report) rec.dumped = await dump(args.data, args.actual, user);
  console.log(JSON.stringify({ pk: user.pk.slice(0, 10), ms, status: rec.report?.status, counts: rec.report?.counts, cuts, thrown: rec.thrown, errors: errors.slice(0, 5), timings: rec.timings }, null, 1));
} finally {
  await browser.close();
  await server.close();
}
process.exit(0);
