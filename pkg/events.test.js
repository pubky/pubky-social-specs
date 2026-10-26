// The event kinds as a caller meets them: the builders' trims and spellings, the rules in the
// reference's words, the decode and the round trip. What every input answers against the
// reference is the scoreboard's job (qa/score.mjs); here are the shapes and the edges.

import assert from "assert";
import {
  attendancePolicies,
  buildPost,
  decodeContent,
  decodeObject,
  editPost,
  encodeContent,
  encodeObject,
  eventStatuses,
  limits,
  planPublish,
  postKinds,
  recurrenceFrequencies,
  rsvpStatuses,
  validatePost,
  weekdays,
} from "./dist/index.js";
import { setClock } from "./dist/testing.js";
import { OTTO, RIO, T0, misuse, refuses, text, utf8 } from "./core.fixture.js";

const HUB = "https://www.openstreetmap.org/way/481516234";
const theirEvent = `pubky://${RIO}/pub/social/v1/posts/0035QZPT4QG00`;

/** The design page's example, as a caller gives it. */
const lugano = () => ({
  kind: "event",
  title: "Lugano Bitcoin Evening",
  description: "Monthly meetup. Talks start at 19:00.",
  start: "2026-10-14T18:30:00",
  timeZone: "Europe/Zurich",
  duration: "PT2H30M",
  locations: [{ name: "Plan ₿ Hub", uri: HUB }],
  links: [{ title: "Website", url: "https://planb.network/" }],
  recurrenceRules: [{ frequency: "monthly", byDay: [{ day: "tu", nthOfPeriod: 2 }] }],
});

