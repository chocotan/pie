import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { getKeybindings, setKeybindings, type TUI, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { type SubagentDetailSnapshot, SubagentDetailView } from "../src/extensions/subagents/view.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const previousKeys = getKeybindings();
const mouse = (x: number, y: number): TuiMouseEvent => ({
	type: "click",
	button: "left",
	x,
	y,
	screenX: x,
	screenY: y,
	width: 100,
	height: 30,
	shift: false,
	alt: false,
	ctrl: false,
	clickCount: 1,
});
const snapshot = (): SubagentDetailSnapshot => ({
	agent: "worker",
	description: "Verify title toggles",
	status: "completed",
	model: "faux/local",
	thinking: "high",
	startedAt: 0,
	finishedAt: 4000,
	messages: [
		{ role: "user", content: "Child instructions", timestamp: 1 },
		fauxAssistantMessage(
			[
				fauxToolCall("read", { path: "a.txt" }, { id: "call-a" }),
				fauxToolCall("read", { path: "b.txt" }, { id: "call-b" }),
			],
			{ timestamp: 2, stopReason: "toolUse" },
		),
		{
			role: "toolResult",
			toolCallId: "call-a",
			toolName: "read",
			content: [{ type: "text", text: "unique read output" }],
			isError: false,
			timestamp: 3,
		},
		{ role: "toolResult", toolCallId: "call-b", toolName: "read", content: [], isError: false, timestamp: 4 },
		fauxAssistantMessage("Final child answer", { timestamp: 5 }),
	],
});
describe("SubagentDetailView", () => {
	beforeEach(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});
	afterEach(() => {
		setKeybindings(previousKeys);
		vi.useRealTimers();
	});
	it.each(["aborted", "error"] as const)(
		"renders a turn-limit %s as muted without changing saved messages",
		(stopReason) => {
			const current: SubagentDetailSnapshot = {
				...snapshot(),
				status: "running",
				messages: [
					...snapshot().messages,
					fauxAssistantMessage("", {
						stopReason: "error",
						errorMessage: "Earlier provider failure",
						timestamp: 6,
					}),
					fauxAssistantMessage("Interrupted answer", {
						stopReason,
						errorMessage: "This operation was aborted",
						timestamp: 7,
					}),
				],
			};
			const view = new SubagentDetailView(
				{ terminal: { rows: 30 }, requestRender: vi.fn() } as unknown as TUI,
				() => current,
				vi.fn(),
			);
			view.render(100);
			current.status = "stopped";
			current.stopReason = "Subagent turn limit reached";
			const rendered = view.render(100).join("\n");
			expect(rendered).toContain(theme.fg("muted", "Subagent turn limit reached"));
			expect(rendered).toContain(theme.fg("muted", "This operation was aborted"));
			expect(rendered).toContain(theme.fg("error", "Error: Earlier provider failure"));
			const text = stripAnsi(rendered);
			expect(text).toContain("Subagent turn limit reached");
			expect(text).toContain("Final child answer");
			expect(text).toContain("Interrupted answer");
			expect(text).not.toContain("Error: This operation was aborted");
			expect(current.messages.at(-1)).toMatchObject({ stopReason, errorMessage: "This operation was aborted" });
		},
	);
	it("bounds its frame, preserves transcript order, and closes with keyboard or mouse", () => {
		const done = vi.fn();
		const ui = { terminal: { rows: 30 }, requestRender: vi.fn() } as unknown as TUI;
		const view = new SubagentDetailView(ui, snapshot, done);
		for (const width of [1, 2, 10, 40, 100]) {
			const lines = view.render(width);
			expect(lines).toHaveLength(30);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}
		const lines = view.render(100).map(stripAnsi);
		const text = lines.join("\n");
		expect(text).toContain("Verify title toggles");
		expect(text).toContain("faux/local");
		expect(text.indexOf("Child instructions")).toBeLessThan(text.indexOf("a.txt"));
		expect(text.indexOf("a.txt")).toBeLessThan(text.indexOf("b.txt"));
		expect(text.indexOf("b.txt")).toBeLessThan(text.indexOf("Final child answer"));
		view.handleMouse(mouse(97, 1));
		expect(done).toHaveBeenCalledOnce();
		view.handleInput("\x1b");
		expect(done).toHaveBeenCalledTimes(2);
	});
	it("uses the same compact expanded tool layout inside the child transcript", () => {
		const current: SubagentDetailSnapshot = {
			...snapshot(),
			messages: [
				fauxAssistantMessage(
					[
						{ type: "text", text: "Checking free space." },
						fauxToolCall("bash", { command: "df -h", timeout: 10 }, { id: "disk" }),
					],
					{ timestamp: 2, stopReason: "toolUse" },
				),
				{
					role: "toolResult",
					toolName: "bash",
					toolCallId: "disk",
					content: [{ type: "text", text: "Filesystem\n/dev/local 125G" }],
					isError: false,
					durationMs: 24,
					timestamp: 3,
				},
				fauxAssistantMessage(fauxToolCall("read", { path: "disk.txt" }, { id: "next" }), {
					timestamp: 4,
					stopReason: "toolUse",
				}),
				{
					role: "toolResult",
					toolName: "read",
					toolCallId: "next",
					content: [{ type: "text", text: "Next output" }],
					isError: false,
					durationMs: 2,
					timestamp: 5,
				},
			],
		};
		const view = new SubagentDetailView(
			{ terminal: { rows: 30 }, requestRender: vi.fn() } as unknown as TUI,
			() => current,
			vi.fn(),
		);
		let lines = view.render(100).map(stripAnsi);
		let row = lines.findIndex((line) => line.includes("$ df -h"));
		expect(lines[row - 1].replaceAll("│", "").trim()).toBe("");
		expect(lines[row + 1]).toContain("disk.txt");
		expect(view.handleMouse(mouse(3, row))?.handled).toBe(true);
		lines = view.render(100).map(stripAnsi);
		row = lines.findIndex((line) => line.includes("$ df -h"));
		expect(lines[row]).toContain("●");
		expect(lines[row]).not.toMatch(/[▸▾]/);
		expect(lines[row + 1]).toContain("Filesystem");
		expect(lines[row + 2]).toContain("/dev/local");
		expect(lines[row + 3]).toContain("disk.txt");
		expect(lines.join("\n").match(/24ms/g)).toHaveLength(1);
		expect(view.handleMouse(mouse(3, row + 1))?.handled).not.toBe(true);
		expect(stripAnsi(view.render(100).join("\n"))).toContain("Filesystem");
		expect(view.handleMouse(mouse(3, row))?.handled).toBe(true);
		expect(stripAnsi(view.render(100).join("\n"))).not.toContain("Filesystem");
		view.dispose();
	});
	it("renders user content-block arrays from real saved child sessions", () => {
		const current: SubagentDetailSnapshot = {
			...snapshot(),
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Real child instructions" },
						{ type: "text", text: "Second content block" },
					],
					timestamp: 1,
				},
				...snapshot().messages.slice(1),
			],
		};
		const view = new SubagentDetailView(
			{ terminal: { rows: 30 }, requestRender: vi.fn() } as unknown as TUI,
			() => current,
			vi.fn(),
		);
		const text = stripAnsi(view.render(100).join("\n"));
		expect(text).toContain("Real child instructions");
		expect(text).toContain("Second content block");
	});
	it("keeps a manually expanded tool open across renders and incoming messages", () => {
		let current = snapshot();
		const view = new SubagentDetailView(
			{ terminal: { rows: 30 }, requestRender: vi.fn() } as unknown as TUI,
			() => current,
			vi.fn(),
		);
		const lines = view.render(100);
		const y = lines.findIndex((line) => stripAnsi(line).includes("a.txt"));
		expect(view.handleMouse(mouse(3, y))?.handled).toBe(true);
		expect(stripAnsi(view.render(100).join("\n"))).toContain("unique read output");
		current = {
			...current,
			messages: [...current.messages, fauxAssistantMessage("Another answer", { timestamp: 6 })],
		};
		expect(stripAnsi(view.render(100).join("\n"))).toContain("unique read output");
		view.handleInput("\x0f");
		view.handleInput("\x0f");
		expect(stripAnsi(view.render(100).join("\n"))).not.toContain("unique read output");
	});
	it("clears a running tool's display timer when the detail closes", () => {
		vi.useFakeTimers();
		const current: SubagentDetailSnapshot = {
			...snapshot(),
			status: "running",
			activeTool: "bash",
			finishedAt: undefined,
			messages: [
				fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 5" }, { id: "clock" }), {
					timestamp: 9,
					stopReason: "toolUse",
				}),
			],
		};
		const view = new SubagentDetailView(
			{ terminal: { rows: 30 }, requestRender: vi.fn() } as unknown as TUI,
			() => current,
			vi.fn(),
		);
		view.render(100);
		expect(vi.getTimerCount()).toBeGreaterThan(0);
		view.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});
	it("auto-expands streaming thought, collapses at the answer, and obeys remapped shortcuts", () => {
		setKeybindings(new KeybindingsManager({ "app.thinking.toggle": "ctrl+x", "tui.select.cancel": "ctrl+q" }));
		const done = vi.fn();
		const thought = fauxAssistantMessage([{ type: "thinking", thinking: "live reasoning" }], { timestamp: 7 });
		let current: SubagentDetailSnapshot = { ...snapshot(), messages: [], streaming: thought, status: "running" };
		const view = new SubagentDetailView(
			{ terminal: { rows: 30 }, requestRender: vi.fn() } as unknown as TUI,
			() => current,
			done,
		);
		expect(stripAnsi(view.render(100).join("\n"))).toContain("live reasoning");
		current = {
			...current,
			streaming: undefined,
			messages: [fauxAssistantMessage([...thought.content, { type: "text", text: "answer" }], { timestamp: 7 })],
		};
		expect(stripAnsi(view.render(100).join("\n"))).not.toContain("live reasoning");
		view.handleInput("\x18");
		expect(stripAnsi(view.render(100).join("\n"))).toContain("live reasoning");
		view.handleInput("\x11");
		expect(done).toHaveBeenCalledOnce();
		expect(stripAnsi(view.render(100).at(-1)!)).toContain("ctrl+q back");
	});
});
