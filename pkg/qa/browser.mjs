// qa/smoke.mjs in headless Chromium: bundled with esbuild into one module, run in a page.
//   npx playwright install chromium && node qa/browser.mjs

import { build } from "esbuild";
import { chromium } from "playwright";

const { outputFiles } = await build({ entryPoints: [new URL("smoke.mjs", import.meta.url).pathname], bundle: true, format: "esm", write: false, platform: "browser" });
const code = outputFiles[0].text;
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setContent(`<script type="module">${code.replaceAll("</script", "<\\/script")}</script>`);
  await page.waitForFunction(() => globalThis.smokeResult !== undefined || document.title === "failed", null, { timeout: 60_000 }).catch(() => {});
  const result = await page.evaluate(() => globalThis.smokeResult);
  if (result !== "ok") throw new Error(`the smoke run in Chromium gave ${result}: ${errors.join("; ")}`);
  console.log(`ok in Chromium ${browser.version()}`);
} finally {
  await browser.close();
}
