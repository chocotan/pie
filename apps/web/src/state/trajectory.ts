/**
 * Trajectory ledger: turns persisted session entries (plus the in-flight run)
 * into one flat, ordered row per event for the 轨迹 view.
 *
 * Pure functions only; the caller supplies entries and live state. Live rows
 * are limited to the current run and skip tool calls already persisted, so a
 * refresh replaces them without duplication.
 */

import type { TrajectoryEntry, WireMessage } from "../../shared/protocol.ts";
import { summarizeArgs, type LiveBlock, type ToolRun, type ToolStatus } from "./convo-reducer.ts";

export type TrajectoryKind =
	| "user"
	| "assistant"
	| "thinking"
	| "tool"
	| "compaction"
	| "config"
	| "custom"
	| "system"
	| "error";

export interface TrajectoryDetail {
	label: string;
	text: string;
}

export interface TrajectoryRow {
	key: string;
	kind: TrajectoryKind;
	/** 1-based turn number; the user message starts a turn. */
	turn: number | null;
	/** 1-based assistant request number within the turn. */
	request: number | null;
	time?: string;
	title: string;
	preview: string;
	status?: ToolStatus;
	durationMs?: number;
	details: TrajectoryDetail[];
	raw: string;
	/** Lowercased haystack for search. */
	search: string;
}

export interface TrajectoryInput {
	entries: TrajectoryEntry[];
	live: LiveBlock[];
	toolRuns: Record<string, ToolRun>;
	streaming: boolean;
	/** Clock for in-flight rows; defaults to the current time. */
	now?: string;
}

const KIND_LABELS: Record<TrajectoryKind, string> = {
	user: "用户",
	assistant: "助手",
	thinking: "思考",
	tool: "工具",
	compaction: "压缩",
	config: "配置",
	custom: "自定义",
	system: "系统",
	error: "错误",
};

export function trajectoryKindLabel(kind: TrajectoryKind): string {
	return KIND_LABELS[kind];
}

