use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;

#[cfg(feature = "openapi")]
use utoipa::{PartialSchema, ToSchema};

/// Represents user data with name, bio, image, links, and status.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct PubkyId {
    z32: String,
}

const ZBASE32_ALPHABET: &str = "ybndrfg8ejkmcpqxot1uwisza345h769";

#[cfg(feature = "openapi")]
impl PartialSchema for PubkyId {
    fn schema() -> utoipa::openapi::RefOr<utoipa::openapi::schema::Schema> {
        String::schema()
    }
}

#[cfg(feature = "openapi")]
impl ToSchema for PubkyId {}

impl PubkyId {
    /// Format only: 52 z-base32 chars whose 4 dangling bits are zero, so the
    /// string re-encodes to itself. Whether the bytes are a curve point is not
    /// checked here; that answer differs by target and belongs where keys are used.
    fn validate(s: &str) -> Result<(), String> {
        if s.len() != 52 {
            return Err("Validation Error: the string is not 52 ASCII characters".to_string());
        }
        // 52 chars = 260 bits = 32 bytes + 4 pad bits: the final char's index
        // must be a multiple of 16, which leaves exactly 'y' (0) and 'o' (16).
        if !s.chars().all(|c| ZBASE32_ALPHABET.contains(c))
            || !matches!(s.chars().last(), Some('y') | Some('o'))
        {
            return Err("Validation Error: invalid public key encoding".to_string());
        }
        Ok(())
    }

    pub fn try_from(s: &str) -> Result<Self, String> {
        Self::validate(s)?;
        Ok(Self { z32: s.to_string() })
    }

    /// Converts to a public key on demand. A format-valid id need not be a
    /// curve point, so this can fail; hostile input must never panic a consumer.
    #[cfg(all(feature = "sdk", not(target_arch = "wasm32")))]
    pub fn to_public_key(&self) -> Result<pubky::PublicKey, String> {
        pubky::PublicKey::try_from(self.z32.as_str()).map_err(|e| format!("Validation Error: {e}"))
    }
}

#[cfg(all(feature = "sdk", not(target_arch = "wasm32")))]
impl From<pubky::PublicKey> for PubkyId {
    fn from(pk: pubky::PublicKey) -> Self {
        Self { z32: pk.to_z32() }
    }
}

#[cfg(all(feature = "sdk", not(target_arch = "wasm32")))]
impl From<pubky::Keypair> for PubkyId {
    fn from(keypair: pubky::Keypair) -> Self {
        Self::from(keypair.public_key())
    }
}

impl fmt::Display for PubkyId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.z32)
    }
}

impl std::ops::Deref for PubkyId {
    type Target = str;

    fn deref(&self) -> &Self::Target {
        &self.z32
    }
}

impl AsRef<str> for PubkyId {
    fn as_ref(&self) -> &str {
        &self.z32
    }
}

impl Serialize for PubkyId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.z32)
    }
}

