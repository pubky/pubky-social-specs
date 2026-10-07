import { MIME_TO_EXT } from "./data.js";
import { asciiFold } from "./text.js";

const ESSENCE_PART = /^[a-z0-9!#$&^_.+-]+$/;

/** The text before the first `;`, ASCII-folded and untrimmed; null when malformed. */
export function essence(declared: string): string | null {
  const semicolon = declared.indexOf(";");
  const folded = asciiFold(semicolon < 0 ? declared : declared.slice(0, semicolon));
  const slash = folded.indexOf("/");
  if (slash < 0) return null;
  const ok = ESSENCE_PART.test(folded.slice(0, slash)) && ESSENCE_PART.test(folded.slice(slash + 1));
  return ok ? folded : null;
}

/** The path extension a declared type maps to; `"bin"` for anything unmapped or malformed. */
export function mimeToExt(declared: string): string {
  const type = essence(declared);
  return MIME_TO_EXT.find(([mime]) => mime === type)?.[1] ?? "bin";
}
