#!/usr/bin/env node
// screens-cli: drive Screens end to end for verification. Dev only, never shipped. See packages/cli/AGENTS.md.

import fs from "node:fs";
import path from "node:path";
import { listToolsOnce } from "./agent.ts";
import { check, FEATURES } from "./check.ts";
import type { StepResult } from "./driver.ts";
import { extractBlocks, quoteArgv, VERBS, type Block } from "./script.ts";
import { daemonOf, down, send, sessionDir, sessions, up, type UpOptions } from "./session.ts";
import { replayTrace, type TraceFile } from "../../canvas/src/engine/index.ts";

const EXIT = { ok: 0, failed: 1, usage: 2, blocked: 3, noSession: 4 } as const;

const argv = process.argv.slice(2);
let session = process.env.SCREENS_SESSION ?? "default", quiet = false, json = false;
const rest: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (rest.length === 0 && (a === "-s" || a === "--session")) { session = argv[++i] ?? "default"; continue; }
  if (rest.length === 0 && a === "-q") { quiet = true; continue; }
  if (rest.length === 0 && a === "--json") { json = true; continue; }
  rest.push(a);
}
const [cmd, ...args] = rest;
const flag = (f: string) => args.includes(`--${f}`);
const opt = (f: string) => { const i = args.indexOf(`--${f}`); return i >= 0 ? args[i + 1] : undefined; };

function upOptions(): UpOptions {
  const vp = (opt("viewport") ?? "1280x800").split("x").map(Number);
  return { headed: flag("headed"), motion: flag("motion"), viewport: { width: vp[0] ?? 1280, height: vp[1] ?? 800 }, theme: opt("theme") === "dark" ? "dark" : "light",
    browser: opt("browser") ?? process.env.SCREENS_BROWSER ?? (process.platform === "darwin" ? "chrome" : "chromium") };
}

function print(r: StepResult, numbered: boolean) {
  if (json) { console.log(JSON.stringify(r)); return; }
  const where = `${r.block && numbered ? r.block + " " : ""}${numbered && r.line ? `L${r.line} ` : ""}`;
  if (r.ok) { if (!quiet) console.log(`ok ${where}${r.text}`); return; }
  console.log(`FAIL ${where}${r.text}`);
  if (r.evidence.length) console.log(`  evidence ${r.evidence.join(" ")}`);
}

function help() {
  const groups: Record<string, string[]> = {};
  for (const [, v] of Object.entries(VERBS)) (groups[v.group] ??= []).push(`  ${v.summary}`);
  console.log(`screens-cli: drive Screens end to end (dev only)

  up [--headed] [--motion] [--viewport WxH] [--theme dark] [--browser chrome|chromium|PATH]
  down [--all] · ls · check · help
  run SCRIPT|FEATURE.md|DIR|- [--fresh] [--jobs N] [--id BLOCK] [--no-bail]
  <mcp_tool> key=value … [as=@A]      any MCP tool (see \`tools\`); values: JSON, @handles, file: b64: dir: fixture:

person:
${groups.person!.join("\n")}
state:
${groups.state!.join("\n")}
session:
${groups.session!.join("\n")}
evidence:
${groups.evidence!.join("\n")}

-s NAME session (default "default", or SCREENS_SESSION) · -q failures and summary only · --json JSONL
exit: 0 ok · 1 a step failed · 2 usage · 3 blocked (browser cannot launch) · 4 no session`);
}

function collect(src: string, id: string | undefined): Block[] {
  if (src === "-") return [{ id: "-", file: "-", line: 1, text: fs.readFileSync(0, "utf8"), attrs: {} }];
  const p = path.resolve(src);
  if (!fs.existsSync(p)) throw Object.assign(new Error(`no such file ${src}`), { usage: true });
  const files = fs.statSync(p).isDirectory() ? fs.readdirSync(p).filter((f) => f.endsWith(".md")).sort().map((f) => path.join(p, f)) : [p];
  const blocks = files.flatMap((f) => f.endsWith(".md") ? extractBlocks(fs.readFileSync(f, "utf8"), path.basename(f, ".md")).map((b) => ({ ...b, id: `${b.file}/${b.id}` })) : [{ id: "-", file: f, line: 1, text: fs.readFileSync(f, "utf8"), attrs: {} }]);
  return id ? blocks.filter((b) => b.id === id || b.id.endsWith(`/${id}`)) : blocks;
}

async function runBlocks(name: string, blocks: Block[], o: { bail: boolean; freshScreen: boolean }, numbered: boolean) {
  const d = await daemonOf(name);
  if (!d) { console.log(`FAIL no session "${name}" (screens-cli up${name !== "default" ? ` -s ${name}` : ""})`); return { ok: false, steps: 0, code: EXIT.noSession }; }
  let steps = 0, failed = 0;
  const r = await send(d, blocks, o, (x) => { steps++; if (!x.ok) failed++; print(x, numbered); }).catch((e: Error) => ({ ok: false, error: e.message }));
  if (r.error) console.log(`FAIL ${r.error}; see ${path.relative(process.cwd(), path.join(sessionDir(name), "driver.log"))}`);
  return { ok: r.ok && failed === 0, steps, failed, code: r.error ? EXIT.noSession : r.ok && failed === 0 ? EXIT.ok : EXIT.failed };
}

