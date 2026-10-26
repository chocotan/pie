import { Container, Markdown, type MarkdownTheme, visibleWidth } from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";
import { formatMessageTime, TIME_RIGHT_RESERVE } from "./message-time.ts";
import { RenderCache } from "./render-cache.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	private text: string;
	private markdownTheme: MarkdownTheme;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private messageId?: string;
	/** Persisted session-entry ISO timestamp, forwarded to Markdown transformers. */
	private timestamp?: string;
	/** Clock time shown at the end of the message; live messages have no persisted entry timestamp. */
	private messageTime?: number;
	private readonly renderCache = new RenderCache();

	constructor(
		text: string,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
		messageId?: string,
		timestamp?: string,
		messageTime?: number,
	) {
		super();
		this.text = text;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;
		this.messageId = messageId;
		this.timestamp = timestamp;
		this.messageTime = messageTime ?? (timestamp ? Date.parse(timestamp) : undefined);
		this.rebuild();
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		this.rebuild();
	}

	override invalidate(): void {
		this.renderCache.invalidate();
		super.invalidate();
	}

	private rebuild(): void {
		this.renderCache.invalidate();
		this.clear();
		// The Markdown pads and colors its own background: a Box around it would keep a second full-width copy of every
		// line, with identical output.
		this.addChild(
			new Markdown(
				this.text,
				this.outputPad,
				1,
				this.markdownTheme,
				{
					color: (content: string) => theme.fg("userMessageText", content),
					bgColor: (content: string) => theme.bg("userMessageBg", content),
				},
				{
					preserveOrderedListMarkers: true,
					preserveBackslashEscapes: true,
					transform: createMarkdownTransform(
						"user",
						false,
						this.markdownTransformers,
						this.messageId,
						this.timestamp,
					),
				},
			),
		);
	}

	override render(width: number): string[] {
		// The clock label is fixed per message, so a settled row survives frame redraws.
		return this.renderCache.render(String(width), () => this.buildLines(width));
	}

	private buildLines(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) {
			return lines;
		}

		// Markdown pads one blank row under the text; the time goes there so it stays
		// inside the message background instead of being appended past its reset.
		if (this.messageTime !== undefined) {
			const label = theme.fg("muted", formatMessageTime(this.messageTime));
			// Keep the reserved column free so the transcript's auto scrollbar never covers the time.
			const gap = width - TIME_RIGHT_RESERVE - visibleWidth(label);
			if (gap >= 2) lines[lines.length - 1] = theme.bg("userMessageBg", `${" ".repeat(gap) + label} `);
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}
}
