//! Remaps a crawled copy of production to fresh keys, for a replica on a testnet.
//!
//! `replay_remap --corpus <dir> --out <dir> [--salt-env REPLAY_SALT] [--manifest <file>]`
//!
//! Every user directory `<corpus>/<pk>/` gets a keypair derived from the salt and its key. The
//! references between users are rewritten under that map, the content-addressed v0 tag and
//! bookmark ids are derived again over the rewritten targets, follows and mutes are renamed,
//! and every other byte is kept. Writes `<out>/replica/<new pk>/<path>`, `map.json`,
//! `keys.json` (the secrets, never to be committed), `inventory.json` (each replica user's blobs
//! and whether the crawl fetched them, under replica keys) and `remap_report.json`. A user the crawl's
//! manifest (default `<corpus>/../manifest.json`) marks `complete: false` is remapped as far as
//! it was copied and listed under `incomplete_users`.

use ed25519_dalek::SigningKey;
use pubky_social_specs::legacy_v0::traits::{HashId, Validatable};
use pubky_social_specs::legacy_v0::{
    ParsedUri, PubkyAppBookmark, PubkyAppObject, PubkyAppTag, Resource,
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

const PK_LEN: usize = 52;
const SCHEME: &str = "pubky://";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let arg = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let (Some(corpus), Some(out)) = (arg("--corpus"), arg("--out")) else {
        eprintln!("usage: replay_remap --corpus <dir> --out <dir> [--salt-env REPLAY_SALT]");
        std::process::exit(2);
    };
    let salt_env = arg("--salt-env").unwrap_or_else(|| "REPLAY_SALT".into());
    let salt = std::env::var(&salt_env).unwrap_or_default();
    if salt.is_empty() {
        eprintln!("{salt_env} is not set: the salt keeps the replica keys underivable by others");
        std::process::exit(2);
    }
    let manifest = arg("--manifest").map_or_else(
        || Path::new(&corpus).join("..").join("manifest.json"),
        PathBuf::from,
    );
    let manifest = match read_manifest(&manifest) {
        Ok(manifest) => manifest,
        Err(e) => {
            eprintln!("replay_remap: {}: {e}", manifest.display());
            std::process::exit(1);
        }
    };
    match remap(Path::new(&corpus), Path::new(&out), &salt, &manifest) {
        Ok(report) => println!("{}", serde_json::to_string_pretty(&report).unwrap()),
        Err(e) => {
            eprintln!("replay_remap: {e}");
            std::process::exit(1);
        }
    }
}

/// What the remap takes from the crawl's manifest: the users the crawl could not copy whole,
/// and each user's blobs with whether the crawl fetched them. No manifest means neither is known.
#[derive(Default)]
struct Manifest {
    incomplete: BTreeSet<String>,
    blobs: BTreeMap<String, BTreeMap<String, bool>>,
}

fn read_manifest(manifest: &Path) -> io::Result<Manifest> {
    let bytes = match fs::read(manifest) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Manifest::default()),
        Err(e) => return Err(e),
    };
    let manifest: Value = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
    let users = manifest["users"].as_object().into_iter().flatten();
    let mut out = Manifest::default();
    for (pk, user) in users {
        if user["complete"] != Value::Bool(true) {
            out.incomplete.insert(pk.clone());
        }
        let blobs = user["blobs"].as_object().into_iter().flatten();
        out.blobs.insert(
            pk.clone(),
            blobs
                .map(|(hash, blob)| (hash.clone(), blob["fetched"] == Value::Bool(true)))
                .collect(),
        );
    }
    Ok(out)
}

/// Only the owner can read it: the file holds secrets or links replica keys to production.
#[cfg(unix)]
fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let _ = fs::remove_file(path);
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    io::Write::write_all(&mut file, bytes)
}

#[cfg(not(unix))]
fn write_private(path: &Path, _: &[u8]) -> io::Result<()> {
    Err(io::Error::other(format!(
        "{}: an owner-only file needs unix permissions",
        path.display()
    )))
}

/// The replica's secret for a production key: only a holder of the salt can derive it.
fn secret_of(salt: &str, prod_pk: &str) -> [u8; 32] {
    *blake3::hash(format!("replay:{salt}:{prod_pk}").as_bytes()).as_bytes()
}

