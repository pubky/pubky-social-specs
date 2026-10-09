//! The migrator as the npm package loads it: the one part of the JS package that is this
//! crate compiled to wasm.
//!
//! Everything else the package does it does natively, checked against this crate by the
//! surface oracle. The transforms stay here because they read 0.x objects through the frozen
//! reader, whose URL and MIME parsing no JS engine reproduces. The exports take and return
//! plain JS values and throw an `Error` carrying the crate's own message; the one class is the
//! run handle, which holds what the 0.x File objects read so far said.

use crate::constants::PROTOCOL;
use crate::migrate::{MigrationCtx, Skipped};
use crate::{ObjectKind, ParsedUri, PubkyId, PubkySocialFile, PubkySocialObject, Resource};
use serde::Serialize;
use std::fmt::Display;
use wasm_bindgen::prelude::*;

fn fail(e: impl Display) -> JsError {
    JsError::new(&e.to_string())
}

/// Through `JSON.parse`, so the result is what a reader of the stored bytes gets: own data
/// properties only. A direct serializer assigns members, and a stored `__proto__` member
/// would become the object's prototype instead of a member.
fn to_js<T: Serialize + ?Sized>(value: &T) -> Result<JsValue, JsError> {
    let json = serde_json::to_string(value).map_err(fail)?;
    js_sys::JSON::parse(&json).map_err(|_| fail("Validation Error: unreachable, JSON.parse"))
}

/// A plain object from named values, for the shapes serde cannot give (a `Uint8Array` member).
fn object_of(members: &[(&str, &JsValue)]) -> Result<JsValue, JsError> {
    let out = js_sys::Object::new();
    for (name, value) in members {
        // A setter or a read-only member planted on Object.prototype intercepts the set, by
        // throwing or by refusing; an object missing a member must not come back as a result
        match js_sys::Reflect::set(&out, &JsValue::from_str(name), value) {
            Ok(true) => {}
            _ => {
                return Err(fail(format!(
                    "Validation Error: cannot set member {name} on a plain object"
                )))
            }
        }
    }
    Ok(out.into())
}

/// Where a write goes: `path` is owner-relative and `url` the full `pubky://` URI.
#[derive(Serialize)]
struct Meta {
    id: String,
    path: String,
    url: String,
}

/// One run over an owner's 0.x tree: what the v0 File objects read so far say about names,
/// blobs and extensions. Opaque to JS; `free()` it when the run ends.
#[wasm_bindgen]
pub struct Migration {
    ctx: MigrationCtx,
}

/// A run for `owner`; feed it every path of the 0.x tree through `migrate`.
#[wasm_bindgen(js_name = createMigration)]
pub fn create_migration(owner: &str) -> Result<Migration, JsError> {
    Ok(Migration {
        ctx: MigrationCtx::new(PubkyId::try_from(owner).map_err(fail)?),
    })
}

/// A skip as the JS caller reads it: `{skip, note?}`.
fn skipped_js(skipped: &Skipped) -> Result<JsValue, JsError> {
    let mut result = serde_json::json!({ "skip": skipped.skip.as_str() });
    if let Some(note) = &skipped.note {
        result["note"] = note.clone().into();
    }
    to_js(&result)
}

/// One 0.x object by its owner-relative path or the full `pubky://` URL a LIST returns:
/// `{writes, dropped}`, each write as a reader of the stored bytes gets it plus its `meta`, or
/// `{skip}` with the category and, when the reader that refused it said why, its `note`. A
/// File object is read into the run and writes nothing, so walk `files/` first.
#[wasm_bindgen]
pub fn migrate(migration: &mut Migration, v0_path: &str, bytes: &[u8]) -> Result<JsValue, JsError> {
    let migrated = match migration.ctx.migrate(v0_path, bytes) {
        Ok(migrated) => migrated,
        Err(skipped) => return skipped_js(&skipped),
    };
    let owner = migration.ctx.owner();
    let writes = js_sys::Array::new();
    for (path, bytes) in migrated.writes {
        writes.push(&write_js(owner, &path, Some(bytes))?);
    }
    let dropped: Vec<String> = migrated.dropped.iter().map(ToString::to_string).collect();
    object_of(&[
        ("writes", &JsValue::from(writes)),
        ("dropped", &to_js(&dropped)?),
    ])
}

