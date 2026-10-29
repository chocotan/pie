/**
 * Shared HTTP/WebSocket protocol types and validators for the pie Web UI.
 *
 * This module is imported by both the Node host and the browser client.
 * It must not import Node-only or DOM-only modules.
 */

// Thinking levels mirror the provider protocol constants in @earendil-works/pi-ai.
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface WorkspaceInfo {
	id: string;
	/** Canonical (realpath) absolute path of the workspace. */
	path: string;
	/** Display name: basename of path. */
	name: string;
	/** The workspace the host was started in; cannot be removed. */
	isDefault: boolean;
}

export interface SessionSummary {
	/** Absolute path of the session file; used as switch target. */
	path: string;
	id: string;
	name?: string;
	firstMessage: string;
	createdAt: string;
	modifiedAt: string;
	messageCount: number;
}

export interface ModelOption {
	provider: string;
	id: string;
	contextWindow: number;
	reasoning: boolean;
}

// ============================================================================
// Wire messages (structural passthrough of agent messages)
// ============================================================================

export interface TextBlock {
	type: "text";
	text: string;
}
export interface ThinkingBlock {
	type: "thinking";
	thinking: string;
}
export interface ToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}
export type AssistantBlock = TextBlock | ThinkingBlock | ToolCallBlock;

export interface WireUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost?: { total: number };
}

/**
 * A message as transported over HTTP/WS. `content` is a plain string for
 * simple user messages or a block array for assistant/toolResult messages.
 * Extra provider fields are preserved but not interpreted by the UI.
 */
export interface WireMessage {
	role: string;
	content: unknown;
	timestamp?: number;
	/** toolResult messages: id of the tool call they answer. */
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	/** assistant messages. */
	usage?: WireUsage;
	stopReason?: string;
	errorMessage?: string;
}

// ============================================================================
// Live events (whitelist subset of the RPC session events)
// ============================================================================

export type AssistantStreamEvent =
	| { type: "text_start"; contentIndex: number }
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "text_end"; contentIndex: number; content: string }
	| { type: "thinking_start"; contentIndex: number }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| { type: "thinking_end"; contentIndex: number; content: string }
	| { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCallBlock }
	| { type: "done" }
	| { type: "error"; reason: string; errorMessage?: string };

export type LiveEvent =
	| { type: "agent_start" }
	| { type: "agent_end" }
	| { type: "agent_settled"; aborted: boolean }
	| { type: "turn_start" }
	| { type: "turn_end" }
	| { type: "message_start"; message: WireMessage }
	| { type: "message_update"; assistantMessageEvent: AssistantStreamEvent }
	| { type: "message_end"; message: WireMessage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; partialResult: unknown }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: unknown;
			isError: boolean;
			durationMs?: number;
	  }
	| { type: "session_info_changed"; name?: string }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| { type: "compaction_start"; reason: string }
	| { type: "compaction_end"; aborted: boolean; errorMessage?: string }
	| { type: "queue_update"; steering: number; followUp: number }
	| {
			type: "auto_retry_start";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage?: string;
	  }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| { type: "entry_appended"; entryType: string }
	| { type: "extension_error"; error: string }
	| { type: "summarization_retry_scheduled"; attempt: number; maxAttempts: number; delayMs: number };

// ============================================================================
// Extension UI
// ============================================================================

