import { type FauxResponseFactory, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createSubagentsExtension, SUBAGENT_ENTRY, type SubagentRecord } from "../../src/extensions/subagents/index.ts";
import tasksPlugin, { readTaskState, TASK_STATE_ENTRY, type TaskRecord } from "../../src/extensions/tasks/index.ts";
import { raceWithAbortSignal } from "../../src/utils/abort.ts";
import { createHarness, createTestUiContext } from "./harness.ts";

const task = (id: number, status: TaskRecord["status"] = "pending"): TaskRecord => ({
	id: String(id),
	subject: `Task ${id}`,
	description: "Retention fixture",
	status,
	metadata: {},
	blockedBy: [],
});
const record = (id: number, status: SubagentRecord["status"] = "completed"): SubagentRecord => ({
	id: `child-${id}`,
	agent: "worker",
	description: `Child ${id}`,
	prompt: "Retention fixture",
	status,
	model: "faux/local",
	thinking: "off",
	startedAt: id,
	finishedAt: status === "completed" ? id + 100 : undefined,
	output: "Finished",
});

describe("workflow list retention", () => {
	it("prunes old completed tasks on restore and removes their dependency links without reusing IDs", () => {
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry(TASK_STATE_ENTRY, {
			nextId: 14,
			tasks: Array.from({ length: 13 }, (_, index) => ({
				...task(index + 1, index < 4 ? "completed" : "pending"),
				blockedBy: index === 4 ? ["1", "4"] : [],
			})),
		});
		const state = readTaskState(manager);
		expect(state.nextId).toBe(14);
		expect(state.tasks.map((item) => item.id)).toEqual(Array.from({ length: 10 }, (_, index) => String(index + 4)));
		expect(state.tasks.find((item) => item.id === "5")?.blockedBy).toEqual(["4"]);
	});

	it("retains unfinished overflow, then cleans completed tasks on update and create", async () => {
		const harness = await createHarness({ extensionFactories: [tasksPlugin] });
		try {
			await harness.session.bindExtensions({});
			harness.sessionManager.appendCustomEntry(TASK_STATE_ENTRY, {
				nextId: 13,
				tasks: Array.from({ length: 12 }, (_, index) => task(index + 1)),
			});
			const ctx = harness.session.extensionRunner.createToolContext("retention", undefined);
			const update = harness.session.getToolDefinition("TaskUpdate")!;
			const create = harness.session.getToolDefinition("TaskCreate")!;
			await update.execute("link", { taskId: "3", addBlockedBy: ["1"] }, undefined, undefined, ctx);
			expect(readTaskState(harness.sessionManager).tasks).toHaveLength(12);
			const completed = await update.execute(
				"complete-1",
				{ taskId: "1", status: "completed" },
				undefined,
				undefined,
				ctx,
			);
			expect(completed.details).toMatchObject({ id: "1", status: "completed" });
			expect(readTaskState(harness.sessionManager).tasks).toHaveLength(11);
			expect(readTaskState(harness.sessionManager).tasks.find((item) => item.id === "3")?.blockedBy).toEqual([]);
			await update.execute("complete-2", { taskId: "2", status: "completed" }, undefined, undefined, ctx);
			await update.execute("complete-3", { taskId: "3", status: "completed" }, undefined, undefined, ctx);
			await update.execute("progress", { taskId: "5", status: "in_progress" }, undefined, undefined, ctx);
			const list = await harness.session
				.getToolDefinition("TaskList")!
				.execute("list", {}, undefined, undefined, ctx);
			expect((list.details as TaskRecord[])[0]).toMatchObject({ id: "5", status: "in_progress" });
			expect((list.details as TaskRecord[]).at(-1)?.id).toBe("3");
			await create.execute(
				"create",
				{ subject: "New task", description: "Still unfinished" },
				undefined,
				undefined,
				ctx,
			);
			const retained = readTaskState(harness.sessionManager);
			expect(retained.tasks).toHaveLength(10);
			expect(retained.tasks.some((item) => item.id === "3")).toBe(false);
			expect(retained.tasks.at(-1)?.id).toBe("13");
		} finally {
			harness.cleanup();
		}
	});

	it("keeps the ten newest completed subagents removed across reload/tree, without losing history or usage", async () => {
		const manager = SessionManager.inMemory();
		for (let id = 1; id <= 12; id++) {
			manager.appendCustomEntry(SUBAGENT_ENTRY, record(id, "running"));
			manager.appendCustomEntry(SUBAGENT_ENTRY, record(id));
		}
		const harness = await createHarness({
			sessionManager: manager,
			extensionFactories: [createSubagentsExtension()],
		});
		try {
			await harness.session.bindExtensions({});
			const ctx = harness.session.extensionRunner.createToolContext("retention", undefined);
			const list = async (): Promise<SubagentRecord[]> => {
				const result = await harness.session
					.getToolDefinition("list_subagents")!
					.execute("list", {}, undefined, undefined, ctx);
				const text = result.content.find((part) => part.type === "text");
				if (text?.type !== "text") throw new Error("Missing list");
				return (JSON.parse(text.text) as { runs: SubagentRecord[] }).runs;
			};
			expect((await list()).map((item) => item.id)).toEqual(
				Array.from({ length: 10 }, (_, index) => `child-${12 - index}`),
			);
			expect(
				manager
					.getBranch()
					.filter((entry) => entry.type === "custom" && entry.customType === "pie.subagent-removed"),
			).toHaveLength(2);
			harness.setResponses([fauxAssistantMessage("New child result")]);
			const agent = await harness.session
				.getToolDefinition("Agent")!
				.execute("new-child", { prompt: "Return a result", run_in_background: false }, undefined, undefined, ctx);
			expect((agent.details as SubagentRecord).status).toBe("completed");
			expect(await list()).toHaveLength(10);
			expect((await list()).some((item) => item.id === "child-3")).toBe(false);
			await harness.session.extensionRunner.emit({ type: "session_start", reason: "reload" });
			await harness.session.extensionRunner.emit({
				type: "session_tree",
				newLeafId: manager.getLeafId(),
				oldLeafId: null,
			});
			expect(await list()).toHaveLength(10);
			expect((await list()).some((item) => item.id === "child-3")).toBe(false);
			expect(
				manager.getEntries().filter((entry) => entry.type === "usage" && entry.kind === "subagent"),
			).toHaveLength(1);
			expect(
				manager
					.getEntries()
					.some(
						(entry) =>
							entry.type === "custom" &&
							entry.customType === SUBAGENT_ENTRY &&
							(entry.data as SubagentRecord).id === "child-1",
					),
			).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	it("never prunes live or queued subagents when unfinished work exceeds ten", async () => {
		const harness = await createHarness({
			extensionFactories: [createSubagentsExtension()],
			settings: { retry: { enabled: false } },
		});
		let started = 0;
		const never = new Promise<ReturnType<typeof fauxAssistantMessage>>(() => {});
		const response: FauxResponseFactory = async (_context, options) => {
			started++;
			return raceWithAbortSignal(never, options?.signal);
		};
		try {
			await harness.session.bindExtensions({ mode: "rpc", uiContext: createTestUiContext() });
			harness.setResponses(Array.from({ length: 4 }, () => response));
			const ctx = harness.session.extensionRunner.createToolContext("live-retention", undefined);
			const agent = harness.session.getToolDefinition("Agent")!;
			for (let index = 0; index < 12; index++)
				await agent.execute(
					String(index),
					{ prompt: "Wait for cancellation", run_in_background: true },
					undefined,
					undefined,
					ctx,
				);
			await vi.waitFor(() => expect(started).toBe(4));
			const result = await harness.session
				.getToolDefinition("list_subagents")!
				.execute("list", {}, undefined, undefined, ctx);
			const text = result.content.find((part) => part.type === "text");
			if (text?.type !== "text") throw new Error("Missing list");
			const runs = (JSON.parse(text.text) as { runs: SubagentRecord[] }).runs;
			expect(runs).toHaveLength(12);
			expect(runs.slice(0, 4).every((item) => item.status === "running")).toBe(true);
			expect(runs.slice(4).every((item) => item.status === "queued")).toBe(true);
		} finally {
			await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			harness.cleanup();
		}
	});
});
