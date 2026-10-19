// Adapted from @monotykamary/pi-retry 0.11.2 (MIT, Tom X Nguyen).
// Source: https://github.com/monotykamary/pi-retry at 6483ab0f204076aa3ec385746ec1d58f0625cc76.
// See packages/coding-agent/docs/third-party/pi-retry/NOTICE.md.
import type { Settings } from "../../core/settings-manager.ts";

/** Settings namespace owned by this plugin, separate from Pie's built-in `retry` object. */
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
	/**
	 * Retry an error by omitting the failed response and continuing the same
	 * request, instead of queueing a hidden `Retry the previous request.`
	 * message. Off by default, matching upstream.
	 */
	messageFreeRetries: boolean;
}

export interface RetrySubagentPolicy extends RetryPolicy {
	/** Whether the plugin takes over retry for sessions selected by the matchers. */
	enabled: boolean;
	/** Compiled rules; a session whose system prompt matches any rule uses this policy. */
	matchers: readonly RegExp[];
}

export interface RetrySettings {
	/** Policy for an ordinary session. */
	main: RetryPolicy;
	/** Policy for a session selected by `pieRetry.subagents.match.systemPromptRegex`. */
	subagents: RetrySubagentPolicy;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
	baseDelayMs: 2000,
	maxDelayMs: 60000,
	multiplier: 2,
	maxRetriesAtMaxDelay: 3,
	maxContinuations: 10,
	retryContinuations: true,
	retryEmptyStop: true,
	messageFreeRetries: false,
};

