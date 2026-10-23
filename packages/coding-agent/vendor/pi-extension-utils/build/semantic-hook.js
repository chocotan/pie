export const SEMANTIC_HOOK_CHANNEL = "pi:semantic-hook:v1";
/** Bounded protocol sizes keep validation and diagnostics proportionate. */
const MAX_HOOK_NAME_LENGTH = 128;
const MAX_VALUES_KEY_LENGTH = 128;
const MAX_VALUES_VALUE_LENGTH = 4_096;
const MAX_DIAGNOSTIC_SNIPPET = 120;
const KEBAB_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UPPER_SNAKE = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/;
function isSemanticHookName(name) {
    return (name.length > 0 &&
        name.length <= MAX_HOOK_NAME_LENGTH &&
        KEBAB_NAME.test(name));
}
function isSemanticHookValueKey(key) {
    return (key.length > 0 &&
        key.length <= MAX_VALUES_KEY_LENGTH &&
        UPPER_SNAKE.test(key));
}
/** Ordinary object or null-prototype record; rejects arrays and custom prototypes. */
function isPlainObject(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}
function clipSemanticHookDiagnostic(text) {
    if (text.length <= MAX_DIAGNOSTIC_SNIPPET)
        return text;
    return `${text.slice(0, MAX_DIAGNOSTIC_SNIPPET)}…`;
}
function describeThrown(value) {
    try {
        return clipSemanticHookDiagnostic(value instanceof Error ? value.message : String(value));
    }
    catch {
        return "unprintable error";
    }
}
/** Read one own data property without invoking accessors or inherited fields. */
function readOwnDataProperty(object, key) {
    try {
        if (!Object.hasOwn(object, key))
            return { ok: false, reason: "missing" };
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        if (!descriptor ||
            "get" in descriptor ||
            "set" in descriptor ||
            !("value" in descriptor)) {
            return { ok: false, reason: "not a data property" };
        }
        return { ok: true, value: descriptor.value };
    }
    catch (error) {
        return {
            ok: false,
            reason: `property access failed: ${describeThrown(error)}`,
        };
    }
}
function freezeValues(values) {
    return Object.freeze({ ...values });
}
/** Validate one envelope and return an immutable copy of accepted protocol data. */
function parseSemanticHookUnchecked(data) {
    if (!isPlainObject(data)) {
        return { ok: false, reason: "envelope must be a plain object" };
    }
    const versionProp = readOwnDataProperty(data, "version");
    if (!versionProp.ok) {
        return {
            ok: false,
            reason: versionProp.reason === "missing"
                ? "version must be exactly 1"
                : versionProp.reason,
        };
    }
    if (versionProp.value !== 1) {
        return { ok: false, reason: "version must be exactly 1" };
    }
    const nameProp = readOwnDataProperty(data, "name");
    if (!nameProp.ok) {
        return {
            ok: false,
            reason: nameProp.reason === "missing"
                ? "name must be lowercase kebab-case"
                : nameProp.reason,
        };
    }
    if (typeof nameProp.value !== "string" ||
        !isSemanticHookName(nameProp.value)) {
        return { ok: false, reason: "name must be lowercase kebab-case" };
    }
    let values;
    if (Object.hasOwn(data, "values")) {
        const valuesProp = readOwnDataProperty(data, "values");
        if (!valuesProp.ok)
            return { ok: false, reason: valuesProp.reason };
        if (valuesProp.value === undefined) {
            // An own undefined data property is equivalent to absent optional values.
        }
        else if (!isPlainObject(valuesProp.value)) {
            return {
                ok: false,
                reason: "values must be a plain non-array object",
            };
        }
        else {
            const copied = Object.create(null);
            let keys;
            try {
                keys = Object.keys(valuesProp.value);
            }
            catch (error) {
                return {
                    ok: false,
                    reason: `values keys inaccessible: ${describeThrown(error)}`,
                };
            }
            for (const key of keys) {
                if (!isSemanticHookValueKey(key)) {
                    return {
                        ok: false,
                        reason: `invalid values key ${JSON.stringify(clipSemanticHookDiagnostic(key))}`,
                    };
                }
                const entry = readOwnDataProperty(valuesProp.value, key);
                if (!entry.ok) {
                    return {
                        ok: false,
                        reason: `values.${clipSemanticHookDiagnostic(key)}: ${entry.reason}`,
                    };
                }
                if (typeof entry.value !== "string") {
                    return {
                        ok: false,
                        reason: `values.${clipSemanticHookDiagnostic(key)} must be a string`,
                    };
                }
                if (entry.value.length > MAX_VALUES_VALUE_LENGTH) {
                    return {
                        ok: false,
                        reason: `values.${clipSemanticHookDiagnostic(key)} exceeds ${MAX_VALUES_VALUE_LENGTH} characters`,
                    };
                }
                copied[key] = entry.value;
            }
            values = freezeValues(copied);
        }
    }
    const envelope = values === undefined
        ? Object.freeze({ version: 1, name: nameProp.value })
        : Object.freeze({ version: 1, name: nameProp.value, values });
    return { ok: true, envelope };
}
/** Contain hostile Proxy traps as bounded validation failures. */
export function parseSemanticHook(data) {
    try {
        return parseSemanticHookUnchecked(data);
    }
    catch (error) {
        return {
            ok: false,
            reason: `envelope inaccessible: ${describeThrown(error)}`,
        };
    }
}
/** Build, validate, freeze, and synchronously publish one semantic hook. */
export function publishSemanticHook(events, input) {
    const candidate = Object.create(null);
    candidate.version = 1;
    if (input !== null && typeof input === "object") {
        const name = readOwnDataProperty(input, "name");
        if (name.ok)
            candidate.name = name.value;
        else if (name.reason !== "missing") {
            throw new TypeError(`Invalid semantic hook: ${clipSemanticHookDiagnostic(name.reason)}`);
        }
        const values = readOwnDataProperty(input, "values");
        if (values.ok)
            candidate.values = values.value;
        else if (values.reason !== "missing") {
            throw new TypeError(`Invalid semantic hook: ${clipSemanticHookDiagnostic(values.reason)}`);
        }
    }
    const parsed = parseSemanticHook(candidate);
    if (!parsed.ok) {
        throw new TypeError(`Invalid semantic hook: ${clipSemanticHookDiagnostic(parsed.reason)}`);
    }
    events.emit(SEMANTIC_HOOK_CHANNEL, parsed.envelope);
    return parsed.envelope;
}
/** Subscribe to valid hooks. Malformed payloads are reported but never delivered. */
export function subscribeSemanticHooks(events, listener, onInvalid) {
    return events.on(SEMANTIC_HOOK_CHANNEL, (data) => {
        const parsed = parseSemanticHook(data);
        if (parsed.ok)
            listener(parsed.envelope);
        else
            onInvalid?.(clipSemanticHookDiagnostic(parsed.reason));
    });
}
