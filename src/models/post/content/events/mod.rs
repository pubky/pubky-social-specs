//! The event kinds of 1.1: `event` and `rsvp`, and the optional `availability` and `rating`.
//! Each is a post kind on the shared envelope whose `content` is a JSON document with JSCalendar
//! member names where JSCalendar has one. There is no calendar kind: a calendar is a collection
//! whose items are event URIs. The JSCalendar value rules in [`time`] are public, for a sub-spec
//! whose own kinds carry times.

pub mod availability;
pub mod event;
pub mod rating;
pub mod rsvp;
pub mod time;

pub use availability::{PubkySocialAvailabilityBlock, PubkySocialAvailabilityContent};
pub use event::{
    PubkySocialAttendancePolicy, PubkySocialEventAttendance, PubkySocialEventContent,
    PubkySocialEventLink, PubkySocialEventLocation, PubkySocialEventStatus,
};
pub use rating::PubkySocialRatingContent;
pub use rsvp::{PubkySocialRsvpContent, PubkySocialRsvpStatus};
pub use time::{
    PubkySocialNthDay, PubkySocialRecurrenceFrequency, PubkySocialRecurrenceRule,
    PubkySocialWeekday,
};
