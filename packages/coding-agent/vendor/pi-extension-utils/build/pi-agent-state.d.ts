/** Minimal public Pi context surface needed for live agent-state probes. */
export interface PiAgentStateSource {
    /** Official Pi idle state: true only when the agent is not processing a run. */
    isIdle(): boolean;
    /** Official queued-message state when exposed by the host Pi version. */
    hasPendingMessages?(): boolean;
}
/** One synchronous observation of Pi-owned agent state. */
export interface PiAgentStateSnapshot {
    readonly idle: boolean;
    readonly busy: boolean;
    readonly pendingMessages: boolean;
}
/**
 * Query Pi's public context state without inferring activity from event names.
 *
 * Consumers should call this at each relevant public Pi event. The snapshot is
 * deliberately not cached: retries, compaction, queued continuations, and
 * extension-triggered turns can change the official state between events that
 * otherwise look equivalent.
 */
export declare function probePiAgentState(source: PiAgentStateSource): PiAgentStateSnapshot;
