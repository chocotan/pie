/**
 * Worker command guardrails for the pie superagent.
 *
 * These are PATH shims and git defaults, not an OS security boundary. A worker
 * still runs as the operator and can execute a program by absolute path.
 */
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import type { Deployment } from "../types.ts";
import { SetupError } from "../setup.ts";

const MARKER = "# Written by pie-superagent on every start; edits are lost.";
export const WORKER_COMMANDS: readonly string[] = ["gh", "git", "lark-cli"];
export const workerBin = (stateDir: string): string => join(stateDir, "worker-bin");
export const workerGitConfig = (stateDir: string): string => join(stateDir, "worker-gitconfig");
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const gitQuote = (value: string): string => `"${value.replace(/[\\"]/g, (char) => `\\${char}`)}"`;
export const credentialHelper = (cli: string): string => `!${shellQuote(cli)} auth git-credential`;

export function sameDirectory(a: string, b: string): boolean {
	const real = (path: string): string => {
		try {
			return realpathSync(path);
		} catch {
			return resolve(path);
		}
	};
	return real(a) === real(b);
}

export function withoutDirectory(path: string, dir: string): string {
	return path.split(delimiter).filter((entry) => !sameDirectory(entry, dir)).join(delimiter);
}

export const GIT_LOCATION: readonly string[] = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_PREFIX",
	"GIT_COMMON_DIR",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_NAMESPACE",
];

export function agentVariables(stateDir: string): Record<string, string | undefined> {
	return {
		GH_TOKEN: undefined,
		GITHUB_TOKEN: undefined,
		...Object.fromEntries(GIT_LOCATION.map((name) => [name, undefined])),
		GIT_CONFIG_GLOBAL: workerGitConfig(stateDir),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_COUNT: undefined,
		GIT_CONFIG_PARAMETERS: undefined,
		GIT_ASKPASS: "",
		SSH_ASKPASS: undefined,
		GIT_TERMINAL_PROMPT: "0",
		GIT_AUTHOR_NAME: undefined,
		GIT_COMMITTER_NAME: undefined,
		GIT_AUTHOR_EMAIL: undefined,
		GIT_COMMITTER_EMAIL: undefined,
	};
}

async function written(file: string): Promise<boolean> {
	if (!(await lstat(file)).isFile()) return false;
	return (await readFile(file, "utf8")).split("\n", 2).includes(MARKER);
}

export async function writeEnvironment(
	deployment: Pick<Deployment, "stateDir" | "repository" | "github" | "feishu">,
	blockedCommands: readonly string[],
): Promise<void> {
	const { stateDir, github, feishu } = deployment;
	const dir = workerBin(stateDir);
	await mkdir(dir, { recursive: true });
	const before = await readdir(dir);
	for (const name of before) {
		const file = join(dir, name);
		if (!(await written(file))) throw new SetupError("foreignFile", { file });
	}
	const kept = new Set<string>();
	const shim = async (name: string, body: string): Promise<void> => {
		const temporary = join(dir, `.${name}.${process.pid}.tmp`);
		await writeFile(temporary, `#!/bin/sh\n${MARKER}\n${body}\n`, { mode: 0o755 });
		await rename(temporary, join(dir, name));
		kept.add(name);
	};
	const withoutShims = [
		`self=${shellQuote(dir)}`,
		"rest=",
		"IFS=:",
		"set -f",
		'for entry in $PATH; do [ "$entry" = "$self" ] || rest="${rest:+$rest:}$entry"; done',
		"set +f",
		"unset IFS",
		"PATH=$rest",
		"export PATH",
	].join("\n");
	const run = (program: string): string => `${withoutShims}\nexec ${shellQuote(program)} "$@"`;
	const fail = (message: string): string => `echo ${shellQuote(message)} >&2\nexit 1`;
	await shim("gh", run(github.cli));
	await shim("lark-cli", feishu ? run(feishu.cli) : fail("lark-cli is unavailable: this installation has no Feishu bot."));
	for (const name of new Set(blockedCommands.filter((item) => !WORKER_COMMANDS.includes(item)))) {
		await shim(name, fail(`${name} is blocked in this installation; use gh, which acts as ${github.login}.`));
	}
	for (const name of before) if (!kept.has(name)) await unlink(join(dir, name));
	const config = [
		MARKER,
		"[user]",
		"\tuseConfigOnly = true",
		"[credential]",
		"\thelper =",
		'[credential "https://github.com"]',
		`\thelper = ${gitQuote(credentialHelper(github.cli))}`,
		'[url "https://github.com/"]',
		"\tinsteadOf = git@github.com:",
		"\tinsteadOf = ssh://git@github.com/",
		'[filter "lfs"]',
		"\tclean = git-lfs clean -- %f",
		"\tsmudge = git-lfs smudge -- %f",
		"\tprocess = git-lfs filter-process",
		"\trequired = true",
	].join("\n");
	await writeFile(workerGitConfig(stateDir), `${config}\n`, { mode: 0o644 });
}
