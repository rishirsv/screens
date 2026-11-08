// Still-image headers. Pure: reads only the first bytes, never decodes pixels.

export type ImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
export interface ImageInfo { readonly mediaType: ImageType; readonly width: number; readonly height: number }

/** PNG IHDR, JPEG SOFn, GIF screen descriptor, WebP VP8/VP8L/VP8X. null: not a supported still image. */
export function imageInfo(b: Uint8Array): ImageInfo | null {
  const u16be = (i: number) => (b[i]! << 8) | b[i + 1]!;
  const u16le = (i: number) => b[i]! | (b[i + 1]! << 8);
  const u24le = (i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
  const u32be = (i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
  const ascii = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
  const ok = (mediaType: ImageType, width: number, height: number): ImageInfo | null =>
    width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height) ? { mediaType, width, height } : null;

  if (b.length >= 24 && b[0] === 0x89 && ascii(1, 3) === "PNG" && ascii(12, 4) === "IHDR") return ok("image/png", u32be(16), u32be(20));
  if (b.length >= 10 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return ok("image/gif", u16le(6), u16le(8));
  if (b.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const chunk = ascii(12, 4);
    if (chunk === "VP8 ") return ok("image/webp", u16le(26) & 0x3fff, u16le(28) & 0x3fff);
    if (chunk === "VP8L") { const v = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24); return ok("image/webp", (v & 0x3fff) + 1, ((v >>> 14) & 0x3fff) + 1); }
    if (chunk === "VP8X") return ok("image/webp", u24le(24) + 1, u24le(27) + 1);
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1]!;
      if (m === 0xff) { i++; continue; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      const len = u16be(i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return ok("image/jpeg", u16be(i + 7), u16be(i + 5));
      if (m === 0xd9 || m === 0xda) return null;
      i += 2 + len;
    }
  }
  return null;
}
