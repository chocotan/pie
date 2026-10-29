/**
 * App state: workspace list + session lists (from HTTP bootstrap / WS push)
 * and one ConvoState per workspace (from snapshots + live events).
 *
 * Async work lives in Actions (created once per app); the reducer is pure.
 */

import { createContext, useContext, useEffect, useMemo, useReducer, useRef } from "react";
import type { ReactNode } from "react";
import type {
	ConversationSnapshot,
	ExtensionUIRequest,
	ExtensionUIResponse,
	RuntimeStatus,
	ServerMessage,
	SessionConfigDto,
	SessionSummary,
	ThinkingLevel,
	TrajectoryEntry,
	WorkspaceInfo,
} from "../../shared/protocol.ts";
import { api, connectEvents, getToken } from "../api.ts";
import { type ConvoState, convoFromSnapshot, reduceEvent } from "./convo-reducer.ts";

export type ThemeSetting = "light" | "dark" | "system";
export type ViewTab = "chat" | "trajectory";
export type RightTab = "tasks" | "agents" | "jobs";

export interface Toast {
	id: number;
	kind: "info" | "warning" | "error";
	text: string;
}

export interface TrajectoryState {
	sessionId: string;
	entries: TrajectoryEntry[];
	loading: boolean;
	error?: string;
}

export interface AppState {
	connected: boolean;
	workspaces: WorkspaceInfo[];
	sessionsByWs: Record<string, SessionSummary[]>;
	runtimeStatus: Record<string, RuntimeStatus>;
	activeWorkspaceId: string | null;
	view: ViewTab;
	convos: Record<string, ConvoState>;
	trajectories: Record<string, TrajectoryState>;
	collapsedWs: Record<string, boolean>;
	rightTab: RightTab;
	rightCollapsed: boolean;
	sidebarOpen: boolean;
	rightDrawerOpen: boolean;
	theme: ThemeSetting;
	toasts: Toast[];
	extUi: { workspaceId: string; request: ExtensionUIRequest } | null;
	loading: boolean;
}

const initialState: AppState = {
	connected: false,
	workspaces: [],
	sessionsByWs: {},
	runtimeStatus: {},
	activeWorkspaceId: null,
	view: "chat",
	convos: {},
	trajectories: {},
	collapsedWs: {},
	rightTab: "tasks",
	rightCollapsed: false,
	sidebarOpen: false,
	rightDrawerOpen: false,
	theme: ((): ThemeSetting => {
		const saved = localStorage.getItem("pie-web-theme");
		return saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
	})(),
	toasts: [],
	extUi: null,
	loading: true,
};

export type Action =
	| { type: "connected"; connected: boolean }
	| { type: "bootstrap"; workspaces: WorkspaceInfo[]; sessions: Record<string, SessionSummary[]> }
	| { type: "workspaces"; workspaces: WorkspaceInfo[] }
	| { type: "sessions"; workspaceId: string; sessions: SessionSummary[] }
	| { type: "runtime"; workspaceId: string; status: RuntimeStatus }
	| { type: "snapshot"; snapshot: ConversationSnapshot }
	| { type: "trajectory_loading"; workspaceId: string }
	| { type: "trajectory"; workspaceId: string; sessionId: string; entries: TrajectoryEntry[] }
	| { type: "trajectory_error"; workspaceId: string; error: string }
	| { type: "config"; workspaceId: string; config: SessionConfigDto }
	| { type: "stats"; workspaceId: string; stats: ConversationSnapshot["stats"] }
	| { type: "event"; workspaceId: string; sessionId: string; event: Parameters<typeof reduceEvent>[1] }
	| { type: "extension_ui"; workspaceId: string; request: ExtensionUIRequest }
	| { type: "extension_ui_done" }
	| { type: "select_workspace"; workspaceId: string }
	| { type: "set_view"; view: ViewTab }
	| { type: "set_right_tab"; tab: RightTab }
	| { type: "toggle_right" }
	| { type: "set_sidebar_open"; open: boolean }
	| { type: "set_right_drawer_open"; open: boolean }
	| { type: "toggle_ws_collapsed"; workspaceId: string }
	| { type: "set_theme"; theme: ThemeSetting }
	| { type: "toast"; toast: Toast }
	| { type: "dismiss_toast"; id: number };

