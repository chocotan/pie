export type ProcessDomainOpenErrorCode = "INVALID_DECLARATION" | "AUTHENTICATION_FAILED" | "CONNECTION_UNAVAILABLE";
export declare class ProcessDomainOpenError extends Error {
    readonly code: ProcessDomainOpenErrorCode;
    readonly isProcessDomainOpenError: true;
    constructor(code: ProcessDomainOpenErrorCode, message: string, options?: ErrorOptions);
}
export declare function isProcessDomainOpenError(value: unknown): value is ProcessDomainOpenError;
export declare function invalidDeclarationError(cause: unknown): ProcessDomainOpenError;
export declare function authenticationFailedError(cause: unknown): ProcessDomainOpenError;
export declare function connectionUnavailableError(cause: unknown): ProcessDomainOpenError;
