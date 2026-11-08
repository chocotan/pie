import {
	type Component,
	type Focusable,
	Input,
	Markdown,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { getMarkdownTheme } from "../../modes/interactive/theme/theme.ts";
import { formatAnswerScalar } from "./format-answer.ts";
import type { QuestionAnswer, QuestionnaireResult, QuestionParams } from "./types.ts";

/** Native view for the rpiv questionnaire contract; uses the host's input and keybindings. */
export class QuestionnaireView implements Component, Focusable {
	focused = false;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keys: KeybindingsManager;
	private readonly params: QuestionParams;
	private readonly done: (result: QuestionnaireResult) => void;
	private readonly input = new Input({ placeholder: "Your answer" });
	private readonly answers = new Map<number, QuestionAnswer>();
	private readonly selected = new Map<number, Set<number>>();
	private readonly drafts = new Map<number, string>();
	private index = 0;
	private row = 0;
	private editing = false;
	private previewOffset = 0;
	private rowPositions: Array<{ from: number; to: number; row: number }> = [];
	private optionWidth = 0;
	private viewportOffset = 0;
	private inputRow = -1;
	private manualScroll = false;

	constructor(
		tui: TUI,
		theme: Theme,
		keys: KeybindingsManager,
		params: QuestionParams,
		done: (result: QuestionnaireResult) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keys = keys;
		this.params = params;
		this.done = done;
		this.input.onSubmit = (value) => {
			this.drafts.set(this.index, value);
			this.commit(value);
		};
		this.input.onEscape = () => {
			this.drafts.set(this.index, this.input.getValue());
			this.editing = false;
			this.tui.requestRender();
		};
	}
	private commit(custom?: string): void {
		const question = this.params.questions[this.index];
		if (!question) {
			this.done({ answers: [...this.answers.values()], cancelled: false });
			return;
		}
		const choice = question.options[this.row];
		const answer: QuestionAnswer = question.multiSelect
			? {
					questionIndex: this.index,
					question: question.question,
					kind: "multi",
					selected: question.options
						.filter((_option, index) => this.selected.get(this.index)?.has(index))
						.map((option) => option.label),
					answer: custom ?? this.drafts.get(this.index) ?? null,
				}
			: custom !== undefined
				? { questionIndex: this.index, question: question.question, kind: "custom", answer: custom }
				: {
						questionIndex: this.index,
						question: question.question,
						kind: "option",
						answer: choice.label,
						preview: choice.preview,
					};
		this.answers.set(this.index, answer);
		this.editing = false;
		if (this.params.questions.length === 1) this.done({ answers: [answer], cancelled: false });
		else {
			this.index++;
			this.row = 0;
			this.previewOffset = 0;
			this.tui.requestRender();
		}
	}
	private choose(): void {
		const question = this.params.questions[this.index];
		if (!question) {
			this.commit();
			return;
		}
		if (this.row === question.options.length) {
			this.editing = true;
			this.input.setValue(this.drafts.get(this.index) ?? "");
		} else if (question.multiSelect && this.row < question.options.length) {
			const values = this.selected.get(this.index) ?? new Set<number>();
			if (values.has(this.row)) values.delete(this.row);
			else values.add(this.row);
			this.selected.set(this.index, values);
		} else this.commit();
		this.tui.requestRender();
	}
	handleInput(data: string): void {
		this.manualScroll = false;
		if (this.editing) {
			this.input.handleInput(data);
			this.tui.requestRender();
			return;
		}
		if (this.keys.matches(data, "tui.select.cancel")) {
			this.done({ answers: [...this.answers.values()], cancelled: true });
			return;
		}
		const total = this.params.questions.length + 1;
		if (this.keys.matches(data, "app.question.next") || this.keys.matches(data, "app.question.previous")) {
			const delta = this.keys.matches(data, "app.question.previous") ? -1 : 1;
			this.index = (this.index + delta + total) % total;
			this.row = 0;
			this.previewOffset = 0;
		} else if (this.keys.matches(data, "tui.select.up")) this.row = Math.max(0, this.row - 1);
		else if (this.keys.matches(data, "tui.select.down")) {
			const question = this.params.questions[this.index];
			this.row = Math.min((question?.options.length ?? 0) + (question?.multiSelect ? 1 : 0), this.row + 1);
		} else if (this.keys.matches(data, "tui.select.confirm") || this.keys.matches(data, "app.question.toggle"))
			this.choose();
		else if (this.keys.matches(data, "tui.select.pageDown") || this.keys.matches(data, "tui.select.pageUp")) {
			const delta = this.keys.matches(data, "tui.select.pageUp") ? -1 : 1;
			const page = Math.max(1, this.tui.terminal.rows - 8);
			const question = this.params.questions[this.index];
			if (!question?.multiSelect && question?.options[this.row]?.preview)
				this.previewOffset = Math.max(0, this.previewOffset + delta * page);
			else this.viewportOffset = Math.max(0, this.viewportOffset + delta * page);
			this.manualScroll = true;
		}
		this.tui.requestRender();
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.editing && event.y === this.inputRow) return this.input.handleMouse({ ...event, y: 0, height: 1 });
		if (event.type !== "click" || event.button !== "left" || event.x >= this.optionWidth) return undefined;
		const position = this.rowPositions.find((item) => event.y >= item.from && event.y < item.to);
		if (!position) return undefined;
		this.row = position.row;
		this.choose();
		return { handled: true, focus: true };
	}
	invalidate(): void {
		this.input.invalidate();
	}
	render(width: number): string[] {
		const th = this.theme;
		const question = this.params.questions[this.index];
		const tabs = this.params.questions
			.map((item, index) => `${index === this.index ? ">" : ""}${this.answers.has(index) ? "✓ " : ""}${item.header}`)
			.concat(this.index === this.params.questions.length ? ">Submit" : "Submit")
			.join(" · ");
		const lines = [th.fg("accent", truncateToWidth(tabs, width, "…")), ""];
		this.rowPositions = [];
		this.inputRow = -1;
		if (!question) {
			for (const [index, answer] of this.answers)
				lines.push(
					...wrapTextWithAnsi(`${this.params.questions[index].header}: ${formatAnswerScalar(answer)}`, width),
				);
			const missing = this.params.questions
				.filter((_item, index) => !this.answers.has(index))
				.map((item) => item.header);
			if (missing.length) lines.push(th.fg("warning", `Unanswered: ${missing.join(", ")}`));
			lines.push("", th.fg("accent", "Submit selected answers"));
			this.rowPositions.push({ from: lines.length - 1, to: lines.length, row: 0 });
			this.optionWidth = width;
		} else {
			lines.push(...wrapTextWithAnsi(question.question, width), "");
			const option = question.options[this.row];
			const preview = !this.editing && !question.multiSelect ? option?.preview : undefined;
			const split = Boolean(preview) && width >= 100;
			const leftWidth = split ? Math.floor(width * 0.42) : width;
			this.optionWidth = leftWidth;
			const left: string[] = [];
			const options = question.options.map((item) => ({ label: item.label, description: item.description }));
			options.push({ label: "Type something.", description: "Write your own answer" });
			if (question.multiSelect) options.push({ label: "Next", description: "Save selected answers" });
			for (const [index, item] of options.entries()) {
				const marker =
					question.multiSelect && index < question.options.length
						? this.selected.get(this.index)?.has(index)
							? "[x]"
							: "[ ]"
						: `${index + 1}.`;
				const start = lines.length + left.length;
				left.push(
					...wrapTextWithAnsi(
						th.fg(
							index === this.row ? "accent" : "text",
							`${index === this.row ? ">" : " "} ${marker} ${item.label}`,
						),
						leftWidth,
					),
				);
				left.push(...wrapTextWithAnsi(th.fg("muted", `    ${item.description}`), leftWidth));
				this.rowPositions.push({ from: start, to: lines.length + left.length, row: index });
			}
			if (preview) {
				const previewWidth = split ? width - leftWidth - 3 : width;
				const rendered = new Markdown(preview, 0, 0, getMarkdownTheme()).render(previewWidth);
				const capacity = Math.max(3, this.tui.terminal.rows - lines.length - 5);
				this.previewOffset = Math.min(this.previewOffset, Math.max(0, rendered.length - capacity));
				const right = rendered.slice(this.previewOffset, this.previewOffset + capacity);
				if (split) {
					for (let index = 0; index < Math.max(left.length, right.length); index++) {
						const value = left[index] ?? "";
						lines.push(
							value +
								" ".repeat(Math.max(0, leftWidth - visibleWidth(value))) +
								th.fg("borderMuted", " │ ") +
								(right[index] ?? ""),
						);
					}
				} else lines.push(...left, th.fg("accent", "Preview"), ...right);
				if (rendered.length > capacity) lines.push(th.fg("muted", "Use page navigation to scroll the preview"));
			} else lines.push(...left);
			if (this.editing) {
				this.input.focused = this.focused;
				lines.push("", th.fg("muted", "Your answer:"));
				this.inputRow = lines.length;
				lines.push(...this.input.render(width));
			}
		}
		lines.push(
			"",
			th.fg("muted", truncateToWidth("Select / confirm · Next / previous question · Cancel", width, "…")),
		);
		const height = Math.max(1, Math.min(12, this.tui.terminal.rows - 2));
		const focus = this.editing
			? this.inputRow
			: (this.rowPositions.find((position) => position.row === this.row)?.from ?? 0);
		if (this.editing || !this.manualScroll) {
			if (focus < this.viewportOffset) this.viewportOffset = Math.max(0, focus - 1);
			else if (focus >= this.viewportOffset + height - 2) this.viewportOffset = Math.max(0, focus - height + 3);
		}
		this.viewportOffset = Math.min(this.viewportOffset, Math.max(0, lines.length - height));
		this.rowPositions = this.rowPositions.map((position) => ({
			...position,
			from: position.from - this.viewportOffset,
			to: position.to - this.viewportOffset,
		}));
		if (this.inputRow >= 0) this.inputRow -= this.viewportOffset;
		return lines
			.slice(this.viewportOffset, this.viewportOffset + height)
			.map((line) => truncateToWidth(line, width, ""));
	}
}
