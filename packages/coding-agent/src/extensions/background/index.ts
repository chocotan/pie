import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { getAgentDir } from "../../config.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ExtensionToolContext,
} from "../../core/extensions/types.ts";
import { normalizePath } from "../../utils/paths.ts";
import { getPowerShellConfig, getShellConfig } from "../../utils/shell.ts";
import {
	BACKGROUND_ACTIVITY_EVENT,
	BackgroundRegistry,
	type BackgroundTask,
	MAX_LOG_BYTES,
	readTaskLogs,
} from "./registry.ts";
import { renderBackgroundCompletion } from "./renderers.ts";
import { BackgroundDetailView, BackgroundPanel } from "./view.ts";

const runSchema = Type.Object({
	command: Type.String({ minLength: 1 }),
	name: Type.String({ minLength: 1, maxLength: 80, description: "Short task name" }),
	description: Type.Optional(Type.String({ maxLength: 400, description: "Purpose shown as the primary panel label" })),
	shell: Type.Optional(
		StringEnum(["bash", "powershell"] as const, {
			description: "Use the same syntax as this Pie shell tool; defaults to bash",
		}),
	),
	timeoutSeconds: Type.Optional(Type.Number({ minimum: 0.001, maximum: 2147483.647 })),
	notifyOnCompletion: Type.Optional(Type.Boolean({ default: true })),
	triggerOnCompletion: Type.Optional(Type.Boolean({ default: true })),
});

/** Replacements can carry sandbox/remote behavior for which no background spawn adapter exists. */
export function assertLocalShell(pi: ExtensionAPI, ctx: ExtensionToolContext, shell: "bash" | "powershell"): void {
	const tools = pi.getAllTools();
	const replaced = tools.find(
		(tool) => ["bash", "powershell"].includes(tool.name) && tool.sourceInfo.path !== `builtin:${tool.name}`,
	);
	if (replaced)
		throw new Error(
			`bg_run is unavailable while ${replaced.name} is replaced; a background execution adapter is required`,
		);
	if (!pi.getActiveTools().includes(shell) || !ctx.tools.some((tool) => tool.name === shell))
		throw new Error(`bg_run requires the active, callable ${shell} tool`);
	if (!tools.some((tool) => tool.name === shell && tool.sourceInfo.path === `builtin:${shell}`))
		throw new Error(`bg_run requires Pie's local ${shell} tool`);
}