function reduce(state: AppState, action: Action): AppState {
	switch (action.type) {
		case "connected":
			return { ...state, connected: action.connected };
		case "bootstrap":
			return {
				...state,
				workspaces: action.workspaces,
				sessionsByWs: action.sessions,
				activeWorkspaceId: state.activeWorkspaceId ?? action.workspaces[0]?.id ?? null,
				loading: false,
			};
		case "workspaces": {
			const active =
				state.activeWorkspaceId && action.workspaces.some((w) => w.id === state.activeWorkspaceId)
					? state.activeWorkspaceId
					: (action.workspaces[0]?.id ?? null);
			return { ...state, workspaces: action.workspaces, activeWorkspaceId: active };
		}
		case "sessions":
			return { ...state, sessionsByWs: { ...state.sessionsByWs, [action.workspaceId]: action.sessions } };
		case "runtime":
			return { ...state, runtimeStatus: { ...state.runtimeStatus, [action.workspaceId]: action.status } };
		case "snapshot": {
			const convo = convoFromSnapshot(action.snapshot);
			const existing = state.trajectories[action.snapshot.workspaceId];
			return {
				...state,
				convos: { ...state.convos, [action.snapshot.workspaceId]: convo },
				// 会话变了，旧会话的轨迹不能留在新会话上
				trajectories:
					existing && existing.sessionId !== convo.sessionId
						? { ...state.trajectories, [action.snapshot.workspaceId]: { ...existing, entries: [], sessionId: convo.sessionId } }
						: state.trajectories,
			};
		}
		case "trajectory_loading": {
			const existing = state.trajectories[action.workspaceId];
			return {
				...state,
				trajectories: {
					...state.trajectories,
					[action.workspaceId]: { sessionId: existing?.sessionId ?? "", entries: existing?.entries ?? [], loading: true },
				},
			};
		}
		case "trajectory":
			return {
				...state,
				trajectories: {
					...state.trajectories,
					[action.workspaceId]: { sessionId: action.sessionId, entries: action.entries, loading: false },
				},
			};
		case "trajectory_error": {
			const existing = state.trajectories[action.workspaceId];
			return {
				...state,
				trajectories: {
					...state.trajectories,
					[action.workspaceId]: {
						sessionId: existing?.sessionId ?? "",
						entries: existing?.entries ?? [],
						loading: false,
						error: action.error,
					},
				},
			};
		}
		case "config": {
			const convo = state.convos[action.workspaceId];
			if (!convo) return state;
			return {
				...state,
				convos: {
					...state.convos,
					[action.workspaceId]: {
						...convo,
						model: action.config.model,
						thinkingLevel: action.config.thinkingLevel,
						models: action.config.models,
						thinkingLevels: action.config.thinkingLevels,
					},
				},
			};
		}
		case "stats": {
			const convo = state.convos[action.workspaceId];
			if (!convo) return state;
			return { ...state, convos: { ...state.convos, [action.workspaceId]: { ...convo, stats: action.stats } } };
		}
		case "event": {
			const convo = state.convos[action.workspaceId];
			// 事件隔离：只属于当前会话的事件才写入快照
			if (!convo || convo.sessionId !== action.sessionId) return state;
			return {
				...state,
				convos: { ...state.convos, [action.workspaceId]: reduceEvent(convo, action.event) },
			};
		}
		case "extension_ui":
			if (action.request.method === "notify") return state; // notify 走 toast
			return { ...state, extUi: { workspaceId: action.workspaceId, request: action.request } };
		case "extension_ui_done":
			return { ...state, extUi: null };
		case "select_workspace":
			return { ...state, activeWorkspaceId: action.workspaceId, sidebarOpen: false };
		case "set_view":
			return { ...state, view: action.view };
		case "set_right_tab":
			return { ...state, rightTab: action.tab };
		case "toggle_right":
			return { ...state, rightCollapsed: !state.rightCollapsed };
		case "set_sidebar_open":
			return { ...state, sidebarOpen: action.open };
		case "set_right_drawer_open":
			return { ...state, rightDrawerOpen: action.open };
		case "toggle_ws_collapsed":
			return {
				...state,
				collapsedWs: { ...state.collapsedWs, [action.workspaceId]: !state.collapsedWs[action.workspaceId] },
			};
		case "set_theme":
			return { ...state, theme: action.theme };
		case "toast":
			return { ...state, toasts: [...state.toasts.slice(-4), action.toast] };
		case "dismiss_toast":
			return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) };
	}
}

export interface Actions {
	init(): void;
	selectWorkspace(id: string): void;
	addWorkspace(path: string): Promise<void>;
	removeWorkspace(id: string): Promise<void>;
	newSession(): Promise<void>;
	selectSession(sessionPath: string): Promise<void>;
	renameSession(name: string): Promise<void>;
	prompt(text: string): Promise<void>;
	abort(): Promise<void>;
	setModel(provider: string, modelId: string): Promise<void>;
	setThinkingLevel(level: ThinkingLevel): Promise<void>;
	respondExtensionUI(response: ExtensionUIResponse): Promise<void>;
	loadTrajectory(): Promise<void>;
	setView(view: ViewTab): void;
	setRightTab(tab: RightTab): void;
	toggleRight(): void;
	setSidebarOpen(open: boolean): void;
	setRightDrawerOpen(open: boolean): void;
	toggleWorkspaceCollapsed(id: string): void;
	setTheme(theme: ThemeSetting): void;
	pushToast(kind: Toast["kind"], text: string): void;
	dismissToast(id: number): void;
}

