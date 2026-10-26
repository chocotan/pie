import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import type { ReadonlySessionManager } from "../../core/session-manager.ts";
import { TaskDetailView, TodoPanel } from "./view.ts";

export const TASK_STATE_ENTRY = "pie.tasks";
export const TASK_RUN_EVENT = "pie.task-run";
const taskSchema = Type.Object({
	id: Type.String(),
	subject: Type.String({ minLength: 1, maxLength: 400 }),
	description: Type.String({ maxLength: 32768 }),
	status: StringEnum(["pending", "in_progress", "completed"] as const),
	activeForm: Type.Optional(Type.String()),
	agentType: Type.Optional(Type.String()),
	owner: Type.Optional(Type.String()),
	metadata: Type.Record(Type.String(), Type.Unknown()),
	blockedBy: Type.Array(Type.String()),
});
const stateSchema = Type.Object({ nextId: Type.Integer({ minimum: 1 }), tasks: Type.Array(taskSchema) });
const validateState = Compile(stateSchema);
export type TaskRecord = Static<typeof taskSchema>;
export type TaskState = Static<typeof stateSchema>;

export function sortTasks(tasks: readonly TaskRecord[]): TaskRecord[] {
	return [
		...tasks.filter((task) => task.status === "in_progress"),
		...tasks.filter((task) => task.status === "pending"),
		...tasks.filter((task) => task.status === "completed").reverse(),
	];
}

function retainTasks(state: TaskState): TaskState {
	const removed = new Set(
		state.tasks
			.filter((task) => task.status === "completed")
			.slice(0, Math.max(0, state.tasks.length - 10))
			.map((task) => task.id),
	);
	if (!removed.size) return state;
	return {
		...state,
		tasks: state.tasks
			.filter((task) => !removed.has(task.id))
			.map((task) => ({
				...task,
				blockedBy: task.blockedBy.filter((id) => !removed.has(id)),
			})),
	};
}

export function readTaskState(manager: ReadonlySessionManager): TaskState {
	const entry = manager.getBranch().findLast((item) => item.type === "custom" && item.customType === TASK_STATE_ENTRY);
	if (!entry || entry.type !== "custom") return { nextId: 1, tasks: [] };
	if (!validateState.Check(entry.data)) throw new Error("Invalid saved task state");
	return retainTasks(structuredClone(entry.data));
}

const updateSchema = Type.Object({
	taskId: Type.String(),
	status: Type.Optional(StringEnum(["pending", "in_progress", "completed", "deleted"] as const)),
	subject: Type.Optional(taskSchema.properties.subject),
	description: Type.Optional(taskSchema.properties.description),
	activeForm: Type.Optional(Type.String()),
	agentType: Type.Optional(Type.String()),
	owner: Type.Optional(Type.String()),
	metadata: Type.Optional(taskSchema.properties.metadata),
	addBlocks: Type.Optional(Type.Array(Type.String())),
	addBlockedBy: Type.Optional(Type.Array(Type.String())),
});

