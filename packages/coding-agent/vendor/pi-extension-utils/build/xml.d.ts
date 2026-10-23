export declare const MAX_XML_TEXT_CODE_POINTS = 16384;
export interface XmlField {
    readonly name: string;
    readonly value: string;
}
export interface ParsedXmlDocument {
    readonly root: string;
    readonly fields: ReadonlyMap<string, string>;
}
export interface XmlValidationError {
    readonly valid: false;
    readonly error: string;
}
export interface XmlValidationSuccess<T> {
    readonly valid: true;
    readonly value: T;
}
export type XmlValidation<T> = XmlValidationSuccess<T> | XmlValidationError;
export declare function buildXmlDocument(root: string, fields: readonly XmlField[]): string;
export declare function extractTrailingXml(text: string, root: string): string | null;
export declare function parseTrailingXml(text: string, root: string): XmlValidation<ParsedXmlDocument>;
export declare function nonThinkingText(message: unknown): string;
export declare function neutralizeAssistantMessage<T>(message: T): T;
