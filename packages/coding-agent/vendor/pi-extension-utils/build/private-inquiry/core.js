import { constants } from "node:fs";
import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
export const RESULT_FILE_TAG = "private_inquiry_result_file";
/** Default result filename inside the per-inquiry private directory. */
export const RESULT_FILE_NAME = "inquiry.json";
/**
 * Default mkdtemp prefix of the per-inquiry private directory: /var/tmp on
 * POSIX (disk-backed, unlike a RAM /tmp), the OS temp dir elsewhere.
 */
export const RESULT_DIR_PREFIX = join(process.platform === "win32" ? tmpdir() : "/var/tmp", "private-inquiry-");
/**
 * The fixed re-ask budget: consumed invalid responses per inquiry round.
 * Consumers may override per operation via `invalidAttemptLimit`.
 */
export const INVALID_ATTEMPT_LIMIT = 3;
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
/** Prompt rejections caused by cancellation surface as AbortError. */
function isAbortError(error) {
    return (typeof error === "object" &&
        error !== null &&
        error.name === "AbortError");
}
/**
 * Inspect the final assistant outcome this prompt appended to the child.
 * Only messages at or after `startIndex` — captured immediately before the
 * prompt — belong to this response; an inherited reply is never borrowed.
 * `none` means the settled prompt produced no own assistant message, so the
 * file (which may hold stale JSON) must not be evaluated as its result.
 * `failed` (`error`/`aborted`) is a typed provider outcome, never a format
 * correction.
 */
function assistantTerminalOutcome(child, startIndex) {
    for (let index = child.messages.length - 1; index >= startIndex; index--) {
        const message = child.messages[index];
        if (message?.role !== "assistant")
            continue;
        const stopReason = message.stopReason;
        const detail = message.errorMessage;
        const errorText = typeof detail === "string" ? detail : undefined;
        if (stopReason === "aborted") {
            return {
                kind: "failed",
                aborted: true,
                error: errorText ?? "aborted",
            };
        }
        if (stopReason === "error") {
            return {
                kind: "failed",
                aborted: false,
                error: errorText ?? "provider error",
            };
        }
        return { kind: "ok" };
    }
    return { kind: "none" };
}
/**
 * Evaluate the designated result file after a normally settled response.
 * Malformed JSON, non-object JSON, and validator-rejected payloads are
 * model-format errors. Symlink/non-regular targets and filesystem read
 * failures are host execution errors, never repaired here. One complete
 * JSON object is required; payload field semantics stay inside the
 * consumer-supplied `validate`.
 */
async function readResultFile(resultFile, validate) {
    // Open without following links and fstat the descriptor: a replaced
    // directory, symlink, or other non-regular path is a host execution
    // failure, not a model-format retry.
    let raw;
    try {
        const handle = await open(resultFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
            if (!(await handle.stat()).isFile()) {
                return {
                    kind: "execution-error",
                    error: "decision result path is not the designated regular file.",
                };
            }
            raw = await handle.readFile("utf8");
        }
        finally {
            await handle.close().catch(() => { });
        }
    }
    catch (error) {
        return {
            kind: "execution-error",
            error: `result file unreadable: ${errorMessage(error)}`,
        };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return {
            kind: "invalid",
            error: "decision result file does not contain one complete JSON object.",
        };
    }
    const validation = validate(parsed);
    return validation.valid
        ? { kind: "valid", decision: validation.value }
        : { kind: "invalid", error: validation.error };
}
/** Append the actual result-file marker to host callback text. */
/**
 * Non-undefined on platforms where the private-inquiry guard does not hold
 * (POSIX O_NOFOLLOW and exact path identity); every operation fails closed.
 * Tests may override the detected platform via PIU_PRIVATE_INQUIRY_PLATFORM.
 */
const UNSUPPORTED_PLATFORM_ERROR = (process.env.PIU_PRIVATE_INQUIRY_PLATFORM ?? process.platform) === "win32"
    ? "pi-extension-utils/private-inquiry is supported on Linux and macOS only."
    : undefined;
/** Observer copy of a flat candidate; primitives are already immutable. */
function shallowCopy(value) {
    if (typeof value !== "object" || value === null)
        return value;
    return (Array.isArray(value) ? [...value] : { ...value });
}
function withResultMarker(text, resultFile, tag) {
    return `${text}\n\n<${tag}>${JSON.stringify(resultFile)}</${tag}>`;
}
/**
 * Run one bounded logical private inquiry. See the module header for the
 * full contract.
 */
