import { type TUI, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { SubagentRecord } from "../src/extensions/subagents/index.ts";
import { SubagentPanel } from "../src/extensions/subagents/panel.ts";
import type { TaskRecord, TaskState } from "../src/extensions/tasks/index.ts";
import { TaskDetailView, TodoPanel } from "../src/extensions/tasks/view.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const mouse = (x: number, y: number): TuiMouseEvent => ({
	type: "click",
	button: "left",
	x,
	y,
	screenX: x,
	screenY: y,
	width: 80,
	height: 24,
	shift: false,
	alt: false,
	ctrl: false,
	clickCount: 1,
});

describe("workflow floating and inline widgets", () => {
	beforeAll(() => initTheme("dark"));
	it("renders Todo subjects, stays bounded, updates, and closes from its own button", () => {
		let state: TaskState = {
			nextId: 2,
			tasks: [
				{
					id: "1",
					subject: "Verify title toggles",
					activeForm: "Verifying titles",
					description: "Private detailed requirements",
					status: "pending",
					blockedBy: [],
					metadata: {},
				},
			],
		};
		const close = vi.fn();
		const select = vi.fn();
		const more = vi.fn();
		const panel = new TodoPanel(
			{ terminal: { rows: 24 }, requestRender: vi.fn() } as unknown as TUI,
			() => state,
			close,
			select,
			more,
		);
		for (const width of [10, 30, 80]) {
			const lines = panel.render(width);
			expect(lines.length).toBeLessThanOrEqual(8);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}
		let text = stripAnsi(panel.render(80).join("\n"));
		expect(text).toContain("Verify title toggles");
		expect(text).not.toContain("Verifying titles");
		expect(text).not.toContain("Private detailed requirements");
		panel.handleMouse(mouse(3, 1));
		expect(select).toHaveBeenCalledWith(state.tasks[0]);
		state = { ...state, tasks: [{ ...state.tasks[0], status: "completed" }] };
		text = stripAnsi(panel.render(80).join("\n"));
		expect(text).toContain("Todo · 1/1");
		state = {
			nextId: 8,
			tasks: [
				...Array.from({ length: 4 }, (_, index) => ({
					...state.tasks[0],
					id: String(index + 1),
					subject: `Done ${index}`,
					status: "completed" as const,
				})),
				...Array.from({ length: 3 }, (_, index) => ({
					...state.tasks[0],
					id: String(index + 5),
					subject: `Open ${index}`,
					status: "pending" as const,
				})),
			],
		};
		text = stripAnsi(panel.render(80).join("\n"));
		expect(text).not.toContain("hidden");
		expect(text).toContain("Todo · 7/7");
		expect(text).not.toContain("Done 0");
		expect(text).toContain("Open 0");
		panel.handleMouse(mouse(76, 0));
		expect(close).toHaveBeenCalledOnce();
	});
	it("renders task details in a bounded, scrollable view and closes with the configured cancel key", () => {
		const done = vi.fn();
		const requestRender = vi.fn();
		const task: TaskRecord = {
			id: "7",
			subject: "Review the implementation",
			description: Array.from({ length: 40 }, (_, index) => `Requirement line ${index + 1}`).join("\n"),
			activeForm: "Reviewing implementation",
			agentType: "reviewer",
			owner: "worker-1",
			status: "in_progress",
			blockedBy: ["2", "3"],
			metadata: {},
		};
		const detail = new TaskDetailView({ terminal: { rows: 15 }, requestRender } as unknown as TUI, task, done);
		for (const width of [1, 2, 10, 20, 40, 80]) {
			const lines = detail.render(width);
			expect(lines).toHaveLength(12);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}
		let rendered = stripAnsi(detail.render(80).join("\n"));
		expect(rendered).toContain("Review the implementation");
		expect(rendered).toContain("Requirement line 1");
		expect(rendered).not.toContain("Requirement line 20");
		detail.handleMouse({ ...mouse(0, 0), type: "wheel", button: "none", wheelDelta: 20 });
		rendered = stripAnsi(detail.render(80).join("\n"));
		expect(rendered).toContain("Requirement line 20");
		expect(rendered).not.toContain("Requirement line 1\n");
		detail.handleMouse({ ...mouse(0, 0), type: "wheel", button: "none", wheelDelta: 40 });
		rendered = stripAnsi(detail.render(80).join("\n"));
		expect(rendered).toContain("Current step: Reviewing implementation");
		expect(rendered).toContain("Blocked by: #2, #3");
		detail.handleInput("\x1b");
		expect(done).toHaveBeenCalledOnce();
		detail.handleMouse(mouse(76, 0));
		expect(done).toHaveBeenCalledTimes(2);
		expect(requestRender).toHaveBeenCalled();
	});
	it.each([10, 12, 24, 41])(
		"keeps the task footer and last detail visible within an 80%% overlay (%s terminal rows)",
		(rows) => {
			const terminal = { rows };
			const detail = new TaskDetailView(
				{ terminal, requestRender: vi.fn() } as unknown as TUI,
				{
					id: "1",
					subject: "Long task",
					description: "A detailed requirement\n".repeat(40),
					status: "pending",
					blockedBy: ["2"],
					metadata: {},
				},
				vi.fn(),
			);
			for (const height of [rows, rows + 3, rows]) {
				terminal.rows = height;
				detail.handleMouse({ ...mouse(0, 0), type: "wheel", button: "none", wheelDelta: 1000 });
				const lines = detail.render(60).map(stripAnsi);
				expect(lines).toHaveLength(Math.floor(height * 0.8));
				expect(lines.slice(2, -2).join("\n")).toContain("Blocked by: #2");
				expect(lines.at(-2)).toContain("scroll · escape/ctrl+c close");
				expect(lines.at(-1)).toMatch(/^╰─+╯$/);
			}
		},
	);
	it.each([5, 10, 11, 20])("caps subagent rows at ten with a working overflow entrance (%s total)", (total) => {
		const records: SubagentRecord[] = Array.from({ length: total }, (_, index) => ({
			id: String(index),
			agent: "worker",
			description: `Finished ${index}`,
			prompt: "",
			status: "completed",
			model: "faux/local",
			thinking: "off",
			startedAt: index,
			finishedAt: index + 1000,
			output: "",
		}));
		const open = vi.fn();
		const more = vi.fn();
		const panel = new SubagentPanel(
			{ terminal: { rows: 40 }, requestRender: vi.fn() } as unknown as TUI,
			records,
			open,
			more,
			vi.fn(),
		);
		const rows = panel.render(80).map(stripAnsi);
		const visible = Math.min(10, total);
		expect(rows[0]).toContain(`${visible}/${total}`);
		expect(rows.filter((line) => line.includes("●"))).toHaveLength(visible);
		panel.handleMouse(mouse(3, visible));
		expect(open).toHaveBeenCalledWith(records[total - visible]);
		if (total > visible) {
			const row = rows.findIndex((line) => line.includes(`+${total - visible} hidden`));
			expect(row).toBe(visible + 1);
			panel.handleMouse(mouse(3, row));
			expect(more).toHaveBeenCalledOnce();
		}
		panel.dispose();
	});
	it.each([5, 10, 11, 20])("caps Todo entries at ten with a working overflow entrance (%s total)", (total) => {
		const state: TaskState = {
			nextId: total + 1,
			tasks: Array.from({ length: total }, (_, index) => ({
				id: String(index + 1),
				subject: `Task ${index}`,
				description: "Saved requirements",
				status: "completed",
				blockedBy: [],
				metadata: {},
			})),
		};
		const select = vi.fn();
		const more = vi.fn();
		const panel = new TodoPanel(
			{ terminal: { rows: 40 }, requestRender: vi.fn() } as unknown as TUI,
			() => state,
			vi.fn(),
			select,
			more,
		);
		const rows = panel.render(80).map(stripAnsi);
		const visible = Math.min(10, total);
		expect(rows[0]).toContain(`${visible}/${total}`);
		expect(rows.filter((line) => line.includes("#"))).toHaveLength(visible);
		if (total > visible) {
			const row = rows.findIndex((line) => line.includes(`+${total - visible} hidden`));
			expect(row).toBe(visible + 1);
			panel.handleMouse(mouse(3, row));
			expect(more).toHaveBeenCalledOnce();
		}
	});
	it("sorts running work before pending/queued work and completed rows even below the limit", () => {
		const ui = { terminal: { rows: 40 }, requestRender: vi.fn() } as unknown as TUI;
		const state: TaskState = {
			nextId: 4,
			tasks: ["completed", "pending", "in_progress"].map((status, index) => ({
				id: String(index),
				subject: status,
				description: "",
				status: status as TaskState["tasks"][number]["status"],
				blockedBy: [],
				metadata: {},
			})),
		};
		const select = vi.fn();
		const todo = new TodoPanel(ui, () => state, vi.fn(), select, vi.fn());
		const rows = todo.render(80).map(stripAnsi);
		expect(rows[1]).toContain("in_progress");
		expect(rows[2]).toContain("pending");
		expect(rows[3]).toContain("completed");
		todo.handleMouse(mouse(3, 1));
		expect(select).toHaveBeenCalledWith(state.tasks[2]);
		const records: SubagentRecord[] = ["completed", "queued", "running", "error"].map((status, index) => ({
			id: String(index),
			agent: "worker",
			description: status,
			prompt: "",
			status: status as SubagentRecord["status"],
			model: "faux/local",
			thinking: "off",
			startedAt: index,
			output: "",
		}));
		const open = vi.fn();
		const agents = new SubagentPanel(ui, records, open, vi.fn(), vi.fn());
		try {
			const rows = agents.render(80).map(stripAnsi);
			expect(rows[1]).toContain("running");
			expect(rows[2]).toContain("queued");
			expect(rows[3]).toContain("error");
			expect(rows[4]).toContain("completed");
			agents.handleMouse(mouse(3, 1));
			expect(open).toHaveBeenCalledWith(records[2]);
		} finally {
			agents.dispose();
		}
	});
	it("animates queued and running subagents, then stops on a settled status", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const requestRender = vi.fn();
		const record: SubagentRecord = {
			id: "dot",
			agent: "worker",
			description: "Check disk",
			prompt: "Check",
			status: "queued",
			model: "faux/local",
			thinking: "off",
			startedAt: 0,
			output: "",
		};
		const panel = new SubagentPanel(
			{ terminal: { rows: 24 }, requestRender } as unknown as TUI,
			[record],
			vi.fn(),
			vi.fn(),
			vi.fn(),
		);
		try {
			const queued = stripAnsi(panel.render(80)[1]);
			expect(queued).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
			vi.advanceTimersByTime(80);
			expect(requestRender).toHaveBeenCalled();
			expect(stripAnsi(panel.render(80)[1])).not.toBe(queued);
			record.status = "running";
			expect(stripAnsi(panel.render(80)[1])).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
			record.status = "completed";
			record.finishedAt = 80;
			expect(stripAnsi(panel.render(80)[1])).toContain("● Check disk");
			expect(panel.render(80)[1]).toContain(theme.getFgAnsi("success"));
			expect(vi.getTimerCount()).toBe(0);
			record.status = "error";
			expect(panel.render(80)[1]).toContain(theme.getFgAnsi("error"));
		} finally {
			panel.dispose();
			vi.useRealTimers();
		}
	});
	it("renders subagents on separate rows with direct clicks and a visible overflow entrance", () => {
		const record: SubagentRecord = {
			id: "1",
			agent: "worker",
			description: "Review tool titles",
			prompt: "Review",
			status: "completed",
			model: "faux/local",
			thinking: "off",
			startedAt: 0,
			finishedAt: 4000,
			output: "done",
		};
		const open = vi.fn();
		const more = vi.fn();
		const ui = { terminal: { rows: 24 }, requestRender: vi.fn() } as unknown as TUI;
		const close = vi.fn();
		const panel = new SubagentPanel(
			ui,
			[record, { ...record, id: "2", description: "Verify terminal layout", startedAt: 1 }],
			open,
			more,
			close,
		);
		const rows = panel.render(80).map(stripAnsi);
		expect(rows[1]).toContain("Verify terminal layout");
		expect(rows[2]).toContain("Review tool titles");
		expect(rows[2]).toContain("4s");
		panel.handleMouse(mouse(3, 2));
		expect(open).toHaveBeenCalledWith(record);
		panel.handleMouse(mouse(76, 0));
		expect(close).toHaveBeenCalledOnce();
		const mixed = new SubagentPanel(
			ui,
			[
				...Array.from({ length: 4 }, (_, index) => ({
					...record,
					id: `done-${index}`,
					description: `Done ${index}`,
				})),
				...Array.from({ length: 3 }, (_, index) => ({
					...record,
					id: `run-${index}`,
					description: `Running ${index}`,
					status: "running" as const,
					finishedAt: undefined,
				})),
			],
			open,
			more,
			close,
		);
		const mixedText = stripAnsi(mixed.render(80).join("\n"));
		expect(mixedText).toContain("Subagents · 6/7");
		expect(mixedText).toContain("+1 hidden");
		expect(mixedText).toContain("Running 0");
		const crowded = new SubagentPanel(
			ui,
			Array.from({ length: 10 }, (_, index) => ({ ...record, id: String(index) })),
			open,
			more,
			close,
		);
		for (const width of [10, 30, 80, 120]) {
			const lines = crowded.render(width);
			expect(lines.length).toBeGreaterThan(1);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}
		const lines = crowded.render(80).map(stripAnsi);
		const moreRow = lines.findIndex((line) => line.includes("view all"));
		expect(moreRow).toBeGreaterThan(0);
		crowded.handleMouse(mouse(3, moreRow));
		expect(more).toHaveBeenCalledOnce();
	});
});
