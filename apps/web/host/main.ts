/**
 * Entry point for the pie Web UI host.
 *
 *   node host/main.ts [--dev] [--port N] [--bind ADDR]
 *
 * One process serves the HTTP API, the WebSocket event stream, and either the
 * Vite dev middlewares (--dev) or the built static assets (apps/web/dist).
 * A random access token is generated per start and printed once in the URL;
 * it is never written to disk or log files.
 */

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createServer as createViteServer } from "vite";
import { WorkspaceRuntime } from "./runtime.ts";
import { createWebServer } from "./server.ts";
import { WorkspaceRegistry } from "./workspaces.ts";

const DEFAULT_PORT = 5277;

interface CliOptions {
	dev: boolean;
	port: number;
	bind: string;
	agentCli?: string;
}

function parseArgs(argv: string[]): CliOptions {
	let dev = false;
	let port = Number(process.env.PIE_WEB_PORT ?? DEFAULT_PORT);
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new Error(`无效端口: ${process.env.PIE_WEB_PORT}`);
	}
	let bind = "127.0.0.1";
	let agentCli: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--dev") {
			dev = true;
		} else if (arg === "--port") {
			const value = Number(argv[++i]);
			if (!Number.isInteger(value) || value < 0 || value > 65535) {
				throw new Error(`无效端口: ${argv[i]}`);
			}
			port = value;
		} else if (arg === "--bind") {
			bind = argv[++i] ?? "";
			if (!bind) throw new Error("--bind 需要一个地址");
		} else if (arg === "--agent-cli") {
			agentCli = argv[++i];
			if (!agentCli) throw new Error("--agent-cli 需要一个路径");
		} else {
			throw new Error(`未知参数: ${arg}`);
		}
	}
	return { dev, port, bind, agentCli: agentCli ?? process.env.PIE_WEB_AGENT_CLI };
}

function resolveAgentCliPath(): string {
	const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	// dist/index.js -> package root
	const pkgDir = dirname(dirname(entry));
	return join(pkgDir, "dist", "bundle", "cli.js");
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	const token = randomBytes(18).toString("base64url");
	// 子进程以各工作区为 cwd，cli 路径必须是绝对路径
	const rawCli = options.agentCli ?? resolveAgentCliPath();
	const cliPath = isAbsolute(rawCli) ? rawCli : resolve(process.cwd(), rawCli);
	const appDir = dirname(fileURLToPath(import.meta.url)); // apps/web/host

	const registry = new WorkspaceRegistry(join(getAgentDir(), "pie-web-workspaces.json"), process.cwd());
	await registry.load();

	const vite = options.dev
		? await createViteServer({ configFile: join(appDir, "..", "vite.config.ts") })
		: undefined;
	const indexHtmlPath = join(appDir, "..", "index.html");

	const handle = createWebServer({
		token,
		registry,
		createRuntime: (workspace, sink) => new WorkspaceRuntime(workspace, cliPath, sink),
		middlewares: vite ? (req, res, next) => vite.middlewares(req, res, next) : undefined,
		indexHtml: vite
			? async (urlPath) => vite.transformIndexHtml(urlPath, await readFile(indexHtmlPath, "utf-8"))
			: undefined,
		staticDir: options.dev ? undefined : join(appDir, "..", "dist"),
	});

	await new Promise<void>((resolve, reject) => {
		handle.server.once("error", reject);
		handle.server.listen(options.port, options.bind, () => resolve());
	});

	const address = handle.server.address();
	const port = typeof address === "object" && address ? address.port : options.port;
	const url = `http://${options.bind}:${port}/?token=${token}`;
	console.log(`pie Web UI 已启动: ${url}`);
	console.log("提示: 令牌仅本次有效，请从上方 URL 打开；不要把令牌写入文件。");

	let closing = false;
	const shutdown = () => {
		if (closing) return;
		closing = true;
		void (async () => {
			await handle.close();
			await vite?.close();
			process.exit(0);
		})();
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main().catch((error) => {
	console.error(`启动失败: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
