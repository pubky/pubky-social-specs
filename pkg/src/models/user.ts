import { checkReference } from "../canonicalize.js";
import { limits } from "../data.js";
import { fail } from "../errors.js";
import { checkPublicKey } from "../ids.js";
import { type Extra, inputOf, list, object, option, string } from "../json/schema.js";
import { codePointLen, frozenTrim, trimmedOrNull } from "../text.js";
import { socialPath } from "../uri.js";
import { checkExtra, type Model, validate } from "./common.js";

export interface UserLink extends Extra {
  title: string;
  url: string;
}

export interface User extends Extra {
  name: string;
  bio: string | null;
  image: string | null;
  links: UserLink[] | null;
  status: string | null;
}

const link = object<UserLink>("PubkySocialUserLink", { title: string, url: string });

function checkLink(value: UserLink, index: number): void {
  checkExtra(value.extra);
  if (frozenTrim(value.title) === "") fail(`links[${index}].title must not be blank`, `links[${index}].title`);
  if (codePointLen(value.title) > limits.userLinkTitleMaxLength) {
    fail(`links[${index}].title must be at most ${limits.userLinkTitleMaxLength} code points`, `links[${index}].title`);
  }
  checkReference(`links[${index}].url`, value.url, "web", limits.userLinkUrlMaxLength, true, null);
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
  check(value) {
    checkExtra(value.extra);
    // Padding is display text, so it is counted, not removed; only whitespace is still no name
    if (frozenTrim(value.name) === "") fail("name must not be blank", "name");
    const length = codePointLen(value.name);
    if (length < limits.userNameMinLength || length > limits.userNameMaxLength) fail("Invalid name length", "name");
    if (value.bio !== null) {
      if (frozenTrim(value.bio) === "") fail("bio must not be blank", "bio");
      if (codePointLen(value.bio) > limits.userBioMaxLength) fail("Bio exceeds maximum length", "bio");
    }
    if (value.image !== null) checkReference("image", value.image, "pubky or web", limits.imageUrlMaxLength, true, null);
    if (value.links !== null) {
      if (value.links.length > limits.userLinksMaxCount) fail("Too many links", "links");
      value.links.forEach(checkLink);
    }
    if (value.status !== null) {
      if (frozenTrim(value.status) === "") fail("status must not be blank", "status");
      if (codePointLen(value.status) > limits.userStatusMaxLength) fail("Status exceeds maximum length", "status");
    }
  },
};

const maybe = option(string);

/** A fresh profile. The builder trims the display text; references are stored as written. */
export function buildUser(owner: string, input: unknown) {
  checkPublicKey(owner);
  const i = inputOf(input, "input", ["name", "bio", "image", "links", "status"]);
  const links = option(list({ ...link, parse: (js, at) => {
    const l = inputOf(js, at, ["title", "url"]);
    return { title: frozenTrim(string.parse(l.title, `${at}.title`)), url: string.parse(l.url, `${at}.url`), extra: new Map() };
  } }));
  const value: User = {
    name: frozenTrim(string.parse(i.name, "input.name")),
    bio: trimmedOrNull(maybe.parse(i.bio, "input.bio")),
    image: maybe.parse(i.image, "input.image"),
    links: links.parse(i.links, "input.links"),
    status: trimmedOrNull(maybe.parse(i.status, "input.status")),
    extra: new Map(),
  };
  return { id: "", path: socialPath("public", "profile.json"), value, body: validate(user, value, null, true) };
}
