// Development control: real app resource and stdio relay in a synthetic host, never a native Codex host measurement.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Browser, BrowserContext } from "playwright-core";

export async function runOpeningAppControl(browser: Browser, home: string, configFile: string, out: string): Promise<{ errors: string[]; localRequests: string[]; resourceUri: string }> {
  const errors: string[] = [], localRequests: string[] = [];
  let resourceUri = "", context: BrowserContext | undefined;
  const adapter = new Client({ name: "screens-opening-app-relay-control", version: "1" });
  const output = path.resolve(out, "app-result.json");
  const env: NodeJS.ProcessEnv = { ...process.env, SCREENS_HOME: path.resolve(home), SCREENS_OPENING_CONFIG: path.resolve(configFile), SCREENS_OPENING_OUT: output };
  delete env.SCREENS_DEV;
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../../mcp/src/main.ts", import.meta.url)), "--host", "codex"], env: env as Record<string, string>, stderr: "ignore" });
  try {
    const config = JSON.parse(fs.readFileSync(configFile, "utf8")) as { host?: string; runId?: string; cases?: unknown[]; reps?: number };
    if (config.host !== "app-relay-control" || !config.runId || !config.cases?.length || config.reps !== 7) throw new Error("App relay control requires its own labeled opening configuration");
    if (fs.existsSync(output)) throw new Error("Collect and remove the previous app-result.json before running another control");
    await adapter.connect(transport);
    context = await browser.newContext({ viewport: { width: 1559, height: 1029 }, reducedMotion: "reduce" });
    context.on("request", (request) => {
      const url = new URL(request.url());
      if (/^https?:$/.test(url.protocol) && /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(url.hostname)) localRequests.push(request.url());
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    const opener = (await adapter.listTools()).tools.find((tool) => tool.name === "open_screen");
    const uri = (opener?._meta as { ui?: { resourceUri?: unknown } } | undefined)?.ui?.resourceUri;
    if (typeof uri !== "string") throw new Error("open_screen did not advertise an app resource");
    resourceUri = uri;
    const opened = await adapter.callTool({ name: "open_screen", arguments: {} });
    if (opened.isError || (opened.structuredContent as { screenId?: unknown } | undefined)?.screenId !== null) throw new Error("Opening control did not open the library");
    const resource = (await adapter.readResource({ uri })).contents[0];
    const csp = (resource?._meta as { ui?: { csp?: { connectDomains?: unknown; resourceDomains?: unknown } } } | undefined)?.ui?.csp;
    if (!resource || !("text" in resource) || resource.mimeType !== "text/html;profile=mcp-app"
      || !Array.isArray(csp?.connectDomains) || csp.connectDomains.length || !Array.isArray(csp.resourceDomains) || csp.resourceDomains.length) throw new Error("Opening control requires the real offline MCP App resource");
    const allowed = new Set(["_screens_call", "_screens_events", "_screens_content", "_screens_opening_trace"]);
    await page.exposeBinding("__openingAppTool", async (_source, name: string, args: Record<string, unknown>) => {
      if (!allowed.has(name)) throw new Error(`Unexpected app tool: ${name}`);
      const answer = await adapter.callTool({ name, arguments: args });
      if (answer.isError) errors.push(`${name}: ${JSON.stringify(answer.content)}`);
      return answer;
    });
    const host = `<!doctype html><html><head><style>html,body,iframe{margin:0;width:100%;height:100%;border:0}</style></head><body><iframe id="app"></iframe><script>
const app=document.getElementById('app');app.srcdoc=${JSON.stringify(resource.text).replace(/</g, "\\u003c")};
addEventListener('message',async(e)=>{if(e.source!==app.contentWindow||!e.data||e.data.jsonrpc!=='2.0')return;const m=e.data;if(m.method==='ui/notifications/initialized'){e.source.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-input',params:{arguments:{}}},'*');return;}if(m.id===undefined||!m.method)return;
try{let result;if(m.method==='ui/initialize')result={protocolVersion:'2026-01-26',hostCapabilities:{},hostInfo:{name:'screens-app-relay-control',version:'1'}};else if(m.method==='tools/call')result=await __openingAppTool(m.params.name,m.params.arguments);else throw Error('unsupported method');e.source.postMessage({jsonrpc:'2.0',id:m.id,result},'*');}catch(err){e.source.postMessage({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:String(err)}},'*');}});
</script></body></html>`;
    await context.route("**/*", async (route) => {
      if (route.request().url() === "https://screens.test/") await route.fulfill({ status: 200, contentType: "text/html", body: host });
      else if (route.request().url() === "https://screens.test/favicon.ico") await route.fulfill({ status: 204 });
      else { errors.push(`Unexpected network request: ${route.request().url()}`); await route.abort(); }
    });
    await page.goto("https://screens.test/");
    const app = page.frameLocator("#app");
    await app.getByRole("button", { name: "Start opening benchmark", exact: true }).click();
    const expected = config.cases.length * config.reps;
    const status = app.getByRole("status").filter({ hasText: /openings recorded|Opening benchmark failed:/ });
    await status.waitFor({ state: "visible", timeout: expected * 31_000 + 30_000 });
    const text = await status.textContent();
    if (text !== `${expected} openings recorded`) throw new Error(text ?? "Opening benchmark did not report completion");
    const saved = JSON.parse(fs.readFileSync(output, "utf8")) as { runId?: string; host?: string };
    if (saved.runId !== config.runId || saved.host !== "app-relay-control") throw new Error("App relay result identity did not match this run");
    if (localRequests.length) errors.push(`App relay attempted ${localRequests.length} loopback HTTP requests`);
  } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  finally {
    try { await context?.close(); } catch (error) { errors.push(`Context cleanup: ${String(error)}`); }
    try { await adapter.close(); } catch (error) { errors.push(`Adapter cleanup: ${String(error)}`); }
  }
  return { errors, localRequests, resourceUri };
}
