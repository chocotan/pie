import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AgentMessage, AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { TUI } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { getAgentDir } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import { StringEnum } from "../../core/extensions/pi-ai-extension-view.ts";
import type {
	ExtensionContext,
	ExtensionFactory,
	ExtensionToolContext,
	ToolDefinition,
} from "../../core/extensions/types.ts";
import { DefaultResourceLoader } from "../../core/resource-loader.ts";
import { createAgentSession } from "../../core/sdk.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { truncateMiddle } from "../../core/tools/truncate.ts";
import { raceWithAbortSignal } from "../../utils/abort.ts";
import { readTaskState, TASK_RUN_EVENT } from "../tasks/index.ts";
import { monitorWorkProgress } from "../work-progress.ts";
import { discoverAgentDefinitions } from "./definitions.ts";
import { SubagentPanel } from "./panel.ts";
import { renderSubagentCall, renderSubagentCompletion } from "./renderers.ts";
import { SubagentDetailView } from "./view.ts";

export const SUBAGENT_ENTRY = "pie.subagent";
const SUBAGENT_REMOVED_ENTRY = "pie.subagent-removed";
const recordSchema = Type.Object({
	id: Type.String(),
	agent: Type.String(),
	description: Type.String(),
	prompt: Type.String(),
	status: StringEnum(["queued", "running", "completed", "error", "stopped", "interrupted"] as const),
	model: Type.String(),
	thinking: Type.String(),
	turns: Type.Optional(Type.Integer({ minimum: 0 })),
	maxTurns: Type.Optional(Type.Integer({ minimum: 1 })),
	startedAt: Type.Number(),
	finishedAt: Type.Optional(Type.Number()),
	sessionFile: Type.Optional(Type.String()),
	taskId: Type.Optional(Type.String()),
	output: Type.String(),
	stopReason: Type.Optional(Type.String()),
	error: Type.Optional(Type.String()),
	activeTool: Type.Optional(Type.String()),
});
const validateRecord = Compile(recordSchema);
export type SubagentRecord = Static<typeof recordSchema>;

export function sortSubagents(records: readonly SubagentRecord[]): SubagentRecord[] {
	return [...records].sort(
		(a, b) => Number(b.status === "running") - Number(a.status === "running") || b.startedAt - a.startedAt,
	);
}

const DEFAULT_MAX_TURNS = 30;
const DEFAULT_TIMEOUT_SECONDS = 1800;
const subagentTimeout = Type.Optional(
	Type.Number({
		minimum: 0,
		maximum: 2_147_483.647,
		default: DEFAULT_TIMEOUT_SECONDS,
		description:
			"Runtime limit in seconds per subagent, measured from when it leaves the queue. Set 0 for no timeout.",
	}),
);
const WRAP_UP_GRACE_TURNS = 10;
const WRAP_UP_MESSAGE = "You have reached your turn limit. Wrap up immediately — provide your final answer now.";
const SUBAGENT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;

/** Last assistant failure in this run, if the model ended with a provider error. */
function lastAssistantFailure(child: AgentSession, startIndex: number): string | undefined {
	for (let index = child.messages.length - 1; index >= startIndex; index--) {
		const message = child.messages[index];
		if (message.role !== "assistant") continue;
		return message.stopReason === "error" ? message.errorMessage?.trim() || "provider error" : undefined;
	}
	return undefined;
}

const agentParams = Type.Object({
	prompt: Type.String({ minLength: 1, maxLength: 65536 }),
	description: Type.Optional(Type.String({ maxLength: 400 })),
	subagent_type: Type.Optional(Type.String({ default: "worker" })),
	model: Type.Optional(
		Type.String({ description: "provider/model, or an unambiguous model ID; inherits the parent by default" }),
	),
	thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)),
	max_turns: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 1000,
			default: DEFAULT_MAX_TURNS,
			description:
				"Maximum turns before the subagent is asked to wrap up; ten more turns are allowed before it is stopped",
		}),
	),
	timeout_seconds: subagentTimeout,
	run_in_background: Type.Optional(Type.Boolean({ default: true })),
	inherit_context: Type.Optional(Type.Boolean({ default: false })),
	resume: Type.Optional(Type.String({ description: "ID of a completed agent whose session should continue" })),
	task_id: Type.Optional(
		Type.String({ description: "Link the run to a pending task; the task status follows the run" }),
	),
});

