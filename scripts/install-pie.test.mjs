import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync,
	readdirSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { installPie } from "./install-pie.mjs";

const scripts = dirname(fileURLToPath(import.meta.url));
const repository = "https://github.com/chocotan/pie.git";
const branch = "main";
const firstCommit = "a".repeat(40);
const nextCommit = "b".repeat(40);
const catalog = Buffer.from('{"fixture":[]}');
const revision = `sha256-${createHash("sha256").update(catalog).digest("hex")}`;

function fixture(t, rootName = ".pie") {
	const temporary = mkdtempSync(join(tmpdir(), "pie-install-test-"));
	t.after(() => rmSync(temporary, { recursive: true, force: true }));
	const home = join(temporary, "home with spaces");
	const root = join(home, rootName);
	const source = join(root, "source");
	const bin = join(home, ".local", "bin");
	const calls = [];
	const state = { commit: firstCommit, branch, productVersion: "0.1.0", legacyBin: false, dirty: false, fail: undefined, downloaded: [] };
	mkdirSync(root, { recursive: true });
	mkdirSync(join(home, ".pi-ext"));
	writeFileSync(join(home, ".pi-ext", "auth.json"), "legacy must stay here");
	writeFileSync(join(root, "settings.json"), "existing settings bytes\n");
	writeFileSync(join(root, "auth.json"), "existing credentials bytes\n");
	function run(file, args, options) {
		calls.push({ file, args, cwd: options.cwd, env: options.env });
		assert.equal(options.env.npm_config_ignore_scripts, "true");
		if (file === "git") {
			if (state.fail === args[0]) throw new Error(`failed ${args[0]}`);
			switch (args[0]) {
				case "clone": {
					const destination = args.at(-1);
					state.branch = args[args.indexOf("--branch") + 1];
					mkdirSync(join(destination, ".git"));
					mkdirSync(join(destination, "nix"));
					mkdirSync(join(destination, "scripts"));
					writeFileSync(join(destination, "nix", "model-catalog.json"), JSON.stringify({ revision }));
					writeFileSync(join(destination, "scripts", "update.sh"), "#!/bin/bash\n");
					return "";
				}
				case "rev-parse": return args[1] === "--show-toplevel" ? source : state.commit;
				case "remote": return args[1] === "get-url" ? repository : "";
				case "symbolic-ref": return state.branch;
				case "status": return state.dirty ? "?? important.txt\n" : "";
				default: return "";
			}
		}
		if (file === "npm") {
			assert.deepEqual(args, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
			if (state.fail === "ci") throw new Error("failed ci");
			return "";
		}
		assert.equal(file, process.execPath);
		if (args[0].endsWith("hydrate-model-catalog.ts")) {
			assert.equal(readFileSync(args[1], "utf8"), catalog.toString());
			if (state.fail === "hydrate") throw new Error("failed hydrate");
		} else if (args[0].endsWith("pack-packages.mjs")) {
			assert.equal(args[1], "--offline-model-data");
			if (state.fail === "build") throw new Error("failed build");
			mkdirSync(args[3]);
			writeFileSync(join(args[3], "manifest.json"), "{}");
		} else {
			assert.ok(args[0].endsWith("prepare-runtime.mjs"));
			const worker = readFileSync(args[0], "utf8");
			assert.match(worker, /import \{ installConsumer \} from .*local-package-install\.mjs/);
			assert.match(worker, /import \{ readArtifactSet \} from .*package-artifacts\.mjs/);
			assert.match(worker, /smokeTestCodingAgent\(directory\)/);
			assert.match(worker, /packageNames: \["@earendil-works\/pi-coding-agent"\]/);
			if (state.fail === "smoke") throw new Error("failed smoke");
			const directory = join(args[1], "node_modules", "@earendil-works", "pi-coding-agent");
			mkdirSync(directory, { recursive: true });
			writeFileSync(join(directory, "package.json"), JSON.stringify({ version: "1.2.0", piConfig: { version: state.productVersion }, bin: state.legacyBin ? { pie: "cli.js", pi: "cli.js" } : { pie: "cli.js" } }));
			mkdirSync(join(args[1], "node_modules", ".bin"));
			writeFileSync(join(args[1], "node_modules", ".bin", "pie"), "fixture cli");
		}
		return "";
	}
	const dependencies = {
		env: { HOME: home, PATH: process.env.PATH, ...(rootName === ".pie" ? {} : { PIE_CODING_AGENT_DIR: root }) }, run,
		localDirectory: join(temporary, "local repository"),
		download: async (url) => {
			state.downloaded.push(url);
			if (state.fail === "download") throw new Error("failed download");
			return state.fail === "integrity" ? Buffer.from("tampered") : catalog;
		},
	};
	return { temporary, home, root, source, bin, calls, state, dependencies };
}

function assertConfig(f) {
	assert.equal(readFileSync(join(f.root, "settings.json"), "utf8"), "existing settings bytes\n");
	assert.equal(readFileSync(join(f.root, "auth.json"), "utf8"), "existing credentials bytes\n");
	assert.equal(readFileSync(join(f.home, ".pi-ext", "auth.json"), "utf8"), "legacy must stay here");
	assert.equal(existsSync(join(f.root, ".install-lock")), false);
}

test("Git install defaults to the Pie branch, pinned catalog and atomic managed launcher", async (t) => {
	const f = fixture(t);
	const installation = await installPie([], f.dependencies);
	const clone = f.calls.find((call) => call.args[0] === "clone");
	assert.deepEqual(clone.args.slice(0, -1), ["clone", "--no-hardlinks", "--single-branch", "--branch", branch, "--", repository]);
	assert.deepEqual(f.state.downloaded, [`https://pi.dev/api/models/revisions/${revision}?types=chat,image,classifier`]);
	assert.equal(installation.productVersion, "0.1.0");
	assert.equal(installation.commit, firstCommit);
	assert.equal(installation.updaterPath, join(f.source, "scripts", "update.sh"));
	assert.equal(installation.binDirectory, f.bin);
	assert.equal(readlinkSync(join(f.bin, "pie")), join(f.root, "runtime", firstCommit, "node_modules", ".bin", "pie"));
	assert.equal(existsSync(join(f.bin, "pi-ext")), false);
	assert.equal(existsSync(join(f.bin, "pi")), false);
	assert.deepEqual(JSON.parse(readFileSync(join(f.root, "installation.json"), "utf8")), installation);
	assertConfig(f);
});

test("--local clones a clean checkout and honors config/bin overrides for future updates", async (t) => {
	const f = fixture(t, "configured Pie root");
	const customBin = join(f.temporary, "custom bin");
	await installPie(["--local", "--bin-dir", customBin], f.dependencies);
	const clone = f.calls.find((call) => call.args[0] === "clone");
	assert.equal(clone.args.at(-2), f.dependencies.localDirectory);
	assert.ok(f.calls.some((call) => call.cwd === f.dependencies.localDirectory && call.args[0] === "status"));
	assert.ok(f.calls.some((call) => call.args.join(" ") === `remote set-url origin ${repository}`));
	assert.ok(existsSync(join(customBin, "pie")));
	assert.equal(existsSync(join(f.home, ".pie")), false);
	assertConfig(f);
});

test("updates fast-forward clean managed source, retain old runtimes and reuse installed commits", async (t) => {
	const f = fixture(t);
	f.dependencies.env.PIE_INSTALL_BIN_DIR = join(f.temporary, "bin override");
	await installPie([], f.dependencies);
	f.calls.length = 0;
	f.state.commit = nextCommit;
	const installation = await installPie(["--update"], f.dependencies);
	const fetch = f.calls.findIndex((call) => call.args[0] === "fetch");
	const status = f.calls.findIndex((call) => call.args[0] === "status");
	assert.ok(status < fetch);
	assert.deepEqual(f.calls[fetch].args, ["fetch", "--no-tags", "origin", branch]);
	assert.deepEqual(f.calls[fetch + 1].args, ["merge", "--ff-only", "FETCH_HEAD"]);
	assert.ok(existsSync(join(f.root, "runtime", firstCommit, "node_modules", ".bin", "pie")));
	assert.equal(readlinkSync(join(installation.binDirectory, "pie")), join(installation.runtimeDirectory, "node_modules", ".bin", "pie"));
	f.calls.length = 0;
	await installPie(["--update"], f.dependencies);
	assert.equal(f.calls.some((call) => call.file === "npm"), false);
	assertConfig(f);
});

test("dirty source and divergent updates stop before build and leave the current runtime active", async (t) => {
	const f = fixture(t);
	await installPie([], f.dependencies);
	const previous = readlinkSync(join(f.bin, "pie"));
	f.calls.length = 0;
	f.state.dirty = true;
	await assert.rejects(installPie(["--update"], f.dependencies), /dirty/);
	assert.equal(f.calls.some((call) => call.args[0] === "fetch"), false);
	f.state.dirty = false;
	f.state.fail = "merge";
	await assert.rejects(installPie(["--update"], f.dependencies), /failed merge/);
	assert.equal(f.calls.some((call) => call.file === "npm"), false);
	assert.equal(readlinkSync(join(f.bin, "pie")), previous);
	assertConfig(f);
});

for (const failure of ["ci", "download", "integrity", "hydrate", "build", "smoke"]) {
	test(`${failure} failure preserves launcher, provenance, configuration and prior runtime`, async (t) => {
		const f = fixture(t);
		await installPie([], f.dependencies);
		const metadata = readFileSync(join(f.root, "installation.json"), "utf8");
		const launcher = readlinkSync(join(f.bin, "pie"));
		f.state.commit = nextCommit;
		f.state.fail = failure;
		await assert.rejects(installPie(["--update"], f.dependencies), failure === "integrity" ? /SHA256 mismatch/ : new RegExp(`failed ${failure}`));
		assert.equal(readFileSync(join(f.root, "installation.json"), "utf8"), metadata);
		assert.equal(readlinkSync(join(f.bin, "pie")), launcher);
		assert.deepEqual(readdirSync(join(f.root, "runtime")), [firstCommit]);
		assertConfig(f);
	});
}

test("custom refs remain recorded for updates and installer locks are preserved", async (t) => {
	const f = fixture(t);
	await installPie(["--ref", "pie-preview"], f.dependencies);
	f.calls.length = 0;
	await installPie(["--update"], f.dependencies);
	assert.ok(f.calls.some((call) => call.args.join(" ") === "fetch --no-tags origin pie-preview"));
	await assert.rejects(installPie(["--update", "--ref", branch], f.dependencies), /repository\/ref does not match/);
	mkdirSync(join(f.root, ".install-lock"));
	await assert.rejects(installPie(["--update"], f.dependencies), /Another installer/);
	assert.ok(existsSync(join(f.root, ".install-lock")));
	rmSync(join(f.root, ".install-lock"), { recursive: true });
	assertConfig(f);
});

test("local dirty source, failed clones, missing product versions and legacy CLI aliases cannot activate", async (t) => {
	const f = fixture(t);
	f.state.dirty = true;
	await assert.rejects(installPie(["--local"], f.dependencies), /dirty/);
	assert.equal(f.calls.some((call) => call.args[0] === "clone"), false);
	f.state.dirty = false;
	f.state.fail = "clone";
	await assert.rejects(installPie([], f.dependencies), /failed clone/);
	assert.equal(existsSync(f.source), false);
	assert.equal(readdirSync(f.root).some((name) => name.startsWith(".source-")), false);
	f.state.fail = undefined;
	f.state.productVersion = undefined;
	await assert.rejects(installPie([], f.dependencies), /missing the Pie product version/);
	f.state.productVersion = "0.1.0";
	f.state.legacyBin = true;
	await assert.rejects(installPie([], f.dependencies), /only the pie CLI/);
	assert.equal(existsSync(join(f.root, "installation.json")), false);
	assert.equal(existsSync(join(f.bin, "pie")), false);
	assertConfig(f);
});

test("refuses unowned checkouts, launchers, metadata and missing updates", async (t) => {
	const f = fixture(t);
	await assert.rejects(installPie(["--update"], f.dependencies), /No managed installation/);
	mkdirSync(f.source);
	await assert.rejects(installPie([], f.dependencies), /unmanaged checkout/);
	rmSync(f.source, { recursive: true });
	mkdirSync(f.bin, { recursive: true });
	symlinkSync(join(f.temporary, "other-pie"), join(f.bin, "pie"));
	await assert.rejects(installPie([], f.dependencies), /unmanaged launcher/);
	rmSync(join(f.bin, "pie"));
	writeFileSync(join(f.root, "installation.json"), '{"user":"data"}');
	await assert.rejects(installPie([], f.dependencies), /unrelated installation record/);
	assert.equal(readFileSync(join(f.root, "installation.json"), "utf8"), '{"user":"data"}');
	assertConfig(f);
});

for (const name of ["install", "update"]) {
	test(`${name}.sh bootstraps via curl and invokes local checkout without curl`, (t) => {
		const f = fixture(t);
		const tools = join(f.temporary, "tools");
		mkdirSync(tools);
		const log = join(f.temporary, "commands.jsonl");
		const script = readFileSync(join(scripts, `${name}.sh`), "utf8");
		const fakeNode = `#!${process.execPath}
import { appendFileSync, existsSync } from 'node:fs';
appendFileSync(process.env.COMMAND_LOG, JSON.stringify({ command: 'node', args: process.argv.slice(2), downloaded: existsSync(process.argv[2]) }) + '\\n');
`;
		const fakeCurl = `#!${process.execPath}
import { appendFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.COMMAND_LOG, JSON.stringify({ command: 'curl', args }) + '\\n');
if (process.env.FAIL_CURL) process.exit(22);
writeFileSync(args[args.indexOf('--output') + 1], '// downloaded installer');
`;
		writeFileSync(join(tools, "node"), fakeNode);
		writeFileSync(join(tools, "curl"), fakeCurl);
		chmodSync(join(tools, "node"), 0o755);
		chmodSync(join(tools, "curl"), 0o755);
		const env = { ...process.env, HOME: f.home, PATH: `${tools}:${process.env.PATH}`, TMPDIR: f.temporary, COMMAND_LOG: log };
		const remote = spawnSync("bash", ["-s", "--", "--bin-dir", "custom bin"], { input: script, env, encoding: "utf8", cwd: f.temporary });
		assert.equal(remote.status, 0, remote.stderr);
		const commands = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(commands[0].command, "curl");
		assert.ok(commands[0].args.includes("https://raw.githubusercontent.com/chocotan/pie/main/scripts/install-pie.mjs"));
		assert.ok(commands[0].args.includes("--fail"));
		assert.equal(commands[1].command, "node");
		assert.equal(commands[1].downloaded, true);
		assert.deepEqual(commands[1].args.slice(1), [...(name === "update" ? ["--update"] : []), "--bin-dir", "custom bin"]);
		assert.equal(existsSync(dirname(commands[1].args[0])), false);
		writeFileSync(log, "");
		const failed = spawnSync("bash", ["-s"], { input: script, env: { ...env, FAIL_CURL: "1" }, encoding: "utf8", cwd: f.temporary });
		assert.equal(failed.status, 22);
		assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 1);
		const localScripts = join(f.temporary, "checkout", "scripts");
		mkdirSync(localScripts, { recursive: true });
		writeFileSync(join(localScripts, `${name}.sh`), script);
		writeFileSync(join(localScripts, "install-pie.mjs"), "// local installer");
		writeFileSync(log, "");
		const local = spawnSync("bash", [join(localScripts, `${name}.sh`), ...(name === "install" ? ["--local"] : [])], { env, encoding: "utf8" });
		assert.equal(local.status, 0, local.stderr);
		const localCall = JSON.parse(readFileSync(log, "utf8"));
		assert.equal(localCall.command, "node");
		assert.deepEqual(localCall.args, [join(localScripts, "install-pie.mjs"), name === "install" ? "--local" : "--update"]);
	});
}
