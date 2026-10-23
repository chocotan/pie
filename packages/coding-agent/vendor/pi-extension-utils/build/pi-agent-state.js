/**
 * Query Pi's public context state without inferring activity from event names.
 *
 * Consumers should call this at each relevant public Pi event. The snapshot is
 * deliberately not cached: retries, compaction, queued continuations, and
 * extension-triggered turns can change the official state between events that
 * otherwise look equivalent.
 */
export function probePiAgentState(source) {
    const idle = source.isIdle();
    const hasPendingMessages = source.hasPendingMessages;
    return {
        idle,
        busy: !idle,
        pendingMessages: typeof hasPendingMessages === "function"
            ? hasPendingMessages.call(source)
            : false,
    };
}
