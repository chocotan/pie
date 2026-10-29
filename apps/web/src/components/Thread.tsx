import { useEffect, useRef } from "react";
import type { ReactElement, ReactNode } from "react";
import type { TextBlock, ThinkingBlock, ToolCallBlock, WireMessage } from "../../shared/protocol.ts";
import {
	type ConvoState,
	type LiveBlock,
	type ToolRun,
	toolResultIndex,
	toolStatus,
	summarizeArgs,
} from "../state/convo-reducer.ts";
import { Icon } from "./Icon.tsx";
import { ToolCard } from "./ToolCard.tsx";

/** Render text with fenced code blocks as <pre>, everything else as pre-wrap text. */
function TextBody(props: { text: string; caret?: boolean }): ReactElement {
	const parts: ReactNode[] = [];
	const segments = props.text.split(/```[^\n]*\n?/);
	segments.forEach((segment, i) => {
		if (i % 2 === 1) {
			parts.push(<pre key={i}>{segment.replace(/\n$/, "")}</pre>);
		} else if (segment) {
			parts.push(<span key={i}>{segment}</span>);
		}
	});
	return <div className={props.caret ? "body caret" : "body"}>{parts}</div>;
}

function Thinking(props: { text: string }): ReactElement {
	return (
		<div className="thinking">
			<div className="label">
				<Icon name="brain" />
				思考过程
			</div>
			<div>{props.text}</div>
		</div>
	);
}

function messageText(message: WireMessage): string {
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) {
		return message.content
			.map((block) => {
				if (typeof block !== "object" || block === null) return "";
				const b = block as Record<string, unknown>;
				if (b.type === "text" && typeof b.text === "string") return b.text;
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

function toolResultText(result: WireMessage | undefined): string | undefined {
	if (!result) return undefined;
	const text = messageText(result);
	return text || undefined;
}

function isAssistantBlock(block: unknown): block is TextBlock | ThinkingBlock | ToolCallBlock {
	if (typeof block !== "object" || block === null) return false;
	const type = (block as { type?: unknown }).type;
	return type === "text" || type === "thinking" || type === "toolCall";
}

function CommittedToolCard(props: { convo: ConvoState; results: Map<string, WireMessage>; block: ToolCallBlock }): ReactElement {
	const { convo, block } = props;
	const run: ToolRun | undefined = convo.toolRuns[block.id];
	const result = props.results.get(block.id);
	const argsDetail = JSON.stringify(block.arguments, null, 2);
	return (
		<ToolCard
			name={block.name}
			summary={run?.argsSummary ?? summarizeArgs(block.name, block.arguments)}
			argsDetail={argsDetail === "{}" ? undefined : argsDetail}
			resultText={run?.resultText ?? toolResultText(result)}
			status={toolStatus(convo, props.results, block.id)}
			durationMs={run?.durationMs}
		/>
	);
}

function LiveBlocks(props: { convo: ConvoState; results: Map<string, WireMessage> }): ReactElement {
	const { convo } = props;
	const lastTextIndex = convo.live.reduce((acc, block, i) => (block.type === "text" ? i : acc), -1);
	return (
		<div className="msg-agent">
			{convo.live.map((block, i) => {
				if (block.type === "text") {
					return <TextBody key={i} text={block.text} caret={i === lastTextIndex && convo.streaming} />;
				}
				if (block.type === "thinking") {
					return <Thinking key={i} text={block.thinking} />;
				}
				const run = convo.toolRuns[block.id];
				return (
					<ToolCard
						key={block.id}
						name={block.name}
						summary={run?.argsSummary ?? ""}
						argsDetail={block.argsJson || undefined}
						resultText={run?.resultText ?? run?.partialText}
						status={toolStatus(convo, props.results, block.id)}
						durationMs={run?.durationMs}
					/>
				);
			})}
			{convo.streaming && convo.live.length === 0 && (
				<div className="thinking">
					<div className="label">
						<Icon name="spin" className="spin" />
						{convo.compacting ? "正在压缩上下文…" : "正在生成…"}
					</div>
				</div>
			)}
		</div>
	);
}

export function Thread(props: { convo: ConvoState }): ReactElement {
	const { convo } = props;
	const results = toolResultIndex(convo.messages);
	const bodyRef = useRef<HTMLDivElement>(null);

	// 新内容到达时滚到底部
	const contentSize = convo.messages.length * 10_000 + convo.live.reduce((n, b) => n + ("text" in b ? String(b.text).length : 1), 0);
	useEffect(() => {
		const el = bodyRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [contentSize, convo.workspaceId, convo.sessionId]);

	const empty = convo.messages.length === 0 && convo.live.length === 0 && !convo.streaming;

	return (
		<div className="chat-body" ref={bodyRef} aria-live="polite">
			<div className="thread">
				{empty && (
					<div className="empty-state">
						<div className="big">开始一个新会话</div>
						<div>在下方输入你的问题，pie 会调用工具来完成它。</div>
					</div>
				)}
				{convo.messages.map((message, i) => {
					// key 跨快照重取保持稳定（提交消息的 timestamp 不变），同毫秒同角色时退化为序号
					const key = `${message.role}-${message.timestamp ?? i}-${i}`;
					if (message.role === "user") {
						return (
							<div key={key} className="msg-user">
								{messageText(message)}
							</div>
						);
					}
					if (message.role === "assistant" && Array.isArray(message.content)) {
						return (
							<div key={key} className="msg-agent">
								{message.content.filter(isAssistantBlock).map((block, j) => {
									if (block.type === "text") return <TextBody key={j} text={block.text} />;
									if (block.type === "thinking") return <Thinking key={j} text={block.thinking} />;
									return <CommittedToolCard key={block.id} convo={convo} results={results} block={block} />;
								})}
								{message.errorMessage && <div className="msg-error">{message.errorMessage}</div>}
							</div>
						);
					}
					return null; // toolResult 等折叠进工具卡
				})}
				{(convo.live.length > 0 || convo.streaming) && <LiveBlocks convo={convo} results={results} />}
				{convo.liveError && <div className="msg-error">{convo.liveError}</div>}
			</div>
		</div>
	);
}
