/**
 * Per-workspace agent runtime: lazily spawns one agent RPC process per
 * workspace, tags every event with (workspaceId, sessionId) for isolation,
 * keeps a bounded event buffer for mid-stream reconnects, and builds
 * authoritative conversation snapshots from RPC state + messages.
 *
 * All data coming from the agent process is parsed as unknown and narrowed
 * at this boundary; malformed records are dropped, never trusted.
 */

import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	type AssistantStreamEvent,
	type ConversationSnapshot,
	type ExtensionUIRequest,
	type ExtensionUIResponse,
	isRecord,
	type LiveEvent,
	type ModelOption,
	type RuntimeStatus,
	type SessionConfigDto,
	type SessionStatsDto,
	type SessionSummary,
	THINKING_LEVELS,
	type ThinkingLevel,
	type TrajectoryDto,
	type TrajectoryEntry,
	type WireMessage,
} from "../shared/protocol.ts";
import { AgentProcess } from "./agent-process.ts";
import { WorkspaceError, type Workspace } from "./workspaces.ts";

/** Upper bound of buffered events per workspace; oldest are dropped. */
export const EVENT_BUFFER_LIMIT = 1000;
/** Upper bound of trajectory entries returned per request; oldest are dropped. */
export const TRAJECTORY_ENTRY_LIMIT = 300;
/** Upper bound of one entry's raw JSON kept for the raw inspector. */
export const TRAJECTORY_RAW_LIMIT = 4000;

export interface RuntimeSink {
	emitEvent(workspaceId: string, sessionId: string, event: LiveEvent): void;
	emitExtensionUI(workspaceId: string, sessionId: string, request: ExtensionUIRequest): void;
	emitStatus(workspaceId: string, status: RuntimeStatus, error?: string): void;
	/** The session file changed on disk; the host should re-list sessions. */
	requestSessionsRefresh(workspaceId: string): void;
}

// ============================================================================
// Narrowing helpers (wire boundary)
// ============================================================================

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toThinkingLevel(value: unknown): ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value)
		? (value as ThinkingLevel)
		: "off";
}

/** 归一 assistant 消息里的 toolCall 块：接受 id/name/arguments 与 toolCallId/toolName/input 两种字段拼写。 */
function normalizeContent(content: unknown): unknown {
	if (!Array.isArray(content)) return content;
	return content.map((block) => {
		if (!isRecord(block) || block.type !== "toolCall") return block;
		const id = str(block.id) ?? str(block.toolCallId);
		const name = str(block.name) ?? str(block.toolName);
		if (!id || !name) return block;
		const args = isRecord(block.arguments) ? block.arguments : isRecord(block.input) ? block.input : {};
		return { type: "toolCall", id, name, arguments: args };
	});
}

function toWireMessage(value: unknown): WireMessage | null {
	if (!isRecord(value) || typeof value.role !== "string") return null;
	const wire: WireMessage = { role: value.role, content: normalizeContent(value.content ?? "") };
	const timestamp = num(value.timestamp);
	if (timestamp !== undefined) wire.timestamp = timestamp;
	if (wire.role === "toolResult") {
		wire.toolCallId = str(value.toolCallId);
		wire.toolName = str(value.toolName);
		wire.isError = value.isError === true;
	}
	if (wire.role === "assistant") {
		if (isRecord(value.usage)) {
			wire.usage = {
				input: num(value.usage.input) ?? 0,
				output: num(value.usage.output) ?? 0,
				cacheRead: num(value.usage.cacheRead) ?? 0,
				cacheWrite: num(value.usage.cacheWrite) ?? 0,
				totalTokens: num(value.usage.totalTokens) ?? 0,
			};
		}
		wire.stopReason = str(value.stopReason);
		wire.errorMessage = str(value.errorMessage);
	}
	return wire;
}

