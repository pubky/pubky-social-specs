//! The replay's oracle: what migrating each replica user has to leave on the testnet, derived
//! from the replica on disk with the transforms alone, checked against what the testnet holds.
//!
//! `replay_verify --data <dir> [--reports <dir>] [--actual <dir>] [--out <dir>] [--only <pk>]...
//! [--resumed] [--sample <n>] [--compare-reports <dir> --compare-actual <dir>]`
//!
//! For every user of `<data>/replica/`, the engine's walk is replayed over the v0 tree: the
//! passes in the engine's order, File objects first into a [`MigrationCtx`], every other object
//! through it, a write folding onto a key an earlier object claimed counting `already_present`.
//! That gives the v1 objects a run must write, the skips it must count and the flag it must
//! leave. The testnet's side is `<actual>/<pk>.ndjson` (default `<data>/actual`), both roots as
//! `run.mjs` dumped them, and the CLI's report is `<reports>/<pk>.json` (default
//! `<data>/reports`); a browser pass keeps its own of both, in the same shapes. A dump or a
//! report of another seed than `<data>/seed-state.json` names counts as absent. Report counts
//! must equal the oracle's, unless `--resumed`: a run that found an earlier run's copies counts
//! them `already_present`, so only `written` plus `already_present` is fixed. Writes
//! `<out>/<pk>.json` and `<out>/summary.json` (default `<data>/verify`), and exits 1 on any
//! mismatch. `--sample <n>` also writes up to n v0 objects per pass beside the v1 objects they
//! become to `<out>/sample/`, for a reading by hand. `--compare-reports` and `--compare-actual`
//! name another run of the same users from nothing, Node's when this one is a browser's: its
//! report must equal this one, and its tree this one byte for byte but the flag's time.

use pubky_social_specs::legacy_v0::{ParsedUri, PubkyAppObject, Resource};
use pubky_social_specs::migrate::{MigrationCtx, Skip, TRANSFORM_REV};
use pubky_social_specs::{stable_id, PubkyId, PubkySocialObject, StableId};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

const LEGACY: &str = "pub/pubky.app/";
const V1_ROOTS: [&str; 2] = ["pub/social/v1/", "priv/social/v1/"];
const MEDIA: &str = "pub/social/v1/files/";
const FLAG: &str = "priv/social/v1/_migrated.json";
/// The engine's passes, in its walk order.
const BUCKETS: [&str; 9] = [
    "files",
    "blobs",
    "posts",
    "tags",
    "follows",
    "profile",
    "feeds",
    "bookmarks",
    "mutes",
];
/// What two runs of one user from nothing report alike, on any host.
const REPORT_KEYS: [&str; 10] = [
    "status",
    "mode",
    "done",
    "total",
    "counts",
    "dropped",
    "droppedValues",
    "skipped",
    "notes",
    "error",
];
/// Outcomes a run counts besides the transforms' own skips.
const RUN_OUTCOMES: [&str; 5] = [
    "written",
    "already_present",
    "deleted_mid_run",
    "io_error",
    "put_rejected",
];
/// Skips that real v0 data should never produce, each one read by hand.
const FINDINGS: [&str; 4] = ["invalid", "malformed", "shape", "unsafe_integer"];
const PAGE: u64 = 1000;

/// The owner-relative paths and bytes an object is written as.
type Writes = Vec<(String, Vec<u8>)>;

/// Per replica key, the blobs the crawl listed in production: hash to whether it fetched them.
type BlobIndex = BTreeMap<String, BTreeMap<String, bool>>;

struct Options {
    reports: PathBuf,
    actual: PathBuf,
    out: PathBuf,
    /// Another run's reports and dumps.
    compare: Option<(PathBuf, PathBuf)>,
    only: BTreeSet<String>,
    resumed: bool,
    sample: usize,
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let arg = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let Some(data) = arg("--data").map(PathBuf::from) else {
        eprintln!(
            "usage: replay_verify --data <dir> [--reports <dir>] [--actual <dir>] [--out <dir>] \
             [--only <pk>]... [--resumed] [--sample <n>] \
             [--compare-reports <dir> --compare-actual <dir>]"
        );
        std::process::exit(2);
    };
    let compare = match (arg("--compare-reports"), arg("--compare-actual")) {
        (Some(reports), Some(actual)) => Some((PathBuf::from(reports), PathBuf::from(actual))),
        (None, None) => None,
        _ => {
            eprintln!("replay_verify: --compare-reports and --compare-actual go together");
            std::process::exit(2);
        }
    };
    let options = Options {
        reports: arg("--reports").map_or_else(|| data.join("reports"), PathBuf::from),
        actual: arg("--actual").map_or_else(|| data.join("actual"), PathBuf::from),
        compare,
        out: arg("--out").map_or_else(|| data.join("verify"), PathBuf::from),
        only: args
            .windows(2)
            .filter(|w| w[0] == "--only")
            .map(|w| w[1].clone())
            .collect(),
        resumed: args.iter().any(|a| a == "--resumed"),
        sample: arg("--sample").map_or(0, |n| n.parse().unwrap_or(0)),
    };
    match run(&data, &options) {
        Ok(summary) => {
            println!("{}", serde_json::to_string_pretty(&summary).unwrap());
            if summary["mismatched_users"].as_u64() != Some(0) {
                std::process::exit(1);
            }
        }
        Err(e) => {
            eprintln!("replay_verify: {e}");
            std::process::exit(2);
        }
    }
}

fn read_json(file: &Path) -> io::Result<Value> {
    serde_json::from_slice(&fs::read(file)?).map_err(io::Error::other)
}

/// The blobs of the crawl's manifest, under the replica keys the remap gave their owners.
fn blob_index(data: &Path) -> io::Result<BlobIndex> {
    let map = read_json(&data.join("map.json"))?;
    let manifest = read_json(&data.join("manifest.json"))?;
    let mut index = BlobIndex::new();
    for (prod, user) in manifest["users"].as_object().into_iter().flatten() {
        let Some(replica) = map[prod].as_str() else {
            continue;
        };
        let blobs = user["blobs"].as_object().into_iter().flatten();
        index.insert(
            replica.to_string(),
            blobs
                .map(|(hash, blob)| (hash.clone(), blob["fetched"] == Value::Bool(true)))
                .collect(),
        );
    }
    Ok(index)
}

