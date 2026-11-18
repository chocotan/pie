/**
 * Session goal: one durable completion objective that keeps the agent working
 * across rounds, gates completion on the task ledger, and waits for delegated work.
 */

import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { StringEnum } from "../../core/extensions/pi-ai-extension-view.ts";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import type { ReadonlySessionManager } from "../../core/session-manager.ts";
import { BACKGROUND_ACTIVITY_EVENT } from "../background/registry.ts";
import { SUBAGENT_ENTRY } from "../subagents/index.ts";
import { readTaskState, sortTasks, type TaskRecord } from "../tasks/index.ts";

export const GOAL_STATE_ENTRY = "pie.goal";
export const GOAL_ROUND_MESSAGE = "pie.goal-round";
const GOAL_STATUS_MESSAGE = "pie.goal-status";
const DEFAULT_MAX_ROUNDS = 20;
const MAX_ROUNDS = 1000;
const goalSchema = Type.Object({
	objective: Type.String({ minLength: 1, maxLength: 16_384 }),
	status: StringEnum(["active", "paused", "complete"] as const),
	rounds: Type.Integer({ minimum: 0 }),
	maxRounds: Type.Integer({ minimum: 1, maximum: MAX_ROUNDS }),
	createdAt: Type.Number(),
	updatedAt: Type.Number(),
});
const stateSchema = Type.Object({ goal: Type.Union([goalSchema, Type.Null()]) });
const validateState = Compile(stateSchema);
export type GoalRecord = Static<typeof goalSchema>;

/** Latest goal on the active branch, or null when none is set. */
export function readGoalState(manager: ReadonlySessionManager): GoalRecord | null {
	const entry = manager.getBranch().findLast((item) => item.type === "custom" && item.customType === GOAL_STATE_ENTRY);
	if (!entry || entry.type !== "custom") return null;
	if (!validateState.Check(entry.data)) throw new Error("Invalid saved goal state");
	return structuredClone(entry.data).goal;
}

/** Open work that must be resolved before the goal can be completed. */
export function openTasks(tasks: readonly TaskRecord[]): TaskRecord[] {
	return tasks.filter((task) => task.status !== "completed");
}

/** Whether a queued or running subagent or a background shell can still change the result. */
function delegatedRunning(manager: ReadonlySessionManager, backgroundRunning: number): boolean {
	if (backgroundRunning > 0) return true;
	const latest = new Map<string, string>();
	for (const item of manager.getBranch()) {
		if (item.type !== "custom" || item.customType !== SUBAGENT_ENTRY) continue;
		const data = item.data as { id?: unknown; status?: unknown } | undefined;
		if (typeof data?.id === "string" && typeof data?.status === "string") latest.set(data.id, data.status);
	}
	return [...latest.values()].some((status) => status === "queued" || status === "running");
}

/** One-line task rows for prompts and command output. */
function taskRows(tasks: readonly TaskRecord[]): string {
	if (!tasks.length) return "- none";
	return sortTasks(tasks)
		.map((task) => {
			const subject = task.subject.replace(/\s+/g, " ");
			const blocked = task.blockedBy.length
				? ` (blocked by ${task.blockedBy.map((id) => `#${id}`).join(", ")})`
				: "";
			const agent = task.agentType ? ` · ${task.agentType}` : "";
			return `- #${task.id} [${task.status}] ${subject}${agent}${blocked}`;
		})
		.join("\n");
}

function roundPrompt(goal: GoalRecord, tasks: readonly TaskRecord[]): string {
	return `<goal_round>
Objective: ${JSON.stringify(goal.objective)}
Round: ${goal.rounds}/${goal.maxRounds}

Continue toward the objective in this session. Treat the workspace, tool results, and session history as authoritative; inspect them instead of assuming earlier narration is still current. Make concrete progress and verify the result.

Task ledger:
${taskRows(tasks)}

Keep the ledger honest: mark a task that is already finished completed before starting new work, record new steps with TaskCreate, mark a task in_progress when you start it, and complete it only after the result is verified.${tasks.length ? "" : " No task is recorded yet; if the objective needs more than one step, create tasks for the remaining steps first."} Delegate independent tasks with TaskExecute when they have an agentType; while a subagent or background job runs, wait for its completion notice instead of duplicating its work. GoalUpdate complete is rejected while any task remains open, so complete finished tasks first and confirm the whole objective is achieved. If you need the user or cannot proceed, call GoalUpdate pause and explain why.
</goal_round>`;
}

function view(goal: GoalRecord | null, tasks: readonly TaskRecord[], delegated: boolean, armed: boolean) {
	return {
		goal,
		armed,
		roundsRemaining: goal ? Math.max(0, goal.maxRounds - goal.rounds) : 0,
		delegatedRunning: delegated,
		openTasks: openTasks(tasks).map((task) => ({
			id: task.id,
			subject: task.subject,
			status: task.status,
			blockedBy: task.blockedBy,
			owner: task.owner,
			agentType: task.agentType,
		})),
		totalTasks: tasks.length,
	};
}