function toStreamEvent(value: unknown): AssistantStreamEvent | null {
	if (!isRecord(value)) return null;
	const contentIndex = num(value.contentIndex);
	switch (value.type) {
		case "text_start":
			return contentIndex === undefined ? null : { type: "text_start", contentIndex };
		case "text_delta":
			return contentIndex === undefined || typeof value.delta !== "string"
				? null
				: { type: "text_delta", contentIndex, delta: value.delta };
		case "text_end":
			return contentIndex === undefined || typeof value.content !== "string"
				? null
				: { type: "text_end", contentIndex, content: value.content };
		case "thinking_start":
			return contentIndex === undefined ? null : { type: "thinking_start", contentIndex };
		case "thinking_delta":
			return contentIndex === undefined || typeof value.delta !== "string"
				? null
				: { type: "thinking_delta", contentIndex, delta: value.delta };
		case "thinking_end":
			return contentIndex === undefined || typeof value.content !== "string"
				? null
				: { type: "thinking_end", contentIndex, content: value.content };
		case "toolcall_start":
			return contentIndex === undefined || typeof value.id !== "string" || typeof value.toolName !== "string"
				? null
				: { type: "toolcall_start", contentIndex, id: value.id, toolName: value.toolName };
		case "toolcall_delta":
			return contentIndex === undefined || typeof value.delta !== "string"
				? null
				: { type: "toolcall_delta", contentIndex, delta: value.delta };
		case "toolcall_end": {
			const toolCall = value.toolCall;
			if (contentIndex === undefined || !isRecord(toolCall)) return null;
			// 归一：接受 id/name/arguments 与 toolCallId/toolName/input 两种拼写
			const callId = str(toolCall.id) ?? str(toolCall.toolCallId);
			const callName = str(toolCall.name) ?? str(toolCall.toolName);
			if (!callId || !callName) return null;
			const callArgs = isRecord(toolCall.arguments) ? toolCall.arguments : isRecord(toolCall.input) ? toolCall.input : {};
			return {
				type: "toolcall_end",
				contentIndex,
				toolCall: { type: "toolCall", id: callId, name: callName, arguments: callArgs },
			};
		}
		case "done":
			return { type: "done" };
		case "error":
			return {
				type: "error",
				reason: str(value.reason) ?? "error",
				errorMessage: isRecord(value.error) ? str(value.error.errorMessage) : undefined,
			};
		default:
			return null;
	}
}

/** Map a raw RPC stdout event to the whitelisted wire event, or null to drop it. */
export function toLiveEvent(raw: Record<string, unknown>): LiveEvent | null {
	switch (raw.type) {
		case "agent_start":
			return { type: "agent_start" };
		case "agent_end":
			return { type: "agent_end" };
		case "agent_settled":
			return { type: "agent_settled", aborted: raw.aborted === true };
		case "turn_start":
			return { type: "turn_start" };
		case "turn_end":
			return { type: "turn_end" };
		case "queue_update": {
			const steering = Array.isArray(raw.steering) ? raw.steering.length : 0;
			const followUp = Array.isArray(raw.followUp) ? raw.followUp.length : 0;
			return { type: "queue_update", steering, followUp };
		}
		case "auto_retry_start":
			return {
				type: "auto_retry_start",
				attempt: num(raw.attempt) ?? 0,
				maxAttempts: num(raw.maxAttempts) ?? 0,
				delayMs: num(raw.delayMs) ?? 0,
				errorMessage: str(raw.errorMessage),
			};
		case "auto_retry_end":
			return {
				type: "auto_retry_end",
				success: raw.success === true,
				attempt: num(raw.attempt) ?? 0,
				finalError: str(raw.finalError),
			};
		case "entry_appended":
			return { type: "entry_appended", entryType: isRecord(raw.entry) ? (str(raw.entry.type) ?? "custom") : "custom" };
		case "extension_error":
			return { type: "extension_error", error: str(raw.error) ?? "扩展执行失败" };
		case "summarization_retry_scheduled":
			return {
				type: "summarization_retry_scheduled",
				attempt: num(raw.attempt) ?? 0,
				maxAttempts: num(raw.maxAttempts) ?? 0,
				delayMs: num(raw.delayMs) ?? 0,
			};
		case "message_start": {
			const message = toWireMessage(raw.message);
			return message ? { type: "message_start", message } : null;
		}
		case "message_end": {
			const message = toWireMessage(raw.message);
			return message ? { type: "message_end", message } : null;
		}
		case "message_update": {
			const sub = toStreamEvent(raw.assistantMessageEvent);
			return sub ? { type: "message_update", assistantMessageEvent: sub } : null;
		}
		case "tool_execution_start":
			return typeof raw.toolCallId === "string" && typeof raw.toolName === "string"
				? { type: "tool_execution_start", toolCallId: raw.toolCallId, toolName: raw.toolName, args: raw.args }
				: null;
		case "tool_execution_update":
			return typeof raw.toolCallId === "string" && typeof raw.toolName === "string"
				? {
						type: "tool_execution_update",
						toolCallId: raw.toolCallId,
						toolName: raw.toolName,
						partialResult: raw.partialResult,
					}
				: null;
		case "tool_execution_end": {
			if (typeof raw.toolCallId !== "string" || typeof raw.toolName !== "string") return null;
			const end: LiveEvent = {
				type: "tool_execution_end",
				toolCallId: raw.toolCallId,
				toolName: raw.toolName,
				result: raw.result,
				isError: raw.isError === true,
			};
			const durationMs = num(raw.durationMs);
			if (durationMs !== undefined) end.durationMs = durationMs;
			return end;
		}
		case "session_info_changed":
			return { type: "session_info_changed", name: str(raw.name) };
		case "thinking_level_changed":
			return { type: "thinking_level_changed", level: toThinkingLevel(raw.level) };
		case "compaction_start":
			return { type: "compaction_start", reason: str(raw.reason) ?? "manual" };
		case "compaction_end":
			return { type: "compaction_end", aborted: raw.aborted === true, errorMessage: str(raw.errorMessage) };
		default:
			return null;
	}
}

