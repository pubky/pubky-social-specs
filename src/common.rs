#[cfg(target_arch = "wasm32")]
use js_sys::Date;

use std::sync::atomic::{AtomicI64, Ordering};

/// Returns the current timestamp in microseconds since the UNIX epoch.
#[cfg(target_arch = "wasm32")]
pub fn timestamp() -> i64 {
    let ms = Date::now() as i64;
    ms * 1_000
}

#[cfg(not(target_arch = "wasm32"))]
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(not(target_arch = "wasm32"))]
pub fn timestamp() -> i64 {
    #[cfg(feature = "surface")]
    if let Some(now) = pinned::clock() {
        return now;
    }
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_micros() as i64
}

/// A clock and a mint guard a caller sets, so an answer of the surface depends on its request
/// alone and can be recorded and replayed.
#[cfg(all(feature = "surface", not(target_arch = "wasm32")))]
pub(crate) mod pinned {
    use super::{Ordering, LAST_MINTED_MICROS};
    use std::sync::atomic::AtomicI64;

    // i64::MIN stands for no pin: every real reading is positive
    static CLOCK: AtomicI64 = AtomicI64::new(i64::MIN);

    pub(crate) fn clock() -> Option<i64> {
        Some(CLOCK.load(Ordering::SeqCst)).filter(|now| *now != i64::MIN)
    }

    pub(crate) fn set(now_micros: i64, last_minted: i64) {
        CLOCK.store(now_micros, Ordering::SeqCst);
        LAST_MINTED_MICROS.store(last_minted, Ordering::SeqCst);
    }

    pub(crate) fn last_minted() -> i64 {
        LAST_MINTED_MICROS.load(Ordering::SeqCst)
    }
}

/// A JSON error as this crate words it: the parser's message without its position. A position
/// counts bytes of one spelling of the text, so it is no part of what a reader refused.
pub(crate) fn json_error(e: &serde_json::Error) -> String {
    let message = e.to_string();
    // Built from the error's own numbers rather than searched for: a message can quote text
    let position = format!(" at line {} column {}", e.line(), e.column());
    match message.strip_suffix(&position) {
        Some(stripped) => stripped.to_string(),
        None => message,
    }
}

/// The 25 code points with White_Space=Yes at Unicode 15.1. Frozen: never
/// regenerate from a newer Unicode table, because content-addressed ids
/// depend on trim. Engine notions of whitespace (`str::trim`, `\s`,
/// `String.prototype.trim`) stay off the validation surface. U+200B and
/// U+FEFF are deliberately absent (not White_Space). "ASCII control" in this
/// crate means exactly U+0000..U+001F and U+007F (`char::is_ascii_control`).
pub const FROZEN_WHITESPACE: [char; 25] = [
    '\u{0009}', '\u{000A}', '\u{000B}', '\u{000C}', '\u{000D}', '\u{0020}', '\u{0085}', '\u{00A0}',
    '\u{1680}', '\u{2000}', '\u{2001}', '\u{2002}', '\u{2003}', '\u{2004}', '\u{2005}', '\u{2006}',
    '\u{2007}', '\u{2008}', '\u{2009}', '\u{200A}', '\u{2028}', '\u{2029}', '\u{202F}', '\u{205F}',
    '\u{3000}',
];

pub fn is_frozen_whitespace(c: char) -> bool {
    FROZEN_WHITESPACE.contains(&c)
}

/// Trims leading and trailing frozen-whitespace code points. The one trim
/// allowed anywhere on the validation surface.
pub fn frozen_trim(s: &str) -> &str {
    s.trim_matches(is_frozen_whitespace)
}