fn run(data: &Path, options: &Options) -> io::Result<Value> {
    let epoch = read_json(&data.join("seed-state.json"))?["epoch"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| io::Error::other("seed-state.json names no seed epoch"))?;
    let blobs = blob_index(data)?;
    fs::create_dir_all(&options.out)?;
    let mut users: Vec<String> = fs::read_dir(data.join("replica"))?
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|pk| options.only.is_empty() || options.only.contains(pk))
        .collect();
    users.sort();
    let mut summary = Summary::default();
    let mut sampler = Sampler::new(options.sample);
    for (i, pk) in users.iter().enumerate() {
        let tree = read_tree(&data.join("replica").join(pk))?;
        let actual = read_actual(&options.actual.join(format!("{pk}.ndjson")), &epoch)?;
        let report = read_report(&options.reports.join(format!("{pk}.json")), &epoch)?;
        let mut verdict = verify_user(
            pk,
            &tree,
            actual.as_ref(),
            report.as_ref(),
            blobs.get(pk),
            options.resumed,
        );
        if let Some((reports, dumps)) = &options.compare {
            let other_report = read_report(&reports.join(format!("{pk}.json")), &epoch)?;
            let other_actual = read_actual(&dumps.join(format!("{pk}.ndjson")), &epoch)?;
            compare_runs(
                (report.as_ref(), actual.as_ref()),
                (other_report.as_ref(), other_actual.as_ref()),
                &mut verdict,
            );
        }
        fs::write(
            options.out.join(format!("{pk}.json")),
            serde_json::to_vec_pretty(&verdict.to_json(pk)).unwrap(),
        )?;
        summary.add(pk, &verdict);
        sampler.offer(pk, &tree, &verdict.expected);
        if (i + 1) % 100 == 0 {
            eprintln!("{} users verified", i + 1);
        }
    }
    sampler.write(&options.out.join("sample"))?;
    let summary = summary.to_json();
    fs::write(
        options.out.join("summary.json"),
        serde_json::to_vec_pretty(&summary).unwrap(),
    )?;
    Ok(summary)
}

/// The v0 tree under a replica user's directory: owner-relative path to bytes.
fn read_tree(dir: &Path) -> io::Result<BTreeMap<String, Vec<u8>>> {
    let mut tree = BTreeMap::new();
    let mut dirs = vec![dir.to_path_buf()];
    while let Some(d) = dirs.pop() {
        for entry in fs::read_dir(&d)? {
            let path = entry?.path();
            if path.is_dir() {
                dirs.push(path);
            } else {
                let rel = path.strip_prefix(dir).unwrap();
                let rel = rel
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy())
                    .collect::<Vec<_>>()
                    .join("/");
                tree.insert(rel, fs::read(&path)?);
            }
        }
    }
    Ok(tree)
}

/// One object the testnet holds, as `run.mjs` dumped it.
#[derive(Debug, Clone, PartialEq)]
struct Row {
    blake3: String,
    size: u64,
    text: Option<String>,
}

/// The dump of the user's tree, when it is of this seed: its first line names the seed.
fn read_actual(file: &Path, epoch: &str) -> io::Result<Option<BTreeMap<String, Row>>> {
    let text = match fs::read_to_string(file) {
        Ok(text) => text,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let mut lines = text.lines().filter(|l| !l.is_empty());
    let header: Value = serde_json::from_str(lines.next().unwrap_or("{}")).unwrap_or_default();
    if header["seed_epoch"].as_str() != Some(epoch) {
        return Ok(None);
    }
    let mut rows = BTreeMap::new();
    for line in lines {
        let row: Value = serde_json::from_str(line).map_err(io::Error::other)?;
        rows.insert(
            row["path"].as_str().unwrap_or_default().to_string(),
            Row {
                blake3: row["blake3"].as_str().unwrap_or_default().to_string(),
                size: row["size"].as_u64().unwrap_or_default(),
                text: row["text"].as_str().map(str::to_string),
            },
        );
    }
    Ok(Some(rows))
}

/// The CLI's report out of the record `run.mjs` keeps for the user, when it is of this seed.
fn read_report(file: &Path, epoch: &str) -> io::Result<Option<Value>> {
    match fs::read(file) {
        Ok(bytes) => {
            let record: Value = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
            if record["seedEpoch"].as_str() != Some(epoch) {
                return Ok(None);
            }
            Ok(Some(record["report"].clone()).filter(|r| !r.is_null()))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// The engine's pass for an owner-relative path, `None` for one it counts `not_migrated`
/// without reading.
fn bucket(path: &str) -> Option<&'static str> {
    let rel = path.strip_prefix(LEGACY)?;
    if rel == "profile.json" {
        return Some("profile");
    }
    let slash = rel.find('/')?;
    if slash == 0 || slash == rel.len() - 1 {
        return None;
    }
    let segment = &rel[..slash];
    BUCKETS
        .iter()
        .find(|b| **b == segment && **b != "profile")
        .copied()
}

fn key_of(path: &str) -> String {
    match stable_id(path) {
        Some(StableId::Key(key)) => key,
        _ => path.to_string(),
    }
}

/// Media is present by its exact path; anything else by its key across both roots.
fn claim_key(path: &str) -> String {
    if path.starts_with(MEDIA) {
        path.to_string()
    } else {
        key_of(path)
    }
}

/// What a whole run over an empty v1 tree has to write and count.
#[derive(Debug, Default)]
struct Expected {
    /// Path to the bytes each object folding onto it would write, in walk order: the engine
    /// keeps two objects in flight, so either one of a fold may land.
    writes: BTreeMap<String, Vec<Vec<u8>>>,
    skipped: BTreeMap<String, BTreeSet<String>>,
    counts: BTreeMap<String, u64>,
    dropped: u64,
    total: u64,
    /// Bytes of the v0 objects the walk reads.
    read_bytes: u64,
    /// Every v0 object the transforms took: a File read into the run, or an object that gave
    /// writes, with those writes.
    consumed: Vec<(String, Writes)>,
}

fn expect(owner: &PubkyId, tree: &BTreeMap<String, Vec<u8>>) -> Expected {
    let mut expected = Expected {
        counts: Skip::ALL
            .iter()
            .map(|s| s.as_str())
            .chain(RUN_OUTCOMES)
            .map(|o| (o.to_string(), 0))
            .collect(),
        ..Expected::default()
    };
    let legacy: Vec<(&String, &Vec<u8>)> =
        tree.iter().filter(|(p, _)| p.starts_with(LEGACY)).collect();
    expected.total = legacy.len() as u64;
    let count = |expected: &mut Expected, outcome: &str, path: &str| {
        *expected.counts.get_mut(outcome).unwrap() += 1;
        if outcome != "written" && outcome != "already_present" {
            expected
                .skipped
                .entry(outcome.to_string())
                .or_default()
                .insert(path.to_string());
        }
    };

    let mut ctx = MigrationCtx::new(owner.clone());
    let mut claims = BTreeSet::new();
    for pass in BUCKETS {
        for (path, bytes) in legacy.iter().filter(|(p, _)| bucket(p) == Some(pass)) {
            if pass != "files" && pass != "blobs" && claims.contains(&key_of(path)) {
                count(&mut expected, "already_present", path);
                continue;
            }
            expected.read_bytes += bytes.len() as u64;
            let migrated = match ctx.migrate(path, bytes) {
                Ok(migrated) => migrated,
                Err(skip) => {
                    count(&mut expected, skip.skip.as_str(), path);
                    continue;
                }
            };
            expected
                .consumed
                .push(((*path).clone(), migrated.writes.clone()));
            if pass == "files" {
                continue;
            }
            let mut claimed = false;
            for (to, out) in &migrated.writes {
                if claims.insert(claim_key(to)) {
                    claimed = true;
                    expected.writes.insert(to.clone(), vec![out.clone()]);
                } else if let Some(candidates) = expected.writes.get_mut(to) {
                    candidates.push(out.clone());
                }
            }
            if claimed {
                expected.dropped += migrated.dropped.len() as u64;
                count(&mut expected, "written", path);
            } else {
                count(&mut expected, "already_present", path);
            }
        }
    }
    for (path, _) in legacy.iter().filter(|(p, _)| bucket(p).is_none()) {
        count(&mut expected, "not_migrated", path);
    }
    expected
}

fn member<'a>(object: &'a Map<String, Value>, key: &str) -> &'a Value {
    object.get(key).unwrap_or(&Value::Null)
}

/// Deep equality where an absent member equals a `null` one.
fn semantic_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Object(a), Value::Object(b)) => a
            .keys()
            .chain(b.keys())
            .all(|k| semantic_eq(member(a, k), member(b, k))),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| semantic_eq(a, b))
        }
        (a, b) => a == b,
    }
}

