import { describe, expect, test } from "vitest";
import { formatMessageTime } from "../src/modes/interactive/components/message-time.ts";

describe("formatMessageTime", () => {
	test("shows the clock time for a message from today", () => {
		const now = new Date(2025, 9, 26, 12, 0).getTime();
		expect(formatMessageTime(new Date(2025, 9, 26, 9, 5).getTime(), now)).toBe("09:05");
	});

	test("shows hours ago for a previous day within 24 hours", () => {
		const now = new Date(2025, 9, 26, 6, 0).getTime();
		expect(formatMessageTime(new Date(2025, 9, 25, 20, 0).getTime(), now)).toBe("10h ago");
	});

	test("shows days ago from 24 hours on", () => {
		const now = new Date(2025, 9, 26, 12, 0).getTime();
		expect(formatMessageTime(new Date(2025, 9, 25, 11, 0).getTime(), now)).toBe("1d ago");
		expect(formatMessageTime(new Date(2025, 9, 20, 11, 0).getTime(), now)).toBe("6d ago");
	});
});
