// MCP Apps 2026-01-26: the page talks only to its host, never to the service origin.
import type { ClientMessage, ServerMessage } from "@screens/protocol";
import type { RequestBody, ServiceTransport } from "./index.ts";
import { openingRequest, setOpeningTraceSink } from "./diagnostics.ts";

export async function connectAppTransport(): Promise<ServiceTransport> {
  const session = crypto.randomUUID();
  let next = 0, closed = false, ending = false, connected = false, cursor = 0, sessionId = "";
  const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const events = new Set<(m: ServerMessage) => void>();
  const connections = new Set<(up: boolean) => void>();
  const onMessage = (e: MessageEvent) => {
    if (e.source !== parent || !e.data || e.data.jsonrpc !== "2.0") return;
    if (typeof e.data.method === "string") {
      if (e.data.method === "ui/resource-teardown" && e.data.id !== undefined) {
        const id = e.data.id;
        ending = true;
        void Promise.race([call("_screens_call", { kind: "close" }).catch(() => {}), new Promise((resolve) => setTimeout(resolve, 500))]).finally(() => {
          parent.postMessage({ jsonrpc: "2.0", id, result: {} }, "*");
          stop();
        });
      } else if (e.data.id !== undefined) parent.postMessage({ jsonrpc: "2.0", id: e.data.id, error: { code: -32601, message: "Method not found" } }, "*");
      // The tool that opened this view names a Screen to show, or none for the library.
      else if (e.data.method === "ui/notifications/tool-input") {
        const id = e.data.params?.arguments?.screenId;
        dispatchEvent(new CustomEvent("screens:open-screen", { detail: typeof id === "string" ? id : null }));
      }
      return;
    }
    if (typeof e.data.id !== "number") return;
    const w = waiting.get(e.data.id); if (!w) return;
    waiting.delete(e.data.id);
    if (e.data.error) w.reject(new Error(String(e.data.error.message ?? "Host request failed")));
    else w.resolve(e.data.result);
  };
  addEventListener("message", onMessage);
  const rpc = (method: string, params: object) => new Promise<unknown>((resolve, reject) => {
    if (closed) { reject(new Error("connection lost")); return; }
    const id = ++next; waiting.set(id, { resolve, reject }); parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
  });
  const call = async <T>(name: string, args: object): Promise<T> => {
    const r = await rpc("tools/call", { name, arguments: { ...args, session } }) as { isError?: boolean; structuredContent?: { value?: T }; content?: { text?: string }[] };
    if (r.isError) throw new Error(r.content?.[0]?.text ?? "Tool call failed");
    if (!r.structuredContent || !("value" in r.structuredContent)) throw new Error("Invalid tool response");
    return r.structuredContent.value as T;
  };
  // App traces use the same host relay as content. No loopback or external request is made by this page.
  if ((window as unknown as { __SCREENS_OPENING__?: unknown }).__SCREENS_OPENING__) {
    setOpeningTraceSink(async (trace) => { await call("_screens_opening_trace", { trace }); });
  }
  try {
    const init = await openingRequest("app.initialize", () => rpc("ui/initialize", { appInfo: { name: "Screens", version: "0.1.0" }, appCapabilities: {}, protocolVersion: "2026-01-26" })) as { protocolVersion?: string };
    if (init.protocolVersion !== "2026-01-26") throw new Error("Unsupported MCP Apps protocol");
    parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized" }, "*");
    const hello = await openingRequest("app.connect", () => call<{ sessionId: string; since: number }>("_screens_call", { kind: "connect" }));
    sessionId = hello.sessionId; cursor = hello.since; connected = true;
  } catch (e) { removeEventListener("message", onMessage); throw e; }
  const poll = async () => {
    while (!closed && !ending) {
      try {
        const r = await call<{ connected?: boolean; sessionId: string; since: number; reset: boolean; events: { seq: number; message: ServerMessage }[] }>("_screens_events", { since: cursor });
        if (closed || ending) break;
        // The adapter lost the service: stay disconnected until it is back, then the welcome below reconnects the view.
        if (r.connected === false) {
          if (connected) { connected = false; for (const cb of connections) cb(false); }
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
        const replaced = sessionId !== r.sessionId;
        sessionId = r.sessionId;
        if (!connected || r.reset || replaced) { connected = false; for (const cb of connections) cb(false); connected = true; for (const cb of connections) cb(true); }
        cursor = r.since;
        for (const event of r.events) {
          if (event.message.t === "welcome") { for (const cb of connections) cb(false); for (const cb of connections) cb(true); }
          else for (const cb of events) cb(event.message);
        }
      } catch {
        if (closed || ending) break;
        if (connected) { connected = false; for (const cb of connections) cb(false); }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  };
  void poll();
  const b64 = (bytes: Uint8Array) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
  function stop() {
    closed = true; connected = false; removeEventListener("message", onMessage);
    for (const w of waiting.values()) w.reject(new Error("connection lost")); waiting.clear();
  }
  return {
    kind: "app",
    get sessionId() { return sessionId; }, get connected() { return connected; },
    request: <T>(message: RequestBody) => openingRequest(`app.${message.t}`, () => message.t === "readContent"
      ? call<T>("_screens_content", { hash: message.hash }) : call<T>("_screens_call", { kind: "request", message })),
    post: (message: ClientMessage) => { void openingRequest(`app.post.${message.t}`, () => call("_screens_call", { kind: "post", message })).catch(() => {}); },
    sendChunk: (hash, size, offset, bytes) => openingRequest("app.chunk", () => call("_screens_call", { kind: "chunk", hash, size, offset, bytes: b64(bytes) })),
    onEvent: (cb) => { events.add(cb); return () => events.delete(cb); },
    onConnection: (cb) => { connections.add(cb); return () => connections.delete(cb); },
    close: () => { void call("_screens_call", { kind: "close" }).catch(() => {}); stop(); },
  };
}
