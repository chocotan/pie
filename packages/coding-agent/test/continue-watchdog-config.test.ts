import { describe, expect, it } from "vitest";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
import { mergeConfig, validateConfig } from "../src/extensions/continue-watchdog/config.ts";
import { loadRuntimeConfig } from "../src/extensions/continue-watchdog/config-loader.ts";

describe("continue watchdog model configuration", () => {
	it("persists and clears watchdogModel in settings.json without changing other settings", async () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ defaultModel: "main", theme: "dark" }));
		const manager = SettingsManager.fromStorage(storage);
		expect(manager.getWatchdogModel()).toBeUndefined();
		manager.setWatchdogModel("  other/decision:low  ");
		await manager.flush();
		expect(SettingsManager.fromStorage(storage).getWatchdogModel()).toBe("other/decision:low");
		expect(manager.getDefaultModel()).toBe("main");

		manager.setWatchdogModel(undefined);
		await manager.flush();
		const reloaded = SettingsManager.fromStorage(storage);
		expect(reloaded.getWatchdogModel()).toBeUndefined();
		expect(reloaded.getGlobalSettings()).toEqual({ defaultModel: "main", theme: "dark" });
	});

	it.each(["", "  "])("rejects a blank watchdogModel in settings: %j", (model) => {
		const manager = SettingsManager.inMemory();
		expect(() => manager.setWatchdogModel(model)).toThrow("Invalid watchdogModel setting");
	});

	it.each([true, false])("only reads project watchdogModel settings when trusted=%s", (trusted) => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ watchdogModel: "global/model" }));
		storage.withLock("project", () => JSON.stringify({ watchdogModel: "project/model" }));
		const manager = SettingsManager.fromStorage(storage, { projectTrusted: trusted });
		expect(manager.getWatchdogModel()).toBe(trusted ? "project/model" : "global/model");
	});

	it("inherits the main model when unset and trims a configured model", () => {
		expect(mergeConfig().config.model).toBeUndefined();
		expect(validateConfig("global", { model: "  openai/gpt-6-luna:low  " })).toEqual({
			config: { model: "openai/gpt-6-luna:low" },
			diagnostics: [],
		});
	});

	it.each(["", "  ", null, false, 42, [], {}])(
		"rejects invalid model %j without erasing the global model",
		(model) => {
			const result = mergeConfig({ model: "openai/gpt-6-luna:low" }, { model });
			expect(result.config.model).toBe("openai/gpt-6-luna:low");
			expect(result.diagnostics).toEqual([
				{ source: "project", message: "model must be a non-empty model id string", severity: "warning" },
			]);
		},
	);

	it.each([true, false])("only applies a project model when trusted=%s", async (trusted) => {
		const result = await loadRuntimeConfig({
			cwd: "/project",
			agentDir: "/agent",
			trusted,
			io: {
				readFile: async (path) =>
					JSON.stringify({ model: path.startsWith("/agent/") ? "openai/gpt-6-luna:low" : "other/model:off" }),
			},
		});
		expect(result.config.model).toBe(trusted ? "other/model:off" : "openai/gpt-6-luna:low");
		expect(result.diagnostics).toEqual([]);
	});
});
