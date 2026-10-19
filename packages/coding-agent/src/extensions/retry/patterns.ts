// Adapted from @monotykamary/pi-retry 0.11.2 (MIT, Tom X Nguyen).
// Source: https://github.com/monotykamary/pi-retry at 6483ab0f204076aa3ec385746ec1d58f0625cc76.
// See packages/coding-agent/docs/third-party/pi-retry/NOTICE.md.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";

export type RetryCategory = "400-413" | "credit" | "connection" | "server" | "other";

/** Permanent failures: retrying cannot succeed without user action. */
const NON_RETRYABLE_PATTERNS = [
	/invalid\s*api\s*key/i,
	/invalid\s*authentication/i,
	/api\s*key\s*(not\s*found|missing|revoked)/i,
	/model\s*not\s*found/i,
	/unknown\s*model/i,
	/no\s*such\s*model/i,
	/model\s*does\s*not\s*exist/i,
	/unsupported\s*model/i,
	/cannot continue from message role/i,
];

/**
 * Quota, session-limit, and budget exhaustion. Distinct from per-minute rate
 * limits and pay-as-you-go balance errors, which stay retryable because a
 * mid-session top-up lets the retry resume.
 */
const QUOTA_EXHAUSTED_PATTERNS = [
	/hit your (?:[a-z]+ )?usage limit/i,
	/hit your limit/i,
	/usage_limit_reached/i,
	/usage\s*limit\s*(has\s*been\s*)?reached/i,
	/hour\s*limit\s*reached/i,
	/limit\s*will\s*reset\s*at/i,
	/session\s*(limit|quota)/i,
	/exceeded your usage limit/i,
	/insufficient[_\s]quota/i,
	/exceeded your current quota/i,
	/free.models.per.day/i,
	/hour\s*allocated\s*quota/i,
	/week\s*allocated\s*quota/i,
	/month\s*allocated\s*quota/i,
	/free\s*allocated\s*quota/i,
	/premium\s*request\s*allowance/i,
	/monthly\s*(limit|quota|budget|allowance)/i,
	/out of budget/i,
	/budget\s*(has\s*been\s*)?(exceeded|exhausted|limit)/i,
	/max(imum)?\s*budget\s*(exceeded|reached|limit)/i,
	/spending\s*limit/i,
	/exhausted your capacity/i,
	/quota will reset after/i,
	/reached the quota limit/i,
	/you can resume using this model/i,
	/no resource package/i,
	/account\b[^.]*\bis\s*suspended/i,
	/quota\s*(exhausted|depleted)/i,
];

const ERROR_400_413_PATTERNS = [/\b4(00|13)\b.*status code/i, /bad request/i, /payload too large/i];

const CREDIT_ERROR_PATTERNS = [
	/not enough credits/i,
	/insufficient credits/i,
	/insufficient balance/i,
	/out of credits/i,
	/payment required/i,
	/\b402\b.*status code/i,
];

const CONNECTION_ERROR_PATTERNS = [
	/connection\s*error/i,
	/network\s*error/i,
	/fetch\s*failed/i,
	/socket\s*(hang\s*up|error|timeout)/i,
	/econnreset/i,
	/econnrefused/i,
	/etimedout/i,
	/enotfound/i,
	/dns\s*lookup\s*failed/i,
	/request\s*ended\s*without\s*sending\s*any\s*chunks/i,
	/upstream\s*connect/i,
	/other\s*side\s*closed/i,
	/reset\s*before\s*headers/i,
	/broken\s*pipe/i,
	/unexpected\s*end\s*of\s*file/i,
	/tls\s*handshake\s*(error|timeout)/i,
	/ssl\s*connection\s*error/i,
	/timeout\s*(awaiting|waiting\s*for)\s*response/i,
	/request\s*timeout/i,
	/max outbound streams/i,
	/streams?\s*(exhausted|limit)/i,
];

const SERVER_ERROR_PATTERNS = [
	/overloaded/i,
	/rate\s*limit/i,
	/too\s*many\s*requests/i,
	/\b429\b/,
	/\b5\d{2}\b/,
	/service\s*unavailable/i,
	/server\s*error/i,
	/internal\s*error/i,
];

function isAssistantMessage(message: AgentMessage | undefined): message is AssistantMessage {
	return message?.role === "assistant";
}

function errorText(message: AssistantMessage): string {
	return message.errorMessage ?? "";
}

export function isPermanentError(message: AssistantMessage): boolean {
	return NON_RETRYABLE_PATTERNS.some((pattern) => pattern.test(errorText(message)));
}

export function isQuotaExhaustedError(message: AssistantMessage): boolean {
	return QUOTA_EXHAUSTED_PATTERNS.some((pattern) => pattern.test(errorText(message)));
}

/**
 * Any assistant message that ended as an error is retried. Pie's bundled plugin
 * retries every error except context overflow, which compaction owns.
 */
export function isErrorStop(message: AssistantMessage): boolean {
	return message.stopReason === "error" && Boolean(message.errorMessage);
}

export function getErrorCategory(message: AssistantMessage): RetryCategory {
	const text = errorText(message);
	if (ERROR_400_413_PATTERNS.some((pattern) => pattern.test(text))) return "400-413";
	if (CREDIT_ERROR_PATTERNS.some((pattern) => pattern.test(text))) return "credit";
	if (CONNECTION_ERROR_PATTERNS.some((pattern) => pattern.test(text))) return "connection";
	if (SERVER_ERROR_PATTERNS.some((pattern) => pattern.test(text))) return "server";
	return "other";
}

/** The model hit its output token limit mid-response. */
export function hasMaxTokensStop(message: AssistantMessage): boolean {
	return message.stopReason === "length";
}

/**
 * The turn ended with no usable output: no non-blank text and no tool call.
 * Anthropic documents these empty `stop` responses as complete, so the remedy
 * is one continuation prompt rather than an in-place retry.
 */
export function hasEmptyStop(message: AssistantMessage): boolean {
	if (message.stopReason !== "stop") return false;
	return !message.content.some((block) =>
		block.type === "toolCall"
			? true
			: block.type === "text"
				? typeof block.text === "string" && block.text.trim().length > 0
				: false,
	);
}

/** The last assistant message of a projected boundary context, if any. */
export function lastProjectedAssistant(
	entries: readonly { messages: readonly AgentMessage[] }[],
): AssistantMessage | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const messages = entries[index]?.messages ?? [];
		const last = messages[messages.length - 1];
		if (last) return isAssistantMessage(last) ? last : undefined;
	}
	return undefined;
}