async function main(): Promise<number> {
  switch (cmd) {
    case undefined: case "help": case "--help": case "-h": help(); return EXIT.ok;
    case "up": {
      try {
        const r = await up(session, upOptions());
        console.log(`ok up ${session}${r.reused ? " reused" : ""} canvas ${r.daemon.canvas} ${(r.ms / 1000).toFixed(1)}s`);
        return EXIT.ok;
      } catch (e) { const err = e as Error & { blocked?: boolean }; console.log(`FAIL up: ${err.message}`); return err.blocked ? EXIT.blocked : EXIT.failed; }
    }
    case "down": {
      const names = flag("all") ? sessions() : [session];
      for (const n of names) console.log((await down(n)) ? `ok down ${n}` : `ok down ${n} (not running)`);
      return EXIT.ok;
    }
    case "ls": {
      for (const n of sessions()) { const d = await daemonOf(n); console.log(`${n} ${d ? `up ${d.canvas}` : "down"}`); }
      return EXIT.ok;
    }
    case "check": {
      const problems = await check();
      for (const p of problems) console.log(`FAIL ${p}`);
      if (!problems.length) console.log("ok check");
      return problems.length ? EXIT.failed : EXIT.ok;
    }
    case "engine": {
      if (args[0] !== "replay" || !args[1]) break;
      const r = replayTrace(JSON.parse(fs.readFileSync(args[1], "utf8")) as TraceFile);
      console.log(r.matches ? `ok replay ${r.inputs} inputs ${r.docs} doc epochs: final view matches the page` : `FAIL replay diverged in: ${r.mismatch}`);
      return r.matches ? EXIT.ok : EXIT.failed;
    }
    case "run": {
      const src = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--jobs" && args[i - 1] !== "--id") ?? "-";
      let blocks: Block[];
      try { blocks = collect(src, opt("id")); } catch (e) { console.log(`FAIL ${(e as Error).message}`); return EXIT.usage; }
      if (!blocks.length) { console.log(`FAIL no blocks in ${src}`); return EXIT.usage; }
      const feature = blocks.some((b) => b.id !== "-");
      const o = { bail: !flag("no-bail"), freshScreen: feature };
      const t0 = Date.now();
      if (!flag("fresh")) {
        const r = await runBlocks(session, blocks, o, true);
        console.log(`${r.ok ? "ok" : "FAIL"} ${r.steps} steps${r.failed ? `, ${r.failed} failed` : ""} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        return r.code;
      }
      const requested = Number(opt("jobs") ?? 1);
      if (!Number.isInteger(requested) || requested < 1) { console.log(`FAIL --jobs takes a positive integer, got ${opt("jobs")}`); return EXIT.usage; }
      const jobs = Math.min(requested, blocks.length);
      // Unique per invocation, so two fresh runs started together never share a session.
      const stamp = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
      const shares = Array.from({ length: jobs }, (_, k) => blocks.filter((_, i) => i % jobs === k));
      const results = await Promise.all(shares.map(async (share, k) => {
        const name = `run-${stamp}-${k + 1}`;
        try { await up(name, upOptions()); }
        catch (e) { const err = e as Error & { blocked?: boolean }; console.log(`FAIL up ${name}: ${err.message}`); return { ok: false, steps: 0, failed: 0, code: err.blocked ? EXIT.blocked : EXIT.failed }; }
        try { return await runBlocks(name, share, o, true); } finally { await down(name); }
      }));
      const steps = results.reduce((n, r) => n + r.steps, 0), failed = results.reduce((n, r) => n + (r.failed ?? 0), 0);
      let ok = results.every((r) => r.ok);
      const audited = new Set<string>(); let scans = 0;
      for (let k = 0; k < jobs; k++) {
        const file = path.join(sessionDir(`run-${stamp}-${k + 1}`), "home", "result-audit.ndjson");
        if (!fs.existsSync(file)) continue;
        for (const line of fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean)) {
          const r = JSON.parse(line) as { tool: string; scanned: boolean };
          if (r.scanned) { audited.add(r.tool); scans++; }
        }
      }
      if (path.resolve(src) === FEATURES && !opt("id")) {
        const missing = (await listToolsOnce()).filter((t) => !audited.has(t.name));
        if (missing.length) { ok = false; console.log(`FAIL result scan did not reach: ${missing.map((t) => t.name).join(" ")}`); }
      }
      console.log(`${ok ? "ok" : "FAIL"} ${blocks.length} blocks ${steps} steps${failed ? `, ${failed} failed` : ""}, ${scans} MCP results scanned across ${audited.size} tools ${((Date.now() - t0) / 1000).toFixed(1)}s evidence .verify/sessions/run-${stamp}-*`);
      return ok ? EXIT.ok : Math.max(EXIT.failed, ...results.map((r) => r.code));
    }
  }
  // Anything else is a one-line script for the session's driver.
  const r = await runBlocks(session, [{ id: "-", file: "-", line: 0, text: quoteArgv(rest), attrs: {} }], { bail: true, freshScreen: false }, false);
  return r.code;
}

main().then((code) => process.exit(code), (e) => { console.log(`FAIL ${(e as Error).message}`); process.exit(EXIT.failed); });
