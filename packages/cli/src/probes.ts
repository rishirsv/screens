// Dev-only process probes. Each uses real adapters, sockets and child services in an isolated home.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { WebSocket, WebSocketServer } from "ws";
import { connectLocalService, type Service } from "@screens/client";
import { PROTOCOL_VERSION } from "@screens/protocol";
import type { Registry } from "@screens/service";
import { connectAgent, type AgentPort } from "./agent.ts";
import { Aliases } from "./state.ts";

const CLI = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../service/src/cli.ts");
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(fn: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error("process probe timed out"); await delay(25); }
}
function registry(home: string): Registry | null { try { return JSON.parse(fs.readFileSync(path.join(home, "service.json"), "utf8")) as Registry; } catch { return null; } }
async function listen(server: http.Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => resolve((server.address() as { port: number }).port)); });
}

/** Oversized frames are refused by the receiver before parsing or domain authorization. */
export async function probeSocketLimits(reg: Registry): Promise<{ readonly unauthenticated: number; readonly authenticated: number }> {
  const oversized = (authenticated: boolean) => new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(reg.canvasOrigin.replace(/^http/, "ws") + "/ws");
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("oversized-frame connection did not close")); }, 5000);
    ws.on("error", (error) => { clearTimeout(timer); reject(error); });
    ws.on("close", (code) => { clearTimeout(timer); resolve(code); });
    const sendOversized = () => ws.send(authenticated ? Buffer.alloc(4_000_001) : " ".repeat(4_000_001));
    ws.on("open", () => {
      if (authenticated) ws.send(JSON.stringify({ t: "hello", protocol: PROTOCOL_VERSION, token: reg.token, role: "canvas" }));
      else sendOversized();
    });
    ws.on("message", (raw) => { if (JSON.parse(String(raw)).t === "welcome") sendOversized(); });
  });
  return { unauthenticated: await oversized(false), authenticated: await oversized(true) };
}

