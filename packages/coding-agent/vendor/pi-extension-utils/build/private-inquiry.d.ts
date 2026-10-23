/**
 * Private inquiry runtime — shared execution module for Pi extensions.
 *
 * Owns the mechanism only: full fork from a frozen qualified source, guarded
 * result file, same-child bounded correction, exact-child cancellation and
 * typed failures. The execution core is Continue's accepted private-decision
 * operation, moved verbatim into ./private-inquiry/core.ts. Scheduling,
 * verdict schemas, review policy, counters and publication stay with the
 * consumer.
 *
 * The pinned private pi-subagents runtime is imported lazily by
 * `createPrivateRuntime()`, so importing this subpath never initializes Pi.
 */
import type { WatchdogRuntime } from "private-inquiry-subagents-runtime/watchdog-runtime";
export { INVALID_ATTEMPT_LIMIT, RESULT_DIR_PREFIX, RESULT_FILE_NAME, RESULT_FILE_TAG, runPrivateDecision as runPrivateInquiry, type PayloadValidation, type PrivateDecisionObservation as PrivateInquiryObservation, type PrivateDecisionOptions as PrivateInquiryOptions, type PrivateDecisionResult as PrivateInquiryResult, type ResultFileNaming, } from "./private-inquiry/core.js";
export type { ChildRetryPolicy as RetryPolicy, WatchdogChildSession as PrivateChildSession, WatchdogExecutionProfile as ExecutionProfile, WatchdogForkInput as PrivateForkInput, WatchdogRuntime as PrivateRuntime, } from "private-inquiry-subagents-runtime/watchdog-runtime";
/**
 * Create one private runtime: the only call that loads the pinned private
 * pi-subagents entry (and therefore Pi). Dispose it when the owner unloads.
 * Works only where the host transpiles TypeScript under node_modules (tsx,
 * Bun, Deno). Pi extensions import the runtime subpath from their own source.
 */
export declare function createPrivateRuntime(): Promise<WatchdogRuntime>;
/** Typed setup failure carrying a stable reason. */
export declare class PrivateInquirySetupError extends Error {
    readonly reason: "no-replayable-anchor";
    constructor(message: string, reason: "no-replayable-anchor");
}
/** A session entry shape sufficient for replayability analysis. */
export interface ReplayableEntry {
    readonly id: string;
    readonly parentId: string | null;
    readonly type: string;
    readonly message?: {
        readonly role?: string;
        readonly stopReason?: string;
        readonly content?: readonly {
            readonly type: string;
            readonly id?: string;
            readonly toolCallId?: string;
        }[];
    } | undefined;
}
/** Structural parent-session surface needed to capture a frozen source. */
export interface PrivateInquiryParentSession {
    getLeafId(): string | null;
    getEntries(): readonly unknown[];
}
/** Whether the ancestor prefix ending at this persisted entry has no open tool batch. */
export declare function isReplayableEntry(entries: readonly ReplayableEntry[], entry: ReplayableEntry): boolean;
/**
 * Latest closed prefix on the selected ancestry. Later or off-branch replies
 * cannot close a batch, and trailing metadata cannot hide outstanding calls.
 */
export declare function latestReplayableAnchor(entries: readonly ReplayableEntry[], leafId: string | null): string | undefined;
/**
 * Capture the fork anchor at trigger time: the latest replayable entry, or
 * a validated explicit anchor. Pass the result as `fork.anchorId`. No
 * replayable source is a typed setup failure — never a wait, abort or
 * fresh-context fallback.
 */
export declare function captureAnchor(parent: PrivateInquiryParentSession, anchorId?: string): string;
