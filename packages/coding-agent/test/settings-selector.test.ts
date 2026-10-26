import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

describe("SettingsSelectorComponent", () => {
	let harness: Harness | undefined;
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("cycles through fullscreen settings", () => {
		const onExitOutputChange = vi.fn();
		const onScrollbarChange = vi.fn();
		const onCopyOnSelectChange = vi.fn();
		const onWheelScrollLinesChange = vi.fn();
		const config = {
			fullscreenExitOutput: "transcript",
			fullscreenScrollbar: "auto",
			fullscreenCopyOnSelect: true,
			fullscreenWheelScrollLines: 7,
			warnings: {},
			defaultModel: "not set",
			availableDefaultModels: [],
			availableThinkingLevels: [],
			modelThinkingLevels: {},
			availableThemes: [],
		} as unknown as SettingsConfig;
		const callbacks = {
			onFullscreenExitOutputChange: onExitOutputChange,
			onFullscreenScrollbarChange: onScrollbarChange,
			onFullscreenCopyOnSelectChange: onCopyOnSelectChange,
			onFullscreenWheelScrollLinesChange: onWheelScrollLinesChange,
		} as unknown as SettingsCallbacks;

		const cycle = (label: string, count: number) => {
			const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();
			for (const character of label) list.handleInput(character);
			for (let i = 0; i < count; i++) list.handleInput("\r");
		};

		cycle("Fullscreen exit output", 2);
		expect(onExitOutputChange.mock.calls.flat()).toEqual(["resume-hint", "transcript"]);
		cycle("Fullscreen scrollbar", 3);
		expect(onScrollbarChange.mock.calls.flat()).toEqual(["always", "hidden", "auto"]);
		cycle("Fullscreen copy on select", 2);
		expect(onCopyOnSelectChange.mock.calls.flat()).toEqual([false, true]);
		// #9758: custom values from settings.json stay in the cycle.
		cycle("Fullscreen wheel scrolling", 3);
		expect(onWheelScrollLinesChange.mock.calls.flat()).toEqual([10, "auto", 1]);
	});

	it("selects and clears the watchdog model without changing the main model", async () => {
		harness = await createHarness({ models: [{ id: "main" }, { id: "watchdog" }] });
		const main = harness.session.model;
		const onWatchdogModelChange = vi.fn((model: string | undefined) => {
			harness!.settingsManager.setWatchdogModel(model);
		});
		const config = {
			defaultModel: "not set",
			availableDefaultModels: harness.models,
			modelThinkingLevels: {},
		} as unknown as SettingsConfig;
		const callbacks = { onWatchdogModelChange } as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();
		for (const key of "Watchdog model") list.handleInput(key);
		list.handleInput("\r");
		for (const key of "watchdog") list.handleInput(key);
		list.handleInput("\x1b");
		expect(onWatchdogModelChange).not.toHaveBeenCalled();

		list.handleInput("\r");
		for (const key of "watchdog") list.handleInput(key);
		list.handleInput("\r");
		expect(onWatchdogModelChange).toHaveBeenLastCalledWith("faux/watchdog");
		expect(harness.settingsManager.getWatchdogModel()).toBe("faux/watchdog");
		expect(stripAnsi(list.render(120).join("\n"))).toContain("faux/watchdog");

		list.handleInput("\r");
		for (const key of "Default") list.handleInput(key);
		list.handleInput("\r");
		expect(onWatchdogModelChange).toHaveBeenLastCalledWith(undefined);
		expect(harness.settingsManager.getWatchdogModel()).toBeUndefined();
		expect(harness.session.model).toBe(main);
	});

	it("keeps a configured watchdog model with a thinking suffix selectable when unavailable", () => {
		const onWatchdogModelChange = vi.fn();
		const config = {
			defaultModel: "not set",
			watchdogModel: "other/decision:low",
			availableDefaultModels: [],
			modelThinkingLevels: {},
		} as unknown as SettingsConfig;
		const list = new SettingsSelectorComponent(config, {
			onWatchdogModelChange,
		} as unknown as SettingsCallbacks).getSettingsList();
		list.selectItem("watchdog-model");
		list.handleInput("\r");
		expect(stripAnsi(list.render(120).join("\n"))).toContain("other/decision:low");
		list.handleInput("\r");
		expect(onWatchdogModelChange).toHaveBeenCalledWith("other/decision:low");
	});

	it("cycles through share destinations", () => {
		const onSessionShareDestinationChange = vi.fn();
		const config = {
			sessionShareDestination: "auto",
			warnings: {},
			defaultModel: "not set",
			availableDefaultModels: [],
			availableThinkingLevels: [],
			modelThinkingLevels: {},
			availableThemes: [],
		} as unknown as SettingsConfig;
		const callbacks = {
			onSessionShareDestinationChange,
		} as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();
		list.selectItem("share-destination");

		for (let i = 0; i < 3; i++) list.handleInput("\r");

		expect(onSessionShareDestinationChange.mock.calls.flat()).toEqual(["gist", "radius", "auto"]);
	});

	it("selects, persists, and clears the compaction model through its searchable submenu", async () => {
		harness = await createHarness({ models: [{ id: "main" }, { id: "summary/vendor" }] });
		const manager = harness.settingsManager;
		const config = {
			compactModel: manager.getCompactModel(),
			defaultModel: "not set",
			availableDefaultModels: harness.models,
			modelThinkingLevels: {},
		} as unknown as SettingsConfig;
		const onCompactModelChange = vi.fn((model: string | null) => manager.setCompactModel(model));
		const callbacks = { onCompactModelChange } as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();
		for (const character of "Compaction model") list.handleInput(character);
		list.handleInput("\r");
		for (const character of "summary/vendor") list.handleInput(character);
		list.handleInput("\r");
		await manager.flush();
		await manager.reload();
		expect(manager.getCompactModel()).toBe("faux/summary/vendor");
		expect(stripAnsi(list.render(120).join("\n"))).toContain("faux/summary/vendor");

		list.handleInput("\r");
		list.handleInput("\x1b[A");
		list.handleInput("\x1b[A");
		list.handleInput("\r");
		await manager.flush();
		await manager.reload();
		expect(manager.getCompactModel()).toBeNull();
		expect(onCompactModelChange.mock.calls.flat()).toEqual(["faux/summary/vendor", null]);
	});

	it("can clear an unavailable compaction model and cancel without saving", () => {
		const onCompactModelChange = vi.fn();
		const config = {
			compactModel: "missing/model",
			defaultModel: "not set",
			availableDefaultModels: [],
			modelThinkingLevels: {},
		} as unknown as SettingsConfig;
		const list = new SettingsSelectorComponent(config, {
			onCompactModelChange,
		} as unknown as SettingsCallbacks).getSettingsList();
		list.selectItem("compact-model");
		list.handleInput("\r");
		expect(stripAnsi(list.render(120).join("\n"))).toContain("Currently unavailable");
		list.handleInput("\x1b");
		expect(onCompactModelChange).not.toHaveBeenCalled();
		list.handleInput("\r");
		list.handleInput("\x1b[A");
		list.handleInput("\r");
		expect(onCompactModelChange).toHaveBeenCalledExactlyOnceWith(null);
	});

	it("keeps the configured fixed theme marked while browsing", () => {
		const config = {
			defaultModel: "not set",
			availableDefaultModels: [],
			modelThinkingLevels: {},
			currentTheme: "dark",
			terminalTheme: "dark",
			availableThemes: ["system", "dark", "light"],
			warnings: {},
		} as unknown as SettingsConfig;
		const callbacks = { onThemePreview: vi.fn(), onCancel: () => {} } as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();

		list.selectItem("theme");
		list.handleInput("\r");
		let output = stripAnsi(list.render(120).join("\n"));
		expect(output).toMatch(
			/ {4}system +Theme created from your terminal's colors\n {4}automatic +Use separate themes/,
		);
		expect(output).toContain("→ ✓ dark");

		list.handleInput("\x1b[B");
		output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("  ✓ dark");
		expect(output).toContain("→   light");
	});

	it("keeps a configured automatic theme marked while browsing", () => {
		const config = {
			defaultModel: "not set",
			availableDefaultModels: [],
			modelThinkingLevels: {},
			currentTheme: "light/dark",
			terminalTheme: "dark",
			availableThemes: ["dark", "light", "other"],
			warnings: {},
		} as unknown as SettingsConfig;
		const callbacks = { onThemePreview: vi.fn(), onCancel: () => {} } as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();

		list.selectItem("theme");
		list.handleInput("\r");
		list.handleInput("\r");
		let output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("→ ✓ light");

		list.handleInput("\x1b[B");
		output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("  ✓ light");
		expect(output).toContain("→   other");
	});

	it("keeps the configured per-model thinking level marked while browsing", async () => {
		harness = await createHarness({
			models: [{ id: "thinking-model", reasoning: true }],
		});
		const model = harness.getModel("thinking-model")!;
		const modelKey = `${model.provider}/${model.id}`;
		const config = {
			defaultModel: modelKey,
			availableDefaultModels: [model],
			thinkingLevel: "high",
			modelThinkingLevels: { [modelKey]: "medium" },
		} as unknown as SettingsConfig;
		const callbacks = { onCancel: () => {} } as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();

		list.selectItem("model-thinking");
		list.handleInput("\r");
		list.handleInput("\r");

		let output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("→ ✓ medium");
		expect(output).toContain("    (clear override)");

		list.handleInput("\x1b[B");
		output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("  ✓ medium");
		expect(output).toContain("→   high");
	});
});
