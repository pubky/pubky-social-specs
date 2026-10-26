import type * as events from "./models/events.js";
import type * as feeds from "./models/feed.js";
import type * as graph from "./models/graph.js";
import type { KnownAttendancePolicy, KnownCollectionLayout, KnownEventStatus, KnownFeedLayout, KnownFeedReach, KnownFeedSort, KnownPostKind, KnownRecurrenceFrequency, KnownRsvpStatus, KnownWeekday } from "./models/kinds.js";
import type * as posts from "./models/post.js";
import type * as time from "./models/time.js";
import type * as users from "./models/user.js";
import type { validMimeTypes } from "./data.js";
import type { ObjectKind, OwnerPath as PathText, Root } from "./path.js";
/** Bytes that `fetch`, `Blob` and the SDK take as they are. */
export type Bytes = Uint8Array<ArrayBuffer>;
declare const brand: unique symbol;
/**
 * A string the package made or checked, tagged with what it names. The tag is a type only: at
 * run time a branded value is the string, and a plain string is taken wherever a brand is.
 */
export type Brand<S extends string, B extends string> = S & {
    readonly [brand]: B;
};
/**
 * A string argument: a plain one, or one branded `B`. A value branded as anything else is a
 * value of another kind passed by mistake, and does not compile.
 */
export type Given<B extends string, S extends string = string> = S & {
    readonly [brand]?: B;
};
/** A bare public key, 52 z-base32 characters, no `pubky://`: whose tree an object is in. */
export type Owner = Brand<string, "Owner">;
/** The id of a post, minted when it was created; every version of it shares it. */
export type PostId = Brand<string, "PostId">;
/** The id of one version of a post: its post id for the first version, a later one per edit. */
export type EditId = Brand<string, "EditId">;
/** The id of media: the hash of its bytes. */
export type MediaId = Brand<string, "MediaId">;
/**
 * The full URL of one stored object of kind `K`, `pubky://<owner>/...`: what `decodeObject`
 * reads at. For a post it names one version, so it is no reference to the post.
 */
export type PubkyUrl<K extends ObjectKind = ObjectKind> = Brand<`pubky://${string}`, `PubkyUrl.${K}`>;
/** The prefix to LIST one of an owner's trees, such as `pubky://<owner>/pub/social/v1/`: no object is stored at it. */
export type ListPrefix = Brand<`pubky://${string}/`, "ListPrefix">;
/** An owner-relative path, `/pub/...` or `/priv/...`: what the SDK's storage calls and every plan take. */
export type OwnerPath = Brand<PathText, "OwnerPath">;
/** A reference to a post, `buildUri(owner, "post", id)`: versionless, so it names the post and not one version. */
export type PostRef = Brand<`pubky://${string}`, "PostRef">;
/** Where a reference may point: anything but one version of a post. */
export type Reference = Given<"PostRef" | `PubkyUrl.${Exclude<ObjectKind, "post">}`>;
/** A URL argument naming a stored object: a plain string, such as an entry of a LIST, or a `PubkyUrl`. */
export type UrlArg<K extends ObjectKind = ObjectKind> = Given<`PubkyUrl.${K}`>;
/** An owner-relative path argument: a plain string or an `OwnerPath`. */
export type PathArg = Given<"OwnerPath">;
/**
 * A media type the data model names, one of `validMimeTypes`. It picks the extension of a media
 * path; `application/octet-stream`, `application/x-www-form-urlencoded` and
 * `multipart/form-data` map to `.bin`, as does any other string, which is taken too.
 */
export type MimeType = (typeof validMimeTypes)[number];
/**
 * A stored model as a caller holds it: the known members, integers as numbers, and the
 * unknown ones as `$unknown` text. Every public object type below is this of its model, so a
 * member added to a model reaches the type a caller sees.
 */