/** Map a raw extension UI request to the whitelisted wire request, or null to drop it. */
export function toExtensionUIRequest(raw: Record<string, unknown>): ExtensionUIRequest | null {
	if (raw.type !== "extension_ui_request" || typeof raw.id !== "string") return null;
	const timeout = num(raw.timeout);
	switch (raw.method) {
		case "select": {
			const options = Array.isArray(raw.options) ? raw.options.filter((o): o is string => typeof o === "string") : [];
			if (typeof raw.title !== "string" || options.length === 0) return null;
			return { id: raw.id, method: "select", title: raw.title, options, timeout };
		}
		case "confirm":
			return typeof raw.title === "string" && typeof raw.message === "string"
				? { id: raw.id, method: "confirm", title: raw.title, message: raw.message, timeout }
				: null;
		case "input":
			return typeof raw.title === "string"
				? { id: raw.id, method: "input", title: raw.title, placeholder: str(raw.placeholder), timeout }
				: null;
		case "editor":
			return typeof raw.title === "string"
				? { id: raw.id, method: "editor", title: raw.title, prefill: str(raw.prefill) }
				: null;
		case "notify":
			return typeof raw.message === "string"
				? {
						id: raw.id,
						method: "notify",
						message: raw.message,
						notifyType:
							raw.notifyType === "warning" || raw.notifyType === "error" ? raw.notifyType : "info",
					}
				: null;
		default:
			// setStatus/setWidget/setTitle/set_editor_text have no Web UI surface yet.
			return null;
	}
}

/**
 * Narrow one persisted session entry into the Trajectory DTO.
 * `raw` keeps a capped JSON copy so the inspector can show the original.
 */
export function toTrajectoryEntry(value: unknown): TrajectoryEntry | null {
	if (!isRecord(value) || typeof value.id !== "string" || typeof value.type !== "string") return null;
	const entry: TrajectoryEntry = {
		id: value.id,
		parentId: typeof value.parentId === "string" ? value.parentId : null,
		type: value.type,
		raw: "",
	};
	const timestamp = str(value.timestamp);
	if (timestamp) entry.timestamp = timestamp;
	switch (value.type) {
		case "message": {
			const message = toWireMessage(value.message);
			if (!message) return null;
			entry.message = message;
			break;
		}
		case "compaction":
			entry.summary = str(value.summary);
			break;
		case "session_info":
			entry.name = str(value.name);
			break;
		case "model_change":
			entry.provider = str(value.provider);
			entry.modelId = str(value.modelId);
			break;
		case "thinking_level_change":
			entry.level = toThinkingLevel(value.thinkingLevel);
			break;
		case "custom":
			entry.customType = str(value.customType);
			break;
		default:
			break;
	}
	try {
		const json = JSON.stringify(value);
		entry.raw = json.length > TRAJECTORY_RAW_LIMIT ? `${json.slice(0, TRAJECTORY_RAW_LIMIT)}\n…（原始内容已截断）` : json;
	} catch {
		entry.raw = "（无法序列化）";
	}
	return entry;
}

/** Map the RPC `get_entries` payload to bounded trajectory entries. */
export function toTrajectoryDto(data: unknown): TrajectoryDto | null {
	if (!isRecord(data) || typeof data.sessionId !== "string" || !Array.isArray(data.entries)) return null;
	const entries = data.entries
		.map(toTrajectoryEntry)
		.filter((e): e is TrajectoryEntry => e !== null)
		.slice(-TRAJECTORY_ENTRY_LIMIT);
	return { sessionId: data.sessionId, entries };
}