/// Builder trim for optional display text. Whitespace-only means absent, so "no bio" has one
/// spelling on the wire instead of three.
pub(crate) fn trimmed_or_none(text: String) -> Option<String> {
    let trimmed = frozen_trim(&text);
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// ASCII-only lowercase fold (tag labels, MIME essences). Full-Unicode
/// lowercasing changes with Unicode versions, so it stays off this surface.
pub fn ascii_fold(s: &str) -> String {
    s.to_ascii_lowercase()
}

/// Length in Unicode code points; equals JS `[...s].length`.
pub fn code_point_len(s: &str) -> usize {
    s.chars().count()
}

/// A preserved-members map must not carry a known field name: serde would emit the key
/// twice and the reader would reject the object. Only in-process mutation can get here.
/// The two rules on an `extra` map: no key shadows a known field, and every integer inside it
/// is within the JSON-safe range, so a read-modify-write through any JSON engine, this crate's
/// or a JS caller's, carries the member back with its value intact.
pub(crate) fn check_extra(
    extra: &serde_json::Map<String, serde_json::Value>,
    known: &[&str],
) -> Result<(), String> {
    if let Some(k) = extra.keys().find(|k| known.contains(&k.as_str())) {
        return Err(format!(
            "Validation Error: extra must not shadow the field {k}"
        ));
    }
    for (k, v) in extra {
        check_safe_numbers(v).map_err(|e| format!("{e} (in extra member {k})"))?;
    }
    Ok(())
}

pub(crate) fn check_safe_numbers(v: &serde_json::Value) -> Result<(), String> {
    use serde_json::Value::*;
    match v {
        Number(n) => match (n.as_i64(), n.as_u64()) {
            (Some(i), _) => validate_safe_json_int(i),
            (None, Some(_)) => Err(format!(
                "Validation Error: integer {n} outside the JSON-safe range"
            )),
            // a float, or an integer literal every JSON engine already reads as one
            (None, None) => Ok(()),
        },
        Array(items) => items.iter().try_for_each(check_safe_numbers),
        Object(map) => map.values().try_for_each(check_safe_numbers),
        _ => Ok(()),
    }
}

const CROCKFORD_ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// An id is valid iff re-encoding its decoded bytes reproduces the input
/// byte-for-byte: every char from the canonical uppercase alphabet, and
/// every dangling (pad) bit zero. Alias spellings (`O` for `0`, lowercase)
/// would otherwise name the same object under a different homeserver key.
/// Returns the 5-bit digit of every char; callers check the pad bits on the
/// last digit and fold only what fits their value type.
fn canonical_crockford_digits(id: &str, expected_chars: usize) -> Result<Vec<u8>, String> {
    let bytes = id.as_bytes();
    if bytes.len() != expected_chars {
        return Err(format!(
            "Validation Error: Invalid ID length: must be {expected_chars} ASCII characters"
        ));
    }
    bytes
        .iter()
        .map(|&b| {
            CROCKFORD_ALPHABET
                .iter()
                .position(|&c| c == b)
                .map(|v| v as u8)
                .ok_or_else(|| "Validation Error: non-canonical Crockford character".to_string())
        })
        .collect()
}

/// TimestampId: 13 chars, 65 bits, one dangling bit that must be zero
/// (equivalently, the final char is one of `0 2 4 6 8 A C E G J M P R T W Y`).
/// Returns the decoded microseconds. Canonicality only; time bounds are the
/// caller's concern.
pub fn validate_timestamp_id_format(id: &str) -> Result<i64, String> {
    let digits = canonical_crockford_digits(id, 13)?;
    if digits[12] & 1 != 0 {
        return Err("Validation Error: non-canonical ID (dangling bit set)".into());
    }
    let acc = digits.iter().fold(0u128, |acc, &d| (acc << 5) | d as u128);
    Ok((acc >> 1) as u64 as i64)
}

/// HashId: 26 chars, 130 bits, two dangling bits that must be zero
/// (equivalently, the final char is one of `0 4 8 C G M R W`).
pub fn validate_hash_id_format(id: &str) -> Result<(), String> {
    let digits = canonical_crockford_digits(id, 26)?;
    if digits[25] & 0b11 != 0 {
        return Err("Validation Error: non-canonical ID (dangling bits set)".into());
    }
    Ok(())
}

static LAST_MINTED_MICROS: AtomicI64 = AtomicI64::new(0);

/// A clock this far behind the last mint is a correction, not a burst: a
/// burst would need a million mints to open a one second gap.
const CLOCK_ROLLBACK_TOLERANCE_MICROS: i64 = 1_000_000;

/// Strictly increasing microsecond mint for TimestampId creation. If the
/// clock has not advanced past the last issued value, issues last + 1, so a
/// burst runs ahead of the wall clock by one microsecond per mint beyond
/// the clock's rate (in the browser the clock ticks per millisecond). That
/// stays far inside the now + 2h validity bound. After a clock correction
/// (the clock lands more than one second behind the last mint) the mint
/// follows the clock instead; keeping last + 1 there would put every new id
/// beyond the now + 2h bound until wall time caught up. The guard is per
/// process, or per wasm instance; two tabs each keep their own.
/// `timestamp()` stays the raw clock for `created_at` fields.
pub fn mint_timestamp_micros() -> i64 {
    mint_from(timestamp(), &LAST_MINTED_MICROS)
}

/// Ids may sit this far ahead of the reader's clock and still validate.
pub const MAX_FUTURE_MICROS: i64 = 2 * 60 * 60 * 1_000_000;

/// How far above a floor a salted successor may land: one minute, so two clients behind the
/// same head have that much room to diverge while staying well inside the validity bound.
const SUCCESSOR_SPREAD_MICROS: i64 = 60 * 1_000_000;

/// The same mint with a floor. When the clock is past the floor this is the ordinary mint.
/// When it is not, as it is when a post was created by a faster clock or edited in the instant
/// it was created, the successor lands at `floor + 1 + (salt mod room)`: the clock cannot
/// separate two clients that are both behind the head, so the salt does, and callers derive it
/// from the bytes being written so only identical writes share a path. `room` is bounded by the
/// validity window, and a floor with no room left is an error rather than an id no reader
/// accepts. A salted successor does not move the mint guard.
pub fn mint_timestamp_micros_above(floor: i64, salt: u64) -> Result<i64, String> {
    let now = timestamp();
    if now > floor {
        return Ok(mint_from(now, &LAST_MINTED_MICROS));
    }
    let room = (now + MAX_FUTURE_MICROS)
        .checked_sub(floor)
        .and_then(|r| r.checked_sub(1))
        .filter(|r| *r > 0)
        .ok_or("Validation Error: the current version leaves no room for a newer id")?;
    let spread = room.min(SUCCESSOR_SPREAD_MICROS) as u64;
    // Returned as it is, past the guard: the guard keeps two mints of one instant apart, and a
    // successor is told apart by its salt. Moving the guard up to it would put the guard ahead
    // of the clock, the next plain mint would read that as a clock correction and issue the
    // raw clock again, which an earlier mint of the same instant already holds.
    Ok(floor + 1 + (salt % spread) as i64)
}

fn mint_from(now: i64, last_minted: &AtomicI64) -> i64 {
    let bump = |last: i64| {
        if now > last || last - now > CLOCK_ROLLBACK_TOLERANCE_MICROS {
            now
        } else {
            last + 1
        }
    };
    // A compare-exchange loop rather than the standard helper, whose name moves between
    // toolchains while this crate holds an MSRV
    let mut last = last_minted.load(Ordering::SeqCst);
    loop {
        let next = bump(last);
        match last_minted.compare_exchange(last, next, Ordering::SeqCst, Ordering::SeqCst) {
            Ok(_) => return next,
            Err(seen) => last = seen,
        }
    }
}

/// 2^53 - 1: the largest integer JSON round-trips identically through a JS
/// caller. Every i64 wire integer must satisfy |v| <= this.
pub const MAX_SAFE_JSON_INT: i64 = 9_007_199_254_740_991;

pub fn validate_safe_json_int(v: i64) -> Result<(), String> {
    if !(-MAX_SAFE_JSON_INT..=MAX_SAFE_JSON_INT).contains(&v) {
        return Err(format!(
            "Validation Error: integer {v} outside the JSON-safe range"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base32::{decode, encode, Alphabet};

    #[test]
    fn extra_rejects_shadowing_and_unsafe_integers() {
        let ok: serde_json::Map<String, serde_json::Value> = serde_json::from_str(
            r#"{"ext":{"n":9007199254740991,"neg":-9007199254740991,"f":1.5,"big":1e30,"l":[1,{"x":2}]}}"#,
        )
        .unwrap();
        assert!(check_extra(&ok, &["name"]).is_ok());
        let shadow: serde_json::Map<_, _> = serde_json::from_str(r#"{"name":1}"#).unwrap();
        assert!(check_extra(&shadow, &["name"])
            .unwrap_err()
            .contains("shadow"));
        for bad in [
            r#"{"n":9007199254740992}"#,
            r#"{"n":-9007199254740992}"#,
            r#"{"n":18446744073709551615}"#,
            r#"{"deep":[{"n":9007199254740992}]}"#,
        ] {
            let m: serde_json::Map<_, _> = serde_json::from_str(bad).unwrap();
            let e = check_extra(&m, &[]).unwrap_err();
            assert!(
                e.contains("JSON-safe") && e.contains("extra member"),
                "{bad}: {e}"
            );
        }
    }

    const TS_LOWER_BOUND: i64 = 1727740800000000;

    fn crockford_oracle(id: &str) -> bool {
        decode(Alphabet::Crockford, id).map(|b| encode(Alphabet::Crockford, &b))
            == Some(id.to_string())
    }

    #[test]
    fn timestamp_id_kats() {
        assert_eq!(validate_timestamp_id_format("FZZZZZZZZZZZY"), Ok(i64::MAX));
        assert_eq!(
            encode(Alphabet::Crockford, &i64::MAX.to_be_bytes()),
            "FZZZZZZZZZZZY"
        );
        assert_eq!(
            encode(Alphabet::Crockford, &TS_LOWER_BOUND.to_be_bytes()),
            "00326QR0MQG00"
        );
        assert_eq!(
            validate_timestamp_id_format("00326QR0MQG00"),
            Ok(TS_LOWER_BOUND)
        );
        // The O alias still decodes under the crate's decoder; canonical validation rejects it.
        assert!(decode(Alphabet::Crockford, "O0326QR0MQG00").is_some());
        assert!(validate_timestamp_id_format("O0326QR0MQG00").is_err());
    }

    #[test]
    fn timestamp_id_validation_equals_the_reencode_oracle() {
        for id in [
            "0032SSN7Q4EVG",
            "0034A0X7NJ52G",
            "00326QR0MQG00",
            "FZZZZZZZZZZZY",
            "0032ssn7q4evg",
            "O032SSN7Q4EVG",
            "I032SSN7Q4EVG",
            "L032SSN7Q4EVG",
            "U032SSN7Q4EVG",
            "0000000000001",
            "0000000000002",
            "000000000000",
            "00000000000000",
            "",
            "0032SSN7Q4EV",
            "0032SSN7Q4EVG0",
        ] {
            let expected = id.len() == 13 && crockford_oracle(id);
            assert_eq!(validate_timestamp_id_format(id).is_ok(), expected, "{id:?}");
        }
    }

    #[test]
    fn hash_id_validation_equals_the_reencode_oracle() {
        for id in [
            "PZBQ010FF079VVZPQG1RNFN6DR",
            "8Z8CWH8NVYQY39ZEBFGKQWWEKG",
            "00000000000000000000000000",
            "0000000000000000000000000Z",
            "0000000000000000000000001",
            "000000000000000000000000000",
            "pzbq010ff079vvzpqg1rnfn6dr",
            "",
        ] {
            let expected = id.len() == 26 && crockford_oracle(id);
            assert_eq!(validate_hash_id_format(id).is_ok(), expected, "{id:?}");
        }
    }

    #[test]
    fn frozen_trim_strips_exactly_the_table() {
        for c in FROZEN_WHITESPACE {
            assert_eq!(frozen_trim(&format!("{c}a{c}")), "a", "{:?}", c as u32);
        }
        assert_eq!(frozen_trim("\u{200B}a\u{FEFF}"), "\u{200B}a\u{FEFF}");
        assert_eq!(frozen_trim("\u{3000}a\u{00A0}"), "a");
        assert_eq!(frozen_trim(" a b "), "a b");
        assert_eq!(FROZEN_WHITESPACE.len(), 25);
        let mut sorted = FROZEN_WHITESPACE;
        sorted.sort_unstable();
        assert_eq!(sorted, FROZEN_WHITESPACE, "table is ascending");
    }

    #[test]
    fn text_ops_are_ascii_and_code_point_based() {
        assert_eq!(ascii_fold("İX"), "İx");
        assert_eq!(ascii_fold("RUST"), "rust");
        assert_eq!(code_point_len("a👍"), 2);
    }

    #[test]
    fn safe_json_int_bounds() {
        assert!(validate_safe_json_int(MAX_SAFE_JSON_INT).is_ok());
        assert!(validate_safe_json_int(-MAX_SAFE_JSON_INT).is_ok());
        assert!(validate_safe_json_int(MAX_SAFE_JSON_INT + 1).is_err());
        assert!(validate_safe_json_int(i64::MIN).is_err());
    }

    #[test]
    fn mint_follows_a_deterministic_clock() {
        let last = AtomicI64::new(0);
        let clock = [100, 100, 50, 50, 200, 199, 201];
        let minted: Vec<i64> = clock.iter().map(|&now| mint_from(now, &last)).collect();
        assert_eq!(minted, [100, 101, 102, 103, 200, 201, 202]);
    }

    #[test]
    fn mint_follows_the_clock_after_a_correction() {
        let last = AtomicI64::new(5_000_000);
        assert_eq!(mint_from(1_000_000, &last), 1_000_000);
        assert_eq!(mint_from(1_000_000, &last), 1_000_001);
        // A gap inside the tolerance is still treated as a burst.
        let last = AtomicI64::new(1_500_000);
        assert_eq!(mint_from(1_000_000, &last), 1_500_001);
    }

    #[test]
    fn mint_is_strictly_increasing() {
        let mut last = 0;
        for _ in 0..10_000 {
            let t = mint_timestamp_micros();
            assert!(t > last);
            last = t;
        }
    }
}
