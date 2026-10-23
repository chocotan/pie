import type { PiLifecycleEvent, ProcessDomainDeclaration } from "./types.js";
export declare const ENV_NAMES: {
    readonly DECLARATION: "PI_EXTENSION_UTILS_PROCESS_DOMAIN";
};
export declare const MAX_MESSAGE_BYTES: number;
export declare const MAX_CHANNEL_LENGTH = 128;
export declare const MAX_NODE_ID_LENGTH = 128;
export type WireEnvelope = {
    readonly version: 1;
    readonly type: "challenge-request";
    readonly phase: "bootstrap" | "hello";
    readonly domainId: string;
    readonly nodeId: string;
    readonly clientNonce: string;
} | {
    readonly version: 1;
    readonly type: "challenge";
    readonly phase: "bootstrap" | "hello";
    readonly domainId: string;
    readonly nodeId: string;
    readonly clientNonce: string;
    readonly serverNonce: string;
} | {
    readonly version: 1;
    readonly type: "bootstrap";
    readonly domainId: string;
    readonly nodeId: string;
    readonly metadata: Readonly<Record<string, string>>;
    readonly clientNonce: string;
    readonly serverNonce: string;
    readonly proof: string;
} | {
    readonly version: 1;
    readonly type: "bootstrap-ready";
    readonly domainId: string;
    readonly nodeId: string;
    readonly endpoint: string;
    readonly clientNonce: string;
    readonly serverNonce: string;
    readonly proof: string;
} | {
    readonly version: 1;
    readonly type: "hello";
    readonly domainId: string;
    readonly nodeId: string;
    readonly clientNonce: string;
    readonly serverNonce: string;
    readonly proof: string;
} | {
    readonly version: 1;
    readonly type: "ready";
    readonly domainId: string;
    readonly nodeId: string;
    readonly clientNonce: string;
    readonly serverNonce: string;
    readonly proof: string;
} | {
    readonly version: 1;
    readonly type: "data";
    readonly id: string;
    readonly channel: string;
    readonly value: unknown;
    readonly senderId: string;
    readonly targetId: string;
} | {
    readonly version: 1;
    readonly type: "lifecycle";
    readonly id: string;
    readonly senderId: string;
    readonly event: PiLifecycleEvent;
} | {
    readonly version: 1;
    readonly type: "ack";
    readonly id: string;
} | {
    readonly version: 1;
    readonly type: "ping";
    readonly id: string;
} | {
    readonly version: 1;
    readonly type: "pong";
    readonly id: string;
};
export declare function randomId(bytes?: number): string;
export declare function isValidId(value: unknown): value is string;
export declare function isValidChannel(value: unknown): value is string;
export declare function encodeEnvelope(envelope: WireEnvelope): Buffer;
export declare function decodeEnvelope(frame: Buffer): WireEnvelope;
export declare function encodeDeclaration(declaration: ProcessDomainDeclaration): string;
export declare function decodeDeclaration(value: string | undefined): ProcessDomainDeclaration | null;
export type ProofLabel = "bootstrap" | "bootstrap-ready" | "hello" | "ready";
export declare function createProof(capability: string, label: ProofLabel, values: readonly unknown[]): string;
export declare function verifyProof(capability: string, label: ProofLabel, values: readonly unknown[], proof: unknown): boolean;
