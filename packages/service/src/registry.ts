// Per-user registry: how clients find (or start) the one local service.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "@screens/protocol";
import { bundle } from "./bundle.ts";

export interface Registry { pid: number; instanceId: string; protocol: number; token: string; canvasOrigin: string; frameOrigin: string; startedAt: string; dev?: boolean }

export const defaultHome = (): string => path.join(os.homedir(), ".screens");
export const screensHome = (): string => (process.env.SCREENS_HOME ? path.resolve(process.env.SCREENS_HOME) : defaultHome());
export const registryPath = (): string => path.join(screensHome(), "service.json");

export function readRegistry(): Registry | null {
  try { return JSON.parse(fs.readFileSync(registryPath(), "utf8")) as Registry; } catch { return null; }
}

/** A registry is live only if its process exists and its port answers with the same instance ID. */
export async function liveRegistry(): Promise<Registry | null> {
  const r = readRegistry();
  if (!r || r.protocol !== PROTOCOL_VERSION) return null;
  try { process.kill(r.pid, 0); } catch { return null; }
  const h = await fetch(`${r.canvasOrigin}/health`, { signal: AbortSignal.timeout(1500) }).then((x) => x.json() as Promise<{ instanceId?: string; protocol?: number }>).catch(() => null);
  return h?.instanceId === r.instanceId && h.protocol === PROTOCOL_VERSION ? r : null;
}

/** Finds the running service or starts one detached, then waits until it is ready. */
export async function ensureService(): Promise<Registry> {
  const live = await liveRegistry();
  if (live) return live;
  // The published package starts its own bundled service; a checkout starts the source CLI.
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), bundle ? "service.js" : "cli.ts");
  fs.mkdirSync(screensHome(), { recursive: true });
  const log = fs.openSync(path.join(screensHome(), "service.log"), "a");
  spawn(process.execPath, [cli, "serve", "--idle-exit"], { detached: true, stdio: ["ignore", log, log], env: process.env }).unref();
  fs.closeSync(log);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    const r = await liveRegistry();
    if (r) return r;
  }
  throw new Error("The Screens service did not start. Check its local service log.");
}