fn public_key_of(secret: &[u8; 32]) -> String {
    let public = SigningKey::from_bytes(secret).verifying_key().to_bytes();
    base32::encode(base32::Alphabet::Z, &public)
}

#[derive(Default)]
struct Report {
    users: usize,
    objects: usize,
    bytes: u64,
    by_resource: BTreeMap<&'static str, usize>,
    rewritten_objects: usize,
    references_rewritten: usize,
    /// References to users outside the corpus, left as they are
    references_external: usize,
    references_escaped: usize,
    ids_rederived: BTreeMap<&'static str, usize>,
    /// Ids that matched no derivation in the corpus, so they are kept and stay invalid
    ids_kept: BTreeMap<&'static str, usize>,
    renamed: BTreeMap<&'static str, usize>,
    unknown_paths: BTreeMap<String, usize>,
    not_json: usize,
    envelope_noncanonical: usize,
    /// Production keys the crawl did not copy whole, remapped as far as they were copied
    incomplete_users: Vec<String>,
    /// What the frozen 0.x reader refuses in production, by kind: `<pk>/<path>: <error>`
    reader_rejects: BTreeMap<&'static str, Vec<String>>,
    verdict_changed: Vec<String>,
    residual_prod_pks: usize,
    residual_files: usize,
    written: usize,
    linked: usize,
    copied: usize,
}

impl Report {
    fn to_json(&self) -> Value {
        json!({
            "users": self.users,
            "objects": self.objects,
            "bytes": self.bytes,
            "by_resource": self.by_resource,
            "rewritten_objects": self.rewritten_objects,
            "references_rewritten": self.references_rewritten,
            "references_external": self.references_external,
            "references_escaped": self.references_escaped,
            "ids_rederived": self.ids_rederived,
            "ids_kept": self.ids_kept,
            "renamed": self.renamed,
            "unknown_paths": self.unknown_paths,
            "not_json": self.not_json,
            "envelope_noncanonical": self.envelope_noncanonical,
            "incomplete_users": self.incomplete_users,
            "reader_rejects": self.reader_rejects,
            "verdict_changed": self.verdict_changed,
            "residual_prod_pks": {
                "occurrences": self.residual_prod_pks,
                "files": self.residual_files,
            },
            "replica_files": { "written": self.written, "linked": self.linked, "copied": self.copied },
        })
    }
}

fn remap(corpus: &Path, out: &Path, salt: &str, manifest: &Manifest) -> io::Result<Value> {
    let incomplete = &manifest.incomplete;
    let mut prod_pks: Vec<String> = fs::read_dir(corpus)?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|name| pubky_social_specs::PubkyId::try_from(name).is_ok())
        .collect();
    prod_pks.sort();

    let mut map = BTreeMap::new();
    let mut keys = BTreeMap::new();
    for pk in &prod_pks {
        let secret = secret_of(salt, pk);
        let public = public_key_of(&secret);
        keys.insert(public.clone(), hex(&secret));
        map.insert(pk.clone(), public);
    }

    let replica = out.join("replica");
    if replica.exists() {
        fs::remove_dir_all(&replica)?;
    }
    let mut report = Report {
        users: prod_pks.len(),
        incomplete_users: prod_pks
            .iter()
            .filter(|pk| incomplete.contains(*pk))
            .cloned()
            .collect(),
        ..Default::default()
    };
    let remapper = Remapper { map: &map };
    for pk in &prod_pks {
        let user_dir = corpus.join(pk);
        let mut written = HashSet::new();
        for file in walk(&user_dir)? {
            let rel = relative(&user_dir, &file);
            let bytes = fs::read(&file)?;
            let (new_rel, new_bytes) = remapper.object(pk, &rel, &bytes, &mut report);
            if !written.insert(new_rel.clone()) {
                return Err(io::Error::other(format!(
                    "{pk}: two objects remap to {new_rel}"
                )));
            }
            let target = replica.join(&map[pk]).join(&new_rel);
            fs::create_dir_all(target.parent().unwrap())?;
            match new_bytes {
                Some(new_bytes) => {
                    fs::write(&target, new_bytes)?;
                    report.written += 1;
                }
                // The same bytes, so a link: it halves what the replica costs on disk
                None => {
                    if fs::hard_link(&file, &target).is_ok() {
                        report.linked += 1;
                    } else {
                        fs::copy(&file, &target)?;
                        report.copied += 1;
                    }
                }
            }
        }
    }

    fs::create_dir_all(out)?;
    let map_json: BTreeMap<&String, &String> = map.iter().collect();
    write_private(
        &out.join("map.json"),
        &serde_json::to_vec_pretty(&map_json)?,
    )?;
    write_private(&out.join("keys.json"), &serde_json::to_vec_pretty(&keys)?)?;
    // The blob inventory under replica keys, so the verifier and a CI corpus need neither the
    // map nor the production-keyed manifest
    let inventory: BTreeMap<&String, &BTreeMap<String, bool>> = prod_pks
        .iter()
        .filter_map(|pk| Some((map.get(pk)?, manifest.blobs.get(pk)?)))
        .collect();
    fs::write(
        out.join("inventory.json"),
        serde_json::to_vec_pretty(&inventory)?,
    )?;
    let report = report.to_json();
    fs::write(
        out.join("remap_report.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    Ok(report)
}

struct Remapper<'a> {
    map: &'a BTreeMap<String, String>,
}

