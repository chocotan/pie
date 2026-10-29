import { useState } from "react";
import type { ReactElement } from "react";
import type { SessionSummary, WorkspaceInfo } from "../../shared/protocol.ts";
import { useStore } from "../state/store.tsx";
import { Icon } from "./Icon.tsx";
import styles from "./Sidebar.module.css";

function sessionTitle(session: SessionSummary): string {
	if (session.name) return session.name;
	const first = session.firstMessage.trim().replace(/\s+/g, " ");
	if (!first) return "新会话";
	return first.length > 30 ? `${first.slice(0, 30)}…` : first;
}

function formatTime(iso: string): string {
	const date = new Date(iso);
	const now = new Date();
	const sameDay = date.toDateString() === now.toDateString();
	return sameDay
		? date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
		: date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

const THEME_CYCLE = [
	{ key: "light", label: "浅色", icon: "sun" },
	{ key: "dark", label: "深色", icon: "moon" },
	{ key: "system", label: "跟随系统", icon: "monitor" },
] as const;

function AddWorkspace(): ReactElement {
	const { actions } = useStore();
	const [open, setOpen] = useState(false);
	const [path, setPath] = useState("");
	const [busy, setBusy] = useState(false);

	if (!open) {
		return (
			<button className={styles.addToggle} onClick={() => setOpen(true)}>
				<Icon name="plus" />
				添加工作区
			</button>
		);
	}
	return (
		<form
			className={styles.addForm}
			onSubmit={(e) => {
				e.preventDefault();
				if (!path.trim()) return;
				setBusy(true);
				void actions
					.addWorkspace(path.trim())
					.then(() => {
						setOpen(false);
						setPath("");
					})
					.finally(() => setBusy(false));
			}}
		>
			<input
				value={path}
				onChange={(e) => setPath(e.target.value)}
				placeholder="绝对路径，如 /home/me/project"
				aria-label="工作区绝对路径"
				autoFocus
			/>
			<div className={styles.addRow}>
				<button type="button" className={styles.addCancel} onClick={() => setOpen(false)}>
					取消
				</button>
				<button type="submit" className={styles.addBtn} disabled={busy || !path.trim()}>
					添加
				</button>
			</div>
		</form>
	);
}

function SessionItem(props: { workspaceId: string; session: SessionSummary }): ReactElement {
	const { state, actions } = useStore();
	const convo = state.convos[props.workspaceId];
	const active =
		state.activeWorkspaceId === props.workspaceId && convo !== undefined && isCurrentSession(convo.sessionId, props.session);
	const [renaming, setRenaming] = useState(false);
	const [draft, setDraft] = useState("");
	const busy = convo?.streaming === true;

	function onClick(): void {
		if (busy) return;
		if (state.activeWorkspaceId !== props.workspaceId) {
			actions.selectWorkspace(props.workspaceId);
		}
		void actions.selectSession(props.session.path);
	}

	return (
		<button
			className="session-item"
			aria-current={active}
			onClick={onClick}
			onDoubleClick={() => {
				if (!active) return;
				setDraft(props.session.name ?? "");
				setRenaming(true);
			}}
			title={busy ? "生成中，暂不能切换会话" : props.session.path}
			disabled={busy && !active}
		>
			{renaming ? (
				<input
					className={styles.renameInput}
					value={draft}
					aria-label="会话名称"
					autoFocus
					onChange={(e) => setDraft(e.target.value)}
					onClick={(e) => e.stopPropagation()}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							setRenaming(false);
							if (draft.trim()) void actions.renameSession(draft.trim());
						} else if (e.key === "Escape") {
							setRenaming(false);
						}
					}}
					onBlur={() => setRenaming(false)}
				/>
			) : (
				<span className="t">{sessionTitle(props.session)}</span>
			)}
			{props.session.messageCount > 0 && <span className={styles.sessionMeta}>{formatTime(props.session.modifiedAt)}</span>}
		</button>
	);
}

function isCurrentSession(convoSessionId: string, session: SessionSummary): boolean {
	return convoSessionId === session.id;
}

