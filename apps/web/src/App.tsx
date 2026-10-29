import { useEffect } from "react";
import type { ReactElement } from "react";
import { ChatHeader } from "./components/ChatHeader.tsx";
import { Composer } from "./components/Composer.tsx";
import { ExtensionModal } from "./components/ExtensionModal.tsx";
import { IconSprite } from "./components/Icon.tsx";
import { RightPanel } from "./components/RightPanel.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { Thread } from "./components/Thread.tsx";
import { TrajectoryView } from "./components/TrajectoryView.tsx";
import { Toasts } from "./components/Toasts.tsx";
import type { WireMessage } from "../shared/protocol.ts";
import { useStore } from "./state/store.tsx";

function firstUserText(messages: WireMessage[]): string | undefined {
	for (const message of messages) {
		if (message.role !== "user") continue;
		const text =
			typeof message.content === "string"
				? message.content
				: Array.isArray(message.content)
					? message.content
							.map((b) =>
								typeof b === "object" && b !== null && (b as Record<string, unknown>).type === "text"
									? String((b as Record<string, unknown>).text ?? "")
									: "",
							)
							.join(" ")
					: "";
		const trimmed = text.trim().replace(/\s+/g, " ");
		if (trimmed) return trimmed.length > 40 ? `${trimmed.slice(0, 40)}…` : trimmed;
	}
	return undefined;
}

export function App(): ReactElement {
	const { state, actions } = useStore();

	useEffect(() => {
		actions.init();
	}, [actions]);

	// Escape 关闭 drawer
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape" && !state.extUi) {
				actions.setSidebarOpen(false);
				actions.setRightDrawerOpen(false);
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [actions, state.extUi]);

	const convo = state.activeWorkspaceId ? state.convos[state.activeWorkspaceId] : undefined;
	const runtimeStatus = state.activeWorkspaceId ? (state.runtimeStatus[state.activeWorkspaceId] ?? "stopped") : "stopped";
	const title = convo ? (convo.sessionName ?? firstUserText(convo.messages) ?? "新会话") : "pie";
	const scrimOn = state.sidebarOpen || state.rightDrawerOpen;

	return (
		<div className="app">
			<IconSprite />
			<Sidebar />
			<main className="main">
				<ChatHeader title={title} />
				{state.view === "trajectory" ? (
					<TrajectoryView convo={convo} />
				) : convo ? (
					<Thread convo={convo} />
				) : (
					<div className="chat-body">
						<div className="thread">
							<div className="empty-state">
								<div className="big">{state.loading ? "加载中…" : "选择一个工作区"}</div>
								{!state.loading && <div>从左侧选择或添加一个工作区开始。</div>}
							</div>
						</div>
					</div>
				)}
				<Composer convo={convo} runtimeReady={runtimeStatus === "running" || convo !== undefined} />
			</main>
			<RightPanel />
			<div
				className="scrim"
				data-on={scrimOn}
				onClick={() => {
					actions.setSidebarOpen(false);
					actions.setRightDrawerOpen(false);
				}}
			/>
			<ExtensionModal />
			<Toasts />
		</div>
	);
}