type PlainValue<V> = V extends bigint ? number : V extends bigint | null ? number | null : V extends bigint[] ? number[] : V;
type Plain<T> = {
    [K in keyof T as K extends "extra" ? never : K]: PlainValue<T[K]>;
};
interface Open {
    /** The members a newer writer added, as the text they were read with. Carry it along. */
    $unknown?: string;
}
/** One link on a profile. */
export interface UserLink extends Open, Plain<users.UserLink> {
}
/** A profile, stored at `/pub/social/v1/profile.json`: one per owner, public. */
export interface User extends Open, Omit<Plain<users.User>, "links"> {
    /** At most 5 links shown on the profile; null for none. */
    links: UserLink[] | null;
}
/** One media reference of a post. */
export interface Attachment extends Open, Plain<posts.Attachment> {
}
/**
 * One version of a post, stored at `posts/{id}/{editId}[-slug].json` under the public or the
 * private root. `id` and `editId` are in the path, not in the object.
 */
export interface Post extends Open, Omit<Plain<posts.Post>, "kind" | "attachments"> {
    /** What the post is, one of `postKinds`: a kind this version does not know is refused on read. It decides what `content` holds. */
    kind: KnownPostKind;
    /** At most 10 media references; empty for none. A collection carries none: its items are in its envelope. */
    attachments: Attachment[];
}
/** The envelope of an article, inside its post's `content`: read it with `decodeContent`. */
export interface ArticleContent extends Open, Plain<posts.ArticleContent> {
}
/** One entry of a collection. */
export interface CollectionItem extends Open, Plain<posts.CollectionItem> {
}
/** The envelope of a collection, inside its post's `content`: read it with `decodeContent`. */
export interface CollectionContent extends Open, Omit<Plain<posts.CollectionContent>, "items"> {
    /** At most 100 items, in the curator's order; empty for none. */
    items: CollectionItem[];
}
/** One place or meeting link of an event. */
export interface EventLocation extends Open, Plain<events.EventLocation> {
}
/** Who may come to an event and how many. */
export interface EventAttendance extends Open, Omit<Plain<events.EventAttendance>, "policy"> {
    /** How a person gets in, one of `attendancePolicies`: a policy this version does not know is refused on read. */
    policy: KnownAttendancePolicy;
}
/** One link shown with an event, `{ title, url }` as a profile's links are; https only. */
export interface EventLink extends Open, Plain<events.EventLink> {
}
/** One `byDay` entry of a recurrence rule. */
export interface NthDay extends Open, Omit<Plain<time.NthDay>, "day"> {
    /** The weekday, one of `weekdays`: a day this version does not know is refused on read. */
    day: KnownWeekday;
}
/** A JSCalendar recurrence rule, as an event repeats. */
export interface RecurrenceRule extends Open, Omit<Plain<time.RecurrenceRule>, "frequency" | "firstDayOfWeek" | "byDay" | "byMonthDay" | "bySetPosition"> {
    /** How often, one of `recurrenceFrequencies`: a frequency this version does not know is refused on read. */
    frequency: KnownRecurrenceFrequency;
    /** The first day of the week for a weekly rule, one of `weekdays`; null for the default. */
    firstDayOfWeek: KnownWeekday | null;
    /** The weekdays, with which one of the period; at most 31 entries. */
    byDay: NthDay[];
    /** Days of the month, -31 to 31 and never 0; at most 31 entries. */
    byMonthDay: number[];
    /** Positions in the expanded period, -366 to 366 and never 0; at most 31 entries. */
    bySetPosition: number[];
}
/** The envelope of an event, inside its post's `content`: read it with `decodeContent`. Member names are JSCalendar's. */
export interface EventContent extends Open, Omit<Plain<events.EventContent>, "status" | "locations" | "attendance" | "links" | "recurrenceRules"> {
    /** Whether the event is on, one of `eventStatuses`: a status this version does not know is refused on read. */
    status: KnownEventStatus;
    /** Where it is: at most 10 places or meeting links; empty for none. */
    locations: EventLocation[];
    /** Who may come and how many. */
    attendance: EventAttendance;
    /** At most 10 links shown with the event, https only; empty for none. */
    links: EventLink[];
    /** How it repeats: at most 1 rule; empty for a single event. */
    recurrenceRules: RecurrenceRule[];
}
/** The envelope of an rsvp, inside its post's `content`; the post's `parent` is the event. */
export interface RsvpContent extends Open, Omit<Plain<events.RsvpContent>, "status"> {
    /** The answer, one of `rsvpStatuses`: a status this version does not know is refused on read. */
    status: KnownRsvpStatus;
}
/** The envelope of a rating, inside its post's `content`; the post's `parent` is what is rated. */
export interface RatingContent extends Open, Plain<events.RatingContent> {
}
/** What `decodeContent` gives: the kind and its envelope, or null for a kind whose content is plain text. */
export type DecodedContent = {
    /** The article kind. */
    kind: "article";
    /** Its envelope. */
    content: ArticleContent;
} | {
    /** The collection kind. */
    kind: "collection";
    /** Its envelope. */
    content: CollectionContent;
} | {
    /** The event kind. */
    kind: "event";
    /** Its envelope. */
    content: EventContent;
} | {
    /** The rsvp kind. */
    kind: "rsvp";
    /** Its envelope. */
    content: RsvpContent;
} | {
    /** The rating kind. */
    kind: "rating";
    /** Its envelope. */
    content: RatingContent;
};
/** The envelopes `encodeContent` spells. */
export type Envelope = ArticleContent | CollectionContent | EventContent | RsvpContent | RatingContent;
/** A label on an object, stored at `/pub/social/v1/tags/{id}.json`; the id hashes the target and the label. */
export interface Tag extends Open, Plain<graph.Tag> {
}
/** A saved reference, private, stored at `/priv/social/v1/bookmarks/{filename}.json`; the filename spells the target. */
export interface Bookmark extends Open, Plain<graph.Bookmark> {
}
/** A follow, stored at `/pub/social/v1/follows/{followee}.json`: the path holds the followee. */
export interface Follow extends Open, Plain<graph.Edge> {
}
/** A mute, private, stored at `/priv/social/v1/mutes/{mutee}.json`: the path holds the muted key. */
export interface Mute extends Open, Plain<graph.Edge> {
}
/** The filter of a feed, which is its identity. */
export interface FeedConfig extends Open, Omit<Plain<feeds.FeedConfig>, "reach" | "layout" | "sort"> {
    /** Whose posts the feed shows, one of `feedReaches`: `all`, the owner's `following` or `followers`, mutual `friends`, the `wot` (web of trust) or `me`. */
    reach: KnownFeedReach;
    /** How the client lays the feed out, one of `feedLayouts`: `columns`, `wide`, `visual` (media first), `list` or `cards`. */
    layout: KnownFeedLayout;
    /** The order of the posts, one of `feedSorts`: `recent` or `popularity`. */
    sort: KnownFeedSort;
}
/** A saved feed, private, stored at `/priv/social/v1/feeds/{id}.json`; its published copy is the same leaf under `/pub/`. */
export interface Feed extends Open, Omit<Plain<feeds.Feed>, "feed"> {
    /** The filter, which is the whole identity of the feed: its id hashes these members. */
    feed: FeedConfig;
}
/** Each stored kind and its object type, as `decodeObject` and `encodeObject` take the kind. */
export interface Stored {
    /** A profile. */
    user: User;
    /** One version of a post. */
    post: Post;
    /** A follow. */
    follow: Follow;
    /** A mute. */
    mute: Mute;
    /** A bookmark. */
    bookmark: Bookmark;
    /** A tag. */
    tag: Tag;
    /** A feed. */
    feed: Feed;
}
/**
 * What `decodeObject` gives without a kind: the kind the URL names and the object, or the
 * bytes of media. Narrow it on `kind`.
 */
