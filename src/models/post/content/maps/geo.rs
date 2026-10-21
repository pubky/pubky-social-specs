//! The two writer conventions of the Maps spec, so every writer lands on one resource without
//! any folding in the indexers: an OpenStreetMap place is its canonical object URL, and a
//! coordinate is one `geo:` spelling. Both are references on the universal tier, so the
//! reference gate admits them like any other URI; these rules run after it, in the positions
//! that name a place (an event's `locations`, a route's `waypoints`), and are documented for
//! `parent`, `embed` and tag targets, which keep the v1 gate alone.

use crate::limits::VALIDATION_LIMITS;

/// An OpenStreetMap object type, the segment of its canonical URL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum OsmObject {
    Node,
    Way,
    Relation,
}

impl OsmObject {
    pub fn segment(&self) -> &'static str {
        match self {
            OsmObject::Node => "node",
            OsmObject::Way => "way",
            OsmObject::Relation => "relation",
        }
    }
}

const OSM_PREFIX: &str = "https://www.openstreetmap.org/";

/// The hosts that name OpenStreetMap, any of which a pasted link may carry. A reference on one of
/// them in a place position has to be the canonical URL.
const OSM_HOSTS: [&str; 4] = [
    "www.openstreetmap.org",
    "openstreetmap.org",
    "osm.org",
    "www.osm.org",
];

/// Whether `uri` is a web URL on an OpenStreetMap host, canonical or not.
pub fn names_osm(uri: &str) -> bool {
    let rest = match uri
        .strip_prefix("https://")
        .or_else(|| uri.strip_prefix("http://"))
    {
        Some(rest) => rest,
        None => return false,
    };
    let authority = &rest[..rest.find(['/', '?', '#']).unwrap_or(rest.len())];
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = host.split(':').next().unwrap_or("");
    OSM_HOSTS.contains(&host.to_ascii_lowercase().as_str())
}

/// A decimal integer with no leading zero and no sign, at most `max_digits` digits.
fn plain_integer(s: &str, max_digits: usize) -> Option<u64> {
    if s.is_empty() || s.len() > max_digits || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if s.len() > 1 && s.starts_with('0') {
        return None;
    }
    s.parse().ok()
}

/// Parses the canonical OpenStreetMap object URL,
/// `https://www.openstreetmap.org/{node|way|relation}/{id}`: no trailing slash, query or
/// fragment, the id a positive integer with no leading zeros. `None` for anything else, a map
/// link with a view but no object included.
pub fn parse_osm_url(uri: &str) -> Option<(OsmObject, u64)> {
    let rest = uri.strip_prefix(OSM_PREFIX)?;
    let (kind, id) = rest.split_once('/')?;
    let kind = match kind {
        "node" => OsmObject::Node,
        "way" => OsmObject::Way,
        "relation" => OsmObject::Relation,
        _ => return None,
    };
    // 64-bit ids, as OpenStreetMap allocates them, from 1
    let id = plain_integer(id, 18)?;
    (id > 0).then_some((kind, id))
}

/// The canonical URL of an OpenStreetMap object.
pub fn osm_url(object: OsmObject, id: u64) -> String {
    format!("{OSM_PREFIX}{}/{id}", object.segment())
}

/// One coordinate of a `geo:` URI as the convention spells it: `-?` then an integer with no
/// leading zero then at most `geo_fraction_max_digits` fraction digits with no trailing zero,
/// never a negative zero. Returns the integer part and the fraction, both as text, when the
/// magnitude is at most `max_degrees`.
fn coordinate(s: &str, max_degrees: u64) -> Option<(u64, &str)> {
    let (negative, unsigned) = match s.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, s),
    };
    let (whole, fraction) = unsigned.split_once('.').unwrap_or((unsigned, ""));
    let whole = plain_integer(whole, 3)?;
    if unsigned.contains('.') {
        let max = VALIDATION_LIMITS.geo_fraction_max_digits;
        if fraction.is_empty()
            || fraction.len() > max
            || !fraction.bytes().all(|b| b.is_ascii_digit())
            || fraction.ends_with('0')
        {
            return None;
        }
    }
    if negative && whole == 0 && fraction.is_empty() {
        return None;
    }
    if whole > max_degrees || (whole == max_degrees && !fraction.is_empty()) {
        return None;
    }
    Some((whole, fraction))
}

/// Whether `uri` is a `geo:` URI as the convention spells it: `geo:<lat>,<lon>` in decimal
/// degrees, no altitude and no parameters, each coordinate as [`geo_uri`] writes it.
pub fn is_geo_uri(uri: &str) -> bool {
    let Some(rest) = uri.strip_prefix("geo:") else {
        return false;
    };
    let Some((lat, lon)) = rest.split_once(',') else {
        return false;
    };
    coordinate(lat, 90).is_some() && coordinate(lon, 180).is_some()
}

