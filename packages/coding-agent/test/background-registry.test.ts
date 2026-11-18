import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	BackgroundRegistry,
	type BackgroundTask,
	MAX_LOG_BYTES,
	readTaskLogs,
	sortBackgroundTasks,
} from "../src/extensions/background/registry.ts";

let directory: string;
const registries: BackgroundRegistry[] = [];
const shell = { shell: process.execPath, args: ["-e"] };
function registry(options: Partial<ConstructorParameters<typeof BackgroundRegistry>[0]> = {}): BackgroundRegistry {
	const owner = new BackgroundRegistry({
		agentDir: directory,
		sessionId: "fixture-session",
		processTree: { graceMs: 25 },
		...options,
	});
	registries.push(owner);
	return owner;
}
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "pie-background-test-"));
});
afterEach(async () => {
	await Promise.all(registries.splice(0).map((owner) => owner.shutdown()));
	await rm(directory, { recursive: true, force: true });
});
const orderedTask = (id: string, status: BackgroundTask["status"], startedAt: number): BackgroundTask => ({
	id,
	name: id,
	description: id,
	command: "true",
	cwd: "/tmp",
	shell: "bash",
	status,
	startedAt,
	outputPath: `/tmp/${id}`,
	bytesWritten: 0,
	notifyOnCompletion: true,
	triggerOnCompletion: true,
});

describe("sortBackgroundTasks", () => {
	it("puts running jobs first and every settled job newest first", () => {
		const tasks = [
			orderedTask("finished-old", "completed", 1),
			orderedTask("running-new", "running", 9),
			orderedTask("failed-new", "failed", 8),
			orderedTask("running-old", "running", 3),
		];
		expect(sortBackgroundTasks(tasks).map((task) => task.id)).toEqual([
			"running-new",
			"running-old",
			"failed-new",
			"finished-old",
		]);
	});
});

