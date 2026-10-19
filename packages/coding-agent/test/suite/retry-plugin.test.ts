import { type FauxResponseFactory, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { builtInExtensions } from "../../src/extensions/index.ts";
import retryExtension from "../../src/extensions/retry/index.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";

/** Instant, capped backoff so the plugin's schedule is testable without waiting. */
const FAST = { baseDelayMs: 0, maxDelayMs: 0, multiplier: 1, maxRetriesAtMaxDelay: 3 };
/** Keep native retry fast in tests that exercise the hand-over. */
const NATIVE_FAST = { baseDelayMs: 1, maxRetries: 3 };

const harnesses: Harness[] = [];
async function setup(
	responses: Parameters<Harness["setResponses"]>[0],
	options: {
		pieRetry?: Record<string, unknown>;
		retryEnabled?: boolean;
		nativeRetry?: Record<string, unknown>;
		compaction?: boolean;
	} = {},
) {
	const notifications: string[] = [];
	const harness = await createHarness({
		extensionFactories: [retryExtension],
		settings: {
			retry: { enabled: options.retryEnabled ?? false, ...options.nativeRetry },
			compaction: { enabled: options.compaction ?? false },
			pieRetry: options.pieRetry ?? FAST,
		} as never,
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({
		mode: "tui",
		uiContext: createTestUiContext({ notify: (message) => notifications.push(message) }),
	});
	harness.setResponses(responses);
	return { harness, notifications };
}

function afterAllCleanup() {
	for (const harness of harnesses.splice(0)) harness.cleanup();
}
describe("retry plugin", () => {
	it("ships as a replaceable built-in and registers /retry", async () => {
		expect(builtInExtensions.find((extension) => extension.name === "retry")).toMatchObject({
			factory: retryExtension,
			replaceable: true,
			builtin: true,
		});
		const harness = await createHarness({ extensionFactories: [retryExtension] });
		harnesses.push(harness);
		try {
			await harness.session.bindExtensions({ mode: "tui", uiContext: createTestUiContext() });
			expect(harness.session.extensionRunner.getCommand("retry")?.description).toContain("/retry status");
		} finally {
			afterAllCleanup();
		}
	});

	it("retries an unknown provider error and omits the failed response from the model context", async () => {
		const requests: string[] = [];
		const first: FauxResponseFactory = (context) => {
			requests.push(JSON.stringify(context.messages));
			return fauxAssistantMessage("", { stopReason: "error", errorMessage: "mystery provider failure" });
		};
		const second: FauxResponseFactory = (context) => {
			requests.push(JSON.stringify(context.messages));
			return fauxAssistantMessage("recovered");
		};
		const { harness, notifications } = await setup([first, second]);
		try {
			await harness.session.prompt("do the thing");
			expect(harness.faux.state.callCount).toBe(2);
			expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
			// The retry re-asks the same request; the failed attempt is never sent.
			expect(requests[1]).not.toContain("mystery provider failure");
			expect(requests[1]).toContain("do the thing");
			// The failed attempt stays in raw history for the transcript.
			expect(JSON.stringify(harness.sessionManager.getEntries())).toContain("mystery provider failure");
			expect(
				harness.sessionManager
					.getEntries()
					.some((entry) => entry.type === "context_edit" && entry.replacement === null),
			).toBe(true);
			expect(notifications.some((message) => message.includes("Retrying after other error"))).toBe(true);
			afterAllCleanup();
		} finally {
			afterAllCleanup();
		}
	});

	it("does not retry permanent, quota, or context-overflow errors", async () => {
		const cases = [
			{ message: "invalid api key provided", expected: "Non-retryable error" },
			{ message: "You have hit your limit · resets 4pm", expected: "Quota or budget exhausted" },
			{ message: "prompt is too long: 300000 tokens", expected: "Context overflow" },
		];
		for (const testCase of cases) {
			const { harness, notifications } = await setup([
				fauxAssistantMessage("", { stopReason: "error", errorMessage: testCase.message }),
			]);
			await harness.session.prompt("do the thing");
			expect(harness.faux.state.callCount).toBe(1);
			expect(notifications.some((message) => message.includes(testCase.expected))).toBe(true);
			expect(harness.sessionManager.getEntries().some((entry) => entry.type === "context_edit")).toBe(false);
			afterAllCleanup();
		}
	});

	it("continues a response cut off at the output limit and a turn with no usable output", async () => {
		const continuation = await setup([
			fauxAssistantMessage("half a sen", { stopReason: "length" }),
			fauxAssistantMessage("tence."),
		]);
		await continuation.harness.session.prompt("write it");
		expect(continuation.harness.faux.state.callCount).toBe(2);
		expect(continuation.notifications.some((message) => message.includes("Output limit reached"))).toBe(true);
		expect(
			continuation.harness.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom_message" && entry.customType === "pie.retry-continue"),
		).toBe(true);
		afterAllCleanup();

		const empty = await setup([
			fauxAssistantMessage([{ type: "thinking", thinking: "only thinking" }], { stopReason: "stop" }),
			fauxAssistantMessage("real answer"),
		]);
		await empty.harness.session.prompt("answer me");
		expect(empty.harness.faux.state.callCount).toBe(2);
		expect(empty.notifications.some((message) => message.includes("Empty response"))).toBe(true);
		expect(empty.harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
		afterAllCleanup();

		// An empty turn that stays empty is nudged only once.
		const stubborn = await setup([
			fauxAssistantMessage([], { stopReason: "stop" }),
			fauxAssistantMessage([], { stopReason: "stop" }),
		]);
		await stubborn.harness.session.prompt("answer me");
		expect(stubborn.harness.faux.state.callCount).toBe(2);
		expect(stubborn.notifications.some((message) => message.includes("giving up"))).toBe(true);
		afterAllCleanup();
	});

	it("gives up after the configured number of retries at the maximum delay", async () => {
		const { harness, notifications } = await setup([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "connection reset by peer" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "connection reset by peer" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "connection reset by peer" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "connection reset by peer" }),
		]);
		await harness.session.prompt("do the thing");
		expect(harness.faux.state.callCount).toBe(4);
		expect(notifications.some((message) => message.includes("Retry failed 3 times at the maximum backoff"))).toBe(
			true,
		);
		afterAllCleanup();
	});

	it("honors a smaller retry budget", async () => {
		const capped = await setup(
			[
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "connection reset by peer" }),
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "connection reset by peer" }),
				fauxAssistantMessage("should not be requested"),
			],
			{ pieRetry: { ...FAST, maxRetriesAtMaxDelay: 1 } },
		);
		await capped.harness.session.prompt("do the thing");
		expect(capped.harness.faux.state.callCount).toBe(2);
		afterAllCleanup();
	});

	it("can disable output-limit continuations and empty-response nudges", async () => {
		const settings = { pieRetry: { ...FAST, retryContinuations: false, retryEmptyStop: false } };
		const truncated = await setup([fauxAssistantMessage("half", { stopReason: "length" })], settings);
		await truncated.harness.session.prompt("write it");
		expect(truncated.harness.faux.state.callCount).toBe(1);
		expect(truncated.notifications.some((message) => message.includes("Output limit reached"))).toBe(false);
		afterAllCleanup();

		const empty = await setup([fauxAssistantMessage([], { stopReason: "stop" })], settings);
		await empty.harness.session.prompt("answer me");
		expect(empty.harness.faux.state.callCount).toBe(1);
		afterAllCleanup();

		// The catch-all error retry stays available; only continuations are optional.
		const error = await setup(
			[
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "connection reset by peer" }),
				fauxAssistantMessage("recovered"),
			],
			settings,
		);
		await error.harness.session.prompt("do the thing");
		expect(error.harness.faux.state.callCount).toBe(2);
		afterAllCleanup();
	});

	it("hands over from native retry without retrying the same failure twice", async () => {
		// Native retry owns `overloaded_error` while it is enabled, so the plugin
		// must not also run a backoff over the same failure.
		const nativeOwned = await setup(
			[
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
				fauxAssistantMessage("native retry recovered"),
			],
			{ retryEnabled: true, nativeRetry: NATIVE_FAST },
		);
		await nativeOwned.harness.session.prompt("do the thing");
		expect(nativeOwned.harness.faux.state.callCount).toBe(2);
		expect(nativeOwned.harness.eventsOfType("auto_retry_start")).toHaveLength(1);
		// Only native retry acted; the plugin reported nothing of its own.
		expect(nativeOwned.notifications.some((message) => message.includes("Retrying after"))).toBe(false);
		afterAllCleanup();

		// An error native retry does not classify still goes straight to the plugin.
		const unknown = await setup(
			[
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "mystery provider failure" }),
				fauxAssistantMessage("plugin retry recovered"),
			],
			{ retryEnabled: true },
		);
		await unknown.harness.session.prompt("do the thing");
		expect(unknown.harness.faux.state.callCount).toBe(2);
		expect(unknown.harness.eventsOfType("auto_retry_start")).toEqual([]);
		expect(unknown.notifications.some((message) => message.includes("Retrying after other error"))).toBe(true);
		afterAllCleanup();

		// With native retry off, the plugin also covers the errors native would have.
		const nativeOff = await setup(
			[
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
				fauxAssistantMessage("plugin retry recovered"),
			],
			{ retryEnabled: false },
		);
		await nativeOff.harness.session.prompt("do the thing");
		expect(nativeOff.harness.faux.state.callCount).toBe(2);
		expect(nativeOff.harness.eventsOfType("auto_retry_start")).toEqual([]);
		expect(nativeOff.harness.sessionManager.getEntries().some((entry) => entry.type === "context_edit")).toBe(true);
		afterAllCleanup();
	});

	it("leaves a persistently native-retryable error to native retry's own budget", async () => {
		const failing = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" });
		const { harness, notifications } = await setup(
			[failing(), failing(), failing(), failing(), failing(), failing()],
			{
				retryEnabled: true,
				nativeRetry: NATIVE_FAST,
			},
		);
		await harness.session.prompt("do the thing");
		// 1 initial attempt plus native retry's 3 attempts, with no second schedule.
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(3);
		expect(harness.faux.state.callCount).toBe(4);
		expect(notifications.some((message) => message.includes("Retrying after"))).toBe(false);
		afterAllCleanup();
	});

	it("reports status, resets counters, and retries manually with one hidden message", async () => {
		const { harness, notifications } = await setup([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid api key" }),
			fauxAssistantMessage("after manual retry"),
		]);
		const ctx = harness.session.extensionRunner.createCommandContext();
		const command = harness.session.extensionRunner.getCommand("retry")!;
		try {
			await harness.session.prompt("do the thing");
			expect(harness.faux.state.callCount).toBe(1);

			await command.handler("status", ctx);
			expect(notifications.some((message) => message.includes("=== Pie retry status ==="))).toBe(true);

			await command.handler("reset", ctx);
			expect(notifications.some((message) => message.includes("Retry counters reset"))).toBe(true);

			await command.handler("", ctx);
			expect(notifications.some((message) => message.includes("Non-retryable error"))).toBe(true);

			// A quota error is refused manually too.
			await command.handler("status", ctx);
			await command.handler("", ctx);
			expect(harness.faux.state.callCount).toBe(1);
		} finally {
			afterAllCleanup();
		}
	});

	it("cancels a pending backoff when new input arrives", async () => {
		const statuses: string[] = [];
		const slow: FauxResponseFactory = () =>
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "fetch failed" });
		const harness = await createHarness({
			extensionFactories: [retryExtension],
			settings: {
				retry: { enabled: false },
				compaction: { enabled: false },
				pieRetry: { ...FAST, baseDelayMs: 5000, maxDelayMs: 5000 },
			} as never,
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			mode: "tui",
			uiContext: createTestUiContext({
				setStatus: (_key, text) => {
					if (text) statuses.push(text);
				},
			}),
		});
		harness.setResponses([slow, fauxAssistantMessage("after input")]);
		try {
			const prompt = harness.session.prompt("do the thing");
			// Wait until the plugin owns an in-flight backoff, not merely a retry.
			await vi.waitFor(() => expect(statuses.some((text) => text.includes("retry 1 in"))).toBe(true));
			await harness.session.prompt("stop that", { streamingBehavior: "followUp" });
			await prompt;
			// The queued input superseded the retry, so no omitted response and no second request.
			expect(harness.sessionManager.getEntries().some((entry) => entry.type === "context_edit")).toBe(false);
			expect(harness.faux.state.callCount).toBe(2);
			expect(JSON.stringify(harness.session.messages)).toContain("stop that");
		} finally {
			afterAllCleanup();
		}
	});
});
