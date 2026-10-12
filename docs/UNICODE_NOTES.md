# Unicode String Length Handling

## Overview

This document explains how string length validation works in `pubky-social-specs` and the important differences between JavaScript's native string length and Rust's character counting.

## The Problem

JavaScript and Rust count string length differently for certain Unicode characters:

| Character | Type | Rust `.chars().count()` | JS `.length` |
|-----------|------|-------------------------|--------------|
| `"Hello"` | ASCII | 5 | 5 |
| `"中文"` | Chinese | 2 | 2 |
| `"café"` | Accented | 4 | 4 |
| `"🔥"` | Emoji | **1** | **2** |
| `"𒅃"` | Cuneiform | **1** | **2** |
| `"𓀀"` | Hieroglyph | **1** | **2** |

### Why the Difference?

- **JavaScript** uses **UTF-16** encoding internally. The `.length` property counts **UTF-16 code units**.
- **Rust** `.chars().count()` counts **Unicode code points** (scalar values).

Characters in the **Basic Multilingual Plane (BMP)** (U+0000 to U+FFFF) use 1 UTF-16 code unit.
Characters **outside the BMP** (U+10000 and above) require a **surrogate pair** (2 UTF-16 code units).

### Characters Outside BMP (Affected by This Difference)

| Category | Examples | UTF-16 Units per Char |
|----------|----------|----------------------|
| Emoji | 🔥 🚀 😀 👋 🌍 | 2 |
| Cuneiform (Sumerian) | 𒅃 𒀀 𒁀 | 2 |
| Egyptian Hieroglyphs | 𓀀 𓆉 𓍄 | 2 |
| Musical Symbols | 𝄞 𝄢 | 2 |
| Mathematical Alphanumeric | 𝔸 𝕏 | 2 |
| Historic Scripts | Various | 2 |

**Note**: Characters in the BMP (ASCII, Chinese, Japanese, Korean, Arabic, Hebrew, Cyrillic, Greek, Thai, etc.) all use 1 UTF-16 unit and are **unaffected** by this difference.

## Our Solution: Code Points on Both Sides

Every length rule counts Unicode code points. The Rust crate counts them with `.chars().count()`.
The `pubky-social-specs` npm package is a TypeScript implementation of the same rules: it
counts code points too, never UTF-16 units, and its differential tests hold every answer equal
to the crate's, so a name of fifty emoji is accepted by both and one of fifty-one is refused by
both.

### Example: Username Validation

```rust
// In Rust
const MAX_USERNAME_LENGTH: usize = 50;

fn validate(&self, _id: Option<&str>) -> Result<(), String> {
    let name_length = self.name.chars().count();  // Unicode code points
    if name_length > MAX_USERNAME_LENGTH {
        return Err("Validation Error: name must be 3 to 50 code points".into());
    }
    Ok(())
}
```

| Input | `.chars().count()` | Valid? (max 50) |
|-------|-------------------|-----------------|
| `"Alice"` | 5 | ✅ |
| `"🔥".repeat(50)` | 50 | ✅ |
| `"🔥".repeat(51)` | 51 | ❌ |
| `"𓀀".repeat(50)` | 50 | ✅ |

## Client-Side Validation

For client-side validation (for UX feedback), rely on the validators of the `pubky-social-specs` npm package: they count code points exactly as the crate does.

### How to Validate in Your Application

A builder throws a `ValidationError` at the first refusal; `validateUser` and its siblings run the same rules and collect every issue without minting anything:

```javascript
import { buildUser, validateUser, ValidationError } from "pubky-social-specs";

// Method 1: a builder, which refuses at the first rule broken
try {
    buildUser(userId, {
        name: "Alice🔥",       // Emoji counts as 1 character
        bio: "Bio with 𓀀",    // Hieroglyph counts as 1 character
    });
    console.log("User is valid!");
} catch (error) {
    if (error instanceof ValidationError) showError(error.message);
}

// Method 2: every issue of a form at once
const result = validateUser({ name: "Al", bio: "Bio with 𓀀" });
if (!result.success) for (const issue of result.issues) showError(issue.message);
```

### JavaScript Length Methods Comparison

If you need client-side length validation for real-time input feedback (e.g., character counters) or custom validation, you should use methods that count Unicode code points to match Rust's `.chars().count()` behavior:

```javascript
const str = "Hi🔥";

// ❌ WRONG - counts UTF-16 code units, not Unicode code points
str.length                    // 4 (will reject valid input)
if (username.length > MAX_USERNAME_LENGTH) {
    showError("Username too long");
}
// This would incorrectly reject "🔥".repeat(25) 
// because JS sees 50 code units, but Rust sees 25 code points (valid!)

// ✅ CORRECT - counts Unicode code points (matches Rust)
// These methods correctly handle characters outside BMP (emoji, etc.)
[...str].length              // 3 (Unicode code points) - counts 🔥 as 1
Array.from(str).length       // 3 (also works)
```

### When to Validate

- **On form submit**: Always - catch errors before network calls
- **Real-time feedback**: Optional - use `[...str].length` for input counters
- **On input change**: Usually not needed - can impact UX with emoji autocomplete

### Edge Cases: Grapheme Clusters (Advanced)

⚠️ **This is informational** - current validation doesn't handle grapheme clusters, and that's acceptable for most use cases.

Even `.chars().count()` doesn't handle complex **grapheme clusters** (what users perceive as single characters):

| String | Visual | Code Points | User Perception |
|--------|--------|-------------|----------------|
| `"👨‍👩‍👧‍👦"` | family emoji | 7 | 1 |
| `"🇺🇸"` | flag | 2 | 1 |
| `"é"` (e + ◌́) | accented e | 2 | 1 |

**Impact**: A username with 50 flag emojis would actually be 100 code points and fail validation.

**Decision**: For usernames, tags, and bios, code point counting is sufficient. True grapheme counting would add complexity and dependencies without significant benefit for this use case.

## Summary

| Aspect | Approach |
|--------|----------|
| **Validation Location** | The crate, and the npm package, which counts the same way |
| **Length Method** | `.chars().count()` (Unicode code points) |
| **JS Client** | Use `[...str].length` if local validation needed |
| **Affected Characters** | Emoji, ancient scripts, musical symbols |
| **Unaffected Characters** | ASCII, Chinese, Japanese, Arabic, etc. |
| **Performance** | <1ms for typical inputs |

## References

- [Unicode Standard](https://unicode.org/)
- [UTF-16 on Wikipedia](https://en.wikipedia.org/wiki/UTF-16)
- [JavaScript String length](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/length)
- [Rust chars() documentation](https://doc.rust-lang.org/std/primitive.str.html#method.chars)
