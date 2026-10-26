import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_ACTIVITY_EVENT } from "../../src/extensions/background/registry.ts";
import { mergeConfig } from "../../src/extensions/continue-watchdog/config.ts";
import { createLockDecisionController } from "../../src/extensions/continue-watchdog/controller.ts";
import { createObservableAgentHub } from "../../src/extensions/continue-watchdog/hub.ts";
import { createContinueWatchdogExtension } from "../../src/extensions/continue-watchdog/index.ts";
import * as privateDecision from "../../src/extensions/continue-watchdog/private-decision.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";

// The upstream runtime is normally driven by config loading, a cross-process
// idle hub, and a private decision fork. These tests inject the controller so
// only the session opt-in wiring is exercised: default off, explicit enable
// through the command, and a disable that never re-locks on later work.
//
// The idle hub is a process singleton, so one harness owns "main" per process.
describe("bundled continue watchdog", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it.each([undefined, "faux/decision", "other/decision:low"])(
		"uses decision model %s with main-model inheritance when unset",
		async (model) => {
			vi.useFakeTimers();
			const execute = vi.spyOn(privateDecision, "runPrivateDecision").mockResolvedValue({ kind: "cancelled" });
			const controller = createLockDecisionController({ maxContinue: 3 });
			const extensionsResult = await createTestExtensionsResult([
				createContinueWatchdogExtension({
					hub: createObservableAgentHub(),
					controller,
					config: mergeConfig(model === undefined ? {} : { model }).config,
				}),
			]);
			harness = await createHarness({ resourceLoader: createTestResourceLoader({ extensionsResult }) });
			await harness.session.bindExtensions({ mode: "tui", uiContext: createTestUiContext() });
			harness.setResponses([fauxAssistantMessage("done")]);
			await harness.session.prompt("do the work");
			const main = harness.session.model!;
			await harness.session.prompt("/lock-continue-watchdog");
			await vi.advanceTimersByTimeAsync(10_000);

			expect(execute).toHaveBeenCalledOnce();
			expect(execute.mock.calls[0]?.[0].fork.model).toBe(
				model ?? `${main.provider}/${main.id}:${harness.session.thinkingLevel}`,
			);
			expect(harness.session.model).toBe(main);
		},
	);

	it("reads watchdogModel from live settings before each decision", async () => {
		vi.useFakeTimers();
		const execute = vi.spyOn(privateDecision, "runPrivateDecision").mockResolvedValue({ kind: "cancelled" });
		const controller = createLockDecisionController({ maxContinue: 3 });
		const extensionsResult = await createTestExtensionsResult([
			createContinueWatchdogExtension({
				hub: createObservableAgentHub(),
				controller,
				config: mergeConfig({ model: "other/config-model:low" }).config,
			}),
		]);
		harness = await createHarness({ resourceLoader: createTestResourceLoader({ extensionsResult }) });
		await harness.session.bindExtensions({ mode: "tui", uiContext: createTestUiContext() });
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("do the work");

		for (const model of ["faux/settings-model:off", "faux/another-model:low", undefined]) {
			harness.settingsManager.setWatchdogModel(model);
			await harness.session.prompt("/lock-continue-watchdog");
			await vi.advanceTimersByTimeAsync(10_000);
			expect(execute.mock.lastCall?.[0].fork.model).toBe(model ?? "other/config-model:low");
		}
		expect(execute).toHaveBeenCalledTimes(3);
	});

	function notified(notify: ReturnType<typeof vi.fn>, text: string): boolean {
		return notify.mock.calls.some(([message]) => String(message).includes(text));
	}

	function lastStatus(notify: ReturnType<typeof vi.fn>): string {
		const statuses = notify.mock.calls
			.map(([message]) => String(message))
			.filter((message) => message.includes("Continue watchdog status"));
		return statuses[statuses.length - 1] ?? "";
	}

	it("stays disabled until the session enables it, and stays disabled after unlock", async () => {
		const controller = createLockDecisionController({ maxContinue: 3 });
		let bus: { emit(channel: string, data: unknown): void } | undefined;
		const captureBus = (pi: { events: { emit(channel: string, data: unknown): void } }) => {
			bus = pi.events;
		};
		const extensionsResult = await createTestExtensionsResult([
			captureBus,
			createContinueWatchdogExtension({ controller }),
		]);
		harness = await createHarness({ resourceLoader: createTestResourceLoader({ extensionsResult }) });
		const notify = vi.fn();
		await harness.session.bindExtensions({ mode: "tui", uiContext: createTestUiContext({ notify }) });
		harness.setResponses([fauxAssistantMessage("ok")]);

		await harness.session.prompt("/status-continue-watchdog");
		expect(notified(notify, "Session: disabled")).toBe(true);
		expect(notified(notify, "session disabled")).toBe(true);
		expect(controller.snapshot.locked).toBe(false);

		await harness.session.prompt("/lock-continue-watchdog");
		expect(notified(notify, "Continue watchdog locked")).toBe(true);
		expect(controller.snapshot.locked).toBe(true);
		await harness.session.prompt("/status-continue-watchdog");
		expect(notified(notify, "Session: enabled")).toBe(true);
		expect(notified(notify, "Lock: locked")).toBe(true);

		// A running background shell keeps the watchdog from asking: same rule as a
		// live subagent, reported over the extension event bus.
		bus?.emit(BACKGROUND_ACTIVITY_EVENT, { running: 1 });
		await new Promise((resolve) => setTimeout(resolve, 0));
		await harness.session.prompt("/status-continue-watchdog");
		expect(lastStatus(notify)).toContain("background task running");
		bus?.emit(BACKGROUND_ACTIVITY_EVENT, { running: 0 });
		await new Promise((resolve) => setTimeout(resolve, 0));
		await harness.session.prompt("/status-continue-watchdog");
		expect(lastStatus(notify)).not.toContain("background task running");

		await harness.session.prompt("/unlock-continue-watchdog soft test");
		expect(controller.snapshot.locked).toBe(false);

		// Real user work must not silently re-lock a session the user disabled.
		await harness.session.prompt("do the work");
		expect(controller.snapshot.locked).toBe(false);
		await harness.session.prompt("/status-continue-watchdog");
		expect(notified(notify, "Session: disabled")).toBe(true);
		expect(notify.mock.calls.map(([message]) => String(message))).toContainEqual(
			expect.stringContaining("Lock: unlocked"),
		);
	});
});
