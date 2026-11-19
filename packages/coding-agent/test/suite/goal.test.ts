import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { EventBus } from "../../src/core/event-bus.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { BACKGROUND_ACTIVITY_EVENT } from "../../src/extensions/background/registry.ts";
import goalPlugin, { GOAL_STATE_ENTRY, readGoalState } from "../../src/extensions/goal/index.ts";
import { createSubagentsExtension, SUBAGENT_ENTRY } from "../../src/extensions/subagents/index.ts";
import tasksPlugin, { readTaskState } from "../../src/extensions/tasks/index.ts";
import { createHarness, getAssistantTexts, type Harness } from "./harness.ts";

const goal = (status: "active" | "paused" | "complete" = "active") => ({
	objective: "Ship the release",
	status,
	rounds: 0,
	maxRounds: 3,
	createdAt: 1,
	updatedAt: 1,
});
describe("goal extension", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});
	const setup = async (factories = [goalPlugin]) => {
		const harness = await createHarness({ extensionFactories: factories });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		return harness;
	};
	const tool = (harness: Harness, name: string) => harness.session.getToolDefinition(name)!;
	const toolContext = (harness: Harness) => harness.session.extensionRunner.createToolContext("goal-test", undefined);

	it("reads only the active branch and clones the saved goal", () => {
		const manager = SessionManager.inMemory();
		const first = manager.appendCustomEntry(GOAL_STATE_ENTRY, { goal: goal() });
		manager.appendCustomEntry(GOAL_STATE_ENTRY, { goal: goal("complete") });
		manager.branch(first);
		const state = readGoalState(manager);
		expect(state?.status).toBe("active");
		if (!state) throw new Error("expected a goal");
		state.objective = "Changed";
		expect(readGoalState(manager)?.objective).toBe("Ship the release");
		expect(readGoalState(SessionManager.inMemory())).toBeNull();
	});

	it("sets one goal, refuses completion while tasks are open, and clears it", async () => {
		const harness = await setup([goalPlugin, tasksPlugin]);
		const ctx = toolContext(harness);
		await tool(harness, "GoalSet").execute("set", { objective: "Ship it", maxRounds: 2 }, undefined, undefined, ctx);
		expect(readGoalState(harness.sessionManager)).toMatchObject({
			objective: "Ship it",
			status: "active",
			maxRounds: 2,
		});
		await expect(
			tool(harness, "GoalSet").execute("set-again", { objective: "Other" }, undefined, undefined, ctx),
		).rejects.toThrow("already active");

		await tool(harness, "TaskCreate").execute(
			"task",
			{ subject: "Write tests", description: "Cover the goal" },
			undefined,
			undefined,
			ctx,
		);
		await expect(
			tool(harness, "GoalUpdate").execute("complete", { action: "complete" }, undefined, undefined, ctx),
		).rejects.toThrow("unfinished tasks");

		await tool(harness, "TaskUpdate").execute(
			"done",
			{ taskId: "1", status: "completed" },
			undefined,
			undefined,
			ctx,
		);
		await tool(harness, "GoalUpdate").execute("complete", { action: "complete" }, undefined, undefined, ctx);
		expect(readGoalState(harness.sessionManager)?.status).toBe("complete");
		await expect(
			tool(harness, "GoalUpdate").execute("resume", { action: "resume" }, undefined, undefined, ctx),
		).rejects.toThrow("complete");

		await tool(harness, "GoalUpdate").execute("clear", { action: "clear" }, undefined, undefined, ctx);
		expect(readGoalState(harness.sessionManager)).toBeNull();
	});

	it("guides the parent to set goals and delegate tasks without giving children orchestration tools", async () => {
		const harness = await setup([
			goalPlugin,
			tasksPlugin,
			createSubagentsExtension({ agentDir: join(tmpdir(), `pie-test-${randomUUID()}`) }),
		]);
		harness.setResponses([
			({ messages }) => {
				const tools = getCurrentTools(messages);
				expect(getCurrentSystemPrompt(messages)).toContain("without waiting for a /goal command");
				expect(tools.find((tool) => tool.name === "GoalSet")?.description).toContain(
					"the conversation establishes",
				);
				expect(tools.find((tool) => tool.name === "TaskCreate")?.description).toContain("addBlockedBy");
				expect(tools.find((tool) => tool.name === "TaskExecute")?.description).toContain("Proactively delegate");
				return fauxAssistantMessage(fauxToolCall("GoalSet", { objective: "Prepare and verify release notes" }), {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage(
				fauxToolCall("TaskCreate", {
					subject: "Review the release notes",
					description: "Check that each item describes a user-facing change",
					agentType: "reviewer",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("TaskExecute", { task_ids: ["1"] }), { stopReason: "toolUse" }),
			({ messages }) => {
				expect(getCurrentSystemPrompt(messages)).toContain("You are an isolated reviewer subagent");
				expect(getCurrentTools(messages).map((tool) => tool.name)).not.toContain("GoalSet");
				expect(getCurrentTools(messages).map((tool) => tool.name)).not.toContain("TaskExecute");
				return fauxAssistantMessage("Review complete");
			},
			fauxAssistantMessage(fauxToolCall("GoalUpdate", { action: "complete" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Release notes verified"),
		]);
		await harness.session.prompt("Prepare the release notes from the changelog and verify every entry.");

		expect(readTaskState(harness.sessionManager).tasks[0]).toMatchObject({
			status: "completed",
			agentType: "reviewer",
		});
		expect(readGoalState(harness.sessionManager)).toMatchObject({ status: "complete", rounds: 0 });
	});

	it("continues with a round prompt that names the objective and the task ledger, then pauses at the cap", async () => {
		const harness = await setup([goalPlugin, tasksPlugin]);
		harness.sessionManager.appendCustomEntry(GOAL_STATE_ENTRY, { goal: { ...goal(), maxRounds: 1 } });
		const ctx = toolContext(harness);
		await tool(harness, "TaskCreate").execute(
			"task",
			{ subject: "Verify output", description: "Check the result" },
			undefined,
			undefined,
			ctx,
		);
		let continued = "";
		harness.setResponses([
			fauxAssistantMessage("first pass"),
			(context) => {
				continued = JSON.stringify(context.messages);
				return fauxAssistantMessage("second pass");
			},
		]);
		await harness.session.prompt("do the work");

		expect(continued).toContain("<goal_round>");
		expect(continued).toContain("Ship the release");
		expect(continued).toContain("Round: 1/1");
		expect(continued).toContain("#1 [pending] Verify output");
		expect(getAssistantTexts(harness)).toEqual(["first pass", "second pass"]);
		expect(readGoalState(harness.sessionManager)).toMatchObject({ status: "paused", rounds: 1 });
	});

	it("waits while a delegated subagent or background shell is still running", async () => {
		let events!: EventBus;
		const harness = await setup([
			(pi) => {
				events = pi.events;
				goalPlugin(pi);
			},
		]);
		harness.sessionManager.appendCustomEntry(GOAL_STATE_ENTRY, { goal: { ...goal(), maxRounds: 1 } });
		harness.sessionManager.appendCustomEntry(SUBAGENT_ENTRY, { id: "agent-1", status: "running" });
		await expect(
			tool(harness, "GoalUpdate").execute(
				"complete",
				{ action: "complete" },
				undefined,
				undefined,
				toolContext(harness),
			),
		).rejects.toThrow("Delegated work is still running");
		harness.setResponses([fauxAssistantMessage("waiting for the subagent")]);
		await harness.session.prompt("start");
		expect(readGoalState(harness.sessionManager)?.rounds).toBe(0);

		harness.sessionManager.appendCustomEntry(SUBAGENT_ENTRY, { id: "agent-1", status: "completed" });
		events.emit(BACKGROUND_ACTIVITY_EVENT, { running: 1 });
		harness.setResponses([fauxAssistantMessage("waiting for the shell")]);
		await harness.session.prompt("still waiting");
		expect(readGoalState(harness.sessionManager)?.rounds).toBe(0);

		events.emit(BACKGROUND_ACTIVITY_EVENT, { running: 0 });
		harness.setResponses([fauxAssistantMessage("shell done"), fauxAssistantMessage("next round")]);
		await harness.session.prompt("continue");
		expect(readGoalState(harness.sessionManager)).toMatchObject({ status: "paused", rounds: 1 });
	});

	it("drives the same lifecycle from the /goal command", async () => {
		const harness = await setup([goalPlugin, tasksPlugin]);
		const runner = harness.session.extensionRunner;
		const run = (args: string) => runner.getCommand("goal")!.handler(args, runner.createCommandContext());
		await run("Ship the release");
		expect(readGoalState(harness.sessionManager)).toMatchObject({ status: "active", rounds: 0 });
		await run("pause");
		expect(readGoalState(harness.sessionManager)?.status).toBe("paused");
		await run("resume");
		expect(readGoalState(harness.sessionManager)?.status).toBe("active");
		await run("clear");
		expect(readGoalState(harness.sessionManager)).toBeNull();
	});
});