function toSummary(info: {
	path: string;
	id: string;
	name?: string;
	firstMessage: string;
	created: Date;
	modified: Date;
	messageCount: number;
}): SessionSummary {
	return {
		path: info.path,
		id: info.id,
		name: info.name,
		firstMessage: info.firstMessage,
		createdAt: info.created.toISOString(),
		modifiedAt: info.modified.toISOString(),
		messageCount: info.messageCount,
	};
}

/** List sessions of a workspace cwd without starting an agent process. */
export async function listWorkspaceSessions(cwd: string): Promise<SessionSummary[]> {
	const infos = await SessionManager.list(cwd);
	return infos.map(toSummary);
}

// ============================================================================
// Runtime
// ============================================================================

interface StateRead {
	sessionId: string;
	sessionName?: string;
	thinkingLevel: ThinkingLevel;
	isStreaming: boolean;
	model?: { provider: string; id: string };
}

function readState(data: unknown): StateRead {
	if (!isRecord(data) || typeof data.sessionId !== "string") {
		throw new WorkspaceError("代理返回了无效的会话状态");
	}
	const model = isRecord(data.model) ? data.model : undefined;
	return {
		sessionId: data.sessionId,
		sessionName: str(data.sessionName),
		thinkingLevel: toThinkingLevel(data.thinkingLevel),
		isStreaming: data.isStreaming === true,
		model:
			model && typeof model.provider === "string" && typeof model.id === "string"
				? { provider: model.provider, id: model.id }
				: undefined,
	};
}

function readModels(data: unknown): ModelOption[] {
	if (!isRecord(data) || !Array.isArray(data.models)) return [];
	const models: ModelOption[] = [];
	for (const raw of data.models) {
		if (!isRecord(raw) || typeof raw.provider !== "string" || typeof raw.id !== "string") continue;
		models.push({
			provider: raw.provider,
			id: raw.id,
			contextWindow: num(raw.contextWindow) ?? 0,
			reasoning: raw.reasoning === true,
		});
	}
	return models;
}

function readLevels(data: unknown): ThinkingLevel[] {
	if (!isRecord(data) || !Array.isArray(data.levels)) return [];
	return data.levels.filter((l): l is ThinkingLevel => typeof l === "string" && (THINKING_LEVELS as readonly string[]).includes(l));
}

function readStats(data: unknown): SessionStatsDto | undefined {
	if (!isRecord(data) || !isRecord(data.tokens)) return undefined;
	const context = isRecord(data.contextUsage) ? data.contextUsage : null;
	return {
		userMessages: num(data.userMessages) ?? 0,
		assistantMessages: num(data.assistantMessages) ?? 0,
		toolCalls: num(data.toolCalls) ?? 0,
		totalMessages: num(data.totalMessages) ?? 0,
		tokens: {
			input: num(data.tokens.input) ?? 0,
			output: num(data.tokens.output) ?? 0,
			cacheRead: num(data.tokens.cacheRead) ?? 0,
			cacheWrite: num(data.tokens.cacheWrite) ?? 0,
			total: num(data.tokens.total) ?? 0,
		},
		cost: num(data.cost) ?? 0,
		context: context
			? {
					tokens: num(context.tokens) ?? null,
					contextWindow: num(context.contextWindow) ?? 0,
					percent: num(context.percent) ?? null,
				}
			: null,
	};
}

export class WorkspaceRuntime {
	status: RuntimeStatus = "stopped";
	private process: AgentProcess | null = null;
	private starting: Promise<AgentProcess> | null = null;
	private unsubscribe: (() => void) | null = null;
	private sessionId = "";
	private buffer: Array<{ sessionId: string; event: LiveEvent }> = [];
	private models: ModelOption[] | null = null;
	/** 未答复的扩展 UI 请求（按请求 id），WS 重连时重放。 */
	private pendingExtUi = new Map<string, { sessionId: string; request: ExtensionUIRequest }>();
	/** 仍在运行的工具调用的最新 start/update 事件（按 toolCallId），WS 重连时重放。 */
	private activeTools = new Map<string, { sessionId: string; event: LiveEvent }>();

	readonly workspace: Workspace;
	private readonly cliPath: string;
	private readonly sink: RuntimeSink;

