// Adapted from @monotykamary/pi-retry 0.11.2 (MIT, Tom X Nguyen).
// Source: https://github.com/monotykamary/pi-retry at 6483ab0f204076aa3ec385746ec1d58f0625cc76.
// See packages/coding-agent/docs/third-party/pi-retry/NOTICE.md.
//
// Pie adaptation: no SDK prototype patching and no competing retry loop. The
// plugin runs on the public `agent_before_settle` boundary, which Pie reaches
// only after native retry and compaction declined to continue, so exactly one
// component owns each retry.
import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import type { ReadonlySessionManager } from "../../core/session-manager.ts";
import { calculateDelay, formatDuration, type RetryPolicy, readRetryPolicy } from "./config.ts";
import {
	getErrorCategory,
	hasEmptyStop,
	hasMaxTokensStop,
	isPermanentError,
	isQuotaExhaustedError,
	isRetryableError,
	lastProjectedAssistant,
} from "./patterns.ts";

/** One extra nudge is the whole budget for an empty or think-only response. */
const MAX_EMPTY_NUDGES = 1;
const RETRY_STATUS_KEY = "pie.retry-backoff";
const RETRY_TRIGGER_CUSTOM_TYPE = "pie.retry-retry";
const CONTINUATION_CUSTOM_TYPE = "pie.retry-continue";
const BACKOFF_SLICE_MS = 250;

const RETRY_MESSAGE = "Retry the previous request.";
const CONTINUATION_MESSAGE = "Continue exactly where you left off without repeating content.";
const EMPTY_STOP_MESSAGE =
	"Your previous turn contained only thinking and no answer or text. Continue now and produce the actual response, using tools if needed.";

