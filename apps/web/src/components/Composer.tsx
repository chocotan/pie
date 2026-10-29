import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { ThinkingLevel } from "../../shared/protocol.ts";
import type { ConvoState } from "../state/convo-reducer.ts";
import { useStore } from "../state/store.tsx";
import { Dropdown, type DropdownItem } from "./Dropdown.tsx";
import { Icon } from "./Icon.tsx";

const LEVEL_LABELS: Record<ThinkingLevel, string> = {
	off: "关",
	minimal: "极简",
	low: "低",
	medium: "中",
	high: "高",
	xhigh: "超高",
	max: "最高",
};

function formatTokens(n: number): string {
	return n.toLocaleString("zh-CN");
}

export function Composer(props: { convo: ConvoState | undefined; runtimeReady: boolean }): ReactElement {
	const { actions } = useStore();
	const [text, setText] = useState("");
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const convo = props.convo;
	const streaming = convo?.streaming === true;

	useEffect(() => {
		textareaRef.current?.focus();
	}, [convo?.workspaceId, convo?.sessionId]);

	function autoGrow(): void {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
	}

	function send(): void {
		const message = text.trim();
		if (!message || streaming) return;
		setText("");
		requestAnimationFrame(autoGrow);
		void actions.prompt(message);
	}

	const modelItems: DropdownItem[] = (convo?.models ?? []).map((m) => ({
		key: `${m.provider}/${m.id}`,
		label: m.id,
		meta: m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k` : undefined,
		group: m.provider,
		current: convo?.model?.provider === m.provider && convo?.model?.id === m.id,
		onSelect: () => void actions.setModel(m.provider, m.id),
	}));

	const levelItems: DropdownItem[] = (convo?.thinkingLevels ?? []).map((level) => ({
		key: level,
		label: LEVEL_LABELS[level] ?? level,
		current: convo?.thinkingLevel === level,
		onSelect: () => void actions.setThinkingLevel(level),
	}));

	const context = convo?.stats?.context;
	const percent = context?.percent;
	const tokensTotal = convo?.stats?.tokens.total;

	return (
		<footer className="composer">
			<div className="composer-inner">
				<textarea
					ref={textareaRef}
					rows={2}
					value={text}
					placeholder={
						props.runtimeReady ? "向 pie 提问…（Enter 发送，Shift+Enter 换行）" : "代理启动中…"
					}
					aria-label="消息输入框"
					disabled={!props.runtimeReady}
					onChange={(e) => {
						setText(e.target.value);
						autoGrow();
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
							e.preventDefault();
							send();
						}
					}}
				/>
				<div className="composer-bar">
					<Dropdown
						ariaLabel={`切换模型（当前：${convo?.model?.id ?? "未知"}）`}
						label={
							<>
								<Icon name="pie" />
								<span className="label">{convo?.model?.id ?? "…"}</span>
							</>
						}
						items={modelItems}
						disabled={!convo || streaming}
					/>
					<Dropdown
						ariaLabel={`切换思考强度（当前：${LEVEL_LABELS[convo?.thinkingLevel ?? "off"]}）`}
						label={
							<>
								<Icon name="brain" />
								<span className="label">思考：{LEVEL_LABELS[convo?.thinkingLevel ?? "off"]}</span>
							</>
						}
						items={levelItems}
						disabled={!convo || streaming}
					/>
					<span className="spacer" />
					<button
						className={streaming ? "send-btn stop" : "send-btn"}
						aria-label={streaming ? "停止生成" : "发送"}
						disabled={!streaming && (!text.trim() || !props.runtimeReady)}
						onClick={() => (streaming ? void actions.abort() : send())}
					>
						<Icon name={streaming ? "stop" : "send"} />
					</button>
				</div>
			</div>
			<div className="status-line">
				<span>{tokensTotal !== undefined ? `用量：${formatTokens(tokensTotal)} tokens` : "用量：—"}</span>
				<span className="grow" />
				{percent !== undefined && percent !== null && (
					<span>
						上下文
						<span className="ctx-bar" role="img" aria-label={`上下文已使用 ${Math.round(percent)}%`}>
							<i style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
						</span>{" "}
						{Math.round(percent)}%
					</span>
				)}
			</div>
		</footer>
	);
}
