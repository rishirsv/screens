// Browser canvases use service URLs; MCP Apps load image bytes through the host relay.
import { useEffect, useState, type ComponentPropsWithRef } from "react";
import { imageInfo } from "@screens/core";
import type { Service } from "@screens/client";
export function imageDataUrl(bytes: Uint8Array, mediaType = imageInfo(bytes)?.mediaType ?? "application/octet-stream"): string {
  let raw = ""; for (let i = 0; i < bytes.length; i += 0x8000) raw += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mediaType};base64,${btoa(raw)}`;
}
let appService: Service | null = null;
export function configureAppContent(service: Service) { appService = service; }
export function useContentUrl(hash: string | null | undefined, browserUrl?: string): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    // A poster rendered on demand has no hash yet: ask the service for it through the relay, then read its bytes.
    const onDemand = hash ? null : browserUrl?.match(/^\/poster\/([^/]+)\/([^/]+)\/([^/?]+)/);
    if (!appService || (!hash && !onDemand)) { setUrl(undefined); return; }
    let active = true;
    const svc = appService;
    (hash ? Promise.resolve(hash) : svc.poster(onDemand![1]!, onDemand![2]!, undefined, onDemand![3]!).then((p) => p.hash))
      .then((h) => (h ? svc.readContent(h) : null))
      .then((bytes) => { if (active && bytes) setUrl(imageDataUrl(bytes)); }).catch(() => {});
    return () => { active = false; };
  }, [hash, browserUrl]);
  return appService ? url : browserUrl;
}
export function ContentImage({ hash, browserUrl, ...props }: ComponentPropsWithRef<"img"> & { hash: string; browserUrl: string }) {
  const src = useContentUrl(hash, browserUrl);
  return <img {...props} src={src} />;
}