export function createBackgroundExtension(options: { agentDir?: string } = {}): ExtensionFactory {
	return (pi) => {
		pi.registerMessageRenderer("background-task-notification", renderBackgroundCompletion);
		let registry: BackgroundRegistry | undefined;
		let context: ExtensionContext | undefined;
		let dismissed = false;
		let closeDetail: (() => void) | undefined;
		const report = (error: unknown) => context?.ui.notify(`Background tasks: ${String(error)}`, "error");
		const current = (ctx: ExtensionContext): BackgroundRegistry => {
			if (!registry || ctx.sessionManager.getSessionId() !== context?.sessionManager.getSessionId())
				throw new Error("Background task session is not active");
			return registry;
		};
		const result = (value: unknown) => ({
			content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
			details: value,
		});
		const detail = async (task: BackgroundTask, ctx: ExtensionContext) => {
			const owner = current(ctx);
			if (!ctx.hasUI || ctx.mode !== "tui") {
				const logs = await readTaskLogs(owner.resolve(task.id));
				pi.sendMessage({
					customType: "pie.background-detail",
					content: `${task.description}\n${logs.text}`,
					display: true,
				});
				return;
			}
			if (closeDetail) return;
			try {
				await ctx.ui.custom<void>(
					(tui, _theme, _keys, done) => {
						closeDetail = () => done();
						return new BackgroundDetailView(tui, () => owner.resolve(task.id), closeDetail);
					},
					{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 0 } },
				);
			} finally {
				closeDetail = undefined;
			}
		};
		const all = async (ctx: ExtensionContext) => {
			const tasks = current(ctx).list();
			if (!ctx.hasUI) {
				pi.sendMessage({
					customType: "pie.background-list",
					content: JSON.stringify(tasks, null, 2),
					display: true,
				});
				return;
			}
			if (!tasks.length) {
				ctx.ui.notify("No background shell tasks", "info");
				return;
			}
			const labels = tasks.map((task) => `${task.description} · ${task.status} · ${task.id}`);
			const selected = await ctx.ui.select("Background tasks", labels);
			const task = tasks[labels.indexOf(selected ?? "")];
			if (task) await detail(task, ctx);
		};
		const refresh = () => {
			if (!context || !context.hasUI || context.mode !== "tui") return;
			const ctx = context;
			const owner = registry;
			ctx.ui.setWidget(
				"pie.background",
				dismissed || !owner?.list().length
					? undefined
					: (tui) =>
							new BackgroundPanel(
								tui,
								() => owner.list(),
								(task) => {
									void detail(task, ctx).catch(report);
								},
								() => {
									void all(ctx).catch(report);
								},
								() => {
									dismissed = true;
									refresh();
								},
							),
				{ placement: "floating", order: 30 },
			);
		};
		pi.on("session_start", async (_event, ctx) => {
			await registry?.shutdown();
			context = ctx;
			dismissed = false;
			registry = new BackgroundRegistry({
				agentDir: options.agentDir ?? getAgentDir(),
				sessionId: ctx.sessionManager.getSessionId(),
				onChange: () => {
					refresh();
					const running = registry?.list().filter((task) => task.status === "running").length ?? 0;
					pi.events.emit(BACKGROUND_ACTIVITY_EVENT, { running });
				},
				onError: report,
				onCompletion: (task) =>
					pi.sendMessage(
						{
							customType: "background-task-notification",
							display: true,
							details: task,
							content: `<background-task-notification>\n${JSON.stringify({ taskId: task.id, description: task.description, status: task.status, exitCode: task.exitCode, error: task.error, outputPath: task.outputPath })}\nTask finished and output is closed. Any persistence or cleanup error is included above. Use bg_logs only if output is needed; do not poll bg_status to reconfirm.\n</background-task-notification>`,
						},
						{ deliverAs: "followUp", triggerTurn: task.triggerOnCompletion },
					),
			});
			refresh();
		});
		pi.on("session_shutdown", async () => {
			closeDetail?.();
			context?.ui.setWidget("pie.background", undefined);
			context = undefined;
			await registry?.shutdown();
		});
		pi.registerTool({
			name: "bg_run",
			label: "Background shell",
			parameters: runSchema,
			executionMode: "sequential",
			description:
				"Start a background shell command and return its ID, PID and log path immediately. Output is capped at 20MiB; exceeding the cap stops the process tree. Uses Pie's Bash/PowerShell policy. Requires a TUI or RPC session. Shell replacements require an adapter and are rejected.",
			promptSnippet: "Start a long-running background shell command",
			promptGuidelines: [
				"Completion notifications and follow-up turns are enabled by default. After bg_run continue independent work or end your turn; do not poll or sleep waiting. Use bg_status/bg_logs only for deliberate inspection. All tasks stop on session shutdown or reload.",
			],
			async execute(_id, args: Static<typeof runSchema>, signal, _update, ctx) {
				if (ctx.mode !== "tui" && ctx.mode !== "rpc")
					throw new Error("Background shell tasks require a persistent TUI or RPC session");
				const shellName = args.shell ?? "bash";
				assertLocalShell(pi, ctx, shellName);
				const settings = pi.getSettings();
				const shell =
					shellName === "powershell"
						? getPowerShellConfig()
						: getShellConfig(settings.shellPath ? normalizePath(settings.shellPath) : undefined);
				const prefix =
					shellName === "bash"
						? settings.shellCommandPrefix
						: "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}";
				const task = await current(ctx).start(
					prefix ? `${prefix}\n${args.command}` : args.command,
					ctx.cwd,
					shell,
					args,
					signal,
				);
				return result({
					task,
					guidance: task.notifyOnCompletion
						? task.triggerOnCompletion
							? "Completion will notify and start a follow-up turn; do not poll."
							: "Completion will notify without starting a turn."
						: "Completion notifications are disabled; inspect deliberately with bg_status/bg_logs.",
				});
			},
		});
		pi.registerTool({
			name: "bg_status",
			label: "Background status",
			parameters: Type.Object({ taskId: Type.Optional(Type.String()) }),
			description:
				"Inspect one background shell task by ID/prefix, or list this session's active/recent tasks. This is not a waiting primitive.",
			annotations: { readOnlyHint: true },
			async execute(_id, args, _signal, _update, ctx) {
				const owner = current(ctx);
				return result(args.taskId ? owner.resolve(args.taskId) : owner.list());
			},
		});
		pi.registerTool({
			name: "bg_logs",
			label: "Background logs",
			parameters: Type.Object({
				taskId: Type.String(),
				maxBytes: Type.Optional(Type.Integer({ minimum: 1, default: MAX_LOG_BYTES })),
				tail: Type.Optional(Type.Boolean({ default: true })),
			}),
			description:
				"Read an owned task's combined stdout/stderr, capped at 50KiB, from head or tail. Returns the full file path and omission metadata.",
			annotations: { readOnlyHint: true },
			async execute(_id, args, _signal, _update, ctx) {
				const task = current(ctx).resolve(args.taskId);
				const logs = await readTaskLogs(task, args.maxBytes, args.tail);
				return {
					content: [
						{
							type: "text",
							text: `${logs.text || "(no output yet)"}\n\n[${logs.bytesRead}/${logs.totalBytes} bytes${logs.truncated ? "; truncated" : ""}. Full output: ${task.outputPath}]`,
						},
					],
					details: { task, ...logs },
				};
			},
		});
		pi.registerTool({
			name: "bg_kill",
			label: "Stop background shell",
			parameters: Type.Object({ taskId: Type.String() }),
			executionMode: "sequential",
			description:
				"Stop an owned running background shell process tree (TERM, then force if needed), close logs, and save its terminal state. Errors if already terminal.",
			async execute(_id, args, _signal, _update, ctx) {
				return result(await current(ctx).stop(args.taskId));
			},
		});
		pi.registerCommand("jobs", {
			description: "Show background shell tasks and output",
			async handler(args, ctx) {
				dismissed = false;
				refresh();
				if (args.trim()) await detail(current(ctx).resolve(args.trim()), ctx);
				else await all(ctx);
			},
		});
	};
}
export default createBackgroundExtension();
