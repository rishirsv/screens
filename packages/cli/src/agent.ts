// The agent side: a client of the real stdio MCP adapter. It knows no tool by name. Commands, arguments and
// validation all come from the adapter's tools/list, so a new MCP tool is a CLI command the moment it exists.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ArgValue } from "./script.ts";
import type { Aliases } from "./state.ts";
import { authoredKey, inspectResult, resultScanControls, ResultLeakError } from "./result-scan.ts";
import { FIXTURES, fileArg } from "./fixtures.ts";

interface JsonSchema { readonly type?: string | readonly string[]; readonly properties?: Record<string, JsonSchema>; readonly required?: readonly string[]; readonly items?: JsonSchema }
export interface ToolInfo { readonly name: string; readonly summary: string; readonly required: readonly string[]; readonly optional: readonly string[]; readonly schema: JsonSchema }
/** Image content the tool returned, such as a snapshot's poster. Never printed: the driver saves it as evidence. */
export interface AgentImage { readonly mimeType: string; readonly bytes: Buffer }
/** screenId: the Screen the call named, after handles and the current Screen were filled in. */
export interface AgentResult { readonly value: Record<string, unknown>; readonly isError: boolean; readonly opId: string | null; readonly screenId: string | null; readonly images: readonly AgentImage[] }

export interface AgentPort {
  readonly tools: ReadonlyMap<string, ToolInfo>;
  audit(): { readonly scanned: number; readonly tools: readonly string[]; readonly leaks: number; readonly controls: Readonly<Record<string, boolean>> };
  /** Expands args, resolves handles, fills screenId, assigns and journals an opId for mutations, reads structuredContent. */
  /** outDir: the session folder `out:` and `fixture-file:` paths live in. */
  call(tool: string, args: Readonly<Record<string, ArgValue>>, o: { readonly aliases: Aliases; readonly screenId: string | null; readonly cwd: string; readonly outDir: string; readonly journal: (e: object) => void; readonly ownedText?: readonly string[]; readonly dispatched?: () => void }): Promise<AgentResult>;
  /** Kills and respawns the adapter process, as an agent host does when it restarts the MCP server. */
  restart(): Promise<void>;
  close(): Promise<void>;
}

const MCP_MAIN = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../mcp/src/main.ts");

export async function connectAgent(home: string): Promise<AgentPort> {
  let client = await start(home);
  let tools = await list(client);
  const audited = new Set<string>(); let scanned = 0;
  const canary = "SCREENS_UNRELATED_FILE_CANARY_41c921";
  fs.writeFileSync(path.join(home, "unrelated-secret.txt"), canary);
  const authored = new Set<string>();
  const rememberAuthored = (value: unknown): void => {
    if (typeof value === "string") authored.add(authoredKey(value));
    else if (Array.isArray(value)) for (const v of value) rememberAuthored(v);
    else if (value && typeof value === "object") for (const [key, v] of Object.entries(value)) if (key !== "path") rememberAuthored(v);
  };
  const scan = (name: string, r: unknown, args: Record<string, unknown>) => {
    inspectResult(r, { privateStrings: [home, canary], authored,
      callerPath: typeof args.path === "string" && tools.get(name)?.schema.properties?.path ? path.resolve(args.path) : undefined });
    audited.add(name); scanned++;
    fs.appendFileSync(path.join(home, "result-audit.ndjson"), JSON.stringify({ tool: name, scanned: true }) + "\n");
  };

  const callOnce = async (name: string, args: Record<string, unknown>, dispatched?: () => void) => {
    const pending = client.callTool({ name, arguments: args });
    dispatched?.();
    const r = await pending;
    scan(name, r, args);
    const sc = r.structuredContent as Record<string, unknown> | undefined;
    const content = (r.content as { type: string; text?: string; data?: string; mimeType?: string }[] | undefined) ?? [];
    const text = content.find((c) => c.type === "text")?.text ?? "";
    const images = content.filter((c) => c.type === "image" && c.data).map((c) => ({ mimeType: c.mimeType ?? "application/octet-stream", bytes: Buffer.from(c.data!, "base64") }));
    let value: Record<string, unknown> = sc ?? {};
    if (!sc) { try { const p = JSON.parse(text); value = p && typeof p === "object" && !Array.isArray(p) ? p : { result: p }; } catch { value = { message: text }; } }
    return { value, isError: r.isError === true, images };
  };

  return {
    get tools() { return tools; },
    audit: () => ({ scanned, tools: [...audited].sort(), leaks: 0, controls: resultScanControls() }),
    async call(name, raw, o) {
      const info = tools.get(name);
      if (!info) throw new Error(`unknown command or tool "${name}" (see \`screens-cli tools\` and \`screens-cli help\`)`);
      const props = info.schema.properties ?? {};
      const args: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(raw)) {
        if (!(k in props)) throw new Error(`${name} has no argument "${k}" (takes ${[...info.required.map((r) => r + "*"), ...info.optional].join(" ")})`);
        args[k] = await expand(v, props[k]!, o.aliases, o.cwd, o.outDir);
      }
      if ("screenId" in props && args.screenId === undefined && o.screenId) args.screenId = o.screenId;
      let opId: string | null = null;
      // A mutation takes an optional opId; op_status takes a required one and is a read.
      if ("opId" in props && !info.required.includes("opId")) {
        if (args.opId === undefined) args.opId = `cli-${crypto.randomUUID()}`;
        opId = String(args.opId);
      }
      for (const r of info.required) if (args[r] === undefined) throw new Error(`${name} needs ${r}`);
      rememberAuthored(args);
      for (const text of o.ownedText ?? []) authored.add(authoredKey(text));
      o.journal({ at: Date.now(), tool: name, opId, screenId: args.screenId ?? null });
      const screenId = typeof args.screenId === "string" ? args.screenId : null;
      try { return { ...(await callOnce(name, args, o.dispatched)), opId, screenId }; }
      catch (e) {
        if (e instanceof ResultLeakError) throw e;
        // The adapter or its connection died mid-call. Never resend under a new ID: ask what happened.
        if (!opId) throw e;
        client = await start(home); tools = await list(client);
        const s = await callOnce("op_status", { opId });
        if (s.value.status === "committed") return { value: { ...s.value, opId, recovered: true }, isError: false, opId, screenId, images: [] };
        throw Object.assign(new Error(`indeterminate: the call was lost and op_status says ${String(s.value.status)}`), { indeterminate: true });
      }
    },
    async restart() { await client.close().catch(() => {}); client = await start(home); tools = await list(client); },
    close: () => client.close(),
  };
}