export async function runPrivateDecision(options) {
    // Fail closed where the no-follow result-file guard and exact path
    // identity do not hold: never fork or accept a result there.
    if (UNSUPPORTED_PLATFORM_ERROR !== undefined) {
        return { kind: "execution-error", error: UNSUPPORTED_PLATFORM_ERROR };
    }
    const { signal } = options;
    const cancelled = () => signal?.aborted === true || !options.isCurrent();
    const attemptLimit = options.invalidAttemptLimit ?? INVALID_ATTEMPT_LIMIT;
    const resultTag = options.naming?.tag ?? RESULT_FILE_TAG;
    // Owned private resources: exactly one temp dir, created and removed here.
    let dir;
    try {
        dir = await mkdtemp(options.naming?.dirPrefix ?? RESULT_DIR_PREFIX);
    }
    catch (error) {
        return {
            kind: "execution-error",
            error: `private decision directory: ${errorMessage(error)}`,
        };
    }
    const agentDir = join(dir, "agent");
    const resultFile = join(dir, options.naming?.fileName ?? RESULT_FILE_NAME);
    let child;
    let abortRequested = false;
    const abortChild = async () => {
        if (child === undefined || abortRequested)
            return;
        abortRequested = true;
        try {
            await child.abort();
        }
        catch {
            // Abort is best-effort; result authority is already revoked.
        }
    };
    const onSignalAbort = () => {
        void abortChild();
    };
    signal?.addEventListener("abort", onSignalAbort, { once: true });
    const cleanup = async () => {
        // Drain/cancel the exact child, then remove only the owned temp dir.
        await abortChild();
        if (child !== undefined) {
            try {
                await child.dispose();
            }
            catch {
                // Disposal failure must not mask the terminal result.
            }
        }
        await rm(dir, { recursive: true, force: true }).catch(() => { });
    };
    const resetResultFile = async () => {
        // Initialize {} through a no-follow descriptor pinned by fstat. An
        // unexpected replacement (directory, link, non-regular node) is a
        // filesystem failure, not a format retry: it is reported, never
        // repaired or deleted here.
        try {
            const handle = await open(resultFile, constants.O_WRONLY |
                constants.O_CREAT |
                constants.O_NOFOLLOW |
                constants.O_NONBLOCK, 0o600);
            try {
                if (!(await handle.stat()).isFile()) {
                    return "result file initialization: not a regular file";
                }
                await handle.truncate(0);
                await handle.writeFile("{}", "utf8");
            }
            finally {
                await handle.close().catch(() => { });
            }
            return undefined;
        }
        catch (error) {
            return `result file initialization: ${errorMessage(error)}`;
        }
    };
    const runDecision = async () => {
        // Initialize the result file to {} before the first attempt.
        const initError = await resetResultFile();
        if (initError !== undefined) {
            return { kind: "execution-error", error: initError };
        }
        try {
            await mkdir(agentDir, { recursive: true, mode: 0o700 });
        }
        catch (error) {
            return {
                kind: "execution-error",
                error: `private agent directory: ${errorMessage(error)}`,
            };
        }
        try {
            child = await options.runtime.fork({
                ...options.fork,
                agentDir,
                resultFile,
            });
        }
        catch (error) {
            return {
                kind: "execution-error",
                error: `private fork: ${errorMessage(error)}`,
            };
        }
        const sessionId = child.sessionId;
        const ownedChild = child;
        /**
         * One attempt = prompt the child once, then evaluate its own final
         * assistant outcome before trusting the file. Aborted/errored provider
         * outcomes and cancelled/stale attempts are typed failures, never
         * format corrections.
         */
        const attempt = async (text) => {
            if (cancelled())
                return { kind: "cancelled" };
            const startIndex = ownedChild.messages.length;
            let promptError;
            try {
                await ownedChild.prompt(withResultMarker(text, resultFile, resultTag));
            }
            catch (error) {
                promptError = error;
            }
            const outcome = assistantTerminalOutcome(ownedChild, startIndex);
            if (cancelled() ||
                abortRequested ||
                (outcome.kind === "failed" && outcome.aborted) ||
                isAbortError(promptError)) {
                return { kind: "cancelled" };
            }
            if (promptError !== undefined) {
                return {
                    kind: "execution-error",
                    error: errorMessage(promptError),
                };
            }
            if (outcome.kind === "failed") {
                return { kind: "execution-error", error: outcome.error };
            }
            if (outcome.kind === "none") {
                // No own completed assistant message: the file (possibly stale
                // JSON or an inherited reply) must not supply a result.
                return {
                    kind: "execution-error",
                    error: "the prompt settled without an own completed response.",
                };
            }
            // Normally settled own response; admitted writes already completed.
            // The runner's concrete format diagnostic beats generic {}
            // field validation; provider/host throws stay execution errors.
            if (typeof ownedChild.attemptError === "string") {
                return { kind: "invalid", error: ownedChild.attemptError };
            }
            return readResultFile(resultFile, options.validate);
        };
        /**
         * One inquiry = at most `attemptLimit` consumed responses in the same
         * child. Corrections append host text to that child; the file is reset
         * to `{}` before the next authorized attempt.
         */
        const runInquiry = async (inquiry, challengeFeedback) => {
            let text = options.prompt(resultFile, challengeFeedback);
            // Notify once before the first authorized prompt of this inquiry,
            // after the child exists; a throwing callback is an execution
            // error, not a silently launched model request.
            try {
                options.onStarted?.({ inquiry, sessionId });
            }
            catch (error) {
                return { kind: "execution-error", error: errorMessage(error) };
            }
            if (cancelled())
                return { kind: "cancelled" };
            for (let response = 0; response < attemptLimit; response++) {
                // The file is reset to {} before EVERY response attempt: the prior
                // attempt's admitted writes already settled inside `attempt`, so an
                // unchanged old object can never decide a later attempt.
                const attemptInitError = await resetResultFile();
                if (attemptInitError !== undefined) {
                    return { kind: "execution-error", error: attemptInitError };
                }
                const outcome = await attempt(text);
                if (outcome.kind === "cancelled")
                    return { kind: "cancelled" };
                if (outcome.kind === "execution-error")
                    return outcome;
                const observation = outcome;
                try {
                    options.onResponse?.({
                        inquiry,
                        attempt: response + 1,
                        sessionId,
                        outcome: observation.kind === "valid"
                            ? {
                                kind: "valid",
                                decision: shallowCopy(observation.decision),
                            }
                            : { kind: "invalid", error: observation.error },
                    });
                }
                catch {
                    // Audit failure never changes accounting or adds requests.
                }
                if (observation.kind === "valid") {
                    return {
                        kind: "decision",
                        decision: shallowCopy(observation.decision),
                    };
                }
                if (response + 1 >= attemptLimit) {
                    return { kind: "decision-failed", error: observation.error };
                }
                if (cancelled())
                    return { kind: "cancelled" };
                text = options.correction(observation.error, resultFile);
            }
            // Unreachable: the loop bound is `attemptLimit`.
            return { kind: "decision-failed", error: "invalid decision" };
        };
        const initial = await runInquiry("initial");
        if (initial.kind === "cancelled") {
            return { kind: "cancelled", sessionId };
        }
        if (initial.kind === "execution-error") {
            return {
                kind: "execution-error",
                error: initial.error,
                sessionId,
            };
        }
        if (initial.kind === "decision-failed") {
            return {
                kind: "decision-failed",
                error: initial.error,
                sessionId,
                reconsidered: false,
            };
        }
        let candidate = initial.decision;
        let reconsidered = false;
        // One optional semantic review of the valid initial candidate.
        if (options.review !== undefined) {
            if (cancelled())
                return { kind: "cancelled", sessionId };
            let feedback;
            try {
                // Observer copy: a mutating review cannot alter the candidate.
                feedback = await options.review(shallowCopy(candidate));
            }
            catch {
                // A review-service failure is incomplete review: release original.
                feedback = undefined;
            }
            if (cancelled())
                return { kind: "cancelled", sessionId };
            if (feedback !== undefined) {
                // The second inquiry has its own response allowance in the
                // same child; the superseded candidate never commits.
                const second = await runInquiry("reconsideration", feedback);
                if (second.kind === "cancelled") {
                    return { kind: "cancelled", sessionId };
                }
                if (second.kind === "execution-error") {
                    return {
                        kind: "execution-error",
                        error: second.error,
                        sessionId,
                    };
                }
                if (second.kind === "decision-failed") {
                    return {
                        kind: "decision-failed",
                        error: second.error,
                        sessionId,
                        reconsidered: true,
                    };
                }
                candidate = second.decision;
                reconsidered = true;
            }
        }
        if (cancelled())
            return { kind: "cancelled", sessionId };
        return {
            kind: "decision",
            decision: candidate,
            sessionId,
            reconsidered,
        };
    };
    let result;
    try {
        if (cancelled()) {
            result = { kind: "cancelled" };
        }
        else {
            result = await runDecision();
        }
    }
    finally {
        signal?.removeEventListener("abort", onSignalAbort);
        // Cancellation stays live through cleanup; currentness is rechecked
        // after this awaited boundary before any decision/failure can commit.
        await cleanup();
    }
    if ((result.kind === "decision" || result.kind === "decision-failed") &&
        cancelled()) {
        return { kind: "cancelled", sessionId: result.sessionId };
    }
    return result;
}
