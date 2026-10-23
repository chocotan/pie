import { randomBytes } from "node:crypto";
import { neutralizeAssistantMessage, nonThinkingText } from "./xml.js";
export const INQUIRY_PROTOCOL_VERSION = 1;
export const MAX_INQUIRY_CONTENT_CODE_POINTS = 65_536;
function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validNamespace(value) {
    return /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
}
function validInquiryId(value) {
    return (typeof value === "string" &&
        value.length > 0 &&
        value.length <= 128 &&
        /^[A-Za-z0-9_-]+$/.test(value));
}
function validAttempt(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function validContent(value, allowEmpty = false) {
    return (typeof value === "string" &&
        (allowEmpty || value.trim().length > 0) &&
        Array.from(value).length <= MAX_INQUIRY_CONTENT_CODE_POINTS);
}
function correlationOf(value) {
    if (!isObject(value))
        return null;
    return value.version === INQUIRY_PROTOCOL_VERSION &&
        typeof value.namespace === "string" &&
        validNamespace(value.namespace) &&
        validInquiryId(value.inquiryId) &&
        validAttempt(value.attempt)
        ? {
            version: INQUIRY_PROTOCOL_VERSION,
            namespace: value.namespace,
            inquiryId: value.inquiryId,
            attempt: value.attempt,
        }
        : null;
}
function customTypeOf(value) {
    return isObject(value) && typeof value.customType === "string"
        ? value.customType
        : null;
}
function sameCorrelation(left, right) {
    return left !== null &&
        left.version === right.version &&
        left.namespace === right.namespace &&
        left.inquiryId === right.inquiryId &&
        left.attempt === right.attempt;
}
function roleOf(value) {
    return isObject(value) && typeof value.role === "string" ? value.role : null;
}
function contentText(value) {
    if (!isObject(value))
        return null;
    if (typeof value.content === "string")
        return value.content;
    if (!Array.isArray(value.content) || value.content.length !== 1)
        return null;
    const block = value.content[0];
    return isObject(block) && block.type === "text" && typeof block.text === "string"
        ? block.text
        : null;
}
function replacementOf(value) {
    if (!isObject(value))
        return null;
    if (typeof value.customType !== "string" ||
        !validNamespace(value.customType) ||
        !validContent(value.content)) {
        return null;
    }
    return {
        customType: value.customType,
        content: value.content,
        ...(Object.hasOwn(value, "details") ? { details: value.details } : {}),
    };
}
function serializable(value) {
    try {
        return JSON.stringify(value) !== undefined;
    }
    catch {
        return false;
    }
}
function parsePluginMessage(value, namespace) {
    if (!isObject(value) || value.role !== "custom")
        return { type: "unrelated" };
    const customType = customTypeOf(value);
    const promptType = `${namespace}:inquiry`;
    const foldType = `${namespace}:inquiry-fold`;
    if (customType !== promptType && customType !== foldType)
        return { type: "unrelated" };
    const rawDetails = isObject(value.details) ? value.details : undefined;
    const inquiryId = validInquiryId(rawDetails?.inquiryId)
        ? rawDetails.inquiryId
        : undefined;
    const correlation = correlationOf(value.details);
    const content = contentText(value);
    if (correlation === null ||
        correlation.namespace !== namespace ||
        typeof value.timestamp !== "number" ||
        !Number.isFinite(value.timestamp) ||
        content === null) {
        return { type: "invalid", inquiryId };
    }
    if (customType === promptType) {
        return validContent(content)
            ? { type: "prompt", correlation }
            : { type: "invalid", inquiryId: correlation.inquiryId };
    }
    const outcome = rawDetails?.outcome;
    if (outcome === "remove") {
        return content.length === 0
            ? { type: "fold", correlation, timestamp: value.timestamp }
            : { type: "invalid", inquiryId: correlation.inquiryId };
    }
    const replacement = replacementOf(rawDetails?.replacement);
    if (outcome !== "replace" ||
        replacement === null ||
        content !== replacement.content ||
        (Object.hasOwn(replacement, "details") && !serializable(replacement.details))) {
        return { type: "invalid", inquiryId: correlation.inquiryId };
    }
    return {
        type: "fold",
        correlation,
        replacement,
        timestamp: value.timestamp,
    };
}
function isAbortedAssistant(value) {
    return isObject(value) && value.role === "assistant" && value.stopReason === "aborted";
}
function isNeutralizedAssistant(value, namespace, inquiryId, attempt) {
    if (!isObject(value) ||
        value.role !== "assistant" ||
        !Array.isArray(value.content) ||
        value.content.length !== 0 ||
        !isObject(value.details) ||
        !isObject(value.details.piInquiry)) {
        return false;
    }
    const correlation = correlationOf(value.details.piInquiry);
    return (correlation?.namespace === namespace &&
        correlation.inquiryId === inquiryId &&
        correlation.attempt === attempt);
}
function replacementMessage(replacement, correlation, timestamp) {
    return {
        role: "custom",
        customType: replacement.customType,
        content: [{ type: "text", text: replacement.content }],
        display: false,
        details: {
            ...(isObject(replacement.details) ? replacement.details : {}),
            piInquiry: correlation,
        },
        timestamp,
    };
}
function findSegment(messages, startIndex, start, namespace) {
    if (start.attempt !== 1)
        return { kind: "incomplete" };
    let attempt = start.attempt;
    const preserved = [];
    for (let index = startIndex + 1; index < messages.length; index += 1) {
        const message = messages[index];
        if (message === undefined)
            return { kind: "incomplete" };
        const plugin = parsePluginMessage(message, namespace);
        if (plugin.type === "invalid")
            return { kind: "incomplete" };
        if (plugin.type === "prompt") {
            if (plugin.correlation.inquiryId !== start.inquiryId ||
                plugin.correlation.attempt !== attempt + 1) {
                return { kind: "incomplete" };
            }
            attempt = plugin.correlation.attempt;
            continue;
        }
        if (plugin.type === "fold") {
            if (plugin.correlation.inquiryId !== start.inquiryId ||
                plugin.correlation.attempt !== attempt) {
                return { kind: "incomplete" };
            }
            let endIndex = index;
            for (let tail = index + 1; tail < messages.length; tail += 1) {
                const trailing = messages[tail];
                if (trailing === undefined)
                    break;
                if (isNeutralizedAssistant(trailing, namespace, start.inquiryId, attempt)) {
                    endIndex = tail;
                    break;
                }
                const trailingPlugin = parsePluginMessage(trailing, namespace);
                if (trailingPlugin.type !== "unrelated" || roleOf(trailing) !== "custom")
                    break;
                preserved.push(trailing);
                endIndex = tail;
            }
            return {
                kind: "folded",
                endIndex,
                replacement: [
                    ...preserved,
                    ...(plugin.replacement === undefined
                        ? []
                        : [
                            replacementMessage(plugin.replacement, plugin.correlation, plugin.timestamp),
                        ]),
                ],
            };
        }
        const role = roleOf(message);
        if (role === "custom") {
            preserved.push(message);
            continue;
        }
        if (role === "assistant") {
            if (isAbortedAssistant(message) &&
                isNeutralizedAssistant(message, namespace, start.inquiryId, attempt)) {
                return { kind: "aborted", endIndex: index };
            }
            continue;
        }
        if (role === "toolResult")
            continue;
        return { kind: "incomplete" };
    }
    return { kind: "incomplete" };
}
export function createInquiryRuntime(namespace, options = {}) {
    if (!validNamespace(namespace))
        throw new TypeError("invalid inquiry namespace");
    const inquiryId = options.inquiryId ?? randomBytes(16).toString("base64url");
    if (!validInquiryId(inquiryId))
        throw new TypeError("invalid inquiry id");
    const correlation = (attempt) => {
        if (!validAttempt(attempt))
            throw new TypeError("invalid inquiry attempt");
        return {
            version: INQUIRY_PROTOCOL_VERSION,
            namespace,
            inquiryId,
            attempt,
        };
    };
    const prompt = (content, attempt) => {
        if (!validContent(content))
            throw new TypeError("invalid inquiry prompt");
        return {
            customType: `${namespace}:inquiry`,
            content,
            display: false,
            details: correlation(attempt),
        };
    };
    const fold = (attempt, replacement) => {
        if (replacement !== undefined &&
            (replacementOf(replacement) === null ||
                (Object.hasOwn(replacement, "details") && !serializable(replacement.details)))) {
            throw new TypeError("invalid inquiry replacement");
        }
        return {
            customType: `${namespace}:inquiry-fold`,
            content: replacement?.content ?? "",
            display: false,
            details: {
                ...correlation(attempt),
                outcome: replacement === undefined ? "remove" : "replace",
                ...(replacement === undefined ? {} : { replacement }),
            },
        };
    };
    const runtime = {
        inquiryId,
        namespace,
        correlation,
        prompt,
        send(pi, content, attempt) {
            const message = prompt(content, attempt);
            pi.sendMessage(message, { triggerTurn: true, deliverAs: "steer" });
            return message;
        },
        fold,
        capture(message) {
            return roleOf(message) === "assistant" ? nonThinkingText(message) : null;
        },
        neutralize(message, attempt) {
            return neutralizeInquiryAssistant(message, correlation(attempt));
        },
        attempt(attemptNumber) {
            const attemptCorrelation = correlation(attemptNumber);
            let state = "pending";
            let cancellation = null;
            return {
                correlation: attemptCorrelation,
                get state() {
                    return state;
                },
                prompt(content) {
                    return prompt(content, attemptNumber);
                },
                markSent() {
                    if (state !== "pending")
                        return false;
                    state = "sent";
                    return true;
                },
                matchesPrompt(message) {
                    return isObject(message) &&
                        customTypeOf(message) === `${namespace}:inquiry` &&
                        sameCorrelation(correlationOf(message.details), attemptCorrelation);
                },
                capture(message) {
                    if (state === "cancelled" || state === "completed")
                        return null;
                    return roleOf(message) === "assistant" ? nonThinkingText(message) : null;
                },
                complete(replacement) {
                    if (state === "cancelled" || state === "completed")
                        return null;
                    const result = fold(attemptNumber, replacement);
                    state = "completed";
                    return result;
                },
                cancel() {
                    if (state === "completed")
                        return null;
                    cancellation ??= fold(attemptNumber);
                    state = "cancelled";
                    return cancellation;
                },
                neutralize(message, options) {
                    return neutralizeInquiryAssistant(message, attemptCorrelation, options);
                },
            };
        },
    };
    return runtime;
}
export function foldInquiryContext(messages, namespace) {
    if (!Array.isArray(messages) || !validNamespace(namespace))
        return messages;
    const result = [];
    const poisoned = new Set();
    let changed = false;
    for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        if (message === undefined)
            continue;
        const plugin = parsePluginMessage(message, namespace);
        if (plugin.type === "invalid") {
            if (plugin.inquiryId !== undefined)
                poisoned.add(plugin.inquiryId);
            result.push(message);
            continue;
        }
        if (plugin.type !== "prompt" || plugin.correlation.attempt !== 1) {
            result.push(message);
            continue;
        }
        if (poisoned.has(plugin.correlation.inquiryId)) {
            result.push(message);
            continue;
        }
        const segment = findSegment(messages, index, plugin.correlation, namespace);
        if (segment.kind === "folded") {
            result.push(...segment.replacement);
            index = segment.endIndex;
            changed = true;
            continue;
        }
        if (segment.kind === "aborted") {
            index = segment.endIndex;
            changed = true;
            continue;
        }
        poisoned.add(plugin.correlation.inquiryId);
        result.push(message);
    }
    return changed ? result : messages;
}
export function registerInquiryContextFolding(pi, namespace) {
    if (!validNamespace(namespace))
        throw new TypeError("invalid inquiry namespace");
    pi.on("context", (event) => ({
        messages: foldInquiryContext(event.messages, namespace),
    }));
}
export function neutralizeInquiryAssistant(message, correlation, options = {}) {
    if (roleOf(message) !== "assistant")
        return message;
    const neutralized = neutralizeAssistantMessage(message);
    const currentDetails = isObject(neutralized.details)
        ? neutralized.details
        : {};
    return {
        ...neutralized,
        stopReason: options.stopReason ?? neutralized.stopReason,
        details: {
            ...currentDetails,
            piInquiry: correlation,
        },
    };
}
