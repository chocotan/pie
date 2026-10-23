import type { WatchdogForkInput, WatchdogRuntime } from "private-inquiry-subagents-runtime/watchdog-runtime";
/**
 * Host-side private inquiry operation — the proven private-decision core
 * (originally the design Decisions 4-7 adapter of
 * isolate-watchdog-decisions-in-private-fork), moved here verbatim and made
 * consumer-neutral.
 *
 * One logical inquiry = one private /var/tmp directory with a result file
 * initialized to `{}`, one child created through `WatchdogRuntime.fork`, and
 * up to two inquiry rounds in that same child (initial plus at most one
 * review-challenged reconsideration). Each round consumes at most
 * INVALID_ATTEMPT_LIMIT settled model responses; only normally settled
 * responses count as format attempts. Setup, file write/read, provider,
 * cancelled, and stale outcomes are typed failures, never format
 * corrections.
 *
 * The host owns policy and prompt wording via the `validate`, `prompt`,
 * `correction`, and `review` callbacks. This core appends the actual
 * JSON-encoded result path inside <private_inquiry_result_file>...</...> to
 * the callback text. No structured_output instructions are involved; the
 * file is the only result transport.
 */
/** Default marker element appended to every prompt carrying the actual result path. */
export declare const RESULT_FILE_TAG = "private_inquiry_result_file";
/** Default result filename inside the per-inquiry private directory. */
export declare const RESULT_FILE_NAME = "inquiry.json";
/**
 * Default mkdtemp prefix of the per-inquiry private directory: /var/tmp on
 * POSIX (disk-backed, unlike a RAM /tmp), the OS temp dir elsewhere.
 */
export declare const RESULT_DIR_PREFIX: string;
/**
 * Consumer-visible result-file naming. Consumers that already published a
 * marker/file contract (Continue: watchdog_result_file, decision.json,
 * /var/tmp/watchdog-decision-) pass it here so adoption changes no literal.
 */
export interface ResultFileNaming {
    readonly tag?: string;
    readonly fileName?: string;
    readonly dirPrefix?: string;
}
/**
 * The fixed re-ask budget: consumed invalid responses per inquiry round.
 * Consumers may override per operation via `invalidAttemptLimit`.
 */
export declare const INVALID_ATTEMPT_LIMIT = 3;
/** Consumer-supplied payload validation result (design D3). */
export type PayloadValidation<T> = {
    readonly valid: true;
    readonly value: T;
} | {
    readonly valid: false;
    readonly error: string;
};
/** Safe per-response observation handed to the optional audit callback. */
export interface PrivateDecisionObservation<T = unknown> {
    /** Which inquiry round produced this response. */
    readonly inquiry: "initial" | "reconsideration";
    /** 1-based consumed-response number inside this inquiry. */
    readonly attempt: number;
    readonly sessionId: string;
    readonly outcome: {
        readonly kind: "valid";
        readonly decision: T;
    } | {
        readonly kind: "invalid";
        readonly error: string;
    };
}
/** Terminal result of one logical private inquiry. */
export type PrivateDecisionResult<T = unknown> = {
    readonly kind: "decision";
    readonly decision: T;
    readonly sessionId: string;
    /** True when the decision came from the reconsideration inquiry. */
    readonly reconsidered: boolean;
} | {
    readonly kind: "decision-failed";
    readonly error: string;
    readonly sessionId: string;
    readonly reconsidered: boolean;
} | {
    readonly kind: "cancelled";
    readonly sessionId?: string;
} | {
    readonly kind: "execution-error";
    readonly error: string;
    readonly sessionId?: string;
};
export interface PrivateDecisionOptions<T = unknown> {
    readonly runtime: WatchdogRuntime;
    /** Fork input minus host-owned agentDir/resultFile, allocated here. */
    readonly fork: Omit<WatchdogForkInput, "agentDir" | "resultFile">;
    /** Consumed invalid responses allowed per inquiry round. Default 3. */
    readonly invalidAttemptLimit?: number;
    /** Result marker/file/directory naming; neutral defaults when omitted. */
    readonly naming?: ResultFileNaming;
    /** Cancellation signal for the whole logical inquiry. */
    readonly signal?: AbortSignal;
    /**
     * Freshness guard evaluated before/after every awaited boundary and before
     * the terminal result. False means stale: the child is cancelled and its
     * outcome can never commit.
     */
    readonly isCurrent: () => boolean;
    /**
     * Consumer payload validation for the parsed result-file JSON object.
     * A `{ valid: false }` with a safe diagnostic is one consumed invalid
     * response, correctable in the same child.
     */
    readonly validate: (payload: unknown) => PayloadValidation<T>;
    /**
     * Inquiry prompt text. `definiteChallengeFeedback` is present only for the
     * one reconsideration inquiry. The JSON-encoded result path in a
     * <private_inquiry_result_file> marker is appended to the returned text.
     */
    readonly prompt: (resultFile: string, definiteChallengeFeedback?: string) => string;
    /**
     * Correction text appended to the same child after a consumed invalid
     * response; receives the safe validator diagnostic and result path. The
     * result-file marker is appended to the returned text as for `prompt`.
     */
    readonly correction: (error: string, resultFile: string) => string;
    /**
     * Optional semantic review, invoked at most once and only for the valid
     * initial candidate — never a replacement. Receives a copy of the flat
     * candidate so observer mutation cannot alter the accepted result.
     * Returning a string is a definite challenge whose feedback opens the one
     * reconsideration inquiry; `undefined` releases the original candidate.
     * Whether a candidate kind is reviewable at all is consumer policy,
     * expressed by returning `undefined` from this callback.
     */
    readonly review?: (decision: T) => Promise<string | undefined>;
    /**
     * Optional safe per-response audit; receives a copy of the candidate.
     * A throwing callback is swallowed: it must never add model requests or
     * change decision accounting.
     */
    readonly onResponse?: (observation: PrivateDecisionObservation<T>) => void;
    /**
     * Optional lifecycle notification invoked once immediately before the
     * first authorized prompt of each inquiry, after the child exists. A
     * throwing callback is an execution error: no model request is launched
     * silently afterwards.
     */
    readonly onStarted?: (event: {
        readonly inquiry: "initial" | "reconsideration";
        readonly sessionId: string;
    }) => void;
}
/**
 * Run one bounded logical private inquiry. See the module header for the
 * full contract.
 */
export declare function runPrivateDecision<T>(options: PrivateDecisionOptions<T>): Promise<PrivateDecisionResult<T>>;
