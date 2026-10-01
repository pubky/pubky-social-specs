// One user through the harness page in Chromium's headless shell, driven over raw CDP with the
// Runtime domain only. Playwright enables the Network domain, and Chromium then ships every
// request body to the driver: a 100 MB PUT crashes Playwright's pipe (a string over 512 MB)
// and inflates the browser. Writes browser.mjs's record shape and dumps the tree.
//
//   node --experimental-websocket qa/cdp-run.mjs --only <pk> --reports <dir> --actual <dir>

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { HOST, replicaUsers } from "../testnet.mjs";
import { serve } from "../browser/serve.mjs";
import { dump, record } from "./lib.mjs";

const { values: args } = parseArgs({
  options: { data: { type: "string", default: "data" }, only: { type: "string" }, reports: { type: "string" }, actual: { type: "string" }, rescan: { type: "boolean", default: false } },
});
const here = path.dirname(fileURLToPath(import.meta.url));
const browsers = path.join(here, "../node_modules/playwright-core/.local-browsers");
const shellDir = readdirSync(browsers).find((d) => d.startsWith("chromium_headless_shell-"));
const binary = path.join(browsers, shellDir, "chrome-headless-shell-linux64", "chrome-headless-shell");
const user = replicaUsers(args.data, [args.only])[0];
const server = await serve();
const profile = mkdtempSync(path.join(tmpdir(), "qa-cdp-"));
const chrome = spawn(binary, ["--remote-debugging-port=0", "--enable-precise-memory-info", `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
const wsUrl = await new Promise((resolve, reject) => {
  let err = "";
  chrome.stderr.on("data", (c) => {
    err += c;
    const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
    if (m) resolve(m[1]);
  });
  chrome.on("exit", () => reject(new Error(`chrome exited: ${err.slice(-500)}`)));
});

const connect = (url) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && pending.has(msg.id)) {
        const { ok, fail } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? fail(new Error(JSON.stringify(msg.error))) : ok(msg.result);
      }
    };
    ws.onopen = () => resolve({ send: (method, params = {}) => new Promise((ok, fail) => { pending.set(++id, { ok, fail }); ws.send(JSON.stringify({ id, method, params })); }), close: () => ws.close() });
    ws.onerror = reject;
  });

const browserCdp = await connect(wsUrl);
const { targetId } = await browserCdp.send("Target.createTarget", { url: `${server.origin}/` });
const page = await connect(wsUrl.replace(/devtools\/browser\/.*/, `devtools/page/${targetId}`));
const evaluate = async (expression, awaitPromise = false) => {
  const r = await page.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
for (let i = 0; !(await evaluate("window.replay !== undefined").catch(() => false)); i++) {
  if (i > 100) throw new Error("harness did not load");
  await new Promise((r) => setTimeout(r, 200));
}
const { processInfo } = await browserCdp.send("SystemInfo.getProcessInfo");
const pid = processInfo.find((p) => p.type === "renderer")?.id;
const hwm = () => {
  try {
    return Number(/VmHWM:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))[1]) * 1024;
  } catch {
    return null;
  }
};
const memory = { jsHeapPeak: null, wasm: {}, rendererPeakRss: null };
const sampler = setInterval(async () => {
  memory.rendererPeakRss = hwm() ?? memory.rendererPeakRss;
  Object.assign(memory, (await evaluate("window.replay.memory()").catch(() => null)) ?? {});
}, 250);
const t0 = Date.now();
let result;
try {
  const options = JSON.stringify({ secretHex: user.secret, testnetHost: HOST, mode: "run", rescan: args.rescan });
  result = await evaluate(`window.replay.run(${options})`, true);
} catch (e) {
  result = { thrown: e.message };
}
const ms = Date.now() - t0;
clearInterval(sampler);
memory.rendererPeakRss = hwm() ?? memory.rendererPeakRss;
if (result.memory) Object.assign(memory, result.memory);
const version = (await browserCdp.send("Browser.getVersion")).product;
page.close();
browserCdp.close();
const exited = new Promise((r) => chrome.once("exit", r));
chrome.kill();
await exited;
await server.close();
rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
const rec = record(args.data, args.reports, user, { exit: null, signal: null, ms, report: result.report ?? null }, { browser: "chromium-cdp", browserVersion: version, timings: result.timings, memory, ...(result.thrown ? { thrown: result.thrown } : {}) });
if (rec.report) await dump(args.data, args.actual, user);
console.log(JSON.stringify({ pk: user.pk.slice(0, 10), ms, status: rec.report?.status, counts: rec.report?.counts, memory, timings: rec.timings, thrown: rec.thrown }, null, 1));
process.exit(0);