impl Remapper<'_> {
    /// One stored object: its new owner-relative path, and its new bytes, or `None` when they
    /// are the bytes it had.
    fn object(
        &self,
        owner: &str,
        rel: &str,
        bytes: &[u8],
        report: &mut Report,
    ) -> (String, Option<Vec<u8>>) {
        report.objects += 1;
        report.bytes += bytes.len() as u64;
        let resource = ParsedUri::try_from(format!("{SCHEME}{owner}/{rel}").as_str())
            .map(|p| p.resource)
            .unwrap_or(Resource::Unknown);
        let kind = kind_of(&resource);
        *report.by_resource.entry(kind).or_default() += 1;
        if let Resource::Blob(_) = resource {
            return (rel.to_string(), None);
        }
        if let Resource::Unknown = resource {
            *report.unknown_paths.entry(path_pattern(rel)).or_default() += 1;
        }
        let verdict = PubkyAppObject::from_resource(&resource, bytes);
        let before = verdict.is_ok();
        if let (Err(e), false) = (verdict, matches!(resource, Resource::Unknown)) {
            let rejects = report.reader_rejects.entry(kind).or_default();
            rejects.push(format!("{owner}/{rel}: {e}"));
        }

        let (new_bytes, rewrote) = match serde_json::from_slice::<Value>(bytes) {
            Ok(value) => self.rewrite(&resource, &value, bytes, report),
            Err(_) => {
                report.not_json += 1;
                (bytes.to_vec(), false)
            }
        };
        if rewrote {
            report.rewritten_objects += 1;
        }

        let (new_rel, new_resource) = self.rename(rel, &resource, bytes, &new_bytes, report);
        let after = PubkyAppObject::from_resource(&new_resource, &new_bytes).is_ok();
        if before != after && !matches!(resource, Resource::Unknown) {
            report.verdict_changed.push(format!("{owner}/{rel}"));
        }
        let hits = self.residual(&new_bytes);
        if hits > 0 {
            report.residual_prod_pks += hits;
            report.residual_files += 1;
        }
        (new_rel, (new_bytes != bytes).then_some(new_bytes))
    }

    /// The object with its reference positions remapped, every other byte as it was.
    fn rewrite(
        &self,
        resource: &Resource,
        value: &Value,
        raw: &[u8],
        report: &mut Report,
    ) -> (Vec<u8>, bool) {
        // A collection and an article keep a JSON envelope inside `content`
        let envelope = match value.get("kind").and_then(Value::as_str) {
            Some(kind @ ("collection" | "long")) if matches!(resource, Resource::Post(_)) => {
                Some(kind)
            }
            _ => None,
        };
        let mut changed = false;
        let out = rewrite_strings(raw, |path, decoded, token| {
            let reference = match (resource, path) {
                (Resource::Post(_), [Seg::Key(k)]) if k == "parent" || k == "lock" => true,
                (Resource::Post(_), [Seg::Key(k), Seg::Key(u)]) => k == "embed" && u == "uri",
                (Resource::Post(_), [Seg::Key(k), Seg::Index]) => k == "attachments",
                (Resource::Post(_), [Seg::Key(k)]) if k == "content" && envelope.is_some() => {
                    let new = self.envelope_content(envelope?, decoded, token, report)?;
                    changed = true;
                    return Some(new);
                }
                (Resource::Tag(_) | Resource::Bookmark(_), [Seg::Key(k)]) => k == "uri",
                (Resource::File(_), [Seg::Key(k)]) => k == "src",
                (Resource::User, [Seg::Key(k)]) => k == "image",
                _ => false,
            };
            if !reference {
                return None;
            }
            let new = self.reference(decoded, token, report)?;
            changed = true;
            Some(new)
        });
        (out, changed)
    }

    /// The references in a post's envelope: a collection's items and cover, an article's cover.
    fn envelope_content(
        &self,
        kind: &str,
        decoded: &str,
        token: &[u8],
        report: &mut Report,
    ) -> Option<Vec<u8>> {
        serde_json::from_str::<Value>(decoded).ok()?;
        let mut changed = false;
        let inner = rewrite_strings(decoded.as_bytes(), |path, value, inner_token| {
            let reference = match path {
                [Seg::Key(k), Seg::Index] => k == "items" && kind == "collection",
                [Seg::Key(k)] => k == "cover_image",
                _ => false,
            };
            let new = reference.then(|| self.reference(value, inner_token, report))??;
            changed = true;
            Some(new)
        });
        if !changed {
            return None;
        }
        // Re-escaping the envelope keeps the bytes only when the writer escaped it canonically
        if serde_json::to_vec(decoded).ok()? != token {
            report.envelope_noncanonical += 1;
            return None;
        }
        serde_json::to_vec(&String::from_utf8(inner).ok()?).ok()
    }

    /// A `pubky://<pk>/...` reference with its key mapped, or `None` to keep it.
    fn reference(&self, decoded: &str, token: &[u8], report: &mut Report) -> Option<Vec<u8>> {
        let rest = decoded.trim().strip_prefix(SCHEME)?;
        let pk = rest.get(..PK_LEN)?;
        if !matches!(rest.as_bytes().get(PK_LEN), None | Some(b'/')) {
            return None;
        }
        let Some(new_pk) = self.map.get(pk) else {
            if pubky_social_specs::PubkyId::try_from(pk).is_ok() {
                report.references_external += 1;
            }
            return None;
        };
        // A key is z-base32, which JSON never needs to escape; one that was escaped anyway stays
        let Some(at) = find(token, pk.as_bytes()) else {
            report.references_escaped += 1;
            return None;
        };
        report.references_rewritten += 1;
        let mut new = token.to_vec();
        new[at..at + PK_LEN].copy_from_slice(new_pk.as_bytes());
        Some(new)
    }

    /// The path an object is stored at in the replica, and the resource it names there.
    fn rename(
        &self,
        rel: &str,
        resource: &Resource,
        old: &[u8],
        new: &[u8],
        report: &mut Report,
    ) -> (String, Resource) {
        let dir = |r: &str| r.rsplit_once('/').map(|(d, _)| d.to_string()).unwrap();
        match resource {
            Resource::Follow(pk) | Resource::Mute(pk) => {
                let Some(new_pk) = self.map.get(pk.as_ref()) else {
                    report.references_external += 1;
                    return (rel.to_string(), resource.clone());
                };
                let kind = kind_of(resource);
                *report.renamed.entry(kind).or_default() += 1;
                let id = pubky_social_specs::PubkyId::try_from(new_pk).unwrap();
                let renamed = if kind == "follow" {
                    Resource::Follow(id)
                } else {
                    Resource::Mute(id)
                };
                (format!("{}/{new_pk}", dir(rel)), renamed)
            }
            Resource::Tag(id) | Resource::Bookmark(id) if old != new => {
                let kind = kind_of(resource);
                let derived = derive_like(resource, id, old, new);
                let Some(new_id) = derived else {
                    *report.ids_kept.entry(kind).or_default() += 1;
                    return (rel.to_string(), resource.clone());
                };
                *report.ids_rederived.entry(kind).or_default() += 1;
                if new_id != *id {
                    *report.renamed.entry(kind).or_default() += 1;
                }
                let renamed = if kind == "tag" {
                    Resource::Tag(new_id.clone())
                } else {
                    Resource::Bookmark(new_id.clone())
                };
                (format!("{}/{new_id}", dir(rel)), renamed)
            }
            _ => (rel.to_string(), resource.clone()),
        }
    }

    /// Mapped production keys still present in the bytes, anywhere: text mentions, app files.
    fn residual(&self, bytes: &[u8]) -> usize {
        let mut hits = 0;
        let is_z32 = |b: u8| b"ybndrfg8ejkmcpqxot1uwisza345h769".contains(&b);
        let mut start = 0;
        while start < bytes.len() {
            let run = bytes[start..].iter().take_while(|&&b| is_z32(b)).count();
            if run >= PK_LEN {
                for w in bytes[start..start + run].windows(PK_LEN) {
                    if let Ok(s) = std::str::from_utf8(w) {
                        hits += usize::from(self.map.contains_key(s));
                    }
                }
            }
            start += run.max(1);
        }
        hits
    }
}

