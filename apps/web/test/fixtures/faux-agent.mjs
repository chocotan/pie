#!/usr/bin/env node
/**
 * Faux agent for pie Web UI end-to-end testing. Speaks the coding-agent RPC
 * protocol (JSONL on stdin/stdout) without any provider calls or API keys.
 *
 * Behavior:
 * - get_state/get_messages/get_available_models/get_available_thinking_levels/
 *   get_session_stats/new_session/set_model/set_thinking_level/set_session_name: canned responses
 * - prompt "ask ...": first emits an extension_ui_request (select), waits for
 *   extension_ui_response, then streams the answer
 * - prompt "notify ...": emits a notify request, then streams
 * - prompt "slow ...": streams slowly (for abort testing)
 * - any other prompt: streams thinking + text + one bash tool call, then settles
 */

let sessionCounter = 0;
let sessionId = `faux-session-${++sessionCounter}`;
let sessionName;
let thinkingLevel = "medium";
let model = { provider: "faux", id: "faux-large" };
let messages = [];
let entries = [];
let entryCounter = 0;

function appendEntry(type, payload) {
	const id = `e${++entryCounter}`;
	const parentId = entries.length > 0 ? entries[entries.length - 1].id : null;
	entries.push({ id, parentId, type, timestamp: new Date().toISOString(), ...payload });
	return id;
}

appendEntry("model_change", { provider: model.provider, modelId: model.id });
let streaming = false;
let pendingTimers = [];
let extReply = null;

function send(record) {
	process.stdout.write(JSON.stringify(record) + "\n");
}

function respond(id, command, data) {
	send({ id, type: "response", command, success: true, ...(data === undefined ? {} : { data }) });
}

function fail(id, command, error) {
	send({ id, type: "response", command, success: false, error });
}

function later(ms, fn) {
	pendingTimers.push(setTimeout(fn, ms));
}

function streamRun(userText) {
	streaming = true;
	const toolCallId = `tc-${++entryCounter}`;
	const userMsg = { role: "user", content: userText, timestamp: Date.now() };
	messages.push(userMsg);
	appendEntry("message", { message: userMsg });
	send({ type: "agent_start" });
	send({ type: "turn_start" });
	send({ type: "message_start", message: userMsg });
	send({ type: "message_end", message: userMsg });

	later(80, () => send({ type: "message_start", message: { role: "assistant", content: [], timestamp: Date.now() } }));
	later(120, () =>
		send({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } }),
	);
	later(160, () =>
		send({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "先理解请求，" } }),
	);
	later(220, () =>
		send({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "然后调用工具。" } }),
	);
	later(280, () =>
		send({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, id: toolCallId, toolName: "bash" } }),
	);
	later(300, () =>
		send({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: '{"command":"echo hello"}' } }),
	);
	later(320, () =>
		send({
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 1,
				toolCall: { type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "echo hello" } },
			},
		}),
	);
	later(360, () => send({ type: "tool_execution_start", toolCallId: toolCallId, toolName: "bash", args: { command: "echo hello" } }));
	later(600, () =>
		send({
			type: "tool_execution_end",
			toolCallId: toolCallId,
			toolName: "bash",
			result: { content: [{ type: "text", text: "hello" }], details: {} },
			isError: false,
			durationMs: 240,
		}),
	);
	later(640, () => {
		const toolResult = {
			role: "toolResult",
			toolCallId: toolCallId,
			toolName: "bash",
			content: [{ type: "text", text: "hello" }],
			isError: false,
			timestamp: Date.now(),
		};
		messages.push(toolResult);
		appendEntry("message", { message: toolResult });
		send({ type: "message_end", message: toolResult });
	});
	later(700, () => send({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 2 } }));
	const reply = `已处理：${userText}。工具输出为 hello。`;
	for (let i = 0; i < reply.length; i += 4) {
		later(720 + i * 20, () =>
			send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 2, delta: reply.slice(i, i + 4) } }),
		);
	}
	const doneAt = 720 + reply.length * 20 + 100;
	later(doneAt, () => {
		const assistantMsg = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "先理解请求，然后调用工具。" },
				{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "echo hello" } },
				{ type: "text", text: reply },
			],
			timestamp: Date.now(),
			usage: { input: 120, output: 48, cacheRead: 0, cacheWrite: 0, totalTokens: 168, cost: { total: 0 } },
			stopReason: "stop",
		};
		messages.push(assistantMsg);
		appendEntry("message", { message: assistantMsg });
		send({ type: "message_end", message: assistantMsg });
		send({ type: "turn_end", message: assistantMsg, toolResults: [] });
		send({ type: "agent_end", messages, willRetry: false });
		send({ type: "agent_settled", aborted: false });
		streaming = false;
	});
}