	constructor(workspace: Workspace, cliPath: string, sink: RuntimeSink) {
		this.workspace = workspace;
		this.cliPath = cliPath;
		this.sink = sink;
	}

	private setStatus(status: RuntimeStatus, error?: string): void {
		this.status = status;
		this.sink.emitStatus(this.workspace.id, status, error);
	}

	private onRawEvent(raw: Record<string, unknown>): void {
		if (raw.type === "extension_ui_request") {
			const request = toExtensionUIRequest(raw);
			if (request) {
				this.pendingExtUi.set(request.id, { sessionId: this.sessionId, request });
				this.sink.emitExtensionUI(this.workspace.id, this.sessionId, request);
			}
			return;
		}
		const event = toLiveEvent(raw);
		if (!event) return;
		if (event.type === "tool_execution_start" || event.type === "tool_execution_update") {
			this.activeTools.set(event.toolCallId, { sessionId: this.sessionId, event });
		} else if (event.type === "tool_execution_end") {
			this.activeTools.delete(event.toolCallId);
		} else if (event.type === "agent_end") {
			// 一轮结束：所有工具调用都已收尾，无可重放
			this.activeTools.clear();
		}
		this.buffer.push({ sessionId: this.sessionId, event });
		if (this.buffer.length > EVENT_BUFFER_LIMIT) {
			this.buffer.splice(0, this.buffer.length - EVENT_BUFFER_LIMIT);
		}
		this.sink.emitEvent(this.workspace.id, this.sessionId, event);
		if (event.type === "agent_settled" || event.type === "session_info_changed") {
			this.sink.requestSessionsRefresh(this.workspace.id);
		}
	}

	private async ensureProcess(): Promise<AgentProcess> {
		if (this.process?.running) return this.process;
		if (this.starting) return this.starting;
		this.setStatus("starting");
		this.starting = (async () => {
			const process = new AgentProcess({ cliPath: this.cliPath, cwd: this.workspace.path });
			try {
				await process.start();
			} catch (error) {
				this.starting = null;
				this.setStatus("error", error instanceof Error ? error.message : String(error));
				throw error;
			}
			this.process = process;
			this.unsubscribe = process.onEvent((raw) => this.onRawEvent(raw));
			const state = await process.call({ type: "get_state" }).catch(() => null);
			if (state) this.sessionId = readState(state).sessionId;
			this.starting = null;
			this.setStatus("running");
			return process;
		})();
		return this.starting;
	}

	async listSessions(): Promise<SessionSummary[]> {
		return listWorkspaceSessions(this.workspace.path);
	}

	async snapshot(): Promise<ConversationSnapshot> {
		const process = await this.ensureProcess();
		const state = readState(await process.call({ type: "get_state" }));
		this.sessionId = state.sessionId;
		const [messagesRaw, statsRaw, levelsRaw] = await Promise.all([
			process.call({ type: "get_messages" }),
			process.call({ type: "get_session_stats" }).catch(() => undefined),
			process.call({ type: "get_available_thinking_levels" }).catch(() => undefined),
		]);
		if (!this.models) {
			this.models = readModels(await process.call({ type: "get_available_models" }).catch(() => undefined));
		}
		const messages = isRecord(messagesRaw) && Array.isArray(messagesRaw.messages) ? messagesRaw.messages : [];
		return {
			workspaceId: this.workspace.id,
			sessionId: state.sessionId,
			sessionName: state.sessionName,
			streaming: state.isStreaming,
			model: state.model,
			thinkingLevel: state.thinkingLevel,
			models: this.models,
			thinkingLevels: levelsRaw ? readLevels(levelsRaw) : [],
			messages: messages.map(toWireMessage).filter((m): m is WireMessage => m !== null),
			liveEvents: state.isStreaming ? this.liveEventsFor(state.sessionId) : [],
			stats: statsRaw ? readStats(statsRaw) : undefined,
		};
	}

	/** Buffered events of the current in-flight run (since its agent_start). */
	private liveEventsFor(sessionId: string): LiveEvent[] {
		const mine = this.buffer.filter((b) => b.sessionId === sessionId).map((b) => b.event);
		let start = 0;
		for (let i = mine.length - 1; i >= 0; i--) {
			if (mine[i].type === "agent_start") {
				start = i;
				break;
			}
		}
		return mine.slice(start);
	}

