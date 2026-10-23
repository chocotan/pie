import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	ModelRuntime,
	ReadonlySessionManager,
} from "@earendil-works/pi-coding-agent";

export type ChildRetryPolicy = "disabled" | "native";

export interface WatchdogForkInput {
	parent: ReadonlySessionManager;
	parentProviderRegistry: Pick<ModelRuntime, "getRegisteredProviderIds" | "getRegisteredProviderConfig" | "getRegisteredNativeProvider">;
	cwd: string;
	agentDir: string;
	resultFile: string;
	model: string;
	/** Per-child retry policy: "disabled" (Continue) or "native" (Reflect). */
	retryPolicy: ChildRetryPolicy;
	signal?: AbortSignal;
	projectContext?: (messages: AgentMessage[]) => AgentMessage[];
	/** Restrict the fork to an explicit anchor entry instead of the current leaf. */
	anchorId?: string;
	/** Execution profile; default result-write-only. */
	profile?: WatchdogExecutionProfile;
}

/**
 * result-write-only: exactly one write to the designated file per response.
 * read-only-evidence: additionally admits helper-only batches of built-in
 * read/ls/grep/find, bounded by one operation-wide allowance (default 10).
 * Helper turns stay inside one terminal attempt; mixed, duplicate, unknown
 * or over-budget batches are rejected before any effect.
 */
export type WatchdogExecutionProfile =
	| { kind: "result-write-only" }
	| { kind: "read-only-evidence"; maxHelperCalls?: number };

export interface WatchdogChildSession {
	prompt(text: string): Promise<void>;
	abort(): Promise<void>;
	dispose(): Promise<void>;
	subscribe(listener: (event: { type: string; [key: string]: unknown }) => void): () => void;
	readonly messages: readonly AgentMessage[];
	readonly sessionFile: string | undefined;
	readonly sessionId: string;
	readonly modelId: string | undefined;
	readonly inheritedProvider?: string;
	readonly attemptError?: string;
	/** Helper calls admitted so far in this operation (evidence profile). */
	readonly helperCalls?: number;
}

export interface WatchdogRuntime {
	fork(input: WatchdogForkInput): Promise<WatchdogChildSession>;
	dispose(): void;
}

export declare function createWatchdogRuntime(): WatchdogRuntime;
