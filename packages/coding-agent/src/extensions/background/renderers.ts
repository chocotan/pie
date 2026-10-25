import type { MessageRenderer } from "../../core/extensions/types.ts";
import { renderCompletionNotice } from "../completion-notice.ts";
import type { BackgroundTask } from "./registry.ts";

export const renderBackgroundCompletion: MessageRenderer<BackgroundTask> = (message, options, theme) => {
	const task = message.details;
	if (!task || typeof task.name !== "string" || typeof task.status !== "string") return undefined;
	return renderCompletionNotice(
		{
			kind: "Background task",
			title: task.name,
			status: task.status,
			startedAt: task.startedAt,
			finishedAt: task.finishedAt,
			color: task.status === "completed" ? "success" : task.status === "failed" ? "error" : "muted",
			notice: task.error,
			summary: task.description !== task.name ? task.description : undefined,
			details: [
				`Task ID: ${task.id}`,
				`Exit code: ${task.exitCode ?? "none"}`,
				`Command: ${task.command}`,
				`Directory: ${task.cwd}`,
				`Output: ${task.outputPath}`,
			],
		},
		options,
		theme,
	);
};
