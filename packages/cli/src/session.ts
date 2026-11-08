// Session folders under .verify/sessions/<name>/ and the daemon that owns each one.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { defaultHome } from "@screens/service";
import type { SessionSpec, StepResult } from "./driver.ts";
import type { Block } from "./script.ts";

export const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const ROOT = path.join(REPO, ".verify", "sessions");
const DAEMON = path.join(path.dirname(new URL(import.meta.url).pathname), "daemon.ts");

export interface Daemon { readonly pid: number; readonly state: "ready" | "failed"; readonly port?: number; readonly token?: string; readonly canvas?: string; readonly error?: string; readonly blocked?: boolean }
export interface UpOptions { readonly headed: boolean; readonly motion: boolean; readonly viewport: { width: number; height: number }; readonly browser: string; readonly theme: "light" | "dark" }

export const sessionDir = (name: string) => path.join(ROOT, name);
const readJson = <T>(f: string): T | null => { try { return JSON.parse(fs.readFileSync(f, "utf8")) as T; } catch { return null; } };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

export async function daemonOf(name: string): Promise<Daemon | null> {
  const d = readJson<Daemon>(path.join(sessionDir(name), "daemon.json"));
  if (!d || d.state !== "ready" || !alive(d.pid)) return null;
  const ok = await fetch(`http://127.0.0.1:${d.port}/ping`, { headers: { "x-screens-cli": d.token! }, signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
  return ok ? d : null;
}

const freePort = () => new Promise<number>((resolve, reject) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); s.on("error", reject); });

/** Idempotent: reuses a live session, repairs a dead one on the same home and ports. */
export async function up(name: string, o: UpOptions): Promise<{ daemon: Daemon; reused: boolean; ms: number }> {
  const t0 = Date.now();
  const live = await daemonOf(name);
  if (live) return { daemon: live, reused: true, ms: Date.now() - t0 };
  const dir = sessionDir(name), home = path.join(dir, "home");
  if (path.resolve(home) === path.resolve(defaultHome())) throw new Error("refusing to drive the default Screens home");
  fs.mkdirSync(home, { recursive: true });
  const prior = readJson<SessionSpec>(path.join(dir, "spec.json"));
  const spec: SessionSpec = { name, dir, home, ports: prior?.ports ?? { canvas: await freePort(), frame: await freePort() }, ...o };
  fs.writeFileSync(path.join(dir, "spec.json"), JSON.stringify(spec, null, 1));
  fs.rmSync(path.join(dir, "daemon.json"), { force: true });
  const log = fs.openSync(path.join(dir, "driver.log"), "a");
  const child = spawn(process.execPath, [DAEMON, dir], { detached: true, stdio: ["ignore", log, log], cwd: process.cwd(), env: process.env });
  child.unref(); fs.closeSync(log);
  const end = Date.now() + 90_000;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 100));
    const d = readJson<Daemon>(path.join(dir, "daemon.json"));
    if (d?.state === "failed") throw Object.assign(new Error(d.error ?? "the driver failed to start"), { blocked: d.blocked });
    if (d?.state === "ready") return { daemon: d, reused: false, ms: Date.now() - t0 };
    if (!alive(child.pid!)) throw new Error(`the driver exited; see ${path.relative(process.cwd(), path.join(dir, "driver.log"))}`);
  }
  throw new Error("the driver did not become ready in 90 s");
}

export async function down(name: string): Promise<boolean> {
  const d = await daemonOf(name);
  if (!d) return false;
  await fetch(`http://127.0.0.1:${d.port}/stop`, { method: "POST", headers: { "x-screens-cli": d.token! } }).catch(() => {});
  const end = Date.now() + 20_000;
  while (alive(d.pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  return true;
}

export function sessions(): string[] { try { return fs.readdirSync(ROOT).filter((n) => fs.existsSync(path.join(ROOT, n, "spec.json"))); } catch { return []; } }

/** Sends blocks to a session's driver and streams each step result. */
export async function send(d: Daemon, blocks: readonly Block[], o: { bail: boolean; freshScreen: boolean }, onResult: (r: StepResult) => void): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`http://127.0.0.1:${d.port}/run`, { method: "POST", headers: { "x-screens-cli": d.token!, "content-type": "application/json" }, body: JSON.stringify({ blocks, ...o }) });
  if (!res.ok || !res.body) throw new Error(`driver refused the request (${res.status})`);
  let buf = "", final: { ok: boolean; error?: string } = { ok: false, error: "the driver stopped mid-run" };
  const dec = new TextDecoder();
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line) continue;
      const m = JSON.parse(line) as StepResult | { done: true; ok: boolean; error?: string };
      if ("done" in m) final = m; else onResult(m);
    }
  }
  return final;
}
