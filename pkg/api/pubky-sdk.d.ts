import type { MigrationPort } from "../port.js";
import type { SdkSession } from "../../session.js";
export type { SdkResponse, SdkSession } from "../../session.js";
export interface SdkPortOptions {
    /** URLs per LIST page, 1 to 1000; the homeserver caps it at 1000. */
    pageSize?: number;
    /**
     * Milliseconds a read may wait for its answer before it counts as `network`, 60000 by
     * default: LIST, HEAD and the GET of a JSON object. A blob's GET grows with its size, and a
     * write (`putJson`, `putBytes`, DELETE) stays pending until the SDK settles it: the SDK takes
     * no signal, and a write abandoned at a deadline could still land after a later run cleaned
     * up behind it.
     */
    deadlineMs?: number;
}
/**
 * The migration port over a signed-in session of `@synonymdev/pubky` >=0.11 <1: every URL has to
 * be in the session owner's tree. `ifAbsent` is a HEAD then the PUT, which leaves a one round
 * trip window.
 */
declare const sdkPort: (session: SdkSession, options?: SdkPortOptions) => MigrationPort;
export { sdkPort };
//# sourceMappingURL=pubky-sdk.d.ts.map