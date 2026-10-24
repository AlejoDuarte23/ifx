export type SupportedIfcSchema = "IFC2X3" | "IFC4" | "IFC4X3";

const HEADER_LIMIT = 1024 * 1024;

export function detectIfcSchema(source: ArrayBuffer | Uint8Array): string | null {
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
  const header = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, HEADER_LIMIT));
  let cursor = 0;
  const next = (): string | null => {
    while (cursor < header.length) {
      if (/\s/.test(header[cursor]!)) { cursor++; continue; }
      if (header.startsWith("/*", cursor)) {
        const end = header.indexOf("*/", cursor + 2);
        if (end < 0) return null;
        cursor = end + 2; continue;
      }
      const start = cursor++;
      if (header[start] === "'") {
        while (cursor < header.length) {
          if (header[cursor++] === "'") {
            if (header[cursor] === "'") { cursor++; continue; }
            return header.slice(start, cursor);
          }
        }
        return null;
      }
      if (/[A-Za-z_]/.test(header[start]!)) {
        while (cursor < header.length && /[A-Za-z0-9_]/.test(header[cursor]!)) cursor++;
      }
      return header.slice(start, cursor);
    }
    return null;
  };
  for (let token = next(); token !== null; token = next()) {
    const upper = token.toUpperCase();
    if (upper === "ENDSEC" || upper === "DATA") return null;
    if (upper !== "FILE_SCHEMA") continue;
    if (next() !== "(" || next() !== "(") return null;
    const schema = next();
    if (!schema?.startsWith("'") || !schema.endsWith("'")) return null;
    if (next() !== ")" || next() !== ")" || next() !== ";") return null;
    return schema.slice(1, -1).replaceAll("''", "'").toUpperCase();
  }
  return null;
}

export function assertSupportedIfcSchema(source: ArrayBuffer | Uint8Array): SupportedIfcSchema {
  const schema = detectIfcSchema(source);
  switch (schema) {
    case "IFC2X3": case "IFC2X3_TC1": return "IFC2X3";
    case "IFC4": case "IFC4_ADD2": case "IFC4_ADD2_TC1": return "IFC4";
    case "IFC4X3": case "IFC4X3_RC4": case "IFC4X3_ADD2": return "IFC4X3";
    default: throw new Error("The file does not declare a supported IFC2X3, IFC4 or IFC4X3 schema.");
  }
}
