import { checkReference } from "../canonicalize.js";
import { limits } from "../data.js";
import { type Each, fail, member, throwing } from "../errors.js";
import { checkPublicKey } from "../ids.js";
import { type Extra, inputOf, list, object, option, string } from "../json/schema.js";
import { codePointLen, frozenTrim, trimmedOrNull } from "../text.js";
import { socialPath } from "../path.js";
import { checkExtra, type Model, validate } from "./common.js";

export interface UserLink extends Extra {
  /** The link's label, trimmed by the builder: 1 to 100 code points, not blank. */
  title: string;
  /** A canonical `http://` or `https://` URL, stored as written: at most 300 code points. */
  url: string;
}

export interface User extends Extra {
  /** The display name, trimmed by the builder: 3 to 50 code points, not blank. */
  name: string;
  /** A short description, trimmed by the builder: at most 160 code points; null for none. */
  bio: string | null;
  /** The avatar: a canonical pubky or web URI of at most 300 code points, never under the private root; null for none. */
  image: string | null;
  /** At most 5 links shown on the profile; null for none. */
  links: UserLink[] | null;
  /** A status line, trimmed by the builder: at most 50 code points; null for none. */
  status: string | null;
}

const link = object<UserLink>("PubkySocialUserLink", { title: string, url: string });

function checkLink(value: UserLink, index: number, each: Each): void {
  each(() => checkExtra(value.extra, `links[${index}].`));
  each(() => {
    if (frozenTrim(value.title) === "") fail("blank", `links[${index}].title must not be blank`, `links[${index}].title`);
    if (codePointLen(value.title) > limits.userLinkTitleMaxLength) {
      fail("length", `links[${index}].title must be at most ${limits.userLinkTitleMaxLength} code points`, `links[${index}].title`, limits.userLinkTitleMaxLength);
    }
  });
  each(() => checkReference(`links[${index}].url`, value.url, "web", limits.userLinkUrlMaxLength, true, null));
}

export const user: Model<User> = {
  codec: object<User>("PubkySocialUser", {
    name: string,
    bio: option(string),
    image: option(string),
    links: option(list(link)),
    status: option(string),
  }),
  maxBytes: limits.objectMaxBytes,
  // The profile has one root, the public one, whatever root a caller reads it under
  check(value, _id, _publicRoot, each) {
    each(() => checkExtra(value.extra));
    // Padding is display text, so it is counted, not removed; only whitespace is still no name
    each(() => {
      if (frozenTrim(value.name) === "") fail("blank", "name must not be blank", "name");
      const length = codePointLen(value.name);
      if (length < limits.userNameMinLength || length > limits.userNameMaxLength)
        fail(
          "length",
          `name must be ${limits.userNameMinLength} to ${limits.userNameMaxLength} code points`,
          "name",
          length < limits.userNameMinLength ? limits.userNameMinLength : limits.userNameMaxLength,
        );
    });
    each(() => {
      if (value.bio === null) return;
      if (frozenTrim(value.bio) === "") fail("blank", "bio must not be blank", "bio");
      if (codePointLen(value.bio) > limits.userBioMaxLength) fail("length", `bio must be at most ${limits.userBioMaxLength} code points`, "bio", limits.userBioMaxLength);
    });
    const { image } = value;
    if (image !== null) each(() => checkReference("image", image, "pubky or web", limits.imageUrlMaxLength, true, null));
    if (value.links !== null) {
      const links = value.links;
      each(() => {
        if (links.length > limits.userLinksMaxCount) fail("count", `Too many links (max: ${limits.userLinksMaxCount})`, "links", limits.userLinksMaxCount);
      });
      links.forEach((link, index) => checkLink(link, index, each));
    }
    each(() => {
      if (value.status === null) return;
      if (frozenTrim(value.status) === "") fail("blank", "status must not be blank", "status");
      if (codePointLen(value.status) > limits.userStatusMaxLength) fail("length", `status must be at most ${limits.userStatusMaxLength} code points`, "status", limits.userStatusMaxLength);
    });
  },
};

const maybe = option(string);

/**
 * A fresh profile. The builder trims the display text; references are stored as written. A
 * validator passes a collecting `each` and no owner.
 */
export function buildUser(owner: string | null, input: unknown, each: Each = throwing) {
  if (owner !== null) checkPublicKey(owner);
  const i = inputOf(input, "input", ["name", "bio", "image", "links", "status"], each);
  const links = option(
    list({
      ...link,
      parse: (js, at) => {
        const l = inputOf(js, at, ["title", "url"], each);
        return { title: frozenTrim(member(each, () => string.parse(l.title, `${at}.title`), "")), url: member(each, () => string.parse(l.url, `${at}.url`), ""), extra: new Map() };
      },
    }),
  );
  const value: User = {
    name: frozenTrim(member(each, () => string.parse(i.name, "input.name"), "")),
    bio: trimmedOrNull(member(each, () => maybe.parse(i.bio, "input.bio"), null)),
    image: member(each, () => maybe.parse(i.image, "input.image"), null),
    links: member(each, () => links.parse(i.links, "input.links"), null),
    status: trimmedOrNull(member(each, () => maybe.parse(i.status, "input.status"), null)),
    extra: new Map(),
  };
  return { id: "", path: socialPath("public", "profile.json"), value, body: validate(user, value, null, true, each) };
}