describe("BackgroundRegistry", () => {
	it("captures both streams and closes output and metadata before notifying exactly once", async () => {
		const completion = vi.fn();
		const owner = registry({ onCompletion: completion });
		const task = await owner.start(
			"process.stdout.write('hello'); process.stderr.write('diagnostic')",
			directory,
			shell,
			{ name: "\x1b[31mFixture\x1b[0m", description: "Capture\noutput\u202e", timeoutSeconds: 0 },
		);
		expect(task.outputPath.startsWith(join(directory, "tasks"))).toBe(true);
		await owner.wait(task.id);
		const settled = owner.resolve(task.id.slice(0, 12));
		expect(settled.name).toBe("Fixture");
		expect(settled.description).toBe("Capture output");
		expect(settled.status).toBe("completed");
		expect(settled.exitCode).toBe(0);
		expect(completion).toHaveBeenCalledExactlyOnceWith(settled);
		const logs = await readTaskLogs(settled);
		expect(logs.text).toContain("hello");
		expect(logs.text).toContain("diagnostic");
		expect(JSON.parse(await readFile(`${task.outputPath}.json`, "utf8")).status).toBe("completed");
		expect((await stat(task.outputPath)).mode & 0o777).toBe(0o600);
		await expect(owner.stop(task.id)).rejects.toThrow("not running");
		expect(() => owner.resolve("foreign-task")).toThrow("Unknown");
	});
	it("retains every completed record while the panel hides only overflow", async () => {
		const owner = registry();
		let firstId = "";
		for (let index = 0; index < 101; index++) {
			const task = await owner.start("0", directory, shell, { name: `Fixture ${index}`, timeoutSeconds: 0 });
			firstId ||= task.id;
			await owner.wait(task.id);
		}
		expect(owner.list()).toHaveLength(101);
		expect(owner.resolve(firstId).status).toBe("completed");
	}, 20_000);
	it("marks nonzero and signal exits as failures, rather than successful null exits", async () => {
		const owner = registry();
		for (const command of ["process.exitCode = 7", "process.kill(process.pid, 'SIGTERM')"]) {
			const task = await owner.start(command, directory, shell, { name: "Failure", timeoutSeconds: 0 });
			await owner.wait(task.id);
			expect(owner.resolve(task.id).status).toBe("failed");
		}
	});
	it("bounds disk output and terminates an output flood", async () => {
		const owner = registry({ maxOutputBytes: 1024 });
		const task = await owner.start("setInterval(() => process.stdout.write('x'.repeat(4096)), 1)", directory, shell, {
			name: "Flood",
			timeoutSeconds: 0,
		});
		await owner.wait(task.id);
		expect(owner.resolve(task.id)).toMatchObject({ status: "failed", bytesWritten: 1024 });
		expect(owner.resolve(task.id).error).toContain("Output exceeded cap");
		expect((await stat(task.outputPath)).size).toBe(1024);
	});
	it("enforces timeouts, explicit kill, and session shutdown without late notifications", async () => {
		const completion = vi.fn();
		const owner = registry({ onCompletion: completion });
		const timeout = await owner.start("setInterval(() => {}, 1000)", directory, shell, {
			name: "Timeout",
			timeoutSeconds: 0.1,
		});
		await owner.wait(timeout.id);
		expect(owner.resolve(timeout.id)).toMatchObject({ status: "failed", error: "Timed out after 0.1s" });
		const killed = await owner.start("setInterval(() => {}, 1000)", directory, shell, {
			name: "Kill",
			timeoutSeconds: 0,
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect((await owner.stop(killed.id)).status).toBe("killed");
		const shuttingDown = await owner.start("setInterval(() => {}, 1000)", directory, shell, {
			name: "Shutdown",
			timeoutSeconds: 0,
		});
		const notifications = completion.mock.calls.length;
		await owner.shutdown();
		expect(owner.resolve(shuttingDown.id).status).toBe("killed");
		expect(completion).toHaveBeenCalledTimes(notifications);
		await expect(owner.start("0", directory, shell, { name: "Late", timeoutSeconds: 0 })).rejects.toThrow("closed");
	});
	it("closes a racing admission before it can spawn", async () => {
		const spawn = vi.fn();
		const owner = registry({ spawn });
		const admission = owner.start("0", directory, shell, { name: "Race", timeoutSeconds: 0 });
		const failed = expect(admission).rejects.toThrow("closed");
		await owner.shutdown();
		await failed;
		expect(spawn).not.toHaveBeenCalled();
	});
	it("rejects invalid input and aborted admissions before spawning", async () => {
		const spawn = vi.fn();
		const owner = registry({ spawn });
		for (const timeoutSeconds of [-1, Number.NaN, Infinity, 2147484])
			await expect(owner.start("0", directory, shell, { name: "Invalid", timeoutSeconds })).rejects.toThrow(
				"timeout",
			);
		await expect(owner.start(" ", directory, shell, { name: "Empty", timeoutSeconds: 0 })).rejects.toThrow(
			"nonempty",
		);
		await expect(owner.start("0", directory, shell, { name: " ", timeoutSeconds: 0 })).rejects.toThrow("name");
		await expect(
			owner.start("0", directory, shell, { name: "Aborted", timeoutSeconds: 0 }, AbortSignal.abort()),
		).rejects.toThrow();
		expect(spawn).not.toHaveBeenCalled();
	});
	it("preserves an asynchronous spawn failure without leaking a task", async () => {
		const owner = registry();
		await expect(
			owner.start(
				"0",
				directory,
				{ shell: join(directory, "absent-executable"), args: [] },
				{ name: "Missing", timeoutSeconds: 0 },
			),
		).rejects.toThrow();
		expect(owner.list()).toHaveLength(1);
		expect(owner.list()[0].status).toBe("failed");
	});
	it("honors command-over-stdin shell transport and notification opt-out", async () => {
		const completion = vi.fn();
		const owner = registry({ onCompletion: completion });
		const task = await owner.start(
			"process.stdout.write('stdin command')",
			directory,
			{ shell: process.execPath, args: [], commandTransport: "stdin" },
			{ name: "Stdin", notifyOnCompletion: false, timeoutSeconds: 0 },
		);
		await owner.wait(task.id);
		expect((await readTaskLogs(owner.resolve(task.id))).text).toBe("stdin command");
		expect(completion).not.toHaveBeenCalled();
	});
	it("reads bounded head/tail logs without broken UTF-8 and rejects another session's ID", async () => {
		const owner = registry();
		const task = await owner.start("process.stdout.write('START' + '中'.repeat(30000) + 'END')", directory, shell, {
			name: "Large",
			timeoutSeconds: 0,
		});
		await owner.wait(task.id);
		const head = await readTaskLogs(task, 10, false);
		const tail = await readTaskLogs(task, 10, true);
		expect(head.text).toBe("START中");
		expect(tail.text).toBe("中中END");
		expect(head.text + tail.text).not.toContain("�");
		expect((await readTaskLogs(task, 999999)).bytesRead).toBe(MAX_LOG_BYTES);
		await expect(readTaskLogs(task, 0)).rejects.toThrow("positive");
		expect(() => registry({ sessionId: "another-fixture" }).resolve(task.id)).toThrow("Unknown");
	});
});