fn blake3_hex(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

/// Whether the object the testnet holds is one of the candidates: media by its bytes, JSON by
/// its meaning.
fn matches(row: &Row, candidates: &[Vec<u8>], media: bool) -> bool {
    candidates.iter().any(|want| {
        if media {
            return row.blake3 == blake3_hex(want);
        }
        let (Some(text), Ok(want)) = (&row.text, serde_json::from_slice::<Value>(want)) else {
            return row.blake3 == blake3_hex(want);
        };
        serde_json::from_str::<Value>(text).is_ok_and(|got| semantic_eq(&got, &want))
    })
}

/// Why a media reference dangles.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Dangling {
    /// Production holds the blob; the crawl did not sample its bytes.
    NotSampled,
    /// Production listed no such blob for the owner.
    AbsentInProduction,
}

impl Dangling {
    fn as_str(self) -> &'static str {
        match self {
            Dangling::NotSampled => "not_sampled",
            Dangling::AbsentInProduction => "absent_in_production",
        }
    }
}

#[derive(Debug, Default)]
struct Verdict {
    expected: Expected,
    mismatches: Vec<(&'static str, String, String)>,
    /// Media references the expected objects hold whose media the run does not write.
    dangling: BTreeMap<String, Dangling>,
    /// (category, group, path, error) for every skip real data should not produce.
    findings: Vec<(String, String, String, String)>,
    /// (group, path, error) for every object the transforms took that the 0.x reader refuses.
    reverse: Vec<(String, String, String)>,
    report_status: Option<String>,
    report_counts: BTreeMap<String, u64>,
    v1_objects: u64,
    v1_bytes: u64,
}

impl Verdict {
    fn mismatch(&mut self, kind: &'static str, path: &str, detail: impl Into<String>) {
        self.mismatches
            .push((kind, path.to_string(), detail.into()));
    }

    fn to_json(&self, pk: &str) -> Value {
        json!({
            "pk": pk,
            "ok": self.mismatches.is_empty(),
            "report_status": self.report_status,
            "expected": {
                "counts": self.expected.counts,
                "writes": self.expected.writes.len(),
                "dropped": self.expected.dropped,
                "total": self.expected.total,
                "skipped": self.expected.skipped,
            },
            "report_counts": self.report_counts,
            "actual": { "v1_objects": self.v1_objects, "v1_bytes": self.v1_bytes },
            "mismatches": self.mismatches.iter().map(|(kind, path, detail)| {
                json!({ "kind": kind, "path": path, "detail": detail })
            }).collect::<Vec<_>>(),
            "dangling_media": self.dangling.iter().map(|(path, why)| {
                json!({ "path": path, "why": why.as_str() })
            }).collect::<Vec<_>>(),
            "findings": self.findings.iter().map(|(category, group, path, error)| {
                json!({ "category": category, "group": group, "path": path, "error": error })
            }).collect::<Vec<_>>(),
            "migrated_though_refused": self.reverse.iter().map(|(group, path, error)| {
                json!({ "group": group, "path": path, "error": error })
            }).collect::<Vec<_>>(),
        })
    }
}

fn verify_user(
    pk: &str,
    tree: &BTreeMap<String, Vec<u8>>,
    actual: Option<&BTreeMap<String, Row>>,
    report: Option<&Value>,
    blobs: Option<&BTreeMap<String, bool>>,
    resumed: bool,
) -> Verdict {
    let mut verdict = Verdict::default();
    let owner = match PubkyId::try_from(pk) {
        Ok(owner) => owner,
        Err(e) => {
            verdict.mismatch("owner", pk, e);
            return verdict;
        }
    };
    verdict.expected = expect(&owner, tree);
    findings(&owner, tree, &mut verdict);
    dangling(pk, blobs, &mut verdict);
    match actual {
        Some(actual) => compare_tree(pk, tree, actual, &mut verdict),
        None => verdict.mismatch("actual", pk, "no dump of the testnet's tree for this seed"),
    }
    compare_report(report, resumed, &mut verdict);
    verdict
}

fn compare_tree(
    pk: &str,
    tree: &BTreeMap<String, Vec<u8>>,
    actual: &BTreeMap<String, Row>,
    verdict: &mut Verdict,
) {
    for (path, row) in actual {
        if path.starts_with(LEGACY) {
            match tree.get(path) {
                None => verdict.mismatch("v0_extra", path, "on the testnet, not in the replica"),
                Some(bytes) if blake3_hex(bytes) != row.blake3 => {
                    verdict.mismatch("v0_changed", path, "bytes differ from the replica")
                }
                Some(_) => {}
            }
            continue;
        }
        if !V1_ROOTS.iter().any(|root| path.starts_with(root)) {
            verdict.mismatch("foreign", path, "outside the v0 tree and the v1 roots");
            continue;
        }
        verdict.v1_objects += 1;
        verdict.v1_bytes += row.size;
        if path == FLAG {
            continue;
        }
        // Media has no text in the dump; its hash is compared below with bytes the transform
        // already read back through the v1 reader
        if let Some(text) = &row.text {
            let uri = format!("pubky://{pk}/{path}");
            if let Err(e) = PubkySocialObject::from_uri(&uri, text.as_bytes()) {
                verdict.mismatch("reader", path, e);
            }
        }
        match verdict.expected.writes.get(path) {
            None => verdict.mismatch("unexpected", path, "no v0 object migrates to it"),
            Some(candidates) if !matches(row, candidates, path.starts_with(MEDIA)) => {
                let detail = row.text.clone().unwrap_or_else(|| row.blake3.clone());
                verdict.mismatch("content", path, detail);
            }
            Some(_) => {}
        }
    }
    let missing: Vec<String> = tree
        .keys()
        .filter(|p| p.starts_with(LEGACY) && !actual.contains_key(*p))
        .cloned()
        .collect();
    for path in missing {
        verdict.mismatch("v0_missing", &path, "in the replica, not on the testnet");
    }
    let missing: Vec<String> = verdict
        .expected
        .writes
        .keys()
        .filter(|p| !actual.contains_key(*p))
        .cloned()
        .collect();
    for path in missing {
        verdict.mismatch("missing", &path, "expected, not on the testnet");
    }
    compare_flag(actual.get(FLAG), verdict);
}

fn compare_flag(flag: Option<&Row>, verdict: &mut Verdict) {
    let Some(flag) = flag else {
        verdict.mismatch("flag", FLAG, "absent");
        return;
    };
    let Some(flag) = flag
        .text
        .as_deref()
        .and_then(|t| serde_json::from_str::<Value>(t).ok())
    else {
        verdict.mismatch("flag", FLAG, "not JSON");
        return;
    };
    if flag["transform_rev"].as_u64() != Some(TRANSFORM_REV.into()) {
        verdict.mismatch(
            "flag",
            FLAG,
            format!("transform_rev {}", flag["transform_rev"]),
        );
    }
    if let Some(detail) = skipped_differ(&flag["skipped"], &verdict.expected.skipped) {
        verdict.mismatch("flag", FLAG, detail);
    }
    if flag["migrated_at"].as_u64().is_none() {
        verdict.mismatch("flag", FLAG, "migrated_at is not an integer");
    }
}

/// How a `skipped` map a run wrote differs from the expected one, compared as sets.
fn skipped_differ(got: &Value, want: &BTreeMap<String, BTreeSet<String>>) -> Option<String> {
    let mut got_sets: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for (outcome, paths) in got.as_object().into_iter().flatten() {
        let set: BTreeSet<String> = paths
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|p| p.as_str().map(str::to_string))
            .collect();
        if !set.is_empty() {
            got_sets.insert(outcome.clone(), set);
        }
    }
    let mut differences = Vec::new();
    for outcome in got_sets.keys().chain(want.keys()).collect::<BTreeSet<_>>() {
        let empty = BTreeSet::new();
        let (g, w) = (
            got_sets.get(outcome).unwrap_or(&empty),
            want.get(outcome).unwrap_or(&empty),
        );
        let extra: Vec<&String> = g.difference(w).take(3).collect();
        let missing: Vec<&String> = w.difference(g).take(3).collect();
        if !extra.is_empty() || !missing.is_empty() {
            differences.push(format!(
                "{outcome}: {} vs {} expected, extra {extra:?}, missing {missing:?}",
                g.len(),
                w.len()
            ));
        }
    }
    (!differences.is_empty()).then(|| differences.join("; "))
}

