export const MAX_XML_TEXT_CODE_POINTS = 16_384;
function decodeEntities(value) {
    let output = "";
    for (let index = 0; index < value.length; index += 1) {
        if (value[index] !== "&") {
            output += value[index];
            continue;
        }
        const end = value.indexOf(";", index + 1);
        if (end < 0)
            return null;
        const entity = value.slice(index + 1, end);
        if (entity === "lt")
            output += "<";
        else if (entity === "gt")
            output += ">";
        else if (entity === "amp")
            output += "&";
        else if (entity === "quot")
            output += '"';
        else if (entity === "apos")
            output += "'";
        else if (/^#\d+$/.test(entity)) {
            const point = Number(entity.slice(1));
            if (!validCodePoint(point))
                return null;
            output += String.fromCodePoint(point);
        }
        else if (/^#x[0-9a-f]+$/i.test(entity)) {
            const point = Number.parseInt(entity.slice(2), 16);
            if (!validCodePoint(point))
                return null;
            output += String.fromCodePoint(point);
        }
        else
            return null;
        index = end;
    }
    return output;
}
function validCodePoint(point) {
    return (Number.isSafeInteger(point) &&
        (point === 0x9 || point === 0xa || point === 0xd ||
            (point >= 0x20 && point <= 0xd7ff) ||
            (point >= 0xe000 && point <= 0xfffd) ||
            (point >= 0x10000 && point <= 0x10ffff)));
}
function hasOnlyXmlCharacters(value) {
    for (const character of value) {
        const point = character.codePointAt(0);
        if (point === undefined || !validCodePoint(point))
            return false;
    }
    return true;
}
function escapeText(value) {
    if (!hasOnlyXmlCharacters(value))
        throw new TypeError("invalid XML text character");
    return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function nameAt(source, index) {
    const match = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(source.slice(index));
    return match === null ? null : { name: match[0], next: index + match[0].length };
}
function skipWhitespace(source, index) {
    while (/[ \t\r\n]/u.test(source[index] ?? ""))
        index += 1;
    return index;
}
export function buildXmlDocument(root, fields) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(root))
        throw new TypeError("invalid XML root name");
    return `<${root}>${fields.map((field) => {
        if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(field.name))
            throw new TypeError("invalid XML field name");
        return `<${field.name}>${escapeText(field.value)}</${field.name}>`;
    }).join("")}</${root}>`;
}
export function extractTrailingXml(text, root) {
    if (Array.from(text).length > MAX_XML_TEXT_CODE_POINTS)
        return null;
    const trailingWhitespaceRemoved = text.replace(/[ \t\r\n]+$/u, "");
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(root))
        return null;
    const open = `<${root}>`;
    const close = `</${root}>`;
    if (!trailingWhitespaceRemoved.endsWith(close))
        return null;
    const start = trailingWhitespaceRemoved.lastIndexOf(open);
    if (start < 0 || trailingWhitespaceRemoved.indexOf(open) !== start || trailingWhitespaceRemoved.indexOf(close) !== trailingWhitespaceRemoved.lastIndexOf(close))
        return null;
    return trailingWhitespaceRemoved.slice(start);
}
export function parseTrailingXml(text, root) {
    const document = extractTrailingXml(text, root);
    if (document === null)
        return { valid: false, error: "response must end with one valid XML block" };
    const open = `<${root}>`;
    const close = `</${root}>`;
    if (!document.startsWith(open))
        return { valid: false, error: "XML root must be a bare tag" };
    const fields = new Map();
    let index = open.length;
    while (true) {
        index = skipWhitespace(document, index);
        if (document.startsWith(close, index)) {
            index += close.length;
            return index === document.length ? { valid: true, value: { root, fields } } : { valid: false, error: "unsupported trailing XML content" };
        }
        if (document[index] !== "<" || "/!?".includes(document[index + 1] ?? ""))
            return { valid: false, error: "malformed XML field" };
        const field = nameAt(document, index + 1);
        if (field === null || document[field.next] !== ">")
            return { valid: false, error: "XML fields cannot have attributes" };
        const fieldName = field.name;
        index = field.next + 1;
        const textStart = index;
        while (index < document.length && document[index] !== "<")
            index += 1;
        const decoded = decodeEntities(document.slice(textStart, index));
        if (decoded === null || !hasOnlyXmlCharacters(decoded) || document[index] !== "<" || document[index + 1] !== "/")
            return { valid: false, error: "malformed XML field content" };
        const closeName = nameAt(document, index + 2);
        if (closeName === null || closeName.name !== fieldName || document[closeName.next] !== ">")
            return { valid: false, error: "XML field tags do not match" };
        index = closeName.next + 1;
        if (fields.has(fieldName))
            return { valid: false, error: `duplicate XML field: ${fieldName}` };
        fields.set(fieldName, decoded);
    }
}
export function nonThinkingText(message) {
    if (typeof message !== "object" || message === null)
        return "";
    const content = message.content;
    if (!Array.isArray(content))
        return "";
    return content.filter((block) => typeof block === "object" && block !== null && block.type === "text" && typeof block.text === "string").map((block) => block.text).join("");
}
export function neutralizeAssistantMessage(message) {
    if (typeof message !== "object" || message === null)
        return message;
    return { ...message, content: [] };
}
