import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxToolCall,
	getSystemMessageText,
} from "@earendil-works/pi-ai";
import type { TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "../../src/core/agent-session.ts";
import type { EventBus } from "../../src/core/event-bus.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createSubagentsExtension, type SubagentRecord } from "../../src/extensions/subagents/index.ts";
import tasksPlugin, {
	readTaskState,
	TASK_STATE_ENTRY,
	type TaskRecord,
	type TaskState,
	updateTask,
} from "../../src/extensions/tasks/index.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { raceWithAbortSignal } from "../../src/utils/abort.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createHarness, createTestUiContext, getToolResult } from "./harness.ts";

const task = (id: string, status: TaskRecord["status"] = "pending"): TaskRecord => ({
	id,
	subject: `Task ${id}`,
	description: "Verify the result",
	status,
	metadata: {},
	blockedBy: [],
});
const subagents = () => createSubagentsExtension({ agentDir: join(tmpdir(), `pie-test-${randomUUID()}`) });

describe("native tasks plugin", () => {
	it("restores only the active branch and returns detached state", () => {
		const manager = SessionManager.inMemory();
		const first = manager.appendCustomEntry(TASK_STATE_ENTRY, { nextId: 2, tasks: [task("1")] });
		manager.appendCustomEntry(TASK_STATE_ENTRY, { nextId: 3, tasks: [task("1"), task("2")] });
		manager.branch(first);
		const state = readTaskState(manager);
		expect(state.tasks.map((item) => item.id)).toEqual(["1"]);
		state.tasks[0].subject = "Changed";
		expect(readTaskState(manager).tasks[0].subject).toBe("Task 1");
	});
	it("rejects dependency cycles atomically and blocks progress until dependencies complete", () => {
		const original: TaskState = { nextId: 3, tasks: [task("1"), task("2")] };
		const linked = updateTask(original, { taskId: "2", addBlockedBy: ["1"] });
		expect(() => updateTask(linked, { taskId: "1", addBlockedBy: ["2"] })).toThrow("cycle");
		expect(() => updateTask(linked, { taskId: "2", status: "in_progress" })).toThrow("blocked");
		expect(original.tasks[1].blockedBy).toEqual([]);
		const unblocked = updateTask(linked, { taskId: "1", status: "completed" });
		expect(updateTask(unblocked, { taskId: "2", status: "in_progress" }).tasks[1].status).toBe("in_progress");
	});
	it("merges metadata, removes null keys, and removes deleted dependencies", () => {
		const original: TaskState = {
			nextId: 3,
			tasks: [
				{ ...task("1"), metadata: { old: 1 } },
				{ ...task("2"), blockedBy: ["1"] },
			],
		};
		const updated = updateTask(original, { taskId: "1", metadata: { old: null, new: 2 } });
		expect(updated.tasks[0].metadata).toEqual({ new: 2 });
		expect(updateTask(updated, { taskId: "1", status: "deleted" }).tasks).toEqual([task("2")]);
		expect(() => updateTask(original, { taskId: "missing" })).toThrow("Unknown task");
	});
	it("ignores a terminal result from a superseded task owner", async () => {
		let events!: EventBus;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					events = pi.events;
					tasksPlugin(pi);
				},
			],
		});
		try {
			await harness.session.bindExtensions({});
			harness.sessionManager.appendCustomEntry(TASK_STATE_ENTRY, {
				nextId: 2,
				tasks: [{ ...task("1", "in_progress"), owner: "new-run" }],
			});
			events.emit("pie.task-run", { taskId: "1", status: "completed", owner: "old-run" });
			expect(readTaskState(harness.sessionManager).tasks[0]).toMatchObject({
				status: "in_progress",
				owner: "new-run",
			});
			events.emit("pie.task-run", { taskId: "1", status: "completed", owner: "new-run" });
			expect(readTaskState(harness.sessionManager).tasks[0].status).toBe("completed");
		} finally {
			harness.cleanup();
		}
	});

	it("hides an empty Todo panel and preserves dismissal through task updates", async () => {
		initTheme("dark");
		const harness = await createHarness({ extensionFactories: [tasksPlugin] });
		const setWidget = vi.fn();
		try {
			await harness.session.bindExtensions({ mode: "tui", uiContext: createTestUiContext({ setWidget }) });
			expect(setWidget.mock.calls.every((call) => call[1] === undefined)).toBe(true);
			const ctx = harness.session.extensionRunner.createToolContext("todo-ui", undefined);
			const create = harness.session.getToolDefinition("TaskCreate")!;
			const update = harness.session.getToolDefinition("TaskUpdate")!;
			await create.execute("create-1", { subject: "First task", description: "Details" }, undefined, undefined, ctx);
			const ui = { terminal: { rows: 24 }, requestRender: vi.fn() } as unknown as TUI;
			const panel = setWidget.mock.calls.at(-1)![1](ui, theme);
			expect(stripAnsi(panel.render(40).join("\n"))).toContain("First task");
			await update.execute("delete-1", { taskId: "1", status: "deleted" }, undefined, undefined, ctx);
			expect(setWidget.mock.calls.at(-1)![1]).toBeUndefined();
			await create.execute(
				"create-2",
				{ subject: "Second task", description: "Details" },
				undefined,
				undefined,
				ctx,
			);
			const secondPanel = setWidget.mock.calls.at(-1)![1](ui, theme);
			secondPanel.render(40);
			secondPanel.handleMouse({
				type: "click",
				button: "left",
				x: 36,
				y: 0,
				screenX: 36,
				screenY: 0,
				width: 40,
				height: 24,
				shift: false,
				alt: false,
				ctrl: false,
				clickCount: 1,
			});
			await update.execute("update-2", { taskId: "2", status: "in_progress" }, undefined, undefined, ctx);
			expect(setWidget.mock.calls.at(-1)![1]).toBeUndefined();
			await update.execute("delete-2", { taskId: "2", status: "deleted" }, undefined, undefined, ctx);
			await create.execute("create-3", { subject: "Third task", description: "Details" }, undefined, undefined, ctx);
			expect(setWidget.mock.calls.at(-1)![1]).toBeUndefined();
			await harness.session.extensionRunner
				.getCommand("tasks")!
				.handler("", harness.session.extensionRunner.createCommandContext());
			expect(setWidget.mock.calls.at(-1)![1]).toBeTypeOf("function");
		} finally {
			harness.cleanup();
		}
	});
	it("registers usable CRUD tools without duplicating Todo in composer widgets", async () => {
		const harness = await createHarness({ extensionFactories: [tasksPlugin] });
		const setWidget = vi.fn();
		try {
			await harness.session.bindExtensions({ uiContext: createTestUiContext({ setWidget }) });
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("TaskCreate", {
						subject: "Add tests",
						description: "Test a real state transition",
						activeForm: "Adding tests",
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(fauxToolCall("TaskUpdate", { taskId: "1", status: "in_progress" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(fauxToolCall("TaskGet", { taskId: "1" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("Track the work");
			expect(getToolResult(harness, "TaskGet").isError).toBe(false);
			expect(readTaskState(harness.sessionManager).tasks[0].status).toBe("in_progress");
			expect(setWidget).not.toHaveBeenCalled();
			expect(readTaskState(harness.sessionManager).tasks[0].subject).toBe("Add tests");
		} finally {
			harness.cleanup();
		}
	});
	it("opens clicked Todo details in an overlay without appending a JSON chat message", async () => {
		initTheme("dark");
		const harness = await createHarness({ extensionFactories: [tasksPlugin] });
		const setWidget = vi.fn();
		const uiContext = createTestUiContext({ setWidget });
		const custom = vi.spyOn(uiContext, "custom");
		try {
			harness.sessionManager.appendCustomEntry(TASK_STATE_ENTRY, {
				nextId: 2,
				tasks: [{ ...task("1"), metadata: { priority: "high", checks: { passed: 3 } } }],
			});
			await harness.session.bindExtensions({ mode: "tui", uiContext });
			const tui = { terminal: { rows: 24 }, requestRender: vi.fn() } as unknown as TUI;
			const panel = setWidget.mock.calls.at(-1)![1](tui, theme);
			panel.render(80);
			panel.handleMouse({
				type: "click",
				button: "left",
				x: 3,
				y: 1,
				screenX: 3,
				screenY: 1,
				width: 80,
				height: 24,
				shift: false,
				alt: false,
				ctrl: false,
				clickCount: 1,
			});
			expect(custom).toHaveBeenCalledOnce();
			const [factory, options] = custom.mock.calls[0];
			expect(options).toMatchObject({ overlay: true, overlayOptions: { maxHeight: "80%" } });
			const detail = await factory(tui, theme, new KeybindingsManager(), vi.fn());
			const lines = detail.render(60).map(stripAnsi);
			expect(lines).toHaveLength(19);
			expect(lines.join("\n")).toContain("Verify the result");
			expect(lines.join("\n")).toContain("priority: high");
			expect(lines.join("\n")).toContain('"passed": 3');
			expect(
				harness.session.messages.some(
					(message) => message.role === "custom" && message.customType === "pie.task-detail",
				),
			).toBe(false);
		} finally {
			harness.cleanup();
		}
	});
});

describe("native subagents plugin", () => {
	it.each(["Agent", "TaskExecute"])("stops %s at the turn limit without an execution error", async (toolName) => {
		const abort = vi.spyOn(AgentSession.prototype, "abort");
		const read = vi.fn(async () => ({
			content: [{ type: "text" as const, text: "file contents" }],
			details: undefined,
		}));
		const harness = await createHarness({
			extensionFactories: [tasksPlugin, subagents()],
			tools: [
				{ name: "read", label: "Read", description: "Read a file", parameters: Type.Object({}), execute: read },
			],
		});
		try {
			await harness.session.bindExtensions({});
			harness.sessionManager.appendCustomEntry(TASK_STATE_ENTRY, {
				nextId: 2,
				tasks: [{ ...task("1"), agentType: "worker" }],
			});
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall(
						toolName,
						toolName === "Agent"
							? { prompt: "Read a file", max_turns: 1, run_in_background: false }
							: { task_ids: ["1"], max_turns: 1 },
					),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage([{ type: "text", text: "Partial findings" }, fauxToolCall("read", {})], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Parent done"),
				fauxAssistantMessage("Must not request another turn"),
			]);
			await harness.session.prompt("Delegate a file read");
			const ctx = harness.session.extensionRunner.createToolContext("limit-test", undefined);
			const result =
				toolName === "Agent"
					? getToolResult(harness, "Agent")
					: await harness.session
							.getToolDefinition("TaskOutput")!
							.execute("output", { task_id: "1" }, undefined, undefined, ctx);
			if (toolName === "TaskExecute") expect(readTaskState(harness.sessionManager).tasks[0].status).toBe("pending");
			expect(result.isError).toBe(false);
			expect(result.details).toMatchObject({
				status: "stopped",
				stopReason: "Subagent turn limit reached",
			});
			expect((result.details as SubagentRecord).error).toBeUndefined();
			expect(result.content).toEqual([
				{ type: "text", text: expect.stringContaining("Subagent turn limit reached") },
			]);
			expect(abort).toHaveBeenCalledOnce();
			expect(read).toHaveBeenCalledOnce();
			expect(harness.getPendingResponseCount()).toBe(1);
		} finally {
			abort.mockRestore();
			harness.cleanup();
		}
	});
	it("still delivers the automatic background notification after a turn-limit abort", async () => {
		const harness = await createHarness({
			extensionFactories: [subagents()],
			tools: [
				{
					name: "read",
					label: "Read",
					description: "Read a file",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "file contents" }], details: undefined }),
				},
			],
		});
		const response: FauxResponseFactory = (context) => {
			const system = context.messages.find((message) => message.role === "system");
			return system?.role === "system" &&
				getSystemMessageText(system).includes("You are an isolated worker subagent")
				? fauxAssistantMessage(fauxToolCall("read", {}), { stopReason: "toolUse" })
				: fauxAssistantMessage("Parent done");
		};
		try {
			await harness.session.bindExtensions({ mode: "rpc", uiContext: createTestUiContext() });
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("Agent", { prompt: "Read a file", max_turns: 1, run_in_background: true }),
					{ stopReason: "toolUse" },
				),
				response,
				response,
				response,
				response,
			]);
			await harness.session.prompt("Delegate in the background");
			const record = getToolResult(harness, "Agent").details as SubagentRecord;
			await harness.session
				.getToolDefinition("get_subagent_result")!
				.execute(
					"join",
					{ agent_id: record.id, wait: true },
					undefined,
					undefined,
					harness.session.extensionRunner.createToolContext("join", undefined),
				);
			await harness.session.waitForIdle();
			expect(
				harness.session.messages.find(
					(message) => message.role === "custom" && message.customType === "pie.subagent-completion",
				),
			).toMatchObject({
				content: expect.stringContaining("Subagent turn limit reached"),
				details: { status: "stopped", stopReason: "Subagent turn limit reached" },
			});
		} finally {
			harness.cleanup();
		}
	});
	it("keeps provider failures classified as execution errors", async () => {
		const harness = await createHarness({
			extensionFactories: [subagents()],
			settings: { retry: { enabled: false } },
		});
		try {
			await harness.session.bindExtensions({});
			harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "Invalid API key" })]);
			const result = await harness.session
				.getToolDefinition("Agent")!
				.execute(
					"failed",
					{ prompt: "Return a result", max_turns: 1, run_in_background: false },
					undefined,
					undefined,
					harness.session.extensionRunner.createToolContext("failure-test", undefined),
				);
			expect(result.isError).toBe(true);
			expect(result.details).toMatchObject({ status: "error", error: "Invalid API key" });
			expect((result.details as SubagentRecord).stopReason).toBeUndefined();
		} finally {
			harness.cleanup();
		}
	});
	it("allows a new delegation after tree navigation is cancelled", async () => {
		const harness = await createHarness({
			extensionFactories: [
				subagents(),
				(pi) => {
					pi.on("session_before_tree", () => ({ cancel: true }));
				},
			],
		});
		try {
			await harness.session.bindExtensions({});
			const result = await harness.session.extensionRunner.emit({
				type: "session_before_tree",
				preparation: {
					targetId: "target",
					oldLeafId: null,
					commonAncestorId: null,
					entriesToSummarize: [],
					userWantsSummary: false,
				},
				signal: new AbortController().signal,
			});
			expect(result?.cancel).toBe(true);
			harness.setResponses([fauxAssistantMessage("child after cancelled navigation")]);
			const tool = harness.session.getToolDefinition("Agent")!;
			const output = await tool.execute(
				"after-tree",
				{ prompt: "Return a result", run_in_background: false },
				undefined,
				undefined,
				harness.session.extensionRunner.createToolContext("after-tree", undefined),
			);
			expect((output.details as SubagentRecord).status).toBe("completed");
		} finally {
			harness.cleanup();
		}
	});
	it("restores an interrupted branch task to pending", async () => {
		const harness = await createHarness({ extensionFactories: [tasksPlugin, subagents()] });
		try {
			await harness.session.bindExtensions({});
			harness.sessionManager.appendCustomEntry(TASK_STATE_ENTRY, {
				nextId: 2,
				tasks: [{ ...task("1", "in_progress"), owner: "old-run", agentType: "worker" }],
			});
			harness.sessionManager.appendCustomEntry("pie.subagent", {
				id: "old-run",
				agent: "worker",
				prompt: "Old task",
				description: "Old task",
				status: "running",
				model: "faux/faux-1",
				thinking: "off",
				startedAt: 1,
				output: "",
				taskId: "1",
			});
			await harness.session.extensionRunner.emit({
				type: "session_tree",
				newLeafId: harness.sessionManager.getLeafId(),
				oldLeafId: null,
			});
			expect(readTaskState(harness.sessionManager).tasks[0].status).toBe("pending");
			const entry = harness.sessionManager
				.getBranch()
				.findLast((item) => item.type === "custom" && item.customType === "pie.subagent");
			expect(entry?.type === "custom" ? entry.data : undefined).toMatchObject({
				status: "interrupted",
				taskId: "1",
			});
		} finally {
			harness.cleanup();
		}
	});
	it("uses an isolated foreground session and accounts usage once", async () => {
		const harness = await createHarness({ extensionFactories: [subagents()] });
		const setWidget = vi.fn();
		try {
			await harness.session.bindExtensions({ uiContext: createTestUiContext({ setWidget }) });
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("Agent", {
						prompt: "Return a bounded result",
						description: "Inspect auth flow",
						max_turns: 1,
						run_in_background: false,
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("child result"),
				fauxAssistantMessage("parent done"),
			]);
			await harness.session.prompt("Delegate");
			const result = getToolResult(harness, "Agent");
			const record = result.details as SubagentRecord;
			expect(result.isError).toBe(false);
			expect(record.status).toBe("completed");
			expect(record.output).toBe("child result");
			initTheme("dark");
			const factory = setWidget.mock.calls.at(-1)![1];
			const rows = factory({ terminal: { rows: 24 }, requestRender: vi.fn() } as unknown as TUI, theme)
				.render(80)
				.map(stripAnsi);
			expect(rows.join("\n")).toContain("Inspect auth flow");
			expect(rows[0]).toContain("Subagents");
			expect(record.model).toBe(`${harness.getModel().provider}/${harness.getModel().id}`);
			expect(harness.session.getSessionStats().assistantMessages).toBe(2);
			expect(
				harness.sessionManager.getEntries().filter((entry) => entry.type === "usage" && entry.kind === "subagent"),
			).toHaveLength(1);
		} finally {
			harness.cleanup();
		}
	});
	it("rejects unknown agents before starting work", async () => {
		const harness = await createHarness({ extensionFactories: [subagents()] });
		try {
			await harness.session.bindExtensions({});
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("Agent", { prompt: "Do work", subagent_type: "missing", run_in_background: false }),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("Delegate");
			expect(getToolResult(harness, "Agent").isError).toBe(true);
			expect(
				harness.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "custom" && entry.customType === "pie.subagent"),
			).toHaveLength(0);
		} finally {
			harness.cleanup();
		}
	});
	it("stops a delegated background task without completing the todo", async () => {
		const harness = await createHarness({
			extensionFactories: [tasksPlugin, subagents()],
			settings: { retry: { enabled: false } },
		});
		let started!: () => void;
		const childStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const never = new Promise<ReturnType<typeof fauxAssistantMessage>>(() => {});
		const response: FauxResponseFactory = async (context, options) => {
			const system = context.messages.find((message) => message.role === "system");
			if (
				system?.role === "system" &&
				getSystemMessageText(system).includes("You are an isolated worker subagent")
			) {
				started();
				return raceWithAbortSignal(never, options?.signal);
			}
			return fauxAssistantMessage("parent done");
		};
		try {
			await harness.session.bindExtensions({ mode: "rpc", uiContext: createTestUiContext() });
			harness.sessionManager.appendCustomEntry(TASK_STATE_ENTRY, {
				nextId: 2,
				tasks: [{ ...task("1"), agentType: "worker" }],
			});
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("TaskExecute", { task_ids: ["1"] }), { stopReason: "toolUse" }),
				response,
				response,
				response,
			]);
			await harness.session.prompt("Execute task");
			await childStarted;
			const ctx = harness.session.extensionRunner.createToolContext("stop-test", undefined);
			const stop = harness.session.getToolDefinition("TaskStop")!;
			const result = await stop.execute("stop", { task_id: "1" }, undefined, undefined, ctx);
			expect((result.details as SubagentRecord).status).toBe("stopped");
			expect((result.details as SubagentRecord).description).toBe("Task 1");
			expect(readTaskState(harness.sessionManager).tasks[0].status).toBe("pending");
			await harness.session.waitForIdle();
		} finally {
			harness.cleanup();
		}
	});
});
