import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The dev server never runs standalone: host/main.ts embeds Vite in
// middleware mode so one process serves API, WebSocket and the page.
// root 固定为本文件所在目录，与启动 cwd 无关。
const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	root,
	esbuild: { jsx: "automatic" },
	appType: "custom",
	server: { middlewareMode: true },
	build: { outDir: "dist" },
});