export type Decoded = {
    [K in keyof Stored]: {
        /** The kind the URL names. */
        kind: K;
        /** The object, checked by every rule of its kind at that URL. */
        object: Stored[K];
    };
}[keyof Stored] | {
    /** Media: a URL under `files/`. */
    kind: "file";
    /** The bytes as given, checked against the hash the filename carries. */
    bytes: Bytes;
};
/**
 * The kind of a stored object type: a post's URL names a version, every other one the object.
 * A follow and a mute share one type, so their builders name the kind outright.
 */
type KindOf<T> = T extends Post ? "post" : T extends User ? "user" : T extends Feed ? "feed" : T extends Tag ? "tag" : T extends Bookmark ? "bookmark" : "follow" | "mute";
/** A built object: where it goes, what it is, and the exact bytes to PUT there. `K` is its kind. */
export interface Built<T, Id extends string = string, K extends ObjectKind = KindOf<T>> {
    /** What the path names: empty for the profile, the followee for a follow. */
    id: Id;
    /** Owner-relative, as the SDK's storage calls take it. */
    path: OwnerPath;
    /** The full `pubky://` URL of the stored object. For a post it names this version: a reference to the post is `buildUri(owner, "post", id)`. */
    url: PubkyUrl<K>;
    /** The object as stored, every known member present. Keep it for local state; PUT `body`, not this. */
    object: T;
    /** The exact bytes to PUT at `path`: UTF-8 JSON the package spelled. `fetch`, `Blob` and the SDK take it as it is. */
    body: Bytes;
}
/** A built post version: a `Built<Post>` whose `id` is the post id, with the id of this version. */
export type BuiltPost = Built<Post, PostId> & {
    /** The id of this version; equal to `id` for a post never edited. */
    editId: EditId;
};
/** What `buildUser` takes. Display text is trimmed; a reference is stored as written. */
export interface NewUser {
    /** The display name: 3 to 50 code points once trimmed. */
    name: string;
    /** A short description: at most 160 code points once trimmed; empty or absent for none. */
    bio?: string | null;
    /** The avatar: a canonical pubky or web URI of at most 300 code points, never under the private root. */
    image?: string | null;
    /** At most 5 links: a title of 1 to 100 code points and a canonical web URL of at most 300 code points each. */
    links?: {
        title: string;
        url: string;
    }[] | null;
    /** A status line: at most 50 code points once trimmed. */
    status?: string | null;
}
/** One media reference a post input takes. */
export interface NewAttachment {
    /** The media: the `url` of a `buildFile` result, or a canonical web URL; at most 1024 code points. */
    uri: string;
    /** Text describing the media for a screen reader: at most 1000 code points. */
    alt?: string | null;
    /** The file name shown: 1 to 255 code points once trimmed. */
    name?: string | null;
}
interface Placement {
    /** Where the version is stored, `"public"` when absent. A private draft may reference the owner's private media. */
    root?: Root | null;
    /** A readable tail for the version's path, `{editId}-{slug}.json`: 1 to 64 of a-z, 0-9 and `-`. No identity: the editId names the version. */
    slug?: string | null;
}
interface Threaded {
    /** The post this one replies to: `buildUri(author, "post", id)`, a versionless reference of at most 1024 code points. */
    parent?: string | null;
    /** The post or URI this one quotes: a versionless reference of at most 1024 code points. */
    embed?: string | null;
    /** At most 10 media references. */
    attachments?: NewAttachment[] | null;
    /** A pubky reference to what gates the post, at most 1024 code points. */
    lock?: string | null;
}
/** The kinds whose `content` is an envelope a builder writes from members of its own. */
export type EnvelopeKind = "article" | "collection" | "event" | "rsvp" | "rating";
/** A post of any kind but one with an envelope: `note` when `kind` is absent. */
export type NewNote = {
    /** `note` when absent, else `image`, `video`, `link` or `file`: a hint for how to show `content`. */
    kind?: Exclude<KnownPostKind, EnvelopeKind> | null;
    /** The text: at most 2000 code points once trimmed; empty only with an embed or an attachment. */
    content: string;
    /** An article's member: give `kind: "article"`. */
    title?: never;
    /** An article's member: give `kind: "article"`. */
    body?: never;
    /** An article's or a collection's member. */
    cover_image?: never;
    /** A collection's member: give `kind: "collection"`. */
    name?: never;
    /** A collection's member: give `kind: "collection"`. */
    description?: never;
    /** A collection's member: give `kind: "collection"`. */
    items?: never;
    /** A collection's member: give `kind: "collection"`. */
    layout?: never;
} & Threaded & Placement;
/** An article: a title and a body, which the builder writes into the post's `content` envelope. */
export type NewArticle = {
    /** The article kind. */
    kind: "article";
    /** The title: 1 to 100 code points once trimmed. */
    title: string;
    /** The text, Markdown by convention: at most 50000 code points. */
    body: string;
    /** A canonical `pubky`, `http` or `https` URI of an image, at most 300 code points. */
    cover_image?: string | null;
    /** A note's member: an article's text is `body`. */
    content?: never;
    /** A collection's member. */
    name?: never;
    /** A collection's member. */
    description?: never;
    /** A collection's member. */
    items?: never;
    /** A collection's member. */
    layout?: never;
} & Threaded & Placement;
/** A collection: curated references, which the builder writes into the post's `content` envelope. */
export type NewCollection = {
    /** The collection kind. */
    kind: "collection";
    /** The name: 1 to 100 code points once trimmed. */
    name: string;
    /** What it gathers: at most 500 code points once trimmed; empty for none. */
    description?: string | null;
    /** At most 100 items: a versionless reference of at most 1024 code points and a note of at most 1000 code points each. */
    items?: {
        uri: string;
        note?: string | null;
    }[] | null;
    /** A canonical `pubky`, `http` or `https` URI of an image, at most 300 code points. */
    cover_image?: string | null;
    /** How the creator would show it, one of `collectionLayouts`. */
    layout?: KnownCollectionLayout | null;
    /** A note's member. */
    content?: never;
    /** An article's member. */
    title?: never;
    /** An article's member. */
    body?: never;
    /** A collection replies to nothing. */
    parent?: never;
    /** A collection quotes nothing. */
    embed?: never;
    /** A collection's media are its items. */
    attachments?: never;
    /** A collection is not gated. */
    lock?: never;
} & Placement;
/** One place or meeting link a new event takes. */
export interface NewEventLocation {
    /** The place: a canonical OpenStreetMap object URL, a `geo:` point from `geoUri`, or an https meeting link; at most 1024 code points. */
    uri: string;
    /** A name to show: 1 to 100 code points once trimmed. */
    name?: string | null;
}
/** One link a new event takes, `{ title, url }` as a profile's links are. */
export interface NewEventLink {
    /** A title to show: 1 to 100 code points once trimmed. */
    title: string;
    /** An https URL of at most 300 code points, stored as written. */
    url: string;
}
/** Who may come to a new event. */
export interface NewEventAttendance {
    /** How a person gets in, one of `attendancePolicies`; `open` when absent. */
    policy?: KnownAttendancePolicy | null;
    /** Seats, 1 to 1000000 people; absent for no limit. */
    capacity?: number | null;
    /** Whether people past the capacity queue; false when absent. */
    waitlist?: boolean | null;
}
/** A recurrence rule a new event takes, in JSCalendar's members. */
export interface NewRecurrenceRule {
    /** How often, one of `recurrenceFrequencies`. */
    frequency: KnownRecurrenceFrequency;
    /** Every `interval`th period, 1 to 1000 periods; absent for every period. */
    interval?: number | null;
    /** The first day of the week for a weekly rule, one of `weekdays`. */
    firstDayOfWeek?: KnownWeekday | null;
    /** The weekdays, each with which one of the period (-53 to 53, never 0); at most 31 entries. */
    byDay?: {
        day: KnownWeekday;
        nthOfPeriod?: number | null;
    }[] | null;
    /** Days of the month, -31 to 31 and never 0; at most 31 entries. */
    byMonthDay?: number[] | null;
    /** Months, `"1"` to `"12"`; at most 31 entries. */
    byMonth?: string[] | null;
    /** Positions in the expanded period, -366 to 366 and never 0; at most 31 entries. */
    bySetPosition?: number[] | null;
    /** Occurrences in all, 1 to 1000. */
    count?: number | null;
    /** The last local date-time an occurrence may start, at most 3 years after the start. */
    until?: string | null;
}
/** An event: JSCalendar members, which the builder writes into the post's `content` envelope. The cover is `attachments[0]`; categories are tags. */
export type NewEvent = {
    /** The event kind. */
    kind: "event";
    /** The title: 1 to 100 code points once trimmed. */
    title: string;
    /** Markdown: at most 50000 code points once trimmed; empty for none. */
    description?: string | null;
    /** When it starts, a local date-time `YYYY-MM-DDTHH:MM:SS` in `timeZone`. */
    start: string;
    /** An IANA time zone name of at most 64 code points. */
    timeZone: string;
    /** How long it lasts, an ISO 8601 duration `PnW` or `PnDTnHnMnS` of at most 31622400 seconds; required unless `showWithoutTime`. */
    duration?: string | null;
    /** An all-day event; false when absent. */
    showWithoutTime?: boolean | null;
    /** Whether the event is on, one of `eventStatuses`; `confirmed` when absent. */
    status?: KnownEventStatus | null;
    /** At most 10 places or meeting links. */
    locations?: NewEventLocation[] | null;
    /** Who may come; open with no limit when absent. */
    attendance?: NewEventAttendance | null;
    /** At most 10 links, https only. */
    links?: NewEventLink[] | null;
    /** How it repeats: at most 1 rule. */
    recurrenceRules?: NewRecurrenceRule[] | null;
    /** Occurrences removed from the series, each a local date-time; at most 100. */
    excludedDates?: string[] | null;
    /** On an override of one occurrence, the master event: `buildUri(owner, "post", id)` of the same owner. Set together with `recurrenceId`. */
    recurrenceOf?: string | null;
    /** On an override of one occurrence, its local start in the master's series. */
    recurrenceId?: string | null;
    /** At most 10 media references; the first is the cover. */
    attachments?: NewAttachment[] | null;
    /** A pubky reference to the lock guarding the private details, at most 1024 code points. */
    lock?: string | null;
    /** An event replies to nothing. */
    parent?: never;
    /** An event quotes nothing. */
    embed?: never;
} & Placement;
/** An rsvp: an answer to the event at `parent`, which the builder writes into the post's `content` envelope. */
export type NewRsvp = {
    /** The rsvp kind. */
    kind: "rsvp";
    /** The event answered: `buildUri(author, "post", id)`, or any reference of at most 1024 code points. */
    parent: string;
    /** The answer, one of `rsvpStatuses`. */
    status: KnownRsvpStatus;
    /** The occurrence answered, its local start in the event's series; absent for the series. */
    recurrenceId?: string | null;
    /** Companions without an account, 0 to 100 people; 0 when absent. */
    guests?: number | null;
    /** A note to the organiser: at most 2000 code points once trimmed; empty for none. */
    note?: string | null;
    /** An rsvp quotes nothing. */
    embed?: never;
    /** An rsvp carries no media. */
    attachments?: never;
    /** An rsvp is not gated. */
    lock?: never;
} & Placement;
/** A rating: stars on the thing at `parent`, which the builder writes into the post's `content` envelope. */
export type NewRating = {
    /** The rating kind. */
    kind: "rating";
    /** What is rated: a place, an event, a listing or a link, any reference of at most 1024 code points. */
    parent: string;
    /** The stars, 1 to 10 half stars: 10 is five stars. */
    rating: number;
    /** The review: at most 2000 code points once trimmed; empty for none. */
    text?: string | null;
    /** At most 10 media references, photos of the thing. */
    attachments?: NewAttachment[] | null;
    /** A rating quotes nothing. */
    embed?: never;
    /** A rating is not gated. */
    lock?: never;
} & Placement;
/** What `buildPost` takes: a note, an article, a collection, an event, an rsvp or a rating, told apart by `kind`. */
export type NewPost = NewNote | NewArticle | NewCollection | NewEvent | NewRsvp | NewRating;
/** The version URL a reference member would hold, named where it is refused. */
type NoVersion<T> = T extends {
    readonly [brand]: "PubkyUrl.post";
} ? {
    error: 'a reference names the post, buildUri(owner, "post", id), never the url of one version';
} : T extends object ? {
    [K in keyof T]: NoVersion<T[K]>;
} : T;
type BranchOf<I> = I extends {
    kind: "article";
} ? NewArticle : I extends {
    kind: "collection";
} ? NewCollection : I extends {
    kind: "event";
} ? NewEvent : I extends {
    kind: "rsvp";
} ? NewRsvp : I extends {
    kind: "rating";
} ? NewRating : NewNote;
/**
 * A post input as `buildPost` checks it at compile time: the members of its kind only, and no
 * reference holding the URL of a post version.
 */