/// The id the object would carry under the new target, derived the way its old id was: the
/// frozen reader's way (sanitized, then hashed), or for a tag the writer's way over the stored
/// values. An id matching neither was invalid in production and is kept.
fn derive_like(resource: &Resource, id: &str, old: &[u8], new: &[u8]) -> Option<String> {
    let field = |raw: &[u8], key: &str| -> Option<String> {
        let value: Value = serde_json::from_slice(raw).ok()?;
        value.get(key)?.as_str().map(str::to_string)
    };
    match resource {
        Resource::Tag(_) => {
            let tag = |raw: &[u8]| -> Option<PubkyAppTag> {
                Some(PubkyAppTag {
                    uri: field(raw, "uri")?,
                    label: field(raw, "label")?,
                    created_at: 0,
                })
            };
            let (old, new) = (tag(old)?, tag(new)?);
            if old.clone().sanitize().create_id() == id {
                Some(new.sanitize().create_id())
            } else if old.create_id() == id {
                Some(new.create_id())
            } else {
                None
            }
        }
        Resource::Bookmark(_) => {
            let bookmark = |raw: &[u8]| -> Option<PubkyAppBookmark> {
                Some(PubkyAppBookmark {
                    uri: field(raw, "uri")?,
                    created_at: 0,
                })
            };
            let (old, new) = (bookmark(old)?, bookmark(new)?);
            (old.sanitize().create_id() == id).then(|| new.sanitize().create_id())
        }
        _ => None,
    }
}

