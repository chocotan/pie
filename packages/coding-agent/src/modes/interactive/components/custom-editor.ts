import {
	CURSOR_MARKER,
	Editor,
	type EditorOptions,
	type EditorTheme,
	type TUI,
	type TuiMouseEvent,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.ts";
import type { StatusIndicator } from "./status-indicator.ts";

export type CustomEditorOptions = EditorOptions & {
	/** Render working, compaction, summarization, and retry status in the editor's top border. */
	embedWorkingStatus?: boolean;
	getChrome?: () => { model: string; thinking?: string; status: string };
};

/**
 * Custom editor that handles app-level keybindings for coding-agent.
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	private workingStatusIndicator: StatusIndicator | undefined;
	private readonly getChrome: CustomEditorOptions["getChrome"];
	private bottomBorder = "";
	public readonly embedWorkingStatus: boolean;
	public actionHandlers: Map<AppKeybinding, () => void> = new Map();

	// Special handlers that can be dynamically replaced
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	/** Handler for extension-registered shortcuts. Returns true if handled. */
	public onExtensionShortcut?: (data: string) => boolean;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: CustomEditorOptions) {
		super(tui, theme, options);
		this.keybindings = keybindings;
		this.embedWorkingStatus = options?.embedWorkingStatus ?? false;
		this.getChrome = options?.getChrome;
	}

	setWorkingStatusIndicator(indicator: StatusIndicator | undefined): void {
		this.workingStatusIndicator = indicator;
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		const chrome = this.getChrome?.();
		const indicator = this.embedWorkingStatus ? this.workingStatusIndicator : undefined;
		if ((!chrome && !indicator) || width < 8) return super.renderTopBorder(width, hiddenLineCount);
		const overflow = hiddenLineCount ? ` ↑${hiddenLineCount} ` : "";
		let status = chrome?.status ?? "";
		if (indicator) {
			const text =
				chrome && indicator.kind === "working"
					? indicator.renderSpinnerInBorder(2)
					: indicator.renderInBorder(Math.max(1, chrome ? Math.floor(width / 2) : width - 5));
			status = [text, status].filter(Boolean).join(" ");
		}
		const suffix = chrome?.thinking ? ` · ${chrome.thinking}` : "";
		if (!chrome?.model && !suffix) {
			status = truncateToWidth(status, Math.max(0, width - visibleWidth(overflow) - 3), "");
			const fill = Math.max(0, width - visibleWidth(status) - visibleWidth(overflow) - 3);
			return this.borderColor("─ ") + status + this.borderColor(` ${overflow}${"─".repeat(fill)}`);
		}
		const reserve = Math.min(width - 4, visibleWidth(suffix) + 4);
		status = truncateToWidth(status, Math.max(0, width - reserve - visibleWidth(overflow) - 5), "");
		const budget = Math.max(0, width - visibleWidth(status) - visibleWidth(overflow) - 5);
		const model = truncateToWidth(chrome?.model ?? "", Math.max(0, budget - visibleWidth(suffix)), "…");
		const label = truncateToWidth(model + suffix, budget, "");
		const middle = Math.max(0, width - visibleWidth(label) - visibleWidth(overflow) - visibleWidth(status) - 5);
		return this.borderColor(`─ ${label}${overflow}${"─".repeat(middle)} `) + status + this.borderColor(" ─");
	}

	protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
		this.bottomBorder = super.renderBottomBorder(width, hiddenLineCount);
		return this.bottomBorder;
	}

	override render(width: number): string[] {
		if (width < 3)
			return super.render(width).map((line) => {
				const clipped = truncateToWidth(line, width, "");
				return line.includes(CURSOR_MARKER) && !clipped.includes(CURSOR_MARKER) ? CURSOR_MARKER + clipped : clipped;
			});
		const lines = super.render(width - 2);
		const bottom = lines.findIndex((line, index) => index > 0 && line === this.bottomBorder);
		return lines.map((line, index) => {
			if (index === 0) return this.borderColor("╭") + line + this.borderColor("╮");
			if (index === bottom) return this.borderColor("╰") + line + this.borderColor("╯");
			if (index < bottom) return truncateToWidth(this.borderColor("│") + line + this.borderColor("│"), width, "");
			return ` ${line} `;
		});
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<Editor["handleMouse"]> {
		return super.handleMouse(
			event.width < 3 ? event : { ...event, x: Math.max(0, event.x - 1), width: event.width - 2 },
		);
	}

	/**
	 * Register a handler for an app action.
	 */
	onAction(action: AppKeybinding, handler: () => void): void {
		this.actionHandlers.set(action, handler);
	}

	handleInput(data: string): void {
		// Check extension-registered shortcuts first
		if (this.onExtensionShortcut?.(data)) {
			return;
		}

		// Selection page keys move an open autocomplete menu before app actions run.
		// This lets users bind Ctrl+V even though it pastes images by default.
		if (
			this.isShowingAutocomplete() &&
			(this.keybindings.matches(data, "tui.select.pageUp") || this.keybindings.matches(data, "tui.select.pageDown"))
		) {
			super.handleInput(data);
			return;
		}

		// Check for clipboard paste keybinding
		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return;
		}

		// Check app keybindings first

		// Escape/interrupt - only if autocomplete is NOT active
		if (this.keybindings.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete()) {
				// Use dynamic onEscape if set, otherwise registered handler
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return;
				}
			}
			// Let parent handle escape for autocomplete cancellation
			super.handleInput(data);
			return;
		}

		// Exit (Ctrl+D) - only when editor is empty
		if (this.keybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return;
			}
			// Fall through to editor handling for delete-char-forward when not empty
		}

		// Explicit history bindings take precedence over app actions while the editor is focused.
		// This lets users bind Ctrl+P even though it cycles models by default.
		if (
			this.keybindings.matches(data, "tui.editor.historyPrevious") ||
			this.keybindings.matches(data, "tui.editor.historyNext")
		) {
			super.handleInput(data);
			return;
		}

		// Check all other app actions
		for (const [action, handler] of this.actionHandlers) {
			if (action !== "app.interrupt" && action !== "app.exit" && this.keybindings.matches(data, action)) {
				handler();
				return;
			}
		}

		// Pass to parent for editor handling
		super.handleInput(data);
	}
}
