import { describe, expect, test } from "vitest";
import { formatMessageTime } from "../src/modes/interactive/components/message-time.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const BG_RESET = "\x1b[49m";

describe("UserMessageComponent", () => {
	test.each(["light", "dark"])("renders a full-width user background in %s theme", (name) => {
		initTheme(name, false);
		const lines = new UserMessageComponent("Hello world").render(48);
		const background = theme.getBgAnsi("userMessageBg");
		expect(background).not.toBe("");
		expect(lines.every((line) => line.includes(background))).toBe(true);
		expect(lines.map(stripAnsi).some((line) => line.includes("Hello world"))).toBe(true);
	});
	test("keeps user message height stable while moving closing OSC markers off line end", () => {
		initTheme("dark");

		const component = new UserMessageComponent("hello");
		const lines = component.render(20);

		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[0].endsWith(BG_RESET)).toBe(true);
		expect(lines[0]).not.toContain(OSC133_ZONE_END);
		expect(lines[1]).toContain("hello");
		expect(lines[2].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
		expect(lines[2].endsWith(BG_RESET)).toBe(true);
	});

	test("right-aligns the time inside the message background", () => {
		initTheme("dark");
		const timestamp = Date.now();
		const component = new UserMessageComponent("hello", undefined, 1, [], timestamp);
		const lines = component.render(40);

		// The time replaces the Markdown's bottom padding row, so height is unchanged.
		expect(lines).toHaveLength(3);
		const timeRow = stripAnsi(lines[2]);
		expect(timeRow).toContain(formatMessageTime(timestamp));
		expect(timeRow.trimEnd().endsWith(formatMessageTime(timestamp))).toBe(true);
		expect(lines[2]).toContain(theme.getBgAnsi("userMessageBg"));
		expect(stripAnsi(lines[1])).toContain("hello");
	});

	test("chains Markdown transformers with user message context", () => {
		initTheme("dark");
		const calls: string[] = [];
		const component = new UserMessageComponent("The input is $x^2$.", undefined, 1, [
			(markdown, context) => {
				calls.push("formula");
				expect(context).toEqual({ messageType: "user", isStreaming: false, availableWidth: 78 });
				return markdown.replace("$x^2$", "x²");
			},
			(markdown) => {
				calls.push("suffix");
				return `${markdown} Done.`;
			},
		]);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("The input is x². Done.");
		expect(calls).toEqual(["formula", "suffix"]);
	});

	test("reapplies Markdown transformers when invalidated", () => {
		initTheme("dark");
		let suffix = "before";
		const component = new UserMessageComponent("Message", undefined, 1, [(markdown) => `${markdown} ${suffix}`]);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("Message before");

		suffix = "after";
		component.invalidate();

		expect(stripAnsi(component.render(80).join("\n"))).toContain("Message after");
	});
});
