import { useMemo, useState } from "react";
import type { ReactElement } from "react";
import type { TrajectoryEntry } from "../../shared/protocol.ts";
import type { ConvoState } from "../state/convo-reducer.ts";
import {
	buildTrajectoryRows,
	filterTrajectoryRows,
	summarizeTrajectory,
	trajectoryKindLabel,
	type TrajectoryFilter,
	type TrajectoryRow,
} from "../state/trajectory.ts";
import { useStore } from "../state/store.tsx";
import { Icon } from "./Icon.tsx";
import styles from "./TrajectoryView.module.css";

const FILTERS: Array<{ key: TrajectoryFilter; label: string }> = [
	{ key: "all", label: "全部" },
	{ key: "user", label: "用户" },
	{ key: "assistant", label: "助手" },
	{ key: "tool", label: "工具" },
	{ key: "config", label: "系统" },
];

const TAG_CLASS: Record<TrajectoryRow["kind"], string | undefined> = {
	user: styles.tagUser,
	assistant: styles.tagAssistant,
	thinking: styles.tagThinking,
	tool: styles.tagTool,
	compaction: styles.tagConfig,
	config: styles.tagConfig,
	custom: styles.tagConfig,
	system: styles.tagConfig,
	error: styles.tagError,
};

function StatusDot(props: { status: TrajectoryRow["status"] }): ReactElement | null {
	if (!props.status) return null;
	if (props.status === "running") return <span className={`${styles.dot} ${styles.dotRunning}`} aria-label="运行中" />;
	if (props.status === "error") return <span className={`${styles.dot} ${styles.dotError}`} aria-label="失败" />;
	return <span className={`${styles.dot} ${styles.dotDone}`} aria-label="完成" />;
}

function showRowTitle(row: TrajectoryRow): boolean {
	// 工具与系统行的标题携带信息；用户/助手/思考行由左侧标签表达。
	return row.kind === "tool" || row.kind === "config" || row.kind === "custom" || row.kind === "system" || row.kind === "compaction";
}

function Inspector(props: { row: TrajectoryRow; onClose: () => void }): ReactElement {
	const [tab, setTab] = useState<"overview" | "preview" | "raw">("overview");
	const { row } = props;
	const metadata: Array<[string, string]> = [
		["类型", trajectoryKindLabel(row.kind)],
		["轮次", row.turn === null ? "—" : `第 ${row.turn} 轮`],
		["请求", row.request === null ? "—" : `#${row.request}`],
		["时间", row.time ?? "—"],
		["状态", row.status === "running" ? "运行中" : row.status === "error" ? "失败" : row.status === "done" ? "完成" : "—"],
		...(row.durationMs !== undefined ? [["耗时", `${row.durationMs} ms`] as [string, string]] : []),
	];

	return (
		<aside className={styles.inspector} aria-label="事件详情">
			<header className={styles.inspectorHead}>
				<span className={styles.tag + " " + (TAG_CLASS[row.kind] ?? "")}>{trajectoryKindLabel(row.kind)}</span>
				<strong className={styles.inspectorTitle}>{row.title}</strong>
				<button className="icon-btn" aria-label="关闭详情" onClick={props.onClose}>
					<Icon name="x" />
				</button>
			</header>
			<div className={styles.inspectorTabs} role="tablist" aria-label="详情视图">
				{(
					[
						["overview", "概述"],
						["preview", "预览"],
						["raw", "原始内容"],
					] as const
				).map(([key, label]) => (
					<button
						key={key}
						role="tab"
						aria-selected={tab === key}
						className={styles.inspectorTab}
						onClick={() => setTab(key)}
					>
						{label}
					</button>
				))}
			</div>
			<div className={styles.inspectorBody}>
				{tab === "overview" && (
					<dl className={styles.meta}>
						{metadata.map(([label, value]) => (
							<div key={label} className={styles.metaRow}>
								<dt>{label}</dt>
								<dd>{value}</dd>
							</div>
						))}
					</dl>
				)}
				{tab === "preview" &&
					(row.details.length > 0 ? (
						row.details.map((detail, index) => (
							<section key={`${detail.label}-${index}`} className={styles.detailBlock}>
								<h3>{detail.label}</h3>
								<pre>{detail.text || "（空）"}</pre>
							</section>
						))
					) : (
						<p className={styles.muted}>没有可预览的内容。</p>
					))}
				{tab === "raw" && <pre className={styles.raw}>{row.raw || "（空）"}</pre>}
			</div>
		</aside>
	);
}

