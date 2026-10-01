// Offsets this process's clock by QA_CLOCK_OFFSET_MS, loaded with `node --require`. With
// QA_CLOCK_AFTER_SIGNIN=1 the offset starts once the CLI prints its "Migrating" line, so the
// sign-in, which the homeserver bounds by its own clock, runs on the true time. With
// QA_CLOCK_SCOPE=specs only the package's wasm reads the offset clock, found by its glue file
// in the caller's stack, so the SDK's pkarr and proof timestamps stay true.
const offset = Number(process.env.QA_CLOCK_OFFSET_MS || 0);
let active = process.env.QA_CLOCK_AFTER_SIGNIN !== "1";
const RealDate = Date;
const realNow = RealDate.now.bind(RealDate);
const specsOnly = process.env.QA_CLOCK_SCOPE === "specs";
const now = () => {
  if (!active) return realNow();
  if (specsOnly && !new Error().stack.includes("pubky_social_specs.js")) return realNow();
  return realNow() + offset;
};
class SkewedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(now());
    else super(...args);
  }
  static now() {
    return now();
  }
}
globalThis.Date = SkewedDate;
if (!active) {
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    if (!active && String(chunk).startsWith("Migrating ")) active = true;
    return write(chunk, ...rest);
  };
}