describe("the event kinds", () => {
  beforeEach(() => setClock(() => T0));
  after(() => setClock());

  it("are in the tables", () => {
    for (const kind of ["event", "rsvp", "rating"]) assert.ok(postKinds.includes(kind));
    assert.deepStrictEqual([...eventStatuses], ["confirmed", "tentative", "cancelled"]);
    assert.deepStrictEqual([...attendancePolicies], ["open", "approval", "invite", "ticket"]);
    assert.deepStrictEqual([...rsvpStatuses], ["requested", "accepted", "declined", "tentative"]);
    assert.deepStrictEqual([...recurrenceFrequencies], ["yearly", "monthly", "weekly", "daily"]);
    assert.deepStrictEqual([...weekdays], ["mo", "tu", "we", "th", "fr", "sa", "su"]);
    assert.ok(Object.isFrozen(eventStatuses) && Object.isFrozen(weekdays));
    assert.strictEqual(limits.eventRecurrenceMaxOccurrences, 1000);
    assert.strictEqual(limits.eventRecurrenceMaxSpanYears, 3);
    assert.strictEqual(limits.ratingMaxHalfStars, 10);
  });

  describe("event", () => {
    it("builds the design example with JSCalendar member names, in the kind's order", () => {
      const built = buildPost(OTTO, lugano());
      assert.strictEqual(built.object.kind, "event");
      assert.strictEqual(built.object.parent, null);
      assert.strictEqual(
        built.object.content,
        '{"title":"Lugano Bitcoin Evening","description":"Monthly meetup. Talks start at 19:00.","start":"2026-10-14T18:30:00","timeZone":"Europe/Zurich","duration":"PT2H30M","showWithoutTime":false,"status":"confirmed","locations":[{"name":"Plan ₿ Hub","uri":"https://www.openstreetmap.org/way/481516234"}],"attendance":{"policy":"open","capacity":null,"waitlist":false},"links":[{"title":"Website","url":"https://planb.network/"}],"recurrenceRules":[{"frequency":"monthly","byDay":[{"day":"tu","nthOfPeriod":2}]}],"excludedDates":[]}',
      );
      const envelope = decodeContent(built.object);
      assert.strictEqual(envelope.kind, "event");
      assert.deepStrictEqual(envelope.content, {
        title: "Lugano Bitcoin Evening",
        description: "Monthly meetup. Talks start at 19:00.",
        start: "2026-10-14T18:30:00",
        timeZone: "Europe/Zurich",
        duration: "PT2H30M",
        showWithoutTime: false,
        status: "confirmed",
        locations: [{ name: "Plan ₿ Hub", uri: HUB }],
        attendance: { policy: "open", capacity: null, waitlist: false },
        links: [{ title: "Website", url: "https://planb.network/" }],
        recurrenceRules: [
          { frequency: "monthly", interval: null, firstDayOfWeek: null, byDay: [{ day: "tu", nthOfPeriod: 2 }], byMonthDay: [], byMonth: [], bySetPosition: [], count: null, until: null },
        ],
        excludedDates: [],
        recurrenceOf: null,
        recurrenceId: null,
      });
      // read back as the object it returned, and written back to the same bytes
      const read = decodeObject(built.url, built.body, "post");
      assert.deepStrictEqual(read, built.object);
      assert.strictEqual(text(encodeObject(built.url, read)), text(built.body));
    });

    it("trims display text and leaves times and references as written", () => {
      const built = buildPost(OTTO, {
        ...lugano(),
        title: "　 Evening 　",
        description: " \t ",
        locations: [{ uri: HUB, name: "  Hub  " }],
        links: [{ title: "  Site  ", url: "https://planb.network/" }],
      });
      const { content } = decodeContent(built.object);
      assert.strictEqual(content.title, "Evening");
      assert.strictEqual(content.description, null);
      assert.strictEqual(content.locations[0].name, "Hub");
      assert.strictEqual(content.links[0].title, "Site");
      refuses(() => buildPost(OTTO, { ...lugano(), start: " 2026-10-14T18:30:00" }), "Validation Error: start must be a local date-time of the form YYYY-MM-DDTHH:MM:SS:  2026-10-14T18:30:00");
      refuses(() => buildPost(OTTO, { ...lugano(), locations: [{ uri: " geo:46,8" }] }), "Validation Error: locations[0].uri must be spelled in canonical form:  geo:46,8");
    });

    it("needs a duration unless all day, and a known status", () => {
      refuses(() => buildPost(OTTO, { ...lugano(), duration: null }), "Validation Error: Event duration is required unless showWithoutTime is true");
      const allDay = buildPost(OTTO, { kind: "event", title: "Founders day", start: "2026-01-03T00:00:00", timeZone: "UTC", showWithoutTime: true });
      assert.strictEqual(decodeContent(allDay.object).content.duration, null);
      refuses(() => buildPost(OTTO, { ...lugano(), status: "maybe" }), "Validation Error: Event status must be one of confirmed, tentative, cancelled: maybe");
      refuses(() => buildPost(OTTO, { ...lugano(), duration: "P367D" }), `Validation Error: duration must be at most ${limits.eventDurationMaxSeconds} seconds: P367D`);
      refuses(() => buildPost(OTTO, { ...lugano(), timeZone: "+02:00" }), "Validation Error: timeZone must be an IANA time zone name of at most 64 code points: +02:00");
      refuses(() => buildPost(OTTO, { ...lugano(), title: "t".repeat(101) }), "Validation Error: Event title must be at most 100 code points");
      refuses(() => buildPost(OTTO, { ...lugano(), title: "a\u0000b" }), "Validation Error: Event text must not contain control characters other than tab, newline and carriage return");
      refuses(() => buildPost(OTTO, { ...lugano(), description: "a\u001b" }), /control characters/);
      refuses(() => buildPost(OTTO, { ...lugano(), description: "d".repeat(50001) }), "Validation Error: Event description must be at most 50000 code points");
      refuses(() => buildPost(OTTO, { ...lugano(), locations: [{ uri: HUB, name: "n".repeat(101) }] }), "Validation Error: locations[0].name must be 1 to 100 code points and not blank");
      refuses(() => buildPost(OTTO, { ...lugano(), links: [{ title: "n".repeat(101), url: "https://x.y" }] }), "Validation Error: links[0].title must be 1 to 100 code points and not blank");
      refuses(() => buildPost(OTTO, { ...lugano(), links: Array.from({ length: 11 }, () => ({ title: "n", url: "https://x.y" })) }), "Validation Error: Event cannot have more than 10 links");
      // a link's title is `title`: a `name` is no member of a link
      misuse(() => buildPost(OTTO, { ...lugano(), links: [{ name: "Site", url: "https://x.y" }] }), /input\.links\[0\]\.name must be one of title, url/);
      refuses(() => buildPost(OTTO, { ...lugano(), excludedDates: Array.from({ length: 101 }, () => "2026-11-10T18:30:00") }), "Validation Error: Event cannot have more than 100 excluded dates");
      refuses(() => buildPost(OTTO, { ...lugano(), attendance: { capacity: 1000001 } }), "Validation Error: attendance.capacity must be 1 to 1000000 people");
      misuse(() => buildPost(OTTO, { ...lugano(), attendance: { waitlist: "yes" } }), /input\.attendance\.waitlist must be a boolean/);
    });

    it("holds its locations to the place conventions after the universal gate", () => {
      for (const uri of ["https://www.openstreetmap.org/node/1", "geo:46.00547,8.95186", "https://meet.jit.si/lugano", "nostr:nevent1abc", theirEvent]) {
        assert.strictEqual(buildPost(OTTO, { ...lugano(), locations: [{ uri }] }).object.kind, "event", uri);
      }
      refuses(
        () => buildPost(OTTO, { ...lugano(), locations: [{ uri: "geo:46.0,8" }] }),
        "Validation Error: locations[0].uri must be a geo URI, geo:<lat>,<lon> in decimal degrees with at most 5 fraction digits and no trailing zeros: geo:46.0,8",
      );
      refuses(
        () => buildPost(OTTO, { ...lugano(), locations: [{ uri: `${HUB}/` }] }),
        `Validation Error: locations[0].uri must be a canonical OpenStreetMap object URL, https://www.openstreetmap.org/{node|way|relation}/{id}: ${HUB}/`,
      );
      refuses(() => buildPost(OTTO, { ...lugano(), locations: [{ uri: "https://osm.org/way/1" }] }), /canonical OpenStreetMap/);
      refuses(() => buildPost(OTTO, { ...lugano(), locations: Array.from({ length: 11 }, () => ({ uri: "nowhere" })) }), "Validation Error: Event cannot have more than 10 locations");
      refuses(() => buildPost(OTTO, { ...lugano(), links: [{ title: "Site", url: "http://example.com" }] }), "Validation Error: links[0].url must be an https URL: http://example.com");
      refuses(() => buildPost(OTTO, { ...lugano(), links: [{ title: "Site", url: theirEvent }] }), /links\[0\]\.url must be a canonical web URI/);
    });

    it("takes one recurrence rule inside the caps, and an override of one occurrence", () => {
      refuses(() => buildPost(OTTO, { ...lugano(), recurrenceRules: [{ frequency: "weekly" }, { frequency: "daily" }] }), "Validation Error: Event cannot have more than 1 recurrence rules");
      refuses(
        () => buildPost(OTTO, { ...lugano(), recurrenceRules: [{ frequency: "hourly" }] }),
        "Validation Error: recurrenceRules[0].frequency must be one of yearly, monthly, weekly, daily: hourly",
      );
      refuses(() => buildPost(OTTO, { ...lugano(), recurrenceRules: [{ frequency: "daily", count: 1001 }] }), "Validation Error: recurrenceRules[0].count must be 1 to 1000 occurrences");
      refuses(
        () => buildPost(OTTO, { ...lugano(), recurrenceRules: [{ frequency: "daily", until: "2029-10-14T18:30:01" }] }),
        "Validation Error: recurrenceRules[0].until must be on or after start and at most 3 years after it: 2029-10-14T18:30:01",
      );
      refuses(
        () => buildPost(OTTO, { ...lugano(), recurrenceRules: [{ frequency: "monthly", byDay: [{ day: "mo", nthOfPeriod: 0 }] }] }),
        "Validation Error: recurrenceRules[0].byDay[0].nthOfPeriod must be -53 to 53 and not 0",
      );
      refuses(
        () => buildPost(OTTO, { ...lugano(), recurrenceRules: [{ frequency: "yearly", byMonth: ["13"] }] }),
        "Validation Error: recurrenceRules[0].byMonth[0] must be a month number 1 to 12: 13",
      );
      refuses(() => buildPost(OTTO, { ...lugano(), excludedDates: ["2026-11-10"] }), "Validation Error: excludedDates[0] must be a local date-time of the form YYYY-MM-DDTHH:MM:SS: 2026-11-10");
      const master = `pubky://${OTTO}/pub/social/v1/posts/0035QZPT4QG00`;
      const override = buildPost(OTTO, { ...lugano(), recurrenceRules: [], recurrenceOf: master, recurrenceId: "2026-11-10T18:30:00" });
      assert.strictEqual(decodeContent(override.object).content.recurrenceOf, master);
      refuses(() => buildPost(OTTO, { ...lugano(), recurrenceRules: [], recurrenceOf: master }), "Validation Error: recurrenceOf and recurrenceId are set together, on an override of one occurrence");
      refuses(
        () => buildPost(OTTO, { ...lugano(), recurrenceOf: master, recurrenceId: "2026-11-10T18:30:00" }),
        "Validation Error: an override of one occurrence carries no recurrence rules or excluded dates",
      );
      refuses(
        () => buildPost(OTTO, { ...lugano(), recurrenceRules: [], recurrenceOf: `pubky://${OTTO}/pub/social/v1/profile.json`, recurrenceId: "2026-11-10T18:30:00" }),
        `Validation Error: recurrenceOf must reference a post: pubky://${OTTO}/pub/social/v1/profile.json`,
      );
      // the master is the same author's: the builder knows the author, a validator without one does not
      refuses(
        () => buildPost(OTTO, { ...lugano(), recurrenceRules: [], recurrenceOf: theirEvent, recurrenceId: "2026-11-10T18:30:00" }),
        `Validation Error: recurrenceOf must reference a post of the same author: ${theirEvent}`,
      );
      assert.strictEqual(validatePost({ ...lugano(), recurrenceRules: [], recurrenceOf: theirEvent, recurrenceId: "2026-11-10T18:30:00" }).success, true);
      assert.strictEqual(validatePost({ ...lugano(), recurrenceRules: [], recurrenceOf: theirEvent, recurrenceId: "2026-11-10T18:30:00" }, OTTO).success, false);
    });

    it("carries its cover and lock on the envelope and refuses a parent", () => {
      const built = buildPost(OTTO, { ...lugano(), attachments: [{ uri: "https://example.com/poster.png", alt: "poster" }], lock: `pubky://${OTTO}/pub/app.locks/0035QZPT4QG00.json` });
      assert.strictEqual(built.object.attachments[0].alt, "poster");
      assert.ok(built.object.lock);
      refuses(() => encodeObject(built.url, { ...built.object, parent: theirEvent }), "Validation Error: Event posts cannot have parent or embed");
      misuse(() => buildPost(OTTO, { ...lugano(), parent: theirEvent }), /input\.parent must be one of/);
    });

    it("reads stored bytes as written, members this version does not know kept", () => {
      const url = `pubky://${OTTO}/pub/social/v1/posts/0035QZPT4QG00/0035QZPT4QG00.json`;
      const content = JSON.stringify({ title: " padded ", start: "2026-10-14T18:30:00", timeZone: "UTC", duration: "PT1H", locations: [{ uri: "geo:46,8", floor: 2 }], color: "red" });
      const bytes = utf8(JSON.stringify({ content, kind: "event", parent: null, embed: null, attachments: [] }));
      const read = decodeObject(url, bytes, "post");
      const envelope = decodeContent(read);
      assert.strictEqual(envelope.content.title, " padded ");
      assert.strictEqual(envelope.content.status, "confirmed");
      assert.deepStrictEqual(envelope.content.attendance, { policy: "open", capacity: null, waitlist: false });
      assert.strictEqual(envelope.content.$unknown, '{"color":"red"}');
      assert.strictEqual(envelope.content.locations[0].$unknown, '{"floor":2}');
      assert.strictEqual(text(encodeObject(url, read)), text(bytes));
      // and the envelope edited through encodeContent keeps them, written in the kind's spelling
      const again = encodeContent({ ...envelope.content, title: "Evening" });
      assert.ok(
        again.startsWith('{"title":"Evening","start":"2026-10-14T18:30:00","timeZone":"UTC","duration":"PT1H","showWithoutTime":false,"status":"confirmed","locations":[{"uri":"geo:46,8","floor":2}]'),
      );
      assert.ok(again.endsWith(',"excludedDates":[],"color":"red"}'));
      const edited = editPost(OTTO, url, { ...read, content: again });
      assert.strictEqual(decodeContent(edited.object).content.title, "Evening");
    });

    it("collects every issue for a form", () => {
      const result = validatePost({ ...lugano(), title: " ", start: "soon", attendance: { policy: "rsvp", capacity: 0 }, links: [{ title: "x", url: "http://x.y" }] });
      assert.deepStrictEqual(
        result.issues.map((i) => [i.path.join("."), i.code]),
        [
          ["title", "blank"],
          ["start", "format"],
        ],
      );
      // the start did not parse, so the rules that read it did not run; once it does they do
      const more = validatePost({ ...lugano(), attendance: { policy: "rsvp", capacity: 0 }, links: [{ title: "x", url: "http://x.y" }] });
      assert.deepStrictEqual(
        more.issues.map((i) => [i.path.join("."), i.code, i.limit]),
        [
          ["attendance.policy", "unknown_name", undefined],
          ["attendance.capacity", "range", 1000000],
          ["links.0.url", "reference", undefined],
        ],
      );
    });
  });

  describe("rsvp", () => {
    it("answers an event as a reply, the note trimmed", () => {
      const built = buildPost(OTTO, { kind: "rsvp", parent: theirEvent, status: "accepted", guests: 1, note: "  bringing cake 　" });
      assert.strictEqual(built.object.parent, theirEvent);
      assert.strictEqual(built.object.content, '{"status":"accepted","guests":1,"note":"bringing cake"}');
      assert.deepStrictEqual(decodeContent(built.object), { kind: "rsvp", content: { status: "accepted", recurrenceId: null, guests: 1, note: "bringing cake" } });
      const occurrence = buildPost(OTTO, { kind: "rsvp", parent: theirEvent, status: "tentative", recurrenceId: "2026-11-10T18:30:00" });
      assert.strictEqual(occurrence.object.content, '{"status":"tentative","recurrenceId":"2026-11-10T18:30:00","guests":0}');
      assert.deepStrictEqual(decodeObject(built.url, built.body, "post"), built.object);
    });

    it("refuses what the reference refuses, in its words", () => {
      refuses(() => buildPost(OTTO, { kind: "rsvp", parent: theirEvent, status: "going" }), "Validation Error: Rsvp status must be one of requested, accepted, declined, tentative: going");
      refuses(() => buildPost(OTTO, { kind: "rsvp", parent: theirEvent, status: "accepted", guests: 101 }), "Validation Error: Rsvp guests must be 0 to 100 people");
      refuses(() => buildPost(OTTO, { kind: "rsvp", parent: theirEvent, status: "accepted", guests: -1 }), /Rsvp guests must be 0 to 100 people/);
      refuses(
        () => buildPost(OTTO, { kind: "rsvp", parent: theirEvent, status: "accepted", recurrenceId: "tomorrow" }),
        "Validation Error: recurrenceId must be a local date-time of the form YYYY-MM-DDTHH:MM:SS: tomorrow",
      );
      refuses(() => buildPost(OTTO, { kind: "rsvp", parent: `${theirEvent}/0035QZPT4QG00.json`, status: "accepted" }), /parent must be versionless/);
      refuses(() => buildPost(OTTO, { kind: "rsvp", parent: theirEvent, status: "accepted", guests: 1.5 }), "Validation Error: invalid type: floating point `1.5`, expected i64");
      refuses(() => buildPost(OTTO, { kind: "rsvp", parent: theirEvent, status: "accepted", note: "n".repeat(2001) }), "Validation Error: Rsvp note must be at most 2000 code points");
      const url = `pubky://${OTTO}/pub/social/v1/posts/0035QZPT4QG00/0035QZPT4QG00.json`;
      refuses(
        () => decodeObject(url, utf8('{"content":"{\\"status\\":\\"accepted\\"}","kind":"rsvp","parent":null,"embed":null,"attachments":[]}'), "post"),
        "Validation Error: Rsvp posts must have a parent, the event they answer",
      );
      refuses(
        () => decodeObject(url, utf8(`{"content":"{\\"status\\":\\"accepted\\",\\"note\\":\\" \\"}","kind":"rsvp","parent":"${theirEvent}","embed":null,"attachments":[]}`), "post"),
        "Validation Error: Rsvp note must not be blank",
      );
      refuses(
        () => decodeObject(url, utf8(`{"content":"{\\"status\\":\\"accepted\\"}","kind":"rsvp","parent":"${theirEvent}","embed":"https://x.y","attachments":[]}`), "post"),
        "Validation Error: Rsvp posts cannot have embed or attachments",
      );
      misuse(() => buildPost(OTTO, { kind: "rsvp", parent: theirEvent, status: "accepted", attachments: [] }), /input\.attachments must be one of/);
    });
  });

  describe("rating", () => {
    it("puts stars on a thing, the text trimmed, photos on the attachments", () => {
      const built = buildPost(OTTO, { kind: "rating", parent: HUB, rating: 7, text: "  great coffee  " });
      assert.strictEqual(built.object.parent, HUB);
      assert.strictEqual(built.object.content, '{"rating":7,"text":"great coffee"}');
      assert.deepStrictEqual(decodeContent(built.object), { kind: "rating", content: { rating: 7, text: "great coffee" } });
      assert.strictEqual(buildPost(OTTO, { kind: "rating", parent: HUB, rating: 10, text: " " }).object.content, '{"rating":10}');
      const withPhoto = buildPost(OTTO, { kind: "rating", parent: "geo:46.00547,8.95186", rating: 9, attachments: [{ uri: "https://example.com/a.png" }] });
      assert.strictEqual(withPhoto.object.attachments.length, 1);
      assert.deepStrictEqual(decodeObject(built.url, built.body, "post"), built.object);
    });

    it("holds the scale of 1 to 10 half stars", () => {
      for (const stars of [1, 5, 10]) assert.strictEqual(decodeContent(buildPost(OTTO, { kind: "rating", parent: HUB, rating: stars }).object).content.rating, stars);
      for (const bad of [0, 11, -1]) refuses(() => buildPost(OTTO, { kind: "rating", parent: HUB, rating: bad }), "Validation Error: Rating must be 1 to 10 half stars");
      refuses(() => buildPost(OTTO, { kind: "rating", parent: HUB, rating: 7.5 }), "Validation Error: invalid type: floating point `7.5`, expected i64");
      refuses(() => buildPost(OTTO, { kind: "rating", parent: HUB, rating: 7, text: "t".repeat(2001) }), "Validation Error: Rating text must be at most 2000 code points");
      const url = `pubky://${OTTO}/pub/social/v1/posts/0035QZPT4QG00/0035QZPT4QG00.json`;
      refuses(
        () => decodeObject(url, utf8('{"content":"{\\"rating\\":7}","kind":"rating","parent":null,"embed":null,"attachments":[]}'), "post"),
        "Validation Error: Rating posts must have a parent, the thing they rate",
      );
      refuses(
        () => decodeObject(url, utf8(`{"content":"{\\"rating\\":7}","kind":"rating","parent":"${HUB}","embed":"https://x.y","attachments":[]}`), "post"),
        "Validation Error: Rating posts cannot have embed",
      );
      const result = validatePost({ kind: "rating", parent: HUB, rating: 0 });
      assert.deepStrictEqual(result.issues, [{ path: ["rating"], code: "range", message: "Rating must be 1 to 10 half stars", limit: 10 }]);
    });
  });

  describe("publishing", () => {
    it("publishes a private event with its private cover copied, and refuses a private location", () => {
      const media = `pubky://${OTTO}/priv/social/v1/files/0000000000000000000000000G.png`;
      const draft = buildPost(OTTO, { ...lugano(), root: "private", attachments: [{ uri: media }] });
      const plan = planPublish(OTTO, { id: draft.id, editId: draft.editId, post: draft.object });
      assert.strictEqual(plan.copies.length, 1);
      assert.ok(plan.put.object.attachments[0].uri.startsWith(`pubky://${OTTO}/pub/`));
      const located = buildPost(OTTO, { ...lugano(), root: "private", locations: [{ uri: `pubky://${OTTO}/priv/social/v1/posts/0035QZPT4QG00` }] });
      refuses(() => planPublish(OTTO, { id: located.id, editId: located.editId, post: located.object }), /cannot publish: a public post cannot reference a private object/);
    });
  });

  it("encodeContent tells the envelopes apart, or takes the kind", () => {
    const event = decodeContent(buildPost(OTTO, lugano()).object).content;
    assert.ok(encodeContent(event).startsWith('{"title":"Lugano Bitcoin Evening","description"'));
    assert.strictEqual(encodeContent(event, "event"), encodeContent(event));
    assert.strictEqual(encodeContent({ status: "accepted", recurrenceId: null, guests: 0, note: null }), '{"status":"accepted","guests":0}');
    assert.strictEqual(encodeContent({ rating: 3, text: null }), '{"rating":3}');
    misuse(() => encodeContent({ nothing: 1 }), /content must be an envelope/);
    refuses(() => encodeContent(event, "note"), /unknown variant `note`/);
    // an article still goes by its title, and an event's title does not make it one
    assert.strictEqual(encodeContent({ title: "t", body: "b", cover_image: null }), '{"title":"t","body":"b"}');
  });
});

