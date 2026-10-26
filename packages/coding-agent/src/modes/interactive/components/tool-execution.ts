import {
	Box,
	type Component,
	Container,
	getCapabilities,
	Image,
	MouseRegion,
	Spacer,
	sliceByColumn,
	Text,
	type TUI,
	type TuiMouseEvent,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { ToolDefinition, ToolRenderContext, ToolRenderers } from "../../../core/extensions/types.ts";

/** What this component needs from a tool: how to draw it, without executing it. */
export type { ToolRenderers };

import {
	formatToolCallWithArgs,
	getTextOutput as getRenderedTextOutput,
	getToolCallDescription,
	toolTimerText,
} from "../../../core/tools/render-utils.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { ensurePngTranscoder } from "../../../utils/image-convert.ts";
import { theme } from "../theme/theme.ts";
import { ActivityDot } from "./activity-dot.ts";
import { highlightHover } from "./hover-style.ts";
import { keyHint } from "./keybinding-hints.ts";
import { formatMessageTime } from "./message-time.ts";

const FALLBACK_PREVIEW_LINES = 10;

/** Title columns kept before the header time is dropped on narrow rows. */
const MIN_TITLE_WIDTH_WITH_TIME = 12;

export interface ToolExecutionOptions {
	showImages?: boolean;
	imageWidthCells?: number;
	outputPad?: number;
	/** Wall-clock time of the call, shown on the header so long runs stay dated. */
	timestamp?: number;
}

/** Keep rendered body rows and mouse coordinates in sync when omitting a duplicate call title. */
class ToolBody extends Container {
	private readonly omitTitle: boolean;
	private offset = 0;
	constructor(child: Component, omitTitle = false) {
		super();
		this.addChild(child);
		this.omitTitle = omitTitle;
	}
	override render(width: number): string[] {
		const lines = super.render(width);
		let offset = 0;
		while (offset < lines.length && !stripAnsi(lines[offset]).trim()) offset++;
		if (this.omitTitle && offset < lines.length) offset++;
		while (offset < lines.length && !stripAnsi(lines[offset]).trim()) offset++;
		this.offset = offset;
		return lines.slice(offset);
	}
	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		return super.handleMouse({ ...event, y: event.y + this.offset, height: event.height + this.offset });
	}
}