function WorkspaceSection(props: { workspace: WorkspaceInfo }): ReactElement {
	const { state, actions } = useStore();
	const collapsed = state.collapsedWs[props.workspace.id] === true;
	const active = state.activeWorkspaceId === props.workspace.id;
	const status = state.runtimeStatus[props.workspace.id] ?? "stopped";
	const sessions = state.sessionsByWs[props.workspace.id] ?? [];

	return (
		<div>
			<div
				className={styles.wsRow}
				aria-current={active}
				role="button"
				tabIndex={0}
				onClick={() => {
					if (!active) actions.selectWorkspace(props.workspace.id);
					else actions.toggleWorkspaceCollapsed(props.workspace.id);
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						if (!active) actions.selectWorkspace(props.workspace.id);
						else actions.toggleWorkspaceCollapsed(props.workspace.id);
					}
				}}
			>
				<span className={styles.wsChevron} data-open={!collapsed}>
					<Icon name="chev" />
				</span>
				<Icon name="folder" />
				<span className={styles.wsName} title={props.workspace.path}>
					{props.workspace.name}
				</span>
				<span className={styles.wsStatus} data-status={status} title={`代理状态: ${status}`} />
				{!props.workspace.isDefault && (
					<span
						className={styles.wsRemove}
						role="button"
						tabIndex={-1}
						aria-label={`移除工作区 ${props.workspace.name}`}
						onClick={(e) => {
							e.stopPropagation();
							void actions.removeWorkspace(props.workspace.id);
						}}
					>
						<Icon name="x" />
					</span>
				)}
			</div>
			{!collapsed && (
				<div className={styles.wsSessions}>
					{sessions.length === 0 && <div className={styles.wsEmpty}>暂无会话</div>}
					{sessions.map((session) => (
						<SessionItem key={session.path} workspaceId={props.workspace.id} session={session} />
					))}
				</div>
			)}
		</div>
	);
}

export function Sidebar(): ReactElement {
	const { state, actions } = useStore();
	const activeConvo = state.activeWorkspaceId ? state.convos[state.activeWorkspaceId] : undefined;
	const themeIndex = THEME_CYCLE.findIndex((t) => t.key === state.theme);
	const theme = THEME_CYCLE[themeIndex] ?? THEME_CYCLE[2];

	return (
		<aside className="sidebar" data-open={state.sidebarOpen} aria-label="工作区与会话列表">
			<div className="brand">
				<span className="logo">
					<Icon name="pie" />
				</span>
				<span>pie</span>
			</div>
			<button className="new-chat" onClick={() => void actions.newSession()} disabled={activeConvo?.streaming === true}>
				<Icon name="plus" />
				新会话
			</button>
			<nav className="session-list" aria-label="工作区">
				{state.workspaces.map((ws) => (
					<WorkspaceSection key={ws.id} workspace={ws} />
				))}
				<AddWorkspace />
			</nav>

			<div className="rail-only">
				<button
					className="icon-btn"
					aria-label="新会话"
					onClick={() => void actions.newSession()}
					disabled={activeConvo?.streaming === true}
				>
					<Icon name="plus" />
				</button>
				{state.workspaces.map((ws) => (
					<button
						key={ws.id}
						className="rail-dot"
						aria-current={state.activeWorkspaceId === ws.id}
						aria-label={`切换到工作区：${ws.name}`}
						title={ws.path}
						onClick={() => actions.selectWorkspace(ws.id)}
					>
						{ws.name.charAt(0)}
					</button>
				))}
				<div className="rail-spacer" />
			</div>

			<div className="sidebar-foot">
				<span className="foot-label">{state.connected ? "已连接" : "连接中断，重连中…"}</span>
				<button
					className="icon-btn"
					aria-label={`切换主题（当前：${theme.label}）`}
					title={`主题：${theme.label}`}
					onClick={() => actions.setTheme(THEME_CYCLE[(themeIndex + 1) % THEME_CYCLE.length].key)}
				>
					<Icon name={theme.icon} />
				</button>
			</div>
		</aside>
	);
}