fn compare_report(report: Option<&Value>, resumed: bool, verdict: &mut Verdict) {
    let Some(report) = report else {
        verdict.mismatch("report", "", "no report of this seed");
        return;
    };
    let status = report["status"].as_str().unwrap_or_default().to_string();
    verdict.report_counts = report["counts"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(k, v)| (k.clone(), v.as_u64().unwrap_or_default()))
        .collect();
    verdict.report_status = Some(status.clone());
    if let Some(detail) = skipped_differ(&report["skipped"], &verdict.expected.skipped) {
        verdict.mismatch("report", "skipped", detail);
    }
    match status.as_str() {
        // It echoes the flag and walks nothing
        "already_migrated" => return,
        "done" => {}
        other => {
            verdict.mismatch("report", "status", other);
            return;
        }
    }
    let got = |k: &str| verdict.report_counts.get(k).copied().unwrap_or_default();
    let want = |k: &str| verdict.expected.counts.get(k).copied().unwrap_or_default();
    let landed = ["written", "already_present"];
    let mut differences = Vec::new();
    for outcome in verdict.expected.counts.keys() {
        if (!resumed || !landed.contains(&outcome.as_str())) && got(outcome) != want(outcome) {
            differences.push(format!("{outcome} {} vs {}", got(outcome), want(outcome)));
        }
    }
    let (got_landed, want_landed) = (
        landed.iter().map(|k| got(k)).sum::<u64>(),
        landed.iter().map(|k| want(k)).sum::<u64>(),
    );
    if resumed && got_landed != want_landed {
        differences.push(format!(
            "written+already_present {got_landed} vs {want_landed}"
        ));
    }
    let total = report["total"].as_u64().unwrap_or_default();
    if total != verdict.expected.total || report["done"].as_u64() != Some(total) {
        differences.push(format!(
            "done {} of total {total} vs {}",
            report["done"], verdict.expected.total
        ));
    }
    // A resumed run reports only the values dropped in the objects it wrote itself
    if !resumed && report["dropped"].as_u64() != Some(verdict.expected.dropped) {
        differences.push(format!(
            "dropped {} vs {}",
            report["dropped"], verdict.expected.dropped
        ));
    }
    if !differences.is_empty() {
        verdict.mismatch("report", "counts", differences.join("; "));
    }
}

/// A report or flag with its path lists sorted, since two runs may finish objects in another
/// order.
fn sorted_lists(value: &Value) -> Value {
    let mut value = value.clone();
    for paths in value["skipped"]
        .as_object_mut()
        .into_iter()
        .flat_map(|m| m.values_mut())
    {
        if let Some(paths) = paths.as_array_mut() {
            paths.sort_by_key(Value::to_string);
        }
    }
    if let Some(notes) = value.get_mut("notes").and_then(Value::as_array_mut) {
        notes.sort_by_key(Value::to_string);
    }
    value
}

/// The flag as another run of the same walk writes it: everything but when.
fn flag_content(row: &Row) -> Option<Value> {
    let mut flag: Value = serde_json::from_str(row.text.as_deref()?).ok()?;
    flag.as_object_mut()?.remove("migrated_at");
    Some(sorted_lists(&flag))
}

fn short(value: &Value) -> String {
    value.to_string().chars().take(200).collect()
}

/// How this run differs from another run of the same user from nothing: each is its report and
/// its dump. Only the flag's `migrated_at` may differ.
fn compare_runs(
    (report, actual): (Option<&Value>, Option<&BTreeMap<String, Row>>),
    (other_report, other_actual): (Option<&Value>, Option<&BTreeMap<String, Row>>),
    verdict: &mut Verdict,
) {
    match (report.map(sorted_lists), other_report.map(sorted_lists)) {
        (Some(a), Some(b)) => {
            for key in REPORT_KEYS {
                if a[key] != b[key] {
                    let detail = format!("{} vs {}", short(&a[key]), short(&b[key]));
                    verdict.mismatch("compare_report", key, detail);
                }
            }
        }
        (_, None) => verdict.mismatch("compare_report", "", "no report of this seed to compare"),
        // Its absence is a report mismatch already
        (None, Some(_)) => {}
    }
    let (Some(a), Some(b)) = (actual, other_actual) else {
        if other_actual.is_none() {
            verdict.mismatch("compare_dump", "", "no dump of this seed to compare");
        }
        return;
    };
    for path in a.keys().chain(b.keys()).collect::<BTreeSet<_>>() {
        match (a.get(path), b.get(path)) {
            (Some(_), None) => verdict.mismatch("compare_dump", path, "only in this run"),
            (None, Some(_)) => verdict.mismatch("compare_dump", path, "only in the other run"),
            (Some(x), Some(y)) if path == FLAG => {
                if flag_content(x) != flag_content(y) {
                    let detail = format!("{:?} vs {:?}", x.text, y.text);
                    verdict.mismatch("compare_dump", path, detail);
                }
            }
            (Some(x), Some(y)) => {
                if x.blake3 != y.blake3 {
                    let detail = format!("{} vs {}", x.blake3, y.blake3);
                    verdict.mismatch("compare_dump", path, detail);
                }
            }
            (None, None) => unreachable!("a path of either dump"),
        }
    }
}

