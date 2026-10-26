// The session grants an app asks for.

/**
 * The scopes a 1.x client writes, and all the migration engine of `pubky-social-migrator`
 * checks a session for: both 1.x roots. Reading and listing the 0.x tree is anonymous.
 *
 * @example
 * ```ts
 * import { ENGINE_CAPS } from "pubky-social-specs";
 * console.log(ENGINE_CAPS.split(","));
 * ```
 */
export const ENGINE_CAPS = "/pub/social/v1/:rw,/priv/social/v1/:rw";

/**
 * The full session grant of a migrating pubky-app: `ENGINE_CAPS`, the app's own private
 * namespace, and the 0.x tree, which deleting a migrated object later still reaches. The
 * engine does not check it; it is what the app asks for when it upgrades a session.
 *
 * @example
 * ```ts
 * import { MIGRATION_CAPS } from "pubky-social-specs";
 * // The capabilities a migrating app asks for when it upgrades a session
 * console.log(MIGRATION_CAPS.split(","));
 * ```
 */
export const MIGRATION_CAPS = `${ENGINE_CAPS},/priv/app.pubky/v1/:rw,/pub/pubky.app/:rw`;
