import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxThinking,
	fauxToolCall,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import type { Settings } from "../../src/core/settings-manager.ts";
import compactModelExtension from "../../src/extensions/compact-model/index.ts";
import {
	createDecisionFoldMessage,
	createDecisionPromptMessage,
} from "../../src/extensions/continue-watchdog/context-fold.ts";
import { projectCompactionPreparation } from "../../src/extensions/continue-watchdog/summary-projection.ts";
import { builtInExtensions } from "../../src/extensions/index.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function setup(compactModel?: unknown, preparationExtension?: ExtensionFactory) {
	const notifications: string[] = [];
	const harness = await createHarness({
		models: [{ id: "main" }, { id: "summary/vendor", reasoning: true }],
		settings: {
			compactModel,
			compaction: { enabled: false, keepRecentTokens: 1 },
			retry: { enabled: true, baseDelayMs: 0, maxRetries: 1 },
			modelThinkingLevels: { "faux/summary/vendor": "low" },
		} as Settings,
		extensionFactories: preparationExtension
			? [preparationExtension, compactModelExtension]
			: [compactModelExtension],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({
		mode: "tui",
		uiContext: createTestUiContext({ notify: (message) => notifications.push(message) }),
	});
	harness.sessionManager.appendMessage({ role: "user", content: "old request", timestamp: Date.now() });
	harness.sessionManager.appendMessage(
		fauxAssistantMessage([fauxToolCall("read", { path: "read.ts" }), fauxToolCall("edit", { path: "edited.ts" })]),
	);
	const keptId = harness.sessionManager.appendMessage({
		role: "user",
		content: "keep this recent request",
		timestamp: Date.now(),
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	return { harness, notifications, keptId };
}

describe("compact-model plugin", () => {
	it("ships as a built-in", () => {
		expect(builtInExtensions.find((extension) => extension.name === "compact-model")).toMatchObject({
			factory: compactModelExtension,
			builtin: true,
		});
	});

	it("uses the configured model without changing the conversation model or retention", async () => {
		const { harness, keptId } = await setup("faux/summary/vendor");
		const response = fauxAssistantMessage("checkpoint");
		harness.setResponses([
			(context, options, _state, model) => {
				expect(model.id).toBe("summary/vendor");
				expect(options).toMatchObject({ apiKey: "faux-key", cacheRetention: "none", reasoning: "low" });
				expect(options?.signal).toBeInstanceOf(AbortSignal);
				expect(JSON.stringify(context)).toContain("Additional focus: preserve decisions");
				expect(JSON.stringify(context)).toContain("old request");
				expect(JSON.stringify(context)).not.toContain("keep this recent request");
				return response;
			},
		]);

		const result = await harness.session.compact("preserve decisions");

		expect(result).toMatchObject({
			firstKeptEntryId: keptId,
			details: { readFiles: ["read.ts"], modifiedFiles: ["edited.ts"], compactModel: "faux/summary/vendor" },
		});
		expect(result.usage?.input).toBeGreaterThan(0);
		expect(harness.sessionManager.getEntries().at(-1)).toMatchObject({ usage: result.usage });
		expect(result.summary).toContain("checkpoint");
		expect(result.summary).toContain("<modified-files>\nedited.ts\n</modified-files>");
		expect(harness.session.model?.id).toBe("main");
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "user", content: "keep this recent request" });
		expect(harness.sessionManager.getEntries().at(-1)).toMatchObject({ type: "compaction", fromHook: true });
	});

	it("keeps prior summaries and cumulative file lists across repeated compactions", async () => {
		const { harness } = await setup("faux/summary/vendor");
		harness.setResponses([fauxAssistantMessage("first checkpoint")]);
		await harness.session.compact();
		harness.sessionManager.appendMessage({ role: "user", content: "new retained request", timestamp: Date.now() });
		harness.setResponses([
			(context) => {
				expect(JSON.stringify(context)).toContain("<previous-summary>\\nfirst checkpoint");
				return fauxAssistantMessage("second checkpoint");
			},
		]);

		const result = await harness.session.compact();

		expect(result.details).toMatchObject({ readFiles: ["read.ts"], modifiedFiles: ["edited.ts"] });
		expect(result.summary).toContain("<read-files>\nread.ts\n</read-files>");
	});

	it.each([null, "faux/unknown", "faux/summary/vendor"])(
		"keeps cumulative file lists when returning to default compaction (%s)",
		async (selected) => {
			const { harness } = await setup("faux/summary/vendor");
			harness.setResponses([fauxAssistantMessage("first checkpoint")]);
			await harness.session.compact();
			harness.sessionManager.appendMessage({ role: "user", content: "new retained request", timestamp: Date.now() });
			harness.settingsManager.applyOverrides({ compactModel: selected });
			harness.setResponses([
				...(selected === "faux/summary/vendor" ? [fauxAssistantMessage("partial", { stopReason: "length" })] : []),
				fauxAssistantMessage("default checkpoint"),
			]);

			const result = await harness.session.compact();

			expect(result.details).toMatchObject({ readFiles: ["read.ts"], modifiedFiles: ["edited.ts"] });
			expect(harness.sessionManager.getEntries().at(-1)).toMatchObject({ fromHook: false });
		},
	);

	it("summarizes after the watchdog removes internal inquiry traffic", async () => {
		const names = builtInExtensions.map((extension) => extension.name);
		expect(names.indexOf("continue-watchdog")).toBeLessThan(names.indexOf("compact-model"));
		const { harness } = await setup("faux/summary/vendor", (pi) => {
			pi.on("session_before_compact", (event) => {
				projectCompactionPreparation(event.preparation, event.branchEntries);
			});
		});
		const prompt = createDecisionPromptMessage({
			exchangeId: "test-inquiry",
			cycleId: 1,
			decisionPrompt: "internal secret",
		});
		harness.sessionManager.appendCustomMessageEntry(
			prompt.customType,
			prompt.content,
			prompt.display,
			prompt.details,
		);
		const fold = createDecisionFoldMessage({ exchangeId: "test-inquiry", cycleId: 1, outcome: "invalidated" });
		harness.sessionManager.appendCustomMessageEntry(fold.customType, fold.content, fold.display, fold.details);
		harness.sessionManager.appendMessage({ role: "user", content: "new retained request", timestamp: Date.now() });
		harness.setResponses([
			(context) => {
				expect(JSON.stringify(context)).toContain("old request");
				expect(JSON.stringify(context)).not.toContain("internal secret");
				return fauxAssistantMessage("checkpoint");
			},
		]);
		await harness.session.compact();
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("uses the same model for history and split-turn prefix summaries", async () => {
		const { harness } = await setup("faux/summary/vendor");
		harness.sessionManager.appendMessage(fauxAssistantMessage("recent assistant response"));
		const requestedModels: string[] = [];
		harness.setResponses([
			(_context, _options, _state, model) => {
				requestedModels.push(model.id);
				return fauxAssistantMessage("history checkpoint");
			},
			(_context, _options, _state, model) => {
				requestedModels.push(model.id);
				return fauxAssistantMessage("turn prefix checkpoint");
			},
		]);

		const result = await harness.session.compact();

		expect(requestedModels).toEqual(["summary/vendor", "summary/vendor"]);
		expect(result.summary).toContain("history checkpoint");
		expect(result.summary).toContain("turn prefix checkpoint");
	});

	it.each(["threshold", "overflow"] as const)("handles automatic %s compaction", async (reason) => {
		const { harness } = await setup("faux/summary/vendor");
		harness.setResponses([
			(_context, _options, _state, model) => {
				expect(model.id).toBe("summary/vendor");
				return fauxAssistantMessage("automatic checkpoint");
			},
		]);
		const session = harness.session as unknown as {
			_runAutoCompaction: (reason: "threshold" | "overflow", willRetry: boolean) => Promise<boolean>;
		};

		await expect(session._runAutoCompaction(reason, false)).resolves.toBe(false);
		expect(harness.eventsOfType("compaction_end").at(-1)?.result?.summary).toContain("automatic checkpoint");
	});

	it.each([null, undefined])("leaves default compaction active when compactModel is %s", async (selected) => {
		const { harness, notifications } = await setup(selected);
		harness.setResponses([
			(_context, _options, _state, model) => {
				expect(model.id).toBe("main");
				return fauxAssistantMessage("default checkpoint");
			},
		]);
		await harness.session.compact();
		expect(notifications).toEqual([]);
		expect(harness.sessionManager.getEntries().at(-1)).toMatchObject({ fromHook: false });
	});

	it.each(["missing-model", "faux/unknown", "faux/", 123, { model: "faux/main" }])(
		"warns and falls back for an invalid or unknown selection: %j",
		async (selected) => {
			const { harness, notifications } = await setup(selected);
			harness.setResponses([fauxAssistantMessage("default checkpoint")]);
			const result = await harness.session.compact();
			expect(result.summary).toContain("default checkpoint");
			expect(notifications.some((message) => message.includes("using default compaction"))).toBe(true);
			expect(harness.sessionManager.getEntries().at(-1)).toMatchObject({ fromHook: false });
		},
	);

	it.each([
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid api key" }),
		fauxAssistantMessage("partial checkpoint", { stopReason: "length" }),
		fauxAssistantMessage("   "),
		fauxAssistantMessage(fauxThinking("no visible checkpoint")),
		fauxAssistantMessage(fauxToolCall("read", { path: "x" }), { stopReason: "toolUse" }),
	])("falls back instead of saving a failed, incomplete, or empty summary ($stopReason)", async (response) => {
		const { harness, notifications } = await setup("faux/summary/vendor");
		const requestedModels: string[] = [];
		harness.setResponses([
			(_context, _options, _state, model) => {
				requestedModels.push(model.id);
				return response;
			},
			(_context, _options, _state, model) => {
				requestedModels.push(model.id);
				return fauxAssistantMessage("default checkpoint");
			},
		]);
		const result = await harness.session.compact();
		expect(result.summary).toContain("default checkpoint");
		expect(requestedModels).toEqual(["summary/vendor", "main"]);
		expect(notifications.some((message) => message.includes("using default compaction"))).toBe(true);
	});

	it("resolves the summary provider's own authentication", async () => {
		const { harness } = await setup("summary-provider/summary");
		const model = { ...harness.getModel(), provider: "summary-provider", id: "summary" };
		harness.session.modelRuntime.registerNativeProvider({
			id: model.provider,
			name: "Summary provider",
			auth: {
				apiKey: {
					name: "Summary token",
					resolve: async () => ({ auth: { apiKey: "summary-key" }, source: "test" }),
				},
			},
			getModels: () => [model],
			stream: () => createAssistantMessageEventStream(),
			streamSimple: (requested, _context, options) => {
				expect(requested.provider).toBe("summary-provider");
				expect(options?.apiKey).toBe("summary-key");
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() =>
					stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("checkpoint") }),
				);
				return stream;
			},
		});
		await expect(harness.session.compact()).resolves.toMatchObject({
			summary: expect.stringContaining("checkpoint"),
		});
	});

	it("retries transient errors on the configured model", async () => {
		const { harness, notifications } = await setup("faux/summary/vendor");
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" }),
			fauxAssistantMessage("retried checkpoint"),
		]);
		const result = await harness.session.compact();
		expect(result.summary).toContain("retried checkpoint");
		expect(harness.faux.state.callCount).toBe(2);
		expect(notifications.some((message) => message.includes("using default compaction"))).toBe(false);
	});

	it("cancels an in-flight request without falling back or appending a checkpoint", async () => {
		const { harness, notifications } = await setup("faux/summary/vendor");
		let markStarted = () => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		let requestOptions: SimpleStreamOptions | undefined;
		harness.setResponses([
			async (_context, options) => {
				requestOptions = options;
				markStarted();
				await new Promise<void>((resolve) =>
					options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
				);
				return fauxAssistantMessage("", { stopReason: "aborted" });
			},
		]);
		const result = harness.session.compact();
		const rejected = expect(result).rejects.toThrow("Compaction cancelled");
		await started;
		harness.session.abortCompaction();
		await rejected;
		expect(requestOptions?.signal?.aborted).toBe(true);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
		expect(notifications.some((message) => message.includes("using default compaction"))).toBe(false);
	});
});
