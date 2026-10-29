import { describe, expect, it } from "vitest";
import { toTrajectoryDto, toTrajectoryEntry, TRAJECTORY_ENTRY_LIMIT, TRAJECTORY_RAW_LIMIT } from "../host/runtime.ts";

describe("toTrajectoryEntry", () => {
	it("normalizes tool call field spellings inside persisted messages", () => {
		const entry = toTrajectoryEntry({
			id: "e1",
			parentId: null,
			type: "message",
			timestamp: "2026-01-01T00:00:00.000Z",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", toolCallId: "c1", toolName: "read", input: { path: "/a" } }],
			},
		});
		expect(entry?.message?.content).toEqual([
			{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/a" } },
		]);
		expect(entry?.timestamp).toBe("2026-01-01T00:00:00.000Z");
	});

	it("projects non-message entries", () => {
		expect(
			toTrajectoryEntry({ id: "c", parentId: "p", type: "compaction", summary: "压缩摘要" }),
		).toMatchObject({ type: "compaction", summary: "压缩摘要" });
		expect(
			toTrajectoryEntry({ id: "m", type: "model_change", provider: "faux", modelId: "faux-large" }),
		).toMatchObject({ provider: "faux", modelId: "faux-large" });
		expect(toTrajectoryEntry({ id: "l", type: "thinking_level_change", thinkingLevel: "high" })).toMatchObject({
			level: "high",
		});
		expect(toTrajectoryEntry({ id: "n", type: "session_info", name: "标题" })).toMatchObject({ name: "标题" });
	});

	it("rejects entries without an id, type or valid message", () => {
		expect(toTrajectoryEntry({ type: "message" })).toBeNull();
		expect(toTrajectoryEntry({ id: "x" })).toBeNull();
		expect(toTrajectoryEntry({ id: "x", type: "message", message: { nope: true } })).toBeNull();
	});

	it("caps the raw JSON kept for the inspector", () => {
		const entry = toTrajectoryEntry({
			id: "e1",
			type: "message",
			message: { role: "user", content: "x".repeat(TRAJECTORY_RAW_LIMIT * 2) },
		});
		expect(entry?.raw.length).toBeLessThan(TRAJECTORY_RAW_LIMIT + 100);
		expect(entry?.raw.endsWith("（原始内容已截断）")).toBe(true);
	});
});

describe("toTrajectoryDto", () => {
	it("keeps the newest entries when the session exceeds the limit", () => {
		const entries = Array.from({ length: TRAJECTORY_ENTRY_LIMIT + 5 }, (_, index) => ({
			id: `e${index}`,
			type: "custom",
			customType: "note",
		}));
		const dto = toTrajectoryDto({ sessionId: "s1", entries });
		expect(dto?.entries).toHaveLength(TRAJECTORY_ENTRY_LIMIT);
		expect(dto?.entries[0].id).toBe("e5");
		expect(dto?.sessionId).toBe("s1");
	});

	it("rejects malformed payloads", () => {
		expect(toTrajectoryDto(null)).toBeNull();
		expect(toTrajectoryDto({ sessionId: "s1" })).toBeNull();
	});
});
