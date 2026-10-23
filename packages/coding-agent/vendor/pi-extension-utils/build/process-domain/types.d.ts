export declare const PROCESS_DOMAIN_PROTOCOL: 1;
export type ProcessDomainTransport = "ipc" | "tcp-loopback";
export type ProcessDomainRole = "host" | "client";
export type PeerStatus = "online" | "offline";
export interface ProcessDomainDeclaration {
    readonly version: typeof PROCESS_DOMAIN_PROTOCOL;
    readonly domainId: string;
    readonly endpoint: string;
    readonly capability: string;
    readonly hostNodeId: string;
}
export interface ProcessDomainPeer {
    readonly nodeId: string;
    readonly status: PeerStatus;
    readonly metadata: Readonly<Record<string, string>>;
    readonly connectedAt: number;
    readonly disconnectedAt?: number;
}
export interface ProcessDomainDataMessage<T = unknown> {
    readonly id: string;
    readonly channel: string;
    readonly value: T;
    readonly senderId: string;
    readonly targetId: string;
    readonly receivedAt: number;
}
export type PiLifecycleEventName = "session_start" | "agent_start" | "agent_end" | "agent_settled" | "turn_start" | "turn_end" | "session_shutdown";
export interface PiLifecycleEvent {
    readonly name: PiLifecycleEventName;
    readonly at: number;
    readonly sessionId?: string;
    readonly details?: Readonly<Record<string, unknown>>;
}
export type ProcessDomainEvent = {
    readonly type: "peer";
    readonly peer: ProcessDomainPeer;
} | {
    readonly type: "lifecycle";
    readonly senderId: string;
    readonly event: PiLifecycleEvent;
} | {
    readonly type: "transport";
    readonly transport: ProcessDomainTransport;
    readonly endpoint: string;
};
export interface SendOptions {
    readonly timeoutMs?: number;
}
export interface ProcessDomainNode {
    readonly role: ProcessDomainRole;
    readonly nodeId: string;
    readonly transport: ProcessDomainTransport;
    readonly endpoint: string;
    readonly declaration: ProcessDomainDeclaration;
    peers(): readonly ProcessDomainPeer[];
    send<T>(targetId: string, channel: string, value: T, options?: SendOptions): Promise<void>;
    broadcast<T>(channel: string, value: T, options?: SendOptions): Promise<void>;
    reportLifecycle(event: PiLifecycleEvent, options?: SendOptions): Promise<void>;
    subscribe(channel: string, listener: (message: ProcessDomainDataMessage) => void): () => void;
    subscribeEvents(listener: (event: ProcessDomainEvent) => void): () => void;
    close(): Promise<void>;
}
export interface OpenProcessDomainOptions {
    readonly env?: NodeJS.ProcessEnv;
    readonly metadata?: Readonly<Record<string, string>>;
    readonly connectTimeoutMs?: number;
    readonly heartbeatIntervalMs?: number;
    readonly heartbeatTimeoutMs?: number;
    readonly heartbeatTimeToLiveMs?: number;
    readonly onError?: (error: Error) => void;
}
/**
 * A reference-counted handle over one shared ProcessDomainNode.
 *
 * Multiple extensions in the same JS realm (e.g. two watchdog plugins each
 * bundling their own copy of this package) must not race for the env-based
 * host/client election: the first opener would become host and silently
 * demote every later opener to client. openSharedProcessDomain returns the
 * same live node to every caller in the realm; the underlying node closes
 * only when the last handle is closed.
 */
export interface SharedProcessDomainHandle extends ProcessDomainNode {
    /** Close this handle. Closes the underlying node when refcount reaches 0. */
    release(): Promise<void>;
}
export interface PiLifecycleExtensionApi {
    on(event: PiLifecycleEventName, handler: (event: unknown, context: unknown) => void | Promise<void>): void;
}
export interface PiLifecycleAttachment {
    close(): void;
}
