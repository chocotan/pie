// Adapted from @monotykamary/pi-retry 0.11.2 (MIT, Tom X Nguyen).
// Source: https://github.com/monotykamary/pi-retry at 6483ab0f204076aa3ec385746ec1d58f0625cc76.
// See packages/coding-agent/docs/third-party/pi-retry/NOTICE.md.
//
// Pie adaptation: no SDK prototype patching. The plugin takes over the built-in
// agent-turn retry scheduler through the supported `pi.setNativeRetryEnabled()`
// action and owns the backoff on the public `agent_before_settle` boundary, so
// exactly one component retries a failure.
import { isContextOverflow } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import type { ReadonlySessionManager } from "../../core/session-manager.ts";
import {
	calculateDelay,
	formatDuration,
	matchesSystemPrompt,
	type RetryPolicy,
	type RetrySettings,
	readRetrySettings,
} from "./config.ts";
import {
	getErrorCategory,
	hasEmptyStop,
	hasMaxTokensStop,
	isErrorStop,
	isPermanentError,
	isQuotaExhaustedError,
	lastProjectedAssistant,
	type RetryCategory,
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

/** First-attempt wording per category; the retry itself is the same for all of them. */
const CATEGORY_NOTICE: Record<RetryCategory, string> = {
	"400-413": "Retrying after a 400/413 error; if the payload is genuinely too large this keeps failing.",
	credit: "Retrying after a credit error; a mid-session top-up lets the retry resume.",
	connection: "Retrying after a connection error.",
	server: "Retrying after a server error.",
	other: "Retrying after an error.",
};

interface CategoryState {
	attempts: number;
	lastError: string;
}

export default function retryExtension(pi: ExtensionAPI): void {
	let resolved: RetrySettings = readRetrySettings({});
	let usesSubagentPolicy = false;
	let retryAttempts = 0;
	let maxDelayRetries = 0;
	let continuations = 0;
	let emptyNudges = 0;
	let generation = 0;
	let lifecycleId = 0;
	let overflowNoticeShown = false;
	const categories: Record<RetryCategory, CategoryState> = {
		"400-413": { attempts: 0, lastError: "" },
		credit: { attempts: 0, lastError: "" },
		connection: { attempts: 0, lastError: "" },
		server: { attempts: 0, lastError: "" },
		other: { attempts: 0, lastError: "" },
	};

	const resetCounters = () => {
		retryAttempts = 0;
		maxDelayRetries = 0;
		continuations = 0;
		emptyNudges = 0;
		overflowNoticeShown = false;
		for (const state of Object.values(categories)) {
			state.attempts = 0;
			state.lastError = "";
		}
	};

	/** `retry.enabled` is the master switch; the RPC `set_auto_retry` command toggles it. */
	const autoRetryEnabled = (): boolean => pi.getSettings().retry?.enabled ?? true;
	/** The policy governing this session: the matched subagent policy, or the main one. */
	const activePolicy = (): RetryPolicy => (usesSubagentPolicy ? resolved.subagents : resolved.main);
	/** Whether the plugin retries this session at all. */
	const ownsRetry = (): boolean => !(usesSubagentPolicy && !resolved.subagents.enabled);

	const readSystemPrompt = (ctx: { getSystemPrompt?: () => string }): string => {
		try {
			return typeof ctx.getSystemPrompt === "function" ? ctx.getSystemPrompt() : "";
		} catch {
			return "";
		}
	};

	/**
	 * Resolve the policy for this session from its effective system prompt and
	 * apply retry ownership. A session selected by the subagent matchers may opt
	 * out with `subagents.enabled: false`, which leaves the built-in scheduler
	 * untouched.
	 */
	const resolveSession = (systemPrompt: string) => {
		const next = readRetrySettings(pi.getSettings());
		const matched = matchesSystemPrompt(systemPrompt, next.subagents.matchers);
		resolved = next;
		usesSubagentPolicy = matched;
		// Take over retry unless the matched subagent policy explicitly opts out.
		const takesOver = !(matched && !next.subagents.enabled);
		pi.setNativeRetryEnabled(!takesOver);
	};

	const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error") =>
		ctx.ui.notify(message, level);
	const setStatus = (ctx: ExtensionContext, text: string | undefined) => {
		try {
			ctx.ui.setStatus(RETRY_STATUS_KEY, text);
		} catch {
			// A closing or headless UI must not break the retry.
		}
	};
	const emitLifecycle = (event: string, id: number) => {
		try {
			pi.events.emit(event, { retryId: id });
		} catch {
			// A replaced session invalidates the bus while a retry unwinds.
		}
	};
	/** Close the current retry lifecycle exactly once, matching upstream's started/completed/cancelled contract. */
	const finishLifecycle = (event: "pie.retry-completed" | "pie.retry-cancelled") => {
		if (lifecycleId === 0) return;
		emitLifecycle(event, lifecycleId);
		lifecycleId = 0;
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

	pi.on("session_start", (_event, ctx) => {
		resolveSession(readSystemPrompt(ctx));
		generation++;
		resetCounters();
	});

	// The effective prompt is known per run, and settings may change between runs.
	pi.on("before_agent_start", (event) => {
		resolveSession(event.systemPrompt);
	});

	pi.on("session_shutdown", () => {
		pi.setNativeRetryEnabled(true);
		generation++;
		finishLifecycle("pie.retry-cancelled");
		resetCounters();
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		const assistant = lastProjectedAssistant(event.context.contextEntries);
		if (!assistant) return undefined;
		if (!isErrorStop(assistant) && !hasMaxTokensStop(assistant) && !hasEmptyStop(assistant)) return undefined;

		const own = generation;
		const settings = activePolicy();
		const drafts = [...(event.entries ?? [])];

		// A matched session may keep the built-in scheduler; it then owns retry.
		if (!ownsRetry()) return undefined;
		// Automatic retry is off: `retry.enabled` or the RPC set_auto_retry command.
		// This gates retries, continuations, and empty-response nudges alike.
		if (!autoRetryEnabled()) return undefined;

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
					? "Empty response — nudging once to produce output."
					: `Output limit reached — continuing the response (${continuations}/${settings.maxContinuations}).`,
				"info",
			);
			if (!(await backoff(ctx, calculateDelay(attempt + 1, settings), attempt + 1, own))) return undefined;
			if (generation !== own) return undefined;
			drafts.push({
				type: "custom_message",
				customType: CONTINUATION_CUSTOM_TYPE,
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

		if (maxDelayRetries >= settings.maxRetriesAtMaxDelay) {
			finishLifecycle("pie.retry-cancelled");
			notify(
				ctx,
				`Retry failed ${settings.maxRetriesAtMaxDelay} times at the maximum backoff (${formatDuration(settings.maxDelayMs)}) — giving up.`,
				"warning",
			);
			return undefined;
		}

		const category = getErrorCategory(assistant);
		const state = categories[category];
		state.attempts++;
		state.lastError = assistant.errorMessage ?? "";
		retryAttempts++;
		const delay = calculateDelay(retryAttempts, settings);
		if (delay >= settings.maxDelayMs) maxDelayRetries++;
		if (retryAttempts === 1) {
			const futile = isPermanentError(assistant)
				? " This looks permanent (invalid key or unknown model); fix it to make the retry succeed."
				: isQuotaExhaustedError(assistant)
					? " Quota or budget is exhausted; retrying cannot help until the plan or budget is fixed."
					: "";
			const id = ++lifecycleId;
			emitLifecycle("pie.retry-started", id);
			notify(ctx, `${CATEGORY_NOTICE[category]}${futile} ${state.lastError.slice(0, 120)}`, "info");
		}
		if (!(await backoff(ctx, delay, retryAttempts, own))) return undefined;
		if (generation !== own) return undefined;

		if (settings.messageFreeRetries) {
			// Omit the failed response from the model projection so the same request
			// is sent again. The raw history keeps it, exactly like native retry.
			const failed = event.context.contextEntries.findLast((entry) => entry.messages.includes(assistant))
				?.sourceEntry.id;
			if (!failed) return undefined;
			drafts.push({ type: "context_edit", targetId: failed, replacement: null });
		} else {
			// Upstream's default: one hidden retry message stays in the context and
			// the session file, and the failed response stays in the transcript.
			drafts.push({
				type: "custom_message",
				customType: RETRY_TRIGGER_CUSTOM_TYPE,
				content: RETRY_MESSAGE,
				display: false,
			});
		}
		return { entries: drafts, continue: true };
	});

	pi.on("turn_end", (event) => {
		const message = event.message;
		if (message.role !== "assistant") return;
		if (message.stopReason === "error" || message.stopReason === "length") return;
		if (hasEmptyStop(message)) return;
		finishLifecycle("pie.retry-completed");
		resetCounters();
	});

	pi.on("input", () => {
		generation++;
		finishLifecycle("pie.retry-cancelled");
		resetCounters();
	});

	pi.registerCommand("retry", {
		description: "Retry controls: /retry, /retry status, /retry reset",
		async handler(args, ctx) {
			const settings = activePolicy();
			const subcommand = args.trim().split(/\s+/)[0]?.toLowerCase();

			if (subcommand === "status") {
				const last = lastAssistantOf(ctx.sessionManager);
				const lines = [
					"=== Pie retry status ===",
					`Automatic retry: ${autoRetryEnabled() ? "on" : "off"} (retry.enabled; RPC set_auto_retry)`,
					`Policy: ${usesSubagentPolicy ? "subagent matcher" : "main"}${
						usesSubagentPolicy && !resolved.subagents.enabled ? " (takeover disabled)" : ""
					}`,
					`Owns agent-turn retry: ${ownsRetry() ? "yes" : "no"}`,
					`Retry mode: ${settings.messageFreeRetries ? "message-free (omit failed response)" : "hidden retry message"}`,
					`Retries: ${retryAttempts} total, ${maxDelayRetries}/${settings.maxRetriesAtMaxDelay} at max delay`,
					`Output continuations: ${continuations}/${settings.maxContinuations}`,
					`Empty-response nudges: ${emptyNudges}/${MAX_EMPTY_NUDGES}`,
					`Backoff: ${settings.baseDelayMs}ms x${settings.multiplier}, max ${settings.maxDelayMs}ms`,
					"By category:",
				];
				for (const [name, state] of Object.entries(categories)) {
					lines.push(`  ${name}: ${state.attempts}${state.lastError ? ` — ${state.lastError.slice(0, 80)}` : ""}`);
				}
				lines.push(`Last stop reason: ${last?.stopReason ?? "none"}`);
				lines.push(`Last error: ${(last?.errorMessage ?? "none").slice(0, 120)}`);
				notify(ctx, lines.join("\n"), "info");
				return;
			}

			if (subcommand === "reset") {
				generation++;
				finishLifecycle("pie.retry-cancelled");
				resetCounters();
				notify(ctx, "Retry counters reset.", "info");
				return;
			}

			if (!ownsRetry()) {
				notify(
					ctx,
					"This session keeps the built-in retry scheduler (pieRetry.subagents.enabled is false).",
					"info",
				);
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
			finishLifecycle("pie.retry-cancelled");
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
