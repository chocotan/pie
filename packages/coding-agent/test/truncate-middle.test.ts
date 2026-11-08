import { describe, expect, it } from "vitest";
import { truncateMiddle } from "../src/core/tools/truncate.ts";

describe("truncateMiddle", () => {
	it("returns content within the byte limit unchanged", () => {
		expect(truncateMiddle("short output", 32)).toMatchObject({
			content: "short output",
			truncated: false,
			removedChars: 0,
		});
	});

	it("keeps both ends and cuts only at UTF-8 character boundaries", () => {
		const content = `开头${"a".repeat(1000)}结尾`;
		const result = truncateMiddle(content, 40);
		expect(result.truncated).toBe(true);
		expect(result.content.startsWith("开头")).toBe(true);
		expect(result.content.endsWith("结尾")).toBe(true);
		expect(result.content).toContain("chars truncated");
		expect(result.removedChars).toBeGreaterThan(0);
	});
});
