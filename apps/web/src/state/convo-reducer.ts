/**
 * Conversation state reducer: rebuilds the rendered conversation from a
 * snapshot (committed messages) plus the whitelisted live event stream.
 *
 * Pure functions only — no DOM, no network — so they are unit-testable in
 * Node. Event isolation is the caller's job: only apply events whose
 * (workspaceId, sessionId) match the ConvoState being reduced.
 */

import type {
	ConversationSnapshot,
	LiveEvent,
	ModelOption,
	SessionStatsDto,
	TextBlock,
	ThinkingBlock,
	ThinkingLevel,
	ToolCallBlock,
	WireMessage,
} from "../../shared/protocol.ts";

/** Tool call block while streaming: args arrive as JSON fragments. */
export interface LiveToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	argsJson: string;
	/** Final arguments from toolcall_end. */
	final?: Record<string, unknown>;
}

export type LiveBlock = TextBlock | ThinkingBlock | LiveToolCallBlock;

export type ToolStatus = "running" | "done" | "error";

export interface ToolRun {
	id: string;
	name: string;
	argsSummary: string;
	status: ToolStatus;
	partialText?: string;
	resultText?: string;
	durationMs?: number;
}

export interface ConvoState {
	workspaceId: string;
	sessionId: string;
	sessionName?: string;
	streaming: boolean;
	compacting: boolean;
	messages: WireMessage[];
	live: LiveBlock[];
	liveError?: string;
	toolRuns: Record<string, ToolRun>;
	model?: { provider: string; id: string };
	thinkingLevel: ThinkingLevel;
	models: ModelOption[];
	thinkingLevels: ThinkingLevel[];
	stats?: SessionStatsDto;
}

export function convoFromSnapshot(snapshot: ConversationSnapshot): ConvoState {
	let convo: ConvoState = {
		workspaceId: snapshot.workspaceId,
		sessionId: snapshot.sessionId,
		sessionName: snapshot.sessionName,
		streaming: false,
		compacting: false,
		messages: snapshot.messages,
		live: [],
		toolRuns: {},
		model: snapshot.model,
		thinkingLevel: snapshot.thinkingLevel,
		models: snapshot.models,
		thinkingLevels: snapshot.thinkingLevels,
		stats: snapshot.stats,
	};
	for (const event of snapshot.liveEvents) {
		convo = reduceEvent(convo, event);
	}
	return convo;
}

function sameMessage(a: WireMessage, b: WireMessage): boolean {
	return a.role === b.role && a.timestamp !== undefined && a.timestamp === b.timestamp;
}

function stringifyDetail(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "string") return value;
	if (typeof value === "object" && !Array.isArray(value)) {
		const content = (value as Record<string, unknown>).content;
		if (Array.isArray(content)) {
			const text = content
				.map((block) =>
					typeof block === "object" && block !== null && (block as Record<string, unknown>).type === "text"
						? String((block as Record<string, unknown>).text ?? "")
						: "",
				)
				.filter(Boolean)
				.join("\n");
			if (text) return text;
		}
	}
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** One-line summary of tool arguments for cards and panel rows. */
export function summarizeArgs(toolName: string, args: unknown): string {
	if (typeof args !== "object" || args === null) return "";
	const record = args as Record<string, unknown>;
	const preferred =
		record.command ?? record.path ?? record.pattern ?? record.subject ?? record.description ?? record.query;
	if (typeof preferred === "string" && preferred) return truncate(preferred, 80);
	try {
		return truncate(JSON.stringify(args), 80);
	} catch {
		return "";
	}
}

function applyStreamEvent(live: LiveBlock[], event: Extract<LiveEvent, { type: "message_update" }>["assistantMessageEvent"]): LiveBlock[] {
	if (event.type === "done" || event.type === "error") return live;
	const next = [...live];
	const index = event.contentIndex;
	switch (event.type) {
		case "text_start":
			if (!next[index]) next[index] = { type: "text", text: "" };
			break;
		case "text_delta": {
			const block = next[index];
			next[index] =
				block?.type === "text" ? { ...block, text: block.text + event.delta } : { type: "text", text: event.delta };
			break;
		}
		case "text_end":
			next[index] = { type: "text", text: event.content };
			break;
		case "thinking_start":
			if (!next[index]) next[index] = { type: "thinking", thinking: "" };
			break;
		case "thinking_delta": {
			const block = next[index];
			next[index] =
				block?.type === "thinking"
					? { ...block, thinking: block.thinking + event.delta }
					: { type: "thinking", thinking: event.delta };
			break;
		}
		case "thinking_end":
			next[index] = { type: "thinking", thinking: event.content };
			break;
		case "toolcall_start":
			next[index] = { type: "toolCall", id: event.id, name: event.toolName, argsJson: "" };
			break;
		case "toolcall_delta": {
			const block = next[index];
			if (block?.type === "toolCall") next[index] = { ...block, argsJson: block.argsJson + event.delta };
			break;
		}
		case "toolcall_end":
			next[index] = {
				type: "toolCall",
				id: event.toolCall.id,
				name: event.toolCall.name,
				argsJson: JSON.stringify(event.toolCall.arguments, null, 2),
				final: event.toolCall.arguments,
			};
			break;
	}
	return next;
}

