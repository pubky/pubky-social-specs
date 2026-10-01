// The migration as a web app runs it: the package's ESM build, the SDK's browser build and Web
// Locks, in one page. `browser.mjs` drives it through `window.replay.run`.

const CLIENT_ID = "pubky-social-migrate";
const HEAP_EVERY_MS = 200;

// Each wasm's linear memory, to read its size after the run. It only grows, so its size at the
// end is its peak. Hooked before the modules that instantiate them load.
const memories = new Map();
const watch = (instance) => {
  const { exports } = instance;
  if (!(exports.memory instanceof WebAssembly.Memory)) return;
  const label = "__wbg_keypair_free" in exports ? "sdk" : "__wbg_migration_free" in exports ? "specs" : `wasm${memories.size}`;
  memories.set(label, exports.memory);
};
const { instantiate, Instance } = WebAssembly;
WebAssembly.instantiate = async (...args) => {
  const result = await instantiate(...args);
  watch(result.instance ?? result);
  return result;
};
WebAssembly.Instance = new Proxy(Instance, {
  construct(target, args) {
    const instance = Reflect.construct(target, args);
    watch(instance);
    return instance;
  },
});

const { default: sdk } = await import("@synonymdev/pubky");
const { runMigration } = await import("pubky-social-specs/migration");
const { sdkPort } = await import("pubky-social-specs/migration/pubky-sdk");

const hexToBytes = (hex) => Uint8Array.from(hex.match(/../g), (byte) => parseInt(byte, 16));
// Chromium only; precise with --enable-precise-memory-info
const heap = () => performance.memory?.usedJSHeapSize ?? null;
const lock = (name, fn) => navigator.locks.request(name, { ifAvailable: true }, fn);

const progress = [];
let heapPeak = null;
const sample = () => {
  const now = heap();
  if (now !== null && (heapPeak === null || now > heapPeak)) heapPeak = now;
};
/** The run's memory so far; the driver reads it too, so a tab that dies leaves numbers behind. */
const memory = () => ({
  jsHeapPeak: heapPeak,
  wasm: Object.fromEntries([...memories].map(([label, m]) => [label, m.buffer.byteLength])),
});

/**
 * The port with every call timed: count and summed latency per call, and the time no call was in
 * flight, which is the engine's own work, the wasm included.
 */
const timed = (port) => {
  const calls = {};
  let inFlight = 0;
  let idleSince = performance.now();
  let idleMs = 0;
  const wrap = (name, fn) => async (...args) => {
    if (inFlight++ === 0) idleMs += performance.now() - idleSince;
    const t0 = performance.now();
    try {
      return await fn(...args);
    } finally {
      const c = (calls[name] ??= { n: 0, ms: 0 });
      c.n++;
      c.ms += performance.now() - t0;
      if (--inFlight === 0) idleSince = performance.now();
    }
  };
  const wrapped = Object.fromEntries(["list", "get", "head", "putJson", "putBytes", "delete"].map((name) => [name, wrap(name, port[name].bind(port))]));
  const summary = () => ({
    idleMs: Math.round(idleMs + (inFlight === 0 ? performance.now() - idleSince : 0)),
    calls: Object.fromEntries(Object.entries(calls).map(([name, c]) => [name, { n: c.n, ms: Math.round(c.ms) }])),
  });
  return { port: wrapped, summary };
};

/**
 * Signs in with the secret, migrates the account's tree on the testnet at `testnetHost`, signs
 * out, and resolves with the report, the timings and the memory peaks.
 */
const run = async ({ secretHex, testnetHost = "localhost", mode = "run", rescan = false }) => {
  progress.length = 0;
  heapPeak = heap();
  const t0 = performance.now();
  let session;
  try {
    session = await sdk.Pubky.testnet(testnetHost).signer(sdk.Keypair.fromSecret(hexToBytes(secretHex))).signin(CLIENT_ID);
  } catch (error) {
    // The CLI's wording, which the driver retries on as run.mjs does
    throw new Error(`Sign-in failed: ${error?.message ?? error}`);
  }
  const t1 = performance.now();
  const timer = setInterval(sample, HEAP_EVERY_MS);
  const port = timed(sdkPort(session));
  try {
    const report = await runMigration({
      owner: session.info.publicKey.z32(),
      port: port.port,
      caps: session.info.capabilities,
      mode,
      rescan,
      lock,
      onProgress: (event) => {
        progress.push({ t: Math.round(performance.now() - t1), phase: event.phase, kind: event.kind, done: event.done, total: event.total });
        sample();
      },
    });
    const t2 = performance.now();
    sample();
    return {
      report,
      timings: { signinMs: Math.round(t1 - t0), migrateMs: Math.round(t2 - t1), port: port.summary() },
      memory: memory(),
    };
  } finally {
    clearInterval(timer);
    // The session holds a root grant, which must not outlive the run
    await session.signout().catch((error) => console.warn(`could not sign out: ${error?.message ?? error}`));
  }
};

window.replay = { run, progress, memory };
document.getElementById("state").textContent = "ready";
