/**
 * Minimal JSONL client for the coding agent's RPC mode (`--mode rpc`).
 *
 * Self-contained on purpose: it speaks the documented stdin/stdout protocol
 * directly instead of importing packages/coding-agent internals, so the web
 * host typechecks and runs independently of the package build state.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { isRecord } from "../shared/protocol.ts";

export type AgentEventListener = (event: Record<string, unknown>) => void;

const REQUEST_TIMEOUT_MS = 60_000;
const STDERR_TAIL = 2000;

export class AgentProcess {
	private child: ChildProcess | null = null;
	private pending = new Map<string, { resolve: (data: unknown) => void; reject: (error: Error) => void }>();
	private listeners: AgentEventListener[] = [];
	private requestId = 0;
	private stderr = "";
	private lineBuffer = "";
	private exitError: Error | null = null;

	private readonly cliPath: string;
	private readonly cwd: string;

	constructor(options: { cliPath: string; cwd: string }) {
		this.cliPath = options.cliPath;
		this.cwd = options.cwd;
	}

	get running(): boolean {
		return this.child !== null && this.child.exitCode === null && !this.exitError;
	}

	async start(): Promise<void> {
		if (this.child) throw new Error("代理进程已启动");
		this.exitError = null;
		const child = spawn("node", [this.cliPath, "--mode", "rpc"], {
			cwd: this.cwd,
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;

		child.stderr?.on("data", (data) => {
			// 只保留尾部，避免长期运行的代理把内存吃满。
			this.stderr = (this.stderr + String(data)).slice(-STDERR_TAIL * 2);
		});
		child.once("exit", (code, signal) => {
			if (this.child !== child) return;
			this.exitError = new Error(`代理进程退出 (code=${code} signal=${signal})。${this.stderrTail()}`);
			this.rejectAll(this.exitError);
		});
		child.once("error", (error) => {
			if (this.child !== child) return;
			this.exitError = new Error(`代理进程错误: ${error.message}。${this.stderrTail()}`);
			this.rejectAll(this.exitError);
		});
		child.stdout?.setEncoding("utf-8");
		child.stdout?.on("data", (data: string) => this.onStdoutData(data));

		await new Promise((resolve) => setTimeout(resolve, 100));
		if (child.exitCode !== null) {
			throw this.exitError ?? new Error(`代理进程启动失败 (code=${child.exitCode})。${this.stderrTail()}`);
		}
	}

	onEvent(listener: AgentEventListener): () => void {
		this.listeners.push(listener);
		return () => {
			const index = this.listeners.indexOf(listener);
			if (index !== -1) this.listeners.splice(index, 1);
		};
	}

	/** Send a command and resolve with its `data` payload; rejects on error responses. */
	call(command: Record<string, unknown>): Promise<unknown> {
		const id = `req_${++this.requestId}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`等待 ${String(command.type)} 响应超时。${this.stderrTail()}`));
			}, REQUEST_TIMEOUT_MS);
			this.pending.set(id, {
				resolve: (data) => {
					clearTimeout(timer);
					resolve(data);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			try {
				this.write({ ...command, id });
			} catch (error) {
				this.pending.delete(id);
				clearTimeout(timer);
				reject(error);
			}
		});
	}

	/** Answer an extension UI request (no response is expected). */
	respondExtensionUI(response: Record<string, unknown>): void {
		this.write({ type: "extension_ui_response", ...response });
	}

	async stop(): Promise<void> {
		const child = this.child;
		if (!child) return;
		child.kill("SIGTERM");
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				resolve();
			}, 1000);
			child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
		if (this.child === child) this.child = null;
		this.pending.clear();
	}

	private onStdoutData(data: string): void {
		this.lineBuffer += data;
		for (;;) {
			const index = this.lineBuffer.indexOf("\n");
			if (index === -1) break;
			const line = this.lineBuffer.slice(0, index).trim();
			this.lineBuffer = this.lineBuffer.slice(index + 1);
			if (!line) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}
			this.handleRecord(parsed);
		}
	}

	private handleRecord(data: unknown): void {
		if (!isRecord(data)) return;
		if (data.type === "response" && typeof data.id === "string") {
			const pending = this.pending.get(data.id);
			if (!pending) return;
			this.pending.delete(data.id);
			if (data.success === false) {
				pending.reject(new Error(typeof data.error === "string" ? data.error : "RPC 命令失败"));
			} else {
				pending.resolve(data.data);
			}
			return;
		}
		for (const listener of [...this.listeners]) listener(data);
	}

	private write(record: Record<string, unknown>): void {
		const child = this.child;
		if (!child?.stdin) throw new Error("代理进程未启动");
		if (this.exitError) throw this.exitError;
		if (child.exitCode !== null || child.stdin.destroyed || !child.stdin.writable) {
			throw new Error(`代理进程不可写。${this.stderrTail()}`);
		}
		child.stdin.write(`${JSON.stringify(record)}\n`);
	}

	private rejectAll(error: Error): void {
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}

	private stderrTail(): string {
		const tail = this.stderr.slice(-STDERR_TAIL).trim();
		return tail ? `stderr: ${tail}` : "";
	}
}
