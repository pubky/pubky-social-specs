// Serves the harness page, the built package under `/pkg/` and this directory's `node_modules`
// under `/node_modules/`, on 127.0.0.1 only. A secure context needs no TLS on a loopback
// origin, so Web Locks are there.
//
//   node browser/serve.mjs [--port 8787]      # to open the harness by hand

import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOTS = {
  "/pkg/": path.resolve(here, "../../../pkg"),
  "/node_modules/": path.resolve(here, "../node_modules"),
  "/": here,
};
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".wasm": "application/wasm" };

const resolve = (pathname) => {
  const route = pathname === "/" ? "/harness.html" : pathname;
  const [prefix, root] = Object.entries(ROOTS).find(([prefix]) => route.startsWith(prefix));
  const file = path.resolve(root, `.${route.slice(prefix.length - 1)}`);
  // A path that climbs out of its root is not served
  return file.startsWith(root + path.sep) ? file : null;
};

/** Starts the server; resolves with its origin and a `close()`. */
export const serve = (port = 0) =>
  new Promise((ready) => {
    const server = createServer((req, res) => {
      const file = resolve(decodeURIComponent(new URL(req.url, "http://x").pathname));
      let size;
      try {
        size = file && statSync(file).isFile() ? statSync(file).size : undefined;
      } catch {
        size = undefined;
      }
      if (size === undefined) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "content-length": size, "cache-control": "no-store" });
      createReadStream(file).pipe(res);
    });
    server.listen(port, "127.0.0.1", () => {
      ready({ origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => server.close(done)) });
    });
  });

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { port: { type: "string", default: "8787" } } });
  const { origin } = await serve(Number(values.port));
  console.log(`harness at ${origin}/`);
}
