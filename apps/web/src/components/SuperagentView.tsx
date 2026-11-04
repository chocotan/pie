import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { api, type SuperagentOverview } from "../api.ts";

const STAGE_LABELS: Record<string, string> = {
	person: "待人工",
	working: "执行中",
	idle: "等待触发",
	ended: "已结束",
};

export function SuperagentView(): ReactElement {
	const [data, setData] = useState<SuperagentOverview>();
	const [error, setError] = useState("");

	async function load(): Promise<void> {
		try {
			setData(await api.superagent());
			setError("");
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "工单面板加载失败");
		}
	}

	useEffect(() => {
		void load();
		const timer = window.setInterval(() => void load(), 5000);
		return () => window.clearInterval(timer);
	}, []);

	if (!data) return <div className="chat-body"><p>{error || "加载工单…"}</p></div>;
	return (
		<div className="chat-body">
			<section>
				<h2>总览</h2>
				<p>{data.setup ? `设置未完成：${data.setup.detail}` : data.repository || "未配置仓库"}</p>
				<button
					type="button"
					onClick={() => void api.pauseSuperagent(!data.paused).then(load)}
				>
					{data.paused ? "继续处理" : "暂停处理"}
				</button>
				{error && <p role="alert">{error}</p>}
			</section>
			<section>
				<h2>工单</h2>
				{data.tickets.length === 0 && <p>没有工单。</p>}
				<ul>
					{data.tickets.map((ticket) => (
						<li key={ticket.id}>
							<strong>{ticket.title}</strong>
							<span>{STAGE_LABELS[ticket.stage.stage] ?? ticket.stage.stage}</span>
							<button type="button" onClick={() => void api.stopTicket(ticket.id).then(load)}>停止</button>
						</li>
					))}
				</ul>
			</section>
			<section>
				<h2>线程</h2>
				<ul>
					{data.threads.map((thread) => (
						<li key={thread.key}>{thread.key} · 待评估 {thread.pending} · 订阅 {thread.subscriptions}</li>
					))}
				</ul>
			</section>
		</div>
	);
}
