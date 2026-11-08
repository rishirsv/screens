// Files from Finder or the clipboard → stored content with the service's image header read.

import type { Service } from "@screens/client";
import { imageInfo } from "@screens/core";
import type { DroppedImage } from "../../engine/index.ts";

/** The service's per-file limit. */
const MAX_BYTES = 64e6;


/** Images only, in order, through the service's one upload path. Files that are not PNG, JPEG, WebP or GIF are skipped. */
export async function uploadImages(svc: Service, files: readonly File[]): Promise<DroppedImage[]> {
  const out: DroppedImage[] = [];
  for (const f of files) {
    if (f.size > MAX_BYTES) continue;
    const bytes = new Uint8Array(await f.arrayBuffer());
    const info = imageInfo(bytes); if (!info) continue;
    out.push({ hash: await svc.upload(bytes), mediaType: info.mediaType, width: info.width, height: info.height, title: f.name.replace(/\.[a-z0-9]+$/i, "") || "Image" });
  }
  return out;
}

export const filesOf = (dt: DataTransfer | null): File[] => (dt ? [...dt.files] : []);

/** A random id core accepts for folders and media (CLIENT_ID). */
export const clientId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => (b % 36).toString(36)).join("");