function askThenStream(userText, id) {
	const extId = "ext-1";
	send({ type: "extension_ui_request", id: extId, method: "select", title: "选择处理方式", options: ["方案 A", "方案 B"], timeout: 60000 });
	extReply = (record) => {
		const answer = record.cancelled === true ? "（已取消）" : String(record.value ?? "");
		streamRun(`${userText}（扩展回复: ${answer}）`);
		respond(id, "prompt", { disposition: "started" });
	};
}

function handleCommand(record) {
	const { id, type } = record;
	switch (type) {
		case "extension_ui_response": {
			const reply = extReply;
			extReply = null;
			if (reply) reply(record);
			break;
		}
		case "get_state":
			respond(id, type, {
				model,
				thinkingLevel,
				isStreaming: streaming,
				isCompacting: false,
				steeringMode: "all",
				followUpMode: "all",
				sessionFile: `/tmp/faux/${sessionId}.jsonl`,
				sessionId,
				sessionName,
				autoCompactionEnabled: true,
				messageCount: messages.length,
				pendingMessageCount: 0,
			});
			break;
		case "get_messages":
			respond(id, type, { messages });
			break;
		case "get_entries":
			respond(id, type, { entries, leafId: entries.length > 0 ? entries[entries.length - 1].id : null });
			break;
		case "get_available_models":
			respond(id, type, {
				models: [
					{ provider: "faux", id: "faux-large", contextWindow: 128000, reasoning: true },
					{ provider: "faux", id: "faux-small", contextWindow: 32000, reasoning: false },
				],
			});
			break;
		case "get_available_thinking_levels":
			respond(id, type, { levels: ["off", "low", "medium", "high"] });
			break;
		case "get_session_stats":
			respond(id, type, {
				sessionFile: `/tmp/faux/${sessionId}.jsonl`,
				sessionId,
				userMessages: messages.filter((m) => m.role === "user").length,
				assistantMessages: messages.filter((m) => m.role === "assistant").length,
				toolCalls: 1,
				toolResults: 1,
				totalMessages: messages.length,
				tokens: { input: 120, output: 48, cacheRead: 0, cacheWrite: 0, total: 168 },
				cost: 0,
				contextUsage: { tokens: 168, contextWindow: 128000, percent: 0.13 },
			});
			break;
		case "new_session":
			sessionId = `faux-session-${++sessionCounter}`;
			sessionName = undefined;
			messages = [];
			entries = [];
			entryCounter = 0;
			appendEntry("model_change", { provider: model.provider, modelId: model.id });
			respond(id, type, { cancelled: false });
			break;
		case "switch_session":
			respond(id, type, { cancelled: false });
			break;
		case "set_model":
			model = { provider: record.provider, id: record.modelId };
			respond(id, type, model);
			break;
		case "set_thinking_level":
			thinkingLevel = record.level;
			respond(id, type);
			send({ type: "thinking_level_changed", level: thinkingLevel });
			break;
		case "set_session_name":
			sessionName = record.name;
			respond(id, type);
			send({ type: "session_info_changed", name: sessionName });
			break;
		case "prompt": {
			const message = String(record.message ?? "");
			if (message.startsWith("ask")) {
				askThenStream(message, id);
			} else if (message.startsWith("notify")) {
				send({ type: "extension_ui_request", id: "ext-n1", method: "notify", message: "faux 通知：任务已排队", notifyType: "info" });
				respond(id, type, { disposition: "started" });
				streamRun(message);
			} else if (message.startsWith("slow")) {
				respond(id, type, { disposition: "started" });
				streamRun(message);
				// 额外拖长流式，便于测试 abort
				streaming = true;
			} else {
				respond(id, type, { disposition: "started" });
				streamRun(message);
			}
			break;
		}
		case "abort":
			for (const timer of pendingTimers) clearTimeout(timer);
			pendingTimers = [];
			streaming = false;
			respond(id, type);
			send({ type: "agent_end", messages, willRetry: false });
			send({ type: "agent_settled", aborted: true });
			break;
		default:
			respond(id, type, {});
	}
}

let buffer = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	for (;;) {
		const index = buffer.indexOf("\n");
		if (index === -1) break;
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (!line) continue;
		try {
			handleCommand(JSON.parse(line));
		} catch {
			// 忽略无法解析的行
		}
	}
});
