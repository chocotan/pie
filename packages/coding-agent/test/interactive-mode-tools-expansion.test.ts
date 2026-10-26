import { Container, Text } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("InteractiveMode.setToolsExpanded custom messages", () => {
	test.each(["background-task-notification", "pie.subagent-completion"])(
		"expands and collapses an existing %s message",
		(customType) => {
			initTheme("dark");
			const component = new CustomMessageComponent(
				{ role: "custom", customType, content: "details", display: true, timestamp: 0 },
				(_message, { expanded }) => new Text(expanded ? "summary\ndetails" : "summary", 0, 0),
			);
			const chatContainer = new Container();
			chatContainer.addChild(component);
			const context = {
				toolOutputExpanded: false,
				customHeader: undefined,
				builtInHeader: undefined,
				loadedResourcesContainer: new Container(),
				chatContainer,
				showStatus: vi.fn(),
			};
			const prototype = InteractiveMode.prototype as unknown as {
				setToolsExpanded(this: typeof context, expanded: boolean): void;
			};

			expect(component.render(80).map(stripAnsi).join("\n")).not.toContain("details");
			prototype.setToolsExpanded.call(context, true);
			expect(
				component
					.render(80)
					.map((line) => stripAnsi(line).trimEnd())
					.join("\n"),
			).toContain("summary\ndetails");
			expect(context.toolOutputExpanded).toBe(true);
			expect(context.showStatus).toHaveBeenLastCalledWith("Tool output: expanded");

			prototype.setToolsExpanded.call(context, false);
			expect(component.render(80).map(stripAnsi).join("\n")).not.toContain("details");
			expect(context.toolOutputExpanded).toBe(false);
			expect(context.showStatus).toHaveBeenLastCalledWith("Tool output: collapsed");
		},
	);
});
