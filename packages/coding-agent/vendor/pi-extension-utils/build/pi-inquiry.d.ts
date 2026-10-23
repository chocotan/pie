export declare const INQUIRY_PROTOCOL_VERSION: 1;
export declare const MAX_INQUIRY_CONTENT_CODE_POINTS = 65536;
export interface InquiryCorrelation {
    readonly version: typeof INQUIRY_PROTOCOL_VERSION;
    readonly namespace: string;
    readonly inquiryId: string;
    readonly attempt: number;
}
export interface InquiryReplacement {
    readonly customType: string;
    readonly content: string;
    readonly details?: unknown;
}
export interface InquiryMessage {
    readonly customType: string;
    readonly content: string;
    readonly display: false;
    readonly details: InquiryCorrelation;
}
export interface InquiryFoldMessage {
    readonly customType: string;
    readonly content: string;
    readonly display: false;
    readonly details: InquiryCorrelation & {
        readonly outcome: "remove" | "replace";
        readonly replacement?: InquiryReplacement;
    };
}
export interface InquirySendApi {
    sendMessage(message: InquiryMessage, options: {
        readonly triggerTurn: true;
        readonly deliverAs: "steer";
    }): void;
}
export interface InquiryContextApi {
    on(event: "context", handler: (event: {
        messages: object[];
    }) => {
        messages?: object[];
    }): void;
}
export type InquiryAttemptState = "pending" | "sent" | "completed" | "cancelled";
/**
 * Pure, per-attempt inquiry ownership. The Pi adapter remains responsible for
 * aborting an active turn and delivering the returned fold message.
 */
export interface InquiryAttemptHandle {
    readonly correlation: InquiryCorrelation;
    readonly state: InquiryAttemptState;
    prompt(content: string): InquiryMessage;
    markSent(): boolean;
    matchesPrompt(message: unknown): boolean;
    capture(message: unknown): string | null;
    complete(replacement?: InquiryReplacement): InquiryFoldMessage | null;
    /** Idempotently returns the same remove-fold after cancellation. */
    cancel(): InquiryFoldMessage | null;
    neutralize<T>(message: T, options?: {
        readonly stopReason?: "stop" | "aborted";
    }): T;
}
export interface InquiryRuntime {
    readonly inquiryId: string;
    readonly namespace: string;
    correlation(attempt: number): InquiryCorrelation;
    prompt(content: string, attempt: number): InquiryMessage;
    send(pi: InquirySendApi, content: string, attempt: number): InquiryMessage;
    fold(attempt: number, replacement?: InquiryReplacement): InquiryFoldMessage;
    capture(message: unknown): string | null;
    neutralize<T>(message: T, attempt: number): T;
    attempt(attempt: number): InquiryAttemptHandle;
}
export declare function createInquiryRuntime(namespace: string, options?: {
    readonly inquiryId?: string;
}): InquiryRuntime;
export declare function foldInquiryContext<T extends object>(messages: T[], namespace: string): T[];
export declare function registerInquiryContextFolding(pi: InquiryContextApi, namespace: string): void;
export declare function neutralizeInquiryAssistant<T>(message: T, correlation: InquiryCorrelation, options?: {
    readonly stopReason?: "stop" | "aborted";
}): T;