function truncate(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (typeof block !== "object" || block === null) return "";
			const record = block as Record<string, unknown>;
			return record.type === "text" && typeof record.text === "string" ? record.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

function blocksOf(message: WireMessage): Record<string, unknown>[] {
	if (!Array.isArray(message.content)) return [];
	return message.content.filter(
		(block): block is Record<string, unknown> => typeof block === "object" && block !== null,
	);
}

function detailText(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	const record = typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
	if (record && Array.isArray(record.content)) {
		const text = textOf(record.content);
		if (text) return text;
	}
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function rawOf(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

/** "HH:MM:SS" in local time, or the raw value when it is not a timestamp. */
export function formatClock(timestamp: string | undefined): string | undefined {
	if (!timestamp) return undefined;
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) return timestamp;
	return date.toLocaleTimeString("zh-CN", { hour12: false });
}

function pushRow(rows: TrajectoryRow[], row: Omit<TrajectoryRow, "search">): void {
	rows.push({ ...row, search: `${row.title} ${row.preview} ${row.details.map((d) => d.text).join(" ")}`.toLowerCase() });
}

function entryRowTitle(entry: TrajectoryEntry): string {
	switch (entry.type) {
		case "compaction":
			return "上下文压缩";
		case "model_change":
			return "模型切换";
		case "thinking_level_change":
			return "思考强度";
		case "session_info":
			return entry.name ? "会话命名" : "会话名称清除";
		case "custom":
			return entry.customType ?? "自定义条目";
		default:
			return entry.type;
	}
}

function configPreview(entry: TrajectoryEntry): string {
	switch (entry.type) {
		case "model_change":
			return [entry.provider, entry.modelId].filter(Boolean).join(" / ");
		case "thinking_level_change":
			return entry.level ?? "";
		case "session_info":
			return entry.name ?? "（已清除）";
		case "compaction":
			return truncate(entry.summary ?? "", 120);
		default:
			return truncate(entry.raw, 120);
	}
}

export function buildTrajectoryRows(input: TrajectoryInput): TrajectoryRow[] {
	const rows: TrajectoryRow[] = [];

	// Pair tool results with their calls before walking, so a call row can show
	// its result without a second pass over the ledger. Calls named by an
	// assistant message own their row even when the result was persisted first.
	const results = new Map<string, WireMessage>();
	const callIdsInAssistant = new Set<string>();
	for (const entry of input.entries) {
		if (entry.message?.role === "toolResult" && entry.message.toolCallId) {
			results.set(entry.message.toolCallId, entry.message);
		}
		if (entry.message?.role === "assistant") {
			for (const block of blocksOf(entry.message)) {
				if (block.type === "toolCall" && typeof block.id === "string") callIdsInAssistant.add(block.id);
			}
		}
	}

	let turn = 0;
	let request = 0;

	for (const entry of input.entries) {
		const time = formatClock(entry.timestamp);
		if (entry.type !== "message" || !entry.message) {
			const kind: TrajectoryKind =
				entry.type === "compaction" ? "compaction" : entry.type === "custom" ? "custom" : "config";
			pushRow(rows, {
				key: entry.id,
				kind,
				turn: turn || null,
				request: null,
				time,
				title: entryRowTitle(entry),
				preview: configPreview(entry),
				details:
					entry.type === "compaction"
						? [{ label: "摘要", text: entry.summary ?? "" }]
						: [{ label: "条目", text: entry.raw }],
				raw: entry.raw,
			});
			continue;
		}

		const message = entry.message;
		if (message.role === "user") {
			turn += 1;
			request = 0;
			const text = textOf(message.content);
			pushRow(rows, {
				key: entry.id,
				kind: "user",
				turn,
				request: null,
				time,
				title: KIND_LABELS.user,
				preview: truncate(text, 200),
				details: [{ label: "内容", text }],
				raw: entry.raw,
			});
			continue;
		}

		if (message.role === "toolResult") {
			const callId = message.toolCallId;
			if (callId && callIdsInAssistant.has(callId)) continue;
			const text = detailText({ content: message.content });
			pushRow(rows, {
				key: `result:${entry.id}`,
				kind: "tool",
				turn: turn || null,
				request: request || null,
				time,
				title: message.toolName ?? "工具结果",
				preview: truncate(text, 160),
				status: message.isError ? "error" : "done",
				details: [{ label: message.isError ? "错误输出" : "输出", text }],
				raw: entry.raw,
			});
			continue;
		}

		if (message.role !== "assistant") {
			pushRow(rows, {
				key: entry.id,
				kind: "system",
				turn: turn || null,
				request: null,
				time,
				title: message.role,
				preview: truncate(textOf(message.content), 160),
				details: [{ label: "内容", text: detailText({ content: message.content }) }],
				raw: entry.raw,
			});
			continue;
		}

		request += 1;
		const blocks = blocksOf(message);
		const thinking = blocks
			.filter((b) => b.type === "thinking" && typeof b.thinking === "string")
			.map((b) => String(b.thinking))
			.join("\n\n");
		const text = textOf(message.content);
		const calls = blocks.filter(
			(b) => b.type === "toolCall" && typeof b.id === "string" && typeof b.name === "string",
		);
		const usage = message.usage
			? `输入 ${message.usage.input} · 输出 ${message.usage.output} · 缓存读 ${message.usage.cacheRead}`
			: "";
		pushRow(rows, {
			key: entry.id,
			kind: "assistant",
			turn: turn || null,
			request,
			time,
			title: KIND_LABELS.assistant,
			preview: truncate(text || thinking || calls.map((c) => String(c.name)).join(", "), 200),
			details: [
				...(thinking ? [{ label: "思考", text: thinking }] : []),
				...(text ? [{ label: "回复", text }] : []),
				...(usage ? [{ label: "用量", text: usage }] : []),
			],
			raw: entry.raw,
		});

		for (const call of calls) {
			const callId = String(call.id);
			const args = typeof call.arguments === "object" && call.arguments !== null ? call.arguments : {};
			const result = results.get(callId);
			const output = result ? detailText({ content: result.content }) : undefined;
			const summary = summarizeArgs(String(call.name), args);
			pushRow(rows, {
				key: `tool:${callId}`,
				kind: "tool",
				turn: turn || null,
				request,
				time,
				title: String(call.name),
				preview: truncate([summary, output ? `→ ${truncate(output, 120)}` : ""].filter(Boolean).join(" "), 220),
				status: result ? (result.isError ? "error" : "done") : input.toolRuns[callId]?.status,
				durationMs: input.toolRuns[callId]?.durationMs,
				details: [
					{ label: "参数", text: rawOf(args) },
					...(output !== undefined ? [{ label: result?.isError ? "错误输出" : "输出", text: output }] : []),
				],
				raw: rawOf({ call, result: result ?? null }),
			});
		}
	}

	// In-flight rows: the current assistant message and its tool calls. The
	// reducer clears `live` on message_end, so these never duplicate persisted
	// entries except after a mid-stream reconnect.
	const liveTurn = turn || null;
	const liveTime = formatClock(input.now ?? new Date().toISOString());
	input.live.forEach((block, index) => {
		const time = liveTime;
		if (block.type === "thinking") {
			pushRow(rows, {
				key: `live:thinking:${index}`,
				kind: "thinking",
				turn: liveTurn,
				request: request + 1 || null,
				time,
				title: KIND_LABELS.thinking,
				preview: truncate(block.thinking, 200),
				status: input.streaming ? "running" : undefined,
				details: [{ label: "思考", text: block.thinking }],
				raw: block.thinking,
			});
			return;
		}
		if (block.type === "text") {
			pushRow(rows, {
				key: `live:text:${index}`,
				kind: "assistant",
				turn: liveTurn,
				request: request + 1 || null,
				time,
				title: KIND_LABELS.assistant,
				preview: truncate(block.text, 200),
				status: input.streaming ? "running" : undefined,
				details: [{ label: "回复", text: block.text }],
				raw: block.text,
			});
			return;
		}
		const run = input.toolRuns[block.id];
		const args = block.final ?? parsePartialArgs(block.argsJson);
		pushRow(rows, {
			key: `live:tool:${block.id}`,
			kind: "tool",
			turn: liveTurn,
			request: request + 1 || null,
			time,
			title: block.name,
			preview: truncate(run?.argsSummary || summarizeArgs(block.name, args), 200),
			status: run?.status ?? (input.streaming ? "running" : undefined),
			durationMs: run?.durationMs,
			details: [
				{ label: "参数", text: rawOf(args) },
				...(run?.resultText ? [{ label: run.status === "error" ? "错误输出" : "输出", text: run.resultText }] : []),
				...(run?.partialText && !run.resultText ? [{ label: "实时输出", text: run.partialText }] : []),
			],
			raw: rawOf({ toolCall: { id: block.id, name: block.name, arguments: args }, run: run ?? null }),
		});
	});

	return rows;
}

function parsePartialArgs(json: string): Record<string, unknown> {
	if (!json) return {};
	try {
		const parsed: unknown = JSON.parse(json);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

export type TrajectoryFilter = "all" | "user" | "assistant" | "tool" | "config";

export function filterTrajectoryRows(
	rows: TrajectoryRow[],
	query: string,
	filter: TrajectoryFilter,
): TrajectoryRow[] {
	const needle = query.trim().toLowerCase();
	return rows.filter((row) => {
		if (filter === "user" && row.kind !== "user") return false;
		if (filter === "assistant" && row.kind !== "assistant" && row.kind !== "thinking") return false;
		if (filter === "tool" && row.kind !== "tool") return false;
		if (filter === "config" && row.kind !== "config" && row.kind !== "compaction" && row.kind !== "custom") {
			return false;
		}
		return needle === "" || row.search.includes(needle);
	});
}

export interface TrajectorySummary {
	turns: number;
	requests: number;
	tools: number;
}

export function summarizeTrajectory(rows: TrajectoryRow[]): TrajectorySummary {
	let turns = 0;
	let requests = 0;
	let tools = 0;
	for (const row of rows) {
		if (row.kind === "user") turns += 1;
		if (row.kind === "assistant" && row.request !== null) requests = Math.max(requests, row.request);
		if (row.kind === "tool") tools += 1;
	}
	return { turns, requests, tools };
}
