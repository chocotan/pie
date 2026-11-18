import { describe, expect, it } from "vitest";
import { type SubagentRecord, sortSubagents } from "../src/extensions/subagents/index.ts";

const record = (id: string, status: SubagentRecord["status"], startedAt: number): SubagentRecord => ({
	id,
	agent: "worker",
	description: id,
	prompt: "verify order",
	status,
	model: "faux/local",
	thinking: "high",
	startedAt,
	output: "",
});

describe("sortSubagents", () => {
	it("puts running agents first and sorts each group newest first", () => {
		const records = [
			record("completed-new", "completed", 9),
			record("running-old", "running", 2),
			record("interrupted", "interrupted", 7),
			record("running-new", "running", 8),
			record("queued", "queued", 6),
		];
		expect(sortSubagents(records).map((item) => item.id)).toEqual([
			"running-new",
			"running-old",
			"completed-new",
			"interrupted",
			"queued",
		]);
	});
});