/// The owner's media references in the expected objects that point at no expected media, and
/// whether production held their blob.
fn dangling(pk: &str, blobs: Option<&BTreeMap<String, bool>>, verdict: &mut Verdict) {
    let needle = format!("pubky://{pk}/{MEDIA}");
    let mut dangling = BTreeMap::new();
    for candidates in verdict.expected.writes.values() {
        let text = String::from_utf8_lossy(&candidates[0]);
        for (at, _) in text.match_indices(&needle) {
            let rest = &text[at + "pubky://".len() + pk.len() + 1..];
            let end = rest.find(['"', '\\', ' ']).unwrap_or(rest.len());
            let target = &rest[..end];
            if verdict.expected.writes.contains_key(target) {
                continue;
            }
            let hash = target[MEDIA.len()..].split('.').next().unwrap_or_default();
            let why = if blobs.is_some_and(|b| b.contains_key(hash)) {
                Dangling::NotSampled
            } else {
                Dangling::AbsentInProduction
            };
            dangling.insert(target.to_string(), why);
        }
    }
    verdict.dangling = dangling;
}

/// What the frozen 0.x reader says of a v0 object, `None` when it accepts it.
fn reader_verdict(owner: &PubkyId, path: &str, bytes: &[u8]) -> Option<String> {
    let uri = format!("pubky://{}/{path}", owner.as_ref());
    match ParsedUri::try_from(uri.as_str()) {
        Err(e) => Some(format!("the 0.x parser refuses the path: {e}")),
        Ok(parsed) => match PubkyAppObject::from_resource(&parsed.resource, bytes) {
            Err(e) => Some(e),
            Ok(_) if matches!(parsed.resource, Resource::Unknown) => {
                Some("a path the 0.x reader does not know".into())
            }
            Ok(_) => None,
        },
    }
}

/// Both directions between the transforms and the frozen 0.x reader: every skip real data
/// should not produce, grouped by what the reader says of the object, and every object the
/// transforms took although the reader refuses it.
fn findings(owner: &PubkyId, tree: &BTreeMap<String, Vec<u8>>, verdict: &mut Verdict) {
    for category in FINDINGS {
        for path in verdict.expected.skipped.get(category).into_iter().flatten() {
            let error = reader_verdict(owner, path, &tree[path])
                .unwrap_or_else(|| "the 0.x reader accepts it".into());
            let pass = bucket(path).unwrap_or("rest");
            let group = format!("{category} {pass}: {}", fold(&error));
            verdict
                .findings
                .push((category.to_string(), group, path.clone(), error));
        }
    }
    for (path, _) in &verdict.expected.consumed {
        if let Some(error) = reader_verdict(owner, path, &tree[path]) {
            let pass = bucket(path).unwrap_or("rest");
            let group = format!("{pass}: {}", fold(&error));
            verdict.reverse.push((group, path.clone(), error));
        }
    }
}

/// An error message with its positions and ids folded, so messages group by kind.
fn fold(error: &str) -> String {
    let error = match error.find(" at line ") {
        Some(at) => &error[..at],
        None => error,
    };
    let folded: Vec<&str> = error
        .split_whitespace()
        .map(|w| {
            if w.len() >= 13 && w.chars().any(|c| c.is_ascii_digit()) {
                "*"
            } else {
                w
            }
        })
        .collect();
    folded.join(" ").chars().take(120).collect()
}

/// LIST pages a first run asks for, derived since the CLI does not count them: the legacy
/// root in pages of 1000 and the empty page that ends it, and each v1 root, empty.
fn list_pages_derived(objects: u64) -> u64 {
    objects.div_ceil(PAGE) + 1 + 2
}

/// Up to n v0 objects per pass beside the v1 objects they become, picked by a hash of their
/// owner and path so the choice spreads across users and stays the same from run to run.
struct Sampler {
    per_pass: usize,
    picked: BTreeMap<&'static str, BTreeMap<String, Value>>,
}

impl Sampler {
    fn new(per_pass: usize) -> Self {
        Self {
            per_pass,
            picked: BTreeMap::new(),
        }
    }

    fn offer(&mut self, pk: &str, tree: &BTreeMap<String, Vec<u8>>, expected: &Expected) {
        if self.per_pass == 0 {
            return;
        }
        let shown = |bytes: &[u8]| match serde_json::from_slice::<Value>(bytes) {
            Ok(value) => value,
            Err(_) => Value::String(String::from_utf8_lossy(bytes).into_owned()),
        };
        for (path, writes) in &expected.consumed {
            let Some(pass) = bucket(path).filter(|p| *p != "files" && *p != "blobs") else {
                continue;
            };
            let key = blake3_hex(format!("{pk}/{path}").as_bytes());
            let picked = self.picked.entry(pass).or_default();
            if picked.len() >= self.per_pass && picked.keys().next_back() < Some(&key) {
                continue;
            }
            let v1: Vec<Value> = writes
                .iter()
                .map(|(to, bytes)| json!({ "path": to, "object": shown(bytes) }))
                .collect();
            let v0 = json!({ "path": path, "object": shown(&tree[path]) });
            picked.insert(key, json!({ "pk": pk, "v0": v0, "v1": v1 }));
            if picked.len() > self.per_pass {
                picked.pop_last();
            }
        }
    }

    fn write(&self, dir: &Path) -> io::Result<()> {
        if self.per_pass == 0 {
            return Ok(());
        }
        if dir.exists() {
            fs::remove_dir_all(dir)?;
        }
        fs::create_dir_all(dir)?;
        for (pass, picked) in &self.picked {
            for (i, pair) in picked.values().enumerate() {
                fs::write(
                    dir.join(format!("{pass}-{i:02}.json")),
                    serde_json::to_vec_pretty(pair).unwrap(),
                )?;
            }
        }
        Ok(())
    }
}

type Groups = BTreeMap<String, (u64, Vec<Value>)>;

fn add_to_group(groups: &mut Groups, name: &str, pk: &str, path: &str, error: &str) {
    let entry = groups.entry(name.to_string()).or_default();
    entry.0 += 1;
    if entry.1.len() < 5 {
        entry
            .1
            .push(json!({ "pk": pk, "path": path, "error": error }));
    }
}

fn groups_json(groups: &Groups) -> Value {
    json!({
        "count": groups.values().map(|(n, _)| n).sum::<u64>(),
        "groups": groups.iter().map(|(group, (count, examples))| {
            json!({ "group": group, "count": count, "examples": examples })
        }).collect::<Vec<_>>(),
    })
}