/// The `geo:` URI of a point, rounded to `digits` fraction digits (at most
/// `geo_fraction_max_digits`; five is about a metre, three about 100 m, two about 1 km) and
/// spelled with no trailing zeros, so one point has one spelling. Rounding is half up in both
/// implementations.
pub fn geo_uri(lat: f64, lon: f64, digits: usize) -> Result<String, String> {
    let max = VALIDATION_LIMITS.geo_fraction_max_digits;
    if digits > max {
        return Err(format!(
            "Validation Error: a geo URI carries at most {max} fraction digits"
        ));
    }
    if !lat.is_finite() || !lon.is_finite() {
        return Err("Validation Error: a geo URI needs finite coordinates".into());
    }
    let scale = 10u64.pow(digits as u32);
    let spell = |value: f64, max_degrees: u64| -> Option<String> {
        // floor(x + 0.5) rather than round: the two implementations agree on it for every tie
        let scaled = (value * scale as f64 + 0.5).floor();
        if scaled.abs() > (max_degrees * scale) as f64 {
            return None;
        }
        let scaled = scaled as i64;
        if scaled == 0 {
            return Some("0".to_string());
        }
        let magnitude = scaled.unsigned_abs();
        let whole = magnitude / scale;
        let fraction = format!("{:0width$}", magnitude % scale, width = digits);
        let fraction = fraction.trim_end_matches('0');
        let sign = if scaled < 0 { "-" } else { "" };
        Some(if fraction.is_empty() {
            format!("{sign}{whole}")
        } else {
            format!("{sign}{whole}.{fraction}")
        })
    };
    match (spell(lat, 90), spell(lon, 180)) {
        (Some(lat), Some(lon)) => Ok(format!("geo:{lat},{lon}")),
        _ => Err(
            "Validation Error: a geo URI needs a latitude within 90 and a longitude within 180 degrees"
                .into(),
        ),
    }
}

