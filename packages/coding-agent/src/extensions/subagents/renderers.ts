import { Text } from "@earendil-works/pi-tui";
import type { MessageRenderer } from "../../core/extensions/types.ts";
import { formatToolCallWithArgs, getToolCallDescription } from "../../core/tools/render-utils.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { renderCompletionNotice } from "../completion-notice.ts";
import type { SubagentRecord } from "./index.ts";

export const renderSubagentCompletion: MessageRenderer<SubagentRecord> = (message, options, theme) => {
	const record = message.details;
	if (!record || typeof record.agent !== "string" || typeof record.status !== "string") return undefined;
	return renderCompletionNotice(
		{
			kind: "Subagent",
			title: record.description || record.agent,
			status: record.status,
			progress:
				record.turns !== undefined && record.maxTurns !== undefined
					? `${record.turns}/${record.maxTurns}`
					: undefined,
			startedAt: record.startedAt,
			finishedAt: record.finishedAt,
			color: record.status === "completed" ? "success" : record.status === "error" ? "error" : "muted",
			notice: record.stopReason || record.error,
			summary: record.output,
			details: [
				`Agent: ${record.agent}`,
				`Agent ID: ${record.id}`,
				`Model: ${record.model} · ${record.thinking}`,
				...(record.taskId ? [`Task: #${record.taskId}`] : []),
				...(record.sessionFile ? [`Session: ${record.sessionFile}`] : []),
			],
		},
		options,
		theme,
	);
};

/** A readable subagent heading, with the original parameters retained when expanded. */
export function renderSubagentCall(
	name: string,
	caption: string,
	args: unknown,
	theme: Theme,
	expanded: boolean,
): Text {
	const purpose = getToolCallDescription({ description: caption }) ?? name;
	const heading = `${theme.fg("toolTitle", theme.bold(name))} ${theme.fg("accent", purpose)}`;
	if (!expanded) return new Text(heading, 0, 0);
	const parameters = formatToolCallWithArgs(name, args, theme, true).split("\n").slice(1).join("\n");
	// ToolExecutionComponent already draws an explicit description in its title.
	return new Text(getToolCallDescription(args) ? parameters : `${heading}\n${parameters}`, 0, 0);
}