async function start(home: string): Promise<Client> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [MCP_MAIN], env: { ...process.env, SCREENS_HOME: home } as Record<string, string>, stderr: "ignore" });
  const client = new Client({ name: "screens-cli", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

async function list(client: Client): Promise<Map<string, ToolInfo>> {
  const r = await client.listTools();
  return new Map(r.tools.filter((t) => {
    const visibility = (t._meta?.ui as { visibility?: string[] } | undefined)?.visibility;
    return !visibility || visibility.includes("model");
  }).map((t) => {
    const schema = t.inputSchema as JsonSchema;
    const required = schema.required ?? [];
    const optional = Object.keys(schema.properties ?? {}).filter((k) => !required.includes(k));
    return [t.name, { name: t.name, summary: (t.description ?? "").split(". ")[0]!, required, optional, schema }];
  }));
}

/** Lists the adapter's tools without a session. tools/list never starts the service. */
export async function listToolsOnce(): Promise<ToolInfo[]> {
  const home = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "screens-cli-tools-"));
  const c = await start(home);
  try { return [...(await list(c)).values()]; } finally { await c.close(); fs.rmSync(home, { recursive: true, force: true }); }
}

const typeOf = (s: JsonSchema) => (Array.isArray(s.type) ? s.type[0] : s.type) as string | undefined;

async function expand(v: ArgValue, schema: JsonSchema, a: Aliases, cwd: string, outDir: string): Promise<unknown> {
  if (v.kind === "expand") {
    if (v.how === "out") { fs.mkdirSync(outDir, { recursive: true }); return path.join(outDir, v.path); }
    if (v.how === "fixture-file") return fileArg(`fixture:${v.path}`, outDir, cwd);
    if (v.how === "fixture") { const f = FIXTURES[v.path]; if (!f) throw new Error(`no fixture "${v.path}" (fixtures: ${Object.keys(FIXTURES).join(" ")})`); return f(); }
    // b64:fixture:NAME and file:fixture:NAME read a file fixture.
    const p = fileArg(v.path, outDir, cwd);
    if (v.how === "file") return fs.readFileSync(p, "utf8");
    if (v.how === "b64") return fs.readFileSync(p).toString("base64");
    return readBundle(p);
  }
  const t = typeOf(schema);
  if (t === "string") return /^@[\w-]+$/.test(v.raw) ? a.resolve({ kind: "ref", name: v.raw.slice(1) }) : v.raw;
  // JSON values may carry @handles: quote and resolve them before parsing.
  const json = v.raw.replace(/"@([\w-]+)"/g, (m, n: string) => { const id = a.tryResolve(n); return id ? JSON.stringify(id) : m; })
    .replace(/(^|[\s,[{:])@([\w-]+)/g, (_m, pre: string, n: string) => `${pre}${JSON.stringify(a.resolve({ kind: "ref", name: n }))}`);
  try { return JSON.parse(json); }
  catch {
    if (t === "array") return v.raw.split(",").filter(Boolean).map((x) => (x.startsWith("@") ? a.resolve({ kind: "ref", name: x.slice(1) }) : x));
    return v.raw;
  }
}

/** A directory as an MCP bundle. Refuses paths that leave it. */
function readBundle(root: string): { path: string; content: string; encoding: "utf8" | "base64" }[] {
  if (fs.lstatSync(root).isSymbolicLink()) throw Object.assign(new Error("Bundle symlinks are not allowed"), { code: "bundle-path" });
  const real = fs.realpathSync(root);
  const out: { path: string; content: string; encoding: "utf8" | "base64" }[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) throw Object.assign(new Error("Bundle symlinks are not allowed"), { code: "bundle-path" });
      const r = fs.realpathSync(full);
      if (r !== real && !r.startsWith(real + path.sep)) throw Object.assign(new Error("Bundle symlinks are not allowed"), { code: "bundle-path" });
      if (fs.statSync(r).isDirectory()) { walk(full); continue; }
      const bytes = fs.readFileSync(r), rel = path.relative(root, full).split(path.sep).join("/");
      const textual = /\.(html?|css|m?js|json|svg|txt|md)$/i.test(e.name);
      out.push({ path: rel, content: textual ? bytes.toString("utf8") : bytes.toString("base64"), encoding: textual ? "utf8" : "base64" });
    }
  };
  walk(root);
  return out;
}