	async newSession(): Promise<ConversationSnapshot> {
		const process = await this.ensureProcess();
		const result = await process.call({ type: "new_session" });
		if (isRecord(result) && result.cancelled === true) throw new WorkspaceError("新建会话被扩展取消");
		this.buffer = [];
		this.pendingExtUi.clear();
		this.activeTools.clear();
		const snap = await this.snapshot();
		this.sink.requestSessionsRefresh(this.workspace.id);
		return snap;
	}

	async switchSession(sessionPath: string): Promise<ConversationSnapshot> {
		// Only session files that belong to this workspace are accepted.
		const known = await this.listSessions();
		if (!known.some((s) => s.path === sessionPath)) {
			throw new WorkspaceError("会话不属于该工作区");
		}
		const process = await this.ensureProcess();
		const result = await process.call({ type: "switch_session", sessionPath });
		if (isRecord(result) && result.cancelled === true) throw new WorkspaceError("会话切换被扩展取消");
		this.buffer = [];
		this.pendingExtUi.clear();
		this.activeTools.clear();
		return this.snapshot();
	}

	async prompt(message: string): Promise<{ disposition: string }> {
		const process = await this.ensureProcess();
		const result = await process.call({ type: "prompt", message });
		return { disposition: isRecord(result) ? (str(result.disposition) ?? "started") : "started" };
	}

	/** Persisted entries of the active session, for the Trajectory ledger. */
	async getTrajectory(): Promise<TrajectoryDto> {
		const process = await this.ensureProcess();
		const state = readState(await process.call({ type: "get_state" }));
		this.sessionId = state.sessionId;
		const raw = await process.call({ type: "get_entries" }).catch(() => undefined);
		return toTrajectoryDto({ sessionId: state.sessionId, entries: isRecord(raw) ? raw.entries : [] }) ?? {
			sessionId: state.sessionId,
			entries: [],
		};
	}

	async abort(): Promise<void> {
		if (this.process?.running) await this.process.call({ type: "abort" });
	}

	async setModel(provider: string, modelId: string): Promise<SessionConfigDto> {
		const process = await this.ensureProcess();
		await process.call({ type: "set_model", provider, modelId });
		this.models = null;
		return this.configDto(process);
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<SessionConfigDto> {
		const process = await this.ensureProcess();
		await process.call({ type: "set_thinking_level", level });
		return this.configDto(process);
	}

	private async configDto(process: AgentProcess): Promise<SessionConfigDto> {
		const [stateRaw, levelsRaw] = await Promise.all([
			process.call({ type: "get_state" }),
			process.call({ type: "get_available_thinking_levels" }).catch(() => undefined),
		]);
		if (!this.models) {
			this.models = readModels(await process.call({ type: "get_available_models" }).catch(() => undefined));
		}
		const state = readState(stateRaw);
		return {
			model: state.model,
			thinkingLevel: state.thinkingLevel,
			models: this.models,
			thinkingLevels: levelsRaw ? readLevels(levelsRaw) : [],
		};
	}

	async setSessionName(name: string): Promise<void> {
		const process = await this.ensureProcess();
		await process.call({ type: "set_session_name", name });
		this.sink.requestSessionsRefresh(this.workspace.id);
	}

	/** 新 WS 连接需要重放的未完成状态：仍运行的工具事件 + 未答复的扩展请求。 */
	replayPending(): Array<{ sessionId: string } & ({ event: LiveEvent } | { request: ExtensionUIRequest })> {
		return [
			...[...this.activeTools.values()].map((t): { sessionId: string; event: LiveEvent } => ({
				sessionId: t.sessionId,
				event: t.event,
			})),
			...[...this.pendingExtUi.values()].map((p): { sessionId: string; request: ExtensionUIRequest } => ({
				sessionId: p.sessionId,
				request: p.request,
			})),
		];
	}

	respondExtensionUI(response: ExtensionUIResponse): void {
		if (!this.process?.running) throw new WorkspaceError("该工作区的代理尚未启动");
		this.pendingExtUi.delete(response.id);
		if ("value" in response) {
			this.process.respondExtensionUI({ id: response.id, value: response.value });
		} else if ("confirmed" in response) {
			this.process.respondExtensionUI({ id: response.id, confirmed: response.confirmed });
		} else {
			this.process.respondExtensionUI({ id: response.id, cancelled: true });
		}
	}

	async dispose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
		const process = this.process;
		this.process = null;
		this.buffer = [];
		this.pendingExtUi.clear();
		this.activeTools.clear();
		if (process) await process.stop().catch(() => {});
		this.setStatus("stopped");
	}
}