/** Reject a delegation link to a task that is not ready to start. */
function assertDelegatableTask(ctx: ExtensionToolContext, taskId: string): void {
	const state = readTaskState(ctx.sessionManager);
	const task = state.tasks.find((item) => item.id === taskId);
	if (!task) throw new Error(`Unknown task: ${taskId}`);
	if (task.status !== "pending") throw new Error(`Task ${taskId} must be pending to delegate (it is ${task.status})`);
	const blocked = task.blockedBy.filter((id) => state.tasks.find((item) => item.id === id)?.status !== "completed");
	if (blocked.length) throw new Error(`Task ${taskId} is blocked by ${blocked.join(", ")}`);
}
interface Run {
	record: SubagentRecord;
	controller: AbortController;
	stall: AbortController;
	child?: AgentSession;
	streaming?: AssistantMessage;
	started: boolean;
	done: Promise<void>;
	resolve: () => void;
	reject: (error: unknown) => void;
	execute: () => Promise<void>;
}
const codingToolNames = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "powershell"]);

async function waitForSubagent(run: Run | undefined, signal?: AbortSignal): Promise<string | undefined> {
	signal?.throwIfAborted();
	if (!run) return;
	const stall = run.stall.signal;
	try {
		await raceWithAbortSignal(run.done, signal ? AbortSignal.any([signal, stall]) : stall);
	} catch (error) {
		signal?.throwIfAborted();
		if (stall.aborted && error === stall.reason && error instanceof Error) return error.message;
		throw error;
	}
}

function resultText(record: SubagentRecord): string {
	return [
		record.stopReason,
		record.error,
		record.output || (record.error ? undefined : "No output yet"),
		record.sessionFile && `Full session: ${record.sessionFile}`,
	]
		.filter(Boolean)
		.join("\n");
}