#[derive(Default)]
struct Summary {
    users: u64,
    mismatched: Vec<String>,
    mismatch_kinds: BTreeMap<&'static str, u64>,
    examples: Vec<Value>,
    expected_counts: BTreeMap<String, u64>,
    report_counts: BTreeMap<String, u64>,
    report_status: BTreeMap<String, u64>,
    findings: Groups,
    reverse: Groups,
    dangling: BTreeMap<&'static str, u64>,
    dangling_users: u64,
    v0_objects: u64,
    v0_read_bytes: u64,
    v1_objects: u64,
    v1_bytes: u64,
    expected_writes: u64,
    list_pages: u64,
}

impl Summary {
    fn add(&mut self, pk: &str, verdict: &Verdict) {
        self.users += 1;
        if !verdict.mismatches.is_empty() {
            self.mismatched.push(pk.to_string());
        }
        for (kind, path, detail) in &verdict.mismatches {
            *self.mismatch_kinds.entry(kind).or_default() += 1;
            if self.examples.len() < 50 {
                let detail: String = detail.chars().take(400).collect();
                self.examples
                    .push(json!({ "pk": pk, "kind": kind, "path": path, "detail": detail }));
            }
        }
        for (outcome, n) in &verdict.expected.counts {
            *self.expected_counts.entry(outcome.clone()).or_default() += n;
        }
        for (outcome, n) in &verdict.report_counts {
            *self.report_counts.entry(outcome.clone()).or_default() += n;
        }
        let status = verdict.report_status.clone().unwrap_or("none".into());
        *self.report_status.entry(status).or_default() += 1;
        for (_, name, path, error) in &verdict.findings {
            add_to_group(&mut self.findings, name, pk, path, error);
        }
        for (name, path, error) in &verdict.reverse {
            add_to_group(&mut self.reverse, name, pk, path, error);
        }
        for why in verdict.dangling.values() {
            *self.dangling.entry(why.as_str()).or_default() += 1;
        }
        self.dangling_users += u64::from(!verdict.dangling.is_empty());
        self.v0_objects += verdict.expected.total;
        self.v0_read_bytes += verdict.expected.read_bytes;
        self.v1_objects += verdict.v1_objects;
        self.v1_bytes += verdict.v1_bytes;
        self.expected_writes += verdict.expected.writes.len() as u64;
        self.list_pages += list_pages_derived(verdict.expected.total);
    }

