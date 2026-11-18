const STALL_DELAY_MS = 5 * 60 * 1000;

/** Report sustained inactivity once, then rearm only after new progress. */
export function monitorWorkProgress(onStalled: (idleSeconds: number) => void) {
	let lastProgress = performance.now();
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;

	function schedule(delayMs: number): void {
		timer = setTimeout(check, Math.ceil(delayMs));
		timer.unref();
	}

	function check(): void {
		timer = undefined;
		const idleMs = performance.now() - lastProgress;
		if (idleMs < STALL_DELAY_MS) schedule(STALL_DELAY_MS - idleMs);
		else onStalled(Math.floor(idleMs / 1000));
	}

	schedule(STALL_DELAY_MS);
	return {
		report(): void {
			if (stopped) return;
			lastProgress = performance.now();
			// Streams can report progress on every chunk. Keep the existing timer until its next check.
			if (timer === undefined) schedule(STALL_DELAY_MS);
		},
		stop(): void {
			stopped = true;
			clearTimeout(timer);
		},
	};
}
