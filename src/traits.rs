use crate::common::{
    json_error, mint_timestamp_micros, mint_timestamp_micros_above, timestamp,
    validate_timestamp_id_format, MAX_FUTURE_MICROS,
};
use crate::limits::VALIDATION_LIMITS;
use base32::{encode, Alphabet};
use blake3::Hasher;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
#[cfg(target_arch = "wasm32")]
use tsify_next::Tsify;

/// Big-endian microseconds in Crockford base32: bytewise order is chronological order.
fn encode_timestamp_id(micros: i64) -> String {
    encode(Alphabet::Crockford, &micros.to_be_bytes())
}

pub trait TimestampId {
    /// Creates a unique identifier based on the current timestamp.
    fn create_id(&self) -> String {
        // Strictly increasing per session, so same-instant mints never share a path
        encode_timestamp_id(mint_timestamp_micros())
    }

    /// An id strictly above `floor` in bytewise order, for versions of an object whose
    /// current head may sit ahead of this clock. The floor must itself be a valid id (format
    /// and time bounds); `salt` separates clients that are all behind it, see the mint.
    fn create_id_above(&self, floor: &str, salt: u64) -> Result<String, String> {
        self.validate_id(floor)?;
        let floor = validate_timestamp_id_format(floor)?;
        Ok(encode_timestamp_id(mint_timestamp_micros_above(
            floor, salt,
        )?))
    }

    /// Validates that the provided ID is a valid Crockford Base32-encoded timestamp,
    /// 13 characters long, and represents a reasonable timestamp.
    fn validate_id(&self, id: &str) -> Result<(), String> {
        self.validate_id_at(id, timestamp())
    }

    /// [`Self::validate_id`] against a given clock, so the time bounds are testable at their
    /// edges. The id must be canonical, on or after 2024-10-01 UTC, and at most two hours
    /// ahead of `now_micros`.
    fn validate_id_at(&self, id: &str, now_micros: i64) -> Result<(), String> {
        // Canonical encoding first, then the time bounds
        let timestamp_micros = validate_timestamp_id_format(id)?;
        if timestamp_micros < MIN_TIMESTAMP_ID_MICROS {
            return Err(
                "Validation Error: Invalid ID, timestamp must be on or after October 1st, 2024"
                    .into(),
            );
        }
        if timestamp_micros > now_micros.saturating_add(MAX_FUTURE_MICROS) {
            return Err("Validation Error: Invalid ID, timestamp is too far in the future".into());
        }
        Ok(())
    }
}

/// 2024-10-01 00:00:00 UTC, the lower bound of a valid timestamp id.
const MIN_TIMESTAMP_ID_MICROS: i64 = 1_727_740_800_000_000;

/// The one content-addressed id body: blake3 over the data, the first half of the hash bytes,
/// Crockford base32. Shared with the overflow bookmark filename, which has no `HashId` impl
/// to hang it on.
pub(crate) fn hash_id_of(data: &str) -> String {
    let mut hasher = Hasher::new();
    hasher.update(data.as_bytes());
    hash_id_from(&hasher)
}

/// The id body of whatever `hasher` has been fed, for data hashed in chunks.
pub(crate) fn hash_id_from(hasher: &Hasher) -> String {
    let blake3_hash = hasher.finalize();
    let half_hash_length = blake3_hash.as_bytes().len() / 2;
    encode(
        Alphabet::Crockford,
        &blake3_hash.as_bytes()[..half_hash_length],
    )
}

/// Trait for generating an ID based on the struct's data.
pub trait HashId {
    fn get_id_data(&self) -> String;

    /// Creates a unique identifier for a content-addressed homeserver path. The identity
    /// input is the model's own (for a tag, `uri` and `label` joined by a colon); the body
    /// is [`hash_id_of`].
    fn create_id(&self) -> String {
        hash_id_of(&self.get_id_data())
    }

    /// Validates that the provided ID matches the generated ID.
    fn validate_id(&self, id: &str) -> Result<(), String> {
        let generated_id = self.create_id();
        if generated_id != id {
            return Err(format!(
                "Validation Error: Invalid ID: expected {generated_id}, found {id}"
            ));
        }
        Ok(())
    }
}

/// The storage root a path lives under. Its serde spelling is the word a parsed URI's
/// visibility uses; the path segment is [`Root::segment`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(target_arch = "wasm32", derive(Tsify))]
pub enum Root {
    #[serde(rename = "public")]
    Pub,
    #[serde(rename = "private")]
    Priv,
}

impl Root {
    pub fn segment(&self) -> &'static str {
        match self {
            Root::Pub => crate::constants::PUBLIC_ROOT,
            Root::Priv => crate::constants::PRIVATE_ROOT,
        }
    }
}

/// Validation context: the DESTINATION ROOT the object is being written under.
/// Models with reference-tier fields need it for the root rule; the rest ignore
/// it. Nothing else is ever threaded here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ValidationCtx {
    pub root: Root,
}

/// Ingest and single-root-model convenience.
pub const PUB_CTX: ValidationCtx = ValidationCtx { root: Root::Pub };

/// An alias for now, so `Err(String)` sites keep compiling; may become a
/// structured enum in a later breaking pass.
pub type ValidationError = String;

