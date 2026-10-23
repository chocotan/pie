const PROCESS_DOMAIN_OPEN_ERROR_CODES = new Set([
    "INVALID_DECLARATION",
    "AUTHENTICATION_FAILED",
    "CONNECTION_UNAVAILABLE",
]);
export class ProcessDomainOpenError extends Error {
    code;
    isProcessDomainOpenError = true;
    constructor(code, message, options) {
        super(message, options);
        this.code = code;
        this.name = "ProcessDomainOpenError";
    }
}
export function isProcessDomainOpenError(value) {
    return (value instanceof Error &&
        value.isProcessDomainOpenError === true &&
        PROCESS_DOMAIN_OPEN_ERROR_CODES.has(value.code));
}
export function invalidDeclarationError(cause) {
    return new ProcessDomainOpenError("INVALID_DECLARATION", "process-domain declaration is invalid", { cause });
}
export function authenticationFailedError(cause) {
    return new ProcessDomainOpenError("AUTHENTICATION_FAILED", "process-domain authentication failed", { cause });
}
export function connectionUnavailableError(cause) {
    return new ProcessDomainOpenError("CONNECTION_UNAVAILABLE", "process-domain connection is unavailable", { cause });
}
