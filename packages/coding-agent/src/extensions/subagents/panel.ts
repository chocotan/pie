import {
	type Component,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { ActivityDot } from "../../modes/interactive/components/activity-dot.ts";
import { highlightHover } from "../../modes/interactive/components/hover-style.ts";
import { theme } from "../../modes/interactive/theme/theme.ts";
import { type SubagentRecord, sortSubagents } from "./index.ts";

/** Floating run list, one entry per row, with direct detail and overflow entrances. */
export class SubagentPanel implements Component {
	private readonly ui: TUI;
	private readonly records: readonly SubagentRecord[];
	private readonly open: (record: SubagentRecord) => void;
	private readonly more: () => void;
	private readonly close: () => void;
	private rows: Array<SubagentRecord | undefined> = [];
	private width = 0;
	private hoveredRow: number | undefined;
	private spinner?: ActivityDot;
	constructor(
		ui: TUI,
		records: readonly SubagentRecord[],
		open: (record: SubagentRecord) => void,
		more: () => void,
		close: () => void,
	) {
		this.ui = ui;
		this.records = records;
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
		if (!this.records.length || width < 1) return [];
		const sorted = sortSubagents(this.records);
		const count = Math.min(5, sorted.length, Math.max(1, Math.floor(this.ui.terminal.rows * 0.35) - 2));
		const records = sorted.slice(0, count);
		const hidden = sorted.length - count;
		if (!records.some((record) => ["running", "queued"].includes(record.status))) this.dispose();
		const title = truncateToWidth(`Subagents · ${records.length}/${sorted.length}`, Math.max(0, width - 8), "…");
		const close = this.hoveredRow === 0 ? highlightHover("[x]") : "[x]";
		const lines = [
			`╭ ${theme.fg("accent", theme.bold(title))}${" ".repeat(Math.max(0, width - visibleWidth(title) - 7))}${close} ╮`,
		];
		const inner = Math.max(0, width - 4);
		for (const record of records) {
			const color =
				record.status === "completed"
					? "success"
					: record.status === "error"
						? "error"
						: ["running", "queued"].includes(record.status)
							? "accent"
							: "muted";
			let icon = theme.fg(color, "●");
			if (["running", "queued"].includes(record.status)) {
				this.spinner ??= new ActivityDot(this.ui);
				icon = this.spinner.renderDot();
			}
			const end =
				record.finishedAt ??
				(record.status === "running" || record.status === "queued" ? Date.now() : record.startedAt);
			const progress =
				record.turns !== undefined && record.maxTurns !== undefined ? ` ${record.turns}/${record.maxTurns}` : "";
			const duration = `${progress} ${Math.max(0, Math.floor((end - record.startedAt) / 1000))}s`;
			const description = truncateToWidth(
				record.description || record.agent,
				Math.max(0, inner - duration.length - 2),
				"…",
			);
			const text = truncateToWidth(`${icon} ${theme.bold(description)}${theme.fg("muted", duration)}`, inner, "");
			lines.push(`│ ${text}${" ".repeat(Math.max(0, inner - visibleWidth(text)))} │`);
			this.rows.push(record);
		}
		const overflow = hidden;
		if (overflow) {
			const text = truncateToWidth(theme.fg("muted", `+${overflow} hidden · view all`), inner, "…");
			lines.push(`│ ${text}${" ".repeat(Math.max(0, inner - visibleWidth(text)))} │`);
			this.rows.push(undefined);
		}
		lines.push(`╰${"─".repeat(Math.max(0, width - 2))}╯`);
		return lines.map((line, row) =>
			truncateToWidth(row > 0 && row === this.hoveredRow ? highlightHover(line) : line, width, ""),
		);
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const closing = event.y === 0 && event.x >= Math.max(0, this.width - 6);
		const item = event.y >= 1 && event.y <= this.rows.length;
		if (event.type === "move" || event.type === "leave") {
			const hovered = event.type === "move" && event.button === "none" && (closing || item) ? event.y : undefined;
			const changed = hovered !== this.hoveredRow;
			this.hoveredRow = hovered;
			return hovered !== undefined || changed ? { handled: true, render: changed } : undefined;
		}
		if (event.button !== "left") return undefined;
		if (!closing && !item) return undefined;
		if (event.type === "press") return { handled: true, render: false };
		if (event.type !== "click") return undefined;
		if (closing) this.close();
		else {
			const record = this.rows[event.y - 1];
			if (record) this.open(record);
			else this.more();
		}
		return { handled: true };
	}
}
