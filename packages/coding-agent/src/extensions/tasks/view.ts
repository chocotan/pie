import {
	type Component,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { highlightHover } from "../../modes/interactive/components/hover-style.ts";
import { theme } from "../../modes/interactive/theme/theme.ts";
import { sortTasks, type TaskRecord, type TaskState } from "./index.ts";

/** Non-capturing task panel; its owner controls opening and dismissal. */
export class TodoPanel implements Component {
	private readonly ui: TUI;
	private readonly getState: () => TaskState;
	private readonly close: () => void;
	private readonly select: (task: TaskRecord) => void;
	private readonly more: () => void;
	private moreRow: number | undefined;
	private offset = 0;
	private positions: Array<{ from: number; to: number; task: TaskRecord }> = [];
	private width = 0;
	private bodyHeight = 0;
	private hovered: string | undefined;

	constructor(
		ui: TUI,
		getState: () => TaskState,
		close: () => void,
		select: (task: TaskRecord) => void,
		more: () => void,
	) {
		this.ui = ui;
		this.getState = getState;
		this.close = close;
		this.select = select;
		this.more = more;
	}
	invalidate(): void {}
	render(width: number): string[] {
		this.width = width;
		const state = this.getState();
		const done = state.tasks.filter((task) => task.status === "completed").length;
		this.moreRow = undefined;
		const tasks = sortTasks(state.tasks).slice(0, 10);
		const hidden = state.tasks.length - tasks.length;
		const inner = Math.max(1, width - 4);
		const title = truncateToWidth(
			`Todo · ${tasks.length}/${state.tasks.length} · ${done} done`,
			Math.max(0, width - 8),
			"…",
		);
		const close = this.hovered === "close" ? highlightHover("[x]") : "[x]";
		const header = `╭ ${theme.fg("accent", theme.bold(title))}${" ".repeat(Math.max(0, width - visibleWidth(title) - 7))}${close} ╮`;
		const capacity = Math.max(0, Math.floor(this.ui.terminal.rows * 0.35) - 2);
		const body: string[] = [];
		const positions: typeof this.positions = [];
		if (!tasks.length) body.push(theme.fg("muted", hidden ? `${hidden} completed hidden` : "No tasks"));
		for (const task of tasks) {
			const marker = task.status === "completed" ? "✓" : task.status === "in_progress" ? "›" : "·";
			const color = task.status === "completed" ? "success" : task.status === "in_progress" ? "accent" : "muted";
			const start = body.length;
			body.push(...wrapTextWithAnsi(theme.fg(color, `${marker} #${task.id} ${task.subject}`), inner));
			positions.push({ from: start, to: body.length, task });
		}
		this.offset = Math.min(this.offset, Math.max(0, body.length - capacity));
		this.positions = positions.map((position) => ({
			...position,
			from: position.from - this.offset + 1,
			to: position.to - this.offset + 1,
		}));
		const visible = body.slice(this.offset, this.offset + capacity);
		this.bodyHeight = visible.length;
		const lines = [header];
		for (const [index, line] of visible.entries()) {
			const row = `│ ${line}${" ".repeat(Math.max(0, inner - visibleWidth(line)))} │`;
			const task = this.positions.find((position) => index + 1 >= position.from && index + 1 < position.to)?.task;
			lines.push(task && task.id === this.hovered ? highlightHover(row) : row);
		}
		if (hidden) {
			this.moreRow = lines.length;
			const label = truncateToWidth(theme.fg("muted", `+${hidden} hidden · view all`), inner, "…");
			const row = `│ ${label}${" ".repeat(Math.max(0, inner - visibleWidth(label)))} │`;
			lines.push(this.hovered === "more" ? highlightHover(row) : row);
		}
		const footer =
			body.length > capacity
				? ` ${this.offset + 1}–${Math.min(body.length, this.offset + capacity)}/${body.length} · scroll `
				: "";
		const label = truncateToWidth(footer, Math.max(0, width - 2), "");
		lines.push(`╰${label}${"─".repeat(Math.max(0, width - visibleWidth(label) - 2))}╯`);
		return lines.map((line) => truncateToWidth(line, width, ""));
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel") {
			this.hovered = undefined;
			this.offset = Math.max(0, this.offset + (event.wheelDelta ?? 0));
			this.ui.requestRender();
			return { handled: true };
		}
		const closing = event.y === 0 && event.x >= Math.max(0, this.width - 6);
		const task =
			event.y > 0 && event.y <= this.bodyHeight
				? this.positions.find((position) => event.y >= position.from && event.y < position.to)?.task
				: undefined;
		const more = this.moreRow !== undefined && event.y === this.moreRow;
		if (event.type === "move" || event.type === "leave") {
			const hovered =
				event.type === "move" && event.button === "none"
					? closing
						? "close"
						: more
							? "more"
							: task?.id
					: undefined;
			const changed = hovered !== this.hovered;
			this.hovered = hovered;
			return hovered !== undefined || changed ? { handled: true, render: changed } : undefined;
		}
		if (event.button !== "left") return undefined;
		if (!closing && !task && !more) return undefined;
		if (event.type === "press") return { handled: true, render: false };
		if (event.type !== "click") return undefined;
		if (closing) this.close();
		else if (more) this.more();
		else if (task) this.select(task);
		return { handled: true };
	}
}