export default function retryExtension(pi: ExtensionAPI): void {
	let retryAttempts = 0;
	let maxDelayRetries = 0;
	let continuations = 0;
	let emptyNudges = 0;
	let generation = 0;
	let overflowNoticeShown = false;

	const resetCounters = () => {
		retryAttempts = 0;
		maxDelayRetries = 0;
		continuations = 0;
		emptyNudges = 0;
		overflowNoticeShown = false;
	};

	const policy = (): RetryPolicy => readRetryPolicy(pi.getSettings());
	const nativeRetryEnabled = () => pi.getSettings().retry?.enabled ?? true;
	const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error") =>
		ctx.ui.notify(message, level);
	const setStatus = (ctx: ExtensionContext, text: string | undefined) => {
		try {
			ctx.ui.setStatus(RETRY_STATUS_KEY, text);
		} catch {
			// A closing or headless UI must not break the retry.
		}
	};

	/**
	 * Wait out the backoff in slices so new input or a session shutdown cancels
	 * it within one slice. Returns false when the wait was cancelled or aborted.
	 */
	const backoff = async (ctx: ExtensionContext, delayMs: number, attempt: number, own: number): Promise<boolean> => {
		const deadline = Date.now() + delayMs;
		setStatus(ctx, `retry ${attempt} in ${formatDuration(delayMs)}`);
		try {
			while (Date.now() < deadline) {
				if (generation !== own) return false;
				await new Promise((resolve) => setTimeout(resolve, Math.min(BACKOFF_SLICE_MS, deadline - Date.now())));
				if (generation !== own) return false;
				setStatus(ctx, `retry ${attempt} in ${formatDuration(Math.max(0, deadline - Date.now()))}`);
			}
			return true;
		} finally {
			setStatus(ctx, undefined);
		}
	};

	const cancelled = (own: number) => generation !== own;

	pi.on("agent_before_settle", async (event, ctx) => {
		const assistant = lastProjectedAssistant(event.context.contextEntries);
		if (!assistant) return undefined;
		if (assistant.stopReason !== "error" && !hasMaxTokensStop(assistant) && !hasEmptyStop(assistant))
			return undefined;

		const own = generation;
		const settings = policy();
		const drafts = [...(event.entries ?? [])];

		// A response that stopped early or produced nothing keeps its own turn,
		// so the continuation is queued as a hidden provider-valid user message.
		if (hasMaxTokensStop(assistant) || hasEmptyStop(assistant)) {
			const empty = hasEmptyStop(assistant);
			if (empty && (!settings.retryEmptyStop || emptyNudges >= MAX_EMPTY_NUDGES)) {
				if (settings.retryEmptyStop) {
					notify(
						ctx,
						"Empty response after one continuation — giving up (the model keeps ending its turn with no output).",
						"warning",
					);
				}
				return undefined;
			}
			if (!empty && (!settings.retryContinuations || continuations >= settings.maxContinuations)) {
				if (settings.retryContinuations) {
					notify(
						ctx,
						`Response still truncated after ${settings.maxContinuations} continuations — giving up.`,
						"warning",
					);
				}
				return undefined;
			}

			const attempt = empty ? retryAttempts + 1 : retryAttempts;
			if (empty) emptyNudges++;
			else continuations++;
			notify(
				ctx,
				empty
					? `Empty response — nudging once to produce output.`
					: `Output limit reached — continuing the response (${continuations}/${settings.maxContinuations}).`,
				"info",
			);
			if (!(await backoff(ctx, calculateDelay(attempt + 1, settings), attempt + 1, own))) return undefined;
			if (cancelled(own)) return undefined;
			drafts.push({
				type: "custom_message",
				customType: empty ? CONTINUATION_CUSTOM_TYPE : CONTINUATION_CUSTOM_TYPE,
				content: empty ? EMPTY_STOP_MESSAGE : CONTINUATION_MESSAGE,
				display: false,
			});
			return { entries: drafts, continue: true };
		}

		// Context overflow is compaction's job; retrying it in place would loop.
		if (isContextOverflow(assistant)) {
			if (!overflowNoticeShown) {
				overflowNoticeShown = true;
				notify(ctx, "Context overflow — deferring to compaction instead of retrying.", "info");
			}
			return undefined;
		}
		if (isPermanentError(assistant)) {
			notify(ctx, `Non-retryable error (not retried): ${(assistant.errorMessage ?? "").slice(0, 120)}`, "error");
			return undefined;
		}
		if (isQuotaExhaustedError(assistant)) {
			notify(
				ctx,
				`Quota or budget exhausted — not retrying. Fix the plan, billing, or wait for the reset window, then run /retry.`,
				"error",
			);
			return undefined;
		}
		if (!isRetryableError(assistant)) return undefined;

		// While native retry is enabled it owns every error it classifies, so the
		// plugin never runs a second backoff schedule over the same failure. With
		// native retry disabled the plugin catches those errors too.
		if (nativeRetryEnabled() && isRetryableAssistantError(assistant)) return undefined;

		if (maxDelayRetries >= settings.maxRetriesAtMaxDelay) {
			notify(
				ctx,
				`Retry failed ${settings.maxRetriesAtMaxDelay} times at the maximum backoff (${formatDuration(settings.maxDelayMs)}) — giving up.`,
				"warning",
			);
			return undefined;
		}

		retryAttempts++;
		const delay = calculateDelay(retryAttempts, settings);
		if (delay >= settings.maxDelayMs) maxDelayRetries++;
		const category = getErrorCategory(assistant);
		if (retryAttempts === 1) {
			notify(ctx, `Retrying after ${category} error: ${(assistant.errorMessage ?? "").slice(0, 120)}`, "info");
		}
		if (!(await backoff(ctx, delay, retryAttempts, own))) return undefined;
		if (cancelled(own)) return undefined;

		// Omit the failed response from the model projection so the same request
		// is sent again. The raw history keeps it, exactly like native retry.
		const failed = event.context.contextEntries.findLast((entry) => entry.messages.includes(assistant))?.sourceEntry
			.id;
		if (!failed) return undefined;
		drafts.push({ type: "context_edit", targetId: failed, replacement: null });
		return { entries: drafts, continue: true };
	});

	pi.on("turn_end", (event) => {
		const message = event.message;
		if (message.role !== "assistant") return;
		if (message.stopReason === "error" || message.stopReason === "length") return;
		if (hasEmptyStop(message)) return;
		resetCounters();
	});

	pi.on("input", () => {
		generation++;
		resetCounters();
	});

	pi.on("session_shutdown", () => {
		generation++;
		resetCounters();
	});

	pi.registerCommand("retry", {
		description: "Retry controls: /retry, /retry status, /retry reset",
		async handler(args, ctx) {
			const settings = policy();
			const subcommand = args.trim().split(/\s+/)[0]?.toLowerCase();

			if (subcommand === "status") {
				const last = lastAssistantOf(ctx.sessionManager);
				notify(
					ctx,
					[
						"=== Pie retry status ===",
						`Error retries: ${retryAttempts}`,
						`Retries at max delay: ${maxDelayRetries}/${settings.maxRetriesAtMaxDelay}`,
						`Output continuations: ${continuations}/${settings.maxContinuations}`,
						`Empty-response nudges: ${emptyNudges}/${MAX_EMPTY_NUDGES}`,
						`Backoff: ${settings.baseDelayMs}ms x${settings.multiplier}, max ${settings.maxDelayMs}ms`,
						`Last stop reason: ${last?.stopReason ?? "none"}`,
						`Last error: ${(last?.errorMessage ?? "none").slice(0, 120)}`,
						"Native retry runs first; this plugin covers the errors it declines.",
					].join("\n"),
					"info",
				);
				return;
			}

			if (subcommand === "reset") {
				generation++;
				resetCounters();
				notify(ctx, "Retry counters reset.", "info");
				return;
			}

			const last = lastAssistantOf(ctx.sessionManager);
			if (!last) {
				notify(ctx, "No assistant message to retry.", "warning");
				return;
			}
			if (last.stopReason === "error") {
				if (isContextOverflow(last)) {
					notify(
						ctx,
						"Context overflow — use /compact to reduce context; compaction retries automatically.",
						"info",
					);
					return;
				}
				if (isPermanentError(last)) {
					notify(ctx, "Non-retryable error — fix the underlying issue first, then /retry.", "warning");
					return;
				}
				if (isQuotaExhaustedError(last)) {
					notify(ctx, "Quota or budget exhausted — resolve the plan or billing issue first.", "warning");
					return;
				}
			} else if (!hasMaxTokensStop(last) && !hasEmptyStop(last)) {
				notify(
					ctx,
					"No retryable error or truncated response found. Use /retry status for diagnostics.",
					"warning",
				);
				return;
			}

			// Manual retries start from idle, where only a queued message can
			// continue the run, so they always use one hidden message.
			generation++;
			resetCounters();
			notify(ctx, "Retrying now…", "info");
			pi.sendMessage(
				{
					customType: RETRY_TRIGGER_CUSTOM_TYPE,
					content: hasEmptyStop(last)
						? EMPTY_STOP_MESSAGE
						: hasMaxTokensStop(last)
							? CONTINUATION_MESSAGE
							: RETRY_MESSAGE,
					display: false,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		},
	});
}

function lastAssistantOf(manager: ReadonlySessionManager) {
	for (const entry of [...manager.getEntries()].reverse()) {
		if (entry.type !== "message") continue;
		if (entry.message.role === "assistant") return entry.message;
	}
	return undefined;
}