impl<'de> Deserialize<'de> for PubkyId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        PubkyId::try_from(&s).map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(all(feature = "sdk", not(target_arch = "wasm32")))]
    use pubky::Keypair;

    #[test]
    fn test_try_from_valid() {
        let valid_key = "operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo";
        let result = PubkyId::try_from(valid_key);
        assert!(result.is_ok());
        assert_eq!(result.unwrap().as_ref(), valid_key);
    }

    #[test]
    fn test_try_from_invalid_length() {
        let invalid_key = "short";
        let result = PubkyId::try_from(invalid_key);
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            "Validation Error: the string is not 52 ASCII characters"
        );
    }

    #[test]
    fn test_try_from_invalid_encoding() {
        // 52 characters but invalid z-base-32 (contains invalid char '0')
        let invalid_key = "0perrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rd0";
        let result = PubkyId::try_from(invalid_key);
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            "Validation Error: invalid public key encoding"
        );
    }

    #[test]
    #[cfg(all(feature = "sdk", not(target_arch = "wasm32")))]
    fn test_from_public_key() {
        // Create a keypair and extract the public key
        let keypair = Keypair::random();
        let public_key = keypair.public_key();
        let expected_z32 = public_key.to_z32();

        // Convert PublicKey to PubkyId
        let pubky_id = PubkyId::from(public_key);

        // Verify the PubkyId contains the correct z32 string
        assert_eq!(pubky_id.as_ref(), expected_z32);
        assert_eq!(pubky_id.to_string(), expected_z32);
    }

    #[test]
    #[cfg(all(feature = "sdk", not(target_arch = "wasm32")))]
    fn test_from_keypair() {
        // Create a keypair
        let keypair = Keypair::random();
        let expected_z32 = keypair.public_key().to_z32();

        // Convert Keypair to PubkyId
        let pubky_id = PubkyId::from(keypair);

        // Verify the PubkyId contains the correct z32 string (derived from public key)
        assert_eq!(pubky_id.as_ref(), expected_z32);
        assert_eq!(pubky_id.to_string(), expected_z32);
    }

    #[test]
    #[cfg(all(feature = "sdk", not(target_arch = "wasm32")))]
    fn test_from_public_key_produces_valid_pubky_id() {
        // Ensure the PubkyId created from PublicKey is valid (52 char z32)
        let keypair = Keypair::random();
        let public_key = keypair.public_key();
        let pubky_id = PubkyId::from(public_key);

        // The inner string should be 52 characters (valid z32 public key)
        assert_eq!(pubky_id.as_ref().len(), 52);

        // Should also work with try_from validation
        let result = PubkyId::try_from(pubky_id.as_ref());
        assert!(result.is_ok());
    }

    #[test]
    #[cfg(all(feature = "sdk", not(target_arch = "wasm32")))]
    fn test_from_keypair_produces_valid_pubky_id() {
        // Ensure the PubkyId created from Keypair is valid (52 char z32)
        let keypair = Keypair::random();
        let pubky_id = PubkyId::from(keypair);

        // The inner string should be 52 characters (valid z32 public key)
        assert_eq!(pubky_id.as_ref().len(), 52);

        // Should also work with try_from validation
        let result = PubkyId::try_from(pubky_id.as_ref());
        assert!(result.is_ok());
    }

    #[test]
    #[cfg(all(feature = "sdk", not(target_arch = "wasm32")))]
    fn test_from_keypair_and_public_key_produce_same_result() {
        // Create a keypair
        let keypair = Keypair::random();
        let public_key = keypair.public_key();

        // Store expected value before moving keypair
        let expected_z32 = public_key.to_z32();

        // Convert both to PubkyId
        let pubky_id_from_keypair = PubkyId::from(keypair);
        let pubky_id_from_public_key = PubkyId::from(public_key);

        // Both should produce the same PubkyId
        assert_eq!(pubky_id_from_keypair, pubky_id_from_public_key);
        assert_eq!(pubky_id_from_keypair.as_ref(), expected_z32);
    }

    #[test]
    #[cfg(all(feature = "sdk", not(target_arch = "wasm32")))]
    fn test_to_public_key_succeeds_for_a_real_key() {
        let keypair = Keypair::random();
        let expected_public_key = keypair.public_key();
        let pubky_id = PubkyId::from(expected_public_key.clone());

        let converted_public_key = pubky_id.to_public_key().unwrap();

        assert_eq!(converted_public_key, expected_public_key);
    }

    #[test]
    fn test_serialization() {
        let valid_key = "operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo";
        let pubky_id = PubkyId::try_from(valid_key).unwrap();

        let json = serde_json::to_string(&pubky_id).unwrap();
        // Serde serializes the inner String, so it should be a quoted JSON string
        assert_eq!(json, format!("\"{}\"", valid_key));
    }

    #[test]
    fn test_deserialization() {
        let valid_key = "operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo";
        // Deserialize from a JSON string (quoted)
        let json = format!("\"{}\"", valid_key);
        let pubky_id: PubkyId = serde_json::from_str(&json).unwrap();

        assert_eq!(pubky_id.as_ref(), valid_key);
    }

    #[test]
    fn test_deserialization_from_slice() {
        let valid_key = "operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo";
        // Deserialize from a JSON byte slice
        let json_str = format!("\"{}\"", valid_key);
        let pubky_id: PubkyId = serde_json::from_slice(json_str.as_bytes()).unwrap();

        assert_eq!(pubky_id.as_ref(), valid_key);
    }

    #[test]
    fn test_deserialization_invalid_length() {
        let json = "\"short\"";
        let result: Result<PubkyId, _> = serde_json::from_str(json);
        assert!(result.is_err());
    }

    #[test]
    fn test_deserialization_invalid_length_from_slice() {
        let json = "\"short\"";
        let result: Result<PubkyId, _> = serde_json::from_slice(json.as_bytes());
        assert!(result.is_err());
    }

    #[test]
    fn test_deserialization_invalid_encoding() {
        // 52 chars but contains invalid z-base-32 character '0'
        let json = "\"0perrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rd0\"";
        let result: Result<PubkyId, _> = serde_json::from_str(json);
        assert!(result.is_err());
    }

    #[test]
    fn test_roundtrip() {
        let valid_key = "operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo";
        let original = PubkyId::try_from(valid_key).unwrap();

        let json = serde_json::to_string(&original).unwrap();
        let deserialized: PubkyId = serde_json::from_str(&json).unwrap();

        assert_eq!(original, deserialized);
    }

    fn zbase32_oracle(s: &str) -> bool {
        base32::decode(base32::Alphabet::Z, s).map(|b| base32::encode(base32::Alphabet::Z, &b))
            == Some(s.to_string())
    }

    #[test]
    fn pubky_id_format_table() {
        let ok = "operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo";
        assert!(PubkyId::try_from(ok).is_ok());
        let flipped_last = format!("{}b", &ok[..51]);
        for bad in [
            ok.to_uppercase(),
            ok[..51].to_string(),
            format!("{ok}y"),
            format!("{}0", &ok[..51]),
            flipped_last,
        ] {
            assert!(PubkyId::try_from(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn pubky_id_validation_equals_the_reencode_oracle() {
        let ok = "operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo";
        for s in [
            ok.to_string(),
            format!("{}b", &ok[..51]),
            format!("{}o", &ok[..51]),
            ok.to_uppercase(),
            "y".repeat(52),
            "9".repeat(52),
        ] {
            let expected = s.len() == 52 && zbase32_oracle(&s);
            assert_eq!(PubkyId::try_from(&s).is_ok(), expected, "{s}");
        }
    }
}