describe("bounds before references", () => {
  beforeEach(() => setClock(() => T0));
  after(() => setClock());

  const id = "0035QZPT4QG00";
  const privatePost = `pubky://${OTTO}/priv/social/v1/posts/${id}`;
  // An event version whose list of `n` locations ends in the owner's private post
  const draft = (kind, n, pad = 0) => {
    const items = Array.from({ length: n - 1 }, () => ({ uri: "geo:0,0" }));
    items.push({ uri: privatePost });
    const envelope = { title: "t", start: "2026-10-14T18:30:00", timeZone: "UTC", duration: "PT1H", locations: items, ...(pad > 0 ? { description: "d".repeat(pad) } : {}) };
    return { content: JSON.stringify(envelope), kind, parent: null, embed: null, attachments: [], lock: null };
  };
  const publish = (post) => planPublish(OTTO, { id, editId: id, post });

  it("publish refuses an oversized list by its cap, before it reads a reference in it", () => {
    refuses(() => publish(draft("event", 10)), /cannot reference a private object/);
    refuses(() => publish(draft("event", 11)), "Validation Error: Event cannot have more than 10 locations");
    refuses(() => publish(draft("event", 2, limits.eventContentMaxLength)), `Validation Error: Event content must be at most ${limits.eventContentMaxLength} code points`);
  });

  it("publish keeps the 1.0 order for the 1.0 kinds: their references first", () => {
    const items = Array.from({ length: 101 }, () => ({ uri: privatePost }));
    const collection = { content: JSON.stringify({ name: "c", items }), kind: "collection", parent: null, embed: null, attachments: [], lock: null };
    refuses(() => publish(collection), `Validation Error: cannot publish: a public post cannot reference a private object: ${privatePost}`);
    const attachments = Array.from({ length: 11 }, () => ({ uri: "https://example.com/a.png", alt: null, name: null }));
    const note = { content: "n", kind: "note", parent: privatePost, embed: null, attachments, lock: null };
    refuses(() => publish(note), /cannot reference a private object/);
    refuses(() => publish({ ...note, attachments: [], content: "n".repeat(limits.postMaxBytes) }), /cannot reference a private object/);
  });

  it("a list of 150,000 is refused by the byte cap, never walked into an argument list", () => {
    const huge = draft("event", 150_000);
    refuses(() => publish(huge), `Validation Error: object exceeds ${limits.postMaxBytes} bytes`);
    refuses(() => encodeObject({ kind: "post", root: "private" }, huge), `Validation Error: object exceeds ${limits.postMaxBytes} bytes`);
    refuses(() => decodeObject({ kind: "post", root: "private" }, utf8(JSON.stringify(huge))), `Validation Error: object exceeds ${limits.postMaxBytes} bytes`);
  });

  it("validation checks a raw content cap before it parses", () => {
    const max = limits.eventContentMaxLength;
    refuses(() => encodeObject({ kind: "post", root: "private" }, draft("event", 11, max)), `Validation Error: Event content must be at most ${max} code points`);
    for (const [kind, name, cap] of [
      ["rsvp", "Rsvp", limits.rsvpContentMaxLength],
      ["rating", "Rating", limits.ratingContentMaxLength],
    ]) {
      const post = { content: "[".repeat(cap + 1), kind, parent: `pubky://${OTTO}/pub/social/v1/posts/${id}`, embed: null, attachments: [], lock: null };
      refuses(() => encodeObject({ kind: "post", root: "private" }, post), `Validation Error: ${name} content must be at most ${cap} code points`);
      assert.strictEqual(validatePost({ kind: "rating", parent: theirEvent, rating: 3, text: "t".repeat(2000) }).success, true);
    }
  });
});
