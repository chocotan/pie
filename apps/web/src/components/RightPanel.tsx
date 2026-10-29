import type { ReactElement } from "react";
import { deriveAgentItems, deriveTaskItems, type PanelItem, type ToolStatus } from "../state/convo-reducer.ts";
import { useStore, type RightTab } from "../state/store.tsx";
import { Icon } from "./Icon.tsx";

const TABS: Array<{ key: RightTab; label: string; icon: string }> = [
	{ key: "tasks", label: "任务", icon: "task" },
	{ key: "agents", label: "子代理", icon: "agent" },
	{ key: "jobs", label: "后台任务", icon: "job" },
];

const STATUS_BADGE: Record<ToolStatus, { cls: string; text: string }> = {
	running: { cls: "badge run", text: "进行中" },
	done: { cls: "badge ok", text: "完成" },
	error: { cls: "badge err", text: "失败" },
};

function ItemList(props: { items: PanelItem[]; emptyText: string }): ReactElement {
	if (props.items.length === 0) {
		return <div className="panel-empty">{props.emptyText}</div>;
	}
	return (
		<>
			{props.items.map((item) => {
				const badge = STATUS_BADGE[item.status];
				return (
					<div className="item-card" key={item.id}>
						<div className="row1">
							<span className="t">{item.title}</span>
							<span className={badge.cls}>{badge.text}</span>
						</div>
						{item.detail && (
							<div className="row2">
								<code>{item.detail}</code>
							</div>
						)}
					</div>
				);
			})}
		</>
	);
}

export function RightPanel(): ReactElement {
	const { state, actions } = useStore();
	const convo = state.activeWorkspaceId ? state.convos[state.activeWorkspaceId] : undefined;

	function onTabKeyDown(e: React.KeyboardEvent, index: number): void {
		let next = -1;
		if (e.key === "ArrowRight") next = (index + 1) % TABS.length;
		else if (e.key === "ArrowLeft") next = (index + TABS.length - 1) % TABS.length;
		else if (e.key === "Home") next = 0;
		else if (e.key === "End") next = TABS.length - 1;
		if (next >= 0) {
			e.preventDefault();
			actions.setRightTab(TABS[next].key);
			document.getElementById(`tab-${TABS[next].key}`)?.focus();
		}
	}

	return (
		<aside
			className="right"
			aria-label="任务与子代理面板"
			data-open={state.rightDrawerOpen}
			data-collapsed={state.rightCollapsed}
		>
			<div className="right-head">
				<strong style={{ fontSize: 14 }}>工作区</strong>
				<button className="icon-btn" aria-label="关闭任务面板" onClick={() => actions.setRightDrawerOpen(false)}>
					<Icon name="x" />
				</button>
			</div>
			<div className="tabs" role="tablist" aria-label="右侧面板标签">
				{TABS.map((tab, index) => (
					<button
						key={tab.key}
						className="tab"
						role="tab"
						id={`tab-${tab.key}`}
						aria-selected={state.rightTab === tab.key}
						aria-controls={`panel-${tab.key}`}
						tabIndex={state.rightTab === tab.key ? 0 : -1}
						onClick={() => actions.setRightTab(tab.key)}
						onKeyDown={(e) => onTabKeyDown(e, index)}
					>
						<Icon name={tab.icon} />
						{tab.label}
					</button>
				))}
			</div>

			<div className="panel-body" role="tabpanel" id="panel-tasks" aria-labelledby="tab-tasks" hidden={state.rightTab !== "tasks"}>
				{convo ? (
					<ItemList items={deriveTaskItems(convo)} emptyText="当前会话暂无任务记录（TaskCreate/TaskUpdate 调用会显示在这里）。" />
				) : (
					<div className="panel-empty">会话加载中…</div>
				)}
			</div>
			<div className="panel-body" role="tabpanel" id="panel-agents" aria-labelledby="tab-agents" hidden={state.rightTab !== "agents"}>
				{convo ? (
					<ItemList items={deriveAgentItems(convo)} emptyText="当前会话暂无子代理调用（Agent 工具的调用会显示在这里）。" />
				) : (
					<div className="panel-empty">会话加载中…</div>
				)}
			</div>
			<div className="panel-body" role="tabpanel" id="panel-jobs" aria-labelledby="tab-jobs" hidden={state.rightTab !== "jobs"}>
				<div className="panel-empty">
					当前 RPC 事件流中没有可可靠识别后台任务的数据来源，为避免展示失真信息此处暂为空；后续接入后台任务 API 后展示。
				</div>
			</div>
		</aside>
	);
}
