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
export { INVALID_ATTEMPT_LIMIT, RESULT_DIR_PREFIX, RESULT_FILE_NAME, RESULT_FILE_TAG, runPrivateDecision as runPrivateInquiry, } from "./private-inquiry/core.js";
/**
 * Create one private runtime: the only call that loads the pinned private
 * pi-subagents entry (and therefore Pi). Dispose it when the owner unloads.
 * Works only where the host transpiles TypeScript under node_modules (tsx,
 * Bun, Deno). Pi extensions import the runtime subpath from their own source.
 */
export async function createPrivateRuntime() {
    const mod = await import("private-inquiry-subagents-runtime/watchdog-runtime");
    return mod.createWatchdogRuntime();
}
// ---------------------------------------------------------------------------
// Frozen qualified source (design D2)
// ---------------------------------------------------------------------------
/** Typed setup failure carrying a stable reason. */
export class PrivateInquirySetupError extends Error {
    reason;
    constructor(message, reason) {
        super(message);
        this.reason = reason;
        this.name = "PrivateInquirySetupError";
    }
}
/** Whether the ancestor prefix ending at this persisted entry has no open tool batch. */
export function isReplayableEntry(entries, entry) {
    return latestReplayableAnchor(entries, entry.id) === entry.id;
}
/**
 * Latest closed prefix on the selected ancestry. Later or off-branch replies
 * cannot close a batch, and trailing metadata cannot hide outstanding calls.
 */
export function latestReplayableAnchor(entries, leafId) {
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const branch = [];
    let current = leafId ? byId.get(leafId) : undefined;
    while (current) {
        branch.push(current);
        current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    const pending = new Set();
    let anchor;
    for (const entry of branch.reverse()) {
        const message = entry.message;
        if (message?.role === "assistant" && message.stopReason === "toolUse") {
            for (const block of message.content ?? []) {
                if (block.type === "toolCall" && typeof block.id === "string")
                    pending.add(block.id);
            }
        }
        else if (message?.role === "toolResult") {
            // Pi persists the call id on the message; older shapes used content blocks.
            if (typeof message.toolCallId === "string")
                pending.delete(message.toolCallId);
            for (const block of message.content ?? []) {
                if (typeof block.toolCallId === "string")
                    pending.delete(block.toolCallId);
            }
        }
        if (pending.size === 0)
            anchor = entry.id;
    }
    return anchor;
}
/**
 * Capture the fork anchor at trigger time: the latest replayable entry, or
 * a validated explicit anchor. Pass the result as `fork.anchorId`. No
 * replayable source is a typed setup failure — never a wait, abort or
 * fresh-context fallback.
 */
export function captureAnchor(parent, anchorId) {
    const entries = parent.getEntries();
    const id = anchorId ?? latestReplayableAnchor(entries, parent.getLeafId());
    const anchor = id === undefined ? undefined : entries.find((entry) => entry.id === id);
    if (id === undefined || anchor === undefined || !isReplayableEntry(entries, anchor)) {
        throw new PrivateInquirySetupError("the parent has no replayable persisted entry to fork from", "no-replayable-anchor");
    }
    return id;
}