/// A 0.x blob by its path, its size and the media id of its bytes, which stay with the
/// caller: a blob up to the media cap copied into the wasm grows its memory for the rest of
/// the run. `{writes: [{kind: "file", meta}], dropped: []}`, the caller PUTting its own bytes
/// at `meta.url`, or `{skip}` as `migrate` gives for the same bytes.
#[wasm_bindgen(js_name = migrateBlob)]
pub fn migrate_blob(
    migration: &Migration,
    v0_path: &str,
    size: f64,
    hash: &str,
) -> Result<JsValue, JsError> {
    // A JS number: a fraction or a negative is no size; one past u64 saturates, over the cap
    if !(size >= 0.0 && size.fract() == 0.0) {
        return Err(fail(
            "Validation Error: a blob size is a non-negative integer",
        ));
    }
    let path = match migration.ctx.blob_destination(v0_path, size as u64, hash) {
        Ok(path) => path,
        Err(skipped) => return skipped_js(&skipped),
    };
    let write = write_js(migration.ctx.owner(), &path, None)?;
    object_of(&[
        ("writes", &js_sys::Array::of1(&write).into()),
        ("dropped", &js_sys::Array::new().into()),
    ])
}

/// A media id computed a chunk at a time, for bytes too large to copy into the wasm whole.
/// Opaque to JS; `hasherFinish` consumes it.
#[wasm_bindgen]
pub struct Hasher {
    inner: blake3::Hasher,
}

#[wasm_bindgen(js_name = hasherNew)]
pub fn hasher_new() -> Hasher {
    Hasher {
        inner: blake3::Hasher::new(),
    }
}

/// Feeds the next chunk; only the chunk is copied in.
#[wasm_bindgen(js_name = hasherUpdate)]
pub fn hasher_update(hasher: &mut Hasher, chunk: &[u8]) {
    hasher.inner.update(chunk);
}

/// The id of everything fed, spelled as a media path spells it.
#[wasm_bindgen(js_name = hasherFinish)]
pub fn hasher_finish(hasher: Hasher) -> String {
    crate::traits::hash_id_from(&hasher.inner)
}

fn object_js(object: &PubkySocialObject) -> Result<JsValue, JsError> {
    match object {
        PubkySocialObject::User(o) => to_js(o),
        PubkySocialObject::Post(o) => to_js(o),
        PubkySocialObject::Follow(o) => to_js(o),
        PubkySocialObject::Mute(o) => to_js(o),
        PubkySocialObject::Bookmark(o) => to_js(o),
        PubkySocialObject::Tag(o) => to_js(o),
        // Media has no JSON form, so it crosses as `{bytes}`, one copy out of wasm memory
        PubkySocialObject::File(o) => {
            object_of(&[("bytes", &js_sys::Uint8Array::from(&o.0[..]).into())])
        }
        PubkySocialObject::Feed(o) => to_js(o),
    }
}

/// A write as a reader gets it back, with where it goes, so after the PUT the engine holds
/// what a later GET would give. Media is wrapped as it is: its bytes passed the same gate in
/// the transform, and hashing them again would double the cost of a blob. Without bytes the
/// write is only where they go, for media the caller holds.
fn write_js(owner: &PubkyId, path: &str, bytes: Option<Vec<u8>>) -> Result<JsValue, JsError> {
    let url = [PROTOCOL, owner.as_ref(), "/", path].concat();
    let parsed = ParsedUri::try_from(url.as_str())
        .map_err(|_| fail("Validation Error: unreachable, the transform read this path"))?;
    let meta = to_js(&Meta {
        id: parsed.resource.id().unwrap_or_default(),
        path: format!("/{path}"),
        url: url.clone(),
    })?;
    let Some(bytes) = bytes else {
        let kind = JsValue::from_str(ObjectKind::File.wire_name());
        return object_of(&[("kind", &kind), ("meta", &meta)]);
    };
    let object = match parsed.resource {
        Resource::File(_) => PubkySocialObject::File(PubkySocialFile(bytes)),
        _ => PubkySocialObject::from_uri_owned(&url, bytes).map_err(|_| {
            fail("Validation Error: unreachable, the transform read this object back")
        })?,
    };
    object_of(&[
        ("kind", &JsValue::from_str(object.kind().wire_name())),
        ("object", &object_js(&object)?),
        ("meta", &meta),
    ])
}