export function reduceEvent(state: ConvoState, event: LiveEvent): ConvoState {
	switch (event.type) {
		case "agent_start":
			return { ...state, streaming: true };
		case "agent_end":
		case "agent_settled":
			return { ...state, streaming: false, compacting: false };
		case "message_start":
			if (event.message.role === "assistant") {
				return { ...state, live: [], liveError: undefined };
			}
			return state; // 非 assistant 消息在 message_end 提交，避免重复
		case "message_update":
			if (event.assistantMessageEvent.type === "error") {
				return {
					...state,
					liveError: event.assistantMessageEvent.errorMessage ?? `生成失败（${event.assistantMessageEvent.reason}）`,
				};
			}
			return { ...state, live: applyStreamEvent(state.live, event.assistantMessageEvent) };
		case "message_end": {
			const last = state.messages[state.messages.length - 1];
			if (last && sameMessage(last, event.message)) return state;
			if (event.message.role === "assistant") {
				return { ...state, messages: [...state.messages, event.message], live: [] };
			}
			return { ...state, messages: [...state.messages, event.message] };
		}
		case "tool_execution_start": {
			const run: ToolRun = {
				id: event.toolCallId,
				name: event.toolName,
				argsSummary: summarizeArgs(event.toolName, event.args),
				status: "running",
			};
			return { ...state, toolRuns: { ...state.toolRuns, [event.toolCallId]: run } };
		}
		case "tool_execution_update": {
			const run = state.toolRuns[event.toolCallId];
			if (!run) return state;
			const partialText = stringifyDetail(event.partialResult);
			return {
				...state,
				toolRuns: { ...state.toolRuns, [event.toolCallId]: { ...run, partialText } },
			};
		}
		case "tool_execution_end": {
			const existing = state.toolRuns[event.toolCallId];
			const run: ToolRun = {
				id: event.toolCallId,
				name: event.toolName,
				argsSummary: existing?.argsSummary ?? "",
				status: event.isError ? "error" : "done",
				resultText: stringifyDetail(event.result),
				durationMs: event.durationMs,
			};
			return { ...state, toolRuns: { ...state.toolRuns, [event.toolCallId]: run } };
		}
		case "session_info_changed":
			return { ...state, sessionName: event.name };
		case "thinking_level_changed":
			return { ...state, thinkingLevel: event.level };
		case "compaction_start":
			return { ...state, compacting: true };
		case "compaction_end":
			return { ...state, compacting: false };
		default:
			// Ledger-only events (turns, queues, retries) do not change the chat view.
			return state;
	}
}

// ============================================================================
// Derivations for rendering
// ============================================================================

/** Index committed toolResult messages by the tool call they answer. */
export function toolResultIndex(messages: WireMessage[]): Map<string, WireMessage> {
	const map = new Map<string, WireMessage>();
	for (const message of messages) {
		if (message.role === "toolResult" && message.toolCallId) map.set(message.toolCallId, message);
	}
	return map;
}

/** Status of a tool call block, from live runs first, then committed results. */
export function toolStatus(convo: ConvoState, results: Map<string, WireMessage>, toolCallId: string): ToolStatus {
	const run = convo.toolRuns[toolCallId];
	if (run) return run.status;
	const result = results.get(toolCallId);
	if (result) return result.isError ? "error" : "done";
	return convo.streaming ? "running" : "done";
}

export interface PanelItem {
	id: string;
	title: string;
	detail?: string;
	status: ToolStatus;
}

const TASK_TOOL_NAMES = new Set(["TaskCreate", "TaskUpdate", "TaskGet", "TaskList"]);

function collectToolCalls(convo: ConvoState): ToolCallBlock[] {
	const calls: ToolCallBlock[] = [];
	for (const message of convo.messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (isToolCallBlock(block)) calls.push(block);
		}
	}
	for (const block of convo.live) {
		if (block.type === "toolCall") {
			calls.push({ type: "toolCall", id: block.id, name: block.name, arguments: block.final ?? {} });
		}
	}
	return calls;
}

function isToolCallBlock(block: unknown): block is ToolCallBlock {
	return (
		typeof block === "object" &&
		block !== null &&
		(block as ToolCallBlock).type === "toolCall" &&
		typeof (block as ToolCallBlock).id === "string"
	);
}

function panelItems(convo: ConvoState, matches: (name: string) => boolean): PanelItem[] {
	const results = toolResultIndex(convo.messages);
	const items: PanelItem[] = [];
	for (const call of collectToolCalls(convo)) {
		if (!matches(call.name)) continue;
		const args = call.arguments;
		const title =
			(typeof args.subject === "string" && args.subject) ||
			(typeof args.description === "string" && args.description) ||
			(typeof args.taskId === "string" && `#${args.taskId}`) ||
			call.name;
		const statusText = typeof args.status === "string" ? `状态: ${args.status}` : undefined;
		const summary = summarizeArgs(call.name, args);
		items.push({
			id: call.id,
			title,
			detail: statusText ?? (summary || undefined),
			status: toolStatus(convo, results, call.id),
		});
	}
	return items;
}

/** 任务 tab：任务管理工具的真实调用记录。 */
export function deriveTaskItems(convo: ConvoState): PanelItem[] {
	return panelItems(convo, (name) => TASK_TOOL_NAMES.has(name));
}

/** 子代理 tab：Agent 工具的真实调用记录。 */
export function deriveAgentItems(convo: ConvoState): PanelItem[] {
	return panelItems(convo, (name) => name === "Agent");
}
