/**
 * HTTP + WebSocket server for the pie Web UI.
 *
 * Security model: the server binds to a loopback address, every /api request
 * needs a Bearer token, the WebSocket handshake needs the same token as query
 * param (browsers cannot set headers), Host must be loopback, and mutating
 * requests with an Origin header must be same-origin. JSON bodies are capped.
 */

import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import {
	parseAddWorkspace,
	parseExtensionUIResponse,
	parsePrompt,
	parseSelectSession,
	parseSessionName,
	parseSetModel,
	parseSetThinkingLevel,
	ProtocolError,
	type ServerMessage,
} from "../shared/protocol.ts";
import { listWorkspaceSessions, type RuntimeSink, WorkspaceRuntime } from "./runtime.ts";
import { WorkspaceError, type Workspace, type WorkspaceRegistry } from "./workspaces.ts";

const MAX_JSON_BODY = 1_000_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".map": "application/json",
	".woff2": "font/woff2",
};

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

export interface WebServerOptions {
	token: string;
	registry: WorkspaceRegistry;
	createRuntime: (workspace: Workspace, sink: RuntimeSink) => WorkspaceRuntime;
	/** Dev mode: Vite connect middlewares handle non-API requests. */
	middlewares?: Middleware;
	/** Dev mode: returns the transformed index.html (appType "custom" has no SPA fallback). */
	indexHtml?: (urlPath: string) => Promise<string>;
	/** Prod mode: directory of built static assets. */
	staticDir?: string;
}

export interface WebServerHandle {
	server: Server;
	close(): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, message: string): void {
	sendJson(res, status, { error: message });
}

function hostIsLoopback(req: IncomingMessage): boolean {
	const host = req.headers.host;
	if (!host) return false;
	const hostname = host.includes(":") && !host.startsWith("[") ? host.slice(0, host.indexOf(":")) : host;
	return LOOPBACK_HOSTS.has(hostname);
}

/** Requests carrying an Origin header must be same-origin. */
function originAllowed(req: IncomingMessage): boolean {
	const origin = req.headers.origin;
	if (!origin) return true;
	try {
		return new URL(origin).host === req.headers.host;
	} catch {
		return false;
	}
}

function bearerToken(req: IncomingMessage): string | null {
	const header = req.headers.authorization;
	if (!header?.startsWith("Bearer ")) return null;
	return header.slice("Bearer ".length);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > MAX_JSON_BODY) throw new ProtocolError("请求体过大");
		chunks.push(chunk as Buffer);
	}
	if (chunks.length === 0) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
	} catch {
		throw new ProtocolError("请求体不是有效 JSON");
	}
}

