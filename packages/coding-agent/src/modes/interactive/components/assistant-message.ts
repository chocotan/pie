import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	Container,
	Markdown,
	type MarkdownTheme,
	MouseRegion,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { highlightHover } from "./hover-style.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";
import { appendMessageTime, formatMessageTime } from "./message-time.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/** Columns between the collapsed thinking label and its one-line preview. */
const THINKING_PREVIEW_GAP = 2;
/** Smallest preview width worth showing; below it the label keeps the whole line. */
const MIN_THINKING_PREVIEW_WIDTH = 12;
/** Body columns kept before the header time is dropped on narrow rows. */
const MIN_THINKING_BODY_WIDTH_WITH_TIME = 12;

/** Latest non-blank line of hidden thinking content, used as the collapsed preview. */
function thinkingPreview(text: string): string | undefined {
	let end = text.length;
	while (end > 0) {
		const start = text.lastIndexOf("\n", end - 1) + 1;
		const line = text.slice(start, end).trim();
		if (line.length > 0) return line;
		if (start === 0) break;
		end = start - 1;
	}
	return undefined;
}

/** One-line thinking header: label on the left, truncated preview, then the time on the right. */
function renderThinkingHeader(
	title: string,
	preview: string | undefined,
	clockText: string | undefined,
	width: number,
	paddingX: number,
): string {
	const pad = Math.min(paddingX, Math.max(0, Math.floor((width - 1) / 2)));
	const available = Math.max(1, width - pad * 2);
	const clockSegment =
		clockText !== undefined && available - visibleWidth(clockText) - 2 >= MIN_THINKING_BODY_WIDTH_WITH_TIME
			? `  ${theme.fg("muted", clockText)}`
			: "";
	const bodyWidth = Math.max(1, available - visibleWidth(clockSegment));
	const styledTitle = theme.italic(theme.fg("thinkingText", title));
	const previewWidth = bodyWidth - visibleWidth(title) - THINKING_PREVIEW_GAP;
	const body =
		preview === undefined || previewWidth < MIN_THINKING_PREVIEW_WIDTH
			? truncateToWidth(styledTitle, bodyWidth, "…")
			: `${styledTitle}${" ".repeat(THINKING_PREVIEW_GAP)}${theme.fg("muted", truncateToWidth(preview, previewWidth, "…"))}`;
	const text = " ".repeat(pad) + body + " ".repeat(Math.max(0, bodyWidth - visibleWidth(body))) + clockSegment;
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private isStreaming = false;
	private thinkingVisibilityOverrides = new Map<number, boolean>();
	private globalThinkingVisibilityOverride?: boolean;
	private readonly autoExpandLiveThinking: boolean;
	private readonly thinkingTimes = new Map<number, { started: number; ended?: number }>();

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = true,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
		autoExpandLiveThinking = true,
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.autoExpandLiveThinking = autoExpandLiveThinking;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		this.globalThinkingVisibilityOverride = hide;
		this.thinkingVisibilityOverrides.clear();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) return lines;
		if (!this.hasToolCalls) {
			lines[0] = OSC133_ZONE_START + lines[0];
			lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		}
		// A message that only carries tool calls renders no row of its own; its tool header keeps the time.
		if (!this.isStreaming) appendMessageTime(lines, width, this.lastMessage?.timestamp);
		return lines;
	}

	updateContent(message: AssistantMessage, isStreaming = this.isStreaming): void {
		this.lastMessage = message;
		this.isStreaming = isStreaming;

		// Clear content container
		this.contentContainer.clear();

		const hasVisibleContent = message.content.some(
			(c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		// Render content in order
		let thinkingRunIndex = 0;
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				this.contentContainer.addChild(
					new Markdown(content.text.trim(), this.outputPad, 0, this.markdownTheme, undefined, {
						transform: createMarkdownTransform("assistant", this.isStreaming, this.markdownTransformers),
					}),
				);
			} else if (content.type === "thinking") {
				const thinkingBlocks: string[] = [];
				for (; i < message.content.length; i++) {
					const thinkingContent = message.content[i];
					if (thinkingContent.type !== "thinking") {
						break;
					}
					const thinking = thinkingContent.thinking.trim();
					if (thinking) {
						thinkingBlocks.push(thinking);
					}
				}
				i--;

				if (thinkingBlocks.length === 0) {
					continue;
				}

				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

				const runIndex = thinkingRunIndex++;
				const active = this.isStreaming && i === message.content.length - 1;
				// A live run expands only in views that opt in; the transcript keeps the
				// configured default so a long thought never pushes the answer off screen.
				const hidden =
					this.thinkingVisibilityOverrides.get(runIndex) ??
					this.globalThinkingVisibilityOverride ??
					(!(active && this.autoExpandLiveThinking) && this.hideThinkingBlock);
				if (this.isStreaming && !this.thinkingTimes.has(runIndex))
					this.thinkingTimes.set(runIndex, { started: Date.now() });
				const timing = this.thinkingTimes.get(runIndex);
				if (timing && !active && timing.ended === undefined) timing.ended = Date.now();
				const label = active || this.hiddenThinkingLabel !== "Thinking..." ? this.hiddenThinkingLabel : "Thought";
				const elapsed = timing
					? ` · ${(Math.max(0, (timing.ended ?? Date.now()) - timing.started) / 1000).toFixed(1)}s`
					: "";
				const thinkingComponent = new Container();
				let headerHovered = false;
				const headerText = `${hidden ? "▸" : "▾"} ${label}${elapsed}`;
				// Hidden content still shows its latest line, so a collapsed thought is not blank.
				const preview = hidden ? thinkingPreview(thinkingBlocks[thinkingBlocks.length - 1] ?? "") : undefined;
				const clock = formatMessageTime(message.timestamp);
				thinkingComponent.addChild({
					render: (width) => {
						const line = renderThinkingHeader(headerText, preview, clock, width, this.outputPad);
						return [headerHovered ? highlightHover(line) : line];
					},
					invalidate: () => {},
				});
				if (!hidden) {
					thinkingComponent.addChild(
						new Markdown(
							thinkingBlocks.join("\n\n"),
							this.outputPad,
							0,
							this.markdownTheme,
							{
								color: (text: string) => theme.fg("thinkingText", text),
								italic: true,
							},
							{
								transform: createMarkdownTransform(
									"assistant-thinking",
									this.isStreaming,
									this.markdownTransformers,
								),
							},
						),
					);
				}

				this.contentContainer.addChild(
					new MouseRegion(thinkingComponent, (event) => {
						if (event.type === "move" || event.type === "leave") {
							const hovered = event.type === "move" && event.button === "none" && event.y === 0;
							const changed = hovered !== headerHovered;
							headerHovered = hovered;
							return hovered || changed ? { handled: true, render: changed } : undefined;
						}
						// The label row captures the press so repeated clicks keep toggling; the
						// body leaves it unhandled so a drag there selects text instead.
						if (event.button !== "left") return undefined;
						if (event.type === "press" && event.y === 0) return { handled: true, render: false };
						if (event.type !== "click") return undefined;
						this.thinkingVisibilityOverrides.set(runIndex, !hidden);
						if (this.lastMessage) this.updateContent(this.lastMessage);
						return { handled: true };
					}),
				);
				// An expanded thought keeps a separator before following content; a collapsed
				// header is one dim line and hugs what comes next.
				if (!hidden && hasVisibleContentAfter) {
					this.contentContainer.addChild(new Spacer(1));
				}
			}
		}

		// Check if incomplete/failed - show after partial content.
		// For aborted/error tool calls, tool execution components show the error.
		// Length stops can happen before a tool call is complete, so surface them here too.
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (message.stopReason === "length") {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(
				new Text(theme.fg("error", "Response was truncated before completion."), this.outputPad, 0),
			);
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), this.outputPad, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), this.outputPad, 0));
			}
		}
	}
}
