import type { MigrationPort } from "../port.js";
/** The part of a streamed `Response` the port reads. */
export interface SdkResponse {
    headers: {
        get(name: string): string | null;
    };
    body: {
        getReader(): {
            read(): Promise<{
                done: boolean;
                value?: Uint8Array;
            }>;
            cancel(): Promise<void>;
        };
        cancel(): Promise<void>;
    } | null;
    arrayBuffer(): Promise<ArrayBuffer>;
}
/** The part of a signed-in SDK `Session` the port calls, as 0.11 to 0.14 declare it. */
export interface SdkSession {
    info: {
        publicKey: {
            z32(): string;
        };
    };
    storage: {
        list(path: string, cursor: string | null, reverse: boolean, limit: number, shallow: boolean): Promise<string[]>;
        getBytes(path: string): Promise<Uint8Array>;
        get(path: string): Promise<SdkResponse>;
        exists(path: string): Promise<boolean>;
        putJson(path: string, body: unknown): Promise<void>;
        putBytes(path: string, bytes: Uint8Array): Promise<void>;
        delete(path: string): Promise<void>;
    };
}
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