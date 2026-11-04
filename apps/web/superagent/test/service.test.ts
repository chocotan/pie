import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Trigger } from "../src/core/index.ts";
import { SettingsSchema } from "../src/policy.ts";
import { RecordingSessions, SuperagentService } from "../src/service.ts";

function trigger(text = "@agent 修复错字"): Trigger {
	return {
		id: "trigger-1",
		source: "github",
		threads: [{ source: "github", id: "12" }],
		actor: { source: "github", id: "alice" },
		human: true,
		addressed: "mention",
		at: "2026-11-02T00:00:00.000Z",
		text,
		channel: { source: "github", thread: "github:12", address: { number: "12" } },
		meta: { number: 12 },
	};
}

describe("superagent service", () => {
	it("accepts an explicit request, starts a worker, and records a report", async () => {
		const sessions = new RecordingSessions();
		const service = new SuperagentService({
			stateDir: mkdtempSync(join(tmpdir(), "pie-superagent-")),
			sessions,
			settings: SettingsSchema.parse({
				policy: { sources: { github: { allowed: [{ id: "alice" }] } } },
			}),
			deployment: {
				stateDir: "/tmp/state",
				repository: "owner/repo",
				github: { cli: "gh", login: "agent", noreply: "agent@example.test" },
			},
		});
		expect(service.receive(trigger())).toBe("stored");
		const ticket = service.accept("trigger-1", "修复错字");
		await Promise.resolve();
		expect(sessions.prompts[0]).toContain(ticket.id);
		const updated = service.report(ticket.id, { state: "ready", summary: "已修复" });
		expect(updated.assignments.at(-1)?.report?.state).toBe("ready");
		expect(service.overview().tickets).toHaveLength(1);
		expect(service.replies.map((reply) => reply.text)).toContain("已接单");
	});
});