export function TrajectoryView(props: { convo?: ConvoState }): ReactElement {
	const { state } = useStore();
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<TrajectoryFilter>("all");
	const [selectedKey, setSelectedKey] = useState<string | null>(null);

	const workspaceId = state.activeWorkspaceId;
	const convo = props.convo;
	const trajectory = workspaceId ? state.trajectories[workspaceId] : undefined;
	const matchesSession = Boolean(trajectory && convo && trajectory.sessionId === convo.sessionId);
	const entries: TrajectoryEntry[] = matchesSession && trajectory ? trajectory.entries : [];

	const rows = useMemo(
		() =>
			buildTrajectoryRows({
				entries,
				live: convo?.live ?? [],
				toolRuns: convo?.toolRuns ?? {},
				streaming: convo?.streaming ?? false,
			}),
		[entries, convo?.live, convo?.toolRuns, convo?.streaming],
	);
	const visible = useMemo(() => filterTrajectoryRows(rows, query, filter), [rows, query, filter]);
	const summary = useMemo(() => summarizeTrajectory(rows), [rows]);
	const selected = selectedKey ? (rows.find((row) => row.key === selectedKey) ?? null) : null;

	let lastTurn: number | null = null;

	return (
		<div className={styles.wrap}>
			<div className={styles.toolbar}>
				<label className={styles.search}>
					<Icon name="search" />
					<input
						type="search"
						value={query}
						placeholder="搜索事件"
						aria-label="搜索轨迹"
						onChange={(e) => setQuery(e.target.value)}
					/>
				</label>
				<div className={styles.filters} role="group" aria-label="事件类型">
					{FILTERS.map((item) => (
						<button
							key={item.key}
							className={styles.filter}
							aria-pressed={filter === item.key}
							onClick={() => setFilter(item.key)}
						>
							{item.label}
						</button>
					))}
				</div>
				<span className={styles.counts}>
					{rows.length} 个事件 · {summary.turns} 轮 · {summary.tools} 次工具
				</span>
			</div>

			<div className={styles.body}>
				<div className={styles.ledger}>
					{(trajectory?.loading ?? false) && !matchesSession && <p className={styles.muted}>加载轨迹…</p>}
					{trajectory?.error && <p className={styles.error}>{trajectory.error}</p>}
					{!workspaceId && <p className={styles.muted}>先选择一个工作区。</p>}
					{workspaceId && rows.length === 0 && !trajectory?.loading && (
						<p className={styles.muted}>
							{query || filter !== "all"
								? "没有匹配的事件。"
								: "该会话还没有事件。发送一条消息后，每个事件都会出现在这里。"}
						</p>
					)}
					{visible.map((row) => {
						const showTurn = row.turn !== null && row.turn !== lastTurn;
						if (row.turn !== null) lastTurn = row.turn;
						return (
							<div key={row.key}>
								{showTurn && <div className={styles.turnHeader}>第 {row.turn} 轮</div>}
								<button
									type="button"
									className={styles.row + (selectedKey === row.key ? " " + styles.rowActive : "")}
									aria-pressed={selectedKey === row.key}
									onClick={() => setSelectedKey(row.key)}
								>
									<span className={styles.time}>{row.time ?? ""}</span>
									<span className={styles.tag + " " + (TAG_CLASS[row.kind] ?? "")}>
										{trajectoryKindLabel(row.kind)}
									</span>
									<span className={styles.line}>
										{row.request !== null && row.kind !== "user" ? (
											<span className={styles.request}>#{row.request}</span>
										) : null}
										{showRowTitle(row) ? <span className={styles.title}>{row.title}</span> : null}
										<span className={styles.preview}>{row.preview}</span>
									</span>
									<StatusDot status={row.status} />
								</button>
							</div>
						);
					})}
				</div>
				{selected && (
					<Inspector
						row={selected}
						onClose={() => {
							setSelectedKey(null);
						}}
					/>
				)}
			</div>
		</div>
	);
}
