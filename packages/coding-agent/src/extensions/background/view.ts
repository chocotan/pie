import {
	type Component,
	getKeybindings,
	Text,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { ActivityDot } from "../../modes/interactive/components/activity-dot.ts";
import { highlightHover } from "../../modes/interactive/components/hover-style.ts";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { ToolTranscriptContainer } from "../../modes/interactive/components/tool-transcript.ts";
import { theme } from "../../modes/interactive/theme/theme.ts";
import { type BackgroundTask, readTaskLogs, sortBackgroundTasks } from "./registry.ts";

export class BackgroundPanel implements Component {
	private readonly ui: TUI;
	private readonly tasks: () => BackgroundTask[];
	private readonly open: (task: BackgroundTask) => void;
	private readonly more: () => void;
	private readonly close: () => void;
	private rows: Array<BackgroundTask | undefined> = [];
	private width = 0;
	private hovered?: number;
	private spinner?: ActivityDot;
	constructor(
		ui: TUI,
		tasks: () => BackgroundTask[],
		open: (task: BackgroundTask) => void,
		more: () => void,
		close: () => void,
	) {
		this.ui = ui;
		this.tasks = tasks;
		this.open = open;
		this.more = more;
		this.close = close;
	}
	invalidate(): void {}
	dispose(): void {
		this.spinner?.dispose();
		this.spinner = undefined;
	}
	render(width: number): string[] {
		this.width = width;
		this.rows = [];
		const tasks = sortBackgroundTasks(this.tasks());
		if (!tasks.length || width < 1) {
			this.dispose();
			return [];
		}
		const count = Math.min(5, tasks.length, Math.max(1, Math.floor(this.ui.terminal.rows * 0.35) - 3));
		const visible = tasks.slice(0, count);
		if (!visible.some((task) => task.status === "running")) this.dispose();
		const title = truncateToWidth("Background", Math.max(0, width - 8), "…");
		const close = this.hovered === 0 ? highlightHover("[x]") : "[x]";
		const lines = [
			`╭ ${theme.fg("accent", theme.bold(title))}${" ".repeat(Math.max(0, width - visibleWidth(title) - 7))}${close} ╮`,
		];
		const inner = Math.max(0, width - 4);
		for (const task of visible) {
			const color = task.status === "completed" ? "success" : task.status === "failed" ? "error" : "muted";
			let icon = theme.fg(color, "●");
			if (task.status === "running") {
				this.spinner ??= new ActivityDot(this.ui);
				icon = this.spinner.renderDot();
			}
			const elapsed = ` ${Math.max(0, Math.floor(((task.finishedAt ?? Date.now()) - task.startedAt) / 1000))}s`;
			const description = truncateToWidth(
				task.description || task.name,
				Math.max(0, inner - elapsed.length - 2),
				"…",
			);
			const text = truncateToWidth(`${icon} ${theme.bold(description)}${theme.fg("muted", elapsed)}`, inner, "");
			lines.push(`│ ${text}${" ".repeat(Math.max(0, inner - visibleWidth(text)))} │`);
			this.rows.push(task);
		}
		if (tasks.length > count) {
			const text = truncateToWidth(theme.fg("muted", `+${tasks.length - count} hidden · view all`), inner, "…");
			lines.push(`│ ${text}${" ".repeat(Math.max(0, inner - visibleWidth(text)))} │`);
			this.rows.push(undefined);
		}
		lines.push(`╰${"─".repeat(Math.max(0, width - 2))}╯`);
		return lines.map((line, row) =>
			truncateToWidth(row > 0 && row === this.hovered ? highlightHover(line) : line, width, ""),
		);
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const close = event.y === 0 && event.x >= Math.max(0, this.width - 6);
		const item = event.y > 0 && event.y <= this.rows.length;
		if (event.type === "move" || event.type === "leave") {
			const hovered = event.type === "move" && event.button === "none" && (close || item) ? event.y : undefined;
			const changed = hovered !== this.hovered;
			this.hovered = hovered;
			return hovered !== undefined || changed ? { handled: true, render: changed } : undefined;
		}
		if (event.button !== "left" || (!close && !item)) return undefined;
		if (event.type === "press") return { handled: true, render: false };
		if (event.type !== "click") return undefined;
		if (close) this.close();
		else {
			const task = this.rows[event.y - 1];
			if (task) this.open(task);
			else this.more();
		}
		return { handled: true };
	}
}

/** Focus is captured only by the explicit detail overlay, and restored by ui.custom on close. */
export class BackgroundDetailView implements Component {
	private readonly ui: TUI;
	private readonly getTask: () => BackgroundTask;
	private readonly done: () => void;
	private readonly keys = getKeybindings();
	private readonly transcript = new ToolTranscriptContainer();
	private readonly timer: NodeJS.Timeout;
	private log = "Loading output…";
	private loading = false;
	private disposed = false;
	private scrollTop = 0;
	private contentHeight = 0;
	private bodyHeight = 0;
	private width = 0;
	private hovered = false;
	constructor(ui: TUI, getTask: () => BackgroundTask, done: () => void) {
		this.ui = ui;
		this.getTask = getTask;
		this.done = done;
		this.timer = setInterval(() => {
			void this.refresh();
		}, 1000);
		this.timer.unref();
		void this.refresh();
	}
	private async refresh(): Promise<void> {
		if (this.loading || this.disposed) return;
		this.loading = true;
		try {
			const logs = await readTaskLogs(this.getTask());
			this.log = `${logs.truncated ? `[Tail of ${logs.totalBytes} bytes; full output: ${this.getTask().outputPath}]\n\n` : ""}${logs.text || "(no output yet)"}`;
		} catch (error) {
			this.log = `Cannot read output: ${String(error)}`;
		} finally {
			this.loading = false;
			if (!this.disposed) this.ui.requestRender();
		}
	}
	dispose(): void {
		this.disposed = true;
		clearInterval(this.timer);
	}
	invalidate(): void {
		this.transcript.invalidate();
	}
	handleInput(data: string): void {
		if (this.keys.matches(data, "tui.select.cancel")) {
			this.done();
			return;
		}
		if (this.keys.matches(data, "tui.select.pageUp") || this.keys.matches(data, "tui.altScreen.pageUp"))
			this.scroll(-Math.max(1, this.bodyHeight - 1));
		else if (this.keys.matches(data, "tui.select.pageDown") || this.keys.matches(data, "tui.altScreen.pageDown"))
			this.scroll(Math.max(1, this.bodyHeight - 1));
		else if (this.keys.matches(data, "tui.select.up") || this.keys.matches(data, "tui.altScreen.lineUp"))
			this.scroll(-1);
		else if (this.keys.matches(data, "tui.select.down") || this.keys.matches(data, "tui.altScreen.lineDown"))
			this.scroll(1);
	}
	private scroll(delta: number): void {
		this.scrollTop = Math.max(0, Math.min(Math.max(0, this.contentHeight - this.bodyHeight), this.scrollTop + delta));
		this.ui.requestRender();
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const close = event.y === 1 && event.x >= Math.max(0, this.width - 6);
		if (event.type === "move" || event.type === "leave") {
			const hovered = event.type === "move" && event.button === "none" && close;
			const changed = hovered !== this.hovered;
			this.hovered = hovered;
			if (hovered || changed) return { handled: true, render: changed };
		}
		if (event.button === "left" && close) {
			if (event.type === "press") return { handled: true, render: false };
			if (event.type === "click") {
				this.done();
				return { handled: true };
			}
		}
		if (event.type === "wheel" && event.y >= 4 && event.y < 4 + this.bodyHeight) {
			this.scroll(event.wheelDelta ?? 0);
			return { handled: true };
		}
		return undefined;
	}
	render(width: number): string[] {
		this.width = width;
		const task = this.getTask();
		const height = Math.max(1, this.ui.terminal.rows);
		const inner = Math.max(1, width - 2);
		this.bodyHeight = Math.max(0, height - 6);
		const frame = (content: string) => {
			const text = truncateToWidth(content, Math.max(0, width - 2), "");
			return `│${text}${" ".repeat(Math.max(0, width - 2 - visibleWidth(text)))}│`;
		};
		const title = truncateToWidth(theme.bold(task.description || task.name), Math.max(0, inner - 5), "…");
		const close = this.hovered ? highlightHover("[x]") : "[x]";
		const lines = [
			`╭${"─".repeat(Math.max(0, width - 2))}╮`,
			frame(`${title}${" ".repeat(Math.max(0, inner - visibleWidth(title) - 3))}${close}`),
			frame(theme.fg(task.status === "failed" ? "error" : "muted", `${task.status} · ${task.shell} · ${task.id}`)),
			`├${"─".repeat(Math.max(0, width - 2))}┤`,
		];
		this.transcript.clear();
		this.transcript.addChild(
			new Text(
				theme.fg(
					"muted",
					`${task.cwd}\n${task.shell === "powershell" ? "PS>" : "$"} ${task.command}\n${task.outputPath}`,
				),
				0,
				0,
			),
		);
		if (task.error) this.transcript.addChild(new Text(theme.fg("error", task.error), 0, 0));
		this.transcript.addChild(new Text(this.log, 0, 0));
		const content = this.transcript.render(inner);
		this.contentHeight = content.length;
		this.scrollTop = Math.min(this.scrollTop, Math.max(0, content.length - this.bodyHeight));
		for (let index = 0; index < this.bodyHeight; index++) lines.push(frame(content[this.scrollTop + index] ?? ""));
		lines.push(`╰${"─".repeat(Math.max(0, width - 2))}╯`, frame(keyHint("tui.select.cancel", "back")));
		return lines.slice(0, height).map((line) => truncateToWidth(line, width, ""));
	}
}