export function updateTask(state: TaskState, changes: Static<typeof updateSchema>): TaskState {
	const next = structuredClone(state);
	const task = next.tasks.find((item) => item.id === changes.taskId);
	if (!task) throw new Error(`Unknown task: ${changes.taskId}`);
	if (changes.status === "deleted") {
		next.tasks = next.tasks.filter((item) => item.id !== task.id);
		for (const item of next.tasks) item.blockedBy = item.blockedBy.filter((id) => id !== task.id);
		return next;
	}
	for (const key of ["subject", "description", "activeForm", "agentType", "owner"] as const) {
		const value = changes[key];
		if (value !== undefined) task[key] = value;
	}
	if (!task.subject.trim()) throw new Error("Task subject must not be blank");
	if (changes.status) task.status = changes.status;
	for (const [key, value] of Object.entries(changes.metadata ?? {})) {
		if (value === null) delete task.metadata[key];
		else Object.defineProperty(task.metadata, key, { value, enumerable: true, configurable: true, writable: true });
	}
	for (const id of changes.addBlockedBy ?? []) task.blockedBy = [...new Set([...task.blockedBy, id])];
	for (const id of changes.addBlocks ?? []) {
		const blocked = next.tasks.find((item) => item.id === id);
		if (!blocked) throw new Error(`Unknown task: ${id}`);
		blocked.blockedBy = [...new Set([...blocked.blockedBy, task.id])];
	}
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (id: string): void => {
		if (visiting.has(id)) throw new Error("Task dependencies must not contain a cycle");
		if (visited.has(id)) return;
		const item = next.tasks.find((candidate) => candidate.id === id);
		if (!item) throw new Error(`Unknown dependency: ${id}`);
		visiting.add(id);
		for (const dependency of item.blockedBy) visit(dependency);
		visiting.delete(id);
		visited.add(id);
	};
	for (const item of next.tasks) visit(item.id);
	if (changes.status === "in_progress" || changes.status === "completed") {
		const open = task.blockedBy.filter((id) => next.tasks.find((item) => item.id === id)?.status !== "completed");
		if (open.length) throw new Error(`Task ${task.id} is blocked by ${open.join(", ")}`);
	}
	return next;
}

