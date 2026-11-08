// MCP Apps relay. Each view owns a canvas-role connection; credentials stay in the adapter.
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { connectWebSocketTransport, type ServiceTransport, type RequestBody } from "@screens/client";
import type { ClientMessage, ServerMessage } from "@screens/protocol";
import { bundle, canvasAssets, ensureService, openingConfigScript, readOpeningConfig, screensHome } from "@screens/service";

const allowed = new Set(["list", "create", "openLibrary", "libraryOp", "libraryHistory", "purge", "searchMedia", "open", "op", "history", "status", "upload", "importScreen", "poster"]);
const posts = new Set(["transient", "context", "leave", "viewCommandAnswer"]);
const meta = { ui: { visibility: ["app"] } };
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: { value } });
type Session = { transport: ServiceTransport; up: boolean; sequence: number; events: { seq: number; message: ServerMessage }[]; wake: Set<() => void>; touched: number };

export function registerAppTools(server: McpServer): void {
  const openingOut = process.env.SCREENS_OPENING_OUT;
  if (process.env.SCREENS_OPENING_CONFIG && openingOut) {
    const out = path.resolve(openingOut), library = path.join(screensHome(), "library");
    if (out === library || out.startsWith(`${library}${path.sep}`)) throw new Error("Opening traces must be written outside the Screens library");
    server.registerTool("_screens_opening_trace", { description: "Collect an explicitly enabled opening benchmark result.", _meta: meta,
      inputSchema: { session: z.string().uuid(), trace: z.unknown() } }, async ({ trace }) => {
      const openingConfig = readOpeningConfig();
      if (!openingConfig) throw new Error("Opening trace collection is not configured");
      if (!trace || typeof trace !== "object" || Array.isArray(trace) || (trace as Record<string, unknown>).runId !== openingConfig.runId) throw new Error("Opening trace run does not match the configured run");
      const json = JSON.stringify(trace);
      if (Buffer.byteLength(json) > 8 * 1024 * 1024) throw new Error("Opening trace exceeds 8 MiB");
      // The output is a diagnostic artifact, never Screen storage. Exclusive creation makes lost-answer retries idempotent.
      fs.mkdirSync(path.dirname(out), { recursive: true });
      try { fs.writeFileSync(out, json, { flag: "wx", mode: 0o600 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || fs.statSync(out).size > 8 * 1024 * 1024 || fs.readFileSync(out, "utf8") !== json) throw new Error("Opening trace output already contains a different result");
      }
      return result({ collected: true, runId: openingConfig.runId });
    });
  }
  const sessions = new Map<string, Promise<Session>>();
  const getSession = async (id: string): Promise<Session> => {
    let pending = sessions.get(id);
    if (!pending) {
      pending = (async () => {
        const reg = await ensureService();
        const transport = await connectWebSocketTransport({ origin: reg.canvasOrigin, token: reg.token, instanceId: reg.instanceId, role: "canvas", surface: "app" });
        const session: Session = { transport, up: true, sequence: 0, events: [], wake: new Set(), touched: Date.now() };
        const push = (message: ServerMessage) => {
          session.events.push({ seq: ++session.sequence, message });
          if (session.events.length > 10000) session.events.splice(0, session.events.length - 10000);
          for (const fn of session.wake) fn();
        };
        transport.onEvent(push);
        // The view hears about an outage on its next poll, so it waits for the service instead of retrying into a dead connection.
        transport.onConnection((up) => {
          session.up = up;
          if (up) push({ t: "welcome", sessionId: transport.sessionId, instanceId: reg.instanceId, protocol: 1 });
          else for (const fn of session.wake) fn();
        });
        return session;
      })();
      sessions.set(id, pending);
      pending.catch(() => { if (sessions.get(id) === pending) sessions.delete(id); });
    }
    const session = await pending;
    session.touched = Date.now();
    return session;
  };
  // A view that vanishes without cleanup must not leave its selection as the active view.
  const sweep = setInterval(() => {
    for (const [id, pending] of sessions) void pending.then((session) => {
      if (Date.now() - session.touched > 15_000 && sessions.get(id) === pending) { sessions.delete(id); session.transport.close(); }
    }, () => {});
  }, 5000);
  sweep.unref();
  const session = z.string().uuid();
  server.registerTool("_screens_call", { description: "Canvas service request or upload chunk.", _meta: meta,
    inputSchema: { session, kind: z.enum(["connect", "request", "post", "chunk", "close"]), message: z.record(z.string(), z.unknown()).optional(), hash: z.string().optional(), size: z.number().int().optional(), offset: z.number().int().optional(), bytes: z.string().optional() } }, async (a) => {
    if (a.kind === "close") {
      const pending = sessions.get(a.session);
      sessions.delete(a.session);
      if (pending) (await pending).transport.close();
      return result(null);
    }
    const s = await getSession(a.session), t = s.transport;
    if (a.kind === "connect") return result({ sessionId: t.sessionId, since: s.sequence });
    if (a.kind === "chunk") {
      if (!a.hash || a.size === undefined || a.offset === undefined || a.bytes === undefined || a.bytes.length > 1400000) throw new Error("Invalid upload chunk");
      return result(await t.sendChunk(a.hash, a.size, a.offset, new Uint8Array(Buffer.from(a.bytes, "base64"))));
    }
    const m = a.message;
    if (!m || typeof m.t !== "string") throw new Error("Invalid canvas message");
    if (a.kind === "post") { if (!posts.has(m.t)) throw new Error("Canvas message is not allowed"); t.post(m as unknown as ClientMessage); return result(null); }
    if (!allowed.has(m.t)) throw new Error("Canvas request is not allowed");
    const value = await t.request(m as unknown as RequestBody);
    if (m.t === "open" && value && typeof value === "object") {
      const { frameOrigin: _origin, frameCapability: _capability, ...rest } = value as Record<string, unknown>;
      return result({ ...rest, frameOrigin: "", frameCapability: "" });
    }
    return result(value);
  });
  server.registerTool("_screens_events", { description: "Wait for canvas events after a cursor.", _meta: meta, inputSchema: { session, since: z.number().int().nonnegative() } }, async ({ session: id, since }) => {
    const s = await getSession(id);
    if (s.sequence <= since) await new Promise<void>((resolve) => { const done = () => { clearTimeout(timer); s.wake.delete(done); resolve(); }; const timer = setTimeout(done, 1000); s.wake.add(done); });
    return result({ connected: s.up, sessionId: s.transport.sessionId, since: s.sequence, reset: since > s.sequence || (s.events.length > 0 && since < s.events[0]!.seq - 1), events: s.events.filter((e) => e.seq > since) });
  });
  server.registerTool("_screens_content", { description: "Read content bytes as base64.", _meta: meta, inputSchema: { session, hash: z.string().regex(/^[a-f0-9]{64}$/) } }, async ({ session: id, hash }) => {
    const s = await getSession(id);
    return result(await s.transport.request({ t: "readContent", hash }));
  });
}

/** Ordinary resources are versioned; an explicitly enabled benchmark rereads its config and source on every refresh. */
export const APP_URI = process.env.SCREENS_OPENING_CONFIG ? "ui://screens/canvas-opening-bench.html" : `ui://screens/canvas-${bundle?.version ?? "dev"}.html`;

export function registerAppResource(server: McpServer): void {
  server.registerResource("screens-canvas", APP_URI, { title: "Screens", mimeType: "text/html;profile=mcp-app" }, async () => {
    // A checkout's dev service gets the read-only test hook, as its browser canvas does. The published package never has it.
    const reg = await ensureService();
    const openingConfig = readOpeningConfig();
    const { js, css } = await canvasAssets({ testHook: openingConfig ? false : !bundle && !!reg.dev });
    const opening = openingConfig ? openingConfigScript(openingConfig, js, { host: openingConfig.host === "app-relay-control" ? "app-relay-control" : "screens-app", resourceUri: APP_URI, serviceInstanceId: reg.instanceId,
      adapterIdentity: { name: bundle?.name ?? "screens-worktree", version: bundle?.version ?? "source", source: bundle ? "release" : "worktree", sha256: crypto.createHash("sha256").update(fs.readFileSync(fileURLToPath(import.meta.url))).digest("hex") } }) : "";
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Screens</title><style>${css.replace(/<\/style/gi, "<\\/style")}</style><script>window.__SCREENS_APP__=true;${opening}</script></head><body><div id="root"></div><script type="module">${js.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
    return { contents: [{ uri: APP_URI, mimeType: "text/html;profile=mcp-app", text: html,
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: false }, "openai/ui": { availableDisplayModes: ["fullscreen"], preferredDisplayMode: "fullscreen" } } }] };
  });
}
