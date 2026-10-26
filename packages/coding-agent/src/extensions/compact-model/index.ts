import { contentText } from "@earendil-works/pi-ai";
import { compact, computeFileLists } from "../../core/compaction/index.ts";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { SETTINGS_DEFAULTS } from "../../core/settings-defaults.ts";

export default function compactModelExtension(pi: ExtensionAPI): void {
	pi.on("session_before_compact", async (event, ctx) => {
		// Core skips hook-generated file lists; restore ours for both custom and default compaction.
		const fileOps = event.preparation.fileOps;
		const previous = event.branchEntries.findLast((entry) => entry.type === "compaction");
		const details = previous?.details;
		if (
			previous?.fromHook &&
			details &&
			typeof details === "object" &&
			"compactModel" in details &&
			typeof details.compactModel === "string"
		) {
			for (const [files, target] of [
				["readFiles" in details ? details.readFiles : undefined, fileOps.read],
				["modifiedFiles" in details ? details.modifiedFiles : undefined, fileOps.edited],
			] as const) {
				if (!Array.isArray(files)) continue;
				for (const file of files) {
					if (typeof file === "string") target.add(file);
				}
			}
		}

		const settings = pi.getSettings();
		const selected: unknown = settings.compactModel;
		if (selected === undefined || selected === null) return;

		try {
			if (typeof selected !== "string") throw new Error('compactModel must be "provider/modelId" or null');
			const match = /^([^/\s]+)\/(\S+)$/.exec(selected);
			if (!match) throw new Error('compactModel must be "provider/modelId" or null');
			const model = ctx.modelRegistry.find(match[1], match[2]);
			if (!model) throw new Error(`Unknown compaction model: ${selected}`);
			if (event.signal.aborted) return { cancel: true };

			ctx.ui.notify(`Compacting with ${selected}`, "info");
			const result = await compact(
				event.preparation,
				model,
				undefined,
				undefined,
				event.customInstructions,
				event.signal,
				settings.modelThinkingLevels?.[selected] ?? ctx.thinkingLevel,
				async (requestModel, context, options) => {
					const stream = ctx.modelRegistry.streamSimple(requestModel, context, options);
					const response = await stream.result();
					if (response.stopReason === "aborted") throw new Error("Compaction request aborted");
					if (
						response.stopReason !== "error" &&
						response.stopReason !== "length" &&
						!contentText(response.content).trim()
					) {
						throw new Error("Compaction returned an empty summary");
					}
					return stream;
				},
				undefined,
				{ ...SETTINGS_DEFAULTS.retry, ...settings.retry },
			);
			if (event.signal.aborted) return { cancel: true };
			return { compaction: { ...result, details: { ...computeFileLists(fileOps), compactModel: selected } } };
		} catch (error) {
			if (event.signal.aborted) return { cancel: true };
			ctx.ui.notify(
				`Compaction model failed; using default compaction: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
			return;
		}
	});
}
