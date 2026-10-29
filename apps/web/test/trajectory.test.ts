import { describe, expect, test } from "vitest";
import type { TrajectoryEntry, WireMessage } from "../shared/protocol.ts";
import {
	buildTrajectoryRows,
	filterTrajectoryRows,
	summarizeTrajectory,
} from "../src/state/trajectory.ts";

const TIME = "2026-01-02T03:04:05.000Z";

function entry(id: string, message: WireMessage, parentId: string | null = null): TrajectoryEntry {
	return {
		id,
		parentId,
		type: "message",
		timestamp: TIME,
		message,
		raw: JSON.stringify({ id, type: "message", message }),
	};
}

const user = entry("e1", { role: "user", content: "修复登录校验" });
const assistant = entry("e2", {
	role: "assistant",
	content: [
		{ type: "thinking", thinking: "先看文件" },
		{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "form.ts" } },
		{ type: "text", text: "已读取文件" },
	],
	usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, totalTokens: 15 },
});
const toolResult = entry("e3", {
	role: "toolResult",
	toolCallId: "call-1",
	toolName: "read",
	isError: false,
	content: [{ type: "text", text: "form source" }],
});

function build(entries: TrajectoryEntry[], extra: Partial<Parameters<typeof buildTrajectoryRows>[0]> = {}) {
	return buildTrajectoryRows({ entries, live: [], toolRuns: {}, streaming: false, now: TIME, ...extra });
}

describe("buildTrajectoryRows", () => {
	test("numbers turns and requests and pairs tool results with their calls", () => {
		const rows = build([user, assistant, toolResult]);
		expect(rows.map((row) => row.kind)).toEqual(["user", "assistant", "tool"]);
		expect(rows[0].turn).toBe(1);
		expect(rows[1].request).toBe(1);
		expect(rows[2].request).toBe(1);
		const tool = rows[2];
		expect(tool.title).toBe("read");
		expect(tool.status).toBe("done");
		expect(tool.preview).toContain("form source");
		expect(tool.details.map((detail) => detail.label)).toEqual(["参数", "输出"]);
	});

	test("does not emit a duplicate row for a paired tool result", () => {
		const rows = build([user, assistant, toolResult, entry("e4", { role: "user", content: "继续" })]);
		expect(rows.filter((row) => row.kind === "tool")).toHaveLength(1);
		expect(rows[rows.length - 1].turn).toBe(2);
		expect(rows[rows.length - 1].kind).toBe("user");
	});

	test("keeps one tool row when the result was persisted before the assistant message", () => {
		const rows = build([user, toolResult, assistant]);
		expect(rows.map((row) => row.kind)).toEqual(["user", "assistant", "tool"]);
		expect(rows[2].preview).toContain("form source");
	});

	test("marks failed tool results and keeps their output", () => {
		const failed = entry("e3", {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			isError: true,
			content: [{ type: "text", text: "ENOENT" }],
		});
		const rows = build([user, assistant, failed]);
		const tool = rows.find((row) => row.kind === "tool");
		expect(tool?.status).toBe("error");
		expect(tool?.details.some((detail) => detail.text.includes("ENOENT"))).toBe(true);
	});

	test("projects compaction and config entries", () => {
		const rows = build([
			user,
			{
				id: "c1",
				parentId: "e1",
				type: "compaction",
				timestamp: TIME,
				summary: "压缩了早期对话",
				raw: "{}",
			},
			{
				id: "m1",
				parentId: "c1",
				type: "model_change",
				timestamp: TIME,
				provider: "faux",
				modelId: "faux-large",
				raw: "{}",
			},
		]);
		expect(rows.map((row) => row.kind)).toEqual(["user", "compaction", "config"]);
		expect(rows[1].preview).toBe("压缩了早期对话");
		expect(rows[2].preview).toBe("faux / faux-large");
	});

	test("adds in-flight rows with running status", () => {
		const rows = build([user, assistant, toolResult], {
			streaming: true,
			live: [
				{ type: "thinking", thinking: "再确认一次" },
				{ type: "text", text: "正在处理" },
				{ type: "toolCall", id: "call-2", name: "bash", argsJson: '{"command":"npm test"}', final: { command: "npm test" } },
			],
			toolRuns: {
				"call-2": { id: "call-2", name: "bash", argsSummary: "npm test", status: "running" },
			},
		});
		const live = rows.filter((row) => row.key.startsWith("live:"));
		expect(live.map((row) => row.kind)).toEqual(["thinking", "assistant", "tool"]);
		expect(live.every((row) => row.status === "running")).toBe(true);
		expect(live[2].preview).toContain("npm test");
	});

	test("keeps a stable key per entry and per live block", () => {
		const rows = build([user, assistant, toolResult]);
		expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
		expect(rows.map((row) => row.key)).toEqual(["e1", "e2", "tool:call-1"]);
	});
});

describe("filterTrajectoryRows", () => {
	const rows = build([user, assistant, toolResult]);

	test("filters by kind", () => {
		expect(filterTrajectoryRows(rows, "", "user").map((row) => row.kind)).toEqual(["user"]);
		expect(filterTrajectoryRows(rows, "", "tool").map((row) => row.kind)).toEqual(["tool"]);
		expect(filterTrajectoryRows(rows, "", "assistant").map((row) => row.kind)).toEqual(["assistant"]);
	});

	test("searches preview, title and details case-insensitively", () => {
		expect(filterTrajectoryRows(rows, "form source", "all")).toHaveLength(1);
		expect(filterTrajectoryRows(rows, "FORM SOURCE", "all")).toHaveLength(1);
		expect(filterTrajectoryRows(rows, "不存在的文本", "all")).toHaveLength(0);
	});
});

describe("summarizeTrajectory", () => {
	test("counts turns, highest request and tool rows", () => {
		const rows = build([user, assistant, toolResult, entry("e4", { role: "user", content: "继续" })]);
		expect(summarizeTrajectory(rows)).toEqual({ turns: 2, requests: 1, tools: 1 });
	});
});
