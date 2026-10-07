import { checkReference } from "../canonicalize.js";
import { limits } from "../data.js";
import { fail } from "../errors.js";
import { checkPublicKey } from "../ids.js";
import { closed, type Extra, list, open, option, string } from "../json/schema.js";
import { codePointLen, frozenTrim } from "../text.js";
import { socialPath } from "../uri.js";
import { checkExtra, type Model, parse, SIZES, validate } from "./common.js";

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

const link = open<UserLink>("PubkySocialUserLink", { title: { codec: string }, url: { codec: string } });

function checkLink(value: UserLink, index: number): void {
  checkExtra(value.extra);
  if (frozenTrim(value.title) === "") fail(`links[${index}].title must not be blank`);
  if (codePointLen(value.title) > limits.userLinkTitleMaxLength) {
    fail(`links[${index}].title must be at most ${limits.userLinkTitleMaxLength} code points`);
  }
  checkReference(`links[${index}].url`, value.url, "web", limits.userLinkUrlMaxLength, true, null);
}

export const user: Model<User> = {
  codec: open<User>("PubkySocialUser", {
    name: { codec: string },
    bio: { codec: option(string) },
    image: { codec: option(string) },
    links: { codec: option(list(link)) },
    status: { codec: option(string) },
  }),
  maxBytes: SIZES.object,
  // The profile has one root, the public one, whatever root a caller reads it under
  check(value) {
    checkExtra(value.extra);
    // Padding is display text, so it is counted, not removed; only whitespace is still no name
    if (frozenTrim(value.name) === "") fail("name must not be blank");
    const length = codePointLen(value.name);
    if (length < limits.userNameMinLength || length > limits.userNameMaxLength) fail("Invalid name length");
    if (value.bio !== null) {
      if (frozenTrim(value.bio) === "") fail("bio must not be blank");
      if (codePointLen(value.bio) > limits.userBioMaxLength) fail("Bio exceeds maximum length");
    }
    if (value.image !== null) checkReference("image", value.image, "pubky or web", limits.imageUrlMaxLength, true, null);
    if (value.links !== null) {
      if (value.links.length > limits.userLinksMaxCount) fail("Too many links");
      value.links.forEach(checkLink);
    }
    if (value.status !== null) {
      if (frozenTrim(value.status) === "") fail("status must not be blank");
      if (codePointLen(value.status) > limits.userStatusMaxLength) fail("Status exceeds maximum length");
    }
  },
};

interface UserInput {
  name: string;
  bio: string | null;
  image: string | null;
  links: { title: string; url: string }[] | null;
  status: string | null;
}

const none = { absent: () => null };
const input = closed<UserInput>("UserInput", {
  name: { codec: string },
  bio: { codec: option(string), ...none },
  image: { codec: option(string), ...none },
  links: { codec: option(list(closed<{ title: string; url: string }>("LinkInput", { title: { codec: string }, url: { codec: string } }))), ...none },
  status: { codec: option(string), ...none },
});

const trimmedOrNull = (text: string | null) => (text === null ? null : frozenTrim(text) || null);

/** A fresh profile from the JSON text of its input. The builder trims the display text. */
export function buildUser(owner: string, inputJson: string): { path: string; value: User; body: string } {
  checkPublicKey(owner);
  const i = parse(input, inputJson);
  const value: User = {
    name: frozenTrim(i.name),
    bio: trimmedOrNull(i.bio),
    image: i.image,
    links: i.links?.map((l) => ({ title: frozenTrim(l.title), url: l.url, extra: new Map() })) ?? null,
    status: trimmedOrNull(i.status),
    extra: new Map(),
  };
  return { path: socialPath("public", "profile.json"), value, body: validate(user, value, null, true) };
}