export type CheckedPost<I> = {
    [K in keyof I]: K extends keyof BranchOf<I> ? NoVersion<I[K]> : never;
};
/** What `buildFeed` takes. The filter members make the id; `name` and `icon` do not. */
export interface NewFeed {
    /** The display name: 1 to 100 code points once trimmed. */
    name: string;
    /** A name from the client's icon set: 1 to 50 of a-z, 0-9 and `-` once trimmed and ASCII-lowercased. */
    icon: string;
    /** Whose posts the feed shows, one of `feedReaches`. */
    reach: KnownFeedReach;
    /** How the client lays the feed out, one of `feedLayouts`. */
    layout: KnownFeedLayout;
    /** The order of the posts, one of `feedSorts`. */
    sort: KnownFeedSort;
    /** The one post kind shown, one of `postKinds`; absent for every kind. */
    content?: KnownPostKind | null;
    /** At most 5 tag labels a post must carry, folded and sorted by the builder; absent for no tag filter, never empty. */
    tags?: string[] | null;
    /** At most 5 domain labels, with the rules of `tags`. */
    domain_tags?: string[] | null;
}
/** What `buildFile` takes: the bytes, or the id `hashMedia` gave for them, and the declared type. */
export type NewFile = ({
    /** The media itself, 1 byte to 100 MiB; hashed here. */
    bytes: Uint8Array | ArrayBuffer;
    /** Given with `bytes`, the id is computed: pass one or the other. */
    id?: never;
} | {
    /** The hash of the bytes, as `hashMedia` or `createMediaHasher` gave it; the bytes are never seen, so check their size yourself. */
    id: string;
    /** Given with an `id`, the bytes are not read: pass one or the other. */
    bytes?: never;
}) & {
    /** The declared media type, which picks the extension and is never stored. */
    type: MimeType | (string & {});
    /** `"public"` when absent; a private draft's media goes under `"private"`. */
    root?: Root | null;
};
/** A `ReadableStream` of bytes, as far as `hashMedia` reads one. */
export interface ByteStream {
    /** A reader whose chunks are `Uint8Array`s, as a `ReadableStream` of bytes gives. */
    getReader(): {
        read(): Promise<{
            done: boolean;
            value?: Uint8Array | undefined;
        }>;
        releaseLock(): void;
    };
}
/** A `Blob` or a `File`, as far as `hashMedia` reads one: a chunk at a time where it streams, whole where it does not. */
export type BlobLike = {
    /** The bytes as a stream, as `Blob.prototype.stream` gives them. */
    stream(): ByteStream;
} | {
    /** The bytes at once, as `Blob.prototype.arrayBuffer` gives them. */
    arrayBuffer(): Promise<ArrayBuffer>;
};
/** What `hashMedia` reads: a `Blob`, a `File` or a `ReadableStream` of bytes. */
export type MediaSource = BlobLike | ByteStream;
/** Where media goes. There is no `body`: the bytes are the caller's, PUT as they are. */
export interface BuiltFile {
    /** The hash of the bytes. */
    id: MediaId;
    /** Owner-relative, `/{root}/social/v1/files/{id}.{ext}`, as the SDK's storage calls take it. */
    path: OwnerPath;
    /** The full `pubky://` URL: what an attachment or a cover takes. */
    url: PubkyUrl<"file">;
}
/** One copy a plan runs, `from` and `to` both owner-relative. */
export interface Copy {
    /** The path to GET, owner-relative. */
    from: OwnerPath;
    /** The path to PUT the same bytes at, owner-relative. */
    to: OwnerPath;
}
/** A stored version of a post as a LIST found it. */
export interface StoredCopy {
    /** The root the path is under. */
    root: Root;
    /** The owner-relative path, `toPath` of the URL a LIST gave. */
    path: PathArg;
}
/**
 * A copy of the object `deletionPaths` deletes, as a LIST found it: an owner-relative path, or a
 * 0.x object with the members that prove it belongs to the target.
 */
