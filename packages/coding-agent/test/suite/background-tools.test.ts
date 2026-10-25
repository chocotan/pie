import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBackgroundExtension } from "../../src/extensions/background/index.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "./harness.ts";

let directory: string;
let harness: Harness | undefined;
function launchedTask(harness: Harness): { id: string; outputPath: string } {
	const details = getToolResult(harness, "bg_run").details;
	if (!details || typeof details !== "object" || !("task" in details)) throw new Error("Missing launch receipt");
	const task = details.task;
	if (
		!task ||
		typeof task !== "object" ||
		!("id" in task) ||
		typeof task.id !== "string" ||
		!("outputPath" in task) ||
		typeof task.outputPath !== "string"
	)
		throw new Error("Invalid launch receipt");
	return { id: task.id, outputPath: task.outputPath };
}
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "pie-background-extension-"));
});
afterEach(async () => {
	if (harness) {
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		harness.cleanup();
		harness = undefined;
	}
	await rm(directory, { recursive: true, force: true });
});
describe("background extension tool integration", () => {
	it("launches through the local shell, notifies once after output closure, and reads logs through tools", async () => {
		const setWidget = vi.fn();
		harness = await createHarness({ extensionFactories: [createBackgroundExtension({ agentDir: directory })] });
		await harness.session.bindExtensions({ uiContext: createTestUiContext({ setWidget }), mode: "tui" });
		let completed!: () => void;
		const completion = new Promise<void>((resolve) => {
			completed = resolve;
		});
		harness.session.subscribe((event) => {
			if (
				event.type === "message_end" &&
				event.message.role === "custom" &&
				event.message.customType === "background-task-notification"
			)
				completed();
		});
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("bg_run", {
					command: "printf 'fixture stdout'; printf 'fixture stderr' >&2",
					name: "Fixture",
					description: "Capture shell output",
					triggerOnCompletion: false,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("launched"),
		]);
		await harness.session.prompt("Run the fixture shell");
		expect(getToolResult(harness, "bg_run").isError).toBe(false);
		const task = launchedTask(harness);
		await completion;
		expect(setWidget).toHaveBeenCalledWith("pie.background", expect.any(Function), {
			placement: "floating",
			order: 30,
		});
		const metadata = JSON.parse(await readFile(`${task.outputPath}.json`, "utf8"));
		expect(metadata.status).toBe("completed");
		const output = await readFile(task.outputPath, "utf8");
		expect(output).toContain("fixture stdout");
		expect(output).toContain("fixture stderr");
		expect(
			harness
				.eventsOfType("message_end")
				.filter(
					(event) =>
						event.message.role === "custom" && event.message.customType === "background-task-notification",
				),
		).toHaveLength(1);
		const notification = harness.session.messages.find(
			(message) => message.role === "custom" && message.customType === "background-task-notification",
		);
		if (!notification || notification.role !== "custom") throw new Error("Missing background notification");
		expect(notification.content).toContain("<background-task-notification>");
		expect(notification.content).toContain("do not poll bg_status to reconfirm");
		initTheme("dark");
		const renderer = harness.session.extensionRunner.getMessageRenderer(notification.customType)!;
		const rendered = renderer(notification, { expanded: false, outputPad: 1 }, theme)!.render(80);
		expect(stripAnsi(rendered.join("\n"))).toContain("Background task · completed");
		expect(stripAnsi(rendered.join("\n"))).not.toContain("background-task-notification");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bg_logs", { taskId: task.id }), { stopReason: "toolUse" }),
			fauxAssistantMessage("read output"),
		]);
		await harness.session.prompt("Read fixture output");
		expect(getToolResult(harness, "bg_logs").isError).toBe(false);
		expect(JSON.stringify(getToolResult(harness, "bg_logs").content)).toContain("fixture stdout");
		expect(JSON.stringify(getToolResult(harness, "bg_logs").content)).toContain("fixture stderr");
	});
	it.skipIf(process.platform === "win32")(
		"stops owned work through bg_kill and never revives its panel during shutdown",
		async () => {
			const setWidget = vi.fn();
			harness = await createHarness({ extensionFactories: [createBackgroundExtension({ agentDir: directory })] });
			await harness.session.bindExtensions({ uiContext: createTestUiContext({ setWidget }), mode: "tui" });
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("bg_run", {
						command: `exec ${JSON.stringify(process.execPath)} -e 'setInterval(() => {}, 1000)'`,
						name: "Owned wait",
						notifyOnCompletion: false,
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("launched"),
			]);
			await harness.session.prompt("Start owned fixture");
			expect(getToolResult(harness, "bg_run").isError).toBe(false);
			const task = launchedTask(harness);
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("bg_kill", { taskId: task.id }), { stopReason: "toolUse" }),
				fauxAssistantMessage("stopped"),
			]);
			await harness.session.prompt("Stop owned fixture");
			expect(getToolResult(harness, "bg_kill").isError).toBe(false);
			expect(getToolResult(harness, "bg_kill").details).toMatchObject({ status: "killed" });
			await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
			expect(setWidget.mock.lastCall).toEqual(["pie.background", undefined]);
		},
	);
	it.skipIf(process.platform === "win32")(
		"cleans running work on reload, suppresses notifications and isolates the next activation",
		async () => {
			const setWidget = vi.fn();
			harness = await createHarness({ extensionFactories: [createBackgroundExtension({ agentDir: directory })] });
			await harness.session.bindExtensions({ uiContext: createTestUiContext({ setWidget }), mode: "tui" });
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("bg_run", {
						command: `exec ${JSON.stringify(process.execPath)} -e 'setInterval(() => {}, 1000)'`,
						name: "Reload fixture",
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("launched"),
			]);
			await harness.session.prompt("Start reload fixture");
			expect(getToolResult(harness, "bg_run").isError).toBe(false);
			const task = launchedTask(harness);
			await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
			expect(JSON.parse(await readFile(`${task.outputPath}.json`, "utf8")).status).toBe("killed");
			expect(setWidget.mock.lastCall).toEqual(["pie.background", undefined]);
			expect(
				harness
					.eventsOfType("message_end")
					.some(
						(event) =>
							event.message.role === "custom" && event.message.customType === "background-task-notification",
					),
			).toBe(false);
			await harness.session.extensionRunner.emit({ type: "session_start", reason: "reload" });
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("bg_status", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("bg_logs", { taskId: task.id }), { stopReason: "toolUse" }),
				fauxAssistantMessage("new activation"),
			]);
			await harness.session.prompt("Inspect new activation");
			expect(getToolResult(harness, "bg_status").details).toEqual([]);
			expect(getToolResult(harness, "bg_logs").isError).toBe(true);
			expect(JSON.stringify(getToolResult(harness, "bg_logs").content)).toContain("Unknown background task");
		},
	);
	it("passes bg_run through ordinary tool_call permission hooks before executing", async () => {
		const intercepted = vi.fn();
		harness = await createHarness({
			extensionFactories: [
				createBackgroundExtension({ agentDir: directory }),
				(pi) => {
					pi.on("tool_call", (event) => {
						if (event.toolName === "bg_run") {
							intercepted(event.input);
							return { block: true, reason: "Fixture permission denied" };
						}
					});
				},
			],
		});
		await harness.session.bindExtensions({ uiContext: createTestUiContext(), mode: "tui" });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bg_run", { command: "fixture must never run", name: "Blocked" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Test permission hook");
		expect(intercepted).toHaveBeenCalledOnce();
		expect(getToolResult(harness, "bg_run").isError).toBe(true);
		expect(JSON.stringify(getToolResult(harness, "bg_run").content)).toContain("Fixture permission denied");
	});
	it("fails closed on an extension shell replacement before launching a local command", async () => {
		const replacement = vi.fn();
		harness = await createHarness({
			extensionFactories: [
				createBackgroundExtension({ agentDir: directory }),
				(pi) => {
					pi.registerTool({
						name: "bash",
						label: "Fixture sandbox",
						description: "Fake replacement",
						parameters: Type.Object({ command: Type.String() }),
						async execute() {
							replacement();
							return { content: [], details: undefined };
						},
					});
				},
			],
		});
		await harness.session.bindExtensions({ uiContext: createTestUiContext(), mode: "tui" });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bg_run", { command: "fixture must never run", name: "Replaced" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Test shell replacement");
		expect(getToolResult(harness, "bg_run").isError).toBe(true);
		expect(JSON.stringify(getToolResult(harness, "bg_run").content)).toContain("background execution adapter");
		expect(replacement).not.toHaveBeenCalled();
	});
	it("rejects background execution when the parent shell tool is inactive", async () => {
		harness = await createHarness({ extensionFactories: [createBackgroundExtension({ agentDir: directory })] });
		await harness.session.bindExtensions({ uiContext: createTestUiContext(), mode: "tui" });
		harness.session.setActiveToolsByName(["read", "bg_run"]);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bg_run", { command: "fixture must never run", name: "Inactive shell" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Test inactive shell");
		expect(getToolResult(harness, "bg_run").isError).toBe(true);
		expect(JSON.stringify(getToolResult(harness, "bg_run").content)).toContain("active, callable bash");
	});
	it("exposes four independent shell tools and keeps one-shot modes from creating orphans", async () => {
		harness = await createHarness({ extensionFactories: [createBackgroundExtension({ agentDir: directory })] });
		await harness.session.bindExtensions({ uiContext: createTestUiContext(), mode: "print" });
		for (const name of ["bg_run", "bg_status", "bg_logs", "bg_kill"])
			expect(harness.session.getAllTools().some((tool) => tool.name === name)).toBe(true);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bg_run", { command: "fixture must never run", name: "Print" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxToolCall("bg_status", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Test print lifecycle");
		expect(getToolResult(harness, "bg_run").isError).toBe(true);
		expect(JSON.stringify(getToolResult(harness, "bg_run").content)).toContain("persistent TUI or RPC");
		expect(getToolResult(harness, "bg_status").details).toEqual([]);
	});
});
