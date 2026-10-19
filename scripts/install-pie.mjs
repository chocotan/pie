#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync,
	rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const repository = "https://github.com/chocotan/pie.git";
const defaultRef = "main";
const packageName = "@earendil-works/pi-coding-agent";

async function downloadCatalog(url) {
	const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
	if (!response.ok) throw new Error(`Model catalog download failed: HTTP ${response.status}`);
	return Buffer.from(await response.arrayBuffer());
}

// Dependencies are injectable so tests never install packages or use the network.
export async function installPie(args, {
	env = process.env,
	run = execFileSync,
	download = downloadCatalog,
	localDirectory = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
} = {}) {
	const { values } = parseArgs({
		args,
		options: {
			local: { type: "boolean", default: false },
			update: { type: "boolean", default: false },
			"bin-dir": { type: "string" },
			ref: { type: "string" },
			help: { type: "boolean", default: false },
		},
	});
	if (values.help) {
		console.log(`Usage: scripts/install.sh [--local] [--ref <branch>] [--bin-dir <directory>]
       scripts/update.sh [--bin-dir <directory>]

Requires Git, npm and Node.js >=22.19.0 on Linux/macOS.
Builds a managed checkout of ${repository} (${defaultRef}).
--local clones this repository locally instead of downloading Git objects.
PIE_CODING_AGENT_DIR overrides ~/.pie; PIE_INSTALL_BIN_DIR overrides ~/.local/bin.
Updates require a clean managed checkout and only fast-forward its recorded branch.
Existing configuration is never imported or overwritten. Prior runtimes are retained.`);
		return;
	}
	const [major, minor] = process.versions.node.split(".").map(Number);
	if (major < 22 || (major === 22 && minor < 19)) throw new Error("Pie requires Node.js >=22.19.0");
	if (process.platform === "win32") throw new Error("Use these installers on Linux/macOS");
	if (values.local && values.update) throw new Error("--local cannot be combined with --update");
	const home = env.HOME || homedir();
	const root = resolve(env.PIE_CODING_AGENT_DIR || join(home, ".pie"));
	const source = join(root, "source");
	const runtimes = join(root, "runtime");
	const metadataPath = join(root, "installation.json");
	const command = (file, argv, cwd = source, capture = false) => run(file, argv, {
		cwd,
		env: { ...env, npm_config_ignore_scripts: "true" },
		encoding: "utf8",
		stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
	});
	const git = (argv, cwd = source) => String(command("git", argv, cwd, true)).trim();
	const clean = (directory) => {
		if (git(["status", "--porcelain", "--untracked-files=all"], directory)) {
			throw new Error(`Source checkout is dirty; commit or move your changes before retrying: ${directory}`);
		}
	};
	mkdirSync(root, { recursive: true });
	const lock = join(root, ".install-lock");
	try {
		mkdirSync(lock);
	} catch (error) {
		if (error.code === "EEXIST") throw new Error(`Another installer may be running: ${lock}`);
		throw error;
	}
	let staging;
	let launcherStaging;
	let previousMetadata;
	let metadataChanged = false;
	try {
		previousMetadata = existsSync(metadataPath) ? readFileSync(metadataPath, "utf8") : undefined;
		const previous = previousMetadata === undefined ? undefined : JSON.parse(previousMetadata);
		if (previousMetadata !== undefined && (previous?.schemaVersion !== 1 || previous?.repository !== repository || previous?.sourceDirectory !== source)) {
			throw new Error(`Refusing to overwrite an unrelated installation record: ${metadataPath}`);
		}
		const binDirectory = resolve(values["bin-dir"] || env.PIE_INSTALL_BIN_DIR || previous?.binDirectory || join(home, ".local", "bin"));
		const launcher = join(binDirectory, "pie");
		const checkLauncher = () => {
			const entry = lstatSync(launcher, { throwIfNoEntry: false });
			if (!entry) return;
			if (entry.isSymbolicLink()) {
				const target = resolve(binDirectory, readlinkSync(launcher));
				const path = relative(runtimes, target);
				if (path !== "" && !path.startsWith("..") && !isAbsolute(path)) return;
			}
			throw new Error(`Refusing to replace an unmanaged launcher: ${launcher}`);
		};
		checkLauncher();
		let marker;
		if (existsSync(source)) {
			if (lstatSync(source).isSymbolicLink()) throw new Error(`Managed source cannot be a symlink: ${source}`);
			const markerPath = join(source, ".git", "pie-managed.json");
			if (!existsSync(markerPath)) throw new Error(`Refusing to change an unmanaged checkout: ${source}`);
			marker = JSON.parse(readFileSync(markerPath, "utf8"));
			if (marker.repository !== repository || typeof marker.ref !== "string" || (values.ref && values.ref !== marker.ref)) {
				throw new Error("Managed checkout repository/ref does not match; use a separate PIE_CODING_AGENT_DIR");
			}
		} else {
			if (values.update) throw new Error(`No managed installation at ${root}; run scripts/install.sh first`);
			const ref = values.ref || defaultRef;
			git(["check-ref-format", "--branch", ref], root);
			if (values.local) clean(localDirectory);
			const clone = mkdtempSync(join(root, ".source-"));
			try {
				command("git", ["clone", "--no-hardlinks", "--single-branch", "--branch", ref, "--", values.local ? localDirectory : repository, clone], root);
				if (values.local) git(["remote", "set-url", "origin", repository], clone);
				marker = { repository, ref };
				writeFileSync(join(clone, ".git", "pie-managed.json"), `${JSON.stringify(marker)}\n`);
				renameSync(clone, source);
			} finally {
				rmSync(clone, { recursive: true, force: true });
			}
		}
		if (resolve(git(["rev-parse", "--show-toplevel"])) !== source || git(["remote", "get-url", "origin"]) !== repository || git(["symbolic-ref", "--short", "HEAD"]) !== marker.ref) {
			throw new Error(`Managed checkout identity changed: ${source}`);
		}
		const updaterPath = join(source, "scripts", "update.sh");
		clean(source);
		if (values.update) {
			git(["fetch", "--no-tags", "origin", marker.ref]);
			git(["merge", "--ff-only", "FETCH_HEAD"]);
		}
		if (!existsSync(updaterPath)) throw new Error(`Checkout is missing the Pie updater: ${updaterPath}`);
		const commit = git(["rev-parse", "HEAD"]);
		if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error(`Invalid Git commit: ${commit}`);
		mkdirSync(runtimes, { recursive: true });
		const runtime = join(runtimes, commit);
		const runtimeMetadata = join(runtime, "pie-installation.json");
		let productVersion;
		if (existsSync(runtime)) {
			if (!existsSync(runtimeMetadata)) throw new Error(`Refusing to overwrite incomplete runtime: ${runtime}`);
			const installed = JSON.parse(readFileSync(runtimeMetadata, "utf8"));
			if (installed.schemaVersion !== 1 || installed.commit !== commit || installed.repository !== repository || typeof installed.productVersion !== "string" || !installed.productVersion) throw new Error(`Invalid runtime metadata: ${runtime}`);
			productVersion = installed.productVersion;
		} else {
			staging = mkdtempSync(join(runtimes, ".install-"));
			command("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
			const { revision } = JSON.parse(readFileSync(join(source, "nix", "model-catalog.json"), "utf8"));
			if (!/^sha256-[0-9a-f]{64}$/.test(revision)) throw new Error("Invalid pinned model catalog revision");
			const catalog = await download(`https://pi.dev/api/models/revisions/${revision}?types=chat,image,classifier`);
			if (`sha256-${createHash("sha256").update(catalog).digest("hex")}` !== revision) throw new Error("Pinned model catalog SHA256 mismatch");
			const catalogPath = join(staging, "models.all.json");
			writeFileSync(catalogPath, catalog);
			command(process.execPath, [join(source, "packages/ai/scripts/hydrate-model-catalog.ts"), catalogPath]);
			rmSync(catalogPath);
			command(process.execPath, [join(source, "scripts/pack-packages.mjs"), "--offline-model-data", "--out", join(staging, "artifacts")]);
			const worker = join(staging, "prepare-runtime.mjs");
			writeFileSync(worker, `import { installConsumer } from ${JSON.stringify(pathToFileURL(join(source, "scripts/local-package-install.mjs")).href)};
import { readArtifactSet } from ${JSON.stringify(pathToFileURL(join(source, "scripts/package-artifacts.mjs")).href)};
import { smokeTestCodingAgent } from ${JSON.stringify(pathToFileURL(join(source, "scripts/coding-agent-smoke.mjs")).href)};
const directory = process.argv[2];
const artifactSet = readArtifactSet(process.argv[3]);
installConsumer({ artifactSet, directory, packageNames: [${JSON.stringify(packageName)}] });
smokeTestCodingAgent(directory);
`);
			command(process.execPath, [worker, staging, join(staging, "artifacts", "manifest.json")], staging);
			rmSync(worker);
			const manifest = JSON.parse(readFileSync(join(staging, "node_modules", packageName, "package.json"), "utf8"));
			if (Object.keys(manifest.bin ?? {}).join() !== "pie" || typeof manifest.bin.pie !== "string") throw new Error("Coding-agent package must expose only the pie CLI");
			productVersion = manifest.piConfig?.version;
			if (typeof productVersion !== "string" || !productVersion) throw new Error("Coding-agent package is missing the Pie product version (piConfig.version)");
			clean(source);
			writeFileSync(join(staging, "pie-installation.json"), `${JSON.stringify({ schemaVersion: 1, repository, ref: marker.ref, commit, productVersion }, null, 2)}\n`);
			renameSync(staging, runtime);
			staging = undefined;
		}
		const target = join(runtime, "node_modules", ".bin", "pie");
		if (!existsSync(target)) throw new Error(`Missing Pie launcher: ${target}`);
		const installation = {
			schemaVersion: 1, repository, ref: marker.ref, commit, productVersion,
			sourceDirectory: source, runtimeDirectory: runtime, binDirectory,
			updaterPath,
		};
		mkdirSync(binDirectory, { recursive: true });
		launcherStaging = mkdtempSync(join(binDirectory, ".pie-install-"));
		symlinkSync(target, join(launcherStaging, "pie"));
		writeFileSync(join(lock, "installation.json"), `${JSON.stringify(installation, null, 2)}\n`);
		checkLauncher();
		renameSync(join(lock, "installation.json"), metadataPath);
		metadataChanged = true;
		renameSync(join(launcherStaging, "pie"), launcher);
		metadataChanged = false;
		console.log(`Pie ${productVersion} (${commit.slice(0, 12)}) installed: ${launcher}\nUpdate: pie update\nEnsure ${binDirectory} is on PATH.`);
		return installation;
	} catch (error) {
		if (metadataChanged) {
			if (previousMetadata === undefined) rmSync(metadataPath, { force: true });
			else writeFileSync(metadataPath, previousMetadata);
		}
		throw error;
	} finally {
		if (staging) rmSync(staging, { recursive: true, force: true });
		if (launcherStaging) rmSync(launcherStaging, { recursive: true, force: true });
		rmSync(lock, { recursive: true, force: true });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	installPie(process.argv.slice(2)).catch((error) => {
		console.error(`Pie installer: ${error.message}`);
		process.exitCode = 1;
	});
}
