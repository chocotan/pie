/**
 * Browser client for the pie Web UI host: token handling, typed HTTP calls
 * and the WebSocket event stream.
 */

import type {
	ConversationSnapshot,
	ExtensionUIResponse,
	ModelOption,
	ServerMessage,
	SessionConfigDto,
	SessionSummary,
	ThinkingLevel,
	TrajectoryDto,
	WorkspaceInfo,
} from "../shared/protocol.ts";

const TOKEN_KEY = "pie-web-token";

/**
 * The host prints the URL with a one-time token query param. We move it to
 * sessionStorage and strip it from the address bar so it does not leak via
 * bookmarks or screenshots.
 */
export function getToken(): string | null {
	const params = new URLSearchParams(window.location.search);
	const fromUrl = params.get("token");
	if (fromUrl) {
		sessionStorage.setItem(TOKEN_KEY, fromUrl);
		params.delete("token");
		const search = params.toString();
		history.replaceState(null, "", window.location.pathname + (search ? `?${search}` : ""));
		return fromUrl;
	}
	return sessionStorage.getItem(TOKEN_KEY);
}

export class ApiError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

async function apiFetch<T>(path: string, options?: { method?: string; body?: unknown }): Promise<T> {
	const token = getToken();
	const res = await fetch(path, {
		method: options?.method ?? "GET",
		headers: {
			authorization: `Bearer ${token ?? ""}`,
			...(options?.body !== undefined ? { "content-type": "application/json" } : {}),
		},
		body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
	});
	if (!res.ok) {
		let message = `请求失败（${res.status}）`;
		try {
			const body = (await res.json()) as { error?: string };
			if (body.error) message = body.error;
		} catch {
			// 保留默认错误信息
		}
		throw new ApiError(res.status, message);
	}
	return (await res.json()) as T;
}

export interface Bootstrap {
	workspaces: WorkspaceInfo[];
	sessions: Record<string, SessionSummary[]>;
}

export const api = {
	bootstrap: () => apiFetch<Bootstrap>("/api/bootstrap"),
	addWorkspace: (path: string) =>
		apiFetch<{ workspace: WorkspaceInfo; sessions: SessionSummary[] }>("/api/workspaces", {
			method: "POST",
			body: { path },
		}),
	removeWorkspace: (workspaceId: string) =>
		apiFetch<{ ok: true }>(`/api/workspaces/${workspaceId}`, { method: "DELETE" }),
	listSessions: (workspaceId: string) =>
		apiFetch<{ sessions: SessionSummary[] }>(`/api/workspaces/${workspaceId}/sessions`),
	snapshot: (workspaceId: string) =>
		apiFetch<{ snapshot: ConversationSnapshot }>(`/api/workspaces/${workspaceId}/snapshot`),
	trajectory: (workspaceId: string) =>
		apiFetch<{ trajectory: TrajectoryDto }>(`/api/workspaces/${workspaceId}/trajectory`),
	newSession: (workspaceId: string) =>
		apiFetch<{ snapshot: ConversationSnapshot }>(`/api/workspaces/${workspaceId}/new-session`, { method: "POST" }),
	selectSession: (workspaceId: string, sessionPath: string) =>
		apiFetch<{ snapshot: ConversationSnapshot }>(`/api/workspaces/${workspaceId}/select-session`, {
			method: "POST",
			body: { sessionPath },
		}),
	prompt: (workspaceId: string, message: string) =>
		apiFetch<{ disposition: string }>(`/api/workspaces/${workspaceId}/prompt`, {
			method: "POST",
			body: { message },
		}),
	abort: (workspaceId: string) =>
		apiFetch<{ ok: true }>(`/api/workspaces/${workspaceId}/abort`, { method: "POST" }),
	setModel: (workspaceId: string, provider: string, modelId: string) =>
		apiFetch<SessionConfigDto>(`/api/workspaces/${workspaceId}/model`, {
			method: "POST",
			body: { provider, modelId },
		}),
	setThinkingLevel: (workspaceId: string, level: ThinkingLevel) =>
		apiFetch<SessionConfigDto>(`/api/workspaces/${workspaceId}/thinking-level`, {
			method: "POST",
			body: { level },
		}),
	setSessionName: (workspaceId: string, name: string) =>
		apiFetch<{ ok: true }>(`/api/workspaces/${workspaceId}/session-name`, { method: "POST", body: { name } }),
	respondExtensionUI: (workspaceId: string, response: ExtensionUIResponse) =>
		apiFetch<{ ok: true }>(`/api/workspaces/${workspaceId}/extension-ui`, { method: "POST", body: response }),
};

export type { ModelOption };

/** Connect the event stream. Reconnects with backoff until `close` is called. */
export function connectEvents(onMessage: (message: ServerMessage) => void, onStatus: (connected: boolean) => void): {
	close: () => void;
} {
	let ws: WebSocket | null = null;
	let closed = false;
	let attempts = 0;
	let timer: number | undefined;

	function connect(): void {
		if (closed) return;
		const token = getToken();
		const proto = window.location.protocol === "https:" ? "wss" : "ws";
		ws = new WebSocket(`${proto}://${window.location.host}/ws?token=${encodeURIComponent(token ?? "")}`);
		ws.onopen = () => {
			attempts = 0;
			onStatus(true);
		};
		ws.onmessage = (event) => {
			try {
				onMessage(JSON.parse(String(event.data)) as ServerMessage);
			} catch {
				// 忽略无法解析的消息
			}
		};
		ws.onclose = () => {
			onStatus(false);
			if (!closed) {
				const delay = Math.min(5000, 500 * 2 ** attempts++);
				timer = window.setTimeout(connect, delay);
			}
		};
	}
	connect();

	return {
		close() {
			closed = true;
			window.clearTimeout(timer);
			ws?.close();
		},
	};
}
