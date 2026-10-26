import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import {
	type Component,
	getKeybindings,
	Text,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { formatToolDuration } from "../../core/tools/render-utils.ts";
import { createAllToolRenderers } from "../../core/tools/renderers/index.ts";
import { AssistantMessageComponent } from "../../modes/interactive/components/assistant-message.ts";
import { highlightHover } from "../../modes/interactive/components/hover-style.ts";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { ToolExecutionComponent } from "../../modes/interactive/components/tool-execution.ts";
import { ToolTranscriptContainer } from "../../modes/interactive/components/tool-transcript.ts";
import { UserMessageComponent } from "../../modes/interactive/components/user-message.ts";
import { theme } from "../../modes/interactive/theme/theme.ts";

export interface SubagentDetailSnapshot {
	agent: string;
	description: string;
	status: string;
	model: string;
	thinking: string;
	startedAt: number;
	finishedAt?: number;
	stopReason?: string;
	error?: string;
	activeTool?: string;
	messages: readonly AgentMessage[];
	streaming?: AssistantMessage;
}
interface Entry {
	signature: string;
	component: Component;
}
const toolRenderers = createAllToolRenderers();
const HEADER_HEIGHT = 4;

/** Child transcript overlay; displaying it never switches or mutates the parent session. */
export class SubagentDetailView implements Component {
	private readonly ui: TUI;
	private readonly getSnapshot: () => SubagentDetailSnapshot;
	private readonly done: () => void;
	private readonly keys = getKeybindings();
	private readonly transcript = new ToolTranscriptContainer();
	private readonly entries = new Map<string, Entry>();
	private scrollTop = 0;
	private contentHeight = 0;
	private bodyHeight = 0;
	private width = 0;
	private expandedTools = false;
	private expandedThought = false;
	private closeHovered = false;
	constructor(ui: TUI, getSnapshot: () => SubagentDetailSnapshot, done: () => void) {
		this.ui = ui;
		this.getSnapshot = getSnapshot;
		this.done = done;
	}
	handleInput(data: string): void {
		if (this.keys.matches(data, "tui.select.cancel")) {
			this.done();
			return;
		}
		if (this.keys.matches(data, "tui.select.pageUp") || this.keys.matches(data, "tui.altScreen.pageUp"))
			this.scroll(-Math.max(1, this.bodyHeight - 1));
		else if (this.keys.matches(data, "tui.select.pageDown") || this.keys.matches(data, "tui.altScreen.pageDown"))
			this.scroll(Math.max(1, this.bodyHeight - 1));
		else if (this.keys.matches(data, "tui.select.up") || this.keys.matches(data, "tui.altScreen.lineUp"))
			this.scroll(-1);
		else if (this.keys.matches(data, "tui.select.down") || this.keys.matches(data, "tui.altScreen.lineDown"))
			this.scroll(1);
		else if (this.keys.matches(data, "app.tools.expand")) {
			this.expandedTools = !this.expandedTools;
			for (const entry of this.entries.values())
				if (entry.component instanceof ToolExecutionComponent) entry.component.setExpanded(this.expandedTools);
		} else if (this.keys.matches(data, "app.thinking.toggle")) {
			this.expandedThought = !this.expandedThought;
			for (const entry of this.entries.values())
				if (entry.component instanceof AssistantMessageComponent)
					entry.component.setHideThinkingBlock(!this.expandedThought);
		}
		this.ui.requestRender();
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const closing = event.y === 1 && event.x >= Math.max(0, this.width - 6);
		if (event.type === "move" || event.type === "leave") {
			const hovered = event.type === "move" && event.button === "none" && closing;
			const changed = hovered !== this.closeHovered;
			this.closeHovered = hovered;
			if (hovered || (event.type === "leave" && changed)) return { handled: true, render: changed };
			if (changed) this.ui.requestRender();
		}
		if (event.button === "left" && closing) {
			if (event.type === "press") return { handled: true, render: false };
			if (event.type === "click") {
				this.done();
				return { handled: true };
			}
		}
		if (event.y < HEADER_HEIGHT || event.y >= HEADER_HEIGHT + this.bodyHeight) return undefined;
		if (event.type === "wheel") {
			this.scroll(event.wheelDelta ?? 0);
			return { handled: true };
		}
		const result = this.transcript.handleMouse({
			...event,
			x: event.x - 1,
			y: event.y - HEADER_HEIGHT + this.scrollTop,
			width: Math.max(1, this.width - 2),
			height: this.contentHeight,
		});
		if (result?.handled) this.ui.requestRender();
		return result;
	}
	invalidate(): void {
		this.transcript.invalidate();
	}
	dispose(): void {
		for (const entry of this.entries.values()) {
			if (entry.component instanceof ToolExecutionComponent) entry.component.dispose();
		}
	}
	render(width: number): string[] {
		const snapshot = this.getSnapshot();
		this.syncTranscript(snapshot);
		this.width = width;
		const height = Math.max(1, this.ui.terminal.rows);
		const inner = Math.max(1, width - 2);
		this.bodyHeight = Math.max(0, height - HEADER_HEIGHT - 2);
		const description = truncateToWidth(
			theme.bold(snapshot.description || snapshot.agent),
			Math.max(0, inner - 5),
			"…",
		);
		const close = theme.fg("muted", "[X]");
		const title = `${description}${" ".repeat(Math.max(0, inner - visibleWidth(description) - 3))}${this.closeHovered ? highlightHover(close) : close}`;
		const elapsed = formatToolDuration(Math.max(0, (snapshot.finishedAt ?? Date.now()) - snapshot.startedAt));
		const metadata = theme.fg(
			snapshot.status === "error" ? "error" : snapshot.status === "completed" ? "success" : "muted",
			`${snapshot.agent} · ${snapshot.model} · ${snapshot.status} · ${elapsed} · ${snapshot.thinking}`,
		);
		const lines = [
			theme.fg("border", `╭${"─".repeat(Math.max(0, width - 2))}╮`),
			this.frame(title),
			this.frame(metadata),
			theme.fg("border", `├${"─".repeat(Math.max(0, width - 2))}┤`),
		];
		const content = this.transcript.render(inner);
		this.contentHeight = content.length;
		this.scrollTop = Math.min(this.scrollTop, Math.max(0, content.length - this.bodyHeight));
		for (let index = 0; index < this.bodyHeight; index++)
			lines.push(this.frame(content[this.scrollTop + index] ?? ""));
		lines.push(
			theme.fg("border", `╰${"─".repeat(Math.max(0, width - 2))}╯`),
			this.frame(
				[
					keyHint("tui.select.cancel", "back"),
					keyHint("app.tools.expand", "tools"),
					keyHint("app.thinking.toggle", "thought"),
					"↑/↓ scroll",
				].join(" · "),
			),
		);
		return lines.slice(0, height).map((line) => truncateToWidth(line, width, ""));
	}
	private frame(content: string): string {
		const inner = Math.max(0, this.width - 2);
		const text = truncateToWidth(content, inner, "");
		return (
			theme.fg("border", "│") + text + " ".repeat(Math.max(0, inner - visibleWidth(text))) + theme.fg("border", "│")
		);
	}
	private syncTranscript(snapshot: SubagentDetailSnapshot): void {
		const messages = [...snapshot.messages];
		if (snapshot.streaming) {
			const index = messages.findLastIndex(
				(message) => message.role === "assistant" && message.timestamp === snapshot.streaming?.timestamp,
			);
			if (index < 0) messages.push(snapshot.streaming);
			else messages[index] = snapshot.streaming;
		}
		const results = new Map<string, ToolResultMessage>();
		for (const message of messages) if (message.role === "toolResult") results.set(message.toolCallId, message);
		const next = new Map<string, Entry>();
		this.transcript.clear();
		for (const [index, original] of messages.entries()) {
			const stopped =
				snapshot.status === "stopped" &&
				snapshot.stopReason &&
				index === messages.length - 1 &&
				original.role === "assistant" &&
				["aborted", "error"].includes(original.stopReason);
			const message =
				stopped && original.role === "assistant" ? { ...original, stopReason: "stop" as const } : original;
			if (message.role !== "user" && message.role !== "assistant") continue;
			const key = `${message.role}:${index}:${message.timestamp}`;
			const signature = JSON.stringify(message);
			const previous = this.entries.get(key);
			let component = previous?.component;
			if (message.role === "user") {
				if (!component || previous?.signature !== signature) {
					const text =
						typeof message.content === "string"
							? message.content
							: message.content
									.filter((part) => part.type === "text")
									.map((part) => part.text)
									.join("\n");
					component = new UserMessageComponent(text);
				}
			} else {
				const assistant =
					component instanceof AssistantMessageComponent
						? component
						: new AssistantMessageComponent(undefined, !this.expandedThought);
				if (previous?.signature !== signature) assistant.updateContent(message, message === snapshot.streaming);
				component = assistant;
			}
			next.set(key, { signature, component });
			this.transcript.addChild(component);
			if (stopped && original.role === "assistant" && original.errorMessage)
				this.transcript.addChild(new Text(theme.fg("muted", original.errorMessage), 1, 0));
			if (message.role !== "assistant") continue;
			for (const part of message.content) {
				if (part.type !== "toolCall") continue;
				const toolKey = `tool:${part.id}`;
				const result = results.get(part.id);
				const running = !result && snapshot.status === "running" && snapshot.activeTool === part.name;
				const toolSignature = JSON.stringify([part.arguments, result, running]);
				const cached = this.entries.get(toolKey);
				const tool =
					cached?.component instanceof ToolExecutionComponent
						? cached.component
						: new ToolExecutionComponent(
								part.name,
								part.id,
								part.arguments,
								{ showImages: false, timestamp: message.timestamp },
								toolRenderers[part.name as keyof typeof toolRenderers],
								this.ui,
								process.cwd(),
							);
				if (!cached) tool.setExpanded(this.expandedTools);
				if (cached?.signature !== toolSignature) {
					tool.updateArgs(part.arguments);
					tool.setArgsComplete();
					if (result) tool.updateResult(result);
					else if (running) tool.markExecutionStarted();
				}
				next.set(toolKey, { signature: toolSignature, component: tool });
				this.transcript.addChild(tool);
			}
		}
		if (snapshot.stopReason) this.transcript.addChild(new Text(theme.fg("muted", snapshot.stopReason), 1, 0));
		if (snapshot.error) this.transcript.addChild(new Text(theme.fg("error", snapshot.error), 1, 0));
		this.entries.clear();
		for (const [key, entry] of next) this.entries.set(key, entry);
	}
	private scroll(delta: number): void {
		this.scrollTop = Math.max(0, Math.min(Math.max(0, this.contentHeight - this.bodyHeight), this.scrollTop + delta));
		this.ui.requestRender();
	}
}
