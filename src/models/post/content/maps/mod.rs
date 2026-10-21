//! The Maps side of 1.1: two writer conventions and one optional kind. The conventions, a
//! canonical OpenStreetMap object URL and one `geo:` spelling, are in [`geo`]; a located post is
//! a post whose `parent` or `embed` is such a resource, and collections hold places because
//! their items are universal. The `route` kind is the one new type.

pub mod geo;
pub mod route;

pub use route::{
    PubkySocialRouteContent, PubkySocialRoutePolyline, PubkySocialRouteStep,
    PubkySocialRouteWaypoint,
};
