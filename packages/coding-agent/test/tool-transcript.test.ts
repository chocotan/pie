import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Container, Spacer, Text, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { ToolTranscriptContainer } from "../src/modes/interactive/components/tool-transcript.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const mouse = (y: number, height: number): TuiMouseEvent => ({
	type: "click",
	button: "left",
	x: 3,
	y,
	screenX: 3,
	screenY: y,
	width: 100,
	height,
	shift: false,
	alt: false,
	ctrl: false,
	clickCount: 1,
});
const ui = { requestRender: vi.fn() } as unknown as TUI;
function shell(id: string): ToolExecutionComponent {
	const tool = new ToolExecutionComponent(
		"bash",
		id,
		{ command: "df -h", timeout: 10 },
		{},
		createBashToolDefinition("/tmp"),
		ui,
		"/tmp",
	);
	tool.updateResult({
		content: [{ type: "text", text: "Filesystem Size Used Avail\n/dev/local 728G 569G 125G" }],
		isError: false,
		durationMs: 24,
	});
	return tool;
}

describe("tool transcript layout", () => {
	beforeAll(() => initTheme("dark"));
	it.each([false, true])(
		"puts a gap before the title and the output immediately below it (expanded=%s)",
		(expanded) => {
			const transcript = new ToolTranscriptContainer();
			transcript.addChild(new Text("Checking free space.", 0, 0));
			const tool = shell("disk");
			tool.setExpanded(expanded);
			transcript.addChild(tool);
			const lines = transcript
				.render(100)
				.map(stripAnsi)
				.map((line) => line.trimEnd());
			expect(lines[0]).toBe("Checking free space.");
			expect(lines[1]).toBe("");
			expect(lines[2]).toContain("$ df -h");
			expect(lines[2]).toContain("24ms");
			expect(lines.join("\n").match(/24ms/g)).toHaveLength(1);
			if (expanded) {
				expect(lines[3]).toContain("Filesystem");
				expect(lines[4]).toContain("/dev/local");
				expect(lines).toHaveLength(5);
			} else expect(lines).toHaveLength(3);
		},
	);
	it("keeps settled tool rows cached across transcript redraws until their spacing changes", () => {
		const transcript = new ToolTranscriptContainer();
		const first = shell("first");
		const separator = new Text("", 0, 0);
		const second = shell("second");
		transcript.addChild(first);
		transcript.addChild(separator);
		transcript.addChild(second);

		const initial = transcript.render(100);
		const firstRows = first.render(100);
		const secondRows = second.render(100);
		expect(secondRows).toHaveLength(1);

		expect(transcript.render(100)).toEqual(initial);
		expect(first.render(100)).toBe(firstRows);
		expect(second.render(100)).toBe(secondRows);

		separator.setText("Next step");
		const separated = transcript.render(100).map(stripAnsi);
		expect(first.render(100)).toBe(firstRows);
		expect(second.render(100)).toHaveLength(2);
		expect(separated[separated.indexOf("Next step") + 1]).toBe("");

		separator.setText("");
		expect(transcript.render(100)).toEqual(initial);
		expect(second.render(100)).toHaveLength(1);
	});
	it("joins tool-only turns and uses the same layout for rendering and mouse dispatch", () => {
		const transcript = new ToolTranscriptContainer();
		transcript.addChild(new Text("Checking free space.", 0, 0));
		const first = shell("disk");
		transcript.addChild(first);
		transcript.addChild(new Spacer(1));
		transcript.addChild(
			new AssistantMessageComponent(fauxAssistantMessage(fauxToolCall("get_subagent_result", { agent_id: "test" }))),
		);
		const second = new ToolExecutionComponent(
			"get_subagent_result",
			"result",
			{ agent_id: "test" },
			{},
			undefined,
			ui,
			"/tmp",
		);
		second.updateResult({ content: [{ type: "text", text: "Child result" }], isError: false, durationMs: 0 });
		transcript.addChild(second);
		let lines = transcript.render(100).map(stripAnsi);
		expect(lines[2]).toContain("$ df -h");
		expect(lines[3]).toContain("get_subagent_result");
		expect(transcript.handleMouse(mouse(3, lines.length))?.handled).toBe(true);
		lines = transcript.render(100).map(stripAnsi);
		expect(lines[3]).toContain("● get_subagent_result");
		expect(lines[3]).not.toMatch(/[▸▾]/);
		const output = lines.findIndex((line) => line.includes("Child result"));
		expect(output).toBeGreaterThan(3);
		// One click anywhere in the expanded body collapses the tool.
		expect(transcript.handleMouse(mouse(output, lines.length))?.handled).toBe(true);
		expect(transcript.render(100).map(stripAnsi).join("\n")).not.toContain("Child result");
		// The title expands it again, then collapses it.
		expect(transcript.handleMouse(mouse(3, lines.length))?.handled).toBe(true);
		expect(transcript.render(100).map(stripAnsi).join("\n")).toContain("Child result");
		expect(transcript.handleMouse(mouse(3, lines.length))?.handled).toBe(true);
		lines = transcript.render(100).map(stripAnsi);
		expect(lines[3]).toContain("● get_subagent_result");
		expect(lines[3]).not.toMatch(/[▸▾]/);
		expect(lines.join("\n")).not.toContain("Child result");
	});
	it("preserves clickable content rendered by an expanded tool", () => {
		const onClick = vi.fn();
		const result: Container = new Container();
		result.addChild({
			render: () => ["Clickable result"],
			invalidate() {},
			handleMouse: (event) => {
				if (event.type !== "click") return undefined;
				onClick(event.y);
				return { handled: true };
			},
		});
		const tool = new ToolExecutionComponent(
			"custom",
			"click",
			{},
			{},
			{ renderCall: () => new Text("Custom title", 0, 0), renderResult: () => result },
			ui,
			"/tmp",
		);
		tool.updateResult({ content: [], isError: false });
		tool.setExpanded(true);
		const lines = tool.render(100).map(stripAnsi);
		const row = lines.findIndex((line) => line.includes("Clickable result"));
		expect(row).toBe(2);
		expect(tool.handleMouse(mouse(row, lines.length))?.handled).toBe(true);
		expect(onClick).toHaveBeenCalledWith(0);
	});
});
