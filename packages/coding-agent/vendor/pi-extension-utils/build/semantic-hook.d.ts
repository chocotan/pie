export declare const SEMANTIC_HOOK_CHANNEL: "pi:semantic-hook:v1";
export interface SemanticHookV1 {
    readonly version: 1;
    readonly name: string;
    readonly values?: Readonly<Record<string, string>>;
}
export interface SemanticHookInput {
    readonly name: string;
    readonly values?: Readonly<Record<string, string>>;
}
export type ParseSemanticHookResult = {
    ok: true;
    envelope: SemanticHookV1;
} | {
    ok: false;
    reason: string;
};
/** Structural subset of Pi's shared EventBus. No Pi runtime import required. */
export interface SemanticHookEvents {
    emit(channel: string, data: unknown): void;
    on(channel: string, listener: (data: unknown) => void): () => void;
}
/** Contain hostile Proxy traps as bounded validation failures. */
export declare function parseSemanticHook(data: unknown): ParseSemanticHookResult;
/** Build, validate, freeze, and synchronously publish one semantic hook. */
export declare function publishSemanticHook(events: Pick<SemanticHookEvents, "emit">, input: SemanticHookInput): SemanticHookV1;
/** Subscribe to valid hooks. Malformed payloads are reported but never delivered. */
export declare function subscribeSemanticHooks(events: Pick<SemanticHookEvents, "on">, listener: (envelope: SemanticHookV1) => void, onInvalid?: (reason: string) => void): () => void;
