/**
 * Reuses a component's rendered lines across frames.
 *
 * The TUI re-renders the whole tree for every frame (spinners tick several times
 * a second), so a long transcript re-measures every row each time. Components
 * that own their layout call {@link invalidate} whenever their output can change.
 */
export class RenderCache {
	private version = 0;
	private key: string | null = null;
	private lines: string[] = [];

	invalidate(): void {
		this.version += 1;
	}

	render(key: string, build: () => string[]): string[] {
		const full = `${this.version}\u0000${key}`;
		if (full !== this.key) {
			this.lines = build();
			this.key = full;
		}
		return this.lines;
	}
}