export function createWebServer(options: WebServerOptions): WebServerHandle {
	const { token, registry } = options;
	const runtimes = new Map<string, WorkspaceRuntime>();
	const clients = new Set<WebSocket>();
	const refreshTimers = new Map<string, NodeJS.Timeout>();

	function broadcast(message: ServerMessage): void {
		const data = JSON.stringify(message);
		for (const client of clients) {
			if (client.readyState === client.OPEN) client.send(data);
		}
	}

	const sink: RuntimeSink = {
		emitEvent(workspaceId, sessionId, event) {
			broadcast({ type: "event", workspaceId, sessionId, event });
		},
		emitExtensionUI(workspaceId, sessionId, request) {
			broadcast({ type: "extension_ui", workspaceId, sessionId, request });
		},
		emitStatus(workspaceId, status, error) {
			broadcast({ type: "runtime", workspaceId, status, error });
		},
		requestSessionsRefresh(workspaceId) {
			const existing = refreshTimers.get(workspaceId);
			if (existing) clearTimeout(existing);
			refreshTimers.set(
				workspaceId,
				setTimeout(() => {
					refreshTimers.delete(workspaceId);
					const workspace = registry.get(workspaceId);
					if (!workspace) return;
					listWorkspaceSessions(workspace.path)
						.then((sessions) => broadcast({ type: "sessions", workspaceId, sessions }))
						.catch(() => {});
				}, 300),
			);
		},
	};

	function runtimeFor(workspace: Workspace): WorkspaceRuntime {
		let runtime = runtimes.get(workspace.id);
		if (!runtime) {
			runtime = options.createRuntime(workspace, sink);
			runtimes.set(workspace.id, runtime);
		}
		return runtime;
	}

	async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<void> {
		const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]

		if (method === "GET" && url.pathname === "/api/bootstrap") {
			const workspaces = registry.list();
			const sessions: Record<string, unknown> = {};
			for (const ws of workspaces) {
				sessions[ws.id] = await listWorkspaceSessions(ws.path).catch(() => []);
			}
			sendJson(res, 200, { workspaces: workspaces.map((w) => registry.toInfo(w)), sessions });
			return;
		}

		if (method === "POST" && url.pathname === "/api/workspaces") {
			const { path } = parseAddWorkspace(await readJsonBody(req));
			const workspace = await registry.add(path);
			const sessions = await listWorkspaceSessions(workspace.path).catch(() => []);
			broadcast({ type: "workspaces", workspaces: registry.list().map((w) => registry.toInfo(w)) });
			sendJson(res, 201, { workspace: registry.toInfo(workspace), sessions });
			return;
		}

		// /api/workspaces/:id[/action]
		if (parts[1] === "workspaces" && parts.length >= 3) {
			const workspace = registry.get(parts[2]);
			if (!workspace) {
				sendError(res, 404, "未知工作区");
				return;
			}
			const action = parts.length === 4 ? parts[3] : undefined;

			if (method === "DELETE" && !action) {
				const runtime = runtimes.get(workspace.id);
				if (runtime) await runtime.dispose();
				runtimes.delete(workspace.id);
				await registry.remove(workspace.id);
				broadcast({ type: "workspaces", workspaces: registry.list().map((w) => registry.toInfo(w)) });
				sendJson(res, 200, { ok: true });
				return;
			}
			if (method === "GET" && action === "sessions") {
				sendJson(res, 200, { sessions: await listWorkspaceSessions(workspace.path) });
				return;
			}
			if (method === "POST" && action === "new-session") {
				sendJson(res, 200, { snapshot: await runtimeFor(workspace).newSession() });
				return;
			}
			if (method === "POST" && action === "select-session") {
				const { sessionPath } = parseSelectSession(await readJsonBody(req));
				sendJson(res, 200, { snapshot: await runtimeFor(workspace).switchSession(sessionPath) });
				return;
			}
			if (method === "GET" && action === "snapshot") {
				sendJson(res, 200, { snapshot: await runtimeFor(workspace).snapshot() });
				return;
			}
			if (method === "GET" && action === "trajectory") {
				sendJson(res, 200, { trajectory: await runtimeFor(workspace).getTrajectory() });
				return;
			}
			if (method === "POST" && action === "prompt") {
				const { message } = parsePrompt(await readJsonBody(req));
				sendJson(res, 200, await runtimeFor(workspace).prompt(message));
				return;
			}
			if (method === "POST" && action === "abort") {
				await runtimeFor(workspace).abort();
				sendJson(res, 200, { ok: true });
				return;
			}
			if (method === "POST" && action === "model") {
				const { provider, modelId } = parseSetModel(await readJsonBody(req));
				sendJson(res, 200, await runtimeFor(workspace).setModel(provider, modelId));
				return;
			}
			if (method === "POST" && action === "thinking-level") {
				const { level } = parseSetThinkingLevel(await readJsonBody(req));
				sendJson(res, 200, await runtimeFor(workspace).setThinkingLevel(level));
				return;
			}
			if (method === "POST" && action === "session-name") {
				const { name } = parseSessionName(await readJsonBody(req));
				await runtimeFor(workspace).setSessionName(name);
				sendJson(res, 200, { ok: true });
				return;
			}
			if (method === "POST" && action === "extension-ui") {
				runtimeFor(workspace).respondExtensionUI(parseExtensionUIResponse(await readJsonBody(req)));
				sendJson(res, 200, { ok: true });
				return;
			}
		}

		sendError(res, 404, "未知接口");
	}

	const server = createServer((req, res) => {
		void (async () => {
			const method = req.method ?? "GET";
			const url = new URL(req.url ?? "/", "http://localhost");

			if (!hostIsLoopback(req)) {
				sendError(res, 403, "仅允许本机访问");
				return;
			}
			if (url.pathname.startsWith("/api/")) {
				if (bearerToken(req) !== token) {
					sendError(res, 401, "缺少或无效的访问令牌");
					return;
				}
				if (method !== "GET" && !originAllowed(req)) {
					sendError(res, 403, "跨源请求被拒绝");
					return;
				}
				try {
					await handleApi(req, res, url, method);
				} catch (error) {
					if (error instanceof ProtocolError || error instanceof WorkspaceError) {
						sendError(res, 400, error.message);
					} else {
						sendError(res, 500, error instanceof Error ? error.message : "内部错误");
					}
				}
				return;
			}

			if (method !== "GET" && method !== "HEAD") {
				sendError(res, 405, "方法不允许");
				return;
			}
			if (options.middlewares) {
				options.middlewares(req, res, () => {
					void (async () => {
						if (!options.indexHtml) {
							sendError(res, 404, "未找到");
							return;
						}
						try {
							const html = await options.indexHtml(url.pathname);
							res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
							res.end(html);
						} catch {
							sendError(res, 500, "页面渲染失败");
						}
					})();
				});
				return;
			}
			if (options.staticDir) {
				await serveStatic(options.staticDir, url.pathname, res);
				return;
			}
			sendError(res, 404, "未找到");
		})();
	});

	const wss = new WebSocketServer({ noServer: true });
	server.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const authed =
			url.pathname === "/ws" && hostIsLoopback(req) && originAllowed(req) && url.searchParams.get("token") === token;
		if (!authed) {
			socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
			socket.destroy();
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => {
			clients.add(ws);
			ws.on("close", () => clients.delete(ws));
			const hello: ServerMessage = { type: "hello", workspaces: registry.list().map((w) => registry.toInfo(w)) };
			ws.send(JSON.stringify(hello));
			// 重放未答复的扩展 UI 请求与仍在运行的工具事件（断线重连恢复）
			for (const runtime of runtimes.values()) {
				for (const item of runtime.replayPending()) {
					const message: ServerMessage =
						"request" in item
							? {
									type: "extension_ui",
									workspaceId: runtime.workspace.id,
									sessionId: item.sessionId,
									request: item.request,
								}
							: { type: "event", workspaceId: runtime.workspace.id, sessionId: item.sessionId, event: item.event };
					ws.send(JSON.stringify(message));
				}
			}
		});
	});

	return {
		server,
		async close() {
			for (const timer of refreshTimers.values()) clearTimeout(timer);
			refreshTimers.clear();
			for (const client of clients) client.close();
			clients.clear();
			await new Promise<void>((resolve) => wss.close(() => resolve()));
			await Promise.all([...runtimes.values()].map((r) => r.dispose()));
			runtimes.clear();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

async function serveStatic(dir: string, pathname: string, res: ServerResponse): Promise<void> {
	const decoded = decodeURIComponent(pathname);
	// 先拒 ..：词法折叠（normalize）与物理解析（realpath 先跟随符号链接）顺序不同，
	// root/link/.. 会逃出 root。拒绝后再做 realpath 包含检查。
	if (decoded.split("/").includes("..")) {
		sendError(res, 403, "路径不允许");
		return;
	}
	const root = await realpath(dir).catch(() => dir);
	let filePath = join(root, normalize(decoded));
	let real = await realpath(filePath).catch(() => null);
	let info = real ? await stat(real).catch(() => null) : null;
	if (!info?.isFile() || (real !== root && !real!.startsWith(root + sep))) {
		// SPA fallback
		filePath = join(root, "index.html");
		real = await realpath(filePath).catch(() => null);
		info = real ? await stat(real).catch(() => null) : null;
	}
	if (!info || !real) {
		sendError(res, 404, "未找到");
		return;
	}
	res.writeHead(200, { "content-type": CONTENT_TYPES[extname(real)] ?? "application/octet-stream" });
	createReadStream(real).pipe(res);
}
