import type { ProcessDomainTransport } from "./types.js";
export interface BoundEndpoint {
    readonly transport: ProcessDomainTransport;
    readonly endpoint: string;
}
/**
 * The process domain always runs on loopback TCP via node:net so the same code
 * path works on Node.js, Deno, and Bun without native addons or per-runtime
 * adapters. The "ipc" transport name remains in the public types for wire
 * compatibility with older declarations but is no longer selected.
 */
export declare function preferredTransport(): ProcessDomainTransport;
export declare function wildcardEndpoint(transport?: ProcessDomainTransport): string;
