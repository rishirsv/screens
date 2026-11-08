// Inspect the actual MCP response before encoding it. Authored Screen text is data, not a storage diagnostic.
import crypto from "node:crypto";

/** Keep a fixed-size identity rather than retaining uploaded files and source strings for the session. */
export const authoredKey = (text: string): string => crypto.createHash("sha256").update(text).digest("hex");

export class ResultLeakError extends Error {}
export interface ScanScope {
  readonly privateStrings: readonly string[];
  readonly authored: ReadonlySet<string>;
  /** Only a declared local file `path` argument, for this call. Never a prefix or a persisted exemption. */
  readonly callerPath?: string;
}
const absolutePath = /(?:^|[\s"'=(])(?:\/[\w.~%-]+(?:\/[^\s"'<>)\]},;:]+)*|[A-Za-z]:[\\/][^\s"'<>)\]},;]+)/;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function inspectResult(value: unknown, scope: ScanScope): void {
  const visit = (v: unknown, encoded = false): void => {
    if (Array.isArray(v)) { for (const x of v) visit(x); return; }
    if (v && typeof v === "object") {
      const record = v as Record<string, unknown>;
      for (const [key, x] of Object.entries(record)) visit(x, (record.type === "image" && key === "data") || (record.encoding === "base64" && key === "content"));
      return;
    }
    if (typeof v !== "string") return;
    const privateData = (s: string) => scope.privateStrings.some((p) => s.includes(p));
    if (privateData(v)) throw new ResultLeakError("MCP result leaked private storage or an unrelated file");
    if (encoded) {
      const bytes = Buffer.from(v, "base64");
      if (privateData(bytes.toString("utf8"))) throw new ResultLeakError("MCP result leaked encoded private data");
      if (!scope.authored.has(authoredKey(v))) {
        // Binary images are scanned for private bytes; only valid text has meaningful filesystem paths.
        try { visit(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch (e) { if (e instanceof ResultLeakError) throw e; }
      }
      return;
    }
    if (scope.authored.has(authoredKey(v))) return;
    // MCP text content often serializes structuredContent. Inspect its leaf values, not its JSON syntax.
    try { const json: unknown = JSON.parse(v); if (json && typeof json === "object") { visit(json); return; } } catch (e) { if (e instanceof ResultLeakError) throw e; }
    let diagnostic = v;
    if (scope.callerPath) {
      // A diagnostic may echo the exact requested path followed by punctuation, never a sibling or descendant.
      const exact = new RegExp(`(^|[\\s"'=(])${escape(scope.callerPath)}(?=$|[\\s"'\\])},;:])`, "g");
      diagnostic = diagnostic.replace(exact, "$1<caller-path>");
    }
    if (absolutePath.test(diagnostic)) throw new ResultLeakError("MCP result contains an absolute local path");
  };
  visit(value);
}

/** Companion controls for the guard itself, driven by `probe results` beside real tool-result scans. */
export function resultScanControls(): Readonly<Record<string, boolean>> {
  const scope: ScanScope = { privateStrings: ["PRIVATE_CANARY"], authored: new Set([authoredKey("Project /Users/me/design")]), callerPath: "/tmp/a" };
  const blocked = (v: unknown, s = scope) => { try { inspectResult(v, s); return false; } catch (e) { if (e instanceof ResultLeakError) return true; throw e; } };
  return {
    siblingRefused: blocked({ message: "/tmp/a-secret" }),
    descendantRefused: blocked({ message: "/tmp/a/private" }),
    encodedPathRefused: blocked({ encoding: "base64", content: Buffer.from("/mnt/private/file.txt").toString("base64") }),
    canaryRefused: blocked({ content: "PRIVATE_CANARY" }),
    exactPathAllowed: !blocked({ path: "/tmp/a", message: "cannot read /tmp/a: ENOENT" }),
    authoredAllowed: !blocked({ title: "Project /Users/me/design" }),
    argumentPrefixRefused: blocked({ message: "/var/private" }, { ...scope, callerPath: undefined, authored: new Set([authoredKey("/var")]) }),
  };
}