export function createSubagentsExtension(options: { agentDir?: string } = {}): ExtensionFactory {
	return (pi) => {
		pi.registerMessageRenderer("pie.subagent-completion", renderSubagentCompletion);
		const agentDir = options.agentDir ?? getAgentDir();
		const records = new Map<string, SubagentRecord>();
		const runs = new Map<string, Run>();
		const transcripts = new Map<string, AgentMessage[]>();
		let detailOpen = false;
		let detailUI: TUI | undefined;
		let closeDetail: (() => void) | undefined;
		const queue: Run[] = [];
		let active = 0;
		let closing = false;
		let context: ExtensionContext | undefined;
		let panelDismissed = false;
		let timer: ReturnType<typeof setInterval> | undefined;
		const prune = () => {
			const completed = [...records.values()]
				.filter((record) => record.status === "completed")
				.sort((a, b) => (a.finishedAt ?? a.startedAt) - (b.finishedAt ?? b.startedAt));
			for (const record of completed.slice(0, Math.max(0, records.size - 10))) {
				records.delete(record.id);
				if (!detailOpen) transcripts.delete(record.id);
				pi.appendEntry(SUBAGENT_REMOVED_ENTRY, record.id);
			}
		};
		const save = (record: SubagentRecord) => {
			pi.appendEntry(SUBAGENT_ENTRY, structuredClone(record));
			prune();
		};
		const reportTask = (record: SubagentRecord, status: "pending" | "in_progress" | "completed") => {
			if (record.taskId) pi.events.emit(TASK_RUN_EVENT, { taskId: record.taskId, status, owner: record.id });
		};
		const viewResult = (record: SubagentRecord) =>
			pi.sendMessage({
				customType: "pie.subagent-result",
				content: `${record.agent} · ${record.status}\n${resultText(record)}`,
				display: true,
				details: record,
			});
		const showDetail = async (record: SubagentRecord, ctx: ExtensionContext) => {
			if (!ctx.hasUI || ctx.mode !== "tui") {
				viewResult(record);
				return;
			}
			if (detailOpen) return;
			if (!transcripts.has(record.id)) {
				const messages: AgentMessage[] = record.sessionFile
					? SessionManager.open(record.sessionFile)
							.getBranch()
							.flatMap((entry) => (entry.type === "message" ? [entry.message] : []))
					: [{ role: "user", content: record.prompt, timestamp: record.startedAt }];
				transcripts.set(record.id, messages);
			}
			detailOpen = true;
			try {
				await ctx.ui.custom<void>(
					(tui, _theme, _keys, done) => {
						detailUI = tui;
						closeDetail = () => done();
						return new SubagentDetailView(
							tui,
							() => {
								const run = runs.get(record.id);
								return {
									...record,
									messages: run?.child?.messages ?? transcripts.get(record.id) ?? [],
									streaming: run?.streaming,
								};
							},
							closeDetail,
						);
					},
					{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 0 } },
				);
			} finally {
				detailOpen = false;
				detailUI = undefined;
				closeDetail = undefined;
				for (const id of transcripts.keys()) if (!records.has(id)) transcripts.delete(id);
			}
		};
		const showAgents = async (ctx: ExtensionContext) => {
			const list = sortSubagents([...records.values()]);
			if (!ctx.hasUI) {
				pi.sendMessage({
					customType: "pie.subagent-list",
					content: JSON.stringify(
						{ definitions: discoverAgentDefinitions(ctx.cwd, agentDir, ctx.isProjectTrusted()), runs: list },
						null,
						2,
					),
					display: true,
				});
				return;
			}
			if (!list.length) {
				ctx.ui.notify("No subagents. Ask the agent to delegate a task.", "info");
				return;
			}
			const labels = list.map(
				(record) => `${record.description} · ${record.agent} · ${record.status} · ${record.id}`,
			);
			const selected = await ctx.ui.select("Subagents", labels);
			const record = list[labels.indexOf(selected ?? "")];
			if (!record) return;
			const action = await ctx.ui.select(record.description, ["View result", "Stop", "Send steering"]);
			if (action === "View result") await showDetail(record, ctx);
			if (action === "Stop") await stop(record.id);
			if (action === "Send steering") {
				const message = await ctx.ui.input("Steering message");
				if (message?.trim()) {
					const child = runs.get(record.id)?.child;
					if (!child || record.status !== "running") ctx.ui.notify("Agent is not running", "warning");
					else await child.steer(message);
				}
			}
		};
		const refresh = () => {
			if (!context) return;
			const ctx = context;
			ctx.ui.setWidget(
				"pie.subagents",
				!records.size || panelDismissed
					? undefined
					: (tui) =>
							new SubagentPanel(
								tui,
								[...records.values()],
								(record) => {
									void showDetail(record, ctx).catch((error: unknown) =>
										ctx.ui.notify(String(error), "error"),
									);
								},
								() => {
									void showAgents(ctx).catch((error: unknown) => ctx.ui.notify(String(error), "error"));
								},
								() => {
									panelDismissed = true;
									refresh();
								},
							),
				{ placement: "floating", order: 20 },
			);
			detailUI?.requestRender();
		};
		const pump = () => {
			while (!closing && active < 4 && queue.length) {
				const run = queue.shift()!;
				run.started = true;
				active++;
				void run
					.execute()
					.then(run.resolve, run.reject)
					.finally(() => {
						active--;
						pump();
						if (!active && !queue.length && timer) {
							clearInterval(timer);
							timer = undefined;
						}
					});
			}
		};
		const stop = async (id: string) => {
			const run = runs.get(id);
			if (!run || !["queued", "running"].includes(run.record.status)) throw new Error(`Agent is not running: ${id}`);
			run.controller.abort();
			if (!run.started) {
				queue.splice(queue.indexOf(run), 1);
				run.record.status = "stopped";
				run.record.finishedAt = Date.now();
				save(run.record);
				reportTask(run.record, "pending");
				refresh();
				run.resolve();
			}
			await run.done;
		};
		const stopAll = async () => {
			closeDetail?.();
			closing = true;
			if (timer) {
				clearInterval(timer);
				timer = undefined;
			}
			await Promise.all(
				[...runs.values()]
					.filter((run) => ["queued", "running"].includes(run.record.status))
					.map((run) => stop(run.record.id)),
			);
		};
		const restore = (ctx: ExtensionContext, interruption: string) => {
			context = ctx;
			panelDismissed = false;
			closing = false;
			records.clear();
			transcripts.clear();
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type !== "custom") continue;
				if (entry.customType === SUBAGENT_REMOVED_ENTRY && typeof entry.data === "string") {
					records.delete(entry.data);
				} else if (entry.customType === SUBAGENT_ENTRY) {
					if (!validateRecord.Check(entry.data)) throw new Error("Invalid saved subagent record");
					records.set(entry.data.id, structuredClone(entry.data));
				}
			}
			for (const record of records.values()) {
				if (!["running", "queued"].includes(record.status)) continue;
				record.status = "interrupted";
				record.finishedAt = Date.now();
				record.error = interruption;
				save(record);
				reportTask(record, "pending");
			}
			prune();
			refresh();
		};
		pi.on("session_start", (_event, ctx) => {
			restore(ctx, "Session ended before this run completed");
		});
		pi.on("session_shutdown", async () => {
			await stopAll();
			context = undefined;
		});
		pi.on("session_before_tree", async () => {
			try {
				await stopAll();
			} finally {
				closing = false;
			}
		});
		pi.on("session_tree", (_event, ctx) => {
			restore(ctx, "Tree navigation interrupted this run");
		});

		const prepare = (args: Static<typeof agentParams>, ctx: ExtensionToolContext, taskId?: string): Run => {
			if (closing) throw new Error("Session is shutting down");
			if (!args.prompt.trim()) throw new Error("Prompt must not be blank");
			const previous = args.resume ? records.get(args.resume) : undefined;
			if (args.resume && (!previous?.sessionFile || ["running", "queued"].includes(previous.status)))
				throw new Error("Resume requires a settled agent with a saved session");
			const definition = discoverAgentDefinitions(ctx.cwd, agentDir, ctx.isProjectTrusted()).find(
				(agent) => agent.name === (args.subagent_type ?? previous?.agent ?? "worker"),
			);
			if (!definition) throw new Error(`Unknown or untrusted agent: ${args.subagent_type}`);
			const modelName = args.model ?? definition.model;
			const matches = modelName
				? ctx.modelRegistry
						.getAll()
						.filter((model) => model.id === modelName || `${model.provider}/${model.id}` === modelName)
				: [];
			const model = modelName ? (matches.length === 1 ? matches[0] : undefined) : ctx.model;
			if (!model) throw new Error(`Unknown or ambiguous model: ${modelName ?? "parent model"}`);
			const allowed = new Set(definition.tools ?? codingToolNames);
			if ([...allowed].some((name) => !codingToolNames.has(name)))
				throw new Error("Subagent tools must be parent-provided coding tools; orchestration tools are excluded");
			const tools: ToolDefinition[] = ctx.tools
				.filter((tool) => allowed.has(tool.name) && codingToolNames.has(tool.name))
				.map((tool) => ({
					name: tool.name,
					label: tool.label,
					description: tool.description,
					parameters: tool.parameters,
					async execute(_id, input, signal, onUpdate) {
						const outcome = await ctx.executeTool(tool.name, input, { signal, onUpdate });
						return { ...outcome.result, isError: outcome.isError };
					},
				}));
			const thinking = args.thinking ?? definition.thinking ?? ctx.thinkingLevel ?? "off";
			const record: SubagentRecord = {
				id: randomUUID(),
				agent: definition.name,
				description: args.description ?? definition.description,
				prompt: args.prompt,
				status: "queued",
				turns: 0,
				maxTurns: args.max_turns ?? DEFAULT_MAX_TURNS,
				startedAt: Date.now(),
				output: "",
				model: `${model.provider}/${model.id}`,
				thinking,
				taskId,
			};
			const controller = new AbortController();
			let resolve!: () => void;
			let reject!: (error: unknown) => void;
			const done = new Promise<void>((yes, no) => {
				resolve = yes;
				reject = no;
			});
			const parentPrompt = ctx.getSystemPrompt();
			const parentHistory = args.inherit_context
				? ctx.sessionManager
						.getBranch()
						.flatMap((entry) =>
							entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")
								? [
										`${entry.message.role}: ${
											typeof entry.message.content === "string"
												? entry.message.content
												: entry.message.content
														.filter((part) => part.type === "text")
														.map((part) => part.text)
														.join("\n")
										}`,
									]
								: [],
						)
						.join("\n\n")
				: "";
			const run: Run = {
				record,
				controller,
				stall: new AbortController(),
				started: false,
				done,
				resolve,
				reject,
				execute: async () => {
					const timeoutSeconds = args.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS;
					const timeoutError = new Error(`Subagent timed out after ${timeoutSeconds}s`);
					const timeout =
						timeoutSeconds > 0
							? setTimeout(() => controller.abort(timeoutError), timeoutSeconds * 1000)
							: undefined;
					let child: AgentSession | undefined;
					let usageStart = 0;
					let runStart = 0;
					let limitReached = false;
					const progress = monitorWorkProgress((idleSeconds) => {
						if (closing) return;
						const { id, description, taskId, activeTool, turns } = record;
						const details = { agentId: id, taskId, description, idleSeconds, activeTool, turns };
						const stage =
							record.status === "queued"
								? "during startup"
								: activeTool
									? `while running ${activeTool}`
									: "while waiting for the model";
						const observation = `Subagent ${id} has shown no model or tool progress for ${idleSeconds} seconds ${stage}. The run is still active.`;
						run.stall.abort(new Error(observation));
						const content = `${observation} Inspect it with get_subagent_result (wait: false), then decide whether to steer it, stop it, or continue independent work.\n${JSON.stringify(details)}`;
						const busy = !ctx.isIdle();
						pi.sendMessage(
							{ customType: "pie.subagent-stalled", content, display: true, details },
							{ deliverAs: "followUp", triggerTurn: ctx.mode === "tui" || ctx.mode === "rpc" },
						);
						if (busy && ctx.hasUI)
							ctx.ui.notify(`Subagent ${id} has shown no progress for ${idleSeconds}s.`, "warning");
					});
					const reportProgress = () => {
						if (run.stall.signal.aborted) run.stall = new AbortController();
						progress.report();
					};
					const abort = () => {
						progress.stop();
						if (child) void child.abort();
					};
					controller.signal.addEventListener("abort", abort, { once: true });
					try {
						controller.signal.throwIfAborted();
						const settings = SettingsManager.inMemory(pi.getSettings(), {
							projectTrusted: ctx.isProjectTrusted(),
						});
						const loader = new DefaultResourceLoader({
							cwd: ctx.cwd,
							agentDir,
							settingsManager: settings,
							noExtensions: true,
							noSkills: true,
							noThemes: true,
							noPromptTemplates: true,
							noContextFiles: true,
							systemPrompt: `${parentPrompt}\n\n${definition.prompt}\n\nYou are an isolated ${definition.name} subagent. Only the declared tools are available. Return your result to the parent; do not delegate further.`,
						});
						await loader.reload();
						controller.signal.throwIfAborted();
						const manager = previous?.sessionFile
							? SessionManager.open(previous.sessionFile)
							: ctx.sessionManager.getSessionFile()
								? SessionManager.create(ctx.cwd, join(agentDir, "subagents", ctx.sessionManager.getSessionId()))
								: SessionManager.inMemory(ctx.cwd);
						usageStart = manager.getEntryCount();
						({ session: child } = await createAgentSession({
							cwd: ctx.cwd,
							agentDir,
							modelRuntime: ctx.modelRegistry.getModelRuntime(),
							model,
							thinkingLevel: thinking as ThinkingLevel,
							settingsManager: settings,
							sessionManager: manager,
							resourceLoader: loader,
							tools: tools.map((tool) => tool.name),
							customTools: tools,
						}));
						run.child = child;
						runStart = child.messages.length;
						record.thinking = child.thinkingLevel;
						record.sessionFile = manager.getSessionFile();
						record.status = "running";
						controller.signal.throwIfAborted();
						reportProgress();
						save(record);
						refresh();
						let turns = 0;
						let wrapUpRequested = false;
						const maxTurns = args.max_turns ?? DEFAULT_MAX_TURNS;
						child.subscribe((event) => {
							// Cancellation during prompt preflight can arrive before the child has a live run.
							if (event.type === "agent_start" && controller.signal.aborted) abort();
							if (
								event.type === "turn_start" ||
								event.type === "turn_end" ||
								event.type === "tool_execution_start" ||
								event.type === "tool_execution_update" ||
								event.type === "tool_execution_end" ||
								(event.type === "message_update" &&
									"delta" in event.assistantMessageEvent &&
									event.assistantMessageEvent.delta.length > 0)
							)
								reportProgress();
							if (event.type === "turn_start" && !limitReached) {
								record.turns = (record.turns ?? 0) + 1;
								save(record);
								refresh();
							}
							if (event.type === "message_update" && event.message.role === "assistant")
								run.streaming = event.message;
							if (event.type === "message_end") run.streaming = undefined;
							detailUI?.requestRender();
							if (event.type === "tool_execution_start") record.activeTool = event.toolName;
							if (event.type === "tool_execution_end") record.activeTool = undefined;
							if (
								event.type === "turn_end" &&
								event.message.role === "assistant" &&
								event.message.stopReason === "toolUse"
							) {
								turns++;
								if (!wrapUpRequested && turns >= maxTurns) {
									wrapUpRequested = true;
									void child?.steer(WRAP_UP_MESSAGE).catch(() => {});
								} else if (wrapUpRequested && turns >= maxTurns + WRAP_UP_GRACE_TURNS) {
									limitReached = true;
									abort();
								}
							}
						});
						// shortcut: inherited conversation is text-only and capped at 50KB; use the parent session file for full history.
						const prompt = parentHistory
							? `${truncateMiddle(parentHistory, 50 * 1024).content}\n\nDelegated task:\n${args.prompt}`
							: args.prompt;
						let failure: string | undefined;
						let retries = 0;
						while (true) {
							controller.signal.throwIfAborted();
							try {
								await child.prompt(
									retries === 0
										? prompt
										: `The previous request failed (${failure}). Continue the same task without repeating completed work.`,
									{ expandPromptTemplates: false },
								);
								failure = lastAssistantFailure(child, runStart);
							} catch (error) {
								if (controller.signal.aborted || limitReached) throw error;
								failure = error instanceof Error ? error.message : String(error);
							}
							if (failure === undefined || limitReached || retries >= SUBAGENT_RETRY_DELAYS_MS.length) break;
							const delayMs = SUBAGENT_RETRY_DELAYS_MS[retries++];
							await raceWithAbortSignal(
								new Promise<void>((resolve) => setTimeout(resolve, delayMs)),
								controller.signal,
							);
						}
						const last = child.messages.findLast((message) => message.role === "assistant");
						if (controller.signal.aborted || limitReached) {
							record.status = "stopped";
							if (limitReached) record.stopReason = "Subagent turn limit reached";
						} else if (failure) {
							record.status = "error";
							record.error = retries > 0 ? `Subagent failed after ${retries} retries: ${failure}` : failure;
						} else {
							record.status =
								last?.role === "assistant" && ["error", "aborted", "length"].includes(last.stopReason)
									? "error"
									: "completed";
							if (last?.role === "assistant") {
								if (["error", "aborted", "length"].includes(last.stopReason))
									record.error =
										last.stopReason === "length"
											? "Subagent response was truncated before completion"
											: last.errorMessage;
								else if (wrapUpRequested && !controller.signal.aborted)
									record.stopReason = "Subagent wrapped up at turn limit";
							}
						}
					} catch (error) {
						record.status = controller.signal.aborted ? "stopped" : "error";
						record.error = error instanceof Error ? error.message : String(error);
					} finally {
						clearTimeout(timeout);
						progress.stop();
						controller.signal.removeEventListener("abort", abort);
						const timedOut = controller.signal.reason === timeoutError;
						if (timedOut) {
							record.status = "error";
							record.error = timeoutError.message;
						}
						if (child) {
							const last = child.messages.findLast((message, index) => {
								if (index < runStart || message.role !== "assistant") return false;
								return timedOut
									? message.content.some((block) => block.type === "text" && block.text.trim())
									: message.stopReason !== "aborted" || message.content.length > 0;
							});
							if (last?.role === "assistant") {
								const text = last.content
									.flatMap((block) => (block.type === "text" ? [block.text] : []))
									.join("");
								record.output = truncateMiddle(text.trim(), 32 * 1024).content;
							}
							transcripts.set(record.id, [...child.messages]);
							for (const entry of child.sessionManager.getEntries().slice(usageStart)) {
								if (entry.type === "message" && entry.message.role === "assistant")
									pi.appendUsage("subagent", entry.message.provider, entry.message.model, entry.message.usage);
								else if (entry.type === "usage")
									pi.appendUsage("subagent", entry.provider, entry.model, entry.usage);
								else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage)
									pi.appendUsage("subagent_summary", model.provider, model.id, entry.usage);
							}
							child.dispose();
						}
						record.finishedAt = Date.now();
						run.child = undefined;
						runs.delete(record.id);
						record.activeTool = undefined;
						save(record);
						reportTask(record, record.status === "completed" ? "completed" : "pending");
						refresh();
						if (!closing && (args.run_in_background ?? true)) {
							pi.sendMessage(
								{
									customType: "pie.subagent-completion",
									content: `Subagent ${record.id} (${record.agent}) ${record.status}.\n${resultText(record)}`,
									display: true,
									details: record,
								},
								{ triggerTurn: true, deliverAs: "steer" },
							);
						}
					}
				},
			};
			return run;
		};
		const start = (run: Run): Run => {
			records.set(run.record.id, run.record);
			runs.set(run.record.id, run);
			save(run.record);
			reportTask(run.record, "in_progress");
			queue.push(run);
			if (!timer) {
				timer = setInterval(refresh, 1000);
				timer.unref();
			}
			void run.done.catch((error: unknown) =>
				context?.ui.notify(`Subagent failed to finalize: ${String(error)}`, "error"),
			);
			refresh();
			pump();
			return run;
		};
		const output = (record: SubagentRecord, waitNotice?: string): AgentToolResult<SubagentRecord> => ({
			content: [
				{
					type: "text",
					text: `${record.id} · ${record.agent} · ${record.status}\n${waitNotice ? `${waitNotice}\n` : ""}${resultText(record)}`,
				},
			],
			details: structuredClone(record),
			isError:
				record.status === "error" ||
				record.status === "interrupted" ||
				(record.status === "stopped" && !record.stopReason),
		});
		pi.registerTool({
			name: "Agent",
			label: "Delegate",
			description:
				"Delegate a bounded task to an isolated subagent. Defaults to background execution; completion is delivered automatically. Four runs execute at a time; excess work queues. Tools and permissions are inherited without expanding the parent loadout.",
			promptSnippet: "Delegate bounded work to an isolated subagent",
			parameters: agentParams,
			renderCall: (args, theme, ctx) =>
				renderSubagentCall(
					"Agent",
					args.description?.trim() ||
						(args.resume ? records.get(args.resume)?.description : undefined) ||
						args.subagent_type ||
						"worker",
					args,
					theme,
					ctx.expanded,
				),
			async execute(_id, args, signal, _update, ctx) {
				signal?.throwIfAborted();
				const singleUse = ctx.mode === "print" || ctx.mode === "json";
				if (singleUse && args.run_in_background === true)
					throw new Error("Background agents require a TUI or RPC session; use run_in_background: false here");
				if (args.task_id) assertDelegatableTask(ctx, args.task_id);
				const run = start(
					prepare({ ...args, run_in_background: args.run_in_background ?? !singleUse }, ctx, args.task_id),
				);
				if (args.run_in_background ?? !singleUse) return output(run.record);
				const abort = () => {
					void stop(run.record.id);
				};
				signal?.addEventListener("abort", abort, { once: true });
				try {
					if (signal?.aborted) abort();
					await run.done;
					return output(run.record);
				} finally {
					signal?.removeEventListener("abort", abort);
				}
			},
		});
		pi.registerTool({
			name: "list_subagents",
			label: "List subagents",
			description: "List available agent definitions and session runs.",
			parameters: Type.Object({}),
			annotations: { readOnlyHint: true },
			async execute(_id, _args, _signal, _update, ctx) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									definitions: discoverAgentDefinitions(ctx.cwd, agentDir, ctx.isProjectTrusted()),
									runs: sortSubagents([...records.values()]),
								},
								null,
								2,
							),
						},
					],
					details: undefined,
				};
			},
		});
		pi.registerTool({
			name: "get_subagent_result",
			label: "Subagent result",
			description:
				"Read an agent result. Set wait to wait for completion or an inactivity notice. Do not poll while automatic completion is pending. Full output is preserved in the child session.",
			parameters: Type.Object({ agent_id: Type.String(), wait: Type.Optional(Type.Boolean({ default: false })) }),
			renderCall: (args, theme, ctx) => {
				const record = records.get(args.agent_id);
				return renderSubagentCall(
					"get_subagent_result",
					record?.description || record?.agent || "Subagent result",
					args,
					theme,
					ctx.expanded,
				);
			},
			annotations: { readOnlyHint: true },
			async execute(_id, args, signal) {
				const record = records.get(args.agent_id);
				if (!record) throw new Error(`Unknown agent: ${args.agent_id}`);
				const notice = args.wait ? await waitForSubagent(runs.get(record.id), signal) : undefined;
				return output(record, notice);
			},
		});
		pi.registerTool({
			name: "steer_subagent",
			label: "Steer subagent",
			description: "Send guidance to an active subagent at the next tool boundary.",
			parameters: Type.Object({ agent_id: Type.String(), message: Type.String({ minLength: 1 }) }),
			async execute(_id, args) {
				const run = runs.get(args.agent_id);
				if (!run?.child || run.record.status !== "running") throw new Error("Agent is not running");
				await run.child.steer(args.message);
				return output(run.record);
			},
		});
		pi.registerTool({
			name: "stop_subagent",
			label: "Stop subagent",
			description: "Stop queued or running work. A linked task remains unfinished.",
			parameters: Type.Object({ agent_id: Type.String() }),
			async execute(_id, args) {
				await stop(args.agent_id);
				return output(records.get(args.agent_id)!);
			},
		});
		pi.registerTool({
			name: "TaskExecute",
			label: "Execute tasks",
			description:
				"Delegate pending, unblocked tasks with an agentType to subagents. Proactively delegate bounded work that benefits from parallel execution or independent review. Set agentType (such as worker, researcher, or reviewer) and include the constraints and expected result when creating the task. Avoid overlapping edits or duplicating delegated work. Verify and integrate the results. Completion updates task status; failure or stop leaves a pending task.",
			promptSnippet: "Delegate ready tasks from the session ledger to subagents",
			parameters: Type.Object({
				task_ids: Type.Array(Type.String(), { minItems: 1, maxItems: 32 }),
				additional_context: Type.Optional(Type.String()),
				model: Type.Optional(Type.String()),
				max_turns: Type.Optional(
					Type.Integer({
						minimum: 1,
						maximum: 1000,
						description:
							"Maximum turns before the subagent is asked to wrap up; ten more turns are allowed before it is stopped",
					}),
				),
				timeout_seconds: subagentTimeout,
			}),
			executionMode: "sequential",
			async execute(_id, args, signal, _update, ctx) {
				signal?.throwIfAborted();
				const state = readTaskState(ctx.sessionManager);
				if (new Set(args.task_ids).size !== args.task_ids.length) throw new Error("Duplicate task IDs");
				const tasks = args.task_ids.map((id) => {
					const task = state.tasks.find((item) => item.id === id);
					if (
						!task ||
						task.status !== "pending" ||
						!task.agentType ||
						task.blockedBy.some(
							(dependency) => state.tasks.find((item) => item.id === dependency)?.status !== "completed",
						)
					)
						throw new Error(`Task ${id} must be pending, unblocked, and have an agentType`);
					return task;
				});
				const background = ctx.mode === "tui" || ctx.mode === "rpc";
				const prepared = tasks.map((task) =>
					prepare(
						{
							prompt: `${task.subject}\n\n${task.description}${args.additional_context ? `\n\n${args.additional_context}` : ""}`,
							description: task.subject,
							subagent_type: task.agentType,
							model: args.model,
							max_turns: args.max_turns,
							timeout_seconds: args.timeout_seconds,
							run_in_background: background,
						},
						ctx,
						task.id,
					),
				);
				const launched = prepared.map((run) => start(run).record);
				if (!background) {
					const abort = () => {
						for (const run of prepared) void stop(run.record.id).catch(() => {});
					};
					signal?.addEventListener("abort", abort, { once: true });
					try {
						if (signal?.aborted) abort();
						await Promise.all(prepared.map((run) => run.done));
					} finally {
						signal?.removeEventListener("abort", abort);
					}
				}
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								launched.map((record) => ({
									taskId: record.taskId,
									agentId: record.id,
									status: record.status,
									error: record.error,
								})),
								null,
								2,
							),
						},
					],
					details: undefined,
				};
			},
		});
		pi.registerTool({
			name: "TaskOutput",
			label: "Task output",
			description:
				"Read the latest delegated run for a task, optionally waiting for completion or an inactivity notice.",
			parameters: Type.Object({
				task_id: Type.String(),
				block: Type.Optional(Type.Boolean({ default: true })),
				timeout: Type.Optional(Type.Integer({ minimum: 0, maximum: 600000, default: 30000 })),
			}),
			annotations: { readOnlyHint: true },
			async execute(_id, args, signal) {
				const record = [...records.values()].findLast((item) => item.taskId === args.task_id);
				if (!record) throw new Error("Task has no delegated run");
				if ((args.block ?? true) && (args.timeout ?? 30000) > 0) {
					const deadline = AbortSignal.timeout(args.timeout ?? 30000);
					try {
						const notice = await waitForSubagent(
							runs.get(record.id),
							signal ? AbortSignal.any([signal, deadline]) : deadline,
						);
						return output(record, notice);
					} catch (error) {
						signal?.throwIfAborted();
						if (!deadline.aborted) throw error;
					}
				}
				return output(record);
			},
		});
		pi.registerTool({
			name: "TaskStop",
			label: "Stop task",
			description: "Stop a task's latest delegated run without marking the task completed.",
			parameters: Type.Object({ task_id: Type.String() }),
			async execute(_id, args) {
				const record = [...records.values()].findLast((item) => item.taskId === args.task_id);
				if (!record) throw new Error("Task has no delegated run");
				await stop(record.id);
				return output(record);
			},
		});
		pi.registerCommand("agents", {
			description: "View subagent results, stop work, or send steering",
			handler: async (_args, ctx) => {
				panelDismissed = false;
				refresh();
				await showAgents(ctx);
			},
		});
	};
}

export default createSubagentsExtension();
