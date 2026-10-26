import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isPieUpdateCommand, runPieUpdate } from "../src/cli/pie-update.ts";

describe("Pie source updater", () => {
	it("routes app updates separately from extension package updates", () => {
		for (const args of [["update"], ["update", "--self"], ["update", "--help"]])
			expect(isPieUpdateCommand(args)).toBe(true);
		// Package-manager targets and flags must reach the package manager: the
		// installer only rebuilds the app and rejects them.
		for (const args of [
			["update", "--extensions"],
			["update", "--models"],
			["update", "--all"],
			["update", "--extension", "npm:an-extension"],
			["update", "--force"],
			["update", "--approve"],
			["update", "npm:an-extension"],
			["install", "npm:an-extension"],
		])
			expect(isPieUpdateCommand(args)).toBe(false);
	});
	it("runs the managed installer directly with the Pie root and propagates its result", () => {
		const root = mkdtempSync(join(tmpdir(), "pie-update-"));
		try {
			const scripts = join(root, "source", "scripts");
			mkdirSync(scripts, { recursive: true });
			const record = join(root, "args.json");
			writeFileSync(
				join(scripts, "install-pie.mjs"),
				`import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), root: process.env.PIE_CODING_AGENT_DIR })); process.exitCode=17;`,
			);
			expect(runPieUpdate(["update", "--self", "--help"], root, join(root, "package"))).toBe(17);
			expect(JSON.parse(readFileSync(record, "utf8"))).toEqual({ args: ["--update", "--help"], root });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
