import { useState } from "react";
import type { ReactElement } from "react";
import type { ToolStatus } from "../state/convo-reducer.ts";
import { Icon } from "./Icon.tsx";

const STATUS_BADGE: Record<ToolStatus, { cls: string; text: string }> = {
	running: { cls: "badge run", text: "运行中" },
	done: { cls: "badge ok", text: "完成" },
	error: { cls: "badge err", text: "失败" },
};

export function ToolCard(props: {
	name: string;
	summary: string;
	argsDetail?: string;
	resultText?: string;
	status: ToolStatus;
	durationMs?: number;
}): ReactElement {
	const [open, setOpen] = useState(false);
	const badge = STATUS_BADGE[props.status];

	return (
		<div className="tool-card" data-open={open}>
			<button className="tool-head" aria-expanded={open} onClick={() => setOpen(!open)}>
				<Icon name="tool" />
				<span className="name">{props.name}</span>
				<span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1 }}>
					{props.summary}
				</span>
				{props.durationMs !== undefined && (
					<span style={{ fontSize: 11, color: "var(--text-3)", flex: "none" }}>
						{props.durationMs < 1000 ? `${props.durationMs}ms` : `${(props.durationMs / 1000).toFixed(1)}s`}
					</span>
				)}
				<span className={badge.cls}>{badge.text}</span>
				<svg className="icon chev" aria-hidden="true">
					<use href="#i-chev" />
				</svg>
			</button>
			<div className="tool-detail">
				{props.argsDetail && <pre>{props.argsDetail}</pre>}
				{props.resultText && <pre>{props.resultText}</pre>}
				{!props.argsDetail && !props.resultText && <pre>（无详细输出）</pre>}
			</div>
		</div>
	);
}
