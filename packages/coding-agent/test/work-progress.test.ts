import { afterEach, describe, expect, it, vi } from "vitest";
import { monitorWorkProgress } from "../src/extensions/work-progress.ts";

const fiveMinutes = 5 * 60 * 1000;

afterEach(() => vi.useRealTimers());

describe("work progress monitor", () => {
	it("waits for five minutes of silence and reports once until activity resumes", () => {
		vi.useFakeTimers();
		const stalled = vi.fn();
		const progress = monitorWorkProgress(stalled);
		vi.advanceTimersByTime(fiveMinutes - 1);
		progress.report();
		vi.advanceTimersByTime(fiveMinutes - 1);
		expect(stalled).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(stalled).toHaveBeenCalledExactlyOnceWith(300);
		vi.advanceTimersByTime(fiveMinutes * 2);
		expect(stalled).toHaveBeenCalledOnce();
		progress.report();
		vi.advanceTimersByTime(fiveMinutes);
		expect(stalled).toHaveBeenCalledTimes(2);
		progress.report();
		progress.stop();
		progress.report();
		vi.advanceTimersByTime(fiveMinutes);
		expect(stalled).toHaveBeenCalledTimes(2);
	});
});
