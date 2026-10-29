import { describe, expect, it } from "vitest";
import { toExtensionUIRequest, toLiveEvent } from "../host/runtime.ts";

describe("toLiveEvent", () => {
	it("保留 text/thinking delta 事件", () => {
		expect(
			toLiveEvent({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "你好" },
			}),
		).toEqual({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "你好" },
		});
	});

	it("toolcall_end 只保留 id/name/arguments", () => {
		const event = toLiveEvent({
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 1,
				toolCall: { type: "toolCall", id: "t1", name: "read", arguments: { path: "/a" }, extra: "dropped" },
			},
		});
		expect(event).toEqual({
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 1,
				toolCall: { type: "toolCall", id: "t1", name: "read", arguments: { path: "/a" } },
			},
		});
	});

	it("toolcall_end 归一 toolCallId/toolName/input 字段拼写", () => {
		const event = toLiveEvent({
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: { toolCallId: "t9", toolName: "read", input: { path: "/b" } },
			},
		});
		expect(event).toEqual({
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: { type: "toolCall", id: "t9", name: "read", arguments: { path: "/b" } },
			},
		});
	});

	it("保留 turn 边界、队列与重试事件", () => {
		expect(toLiveEvent({ type: "turn_start" })).toEqual({ type: "turn_start" });
		expect(toLiveEvent({ type: "queue_update", steering: ["a"], followUp: [] })).toEqual({
			type: "queue_update",
			steering: 1,
			followUp: 0,
		});
		expect(
			toLiveEvent({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "529" }),
		).toEqual({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "529" });
	});

	it("丢弃未知事件和畸形字段", () => {
		expect(toLiveEvent({ type: "nope" })).toBeNull();
		expect(toLiveEvent({ type: "tool_execution_start", toolCallId: 1, toolName: "x" })).toBeNull();
		expect(toLiveEvent({ type: "message_start", message: { nope: true } })).toBeNull();
	});

	it("tool_execution_end 保留 durationMs", () => {
		expect(
			toLiveEvent({
				type: "tool_execution_end",
				toolCallId: "t1",
				toolName: "bash",
				result: { output: "ok" },
				isError: false,
				durationMs: 12,
			}),
		).toEqual({
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "bash",
			result: { output: "ok" },
			isError: false,
			durationMs: 12,
		});
	});
});

describe("toExtensionUIRequest", () => {
	it("转换 select/confirm/input/editor/notify", () => {
		expect(
			toExtensionUIRequest({ type: "extension_ui_request", id: "1", method: "select", title: "t", options: ["a", "b"] }),
		).toEqual({ id: "1", method: "select", title: "t", options: ["a", "b"], timeout: undefined });
		expect(
			toExtensionUIRequest({ type: "extension_ui_request", id: "2", method: "notify", message: "m", notifyType: "weird" }),
		).toEqual({ id: "2", method: "notify", message: "m", notifyType: "info" });
	});

	it("丢弃无 UI 表面的方法", () => {
		expect(toExtensionUIRequest({ type: "extension_ui_request", id: "1", method: "setTitle", title: "x" })).toBeNull();
		expect(toExtensionUIRequest({ type: "extension_ui_request", id: "1", method: "setStatus" })).toBeNull();
	});
});