/** Regex flags accepted in settings; `g` and `y` would make `test()` stateful. */
const SUPPORTED_REGEX_FLAGS = new Set(["i", "m", "s", "u"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function warn(message: string): void {
	console.warn(`[pie-retry] ${message}`);
}

function readNumber(
	values: Record<string, unknown>,
	key: string,
	fallback: number,
	valid: (value: number) => boolean,
	path = `${RETRY_SETTINGS_KEY}.${key}`,
): number {
	const value = values[key];
	if (value === undefined) return fallback;
	if (typeof value === "number" && Number.isFinite(value) && valid(value)) return value;
	warn(`Ignoring invalid ${path} value: ${String(value)}`);
	return fallback;
}

function readBoolean(
	values: Record<string, unknown>,
	key: string,
	fallback: boolean,
	path = `${RETRY_SETTINGS_KEY}.${key}`,
): boolean {
	const value = values[key];
	if (value === undefined) return fallback;
	if (typeof value === "boolean") return value;
	warn(`Ignoring invalid ${path} value: ${String(value)}`);
	return fallback;
}

function isSupportedFlags(flags: string): boolean {
	const seen = new Set<string>();
	for (const flag of flags) {
		if (!SUPPORTED_REGEX_FLAGS.has(flag) || seen.has(flag)) return false;
		seen.add(flag);
	}
	return true;
}

/**
 * Compile `pieRetry.subagents.match.systemPromptRegex`. An absent group yields
 * no rules; any malformed entry yields no rules as well, so a broken rule can
 * never select every session.
 */
function compileMatchers(subagents: Record<string, unknown>): RegExp[] {
	const matchPath = `${RETRY_SETTINGS_KEY}.subagents.match`;
	if (!Object.hasOwn(subagents, "match")) return [];
	const match = subagents.match;
	if (!isRecord(match)) {
		warn(`Ignoring invalid ${matchPath} value: ${String(match)} (expected an object)`);
		return [];
	}
	const rulesPath = `${matchPath}.systemPromptRegex`;
	const rules = match.systemPromptRegex;
	if (rules === undefined) return [];
	if (!Array.isArray(rules)) {
		warn(`Ignoring invalid ${rulesPath} value: ${String(rules)} (expected an array)`);
		return [];
	}
	const compiled: RegExp[] = [];
	for (const [index, rule] of rules.entries()) {
		const rulePath = `${rulesPath}[${index}]`;
		if (!isRecord(rule)) {
			warn(`Ignoring invalid ${rulePath} value: ${String(rule)} (expected an object)`);
			return [];
		}
		const pattern = rule.pattern;
		if (typeof pattern !== "string" || pattern.trim().length === 0) {
			warn(`Ignoring invalid ${rulePath}.pattern value: ${String(pattern)} (expected a non-empty regex source)`);
			return [];
		}
		const rawFlags = rule.flags;
		if (rawFlags !== undefined && typeof rawFlags !== "string") {
			warn(`Ignoring invalid ${rulePath}.flags value: ${String(rawFlags)} (expected a string)`);
			return [];
		}
		const flags = rawFlags ?? "";
		if (!isSupportedFlags(flags)) {
			warn(`Ignoring invalid ${rulePath}.flags value: ${flags} (allowed flags are unique i, m, s, and u)`);
			return [];
		}
		try {
			compiled.push(new RegExp(pattern, flags));
		} catch (error) {
			warn(`Ignoring invalid ${rulePath}.pattern value: ${pattern} (${String(error)})`);
			return [];
		}
	}
	return compiled;
}

function readPolicy(values: Record<string, unknown>, fallback: RetryPolicy, prefix?: string): RetryPolicy {
	const path = (key: string) => (prefix ? `${prefix}.${key}` : `${RETRY_SETTINGS_KEY}.${key}`);
	return {
		baseDelayMs: readNumber(values, "baseDelayMs", fallback.baseDelayMs, (value) => value >= 0, path("baseDelayMs")),
		maxDelayMs: readNumber(values, "maxDelayMs", fallback.maxDelayMs, (value) => value >= 0, path("maxDelayMs")),
		multiplier: readNumber(values, "multiplier", fallback.multiplier, (value) => value >= 1, path("multiplier")),
		maxRetriesAtMaxDelay: readNumber(
			values,
			"maxRetriesAtMaxDelay",
			fallback.maxRetriesAtMaxDelay,
			(value) => Number.isInteger(value) && value >= 1,
			path("maxRetriesAtMaxDelay"),
		),
		maxContinuations: readNumber(
			values,
			"maxContinuations",
			fallback.maxContinuations,
			(value) => Number.isInteger(value) && value >= 1,
			path("maxContinuations"),
		),
		retryContinuations: readBoolean(
			values,
			"retryContinuations",
			fallback.retryContinuations,
			path("retryContinuations"),
		),
		retryEmptyStop: readBoolean(values, "retryEmptyStop", fallback.retryEmptyStop, path("retryEmptyStop")),
		messageFreeRetries: readBoolean(
			values,
			"messageFreeRetries",
			fallback.messageFreeRetries,
			path("messageFreeRetries"),
		),
	};
}

/**
 * Resolve the main policy and the subagent policy from the session's merged
 * global and project settings. Pie merges project arrays over global ones, so a
 * project matcher list replaces the global list, as upstream specifies. Omitted
 * subagent fields inherit the main policy field by field.
 */
export function readRetrySettings(settings: Settings): RetrySettings {
	const namespace = (settings as Record<string, unknown>)[RETRY_SETTINGS_KEY];
	if (namespace !== undefined && !isRecord(namespace)) {
		warn(`Ignoring invalid ${RETRY_SETTINGS_KEY} settings; expected an object.`);
	}
	const values = isRecord(namespace) ? namespace : {};
	const main = readPolicy(values, DEFAULT_RETRY_POLICY);

	const rawSubagents = values.subagents;
	if (rawSubagents !== undefined && !isRecord(rawSubagents)) {
		warn(`Ignoring invalid ${RETRY_SETTINGS_KEY}.subagents value: ${String(rawSubagents)} (expected an object)`);
	}
	const subagents = isRecord(rawSubagents) ? rawSubagents : {};
	return {
		main,
		subagents: {
			...readPolicy(subagents, main, `${RETRY_SETTINGS_KEY}.subagents`),
			enabled: readBoolean(subagents, "enabled", true, `${RETRY_SETTINGS_KEY}.subagents.enabled`),
			matchers: compileMatchers(subagents),
		},
	};
}

/** Whether the effective system prompt matches any configured subagent rule. */
export function matchesSystemPrompt(systemPrompt: string, matchers: readonly RegExp[]): boolean {
	for (const matcher of matchers) {
		matcher.lastIndex = 0;
		const matched = matcher.test(systemPrompt);
		matcher.lastIndex = 0;
		if (matched) return true;
	}
	return false;
}

export function calculateDelay(attempt: number, policy: RetryPolicy): number {
	return Math.min(policy.baseDelayMs * policy.multiplier ** Math.max(0, attempt - 1), policy.maxDelayMs);
}

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}