const StoreContext = createContext<{ state: AppState; actions: Actions } | null>(null);

export function useStore(): { state: AppState; actions: Actions } {
	const ctx = useContext(StoreContext);
	if (!ctx) throw new Error("StoreContext 缺失");
	return ctx;
}

let toastId = 0;

export function StoreProvider(props: { children: ReactNode }) {
	const [state, dispatch] = useReducer(reduce, initialState);
	const stateRef = useRef(state);
	stateRef.current = state;

	const actions = useMemo<Actions>(() => {
		function pushToast(kind: Toast["kind"], text: string): void {
			const id = ++toastId;
			dispatch({ type: "toast", toast: { id, kind, text } });
			window.setTimeout(() => dispatch({ type: "dismiss_toast", id }), 5000);
		}

		function handleError(error: unknown): void {
			pushToast("error", error instanceof Error ? error.message : String(error));
		}

		function activeWorkspaceId(): string | null {
			return stateRef.current.activeWorkspaceId;
		}

		async function loadSnapshot(workspaceId: string): Promise<void> {
			try {
				const { snapshot } = await api.snapshot(workspaceId);
				dispatch({ type: "snapshot", snapshot });
			} catch (error) {
				handleError(error);
			}
		}

		async function refreshStats(workspaceId: string): Promise<void> {
			try {
				const { snapshot } = await api.snapshot(workspaceId);
				dispatch({ type: "stats", workspaceId, stats: snapshot.stats });
			} catch {
				// 统计刷新失败不打断用户
			}
		}

		async function loadTrajectory(): Promise<void> {
			const workspaceId = activeWorkspaceId();
			if (!workspaceId) return;
			dispatch({ type: "trajectory_loading", workspaceId });
			try {
				const { trajectory } = await api.trajectory(workspaceId);
				dispatch({
					type: "trajectory",
					workspaceId,
					sessionId: trajectory.sessionId,
					entries: trajectory.entries,
				});
			} catch (error) {
				dispatch({
					type: "trajectory_error",
					workspaceId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		function onServerMessage(message: ServerMessage): void {
			switch (message.type) {
				case "hello":
				case "workspaces":
					dispatch({ type: "workspaces", workspaces: message.workspaces });
					break;
				case "sessions":
					dispatch({ type: "sessions", workspaceId: message.workspaceId, sessions: message.sessions });
					break;
				case "runtime":
					dispatch({ type: "runtime", workspaceId: message.workspaceId, status: message.status });
					if (message.status === "error" && message.error) pushToast("error", message.error);
					break;
				case "event":
					dispatch({
						type: "event",
						workspaceId: message.workspaceId,
						sessionId: message.sessionId,
						event: message.event,
					});
					if (message.event.type === "agent_settled") {
						const convo = stateRef.current.convos[message.workspaceId];
						if (convo && convo.sessionId === message.sessionId) void refreshStats(message.workspaceId);
						// 新一轮已落盘：轨迹打开时刷新权威条目
						if (
							stateRef.current.view === "trajectory" &&
							stateRef.current.activeWorkspaceId === message.workspaceId
						) {
							void loadTrajectory();
						}
					}
					break;
				case "extension_ui":
					if (message.request.method === "notify") {
						pushToast(message.request.notifyType === "error" ? "error" : message.request.notifyType === "warning" ? "warning" : "info", message.request.message);
					} else {
						dispatch({ type: "extension_ui", workspaceId: message.workspaceId, request: message.request });
					}
					break;
			}
		}

		// StrictMode 开发模式会双跑 effect，init 必须幂等
		let inited = false;

		return {
			init() {
				if (inited) return;
				inited = true;
				void (async () => {
					try {
						const bootstrap = await api.bootstrap();
						dispatch({ type: "bootstrap", workspaces: bootstrap.workspaces, sessions: bootstrap.sessions });
						const first = bootstrap.workspaces[0];
						if (first) void loadSnapshot(first.id);
					} catch (error) {
						handleError(error);
					}
				})();
				connectEvents(onServerMessage, (connected) => {
					dispatch({ type: "connected", connected });
					// 断线重连后重取已加载工作区的权威快照（host 也会重放未决扩展请求与运行中工具事件）
					if (connected) {
						for (const workspaceId of Object.keys(stateRef.current.convos)) {
							void loadSnapshot(workspaceId);
						}
					}
				});
			},
			selectWorkspace(id) {
				dispatch({ type: "select_workspace", workspaceId: id });
				if (!stateRef.current.convos[id]) void loadSnapshot(id);
			},
			async addWorkspace(path) {
				try {
					const result = await api.addWorkspace(path);
					dispatch({ type: "sessions", workspaceId: result.workspace.id, sessions: result.sessions });
					dispatch({ type: "select_workspace", workspaceId: result.workspace.id });
					if (!stateRef.current.convos[result.workspace.id]) void loadSnapshot(result.workspace.id);
				} catch (error) {
					handleError(error);
				}
			},
			async removeWorkspace(id) {
				try {
					await api.removeWorkspace(id);
				} catch (error) {
					handleError(error);
				}
			},
			async newSession() {
				const id = activeWorkspaceId();
				if (!id) return;
				try {
					const { snapshot } = await api.newSession(id);
					dispatch({ type: "snapshot", snapshot });
					dispatch({ type: "set_view", view: "chat" });
				} catch (error) {
					handleError(error);
				}
			},
			async selectSession(sessionPath) {
				const id = activeWorkspaceId();
				if (!id) return;
				try {
					const { snapshot } = await api.selectSession(id, sessionPath);
					dispatch({ type: "snapshot", snapshot });
					dispatch({ type: "set_view", view: "chat" });
					dispatch({ type: "set_sidebar_open", open: false });
				} catch (error) {
					handleError(error);
				}
			},
			async renameSession(name) {
				const id = activeWorkspaceId();
				if (!id) return;
				try {
					await api.setSessionName(id, name);
					const { snapshot } = await api.snapshot(id);
					dispatch({ type: "snapshot", snapshot });
				} catch (error) {
					handleError(error);
				}
			},
			async prompt(text) {
				const id = activeWorkspaceId();
				if (!id) return;
				try {
					await api.prompt(id, text);
				} catch (error) {
					handleError(error);
				}
			},
			async abort() {
				const id = activeWorkspaceId();
				if (!id) return;
				await api.abort(id).catch(handleError);
			},
			async setModel(provider, modelId) {
				const id = activeWorkspaceId();
				if (!id) return;
				try {
					const config = await api.setModel(id, provider, modelId);
					dispatch({ type: "config", workspaceId: id, config });
				} catch (error) {
					handleError(error);
				}
			},
			async setThinkingLevel(level) {
				const id = activeWorkspaceId();
				if (!id) return;
				try {
					const config = await api.setThinkingLevel(id, level);
					dispatch({ type: "config", workspaceId: id, config });
				} catch (error) {
					handleError(error);
				}
			},
			async respondExtensionUI(response) {
				const extUi = stateRef.current.extUi;
				if (!extUi) return;
				dispatch({ type: "extension_ui_done" });
				try {
					await api.respondExtensionUI(extUi.workspaceId, response);
				} catch (error) {
					handleError(error);
				}
			},
			setView(view) {
				dispatch({ type: "set_view", view });
				if (view === "trajectory") void loadTrajectory();
			},
			setRightTab(tab) {
				dispatch({ type: "set_right_tab", tab });
			},
			toggleRight() {
				dispatch({ type: "toggle_right" });
			},
			setSidebarOpen(open) {
				dispatch({ type: "set_sidebar_open", open });
			},
			setRightDrawerOpen(open) {
				dispatch({ type: "set_right_drawer_open", open });
			},
			toggleWorkspaceCollapsed(id) {
				dispatch({ type: "toggle_ws_collapsed", workspaceId: id });
			},
			setTheme(theme) {
				localStorage.setItem("pie-web-theme", theme);
				dispatch({ type: "set_theme", theme });
			},
			pushToast,
			loadTrajectory,
			dismissToast(id) {
				dispatch({ type: "dismiss_toast", id });
			},
		};
	}, []);

	// 主题应用到 <html data-theme>
	useEffect(() => {
		const root = document.documentElement;
		const media = window.matchMedia("(prefers-color-scheme: dark)");
		const apply = () => {
			const dark = state.theme === "dark" || (state.theme === "system" && media.matches);
			root.dataset.theme = dark ? "dark" : "light";
		};
		apply();
		media.addEventListener("change", apply);
		return () => media.removeEventListener("change", apply);
	}, [state.theme]);

	const value = useMemo(() => ({ state, actions }), [state, actions]);
	return <StoreContext.Provider value={value}>{props.children}</StoreContext.Provider>;
}

export function hasToken(): boolean {
	return getToken() !== null;
}