/// The two conventions as a rule on a place position named `field`, after the reference gate
/// has admitted the URI: a `geo:` URI must be the convention's spelling, and a URL on an
/// OpenStreetMap host must be the canonical object URL. Every other reference passes.
pub(crate) fn check_place_reference(field: &str, uri: &str) -> Result<(), String> {
    if uri.starts_with("geo:") && !is_geo_uri(uri) {
        return Err(format!(
            "Validation Error: {field} must be a geo URI, geo:<lat>,<lon> in decimal degrees with at most {} fraction digits and no trailing zeros: {uri}",
            VALIDATION_LIMITS.geo_fraction_max_digits
        ));
    }
    if names_osm(uri) && parse_osm_url(uri).is_none() {
        return Err(format!(
            "Validation Error: {field} must be a canonical OpenStreetMap object URL, https://www.openstreetmap.org/{{node|way|relation}}/{{id}}: {uri}"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn osm_urls() {
        assert_eq!(
            parse_osm_url("https://www.openstreetmap.org/way/481516234"),
            Some((OsmObject::Way, 481516234))
        );
        assert_eq!(
            parse_osm_url("https://www.openstreetmap.org/node/1"),
            Some((OsmObject::Node, 1))
        );
        assert_eq!(
            parse_osm_url("https://www.openstreetmap.org/relation/62273"),
            Some((OsmObject::Relation, 62273))
        );
        assert_eq!(
            osm_url(OsmObject::Way, 481516234),
            "https://www.openstreetmap.org/way/481516234"
        );
        for bad in [
            "https://www.openstreetmap.org/way/481516234/",
            "https://www.openstreetmap.org/way/481516234?x=1",
            "https://www.openstreetmap.org/way/481516234#map=19/46.0/8.9",
            "https://www.openstreetmap.org/way/0481516234",
            "https://www.openstreetmap.org/way/0",
            "https://www.openstreetmap.org/way/-1",
            "https://www.openstreetmap.org/way/",
            "https://www.openstreetmap.org/way",
            "https://www.openstreetmap.org/Way/1",
            "https://www.openstreetmap.org/user/alice",
            "https://www.openstreetmap.org/?mlat=46&mlon=8",
            "https://www.openstreetmap.org/#map=19/46.0/8.9",
            "https://www.openstreetmap.org/go/0CyXxFqA",
            "https://openstreetmap.org/way/481516234",
            "http://www.openstreetmap.org/way/481516234",
            "https://osm.org/way/481516234",
            "https://www.openstreetmap.org/way/1234567890123456789",
            "",
        ] {
            assert_eq!(parse_osm_url(bad), None, "{bad}");
        }
        // every spelling of the host is OpenStreetMap, so the canonical rule applies to it
        for named in [
            "https://openstreetmap.org/way/1",
            "http://www.openstreetmap.org/way/1",
            "https://OSM.org/node/1",
            "https://u@www.osm.org:443/x",
            "https://www.openstreetmap.org",
        ] {
            assert!(names_osm(named), "{named}");
        }
        for other in [
            "https://example.com/openstreetmap.org",
            "https://www.openstreetmap.org.evil.com/way/1",
            "geo:1,2",
            "pubky://x",
            "https://",
        ] {
            assert!(!names_osm(other), "{other}");
        }
    }

    #[test]
    fn geo_uris() {
        for ok in [
            "geo:46.00547,8.95186",
            "geo:46,8",
            "geo:0,0",
            "geo:-33.8,151.2",
            "geo:90,180",
            "geo:-90,-180",
            "geo:0.1,-0.1",
            "geo:89.99999,179.99999",
        ] {
            assert!(is_geo_uri(ok), "{ok}");
        }
        for bad in [
            "geo:46.005470,8.95186",
            "geo:46.005471,8.95186",
            "geo:46.0,8",
            "geo:046,8",
            "geo:46.,8",
            "geo:.5,8",
            "geo:-0,8",
            "geo:46,-0",
            "geo:+46,8",
            "geo:90.00001,8",
            "geo:91,8",
            "geo:46,180.00001",
            "geo:46,181",
            "geo:46,8,100",
            "geo:46,8;u=35",
            "geo:46,8?z=12",
            "geo:46;8",
            "geo:46",
            "geo:",
            "GEO:46,8",
            "geo: 46,8",
            "geo:46, 8",
            "geo:4６,8",
        ] {
            assert!(!is_geo_uri(bad), "{bad}");
        }
    }

    #[test]
    fn geo_uri_spells_one_point_one_way() {
        assert_eq!(
            geo_uri(46.005470, 8.95186, 5),
            Ok("geo:46.00547,8.95186".into())
        );
        assert_eq!(
            geo_uri(46.005470, 8.95186, 3),
            Ok("geo:46.005,8.952".into())
        );
        assert_eq!(geo_uri(46.005470, 8.95186, 0), Ok("geo:46,9".into()));
        assert_eq!(geo_uri(0.0, 0.0, 5), Ok("geo:0,0".into()));
        assert_eq!(geo_uri(-0.000001, 0.000001, 5), Ok("geo:0,0".into()));
        assert_eq!(geo_uri(-33.8, 151.2, 5), Ok("geo:-33.8,151.2".into()));
        assert_eq!(geo_uri(90.000004, -180.0, 5), Ok("geo:90,-180".into()));
        // half up, the same in both implementations
        assert_eq!(geo_uri(0.125, -0.125, 2), Ok("geo:0.13,-0.12".into()));
        assert!(is_geo_uri(&geo_uri(12.3456789, -98.7654321, 5).unwrap()));
        assert!(geo_uri(90.000005, 0.0, 5).is_err());
        assert!(geo_uri(0.0, 180.5, 5).is_err());
        assert!(geo_uri(f64::NAN, 0.0, 5).is_err());
        assert!(geo_uri(0.0, f64::INFINITY, 5).is_err());
        assert!(geo_uri(0.0, 0.0, 6).is_err());
    }

    #[test]
    fn place_reference_rule_applies_to_the_two_schemes_only() {
        assert!(check_place_reference("f", "geo:46.00547,8.95186").is_ok());
        assert!(check_place_reference("f", "https://www.openstreetmap.org/way/481516234").is_ok());
        assert!(check_place_reference("f", "https://meet.example.com/room").is_ok());
        assert!(check_place_reference("f", "nostr:nevent1abc").is_ok());
        assert_eq!(
            check_place_reference("locations[0].uri", "geo:46.0,8").unwrap_err(),
            "Validation Error: locations[0].uri must be a geo URI, geo:<lat>,<lon> in decimal degrees with at most 5 fraction digits and no trailing zeros: geo:46.0,8"
        );
        assert_eq!(
            check_place_reference("waypoints[1].uri", "https://osm.org/way/1").unwrap_err(),
            "Validation Error: waypoints[1].uri must be a canonical OpenStreetMap object URL, https://www.openstreetmap.org/{node|way|relation}/{id}: https://osm.org/way/1"
        );
    }
}
