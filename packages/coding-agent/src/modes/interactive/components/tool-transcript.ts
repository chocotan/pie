import { type Component, Container, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { stripAnsi } from "../../../utils/ansi.ts";
import { ToolExecutionComponent } from "./tool-execution.ts";

/** Lay out adjacent visible tools together, including tool-only assistant messages between them. */
export class ToolTranscriptContainer extends Container {
	private readonly layout = new Container();
	/**
	 * Blankness of a child's rendered lines, reused while the child returns the same array.
	 * Scanning every line of every child on every frame cost more than composing the transcript,
	 * and a component that redraws returns a new array, so the reference is a sound key.
	 */
	private readonly blankLines = new WeakMap<Component, { lines: readonly string[]; blank: boolean }>();

	private isBlank(child: Component, lines: readonly string[]): boolean {
		const cached = this.blankLines.get(child);
		if (cached && cached.lines === lines) return cached.blank;
		const blank = !lines.some((line) => stripAnsi(line).trim());
		this.blankLines.set(child, { lines, blank });
		return blank;
	}

	override render(width: number): string[] {
		this.layout.clear();
		let previousIsTool = false;
		let gaps: Component[] = [];
		for (const child of this.children) {
			const isTool = child instanceof ToolExecutionComponent;
			if (isTool) child.setLeadingGap(!previousIsTool);
			const rendered = child.render(width);
			if (this.isBlank(child, rendered)) {
				if (rendered.length) gaps.push(child);
				continue;
			}
			if (!isTool || !previousIsTool) {
				for (const gap of gaps) this.layout.addChild(gap);
			}
			gaps = [];
			this.layout.addChild(child);
			previousIsTool = isTool;
		}
		for (const gap of gaps) this.layout.addChild(gap);
		return this.layout.render(width);
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		return this.layout.handleMouse(event);
	}
}
