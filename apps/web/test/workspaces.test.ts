import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceError, WorkspaceRegistry, workspaceIdFor } from "../host/workspaces.ts";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "pie-web-ws-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function registry(): WorkspaceRegistry {
	return new WorkspaceRegistry(join(dir, "config", "workspaces.json"), join(dir, "default"));
}

describe("WorkspaceRegistry", () => {
	it("load() 始终包含默认 cwd（realpath 后）", async () => {
		await mkdir(join(dir, "default"), { recursive: true });
		const reg = registry();
		await reg.load();
		const list = reg.list();
		expect(list).toHaveLength(1);
		expect(list[0].isDefault).toBe(true);
		expect(list[0].path).toBe(await realpath(join(dir, "default")));
		expect(list[0].id).toBe(workspaceIdFor(await realpath(join(dir, "default"))));
	});

	it("add() 拒绝相对路径、缺失路径和普通文件", async () => {
		await mkdir(join(dir, "default"), { recursive: true });
		const reg = registry();
		await reg.load();
		await expect(reg.add("relative/path")).rejects.toThrow(WorkspaceError);
		await expect(reg.add(join(dir, "nope"))).rejects.toThrow(WorkspaceError);
		const file = join(dir, "file.txt");
		await writeFile(file, "x");
		await expect(reg.add(file)).rejects.toThrow(WorkspaceError);
	});

	it("add() 解析符号链接并按 realpath 去重", async () => {
		await mkdir(join(dir, "default"), { recursive: true });
		await mkdir(join(dir, "proj"));
		await symlink(join(dir, "proj"), join(dir, "proj-link"));
		const reg = registry();
		await reg.load();
		const a = await reg.add(join(dir, "proj"));
		const b = await reg.add(join(dir, "proj-link"));
		expect(a.id).toBe(b.id);
		expect(reg.list()).toHaveLength(2);
	});

	it("add/remove 持久化到专用 JSON，重启后恢复且不覆盖其他设置", async () => {
		await mkdir(join(dir, "default"), { recursive: true });
		await mkdir(join(dir, "proj"));
		const reg = registry();
		await reg.load();
		await reg.add(join(dir, "proj"));

		// 旁边的其他设置文件不受影响
		const other = join(dir, "config", "settings.json");
		await writeFile(other, '{"theme":"dark"}');

		const reg2 = registry();
		await reg2.load();
		expect(reg2.list().map((w) => w.path)).toEqual(reg.list().map((w) => w.path));

		const proj = reg2.list().find((w) => !w.isDefault)!;
		await reg2.remove(proj.id);
		expect(reg2.list()).toHaveLength(1);
		await expect(reg2.remove(reg2.list()[0].id)).rejects.toThrow(WorkspaceError);
	});

	it("load() 跳过已被删除的持久化工作区", async () => {
		await mkdir(join(dir, "default"), { recursive: true });
		await mkdir(join(dir, "gone"));
		const reg = registry();
		await reg.load();
		await reg.add(join(dir, "gone"));
		await rm(join(dir, "gone"), { recursive: true });

		const reg2 = registry();
		await reg2.load();
		expect(reg2.list()).toHaveLength(1);
	});
});