export default function goalPlugin(pi: ExtensionAPI): void {
	// Continuation is process-local: a resumed or forked session waits for the user.
	let armed = false;
	let backgroundRunning = 0;
	const save = (goal: GoalRecord | null) => pi.appendEntry(GOAL_STATE_ENTRY, { goal });
	const result = (value: unknown) => ({
		content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
		details: value,
	});
	const statusText = (goal: GoalRecord | null, tasks: readonly TaskRecord[], delegated: boolean): string => {
		if (!goal) return "No goal is set. Use /goal <objective> to set one.";
		return [
			`Goal: ${goal.objective}`,
			`Status: ${goal.status}${goal.status === "active" ? (armed ? " (armed)" : " (disarmed; send a message or /goal resume)") : ""}`,
			`Rounds: ${goal.rounds}/${goal.maxRounds}${delegated ? " · delegated work running" : ""}`,
			`Tasks: ${openTasks(tasks).length} open / ${tasks.length} total`,
			openTasks(tasks).length ? taskRows(openTasks(tasks)) : "",
		]
			.filter(Boolean)
			.join("\n");
	};
	const update = (
		goal: GoalRecord,
		changes: Partial<Pick<GoalRecord, "status" | "rounds" | "maxRounds">>,
	): GoalRecord => ({ ...goal, ...changes, updatedAt: Date.now() });

	pi.events.on(BACKGROUND_ACTIVITY_EVENT, (data) => {
		if (!data || typeof data !== "object" || !("running" in data)) return;
		const running = (data as { running?: unknown }).running;
		if (typeof running === "number" && Number.isSafeInteger(running) && running >= 0) backgroundRunning = running;
	});
	pi.on("session_start", () => {
		armed = false;
		backgroundRunning = 0;
	});
	pi.on("session_tree", () => {
		armed = false;
	});
	pi.on("session_shutdown", () => {
		armed = false;
	});
	pi.on("input", (_event, ctx) => {
		const goal = readGoalState(ctx.sessionManager);
		if (goal?.status === "active") armed = true;
	});

	pi.on("agent_before_settle", (event, ctx) => {
		const goal = readGoalState(ctx.sessionManager);
		if (!goal || goal.status !== "active" || !armed) return;
		if (event.outcome === "aborted") {
			armed = false;
			ctx.ui.notify("Goal paused: the run was interrupted. Send a message or /goal resume to continue.", "info");
			return;
		}
		// Another boundary handler (empty response, output limit) already continues.
		if (event.outcome !== "completed" || event.continue) return;
		const delegated = delegatedRunning(ctx.sessionManager, backgroundRunning);
		if (delegated) return;
		const tasks = readTaskState(ctx.sessionManager).tasks;
		if (goal.rounds >= goal.maxRounds) {
			const paused = update(goal, { status: "paused" });
			ctx.ui.notify(`Goal paused at its ${goal.maxRounds}-round cap. /goal resume adds more rounds.`, "info");
			return {
				entries: [
					...event.entries,
					{ type: "custom" as const, customType: GOAL_STATE_ENTRY, data: { goal: paused } },
				],
			};
		}
		const next = update(goal, { rounds: goal.rounds + 1 });
		ctx.ui.notify(`Goal round ${next.rounds}/${next.maxRounds}`, "info");
		return {
			entries: [
				...event.entries,
				{ type: "custom" as const, customType: GOAL_STATE_ENTRY, data: { goal: next } },
				{
					type: "custom_message" as const,
					customType: GOAL_ROUND_MESSAGE,
					content: roundPrompt(next, tasks),
					display: false,
					details: { round: next.rounds, maxRounds: next.maxRounds, objective: next.objective },
				},
			],
			continue: true,
		};
	});

	pi.registerTool({
		name: "GoalSet",
		label: "Set goal",
		description:
			"Set the session's completion goal. While an active goal exists, every settled turn starts another round until the goal is complete, paused, or the round cap is reached. Use it when the user asks for a multi-step objective to be carried through, and keep the task ledger current. Only one goal can be active.",
		promptSnippet: "Set a completion goal that keeps the session working",
		promptGuidelines: [
			"Set a goal only for a multi-step objective the user wants carried to completion; routine single-turn work needs none.",
		],
		executionMode: "sequential",
		parameters: Type.Object({
			objective: Type.String({ minLength: 1, maxLength: 16_384 }),
			maxRounds: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_ROUNDS, default: DEFAULT_MAX_ROUNDS })),
		}),
		async execute(_id, args, _signal, _update, ctx) {
			const current = readGoalState(ctx.sessionManager);
			if (current?.status === "active")
				throw new Error("A goal is already active; complete, pause, or clear it first.");
			const objective = args.objective.trim();
			if (!objective) throw new Error("Goal objective must not be blank");
			const now = Date.now();
			const goal: GoalRecord = {
				objective,
				status: "active",
				rounds: 0,
				maxRounds: args.maxRounds ?? DEFAULT_MAX_ROUNDS,
				createdAt: now,
				updatedAt: now,
			};
			save(goal);
			armed = true;
			return result(
				view(
					goal,
					readTaskState(ctx.sessionManager).tasks,
					delegatedRunning(ctx.sessionManager, backgroundRunning),
					armed,
				),
			);
		},
	});
	pi.registerTool({
		name: "GoalGet",
		label: "Read goal",
		description: "Read the current goal, open tasks, delegated work still running, and remaining rounds.",
		parameters: Type.Object({}),
		annotations: { readOnlyHint: true },
		async execute(_id, _args, _signal, _update, ctx) {
			const tasks = readTaskState(ctx.sessionManager).tasks;
			return result(
				view(
					readGoalState(ctx.sessionManager),
					tasks,
					delegatedRunning(ctx.sessionManager, backgroundRunning),
					armed,
				),
			);
		},
	});
	pi.registerTool({
		name: "GoalUpdate",
		label: "Update goal",
		description:
			"Update the goal: complete (rejected while tasks remain open), pause, resume, or clear. Resume extends the round cap when it was exhausted.",
		executionMode: "sequential",
		parameters: Type.Object({
			action: StringEnum(["complete", "pause", "resume", "clear"] as const),
		}),
		async execute(_id, args, _signal, _update, ctx) {
			const goal = readGoalState(ctx.sessionManager);
			if (!goal) throw new Error("No goal is set; use GoalSet first");
			const tasks = readTaskState(ctx.sessionManager).tasks;
			if (args.action === "complete") {
				if (delegatedRunning(ctx.sessionManager, backgroundRunning))
					throw new Error(
						"Delegated work is still running; wait for its completion notice before completing the goal.",
					);
				const open = openTasks(tasks);
				if (open.length)
					throw new Error(
						`Goal has unfinished tasks: ${open.map((task) => `#${task.id} ${task.status}`).join(", ")}. Update or delete them first.`,
					);
				const complete = update(goal, { status: "complete" });
				save(complete);
				armed = false;
				return result(view(complete, tasks, false, armed));
			}
			if (args.action === "pause") {
				const paused = update(goal, { status: "paused" });
				save(paused);
				armed = false;
				return result(view(paused, tasks, false, armed));
			}
			if (args.action === "resume") {
				if (goal.status === "complete") throw new Error("The goal is complete; set a new goal instead");
				const resumed = update(goal, {
					status: "active",
					maxRounds: goal.rounds >= goal.maxRounds ? goal.rounds + DEFAULT_MAX_ROUNDS : goal.maxRounds,
				});
				save(resumed);
				armed = true;
				return result(
					view(
						resumed,
						readTaskState(ctx.sessionManager).tasks,
						delegatedRunning(ctx.sessionManager, backgroundRunning),
						armed,
					),
				);
			}
			save(null);
			armed = false;
			return result(view(null, tasks, false, armed));
		},
	});
	pi.registerCommand("goal", {
		description: "Set, inspect, pause, resume, complete, or clear the session goal",
		async handler(args, ctx) {
			const verb = args.trim();
			const current = readGoalState(ctx.sessionManager);
			const tasks = readTaskState(ctx.sessionManager).tasks;
			const delegated = delegatedRunning(ctx.sessionManager, backgroundRunning);
			const show = (goal: GoalRecord | null) => {
				const text = statusText(goal, tasks, delegated);
				if (ctx.hasUI) ctx.ui.notify(text, "info");
				else pi.sendMessage({ customType: GOAL_STATUS_MESSAGE, content: text, display: true });
			};
			if (!verb || verb === "status") {
				show(current);
				return;
			}
			if (verb === "pause") {
				if (!current) throw new Error("No goal is set");
				save(update(current, { status: "paused" }));
				armed = false;
				show(readGoalState(ctx.sessionManager));
				return;
			}
			if (verb === "resume") {
				if (!current) throw new Error("No goal is set");
				if (current.status === "complete") throw new Error("The goal is complete; set a new goal instead");
				save(
					update(current, {
						status: "active",
						maxRounds:
							current.rounds >= current.maxRounds ? current.rounds + DEFAULT_MAX_ROUNDS : current.maxRounds,
					}),
				);
				armed = true;
				show(readGoalState(ctx.sessionManager));
				return;
			}
			if (verb === "complete") {
				if (!current) throw new Error("No goal is set");
				const open = openTasks(tasks);
				save(update(current, { status: "complete" }));
				armed = false;
				show(readGoalState(ctx.sessionManager));
				if (open.length)
					ctx.ui.notify(`Goal completed with ${open.length} open task(s); the ledger was left as is.`, "warning");
				return;
			}
			if (verb === "clear") {
				save(null);
				armed = false;
				show(null);
				return;
			}
			const now = Date.now();
			const goal: GoalRecord = {
				objective: verb,
				status: "active",
				rounds: 0,
				maxRounds: DEFAULT_MAX_ROUNDS,
				createdAt: now,
				updatedAt: now,
			};
			save(goal);
			armed = true;
			show(goal);
		},
	});
}
