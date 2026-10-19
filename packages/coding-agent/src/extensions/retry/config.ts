// Adapted from @monotykamary/pi-retry 0.11.2 (MIT, Tom X Nguyen).
// Source: https://github.com/monotykamary/pi-retry at 6483ab0f204076aa3ec385746ec1d58f0625cc76.
// See packages/coding-agent/docs/third-party/pi-retry/NOTICE.md.
import type { Settings } from "../../core/settings-manager.ts";

/** Settings namespace owned by this plugin, separate from Pie's native `retry` object. */
export const RETRY_SETTINGS_KEY = "pieRetry";

export interface RetryPolicy {
	/** Delay before the first retry, in milliseconds. */
	baseDelayMs: number;
	/** Maximum delay between retries, in milliseconds. */
	maxDelayMs: number;
	/** Exponential backoff multiplier; at least 1. */
	multiplier: number;
	/** Failed retries allowed once the delay has reached maxDelayMs. */
	maxRetriesAtMaxDelay: number;
	/**
	 * Continuations allowed for responses cut off at the output token limit.
	 * Upstream continues without a limit; a cap prevents an endless paid loop.
	 */
	maxContinuations: number;
	/** Continue responses that ended at the output token limit. */
	retryContinuations: boolean;
	/** Nudge a turn that ended with no usable output. Bounded to one nudge. */
	retryEmptyStop: boolean;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
	baseDelayMs: 2000,
	maxDelayMs: 60000,
	multiplier: 2,
	maxRetriesAtMaxDelay: 3,
	maxContinuations: 10,
	retryContinuations: true,
	retryEmptyStop: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNumber(
	settings: Record<string, unknown>,
	key: keyof RetryPolicy,
	fallback: number,
	valid: (value: number) => boolean,
): number {
	const value = settings[key];
	if (value === undefined) return fallback;
	if (typeof value === "number" && Number.isFinite(value) && valid(value)) return value;
	console.warn(`[pie-retry] Ignoring invalid ${RETRY_SETTINGS_KEY}.${String(key)} value: ${String(value)}`);
	return fallback;
}

function readBoolean(settings: Record<string, unknown>, key: keyof RetryPolicy, fallback: boolean): boolean {
	const value = settings[key];
	if (value === undefined) return fallback;
	if (typeof value === "boolean") return value;
	console.warn(`[pie-retry] Ignoring invalid ${RETRY_SETTINGS_KEY}.${String(key)} value: ${String(value)}`);
	return fallback;
}

/** Read the `pieRetry` policy from the session's merged global and project settings. */
export function readRetryPolicy(settings: Settings): RetryPolicy {
	const namespace = (settings as Record<string, unknown>)[RETRY_SETTINGS_KEY];
	if (namespace !== undefined && !isRecord(namespace)) {
		console.warn(`[pie-retry] Ignoring invalid ${RETRY_SETTINGS_KEY} settings; expected an object.`);
		return { ...DEFAULT_RETRY_POLICY };
	}
	const values = isRecord(namespace) ? namespace : {};
	return {
		baseDelayMs: readNumber(values, "baseDelayMs", DEFAULT_RETRY_POLICY.baseDelayMs, (value) => value >= 0),
		maxDelayMs: readNumber(values, "maxDelayMs", DEFAULT_RETRY_POLICY.maxDelayMs, (value) => value >= 0),
		multiplier: readNumber(values, "multiplier", DEFAULT_RETRY_POLICY.multiplier, (value) => value >= 1),
		maxRetriesAtMaxDelay: readNumber(
			values,
			"maxRetriesAtMaxDelay",
			DEFAULT_RETRY_POLICY.maxRetriesAtMaxDelay,
			(value) => Number.isInteger(value) && value >= 1,
		),
		maxContinuations: readNumber(
			values,
			"maxContinuations",
			DEFAULT_RETRY_POLICY.maxContinuations,
			(value) => Number.isInteger(value) && value >= 1,
		),
		retryContinuations: readBoolean(values, "retryContinuations", DEFAULT_RETRY_POLICY.retryContinuations),
		retryEmptyStop: readBoolean(values, "retryEmptyStop", DEFAULT_RETRY_POLICY.retryEmptyStop),
	};
}

export function calculateDelay(attempt: number, policy: RetryPolicy): number {
	return Math.min(policy.baseDelayMs * policy.multiplier ** Math.max(0, attempt - 1), policy.maxDelayMs);
}

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}
