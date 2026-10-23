import { type OpenProcessDomainOptions, type PiLifecycleExtensionApi, type ProcessDomainNode, type SharedProcessDomainHandle } from "./types.js";
export * from "./types.js";
export { isProcessDomainOpenError, ProcessDomainOpenError, type ProcessDomainOpenErrorCode, } from "./errors.js";
export { ENV_NAMES } from "./protocol.js";
export { preferredTransport, wildcardEndpoint } from "./endpoint.js";
export declare function openProcessDomain(options?: OpenProcessDomainOptions): Promise<ProcessDomainNode>;
/**
 * Open (or join) the single shared process-domain node for this JS realm.
 *
 * The first call hosts the domain and publishes the declaration to `env`;
 * later calls in the same realm return a new handle over the same node
 * instead of degrading to a client of the first caller. Handles are
 * reference counted: the node closes only when every handle is released.
 *
 * Per-caller options (metadata, onError) apply only when this call is the
 * one that actually opens the node; joining callers share the open caller's
 * wiring, matching how a single shared node must behave.
 */
export declare function openSharedProcessDomain(options?: OpenProcessDomainOptions): Promise<SharedProcessDomainHandle>;
export declare function attachPiLifecycle(node: ProcessDomainNode, pi: PiLifecycleExtensionApi, sessionId?: string): {
    close(): void;
};