export async function probeLifecycle(suite: "discovery" | "identity" | "idle" | "port", dir: string, tool?: string): Promise<Record<string, unknown>> {
  const home = path.join(dir, `${suite}-${Date.now()}`); fs.mkdirSync(home, { recursive: true });
  const agents: AgentPort[] = [], clients: Service[] = [], servers: http.Server[] = [];
  let pid = 0;
  const start = async (args: string[]) => {
    const log = fs.openSync(path.join(home, "service.log"), "a");
    const child = spawn(process.execPath, [CLI, "serve", ...args], { env: { ...process.env, SCREENS_HOME: home }, stdio: ["ignore", log, log] });
    fs.closeSync(log); pid = child.pid!;
    await until(() => registry(home) !== null);
    return registry(home)!;
  };
  const connect = async (r: Registry) => {
    const c = await connectLocalService({ origin: r.canvasOrigin, token: r.token, instanceId: r.instanceId, role: "agent" }); clients.push(c); return c;
  };
  try {
    if (suite === "discovery") {
      if (!tool) throw new Error("probe discovery needs tool= (a read tool with no required arguments)");
      agents.push(...await Promise.all([connectAgent(home), connectAgent(home)]));
      const args = { aliases: new Aliases(), screenId: null, cwd: process.cwd(), outDir: path.join(home, "out"), journal: () => {} };
      const results = await Promise.all(agents.map((a) => a.call(tool, {}, args)));
      if (results.some((r) => r.isError)) throw new Error("a discovery tool failed");
      const r = registry(home)!; pid = r.pid;
      const c = await connect(r);
      // A third client is this observer; the two others must be the real MCP adapters, on this very instance.
      // Production services have no inspect endpoint, so compare the clients' effects using registry and health,
      // then restart neither adapter and call them again. Only one service can own this home.
      const first = r.instanceId;
      await Promise.all(agents.map((a) => a.call(tool, {}, args)));
      const health = await fetch(`${r.canvasOrigin}/health`).then((x) => x.json()) as { instanceId: string };
      return { adapters: results.length, oneService: registry(home)?.pid === pid && registry(home)?.instanceId === first && health.instanceId === first && c.connected,
        starts: fs.readFileSync(path.join(home, "service.log"), "utf8").split("screens ready ").length - 1 };
    }
    if (suite === "identity") {
      const server = http.createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ instanceId: "unrelated", protocol: 1 })); }); servers.push(server);
      const port = await listen(server), origin = `http://127.0.0.1:${port}`;
      const wss = new WebSocketServer({ server });
      let used = 0, hellos = 0;
      let welcome = { instanceId: "unrelated", protocol: 99 };
      wss.on("connection", (ws) => ws.on("message", (raw) => {
        const m = JSON.parse(String(raw)) as { t: string };
        if (m.t === "hello") { hellos++; ws.send(JSON.stringify({ t: "welcome", ...welcome, sessionId: "probe-client" })); }
        else used++;
      }));
      const fake: Registry = { pid: process.pid, token: "0".repeat(48), protocol: 1, instanceId: "expected", canvasOrigin: origin, frameOrigin: origin, startedAt: new Date().toISOString() };
      fs.writeFileSync(path.join(home, "service.json"), JSON.stringify(fake));
      // Use the real registry client in a separate process, since SCREENS_HOME is process scoped.
      const script = `import { liveRegistry } from ${JSON.stringify(path.resolve(path.dirname(CLI), "registry.ts"))}; console.log(JSON.stringify({ refused: await liveRegistry() === null }));`;
      const registryCheck = await new Promise<boolean>((resolve, reject) => {
        const p = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, SCREENS_HOME: home } }); let out = "";
        p.stdout.on("data", (b: Buffer) => out += b); p.on("error", reject); p.on("exit", (code) => resolve(code === 0 && out.includes('"refused":true')));
      });
      const handshake = await connectLocalService({ origin, token: fake.token, instanceId: fake.instanceId, role: "agent" }).then((c) => { c.close(); return false; }, () => true);
      welcome = { instanceId: "unrelated", protocol: 1 };
      const instance = await connectLocalService({ origin, token: fake.token, instanceId: fake.instanceId, role: "agent" }).then((c) => { c.close(); return false; }, () => true);
      welcome = { instanceId: fake.instanceId, protocol: 99 };
      const protocol = await connectLocalService({ origin, token: fake.token, instanceId: fake.instanceId, role: "agent" }).then((c) => { c.close(); return false; }, () => true);
      welcome = { instanceId: fake.instanceId, protocol: 1 };
      const valid = await connectLocalService({ origin, token: fake.token, instanceId: fake.instanceId, role: "agent" }).then((c) => { c.close(); return true; }, () => false);
      wss.close();
      return { registryRefused: registryCheck, handshakeRefused: handshake, instanceRefused: instance, protocolRefused: protocol, validAccepted: valid, requestsSent: used, hellos };
    }
    if (suite === "idle") {
      const r = await start(["--dev", "--idle-exit", "--idle-ms", "800", "--canvas-port", "0", "--frame-port", "0"]);
      const a = await connect(r), b = await connect(r);
      a.close(); await delay(1900);
      const keptAlive = alive(pid) && b.connected && (await b.listScreens()).length === 0;
      b.close(); await until(() => !alive(pid), 10_000);
      return { keptAlive, exitedWhenIdle: !alive(pid), registryRemoved: registry(home) === null };
    }
    // Hold the actual preferred port. If another service already owns it, it already supplies the occupied precondition.
    const server = http.createServer((_req, res) => res.end("unrelated process")); servers.push(server);
    let occupied = false;
    try { await listen(server, 4980); occupied = true; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e; occupied = true; }
    const r = await start(["--dev", "--frame-port", "0"]);
    const c = await connect(r);
    return { occupied, newPort: new URL(r.canvasOrigin).port !== "4980", recordedPortWorks: c.connected && (await c.listScreens()).length === 0 };
  } finally {
    for (const c of clients) c.close();
    for (const a of agents) await a.close();
    // An unrelated-process registry deliberately points at us; never signal that PID.
    if (suite !== "identity") {
      pid ||= registry(home)?.pid ?? 0;
      if (pid && alive(pid)) { process.kill(pid, "SIGTERM"); await until(() => !alive(pid)).catch(() => { if (alive(pid)) process.kill(pid, "SIGKILL"); }); }
    }
    for (const s of servers) { s.closeAllConnections(); s.close(); }
  }
}
