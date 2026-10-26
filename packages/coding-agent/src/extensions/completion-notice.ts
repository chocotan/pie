import { type Component, MouseRegion, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { MessageRenderOptions } from "../core/extensions/types.ts";
import { formatToolDuration, getToolCallDescription } from "../core/tools/render-utils.ts";
import { highlightHover } from "../modes/interactive/components/hover-style.ts";
import type { Theme } from "../modes/interactive/theme/theme.ts";
import { stripAnsi } from "../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../utils/shell.ts";

interface CompletionNotice {
	kind: string;
	title: string;
	status: string;
	progress?: string;
	startedAt: number;
	finishedAt?: number;
	color: "success" | "error" | "muted";
	notice?: string;
	summary?: string;
	details: string[];
}

/** Human-only presentation; the original notification remains unchanged in model context. */
export function renderCompletionNotice(
	notice: CompletionNotice,
	options: MessageRenderOptions,
	theme: Theme,
): Component {
	let expanded = options.expanded;
	let hovered = false;
	let headingRows = 0;
	const title = getToolCallDescription({ description: notice.title }) ?? notice.kind;
	const duration = formatToolDuration(Math.max(0, (notice.finishedAt ?? notice.startedAt) - notice.startedAt));
	const clean = (text: string) => sanitizeBinaryOutput(stripAnsi(text));
	return new MouseRegion(
		{
			invalidate() {},
			render(width) {
				const padding = Math.min(options.outputPad, Math.max(0, Math.floor((width - 1) / 2)));
				const inner = Math.max(1, width - padding * 2);
				const heading = [notice.kind, notice.status.replaceAll("_", " "), notice.progress, duration]
					.filter(Boolean)
					.join(" · ");
				const label = `${theme.fg("muted", expanded ? "▾" : "▸")} ${theme.fg(notice.color, theme.bold(heading))}`;
				const rows = new Text(label, 0, 0).render(inner);
				rows.push(...new Text(theme.bold(title), 0, 0).render(inner));
				headingRows = rows.length;
				if (hovered) rows.splice(0, rows.length, ...rows.map((line) => highlightHover(line)));
				for (const [text, color] of [
					[notice.notice, notice.color],
					[notice.summary, "text"],
				] as const) {
					if (!text) continue;
					const lines = new Text(theme.fg(color, clean(text)), 0, 0).render(inner);
					rows.push(...(expanded ? lines : lines.slice(0, 3)));
					if (!expanded && lines.length > 3) rows.push(theme.fg("muted", "… expand to read more"));
				}
				if (expanded)
					for (const detail of notice.details)
						rows.push(...new Text(theme.fg("muted", clean(detail)), 0, 0).render(inner));
				return rows.map((line) => truncateToWidth(`${" ".repeat(padding)}${line}`, width, ""));
			},
		},
		(event) => {
			const heading = event.y >= 0 && event.y < headingRows;
			if (event.type === "move" || event.type === "leave") {
				const next = event.type === "move" && event.button === "none" && heading;
				const changed = next !== hovered;
				hovered = next;
				return next || changed ? { handled: true, render: changed } : undefined;
			}
			if (!heading || event.button !== "left") return undefined;
			if (event.type === "press") return { handled: true, render: false };
			if (event.type !== "click") return undefined;
			expanded = !expanded;
			return { handled: true, render: true };
		},
	);
}
