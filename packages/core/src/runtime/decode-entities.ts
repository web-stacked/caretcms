import { HTML_ENTITIES } from "./html-entities.js";

const C1: Record<number, number> = { 128: 8364, 130: 8218, 131: 402, 132: 8222, 133: 8230, 134: 8224, 135: 8225, 136: 710, 137: 8240, 138: 352, 139: 8249, 140: 338, 142: 381, 145: 8216, 146: 8217, 147: 8220, 148: 8221, 149: 8226, 150: 8211, 151: 8212, 152: 732, 153: 8482, 154: 353, 155: 8250, 156: 339, 158: 382, 159: 376 };

/** Decode one HTML parse layer, preserving ambiguous bare references in attributes. */
export function decodeHtmlEntities(text: string, attribute = false): string {
  return text.replace(/&(#(?:[xX][0-9a-fA-F]+|[0-9]+);?|[a-zA-Z][a-zA-Z0-9]*;?)/g, (whole: string, body: string, offset: number) => {
    if (body[0] === "#") {
      const hex = /[xX]/.test(body[1]);
      let code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!code || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) code = 0xfffd;
      return String.fromCodePoint(C1[code] ?? code);
    }
    for (let length = Math.min(body.length, 32); length > 0; length--) {
      const name = body.slice(0, length);
      if (!Object.prototype.hasOwnProperty.call(HTML_ENTITIES, name)) continue;
      const next = body[length] ?? text[offset + whole.length] ?? "";
      if (attribute && !name.endsWith(";") && /[a-zA-Z0-9=]/.test(next)) return whole;
      return HTML_ENTITIES[name] + body.slice(length);
    }
    return whole;
  });
}