export type ExtensionUIRequest =
	| { id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| { id: string; method: "input"; title: string; placeholder?: string; timeout?: number }
	| { id: string; method: "editor"; title: string; prefill?: string }
	| { id: string; method: "notify"; message: string; notifyType?: "info" | "warning" | "error" };

export type ExtensionUIResponse =
	| { id: string; value: string }
	| { id: string; confirmed: boolean }
	| { id: string; cancelled: true };

// ============================================================================
// Snapshots and stats
// ============================================================================

export interface SessionStatsDto {
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	totalMessages: number;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	cost: number;
	context: { tokens: number | null; contextWindow: number; percent: number | null } | null;
}

/**
 * Authoritative conversation state for one (workspace, session). `messages`
 * is the committed history; `liveEvents` carries the in-flight run so a
 * client that connects mid-stream can rebuild the partial assistant message.
 */
export interface ConversationSnapshot {
	workspaceId: string;
	sessionId: string;
	sessionName?: string;
	streaming: boolean;
	model?: { provider: string; id: string };
	thinkingLevel: ThinkingLevel;
	models: ModelOption[];
	thinkingLevels: ThinkingLevel[];
	messages: WireMessage[];
	liveEvents: LiveEvent[];
	stats?: SessionStatsDto;
}

/**
 * A persisted session entry, narrowed at the host boundary for the Trajectory
 * ledger. `raw` is the entry's JSON, capped so one snapshot stays bounded.
 */
export interface TrajectoryEntry {
	id: string;
	parentId: string | null;
	type: string;
	timestamp?: string;
	message?: WireMessage;
	summary?: string;
	name?: string;
	provider?: string;
	modelId?: string;
	level?: ThinkingLevel;
	customType?: string;
	/** Entry JSON for the raw inspector; truncated when the host capped it. */
	raw: string;
}

export interface TrajectoryDto {
	sessionId: string;
	entries: TrajectoryEntry[];
}

/** Returned by model/thinking-level mutations; lighter than a full snapshot. */
export interface SessionConfigDto {
	model?: { provider: string; id: string };
	thinkingLevel: ThinkingLevel;
	models: ModelOption[];
	thinkingLevels: ThinkingLevel[];
}

// ============================================================================
// Server -> client WebSocket messages
// ============================================================================

export type RuntimeStatus = "stopped" | "starting" | "running" | "error";

export type ServerMessage =
	| { type: "hello"; workspaces: WorkspaceInfo[] }
	| { type: "workspaces"; workspaces: WorkspaceInfo[] }
	| { type: "sessions"; workspaceId: string; sessions: SessionSummary[] }
	| { type: "runtime"; workspaceId: string; status: RuntimeStatus; error?: string }
	| { type: "event"; workspaceId: string; sessionId: string; event: LiveEvent }
	| { type: "extension_ui"; workspaceId: string; sessionId: string; request: ExtensionUIRequest };

// ============================================================================
// Validation helpers (network boundary)
// ============================================================================

export class ProtocolError extends Error {}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(body: Record<string, unknown>, field: string, maxLength = 100_000): string {
	const value = body[field];
	if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
		throw new ProtocolError(`字段 ${field} 必须是非空字符串`);
	}
	return value;
}

export function parseAddWorkspace(body: unknown): { path: string } {
	if (!isRecord(body)) throw new ProtocolError("请求体必须是 JSON 对象");
	return { path: requireString(body, "path", 4096) };
}

export function parseSelectSession(body: unknown): { sessionPath: string } {
	if (!isRecord(body)) throw new ProtocolError("请求体必须是 JSON 对象");
	return { sessionPath: requireString(body, "sessionPath", 4096) };
}

export function parsePrompt(body: unknown): { message: string } {
	if (!isRecord(body)) throw new ProtocolError("请求体必须是 JSON 对象");
	return { message: requireString(body, "message", 200_000) };
}

export function parseSetModel(body: unknown): { provider: string; modelId: string } {
	if (!isRecord(body)) throw new ProtocolError("请求体必须是 JSON 对象");
	return { provider: requireString(body, "provider", 200), modelId: requireString(body, "modelId", 300) };
}

export function parseSetThinkingLevel(body: unknown): { level: ThinkingLevel } {
	if (!isRecord(body)) throw new ProtocolError("请求体必须是 JSON 对象");
	const level = body.level;
	if (typeof level !== "string" || !THINKING_LEVELS.includes(level as ThinkingLevel)) {
		throw new ProtocolError("无效的 thinking level");
	}
	return { level: level as ThinkingLevel };
}

export function parseSessionName(body: unknown): { name: string } {
	if (!isRecord(body)) throw new ProtocolError("请求体必须是 JSON 对象");
	return { name: requireString(body, "name", 500) };
}

export function parseExtensionUIResponse(body: unknown): ExtensionUIResponse {
	if (!isRecord(body)) throw new ProtocolError("请求体必须是 JSON 对象");
	const id = requireString(body, "id", 200);
	if (body.cancelled === true) return { id, cancelled: true };
	if (typeof body.confirmed === "boolean") return { id, confirmed: body.confirmed };
	if (typeof body.value === "string") return { id, value: body.value };
	throw new ProtocolError("扩展回复需要 value、confirmed 或 cancelled");
}

/** Narrow a raw parsed JSON value to a WorkspaceInfo, or return null. */
export function toWorkspaceInfo(value: unknown): WorkspaceInfo | null {
	if (!isRecord(value)) return null;
	const { id, path, name, isDefault } = value;
	if (typeof id !== "string" || typeof path !== "string" || typeof name !== "string") return null;
	return { id, path, name, isDefault: isDefault === true };
}
