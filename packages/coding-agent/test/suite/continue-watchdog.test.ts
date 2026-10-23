import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_ACTIVITY_EVENT } from "../../src/extensions/background/registry.ts";
import { createLockDecisionController } from "../../src/extensions/continue-watchdog/controller.ts";
import { createContinueWatchdogExtension } from "../../src/extensions/continue-watchdog/index.ts";
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
