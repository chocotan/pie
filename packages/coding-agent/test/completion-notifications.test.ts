import { type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";
import type { MessageRenderer } from "../src/core/extensions/types.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import type { BackgroundTask } from "../src/extensions/background/registry.ts";
import { renderBackgroundCompletion } from "../src/extensions/background/renderers.ts";
import type { SubagentRecord } from "../src/extensions/subagents/index.ts";
import { renderSubagentCompletion } from "../src/extensions/subagents/renderers.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const background: BackgroundTask = {
	id: "background-id",
	name: "Run code checks",
	description: "Check formatting and types",
	command: "npm run check",
	cwd: "/project",
	shell: "bash",
	status: "completed",
	startedAt: 1000,
	finishedAt: 4200,
	exitCode: 0,
	outputPath: "/logs/check.output",
	bytesWritten: 100,
	notifyOnCompletion: true,
	triggerOnCompletion: true,
};
const agent: SubagentRecord = {
	id: "agent-id",
	agent: "reviewer",
	description: "Review the login flow",
	prompt: "Check login handling",
	status: "completed",
	model: "faux/local",
	thinking: "high",
	startedAt: 1000,
	finishedAt: 6000,
	output: Array.from({ length: 8 }, (_, index) => `Finding ${index + 1}`).join("\n"),
	sessionFile: "/sessions/review.jsonl",
	taskId: "1",
	turns: 3,
	maxTurns: 30,
};
function notification<T>(customType: string, details?: T): CustomMessage<T> {
	return { role: "custom", customType, content: "Original notification", details, display: true, timestamp: 6000 };
}
const mouse = (type: TuiMouseEvent["type"], y = 0): TuiMouseEvent => ({
	type,
	button: type === "move" || type === "leave" ? "none" : "left",
	x: 3,
	y,
	screenX: 3,
	screenY: y,
	width: 80,
	height: 24,
	shift: false,
	alt: false,
	ctrl: false,
	clickCount: 1,
});

