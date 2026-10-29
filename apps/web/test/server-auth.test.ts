import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { RuntimeSink, WorkspaceRuntime } from "../host/runtime.ts";
import { createWebServer, type WebServerHandle } from "../host/server.ts";
import { WorkspaceRegistry, type Workspace } from "../host/workspaces.ts";

const TOKEN = "test-token";

let dir: string;
let handle: WebServerHandle;
let baseUrl: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "pie-web-srv-"));
	await mkdir(join(dir, "default"), { recursive: true });
	const registry = new WorkspaceRegistry(join(dir, "config", "workspaces.json"), join(dir, "default"));
	await registry.load();
	handle = createWebServer({
		token: TOKEN,
		registry,
		// 鉴权测试不触碰 agent 进程
		createRuntime: (_workspace: Workspace, _sink: RuntimeSink): WorkspaceRuntime => {
			throw new Error("测试不应启动代理进程");
		},
	});
	await new Promise<void>((resolve) => handle.server.listen(0, "127.0.0.1", () => resolve()));
	const address = handle.server.address();
	baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterEach(async () => {
	await handle.close();
	await rm(dir, { recursive: true, force: true });
});

function api(path: string, init?: RequestInit): Promise<Response> {
	return fetch(`${baseUrl}${path}`, init);
}

describe("HTTP 鉴权", () => {
	it("无 token 的 /api 请求返回 401", async () => {
		const res = await api("/api/bootstrap");
		expect(res.status).toBe(401);
	});

	it("正确 Bearer token 返回 200 且包含默认工作区", async () => {
		const res = await api("/api/bootstrap", { headers: { authorization: `Bearer ${TOKEN}` } });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { workspaces: { isDefault: boolean }[] };
		expect(body.workspaces).toHaveLength(1);
		expect(body.workspaces[0].isDefault).toBe(true);
	});

	it("非 loopback Host 被拒绝", async () => {
		// undici 不允许覆盖 Host 头，用原始 http 请求发送伪造 Host
		const status = await new Promise<number>((resolve, reject) => {
			const req = httpRequest(`${baseUrl}/api/bootstrap`, {
				headers: { authorization: `Bearer ${TOKEN}`, host: "evil.example.com" },
			});
			req.on("response", (res) => {
				res.resume();
				resolve(res.statusCode ?? 0);
			});
			req.on("error", reject);
			req.end();
		});
		expect(status).toBe(403);
	});

	it("带 Origin 的跨源 POST 被拒绝", async () => {
		const res = await api("/api/workspaces", {
			method: "POST",
			headers: {
				authorization: `Bearer ${TOKEN}`,
				"content-type": "application/json",
				origin: "http://evil.example.com",
			},
			body: JSON.stringify({ path: dir }),
		});
		expect(res.status).toBe(403);
	});

	it("同源 Origin 的 POST 被接受", async () => {
		const res = await api("/api/workspaces", {
			method: "POST",
			headers: {
				authorization: `Bearer ${TOKEN}`,
				"content-type": "application/json",
				origin: baseUrl,
			},
			body: JSON.stringify({ path: join(dir, "default") }),
		});
		expect(res.status).toBe(201);
	});

	it("非法 JSON body 返回 400", async () => {
		const res = await api("/api/workspaces", {
			method: "POST",
			headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
			body: "not-json",
		});
		expect(res.status).toBe(400);
	});

	it("未知 API 路由返回 404", async () => {
		const res = await api("/api/nope", { headers: { authorization: `Bearer ${TOKEN}` } });
		expect(res.status).toBe(404);
	});
});

describe("WebSocket 鉴权", () => {
	it("无 token 的 WS 握手被拒绝", async () => {
		await expect(
			new Promise((resolve, reject) => {
				const ws = new WebSocket(`${baseUrl.replace("http", "ws")}/ws`);
				ws.on("open", () => resolve(null));
				ws.on("error", reject);
			}),
		).rejects.toThrow();
	});

	it("正确 token 的 WS 收到 hello", async () => {
		const ws = new WebSocket(`${baseUrl.replace("http", "ws")}/ws?token=${TOKEN}`);
		const message = await new Promise<string>((resolve, reject) => {
			ws.on("message", (data) => resolve(String(data)));
			ws.on("error", reject);
		});
		ws.close();
		const parsed = JSON.parse(message);
		expect(parsed.type).toBe("hello");
		expect(parsed.workspaces).toHaveLength(1);
	});
});