export class ToolExecutionComponent extends Container {
	private toolCallId: string;
	private contentBox: Box;
	private contentText: Text;
	private contentTextRegion: MouseRegion;
	private selfRenderContainer: Container;
	private callRendererComponent?: Component;
	private resultRendererComponent?: Component;
	private rendererState: any = {};
	private imageComponents: Image[] = [];
	/** Inputs of imageComponents, so updateDisplay can reuse images and keep their converted PNG data. */
	private imageSources: Array<{ data: string; mimeType: string; widthCells: number }> = [];
	private imageSpacers: Spacer[] = [];
	private toolName: string;
	private args: any;
	private expanded = false;
	private spinner?: ActivityDot;
	private headerHovered = false;
	private readonly leadingSpacer = new Spacer(1);
	private showImages: boolean;
	private imageWidthCells: number;
	private outputPad: number;
	private readonly timestamp?: number;
	private isPartial = true;
	private toolDefinition?: ToolRenderers;
	private ui: TUI;
	private cwd: string;
	private executionStarted = false;
	private argsComplete = false;
	private result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError: boolean;
		details?: any;
		durationMs?: number;
	};
	private hideComponent = false;

	constructor(
		toolName: string,
		toolCallId: string,
		args: any,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolRenderers | ToolDefinition<any, any, any> | undefined,
		ui: TUI,
		cwd: string,
	) {
		super();
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.args = args;
		this.toolDefinition = toolDefinition;
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.outputPad = options.outputPad ?? 1;
		this.timestamp = options.timestamp;
		this.ui = ui;
		this.cwd = cwd;

		this.addChild(this.leadingSpacer);
		this.addChild({ render: (width) => [this.renderHeader(width)], invalidate() {} });

		// Always create all shell variants. contentBox is used for default renderer-based composition.
		// selfRenderContainer is used when the tool renders its own framing.
		// contentText is reserved for generic fallback rendering when no tool definition exists.
		this.contentBox = new Box(1, 0, (text: string) => theme.bg("toolPendingBg", text));
		this.contentText = new Text("", 1, 0, (text: string) => theme.bg("toolPendingBg", text));
		this.contentTextRegion = this.createResultRegion(this.contentText);
		this.selfRenderContainer = new Container();

		if (this.hasRendererDefinition()) {
			this.addChild(this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox);
		} else {
			this.addChild(this.contentTextRegion);
		}

		this.updateDisplay();
	}

	private getCallRenderer(): ToolDefinition<any, any>["renderCall"] | undefined {
		return this.toolDefinition?.renderCall;
	}

	private getResultRenderer(): ToolDefinition<any, any>["renderResult"] | undefined {
		return this.toolDefinition?.renderResult;
	}

	private hasRendererDefinition(): boolean {
		return this.toolDefinition !== undefined;
	}

	private getRenderShell(): "default" | "self" {
		return this.toolDefinition?.renderShell ?? "default";
	}

	private getRenderContext(lastComponent: Component | undefined): ToolRenderContext {
		return {
			args: this.args,
			toolCallId: this.toolCallId,
			invalidate: () => {
				this.invalidate();
				this.ui.requestRender();
			},
			lastComponent,
			state: this.rendererState,
			cwd: this.cwd,
			executionStarted: this.executionStarted,
			argsComplete: this.argsComplete,
			isPartial: this.isPartial,
			expanded: this.expanded,
			showImages: this.showImages,
			isError: this.result?.isError ?? false,
			durationMs: this.isPartial ? undefined : this.result?.durationMs,
			outputPad: this.outputPad,
		};
	}

	private createCallFallback(): Component {
		return new Text(formatToolCallWithArgs(this.toolName, this.args, theme, this.expanded), 0, 0);
	}

	private createResultFallback(): Component | undefined {
		const output = this.getTextOutput();
		if (!output) {
			return undefined;
		}

		const lines = output.split("\n");
		const displayLines = this.expanded ? lines : lines.slice(0, FALLBACK_PREVIEW_LINES);
		const remaining = lines.length - displayLines.length;
		let text = displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
		return new Text(text, 0, 0);
	}

	private createResultRegion(component: Component): MouseRegion {
		return new MouseRegion(component, (event) => {
			// Only a click toggles: a press is left unhandled so dragging selects text,
			// and the host emits a click only when the pointer did not move.
			if (event.type !== "click" || event.button !== "left") return undefined;
			this.setExpanded(!this.expanded);
			return { handled: true };
		});
	}

	private createBodyRegion(component: Component, omitTitle = false): MouseRegion {
		return this.createResultRegion(this.getRenderShell() === "self" ? component : new ToolBody(component, omitTitle));
	}

	updateArgs(args: any): void {
		this.args = args;
		this.updateDisplay();
	}

	markExecutionStarted(): void {
		this.executionStarted = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	setArgsComplete(): void {
		this.argsComplete = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError: boolean;
			/** Execution time of a final result. */
			durationMs?: number;
		},
		isPartial = false,
	): void {
		this.result = result;
		this.isPartial = isPartial;
		if (!isPartial || result.isError) {
			this.spinner?.dispose();
			this.spinner = undefined;
		}
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	/**
	 * A restored or abandoned call that never produced a result stays a static row.
	 * Keeping it partial starts an 80ms spinner timer that re-renders every row.
	 */
	markSettled(): void {
		if (!this.isPartial) return;
		this.isPartial = false;
		this.spinner?.dispose();
		this.spinner = undefined;
		this.updateDisplay();
	}

	setLeadingGap(enabled: boolean): void {
		this.leadingSpacer.setLines(enabled ? 1 : 0);
	}

	setOutputPad(outputPad: number): void {
		this.outputPad = outputPad;
		this.updateDisplay();
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		this.updateDisplay();
	}

	setImageWidthCells(width: number): void {
		this.imageWidthCells = Math.max(1, Math.floor(width));
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	dispose(): void {
		this.spinner?.dispose();
		this.spinner = undefined;
		toolTimerText(this.getRenderContext(undefined), false);
	}

	private renderHeader(width: number): string {
		const pad = Math.min(this.outputPad, Math.max(0, Math.floor((width - 1) / 2)));
		const available = Math.max(1, width - 2 * pad);
		let status = theme.fg(this.result?.isError ? "error" : this.result ? "success" : "muted", "●");
		if (this.isPartial && !this.result?.isError) {
			this.spinner ??= new ActivityDot(this.ui);
			status = this.spinner.renderDot();
		}
		const timing = toolTimerText(this.getRenderContext(undefined), this.isPartial);
		const suffix = timing ? ` · ${timing}` : "";
		const clockText = this.timestamp === undefined ? "" : formatMessageTime(this.timestamp);
		const clock =
			clockText !== "" && available - visibleWidth(clockText) - 2 >= MIN_TITLE_WIDTH_WITH_TIME
				? `  ${theme.fg("muted", clockText)}`
				: "";
		const recordedError: unknown = this.result?.details?.error;
		// Only failed tools need their output text; building it on every render of a
		// successful tool copies the full output per frame.
		const error = this.result?.isError
			? ` · ${theme.fg(
					"toolOutput",
					typeof recordedError === "string" ? recordedError.split("\n")[0] : this.getTextOutput().split("\n")[0],
				)}`
			: "";
		const budget = Math.max(
			1,
			available - visibleWidth(status) - 1 - visibleWidth(suffix) - visibleWidth(error) - visibleWidth(clock),
		);
		const renderedCall =
			(this.callRendererComponent ?? this.createCallFallback())
				.render(available)
				.find((line) => stripAnsi(line).trim()) ?? this.toolName;
		const plainCall = stripAnsi(renderedCall);
		const leading = visibleWidth(plainCall) - visibleWidth(plainCall.trimStart());
		const description = getToolCallDescription(this.args);
		const title = description
			? `${theme.fg("toolTitle", theme.bold(this.toolName))} ${theme.fg("accent", description)}`
			: sliceByColumn(renderedCall, leading, visibleWidth(plainCall.trim()));
		const call = truncateToWidth(title, budget, "…");
		const text = truncateToWidth(
			`${status} ${call}${error}${suffix}`,
			Math.max(1, available - visibleWidth(clock)),
			"…",
		);
		// The time sits at the right edge, like the thinking header, so a long title never hides it.
		const gap = Math.max(0, width - pad - visibleWidth(text) - visibleWidth(clock));
		const line = " ".repeat(pad) + text + " ".repeat(gap) + clock;
		const color = this.result?.isError ? "toolErrorBg" : this.isPartial ? "toolPendingBg" : "toolSuccessBg";
		return this.headerHovered ? highlightHover(line) : theme.bg(color, line);
	}

	override render(width: number): string[] {
		if (this.hideComponent) return [];
		if (
			this.getRenderShell() === "self" &&
			this.selfRenderContainer.render(width).length === 0 &&
			this.imageComponents.length === 0
		)
			return [];
		if (!this.expanded) return [...this.leadingSpacer.render(width), this.renderHeader(width)];
		return super.render(width);
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		const headerRow = this.leadingSpacer.render(event.width).length;
		const hoverEvent = event.type === "move" || event.type === "leave";
		const hovered = event.type === "move" && event.button === "none" && event.y === headerRow;
		const hoverChanged = hoverEvent && hovered !== this.headerHovered;
		if (hoverEvent) this.headerHovered = hovered;
		if (hoverChanged && !hovered) this.ui.requestRender();
		if (
			(hoverEvent && hovered) ||
			((event.type === "press" || event.type === "click") && event.button === "left" && event.y === headerRow)
		) {
			if (event.type === "click") this.setExpanded(!this.expanded);
			return {
				handled: true,
				render: hoverChanged || event.type === "click",
				target: {
					component: this,
					originX: event.screenX - event.x,
					originY: event.screenY - event.y,
					width: event.width,
					height: event.height,
				},
			};
		}
		if (!this.expanded || event.y <= headerRow) return undefined;
		return super.handleMouse(event);
	}

	private updateDisplay(): void {
		const bgFn = this.isPartial
			? (text: string) => theme.bg("toolPendingBg", text)
			: this.result?.isError
				? (text: string) => theme.bg("toolErrorBg", text)
				: (text: string) => theme.bg("toolSuccessBg", text);

		let hasContent = false;
		this.hideComponent = false;
		if (this.hasRendererDefinition()) {
			const renderContainer = this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox;
			if (renderContainer instanceof Box) {
				renderContainer.setBgFn(bgFn);
				renderContainer.setPaddingX(this.outputPad);
			}
			renderContainer.clear();

			const callRenderer = this.getCallRenderer();
			if (!callRenderer) {
				renderContainer.addChild(this.createBodyRegion(this.createCallFallback(), true));
				hasContent = true;
			} else {
				try {
					const component = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
					this.callRendererComponent = component;
					renderContainer.addChild(this.createBodyRegion(component, !getToolCallDescription(this.args)));
					hasContent = true;
				} catch {
					this.callRendererComponent = undefined;
					renderContainer.addChild(this.createBodyRegion(this.createCallFallback(), true));
					hasContent = true;
				}
			}

			if (this.result) {
				const resultRenderer = this.getResultRenderer();
				if (!resultRenderer) {
					const component = this.createResultFallback();
					if (component) {
						renderContainer.addChild(this.createBodyRegion(component));
						hasContent = true;
					}
				} else {
					try {
						const component = resultRenderer(
							{ content: this.result.content as any, details: this.result.details },
							{ expanded: this.expanded, isPartial: this.isPartial },
							theme,
							this.getRenderContext(this.resultRendererComponent),
						);
						this.resultRendererComponent = component;
						renderContainer.addChild(this.createBodyRegion(component));
						hasContent = true;
					} catch {
						this.resultRendererComponent = undefined;
						const component = this.createResultFallback();
						if (component) {
							renderContainer.addChild(this.createBodyRegion(component));
							hasContent = true;
						}
					}
				}
			}
		} else {
			this.contentText.setCustomBgFn(bgFn);
			this.contentText.setPaddingX(this.outputPad);
			this.contentText.setText(this.formatToolExecution());
			hasContent = true;
		}

		const previousImages = this.imageComponents;
		const previousSources = this.imageSources;
		for (const img of this.imageComponents) {
			this.removeChild(img);
		}
		this.imageComponents = [];
		this.imageSources = [];
		for (const spacer of this.imageSpacers) {
			this.removeChild(spacer);
		}
		this.imageSpacers = [];

		if (this.result) {
			const imageBlocks = this.result.content.filter((c) => c.type === "image");
			const caps = getCapabilities();
			for (const img of imageBlocks) {
				if (caps.images && this.showImages && img.data && img.mimeType) {
					const spacer = new Spacer(1);
					this.addChild(spacer);
					this.imageSpacers.push(spacer);
					const source = { data: img.data, mimeType: img.mimeType, widthCells: this.imageWidthCells };
					const index = this.imageComponents.length;
					const previous = previousSources[index];
					const imageComponent =
						previous?.data === source.data &&
						previous.mimeType === source.mimeType &&
						previous.widthCells === source.widthCells
							? previousImages[index]
							: new Image(
									source.data,
									source.mimeType,
									{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
									{ maxWidthCells: source.widthCells },
								);
					if (source.mimeType !== "image/png") {
						ensurePngTranscoder(() => {
							this.invalidate();
							this.ui.requestRender();
						});
					}
					this.imageComponents.push(imageComponent);
					this.imageSources.push(source);
					this.addChild(imageComponent);
				}
			}
		}

		if (this.hasRendererDefinition() && !hasContent && this.imageComponents.length === 0) {
			this.hideComponent = true;
		}
	}

	private getTextOutput(): string {
		return getRenderedTextOutput(this.result, this.showImages);
	}

	private formatToolExecution(): string {
		let text = "";
		const content = JSON.stringify(this.args, null, 2);
		if (content) text = content;
		const output = this.getTextOutput();
		if (output) {
			text += `\n${output}`;
		}
		return text;
	}
}
