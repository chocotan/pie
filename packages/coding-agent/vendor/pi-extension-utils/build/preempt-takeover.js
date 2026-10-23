/**
 * Capture-and-reissue state for user input that preempts a plugin-owned hidden
 * run (a decision/reflection inquiry the plugin aborts on user takeover).
 *
 * Why: pi-coding-agent 0.85.1 made `ctx.abort()` asynchronous. A user input
 * that arrives while the hidden run is still streaming is enqueued by Pi as
 * `steer` into that run; when the abort settles, Pi clears the steering queue
 * and the user's message is silently dropped. To avoid losing user input, the
 * host returns `handled` from its input hook for the takeover, captures the
 * text here, and re-issues it as a fresh user turn once the host is idle.
 *
 * This module owns only the *decisions and captured state*. All Pi effects —
 * aborting the hidden run, choosing `handled` vs `continue` in the input hook,
 * and calling `sendUserMessage` — belong to the consuming plugin's adapter.
 * The host decides whether an input "preempts" (it owns the relevant
 * decision/reflection state); this module only records and guards.
 *
 * Limitations:
 * - Single pending slot. The host MUST settle or `clear()` a pending takeover
 *   before capturing another; `capture` throws rather than silently overwrite.
 * - The re-entrancy guard matches on exact text. If the user genuinely retypes
 *   the identical message while a re-issue is pending, that one input passes
 *   through and clears the slot. The window is a single settle cycle.
 *
 * Usage:
 * ```ts
 * const takeover = new PreemptTakeover();
 * // In the plugin's input hook, when the input preempts an active hidden run:
 * takeover.capture(event.text);
 * ctx.abort();                       // host effect
 * return { action: "handled" };      // host effect: swallow the raw takeover
 * // ... but first, at the top of the input hook, let a re-issued text through:
 * if (takeover.isReissuedTakeover(event.text)) return { action: "continue" };
 * // Later, on agent_settled when the host is idle:
 * const text = takeover.takeForReissue();
 * if (text !== null) await options.pi.sendUserMessage(text);
 * ```
 */
export class PreemptTakeover {
    pending = null;
    /**
     * Record a takeover the host has decided to swallow. The text is stored
     * exactly as provided (no truncation or normalization).
     *
     * @throws if a takeover is already pending — settle or `clear()` first.
     */
    capture(text) {
        if (this.pending !== null) {
            throw new Error("PreemptTakeover: a takeover is already pending; settle or clear() before capturing another");
        }
        this.pending = { text, reissued: false };
    }
    /**
     * Re-entrancy guard. Returns true exactly once when `text` matches a
     * captured takeover that the host has already taken for re-issue, and clears
     * the slot so the re-issued message becomes a genuine new user turn instead
     * of being captured again. Returns false for any non-matching or
     * not-yet-reissued input and never clears the slot in that case.
     */
    isReissuedTakeover(text) {
        const pending = this.pending;
        if (pending === null || !pending.reissued || pending.text !== text) {
            return false;
        }
        this.pending = null;
        return true;
    }
    /**
     * Take the captured takeover for re-issue once the host is idle. Returns the
     * exact captured text and marks it re-issued so it is offered at most once;
     * returns `null` when nothing is pending or it was already taken.
     *
     * After taking, the host re-issues the text (e.g. `sendUserMessage`). When
     * that re-issued text re-enters the input hook, `isReissuedTakeover` lets it
     * through and clears the slot.
     */
    takeForReissue() {
        const pending = this.pending;
        if (pending === null || pending.reissued) {
            return null;
        }
        pending.reissued = true;
        return pending.text;
    }
    /** True while a takeover is captured and not yet cleared. */
    get hasPending() {
        return this.pending !== null;
    }
    /** Drop any pending takeover, returning to a freshly-constructed state. */
    clear() {
        this.pending = null;
    }
}
