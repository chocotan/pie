import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgentDir, getPackageDir, isBunBinary } from "../config.ts";
import { spawnProcessSync } from "../utils/child-process.ts";

/**
 * Flags that select a package-manager update target or behavior. The Pie installer
 * only rebuilds the app itself, so these must reach the package manager instead
 * of being forwarded to the installer, which rejects them.
 */
const PACKAGE_UPDATE_FLAGS = new Set([
	"--extensions",
	"--models",
	"--all",
	"--extension",
	// The installer cannot replace a runtime it may still be loading from, so
	// `--force` keeps its package-manager meaning (npm reinstall, or a clear
	// rejection on a managed install).
	"--force",
	"--approve",
	"-a",
	"--no-approve",
	"-na",
]);

/** Bare app updates must never use the upstream SDK's npm self-updater. Package-specific updates stay separate. */
export function isPieUpdateCommand(args: readonly string[]): boolean {
	if (args[0] !== "update" || args.some((arg) => PACKAGE_UPDATE_FLAGS.has(arg))) return false;
	return args.length === 1 || args.includes("--self") || args.slice(1).every((arg) => arg.startsWith("-"));
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