fn kind_of(resource: &Resource) -> &'static str {
    match resource {
        Resource::User => "profile",
        Resource::Post(_) => "post",
        Resource::Follow(_) => "follow",
        Resource::Mute(_) => "mute",
        Resource::Bookmark(_) => "bookmark",
        Resource::Tag(_) => "tag",
        Resource::File(_) => "file",
        Resource::Blob(_) => "blob",
        Resource::Feed(_) => "feed",
        Resource::LastRead => "last_read",
        Resource::Unknown => "unknown",
    }
}

/// An unknown path with the ids folded, so the report counts kinds of paths, not paths.
fn path_pattern(rel: &str) -> String {
    rel.split('/')
        .map(|s| {
            if s.len() >= 13 && s.chars().any(|c| c.is_ascii_digit()) {
                "*"
            } else {
                s
            }
        })
        .collect::<Vec<_>>()
        .join("/")
}

#[derive(Debug, Clone, PartialEq)]
enum Seg {
    Key(String),
    Index,
}

/// Copies a JSON text, handing every string value with its path to `f`, which may replace
/// the token. Keys, numbers, whitespace and escapes pass through as they were. The input must
/// be valid JSON.
fn rewrite_strings(
    raw: &[u8],
    mut f: impl FnMut(&[Seg], &str, &[u8]) -> Option<Vec<u8>>,
) -> Vec<u8> {
    struct Frame {
        object: bool,
        key: Option<String>,
        expect_key: bool,
    }
    let mut out = Vec::with_capacity(raw.len());
    let mut stack: Vec<Frame> = Vec::new();
    let mut i = 0;
    while i < raw.len() {
        match raw[i] {
            b'"' => {
                let mut j = i + 1;
                while raw[j] != b'"' {
                    j += if raw[j] == b'\\' { 2 } else { 1 };
                }
                let token = &raw[i..=j];
                let decoded: String = serde_json::from_slice(token).unwrap_or_default();
                match stack.last_mut() {
                    Some(frame) if frame.object && frame.expect_key => {
                        frame.key = Some(decoded);
                        frame.expect_key = false;
                        out.extend_from_slice(token);
                    }
                    _ => {
                        let path: Vec<Seg> = stack
                            .iter()
                            .map(|frame| match (&frame.key, frame.object) {
                                (Some(key), true) => Seg::Key(key.clone()),
                                _ => Seg::Index,
                            })
                            .collect();
                        match f(&path, &decoded, token) {
                            Some(new) => out.extend_from_slice(&new),
                            None => out.extend_from_slice(token),
                        }
                    }
                }
                i = j + 1;
                continue;
            }
            b'{' | b'[' => stack.push(Frame {
                object: raw[i] == b'{',
                key: None,
                expect_key: raw[i] == b'{',
            }),
            b'}' | b']' => {
                stack.pop();
            }
            b',' => {
                if let Some(frame) = stack.last_mut().filter(|f| f.object) {
                    frame.expect_key = true;
                }
            }
            _ => {}
        }
        out.push(raw[i]);
        i += 1;
    }
    out
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn walk(dir: &Path) -> io::Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    let mut dirs = vec![dir.to_path_buf()];
    while let Some(d) = dirs.pop() {
        for entry in fs::read_dir(&d)? {
            let path = entry?.path();
            if path.is_dir() {
                dirs.push(path);
            } else {
                files.push(path);
            }
        }
    }
    files.sort();
    Ok(files)
}

