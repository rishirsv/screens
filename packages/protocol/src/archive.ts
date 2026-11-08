// The Screens export file. Pure: runs in Node and the browser. The one owner of the format.
//
// Layout: "SCREENS\0" | u32 BE format | u32 BE header length H | header JSON (H bytes) | file bytes back to back, in header order.
// Offsets are derived from sizes, never stored. The header is uploaded and hashed like any file, so the service reads the
// format from bytes it has verified.

import type { ScreenDoc } from "@screens/core";

export const ARCHIVE_FORMAT = 1;
const MAGIC = new TextEncoder().encode("SCREENS\0");
const PREFIX = MAGIC.length + 8;
const HASH = /^[0-9a-f]{64}$/;

export interface ArchiveFile { readonly hash: string; readonly size: number; readonly mediaType: string }
/** `screen` is untrusted until core's checkScreen accepts it. */
export interface ArchiveHead { readonly format: typeof ARCHIVE_FORMAT; readonly screen: unknown; readonly files: readonly ArchiveFile[] }
export interface ArchiveError { readonly error: "format" | "invalid"; readonly message: string }

/** Every content file a Screen references, with the media type the document gives it. Posters are JPEG. */
export function archiveFiles(doc: ScreenDoc): { readonly hash: string; readonly mediaType: string }[] {
  const out = new Map<string, string>();
  for (const it of Object.values(doc.items)) {
    if (it.kind === "reference-image") out.set(it.assetHash, it.mediaType);
    else {
      for (const a of Object.values(it.assetManifest)) if (!out.has(a.hash)) out.set(a.hash, a.mediaType);
      if (it.posterHash && !out.has(it.posterHash)) out.set(it.posterHash, "image/jpeg");
    }
  }
  return [...out].map(([hash, mediaType]) => ({ hash, mediaType }));
}

/** The export as parts to write in order: the prefix and header, then each file's bytes as given (not copied). */
export function encodeArchive(doc: ScreenDoc, files: readonly { readonly hash: string; readonly mediaType: string; readonly bytes: Uint8Array }[]): Uint8Array[] {
  const head: ArchiveHead = { format: ARCHIVE_FORMAT, screen: doc, files: files.map((f) => ({ hash: f.hash, size: f.bytes.length, mediaType: f.mediaType })) };
  const headBytes = new TextEncoder().encode(JSON.stringify(head));
  const first = new Uint8Array(PREFIX + headBytes.length);
  first.set(MAGIC, 0);
  const v = new DataView(first.buffer);
  v.setUint32(MAGIC.length, ARCHIVE_FORMAT); v.setUint32(MAGIC.length + 4, headBytes.length);
  first.set(headBytes, PREFIX);
  return [first, ...files.map((f) => f.bytes)];
}

/** True when `bytes` starts like a Screens export. Export replaces only such a file. */
export function isArchive(bytes: Uint8Array): boolean {
  return bytes.length >= MAGIC.length && MAGIC.every((b, i) => bytes[i] === b);
}

/** The header bytes and one view per file. Refuses a bad magic, an unknown version, a length that disagrees with the sizes,
 *  or repeated hashes. Hashes are not checked here: the upload path verifies every file. */
export function splitArchive(bytes: Uint8Array): { readonly head: Uint8Array; readonly parsed: ArchiveHead; readonly files: readonly { readonly file: ArchiveFile; readonly bytes: Uint8Array }[] } | ArchiveError {
  if (bytes.length < PREFIX || !isArchive(bytes)) return { error: "invalid", message: "this is not a Screens export" };
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const format = v.getUint32(MAGIC.length);
  if (format !== ARCHIVE_FORMAT) return formatError(format);
  const n = v.getUint32(MAGIC.length + 4);
  if (PREFIX + n > bytes.length) return { error: "invalid", message: "the export is truncated" };
  const head = bytes.subarray(PREFIX, PREFIX + n);
  const parsed = parseArchiveHead(head);
  if ("error" in parsed) return parsed;
  let at = PREFIX + n;
  const files = parsed.files.map((file) => { const b = bytes.subarray(at, at + file.size); at += file.size; return { file, bytes: b }; });
  if (at !== bytes.length) return { error: "invalid", message: "the export's length does not match its file list" };
  return { head, parsed, files };
}

/** Parses the header JSON and refuses an unknown format, naming both versions. The service runs this on verified bytes. */
export function parseArchiveHead(head: Uint8Array): ArchiveHead | ArchiveError {
  let h: { format?: unknown; screen?: unknown; files?: unknown };
  try { h = JSON.parse(new TextDecoder().decode(head)); } catch { return { error: "invalid", message: "the export header is not JSON" }; }
  if (!h || typeof h !== "object") return { error: "invalid", message: "the export header is not an object" };
  if (h.format !== ARCHIVE_FORMAT) return formatError(h.format);
  if (!Array.isArray(h.files)) return { error: "invalid", message: "the export has no file list" };
  const seen = new Set<string>();
  for (const f of h.files as ArchiveFile[]) {
    if (!f || !HASH.test(f.hash) || !Number.isInteger(f.size) || f.size < 0 || typeof f.mediaType !== "string") return { error: "invalid", message: "the export's file list is malformed" };
    if (seen.has(f.hash)) return { error: "invalid", message: `file ${f.hash.slice(0, 12)} is listed twice` };
    seen.add(f.hash);
  }
  return { format: ARCHIVE_FORMAT, screen: h.screen, files: h.files as ArchiveFile[] };
}

const formatError = (format: unknown): ArchiveError =>
  ({ error: "format", message: `this file is Screens export format ${String(format)}; this Screens reads format ${ARCHIVE_FORMAT}` });
