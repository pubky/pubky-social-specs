# Changelog

`pubky-social-migrator` is released with `pubky-social-specs`, at the same version, and depends on
exactly that version of it. Its promises about the stored bytes are the data model's, in the
`pubky-social-specs` changelog.

## Unreleased

### Stored bytes

- `transformRev` is 4: the article transform promotes the first attachment to the cover only when
  the body does not reference `attachment:0`, and renumbers the body's inline references when it
  does promote (the `pubky-social-specs` changelog has the rule). A tree whose flag records
  revision 3 is walked again; nothing already written is rewritten.

## 1.0.0-rc.1

### API

- The migration leaves `pubky-social-specs` for this package: `pubky-social-specs/migration` is
  `pubky-social-migrator`, `pubky-social-specs/migration/pubky-sdk` is
  `pubky-social-migrator/pubky-sdk`, and the `pubky-social-migrate` CLI is here.
- `ENGINE_CAPS` and `MIGRATION_CAPS` are no longer exported here: import them from
  `pubky-social-specs`.
- `SdkSession` is the `SocialSession` of `pubky-social-specs/client`, the one session type both
  packages take.
- The lock a run takes is named `pubky-social-migrator:<owner>`.

### Stored bytes

- None. The engine keys a 0.x path through the wasm's `stableKey` and `legacyMediaKey`, the crate's
  own, where it used a TypeScript copy held equal to them.