fn relative(root: &Path, file: &Path) -> String {
    let rel = file.strip_prefix(root).unwrap();
    rel.components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use pubky_social_specs::legacy_v0::{tag_id, PubkyAppBlob};

    const SALT: &str = "test-salt";

    fn tsid(offset: u64) -> String {
        // 2025-01-01, after the frozen reader's earliest accepted id
        let micros: i64 = 1_735_689_600_000_000 + offset as i64;
        base32::encode(base32::Alphabet::Crockford, &micros.to_be_bytes())
    }

    fn pk(n: u8) -> String {
        public_key_of(&[n; 32])
    }

    fn put(root: &Path, owner: &str, rel: &str, bytes: &[u8]) {
        let path = root.join(owner).join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    fn read(root: &Path, owner: &str, rel: &str) -> Vec<u8> {
        fs::read(root.join("replica").join(owner).join(rel))
            .unwrap_or_else(|e| panic!("{owner}/{rel}: {e}"))
    }

    fn get(bytes: &[u8], key: &str) -> Value {
        serde_json::from_slice::<Value>(bytes).unwrap()[key].clone()
    }

    #[test]
    fn keys_match_the_pubky_keypair() {
        let secret = secret_of(SALT, &pk(1));
        let keypair = pubky::Keypair::from_secret(&secret);
        assert_eq!(public_key_of(&secret), keypair.public_key().z32());
    }

    #[test]
    fn remaps_a_small_corpus() {
        let dir = std::env::temp_dir().join(format!("replay_remap_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let corpus = dir.join("corpus");
        let (a, b, outsider) = (pk(1), pk(2), pk(3));
        let app = "pub/pubky.app";
        let b_post = format!("pubky://{b}/{app}/posts/{}", tsid(1));
        let outsider_post = format!("pubky://{outsider}/{app}/posts/{}", tsid(2));
        let file_tsid = tsid(3);
        let blob = b"not really a png".to_vec();
        let hash = PubkyAppBlob(blob.clone()).create_id();

        put(
            &corpus,
            &b,
            &format!("{app}/posts/{}", tsid(1)),
            br#"{"content":"hi","kind":"short","parent":null,"embed":null,"attachments":null}"#,
        );
        put(
            &corpus,
            &a,
            &format!("{app}/profile.json"),
            format!(
                r#"{{"name":"Alice","bio":null,"image":"pubky://{a}/{app}/files/{file_tsid}","links":[{{"title":"b","url":"pubky://{b}/{app}/profile.json"}}],"status":null}}"#
            )
            .as_bytes(),
        );
        // Keys out of serde's order and a text mention, both to stay as written
        let reply = format!(
            r#"{{"kind":"short", "content":"see pubky://{b}/{app}/posts/{t}","parent":"{b_post}","embed":{{"kind":"short","uri":"{outsider_post}"}},"attachments":["pubky://{a}/{app}/files/{file_tsid}"]}}"#,
            t = tsid(1)
        );
        put(
            &corpus,
            &a,
            &format!("{app}/posts/{}", tsid(10)),
            reply.as_bytes(),
        );
        let envelope =
            serde_json::to_string(&json!({"name": "faves", "items": [b_post, outsider_post]}))
                .unwrap();
        let collection = serde_json::to_vec(&json!({
            "content": envelope, "kind": "collection", "parent": null, "embed": null, "attachments": null
        }))
        .unwrap();
        put(
            &corpus,
            &a,
            &format!("{app}/posts/{}", tsid(11)),
            &collection,
        );
        let cover = format!("pubky://{a}/{app}/files/{file_tsid}");
        let article_envelope =
            serde_json::to_string(&json!({"title": "t", "body": "b", "cover_image": cover}))
                .unwrap();
        let article = serde_json::to_vec(&json!({
            "content": article_envelope, "kind": "long", "parent": null, "embed": null, "attachments": null
        }))
        .unwrap();
        put(&corpus, &a, &format!("{app}/posts/{}", tsid(12)), &article);
        let tag_old = tag_id(&b_post, "cool");
        put(
            &corpus,
            &a,
            &format!("{app}/tags/{tag_old}"),
            format!(r#"{{"uri":"{b_post}","label":"cool","created_at":1}}"#).as_bytes(),
        );
        let bookmark = PubkyAppBookmark {
            uri: b_post.clone(),
            created_at: 1,
        };
        let bookmark_old = bookmark.create_id();
        put(
            &corpus,
            &a,
            &format!("{app}/bookmarks/{bookmark_old}"),
            &serde_json::to_vec(&bookmark).unwrap(),
        );
        put(
            &corpus,
            &a,
            &format!("{app}/files/{file_tsid}"),
            format!(
                r#"{{"name":"a.png","created_at":1,"src":"pubky://{a}/{app}/blobs/{hash}","content_type":"image/png","size":16}}"#
            )
            .as_bytes(),
        );
        put(&corpus, &a, &format!("{app}/blobs/{hash}"), &blob);
        put(
            &corpus,
            &a,
            &format!("{app}/follows/{b}"),
            br#"{"created_at":1}"#,
        );
        put(
            &corpus,
            &a,
            &format!("{app}/follows/{outsider}"),
            br#"{"created_at":1}"#,
        );
        put(&corpus, &a, &format!("{app}/settings.json"), br#"{"x":1}"#);

        let out = dir.join("out");
        let incomplete = BTreeSet::from([b.clone()]);
        let manifest = Manifest {
            incomplete,
            blobs: BTreeMap::new(),
        };
        let report = remap(&corpus, &out, SALT, &manifest).unwrap();
        let map: BTreeMap<String, String> =
            serde_json::from_slice(&fs::read(out.join("map.json")).unwrap()).unwrap();
        assert_eq!(map.len(), 2);
        let (na, nb) = (&map[&a], &map[&b]);
        let nb_post = b_post.replace(&b, nb);

        assert_eq!(report["verdict_changed"], json!([]), "{report:#}");
        assert_eq!(report["reader_rejects"], json!({}), "{report:#}");
        assert_eq!(report["references_rewritten"], json!(8), "{report:#}");
        // The embed, the collection item and the follow name the user outside the corpus
        assert_eq!(report["references_external"], json!(3), "{report:#}");
        assert_eq!(
            report["unknown_paths"],
            json!({"pub/pubky.app/settings.json": 1})
        );
        assert_eq!(
            report["replica_files"],
            json!({"written": 7, "linked": 5, "copied": 0})
        );
        // The text mention and the profile link stay as written, and are counted
        assert_eq!(
            report["residual_prod_pks"]["occurrences"],
            json!(2),
            "{report:#}"
        );

        let reader = |rel: &str, resource: Resource| {
            let bytes = read(&out, na, rel);
            PubkyAppObject::from_resource(&resource, &bytes)
                .unwrap_or_else(|e| panic!("{rel}: {e}"));
            bytes
        };

        let tag_new = tag_id(&nb_post, "cool");
        assert_ne!(tag_new, tag_old);
        let tag = reader(
            &format!("{app}/tags/{tag_new}"),
            Resource::Tag(tag_new.clone()),
        );
        assert_eq!(get(&tag, "uri"), json!(nb_post));

        let bookmark_new = PubkyAppBookmark {
            uri: nb_post.clone(),
            created_at: 0,
        }
        .create_id();
        let saved = reader(
            &format!("{app}/bookmarks/{bookmark_new}"),
            Resource::Bookmark(bookmark_new.clone()),
        );
        assert_eq!(get(&saved, "uri"), json!(nb_post));

        let post = reader(
            &format!("{app}/posts/{}", tsid(10)),
            Resource::Post(tsid(10)),
        );
        let expected = reply
            .replace(
                &format!("\"parent\":\"pubky://{b}"),
                &format!("\"parent\":\"pubky://{nb}"),
            )
            .replace(&format!("[\"pubky://{a}"), &format!("[\"pubky://{na}"));
        assert_eq!(String::from_utf8(post).unwrap(), expected);

        let coll = reader(
            &format!("{app}/posts/{}", tsid(11)),
            Resource::Post(tsid(11)),
        );
        let content: Value = serde_json::from_str(get(&coll, "content").as_str().unwrap()).unwrap();
        assert_eq!(content["items"], json!([nb_post, outsider_post]));

        let article = reader(
            &format!("{app}/posts/{}", tsid(12)),
            Resource::Post(tsid(12)),
        );
        let content: Value =
            serde_json::from_str(get(&article, "content").as_str().unwrap()).unwrap();
        assert_eq!(content["cover_image"], json!(cover.replace(&a, na)));
        assert_eq!(content["body"], json!("b"));

        let file = reader(
            &format!("{app}/files/{file_tsid}"),
            Resource::File(file_tsid.clone()),
        );
        assert_eq!(
            get(&file, "src"),
            json!(format!("pubky://{na}/{app}/blobs/{hash}"))
        );
        assert_eq!(
            reader(&format!("{app}/blobs/{hash}"), Resource::Blob(hash.clone())),
            blob
        );

        let profile = reader(&format!("{app}/profile.json"), Resource::User);
        assert_eq!(
            get(&profile, "image"),
            json!(format!("pubky://{na}/{app}/files/{file_tsid}"))
        );
        assert_eq!(
            get(&profile, "links")[0]["url"],
            json!(format!("pubky://{b}/{app}/profile.json"))
        );

        let id = pubky_social_specs::PubkyId::try_from(nb.as_str()).unwrap();
        reader(&format!("{app}/follows/{nb}"), Resource::Follow(id));
        read(&out, na, &format!("{app}/follows/{outsider}"));
        read(&out, nb, &format!("{app}/posts/{}", tsid(1)));

        let keys: BTreeMap<String, String> =
            serde_json::from_slice(&fs::read(out.join("keys.json")).unwrap()).unwrap();
        assert_eq!(keys[na], hex(&secret_of(SALT, &a)));
        for private in ["keys.json", "map.json"] {
            let mode = fs::metadata(out.join(private)).unwrap().permissions();
            assert_eq!(
                std::os::unix::fs::PermissionsExt::mode(&mode) & 0o777,
                0o600,
                "{private}"
            );
        }
        assert_eq!(report["incomplete_users"], json!([b]));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rewrites_only_the_strings_asked() {
        let raw = br#"{ "a" : "x", "b":["x",{"a":"x"}], "c":1.50e1 }"#;
        let out = rewrite_strings(raw, |path, value, _| {
            (path == [Seg::Key("b".into()), Seg::Index, Seg::Key("a".into())] && value == "x")
                .then(|| b"\"y\"".to_vec())
        });
        assert_eq!(out, br#"{ "a" : "x", "b":["x",{"a":"y"}], "c":1.50e1 }"#);
    }
}
