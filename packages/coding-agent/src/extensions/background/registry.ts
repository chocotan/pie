// Adapted from pi-background-tasks (ISC), Copyright (c) 2026. See docs/third-party/pi-background-tasks/LICENSE.
import type { ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, mkdtemp, open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { stripVTControlCharacters } from "node:util";
import { spawnProcess, waitForChildProcess } from "../../utils/child-process.ts";
import {
	getShellEnv,
	type ShellConfig,
	sanitizeBinaryOutput,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";
import { type ProcessTreeOptions, stopProcessTree } from "./process-tree.ts";

export const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
export const MAX_LOG_BYTES = 50 * 1024;

/**
 * Emitted on `pi.events` whenever the running task set changes, so other
 * extensions (the continue watchdog) can treat background shells as activity.
 */
export const BACKGROUND_ACTIVITY_EVENT = "pie.background-activity";
export interface BackgroundActivity {
	readonly running: number;
}
export interface BackgroundTask {
	id: string;
	name: string;
	description: string;
	command: string;
	cwd: string;
	shell: "bash" | "powershell";
	status: "running" | "completed" | "failed" | "killed";
	startedAt: number;
	finishedAt?: number;
	pid?: number;
	exitCode?: number | null;
	error?: string;
	outputPath: string;
	bytesWritten: number;
	notifyOnCompletion: boolean;
	triggerOnCompletion: boolean;
}
export interface StartOptions {
	name: string;
	description?: string;
	timeoutSeconds?: number;
	notifyOnCompletion?: boolean;
	triggerOnCompletion?: boolean;
	shell?: "bash" | "powershell";
}
interface Run {
	task: BackgroundTask;
	stream: WriteStream;
	child: ChildProcess;
	done: Promise<void>;
	stop?: Promise<void>;
	timeout?: NodeJS.Timeout;
	stopping?: "user" | "shutdown" | "failure";
	finalizing: boolean;
}
export interface RegistryOptions {
	agentDir: string;
	sessionId: string;
	onChange?: () => void;
	onCompletion?: (task: BackgroundTask) => void;
	onError?: (error: unknown) => void;
	spawn?: typeof spawnProcess;
	processTree?: ProcessTreeOptions;
	maxOutputBytes?: number;
}

function taskLabel(value: string): string {
	return stripVTControlCharacters(value)
		.replace(/\s+/g, " ")
		.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")
		.trim();
}

/** One session activation owns every child handle. Files never confer process ownership on resume. */
export class BackgroundRegistry {
	private readonly options: RegistryOptions;
	private readonly tasks = new Map<string, BackgroundTask>();
	private readonly runs = new Map<string, Run>();
	private readonly admissions = new Set<Promise<BackgroundTask>>();
	private directory?: Promise<string>;
	private closing = false;
	constructor(options: RegistryOptions) {
		this.options = options;
	}
	list(): BackgroundTask[] {
		return [...this.tasks.values()].map((task) => ({ ...task }));
	}
	resolve(id: string): BackgroundTask {
		if (!id.trim()) throw new Error("Background task ID is required");
		const task = this.tasks.get(id) ?? [...this.tasks.values()].filter((task) => task.id.startsWith(id));
		if (!Array.isArray(task)) return { ...task };
		if (task.length !== 1)
			throw new Error(task.length ? `Ambiguous background task ID: ${id}` : `Unknown background task: ${id}`);
		return { ...task[0] };
	}
	start(
		command: string,
		cwd: string,
		shell: ShellConfig,
		options: StartOptions,
		signal?: AbortSignal,
	): Promise<BackgroundTask> {
		const admission = this.startAdmitted(command, cwd, shell, options, signal);
		this.admissions.add(admission);
		void admission.finally(() => this.admissions.delete(admission)).catch(() => {});
		return admission;
	}
	private async startAdmitted(
		command: string,
		cwd: string,
		shell: ShellConfig,
		options: StartOptions,
		signal?: AbortSignal,
	): Promise<BackgroundTask> {
		const check = () => {
			if (this.closing) throw new Error("Background task admissions are closed");
			signal?.throwIfAborted();
		};
		check();
		if (!command.trim() || command.includes("\0"))
			throw new Error("Background command must be nonempty and contain no NUL bytes");
		const name = taskLabel(options.name);
		if (!name) throw new Error("Background task name must be nonempty");
		if (
			options.timeoutSeconds !== undefined &&
			(!Number.isFinite(options.timeoutSeconds) ||
				options.timeoutSeconds <= 0 ||
				options.timeoutSeconds * 1000 > 2147483647)
		)
			throw new Error("Background timeout must be positive and at most 2147483.647 seconds");
		this.directory ??= this.createDirectory();
		const directory = await this.directory;
		check();
		const id = `b${randomUUID().replaceAll("-", "")}`;
		const task: BackgroundTask = {
			id,
			name,
			description: taskLabel(options.description ?? "") || name,
			command,
			cwd,
			shell: options.shell ?? "bash",
			status: "running",
			startedAt: Date.now(),
			outputPath: join(directory, `${id}.output`),
			bytesWritten: 0,
			notifyOnCompletion: options.notifyOnCompletion ?? true,
			triggerOnCompletion: options.triggerOnCompletion ?? true,
		};
		const stream = createWriteStream(task.outputPath, { flags: "wx", mode: 0o600 });
		let run: Run | undefined;
		try {
			await once(stream, "open");
			check();
			await this.persist(task);
			check();
			const fromStdin = shell.commandTransport === "stdin";
			const child = (this.options.spawn ?? spawnProcess)(
				shell.shell,
				fromStdin ? shell.args : [...shell.args, command],
				{
					cwd,
					env: getShellEnv(),
					detached: process.platform !== "win32",
					stdio: [fromStdin ? "pipe" : "ignore", "pipe", "pipe"],
					windowsHide: true,
				},
			);
			task.pid = child.pid;
			if (child.pid) trackDetachedChildPid(child.pid);
			run = { task, stream, child, done: Promise.resolve(), finalizing: false };
			const owned = run;
			this.tasks.set(id, task);
			this.runs.set(id, owned);
			const fail = (error: string) => {
				task.error ??= error;
				owned.stopping = "failure";
				void this.requestStop(owned).catch((error: unknown) => this.options.onError?.(error));
			};
			stream.on("error", (error) => fail(`Output file write failed: ${error.message}`));
			const append = (chunk: Buffer) => {
				if (owned.finalizing || stream.destroyed || owned.stopping === "failure") return;
				const remaining = Math.max(0, (this.options.maxOutputBytes ?? MAX_OUTPUT_BYTES) - task.bytesWritten);
				const bytes = chunk.subarray(0, remaining);
				if (bytes.length) {
					task.bytesWritten += bytes.length;
					if (!stream.write(bytes)) {
						child.stdout?.pause();
						child.stderr?.pause();
					}
				}
				if (chunk.length > remaining)
					fail(`Output exceeded cap of ${this.options.maxOutputBytes ?? MAX_OUTPUT_BYTES} bytes`);
			};
			stream.on("drain", () => {
				child.stdout?.resume();
				child.stderr?.resume();
			});
			child.stdout?.on("data", append);
			child.stderr?.on("data", append);
			owned.done = this.finish(owned, waitForChildProcess(child));
			void owned.done.catch((error: unknown) => this.options.onError?.(error));
			if (fromStdin) {
				child.stdin?.on("error", (error) => fail(`Command stdin failed: ${error.message}`));
				child.stdin?.end(command);
			}
			if (options.timeoutSeconds !== undefined)
				owned.timeout = setTimeout(
					() => fail(`Timed out after ${options.timeoutSeconds}s`),
					options.timeoutSeconds * 1000,
				);
			const abort = () => {
				owned.stopping = "user";
				void this.requestStop(owned).catch((error: unknown) => this.options.onError?.(error));
			};
			signal?.addEventListener("abort", abort, { once: true });
			try {
				if (signal?.aborted) abort();
				await once(child, "spawn");
				check();
			} finally {
				signal?.removeEventListener("abort", abort);
			}
			this.changed();
			return { ...task };
		} catch (error) {
			if (run) {
				run.stopping ??= "failure";
				run.task.error ??= String(error);
				await this.requestStop(run);
				await run.done;
			} else {
				stream.destroy();
				await finished(stream).catch(() => {});
				await Promise.all([rm(task.outputPath, { force: true }), rm(`${task.outputPath}.json`, { force: true })]);
			}
			throw error;
		}
	}
	private async createDirectory(): Promise<string> {
		const session = createHash("sha256").update(this.options.sessionId).digest("hex").slice(0, 24);
		const root = join(this.options.agentDir, "tasks", session);
		await mkdir(root, { recursive: true, mode: 0o700 });
		return mkdtemp(join(root, "shell-"));
	}
	private async persist(task: BackgroundTask): Promise<void> {
		const path = `${task.outputPath}.json`;
		const temporary = `${path}.tmp`;
		try {
			await writeFile(temporary, `${JSON.stringify(task, null, 2)}\n`, { mode: 0o600, flag: "wx" });
			await rename(temporary, path);
		} finally {
			await rm(temporary, { force: true });
		}
	}
	private requestStop(run: Run): Promise<void> {
		// Keep one force owner even when TERM causes the group leader to exit first.
		run.stop ??= stopProcessTree(run.child, this.options.processTree);
		return run.stop;
	}
	private async finish(run: Run, exit: Promise<number | null>): Promise<void> {
		const task = run.task;
		try {
			try {
				task.exitCode = await exit;
			} catch (error) {
				task.error ??= `Spawn failed: ${String(error)}`;
			}
			if (run.timeout) clearTimeout(run.timeout);
			// Pipe-idle completion can precede descendants. Reap the owned tree before publishing terminal state.
			await this.requestStop(run);
		} catch (error) {
			task.error = `${task.error ? `${task.error}; ` : ""}Tree cleanup failed: ${String(error)}`;
		} finally {
			run.finalizing = true;
			if (run.timeout) clearTimeout(run.timeout);
			try {
				if (!run.stream.destroyed) {
					const closed = finished(run.stream);
					run.stream.end();
					await closed;
				} else if (run.stream.errored) task.error ??= `Output close failed: ${String(run.stream.errored)}`;
			} catch (error) {
				task.error ??= `Output close failed: ${String(error)}`;
			}
			const status = task.error ? "failed" : run.stopping ? "killed" : task.exitCode === 0 ? "completed" : "failed";
			if (status === "failed") task.error ??= `Command exited with code ${task.exitCode ?? "null"}`;
			task.finishedAt = Date.now();
			try {
				await this.persist({ ...task, status });
			} catch (error) {
				task.error = `Terminal metadata write failed: ${String(error)}`;
			}
			task.status = task.error ? "failed" : status;
			if (task.pid && !task.error?.includes("Tree cleanup failed")) untrackDetachedChildPid(task.pid);
			this.changed();
			if (!this.closing && task.notifyOnCompletion) {
				try {
					this.options.onCompletion?.({ ...task });
				} catch (error) {
					this.options.onError?.(error);
				}
			}
			this.runs.delete(task.id);
		}
	}
	private changed(): void {
		this.options.onChange?.();
	}
	async wait(id: string): Promise<void> {
		await this.runs.get(this.resolve(id).id)?.done;
	}
	async stop(id: string): Promise<BackgroundTask> {
		const task = this.resolve(id);
		const run = this.runs.get(task.id);
		if (!run || run.finalizing || task.status !== "running") throw new Error(`Task ${task.id} is not running`);
		run.stopping ??= "user";
		await this.requestStop(run);
		await run.done;
		return this.resolve(task.id);
	}
	async shutdown(): Promise<void> {
		this.closing = true;
		await Promise.allSettled([...this.admissions]);
		const results = await Promise.allSettled(
			[...this.runs.values()].map(async (run) => {
				run.stopping ??= "shutdown";
				await this.requestStop(run);
				await run.done;
			}),
		);
		const failures = results.filter((result) => result.status === "rejected");
		if (failures.length)
			throw new AggregateError(
				failures.map((result) => result.reason),
				"Background task shutdown failed",
			);
	}
}

/** Read at most 50KiB from an owned task's file; never load the whole log into memory. */
export async function readTaskLogs(
	task: BackgroundTask,
	maxBytes = MAX_LOG_BYTES,
	tail = true,
): Promise<{ text: string; bytesRead: number; totalBytes: number; truncated: boolean }> {
	if (!Number.isFinite(maxBytes) || maxBytes < 1) throw new Error("maxBytes must be positive");
	maxBytes = Math.min(MAX_LOG_BYTES, Math.floor(maxBytes));
	const file = await open(task.outputPath, "r");
	try {
		const totalBytes = (await file.stat()).size;
		const buffer = Buffer.alloc(Math.min(totalBytes, maxBytes));
		const { bytesRead } = await file.read(
			buffer,
			0,
			buffer.length,
			tail ? Math.max(0, totalBytes - buffer.length) : 0,
		);
		let start = 0;
		if (tail && totalBytes > bytesRead) while (start < bytesRead && (buffer[start] & 0xc0) === 0x80) start++;
		const decoded = new TextDecoder().decode(buffer.subarray(start, bytesRead), {
			stream: totalBytes > bytesRead && !tail,
		});
		return { text: sanitizeBinaryOutput(decoded), bytesRead, totalBytes, truncated: totalBytes > bytesRead };
	} finally {
		await file.close();
	}
}
