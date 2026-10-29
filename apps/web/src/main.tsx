import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { hasToken, StoreProvider } from "./state/store.tsx";
import "./styles/global.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root 缺失");

if (!hasToken()) {
	rootEl.innerHTML =
		'<div style="padding:48px;text-align:center;font-family:sans-serif">' +
		"<h2>缺少访问令牌</h2><p>请使用 host 启动时打印的带 token 的 URL 打开本页面。</p></div>";
} else {
	createRoot(rootEl).render(
		<StrictMode>
			<StoreProvider>
				<App />
			</StoreProvider>
		</StrictMode>,
	);
}
