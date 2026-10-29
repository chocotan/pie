/**
 * Workspace registry: validates, dedupes and persists the list of workspace
 * directories shown in the Web UI sidebar.
 *
 * Persisted as a dedicated JSON file under the pie config dir (atomic
 * write via tmp + rename) so other settings files are never touched.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute } from "node:path";
import type { WorkspaceInfo } from "../shared/protocol.ts";

export interface Workspace {
	id: string;
	/** Canonical absolute path (symlinks resolved). */
	path: string;
	isDefault: boolean;
}

export function workspaceIdFor(path: string): string {
	return createHash("sha1").update(path).digest("hex").slice(0, 12);
}

export function workspaceDisplayName(path: string): string {
	return basename(path) || path;
}

export class WorkspaceError extends Error {}

interface PersistedShape {
	workspaces?: unknown;
}

export class WorkspaceRegistry {
	private workspaces: Workspace[] = [];
	private writeQueue: Promise<void> = Promise.resolve();

	private readonly filePath: string;
	private readonly defaultCwd: string;

	constructor(filePath: string, defaultCwd: string) {
		this.filePath = filePath;
		this.defaultCwd = defaultCwd;
	}

	list(): Workspace[] {
		return [...this.workspaces];
	}

	get(id: string): Workspace | undefined {
		return this.workspaces.find((w) => w.id === id);
	}

	toInfo(ws: Workspace): WorkspaceInfo {
		return { id: ws.id, path: ws.path, name: workspaceDisplayName(ws.path), isDefault: ws.isDefault };
	}

	/** Canonicalize a user-supplied path; rejects non-absolute paths, missing dirs and files. */
	private async canonicalize(inputPath: string): Promise<string> {
		if (!isAbsolute(inputPath)) {
			throw new WorkspaceError("工作区路径必须是绝对路径");
		}
		let resolved: string;
		try {
			resolved = await realpath(inputPath);
		} catch {
			throw new WorkspaceError(`路径不存在: ${inputPath}`);
		}
		const info = await stat(resolved);
		if (!info.isDirectory()) {
			throw new WorkspaceError(`不是目录: ${inputPath}`);
		}
		return resolved;
	}

	/** Load persisted workspaces, ensuring the default cwd is always present. */
	async load(): Promise<void> {
		const defaultPath = await this.canonicalize(this.defaultCwd);
		const seen = new Set<string>();
		const workspaces: Workspace[] = [{ id: workspaceIdFor(defaultPath), path: defaultPath, isDefault: true }];
		seen.add(defaultPath);

		let persisted: string[] = [];
		try {
			const raw = await readFile(this.filePath, "utf-8");
			const parsed = (JSON.parse(raw) as PersistedShape).workspaces;
			if (Array.isArray(parsed)) {
				persisted = parsed.filter((p): p is string => typeof p === "string");
			}
		} catch {
			// Missing or corrupt file starts with the default workspace only.
		}

		for (const p of persisted) {
			try {
				const resolved = await this.canonicalize(p);
				if (!seen.has(resolved)) {
					seen.add(resolved);
					workspaces.push({ id: workspaceIdFor(resolved), path: resolved, isDefault: false });
				}
			} catch {
				// Dropped workspace directories are skipped silently on load.
			}
		}
		this.workspaces = workspaces;
	}

	async add(inputPath: string): Promise<Workspace> {
		const resolved = await this.canonicalize(inputPath);
		const existing = this.workspaces.find((w) => w.path === resolved);
		if (existing) return existing;
		const ws: Workspace = { id: workspaceIdFor(resolved), path: resolved, isDefault: false };
		this.workspaces.push(ws);
		await this.persist();
		return ws;
	}

	async remove(id: string): Promise<void> {
		const ws = this.get(id);
		if (!ws) throw new WorkspaceError("未知工作区");
		if (ws.isDefault) throw new WorkspaceError("默认工作区（启动目录）不能移除");
		this.workspaces = this.workspaces.filter((w) => w.id !== id);
		await this.persist();
	}

	/** Serialized atomic write; concurrent add/remove calls cannot interleave. */
	private persist(): Promise<void> {
		this.writeQueue = this.writeQueue.then(async () => {
			await mkdir(dirname(this.filePath), { recursive: true });
			const tmp = `${this.filePath}.tmp-${process.pid}`;
			const data = JSON.stringify({ workspaces: this.workspaces.map((w) => w.path) }, null, 2);
			await writeFile(tmp, `${data}\n`, "utf-8");
			await rename(tmp, this.filePath);
		});
		return this.writeQueue;
	}
}