pub trait Validatable: Sized + Serialize + DeserializeOwned {
    /// Total serialized size cap. One cap on the whole object bounds the `extra` map without
    /// counting newer known fields against the extension budget; tightening it later is a break.
    const MAX_BYTES: usize = VALIDATION_LIMITS.object_max_bytes;

    /// Accepts the stored bytes as written or rejects them, never rewrites: builders trim and
    /// fold, so a reader that rewrote would disagree with the bytes on the homeserver and with
    /// any id derived from them.
    fn try_from(blob: &[u8], id: &str, ctx: &ValidationCtx) -> Result<Self, ValidationError> {
        check_size(blob.len(), Self::MAX_BYTES)?;
        let instance: Self = serde_json::from_slice(blob)
            .map_err(|e| format!("Validation Error: {}", json_error(&e)))?;
        instance.validate(Some(id), ctx)?;
        Ok(instance)
    }

    /// The cap first, then the model's own rules, so no in-memory path (builders, JSON
    /// import) can skip the cap. On the read path this re-serializes an object whose raw
    /// bytes already passed; that cost is accepted for one code path.
    fn validate(&self, id: Option<&str>, ctx: &ValidationCtx) -> Result<(), ValidationError> {
        self.validate_size()?;
        self.validate_fields(id, ctx)
    }

    /// The model's own rules, without the size cap.
    fn validate_fields(&self, id: Option<&str>, ctx: &ValidationCtx)
        -> Result<(), ValidationError>;

    fn validate_size(&self) -> Result<(), ValidationError> {
        let len = serde_json::to_vec(self).map_err(|e| e.to_string())?.len();
        check_size(len, Self::MAX_BYTES)
    }
}

fn check_size(len: usize, max: usize) -> Result<(), ValidationError> {
    if len > max {
        return Err(format!("Validation Error: object exceeds {max} bytes"));
    }
    Ok(())
}

pub trait HasPath {
    const ROOT: Root;
    const PATH_SEGMENT: &'static str;
    fn create_path() -> String;
}

pub trait HasIdPath {
    const ROOT: Root;
    const PATH_SEGMENT: &'static str;
    fn create_path(id: &str) -> String;
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Minter;
    impl TimestampId for Minter {}

    #[test]
    fn a_hash_fed_in_chunks_spells_the_id_of_the_whole() {
        let data = "a media object hashed in uneven chunks";
        for split in [0, 3, 7, data.len()] {
            let mut hasher = Hasher::new();
            hasher.update(&data.as_bytes()[..split]);
            hasher.update(&data.as_bytes()[split..]);
            assert_eq!(hash_id_from(&hasher), hash_id_of(data), "{split}");
        }
    }

    #[test]
    fn minted_ids_are_strictly_increasing_and_sort_bytewise_by_time() {
        let ids: Vec<String> = (0..10_000).map(|_| Minter.create_id()).collect();
        let micros: Vec<i64> = ids
            .iter()
            .map(|id| crate::common::validate_timestamp_id_format(id).unwrap())
            .collect();
        assert!(micros.windows(2).all(|w| w[0] < w[1]));
        assert!(ids.windows(2).all(|w| w[0] < w[1]));
        // Fixed width and uppercase mean bytewise order (the homeserver's COLLATE "C")
        // is chronological order, so a reversed LIST is newest-first.
        let mut shuffled = ids.clone();
        shuffled.reverse();
        shuffled.sort_unstable();
        assert_eq!(shuffled, ids);
    }

    fn id_at(micros: i64) -> String {
        encode_timestamp_id(micros)
    }

    #[test]
    fn validate_id_at_the_two_hour_future_edge() {
        let now = 1_758_600_000_000_000;
        assert!(Minter
            .validate_id_at(&id_at(now + MAX_FUTURE_MICROS), now)
            .is_ok());
        let err = Minter
            .validate_id_at(&id_at(now + MAX_FUTURE_MICROS + 1), now)
            .unwrap_err();
        assert_eq!(
            err,
            "Validation Error: Invalid ID, timestamp is too far in the future"
        );
    }

    #[test]
    fn validate_id_at_the_lower_bound() {
        let now = 1_758_600_000_000_000;
        assert_eq!(id_at(MIN_TIMESTAMP_ID_MICROS), "00326QR0MQG00");
        let err = Minter
            .validate_id_at(&id_at(MIN_TIMESTAMP_ID_MICROS - 1), now)
            .unwrap_err();
        assert_eq!(
            err,
            "Validation Error: Invalid ID, timestamp must be on or after October 1st, 2024"
        );
    }

    #[test]
    fn validate_id_checks_format_then_time_bounds() {
        // Exactly the lower bound, canonical: accepted.
        assert!(Minter.validate_id("00326QR0MQG00").is_ok());
        // Canonical but far in the future: format passes, the time bound rejects.
        let err = Minter.validate_id("FZZZZZZZZZZZY").unwrap_err();
        assert!(err.contains("future"), "{err}");
        // The O alias fails on format before any time check.
        let err = Minter.validate_id("O0326QR0MQG00").unwrap_err();
        assert!(err.contains("Crockford"), "{err}");
    }
}
