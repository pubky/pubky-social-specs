// Tag labels, shared by tags and feed filters. A label is not normalized beyond trimming and
// ASCII case, as in the reference: NFC and NFD spellings are two labels.

import { limits } from "../data.js";
import { fail } from "../errors.js";
import { asciiFold, codePointLen, frozenTrim, hasFrozenWhitespace } from "../text.js";

/** A label as it is stored: trimmed and ASCII-lowercased. Only a builder folds. */
export const foldLabel = (label: string) => asciiFold(frozenTrim(label));

export function checkLabel(label: string, field = "label"): void {
  const length = codePointLen(label);
  if (length > limits.tagLabelMaxLength) fail("length", `Tag '${label}' exceeds maximum length of ${limits.tagLabelMaxLength} characters`, field, limits.tagLabelMaxLength);
  if (length < limits.tagLabelMinLength) fail("length", `Tag '${label}' is shorter than minimum length of ${limits.tagLabelMinLength} character`, field, limits.tagLabelMinLength);
  if (hasFrozenWhitespace(label)) fail("format", `Tag '${label}' contains whitespace characters`, field);
  for (const c of label) if ((limits.tagInvalidChars as readonly string[]).includes(c)) fail("format", `Tag '${label}' contains invalid character: ${c}`, field);
}