export type Listing = PathArg | {
    /** The path of a 0.x File object, under `/pub/pubky.app/files/`. */
    path: PathArg;
    /** The File object's stored `src`: it names the bytes, so it ties the object to one hash. */
    src: string;
} | {
    /** The path of a 0.x tag, under `/pub/pubky.app/tags/`. */
    path: PathArg;
    /** The tag's stored `uri`. */
    uri: string;
    /** The tag's stored `label`. */
    label: string;
    /** Absent: the tag is on no 0.x File object. */
    src?: null;
    /** Absent, with `src`. */
    contentType?: null;
} | {
    /** The path of a 0.x tag on a 0.x File object. */
    path: PathArg;
    /** The tag's stored `uri`. */
    uri: string;
    /** The tag's stored `label`. */
    label: string;
    /** That File object's `src`. */
    src: string;
    /** That File object's `content_type`. */
    contentType: string;
};
/** What `parseUri` reads in a URI: whose tree, which root, the path, and what the path names. */
export type ParsedUri = {
    /** The bare key of the tree's owner. */
    owner: Owner;
    /** The root the path is under; `"public"` for the bare owner URL. */
    root: Root;
    /** The owner-relative path; empty for the bare owner URL `pubky://<owner>`. */
    path: OwnerPath | "";
} & ({
    /** The profile, or the user when the path is empty. */
    kind: "user";
} | {
    /** A post: one version when `editId` is present, else the versionless reference. */
    kind: "post";
    /** The post id. */
    id: PostId;
    /** The version, on a version path. */
    editId?: EditId;
    /** The slug of a version path `{editId}-{slug}.json`; `planPublish` takes it to keep it. */
    slug?: string;
} | {
    /** A follow or a mute. */
    kind: "follow" | "mute";
    /** The followed or muted key. */
    id: Owner;
} | {
    /** A tag or a feed. */
    kind: "tag" | "feed";
    /** The hash id. */
    id: string;
} | {
    /** Media. */
    kind: "file";
    /** The hash of the bytes. */
    id: MediaId;
    /** The full name with its extension, the name `buildUri(owner, "file", filename)` takes. */
    filename: string;
} | {
    /** A bookmark. */
    kind: "bookmark";
    /** The filename: base64url of the target, or `~{hash}` for the overflow form. */
    id: string;
    /** The target, when the filename carries one that reads back as valid. */
    target?: string;
} | {
    /** A path under a namespace other than this one, such as the 0.x `pubky.app`. */
    kind: "foreign";
    /** The namespace segment. */
    namespace: string;
    /** The epoch segment after it, when it looks like one. */
    version?: string;
    /** The segments after those. */
    rest: string[];
} | {
    /** A path under an epoch of this namespace this version does not read. */
    kind: "unsupportedVersion";
    /** The epoch segment. */
    version: string;
} | {
    /** A path of this namespace that names no object. */
    kind: "unknown";
});
export type { ObjectKind, Root };
//# sourceMappingURL=types.d.ts.map