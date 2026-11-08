// Hosts one Driver for a session on a loopback port, guarded by a per-session token. Runs one request at a time.
// Started by `screens-cli up`; exits on `down` or after 30 idle minutes, stopping its service.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { BlockedError, Driver, type SessionSpec, type StepResult } from "./driver.ts";
import type { Block } from "./script.ts";

const IDLE_MS = 30 * 60_000;
const dir = process.argv[2];
if (!dir) { console.error("usage: daemon.ts SESSION_DIR"); process.exit(2); }
const spec = JSON.parse(fs.readFileSync(path.join(dir, "spec.json"), "utf8")) as SessionSpec;
const status = (o: object) => fs.writeFileSync(path.join(dir, "daemon.json"), JSON.stringify({ pid: process.pid, ...o }, null, 1), { mode: 0o600 });

let driver: Driver;
try { driver = await Driver.start(spec); }
catch (e) { status({ state: "failed", blocked: e instanceof BlockedError, error: (e as Error).message }); process.exit(e instanceof BlockedError ? 3 : 1); }

const token = crypto.randomBytes(24).toString("hex");
let queue: Promise<unknown> = Promise.resolve();
let last = Date.now();
const serial = <T>(fn: () => Promise<T>) => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };

const server = http.createServer((req, res) => {
  last = Date.now();
  if (req.headers["x-screens-cli"] !== token) { res.statusCode = 401; res.end(); return; }
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    if (req.url === "/ping") { res.end("ok"); return; }
    if (req.url === "/stop") { res.end("ok"); void serial(async () => { await driver.close(); fs.rmSync(path.join(dir, "daemon.json"), { force: true }); process.exit(0); }); return; }
    if (req.url !== "/run") { res.statusCode = 404; res.end(); return; }
    const r = JSON.parse(body) as { blocks: Block[]; bail: boolean; freshScreen: boolean };
    res.setHeader("content-type", "application/x-ndjson");
    void serial(async () => {
      const emit = (x: StepResult) => res.write(JSON.stringify(x) + "\n");
      try { const ok = await driver.run(r.blocks, { bail: r.bail, freshScreen: r.freshScreen }, emit); res.end(JSON.stringify({ done: true, ok }) + "\n"); }
      catch (e) { res.end(JSON.stringify({ done: true, ok: false, error: (e as Error).message }) + "\n"); }
      last = Date.now();
    });
  });
});
server.listen(0, "127.0.0.1", () => status({ state: "ready", port: (server.address() as { port: number }).port, token, canvas: `http://127.0.0.1:${spec.ports.canvas}` }));
setInterval(() => { if (Date.now() - last > IDLE_MS) void serial(async () => { await driver.close(); fs.rmSync(path.join(dir, "daemon.json"), { force: true }); process.exit(0); }); }, 60_000).unref();
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => void driver.close().finally(() => process.exit(0)));
