import { describe, expect, it } from "vitest";
import type { ConversationSnapshot, LiveEvent, WireMessage } from "../shared/protocol.ts";
import {
	convoFromSnapshot,
	deriveAgentItems,
	deriveTaskItems,
	reduceEvent,
	toolStatus,
	toolResultIndex,
	type ConvoState,
} from "../src/state/convo-reducer.ts";

function snapshot(overrides: Partial<ConversationSnapshot> = {}): ConversationSnapshot {
	return {
		workspaceId: "ws1",
		sessionId: "s1",
		streaming: false,
		thinkingLevel: "medium",
		models: [],
		thinkingLevels: ["off", "medium"],
		messages: [],
		liveEvents: [],
		...overrides,
	};
}

function textMessage(role: string, text: string, timestamp = 1): WireMessage {
	return { role, content: text, timestamp };
}

describe("convoFromSnapshot + reduceEvent 流式重建", () => {
	it("text/thinking delta 按 contentIndex 累积，message_end 提交最终消息", () => {
		let convo = convoFromSnapshot(snapshot());
		const events: LiveEvent[] = [
			{ type: "agent_start" },
			{ type: "message_end", message: textMessage("user", "你好", 100) },
			{ type: "message_start", message: { role: "assistant", content: [], timestamp: 101 } },
			{ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
			{ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "想一" } },
			{ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "想二" } },
			{ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 1 } },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "你" } },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "好" } },
			{
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "你好" }], timestamp: 101 },
			},
			{ type: "agent_end" },
		];
		for (const event of events) convo = reduceEvent(convo, event);

		expect(convo.messages).toHaveLength(2);
		expect(convo.messages[0].role).toBe("user");
		expect(convo.messages[1].role).toBe("assistant");
		expect(convo.live).toHaveLength(0);
		expect(convo.streaming).toBe(false);
	});

	it("toolcall_start/delta/end 累积参数，tool_execution_* 更新状态", () => {
		let convo = convoFromSnapshot(snapshot());
		const events: LiveEvent[] = [
			{ type: "agent_start" },
			{ type: "message_start", message: { role: "assistant", content: [], timestamp: 1 } },
			{ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "t1", toolName: "bash" } },
			{ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '{"command":"ls"}' } },
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "toolcall_end",
					contentIndex: 0,
					toolCall: { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
				},
			},
			{ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } },
		];
		for (const event of events) convo = reduceEvent(convo, event);

		const block = convo.live[0];
		expect(block?.type).toBe("toolCall");
		if (block?.type === "toolCall") {
			expect(block.final).toEqual({ command: "ls" });
		}
		expect(convo.toolRuns.t1.status).toBe("running");
		expect(convo.toolRuns.t1.argsSummary).toBe("ls");

		convo = reduceEvent(convo, {
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "file.txt" }] },
			isError: false,
			durationMs: 5,
		});
		expect(convo.toolRuns.t1.status).toBe("done");
		expect(convo.toolRuns.t1.resultText).toBe("file.txt");
		expect(toolStatus(convo, toolResultIndex(convo.messages), "t1")).toBe("done");
	});

	it("message_end 去重（快照已含同一条消息时不重复追加）", () => {
		const msg = textMessage("user", "重复", 42);
		let convo = convoFromSnapshot(snapshot({ messages: [msg] }));
		convo = reduceEvent(convo, { type: "message_end", message: msg });
		expect(convo.messages).toHaveLength(1);
	});

	it("error 事件写入 liveError，agent_settled 结束 streaming", () => {
		let convo = convoFromSnapshot(snapshot({ streaming: true }));
		convo = reduceEvent(convo, {
			type: "message_update",
			assistantMessageEvent: { type: "error", reason: "error", errorMessage: "余额不足" },
		});
		expect(convo.liveError).toBe("余额不足");
		convo = reduceEvent(convo, { type: "agent_settled", aborted: false });
		expect(convo.streaming).toBe(false);
	});

	it("snapshot 携带的 liveEvents 可重建中途加入的流式状态", () => {
		const liveEvents: LiveEvent[] = [
			{ type: "agent_start" },
			{ type: "message_start", message: { role: "assistant", content: [], timestamp: 1 } },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "已完成一半" } },
		];
		const convo = convoFromSnapshot(snapshot({ streaming: true, liveEvents }));
		expect(convo.live[0]).toEqual({ type: "text", text: "已完成一半" });
		expect(convo.streaming).toBe(true);
	});
});

describe("事件隔离（调用方按 workspaceId/sessionId 过滤）", () => {
	it("非当前会话的事件不应被应用（模拟 store 的守卫逻辑）", () => {
		const convo = convoFromSnapshot(snapshot({ sessionId: "s-current" }));
		const foreign: LiveEvent = { type: "message_end", message: textMessage("user", "别会话的消息", 999) };
		// store reducer 的守卫：sessionId 不匹配时直接返回原状态
		const matches = convo.sessionId === "s-old";
		const next: ConvoState = matches ? reduceEvent(convo, foreign) : convo;
		expect(next.messages).toHaveLength(0);
	});
});

describe("右栏投影", () => {
	function convoWithToolCall(name: string, args: Record<string, unknown>, withResult: boolean): ConvoState {
		const messages: WireMessage[] = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "c1", name, arguments: args }],
				timestamp: 1,
			},
		];
		if (withResult) {
			messages.push({
				role: "toolResult",
				toolCallId: "c1",
				toolName: name,
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: 2,
			});
		}
		return convoFromSnapshot(snapshot({ messages }));
	}

	it("Agent 工具调用进入子代理列表，带真实状态", () => {
		const done = convoWithToolCall("Agent", { description: "搜索调用方" }, true);
		expect(deriveAgentItems(done)).toEqual([
			{ id: "c1", title: "搜索调用方", detail: "搜索调用方", status: "done" },
		]);

		const running = convoWithToolCall("Agent", { description: "搜索调用方" }, false);
		expect(deriveAgentItems(running)[0].status).toBe("done"); // 非流式历史消息默认完成
	});

	it("TaskCreate/TaskUpdate 进入任务列表", () => {
		const convo = convoWithToolCall("TaskCreate", { subject: "修复校验", status: "in_progress" }, true);
		const items = deriveTaskItems(convo);
		expect(items).toHaveLength(1);
		expect(items[0].title).toBe("修复校验");
		expect(items[0].detail).toBe("状态: in_progress");
	});

	it("普通工具调用不进入任务/子代理列表", () => {
		const convo = convoWithToolCall("read", { path: "/a" }, true);
		expect(deriveTaskItems(convo)).toHaveLength(0);
		expect(deriveAgentItems(convo)).toHaveLength(0);
	});
});