export default function tasksPlugin(pi: ExtensionAPI): void {
	let context: ExtensionContext | undefined;
	let state: TaskState = { nextId: 1, tasks: [] };
	let dismissed = false;
	const hidePanel = () => context?.ui.setWidget("pie.todo", undefined);
	const resetPanel = () => {
		hidePanel();
		dismissed = false;
	};
	const showTask = async (task: TaskRecord, ctx: ExtensionContext) => {
		if (ctx.hasUI && ctx.mode === "tui") {
			await ctx.ui.custom<void>((tui, _theme, _keys, done) => new TaskDetailView(tui, task, done), {
				overlay: true,
				overlayOptions: { width: "72%", maxHeight: "80%" },
			});
			return;
		}
		pi.sendMessage({ customType: "pie.task-detail", content: JSON.stringify(task, null, 2), display: true });
	};
	const show = (ctx: ExtensionContext) => {
		context = ctx;
		state = readTaskState(ctx.sessionManager);
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		if (dismissed || !state.tasks.length) {
			hidePanel();
			return;
		}
		ctx.ui.setWidget(
			"pie.todo",
			(tui) =>
				new TodoPanel(
					tui,
					() => state,
					() => {
						dismissed = true;
						hidePanel();
					},
					(task) => void showTask(task, ctx).catch((error: unknown) => ctx.ui.notify(String(error), "error")),
					() => {
						const tasks = sortTasks(state.tasks);
						const labels = tasks.map((task) => `#${task.id} ${task.subject} · ${task.status}`);
						void ctx.ui
							.select("All tasks", labels)
							.then(async (selected) => {
								const task = tasks[labels.indexOf(selected ?? "")];
								if (task)
									await showTask(task, ctx).catch((error: unknown) => ctx.ui.notify(String(error), "error"));
							})
							.catch((error: unknown) => ctx.ui.notify(String(error), "error"));
					},
				),
			{ placement: "floating", order: 10 },
		);
	};
	const save = (state: TaskState, ctx: ExtensionContext) => {
		pi.appendEntry(TASK_STATE_ENTRY, retainTasks(state));
		show(ctx);
	};
	pi.on("session_start", (_event, ctx) => {
		resetPanel();
		show(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		resetPanel();
		show(ctx);
	});
	pi.on("session_shutdown", () => {
		resetPanel();
		context = undefined;
	});
	pi.events.on(TASK_RUN_EVENT, (data) => {
		if (!context || !data || typeof data !== "object" || !("taskId" in data) || !("status" in data)) return;
		if (
			typeof data.taskId !== "string" ||
			typeof data.status !== "string" ||
			!["pending", "in_progress", "completed"].includes(data.status)
		)
			return;
		const state = readTaskState(context.sessionManager);
		const task = state.tasks.find((item) => item.id === data.taskId);
		if (!task) return;
		const owner = "owner" in data && typeof data.owner === "string" ? data.owner : undefined;
		if (data.status !== "in_progress" && task.owner && task.owner !== owner) return;
		if (data.status === "in_progress" && task.status !== "pending" && task.owner !== owner) return;
		save(
			updateTask(state, {
				taskId: data.taskId,
				status: data.status as TaskRecord["status"],
				owner,
			}),
			context,
		);
	});
	const result = (value: unknown) => ({
		content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
		details: value,
	});
	pi.registerTool({
		name: "TaskCreate",
		label: "Create task",
		description:
			"Create a session task with pending status. Use for multi-step work; keep statuses current. Above ten records, the oldest completed tasks are removed automatically.",
		promptSnippet: "Create a task for multi-step work",
		executionMode: "sequential",
		parameters: Type.Object({
			subject: taskSchema.properties.subject,
			description: taskSchema.properties.description,
			activeForm: Type.Optional(Type.String()),
			agentType: Type.Optional(Type.String()),
			metadata: Type.Optional(taskSchema.properties.metadata),
		}),
		async execute(_id, args, _signal, _update, ctx) {
			if (!args.subject.trim()) throw new Error("Task subject must not be blank");
			const state = readTaskState(ctx.sessionManager);
			const task: TaskRecord = {
				...args,
				id: String(state.nextId++),
				status: "pending",
				blockedBy: [],
				metadata: args.metadata ?? {},
			};
			state.tasks.push(task);
			save(state, ctx);
			return result(task);
		},
	});
	pi.registerTool({
		name: "TaskList",
		label: "List tasks",
		description:
			"List retained tasks on the current session branch, with in-progress work first and completed work last, including blockers.",
		parameters: Type.Object({}),
		annotations: { readOnlyHint: true },
		async execute(_id, _args, _signal, _update, ctx) {
			return result(sortTasks(readTaskState(ctx.sessionManager).tasks));
		},
	});
	pi.registerTool({
		name: "TaskGet",
		label: "Read task",
		description: "Read a task's full requirements, status, owner, and dependencies.",
		parameters: Type.Object({ taskId: Type.String() }),
		annotations: { readOnlyHint: true },
		async execute(_id, args, _signal, _update, ctx) {
			const tasks = readTaskState(ctx.sessionManager).tasks;
			const task = tasks.find((item) => item.id === args.taskId);
			if (!task) throw new Error(`Unknown task: ${args.taskId}`);
			return result({
				...task,
				blocks: tasks.filter((item) => item.blockedBy.includes(task.id)).map((item) => item.id),
			});
		},
	});
	pi.registerTool({
		name: "TaskUpdate",
		label: "Update task",
		description:
			"Update a task or delete it with status deleted. Dependencies must exist and remain acyclic. Metadata merges; null removes a key.",
		promptSnippet: "Update task progress and dependencies",
		executionMode: "sequential",
		parameters: updateSchema,
		async execute(_id, args, _signal, _update, ctx) {
			const state = updateTask(readTaskState(ctx.sessionManager), args);
			save(state, ctx);
			return result(
				state.tasks.find((task) => task.id === args.taskId) ?? { taskId: args.taskId, status: "deleted" },
			);
		},
	});
	for (const command of ["tasks", "todos"])
		pi.registerCommand(command, {
			description: "Show tasks on the current session branch",
			async handler(_args, ctx) {
				if (ctx.hasUI && ctx.mode === "tui") {
					dismissed = false;
					show(ctx);
					return;
				}
				pi.sendMessage({
					customType: "pie.task-list",
					content: JSON.stringify(sortTasks(readTaskState(ctx.sessionManager).tasks), null, 2),
					display: true,
				});
			},
		});
}
