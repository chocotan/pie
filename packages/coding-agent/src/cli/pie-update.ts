import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgentDir, getPackageDir, isBunBinary } from "../config.ts";
import { spawnProcessSync } from "../utils/child-process.ts";

/** Bare app updates must never use the upstream SDK's npm self-updater. Package-specific updates stay separate. */
export function isPieUpdateCommand(args: readonly string[]): boolean {
	return (
		args[0] === "update" &&
		(args.length === 1 || args.includes("--self") || args.slice(1).every((arg) => arg.startsWith("-")))
	);
}

export function runPieUpdate(
	args: readonly string[],
	agentDir = getAgentDir(),
	packageDir = getPackageDir(),
	run = spawnProcessSync,
): number {
	const managed = join(agentDir, "source", "scripts", "install-pie.mjs");
	const source = resolve(packageDir, "..", "..", "scripts", "install-pie.mjs");
	const updater = existsSync(managed) ? managed : existsSync(source) ? source : undefined;
	if (!updater) {
		console.error(
			"No managed Pie updater was found. Run: curl -fsSL https://raw.githubusercontent.com/chocotan/pie/main/scripts/install.sh | bash",
		);
		return 1;
	}
	const flags = args
		.slice(1)
		.filter((arg) => arg !== "--self")
		.map((arg) => (arg === "-h" ? "--help" : arg));
	const result = run(isBunBinary ? "node" : process.execPath, [updater, "--update", ...flags], {
		stdio: "inherit",
		encoding: "utf8",
		env: { ...process.env, PIE_CODING_AGENT_DIR: agentDir },
	});
	if (result.error) {
		console.error(`Pie update failed: ${result.error.message}`);
		return 1;
	}
	return result.status ?? 1;
}