    fn to_json(&self) -> Value {
        let skips: BTreeMap<&String, &u64> = self
            .expected_counts
            .iter()
            .filter(|(o, n)| **n > 0 && *o != "written" && *o != "already_present")
            .collect();
        json!({
            "users": self.users,
            "mismatched_users": self.mismatched.len(),
            "mismatched": self.mismatched,
            "mismatch_kinds": self.mismatch_kinds,
            "mismatch_examples": self.examples,
            "report_status": self.report_status,
            "expected_counts": self.expected_counts,
            "report_counts": self.report_counts,
            "skip_histogram": skips,
            "findings": {
                "skipped_though_real": groups_json(&self.findings),
                "migrated_though_refused": groups_json(&self.reverse),
            },
            "dangling_media": { "references": self.dangling, "users": self.dangling_users },
            "objects": {
                "v0": self.v0_objects,
                "v1_expected": self.expected_writes,
                "v1_on_testnet_with_flags": self.v1_objects,
            },
            "bytes": { "v0_read": self.v0_read_bytes, "v1_written": self.v1_bytes },
            "list_pages_derived": self.list_pages,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn corpus() -> Value {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/vectors/semantic/v0_to_v1.json"
        );
        serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
    }

    fn bytes_of(input: &Value) -> Vec<u8> {
        match input.get("raw") {
            Some(Value::String(raw)) => raw.as_bytes().to_vec(),
            _ => serde_json::to_vec(&input["body"]).unwrap(),
        }
    }

    /// A v0 tree from the semantic vectors, the first input at each path, plus a tag that
    /// folds onto another one's v1 key.
    fn fixture() -> (String, BTreeMap<String, Vec<u8>>) {
        let corpus = corpus();
        let owner = corpus["owner"].as_str().unwrap().to_string();
        let mut tree = BTreeMap::new();
        for file in corpus["files"].as_array().unwrap() {
            let path = format!("{LEGACY}files/{}", file["tsid"].as_str().unwrap());
            tree.insert(path, bytes_of(file));
        }
        for vector in corpus["vectors"].as_array().unwrap() {
            let input = &vector["input"];
            tree.entry(input["path"].as_str().unwrap().to_string())
                .or_insert_with(|| bytes_of(input));
        }
        // A second tag on the same media through its blob spelling: a distinct 0.x id the
        // reader accepts, and the same 1.x tag once the target is dereferenced
        let uri = format!("pubky://{owner}/{LEGACY}blobs/AKSZ57W2RFKHV1EHK007FQQ8TW");
        let hash = blake3::hash(format!("{uri}:pic").as_bytes());
        let twin_id = base32::encode(base32::Alphabet::Crockford, &hash.as_bytes()[..16]);
        let twin = json!({ "uri": uri, "label": "pic", "created_at": 1727740800000000u64 });
        tree.insert(
            format!("{LEGACY}tags/{twin_id}"),
            serde_json::to_vec(&twin).unwrap(),
        );
        tree.insert(format!("{LEGACY}settings.json"), b"{}".to_vec());
        (owner, tree)
    }

    fn row(path: &str, bytes: &[u8]) -> Row {
        let text = (path.contains("/social/v1/") && !path.starts_with(MEDIA))
            .then(|| String::from_utf8(bytes.to_vec()).unwrap());
        Row {
            blake3: blake3_hex(bytes),
            size: bytes.len() as u64,
            text,
        }
    }

    /// What a correct run leaves: the v0 tree, every expected write, the flag, and its report.
    fn perfect(owner: &str, tree: &BTreeMap<String, Vec<u8>>) -> (BTreeMap<String, Row>, Value) {
        let expected = expect(&PubkyId::try_from(owner).unwrap(), tree);
        let mut actual: BTreeMap<String, Row> =
            tree.iter().map(|(p, b)| (p.clone(), row(p, b))).collect();
        for (path, candidates) in &expected.writes {
            actual.insert(path.clone(), row(path, &candidates[0]));
        }
        let flag = json!({
            "migrated_at": 1_790_000_000_000_000u64,
            "transform_rev": TRANSFORM_REV,
            "skipped": expected.skipped,
        });
        actual.insert(FLAG.into(), row(FLAG, flag.to_string().as_bytes()));
        let report = json!({
            "status": "done",
            "total": expected.total,
            "done": expected.total,
            "counts": expected.counts,
            "dropped": expected.dropped,
            "skipped": expected.skipped,
        });
        (actual, report)
    }

    fn check(
        owner: &str,
        tree: &BTreeMap<String, Vec<u8>>,
        actual: &BTreeMap<String, Row>,
        report: &Value,
    ) -> Verdict {
        verify_user(owner, tree, Some(actual), Some(report), None, false)
    }

    fn kinds(verdict: &Verdict) -> Vec<(&'static str, String)> {
        verdict
            .mismatches
            .iter()
            .map(|(k, p, _)| (*k, p.clone()))
            .collect()
    }

    #[test]
    fn the_expected_run_follows_the_engine_walk() {
        let (owner, tree) = fixture();
        let expected = expect(&PubkyId::try_from(owner.as_str()).unwrap(), &tree);
        let c = |k: &str| expected.counts[k];
        assert_eq!(expected.total, tree.len() as u64);
        // The twin tag folds onto the first one's v1 tag
        assert_eq!(c("already_present"), 1);
        let folded = "pub/social/v1/tags/RWAN47EWPX7RW7SKWT6YX11BP8.json";
        assert_eq!(expected.writes[folded].len(), 2);
        // last_read and settings.json are not read
        assert!(expected.skipped["not_migrated"].contains(&format!("{LEGACY}settings.json")));
        assert!(expected.skipped["not_migrated"].contains(&format!("{LEGACY}last_read")));
        assert_eq!(c("empty_title"), 1);
        // An unknown post kind is what the 0.x reader refuses: invalid, with the reader's note
        assert!(expected.skipped["invalid"]
            .iter()
            .any(|path| path.ends_with("posts/0034A0X7NJ52Y")));
        assert!(expected
            .writes
            .contains_key("pub/social/v1/files/AKSZ57W2RFKHV1EHK007FQQ8TW.png"));
        let files = tree.keys().filter(|p| bucket(p) == Some("files")).count() as u64;
        let accounted: u64 = expected.counts.values().sum();
        assert_eq!(accounted + files, expected.total);
    }

    #[test]
    fn a_correct_run_passes() {
        let (owner, tree) = fixture();
        let (actual, report) = perfect(&owner, &tree);
        assert_eq!(kinds(&check(&owner, &tree, &actual, &report)), vec![]);
    }

    #[test]
    fn content_compares_by_meaning() {
        let (owner, tree) = fixture();
        let (mut actual, report) = perfect(&owner, &tree);
        let path = "pub/social/v1/profile.json";
        let mut value: Value = serde_json::from_str(actual[path].text.as_ref().unwrap()).unwrap();
        let object = value.as_object_mut().unwrap();
        // Another key order and an explicit null for an absent member are the same object
        let reordered: Map<String, Value> = object.clone().into_iter().rev().collect();
        *object = reordered;
        object.insert("status".into(), Value::Null);
        actual.insert(path.into(), row(path, value.to_string().as_bytes()));
        assert_eq!(kinds(&check(&owner, &tree, &actual, &report)), vec![]);

        value["name"] = json!("someone else");
        actual.insert(path.into(), row(path, value.to_string().as_bytes()));
        assert_eq!(
            kinds(&check(&owner, &tree, &actual, &report)),
            vec![("content", path.to_string())]
        );
    }

    #[test]
    fn every_v1_object_must_pass_the_v1_reader() {
        let (owner, tree) = fixture();
        let (mut actual, report) = perfect(&owner, &tree);
        let path = "pub/social/v1/profile.json";
        let mut value: Value = serde_json::from_str(actual[path].text.as_ref().unwrap()).unwrap();
        value["name"] = json!("");
        actual.insert(path.into(), row(path, value.to_string().as_bytes()));
        let got = kinds(&check(&owner, &tree, &actual, &report));
        assert!(got.contains(&("reader", path.to_string())), "{got:?}");
    }

    #[test]
    fn either_object_of_a_fold_may_land() {
        let (owner, tree) = fixture();
        let (mut actual, report) = perfect(&owner, &tree);
        let path = "pub/social/v1/tags/RWAN47EWPX7RW7SKWT6YX11BP8.json";
        let expected = expect(&PubkyId::try_from(owner.as_str()).unwrap(), &tree);
        actual.insert(path.into(), row(path, &expected.writes[path][1]));
        assert_eq!(kinds(&check(&owner, &tree, &actual, &report)), vec![]);
    }

    #[test]
    fn media_compares_byte_for_byte() {
        let (owner, tree) = fixture();
        let (mut actual, report) = perfect(&owner, &tree);
        let path = "pub/social/v1/files/AKSZ57W2RFKHV1EHK007FQQ8TW.png";
        actual.insert(path.into(), row(path, b"other bytes"));
        assert_eq!(
            kinds(&check(&owner, &tree, &actual, &report)),
            vec![("content", path.to_string())]
        );
    }

    #[test]
    fn a_missing_or_unexpected_path_is_a_mismatch() {
        let (owner, tree) = fixture();
        let (mut actual, report) = perfect(&owner, &tree);
        let gone = "pub/social/v1/profile.json";
        actual.remove(gone);
        let stray = "priv/social/v1/mutes/stray.json";
        actual.insert(stray.into(), row(stray, b"{}"));
        let foreign = "pub/other.app/x";
        actual.insert(foreign.into(), row(foreign, b"{}"));
        let mut got = kinds(&check(&owner, &tree, &actual, &report));
        got.sort();
        assert_eq!(
            got,
            vec![
                ("foreign", foreign.to_string()),
                ("missing", gone.to_string()),
                ("reader", stray.to_string()),
                ("unexpected", stray.to_string()),
            ]
        );
    }

    #[test]
    fn the_v0_tree_must_stay_as_it_was() {
        let (owner, tree) = fixture();
        let (mut actual, report) = perfect(&owner, &tree);
        let changed = format!("{LEGACY}profile.json");
        actual.insert(changed.clone(), row(&changed, b"{}"));
        let gone = format!("{LEGACY}last_read");
        actual.remove(&gone);
        let mut got = kinds(&check(&owner, &tree, &actual, &report));
        got.sort();
        assert_eq!(got, vec![("v0_changed", changed), ("v0_missing", gone)]);
    }

    #[test]
    fn the_flag_carries_the_revision_and_the_skips() {
        let (owner, tree) = fixture();
        let (mut actual, report) = perfect(&owner, &tree);
        let flag = json!({ "migrated_at": 1, "transform_rev": 0, "skipped": {} });
        actual.insert(FLAG.into(), row(FLAG, flag.to_string().as_bytes()));
        assert_eq!(
            kinds(&check(&owner, &tree, &actual, &report)),
            vec![("flag", FLAG.into()), ("flag", FLAG.into())]
        );
        actual.remove(FLAG);
        assert_eq!(
            kinds(&check(&owner, &tree, &actual, &report)),
            vec![("flag", FLAG.into())]
        );
    }

    #[test]
    fn report_counts_are_exact_unless_the_run_resumed() {
        let (owner, tree) = fixture();
        let (actual, mut report) = perfect(&owner, &tree);
        let written = report["counts"]["written"].as_u64().unwrap();
        report["counts"]["written"] = json!(written - 3);
        report["counts"]["already_present"] =
            json!(report["counts"]["already_present"].as_u64().unwrap() + 3);
        let exact = verify_user(&owner, &tree, Some(&actual), Some(&report), None, false);
        assert_eq!(kinds(&exact), vec![("report", "counts".into())]);
        // A resumed run finds the earlier run's copies present: the sum is what is fixed
        let resumed = verify_user(&owner, &tree, Some(&actual), Some(&report), None, true);
        assert_eq!(kinds(&resumed), vec![]);

        report["counts"]["not_migrated"] = json!(0);
        let resumed = verify_user(&owner, &tree, Some(&actual), Some(&report), None, true);
        assert_eq!(kinds(&resumed), vec![("report", "counts".into())]);

        let skipped = perfect(&owner, &tree).1["skipped"].clone();
        let second = json!({ "status": "already_migrated", "counts": {}, "skipped": skipped });
        assert_eq!(kinds(&check(&owner, &tree, &actual, &second)), vec![]);
    }

    #[test]
    fn a_dump_or_report_of_another_seed_counts_as_absent() {
        let dir = std::env::temp_dir().join(format!("replay_verify_{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let dump = dir.join("dump.ndjson");
        let line = r#"{"path":"pub/pubky.app/profile.json","size":2,"blake3":"x"}"#;
        fs::write(&dump, format!("{{\"seed_epoch\":\"a\"}}\n{line}\n")).unwrap();
        assert_eq!(read_actual(&dump, "a").unwrap().unwrap().len(), 1);
        assert_eq!(read_actual(&dump, "b").unwrap(), None);
        let record = dir.join("record.json");
        fs::write(&record, r#"{"seedEpoch":"a","report":{"status":"done"}}"#).unwrap();
        assert!(read_report(&record, "a").unwrap().is_some());
        assert_eq!(read_report(&record, "b").unwrap(), None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn findings_run_both_ways_against_the_reader() {
        let (owner, mut tree) = fixture();
        // A File id from before October 2024: the 0.x reader refuses it, and so do the
        // transforms, which read through that reader; the run counts it as its own skip
        let early = format!("{LEGACY}files/001I1L5E4G50G");
        let file = tree[&format!("{LEGACY}files/0033000000000")].clone();
        tree.insert(early.clone(), file);
        let owner_id = PubkyId::try_from(owner.as_str()).unwrap();
        let mut verdict = Verdict {
            expected: expect(&owner_id, &tree),
            ..Verdict::default()
        };
        findings(&owner_id, &tree, &mut verdict);
        let categories: BTreeSet<&str> = verdict.findings.iter().map(|f| f.0.as_str()).collect();
        assert_eq!(categories, BTreeSet::from(["invalid"]));
        assert!(verdict.reverse.is_empty(), "{:?}", verdict.reverse);
        assert!(verdict.expected.skipped["invalid"].contains(&early));
        assert_eq!(fold("expected value at line 3 column 14"), "expected value");
        assert_eq!(
            fold("Invalid ID: expected XAG9KCJR0WMN4JXY44V9PHAKS4, found ba4320656bdee6d5"),
            "Invalid ID: expected * found *"
        );
    }

    #[test]
    fn dangling_media_says_whether_production_held_the_blob() {
        let (owner, mut tree) = fixture();
        tree.retain(|p, _| !p.starts_with(&format!("{LEGACY}blobs/")));
        let owner_id = PubkyId::try_from(owner.as_str()).unwrap();
        let mut verdict = Verdict {
            expected: expect(&owner_id, &tree),
            ..Verdict::default()
        };
        let listed = BTreeMap::from([("AKSZ57W2RFKHV1EHK007FQQ8TW".to_string(), false)]);
        dangling(&owner, Some(&listed), &mut verdict);
        let png = "pub/social/v1/files/AKSZ57W2RFKHV1EHK007FQQ8TW.png";
        assert_eq!(verdict.dangling.get(png), Some(&Dangling::NotSampled));
        assert!(verdict
            .dangling
            .values()
            .any(|why| *why == Dangling::AbsentInProduction));
    }

    #[test]
    fn the_sample_keeps_n_pairs_per_pass() {
        let (owner, tree) = fixture();
        let expected = expect(&PubkyId::try_from(owner.as_str()).unwrap(), &tree);
        let mut sampler = Sampler::new(2);
        sampler.offer(&owner, &tree, &expected);
        assert_eq!(sampler.picked["tags"].len(), 2);
        assert!(!sampler.picked.contains_key("files"));
        let pair = sampler.picked["tags"].values().next().unwrap();
        assert!(pair["v1"][0]["path"]
            .as_str()
            .unwrap()
            .starts_with("pub/social/v1/tags/"));
        let dir = std::env::temp_dir().join(format!("replay_sample_{}", std::process::id()));
        sampler.write(&dir).unwrap();
        assert!(dir.join("tags-01.json").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    fn compare(
        this: (&Value, &BTreeMap<String, Row>),
        other: (&Value, &BTreeMap<String, Row>),
    ) -> Vec<(&'static str, String)> {
        let mut verdict = Verdict::default();
        compare_runs(
            (Some(this.0), Some(this.1)),
            (Some(other.0), Some(other.1)),
            &mut verdict,
        );
        kinds(&verdict)
    }

    #[test]
    fn two_runs_from_nothing_differ_only_in_the_flag_time() {
        let (owner, tree) = fixture();
        let (actual, report) = perfect(&owner, &tree);
        let mut other = actual.clone();
        let mut flag: Value = serde_json::from_str(other[FLAG].text.as_ref().unwrap()).unwrap();
        flag["migrated_at"] = json!(1_790_000_000_000_001u64);
        other.insert(FLAG.into(), row(FLAG, flag.to_string().as_bytes()));
        let mut other_report = report.clone();
        for paths in other_report["skipped"]
            .as_object_mut()
            .unwrap()
            .values_mut()
        {
            paths.as_array_mut().unwrap().reverse();
        }
        assert_eq!(compare((&report, &actual), (&other_report, &other)), vec![]);
    }

    #[test]
    fn another_report_or_object_is_a_mismatch() {
        let (owner, tree) = fixture();
        let (actual, report) = perfect(&owner, &tree);
        let mut other_report = report.clone();
        other_report["counts"]["written"] = json!(0);
        let mut other = actual.clone();
        let changed = other
            .keys()
            .find(|p| p.starts_with("pub/social/v1/posts/"))
            .unwrap()
            .clone();
        other.insert(changed.clone(), row(&changed, b"{}"));
        let gone = other
            .keys()
            .find(|p| p.starts_with("pub/social/v1/tags/"))
            .unwrap()
            .clone();
        other.remove(&gone);
        let mut flag: Value = serde_json::from_str(other[FLAG].text.as_ref().unwrap()).unwrap();
        flag["transform_rev"] = json!(0);
        other.insert(FLAG.into(), row(FLAG, flag.to_string().as_bytes()));
        let mut got = compare((&report, &actual), (&other_report, &other));
        got.sort();
        let mut want = vec![
            ("compare_report", "counts".to_string()),
            ("compare_dump", changed),
            ("compare_dump", gone),
            ("compare_dump", FLAG.to_string()),
        ];
        want.sort();
        assert_eq!(got, want);
    }

    #[test]
    fn list_pages_count_the_empty_page_that_ends_a_walk() {
        assert_eq!(list_pages_derived(0), 3);
        assert_eq!(list_pages_derived(999), 4);
        assert_eq!(list_pages_derived(1000), 4);
        assert_eq!(list_pages_derived(1001), 5);
    }
}