describe("completion notifications", () => {
	beforeEach(() => initTheme("dark"));
	it("renders background status, title and duration without the transport label or JSON", () => {
		const message: CustomMessage<BackgroundTask> = {
			role: "custom",
			customType: "background-task-notification",
			content: `<background-task-notification>\n${JSON.stringify(background)}\n</background-task-notification>`,
			details: background,
			display: true,
			timestamp: 4200,
		};
		const original = structuredClone(message);
		const component = new CustomMessageComponent(message, renderBackgroundCompletion as MessageRenderer);
		let rendered = component.render(80).join("\n");
		expect(rendered).toContain(theme.getFgAnsi("success"));
		let text = stripAnsi(rendered);
		expect(text).toContain("Background task · completed · 3.2s");
		expect(text).toContain("Run code checks");
		expect(text).toContain("Check formatting and types");
		expect(text).not.toContain("background-task-notification");
		expect(text).not.toContain("background-id");
		expect(text).not.toContain("/logs/check.output");
		component.setExpanded(true);
		rendered = component.render(80).join("\n");
		text = stripAnsi(rendered);
		expect(text).toContain("Task ID: background-id");
		expect(text).toContain("Exit code: 0");
		expect(text).toContain("Command: npm run check");
		expect(text).toContain("Output: /logs/check.output");
		expect(message).toEqual(original);
	});
	it("previews subagent output and exposes full output and provenance when expanded", () => {
		const message: CustomMessage<SubagentRecord> = {
			role: "custom",
			customType: "pie.subagent-completion",
			content: "Original model-facing completion text",
			details: agent,
			display: true,
			timestamp: 6000,
		};
		const component = new CustomMessageComponent(message, renderSubagentCompletion as MessageRenderer);
		let text = stripAnsi(component.render(80).join("\n"));
		expect(text).toContain("Subagent · completed · 3/30 · 5.0s");
		expect(text).toContain("Review the login flow");
		expect(text).toContain("Finding 1");
		expect(text).not.toContain("Finding 8");
		expect(text).toContain("expand to read more");
		expect(text).not.toContain("pie.subagent-completion");
		component.setExpanded(true);
		text = stripAnsi(component.render(80).join("\n"));
		expect(text).toContain("Finding 8");
		expect(text).toContain("Agent: reviewer");
		expect(text).toContain("Task: #1");
		expect(text).toContain("Session: /sessions/review.jsonl");
	});
	it("keeps actual failures red and turn-limit stops neutral", () => {
		const failed = renderBackgroundCompletion(
			notification<BackgroundTask>("background-task-notification", {
				...background,
				status: "failed",
				error: "Command exited with code 1",
				exitCode: 1,
			}),
			{ expanded: false, outputPad: 1 },
			theme,
		)!;
		expect(failed.render(80).join("\n")).toContain(theme.fg("error", "Command exited with code 1"));
		const failedAgent = renderSubagentCompletion(
			notification<SubagentRecord>("pie.subagent-completion", {
				...agent,
				status: "error",
				error: "Provider unavailable",
			}),
			{ expanded: false, outputPad: 1 },
			theme,
		)!;
		expect(failedAgent.render(80).join("\n")).toContain(theme.fg("error", "Provider unavailable"));
		const stopped = renderSubagentCompletion(
			notification<SubagentRecord>("pie.subagent-completion", {
				...agent,
				status: "stopped",
				stopReason: "Subagent turn limit reached",
			}),
			{ expanded: false, outputPad: 1 },
			theme,
		)!;
		const text = stopped.render(80).join("\n");
		expect(text).toContain(theme.fg("muted", "Subagent turn limit reached"));
		expect(text).not.toContain(theme.getFgAnsi("error"));
	});
	it("omits progress when an older subagent record has no turn counts", () => {
		const { turns: _turns, maxTurns: _maxTurns, ...older } = agent;
		const component = renderSubagentCompletion(
			notification("pie.subagent-completion", older),
			{ expanded: false, outputPad: 1 },
			theme,
		)!;
		expect(stripAnsi(component.render(80).join("\n"))).toContain("Subagent · completed · 5.0s");
	});
	it("expands only by clicking the header, highlights on hover and stays bounded", () => {
		const component = renderSubagentCompletion(
			notification("pie.subagent-completion", agent),
			{ expanded: false, outputPad: 1 },
			theme,
		)!;
		for (const width of [1, 2, 10, 40, 80])
			expect(component.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
		const original = component.render(80);
		expect(component.handleMouse?.(mouse("move"))).toMatchObject({ handled: true, render: true });
		expect(component.render(80)).not.toEqual(original);
		expect(component.handleMouse?.(mouse("press"))).toMatchObject({ handled: true, render: false });
		expect(component.handleMouse?.(mouse("click"))).toMatchObject({ handled: true, render: true });
		expect(stripAnsi(component.render(80).join("\n"))).toContain("Finding 8");
		expect(component.handleMouse?.(mouse("click", 2))?.handled).not.toBe(true);
		expect(component.handleMouse?.(mouse("click"))?.handled).toBe(true);
		expect(stripAnsi(component.render(80).join("\n"))).not.toContain("Finding 8");
	});
	it("falls back safely for missing structured details and preserves remapped output padding", () => {
		expect(
			renderBackgroundCompletion(
				notification<BackgroundTask>("background-task-notification"),
				{ expanded: false, outputPad: 0 },
				theme,
			),
		).toBeUndefined();
		expect(
			renderSubagentCompletion(
				notification<SubagentRecord>("pie.subagent-completion"),
				{ expanded: false, outputPad: 0 },
				theme,
			),
		).toBeUndefined();
		const component = renderBackgroundCompletion(
			notification("background-task-notification", background),
			{ expanded: false, outputPad: 0 },
			theme,
		)!;
		expect(stripAnsi(component.render(80)[0])).toMatch(/^▸ Background task/);
	});
	it("bounds multiline diagnostics and strips terminal control sequences without changing the notification", () => {
		const message = notification<BackgroundTask>("background-task-notification", {
			...background,
			status: "failed",
			name: "\x1b[31mCode checks\x1b[0m\nfinished",
			error: Array.from({ length: 20 }, (_, index) => `Diagnostic ${index + 1}`).join("\n"),
		});
		const component = renderBackgroundCompletion(message, { expanded: false, outputPad: 1 }, theme)!;
		const rendered = component.render(80);
		expect(rendered.length).toBeLessThanOrEqual(7);
		const text = stripAnsi(rendered.join("\n"));
		expect(text).toContain("Code checks finished");
		expect(text).toContain("Diagnostic 1");
		expect(text).not.toContain("Diagnostic 20");
		expect(text).toContain("expand to read more");
		expect(message.details?.name).toContain("\x1b[31m");
	});
});
