// Runs the suites from src, no build step: an import of dist/<module>.js resolves to
// src/<module>.ts when there is one, and Node strips the types (22.18 and later). The wasm
// glue has no source and stays in dist.
//   node --import ./qa/from-src.mjs node_modules/.bin/mocha test.js ...

import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const dist = `${pkg}dist/`;

registerHooks({
  resolve(specifier, context, next) {
    if ((specifier.startsWith(".") || specifier.startsWith("/")) && context.parentURL?.startsWith("file:")) {
      const file = fileURLToPath(new URL(specifier, context.parentURL));
      const inSrc = file.startsWith(dist) ? `${pkg}src/${file.slice(dist.length)}` : file.startsWith(`${pkg}src/`) ? file : null;
      const source = inSrc !== null && inSrc.endsWith(".js") ? `${inSrc.slice(0, -3)}.ts` : null;
      if (source !== null && existsSync(source)) return { url: pathToFileURL(source).href, format: "module-typescript", shortCircuit: true };
      // What has no source, the glue, is the built file
      const built = inSrc !== null ? `${dist}${inSrc.slice(`${pkg}src/`.length)}` : null;
      if (built !== null && !existsSync(file) && existsSync(built)) return { url: pathToFileURL(built).href, format: "module", shortCircuit: true };
    }
    return next(specifier, context);
  },
});
