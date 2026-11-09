import { afterEach, describe, expect, it, vi } from "vitest";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.ts";

describe("OutputAccumulator temp file failures", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("keeps the bounded tail when the temp file cannot be written", async () => {
		vi.stubEnv("TMPDIR", "/proc");
		const output = new OutputAccumulator({ maxBytes: 16, tempFilePrefix: "pie-test" });
		output.append(Buffer.from("a".repeat(64)));
		output.finish();
		await output.closeTempFile();
		// The stream error is delivered on a later tick.
		await new Promise((resolve) => setTimeout(resolve, 20));

		const snapshot = output.snapshot();
		expect(snapshot.content).toContain("a");
		expect(snapshot.fullOutputPath).toBeUndefined();
		expect((await output.readFullOutput(1024)).truncated).toBe(true);
	});
});
