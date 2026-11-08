// Dev-only MCP Apps host. Relays postMessage tools/call to a real stdio adapter.
import { verifyFrameMessages } from "./frame-messages.ts";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Browser } from "playwright-core";
import type { Service } from "@screens/client";
import { FILE_FIXTURES, FIXTURES } from "./fixtures.ts";

export async function verifyBridge(browser: Browser, home: string, screenId: string, service: Service, secret: string, origins: readonly string[], messagesOnly = false): Promise<Record<string, unknown>> {
  const adapter = new Client({ name: "screens-bridge-host", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve("packages/mcp/src/main.ts"), "--host", "codex"], env: { ...process.env, SCREENS_HOME: home } as Record<string, string>, stderr: "ignore" });
  await adapter.connect(transport);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const requests: string[] = [];
  let uploadChunks = 0;
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("request", (req) => { if (origins.some((o) => req.url().startsWith(o)) || /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::|\/)/i.test(req.url())) requests.push(req.url()); });
  const tool = async (name: string, args: Record<string, unknown>) => {
    const r = await adapter.callTool({ name, arguments: args });
    if (r.isError) throw new Error(`Tool ${name}: ${JSON.stringify(r.content)}`);
    return r;
  };
  try {
    // Both Codex entrypoints open the adapter's own ui:// resource with empty arguments.
    const opener = (await adapter.listTools()).tools.find((t) => t.name === "open_screen") as { _meta?: Record<string, any> } | undefined;
    const uri = opener?._meta?.ui?.resourceUri as string | undefined;
    const entries = opener?._meta?.["openai/ui"]?.entrypoints;
    if (!uri || !Array.isArray(entries) || !["global", "thread"].every((type) => entries.some((entry) => entry.type === type))) throw new Error("open_screen must expose global and thread MCP App entrypoints");
    const empty = await tool("open_screen", {});
    if ((empty.structuredContent as { screenId?: unknown } | undefined)?.screenId !== null) throw new Error("open_screen with empty arguments must open the library");
    const resource = (await adapter.readResource({ uri })).contents[0] as { text?: string; mimeType?: string; _meta?: Record<string, any> };
    if (resource?.mimeType !== "text/html;profile=mcp-app" || !resource.text || !resource._meta?.ui?.csp) throw new Error("the canvas resource is not an MCP App page with a CSP");
    const app = resource.text;
    await tool("open_screen", { screenId });
    await page.exposeBinding("__appTool", async (_source, name: string, args: Record<string, unknown>) => {
      if (name === "_screens_call" && args.kind === "chunk") uploadChunks++;
      if (!["_screens_call", "_screens_events", "_screens_content"].includes(name)) throw new Error("unexpected app tool");
      const answer = await adapter.callTool({ name, arguments: args });
      if (answer.isError) errors.push(`${name}: ${JSON.stringify(answer.content)}`);
      return answer;
    });
    const host = `<!doctype html><html><head><style>html,body,iframe{margin:0;width:100%;height:100%;border:0}</style></head><body><iframe id="app"></iframe><script>
const app=document.getElementById('app');app.srcdoc=${JSON.stringify(app).replace(/</g, "\\u003c")};
addEventListener('message',async(e)=>{if(e.source!==app.contentWindow||!e.data||e.data.jsonrpc!=='2.0')return;const m=e.data;if(m.method==='ui/notifications/initialized'){e.source.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-input',params:{arguments:{screenId:${JSON.stringify(screenId)}}}},'*');return;}if(m.id===undefined||!m.method)return;
try{let result;if(m.method==='ui/initialize')result={protocolVersion:'2026-01-26',hostCapabilities:{},hostInfo:{name:'screens-cli',version:'1'}};else if(m.method==='tools/call')result=await __appTool(m.params.name,m.params.arguments);else throw Error('unsupported method');e.source.postMessage({jsonrpc:'2.0',id:m.id,result},'*');}catch(err){e.source.postMessage({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:String(err)}},'*');}});
</script></body></html>`;
    await page.route("https://screens.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: host }));
    await page.goto(`https://screens.test/s/${screenId}`);
    await page.waitForFunction(() => document.querySelector("iframe")?.contentWindow?.document.querySelector("#root"));
    const appFrame = page.frames().find((f) => f !== page.mainFrame())!;
    await appFrame.waitForFunction(() => !!(window as any).__screensTest, null, { timeout: 15000 });
    if (messagesOnly) return await verifyFrameMessages(appFrame, service, screenId, secret);
    const added = await tool("add_object", { screenId, title: "Bridge probe", x: 0, y: 0, width: 400, height: 300, files: [{ path: "index.html", content: "<!doctype html><html><head><link rel='stylesheet' href='./style.css'></head><body><p data-pid='title'>Before</p><p id='probe'>waiting</p><script>fetch('https://blocked.invalid/').then(()=>probe.textContent='loaded',()=>probe.textContent='blocked')</script></body></html>" }, { path: "style.css", content: "body{background:rgb(1,2,3)}" }] });
    const id = (added.structuredContent as { itemId: string }).itemId;
    if (!id) throw new Error("add_object did not return an item ID");
    await appFrame.locator(`[data-item="${id}"]`).waitFor({ timeout: 15000 });
    await appFrame.locator(`[data-item="${id}"][data-load="ready"]`).waitFor({ timeout: 15000 });
    const snap = appFrame.locator(`[data-item="${id}"] iframe`);
    if (await snap.getAttribute("sandbox") !== "allow-scripts") throw new Error("snapshot sandbox is not allow-scripts only");
    await snap.contentFrame().locator("#probe").filter({ hasText: "blocked" }).waitFor({ timeout: 10000 });
    // A srcdoc document never enters quirks mode, so the CSP meta before the doctype keeps the validator's layout rules.
    const mode = await snap.contentFrame().locator("body").evaluate(() => document.compatMode);
    if (mode !== "CSS1Compat") throw new Error(`the snapshot frame renders in ${mode}, not standards mode`);
    await snap.contentFrame().locator("body").evaluate((body) => { if (getComputedStyle(body).backgroundColor !== "rgb(1, 2, 3)") throw new Error("inlined stylesheet did not load"); });
    await tool("edit_object", { screenId, itemId: id, edits: [{ at: "title", text: "After" }] });
    await snap.contentFrame().locator('[data-pid="title"]').filter({ hasText: "After" }).waitFor({ timeout: 15000 });
    // Annotations are Screens UI inside the app resource, with every edit relayed through app-only tools.
    if (await appFrame.locator(".screens-comments-panel").count()) throw new Error("comments panel did not start hidden");
    const note = (await tool("add_comment", { screenId, itemId: id, x: 40, y: 40, text: "Review this spacing" })).structuredContent as { threadId: string };
    await appFrame.locator(`.screens-pin[data-thread="${note.threadId}"]`).click();
    await appFrame.getByRole("textbox", { name: "Reply", exact: true }).fill("Bridge reply");
    await appFrame.getByRole("textbox", { name: "Reply", exact: true }).press("Enter");
    await appFrame.locator(".comment-body").filter({ hasText: "Bridge reply" }).waitFor();
    await appFrame.getByRole("button", { name: "Edit comment", exact: true }).click();
    await appFrame.getByRole("textbox", { name: "Edit comment", exact: true }).fill("Edited through app");
    await appFrame.getByRole("button", { name: "Save comment", exact: true }).click();
    await appFrame.waitForFunction(() => (window as any).__screensTest.probe(["pending"]).pending.size === 0);
    const savedNote = (await service.read(screenId)).threads[note.threadId];
    if (savedNote?.comments[1]?.text !== "Edited through app" || savedNote.comments[1].author.kind !== "person") throw new Error("annotation edit did not commit through the app relay");
    await appFrame.getByRole("button", { name: "Close", exact: true }).click();
    if (await appFrame.locator(".screens-comments-panel").count()) throw new Error("opening a thread forced the index open");
    const box = await appFrame.locator(`[data-item="${id}"] .frame-title`).boundingBox();
    if (!box) throw new Error("frame title is not visible");
    await service.fault(secret, { kind: "delay-commit", ms: 1500, count: 1 });
    const before = await service.read(screenId);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2, { steps: 6 }); await page.mouse.up();
    await appFrame.waitForFunction(() => ((window as any).__screensTest.probe(["pending"]).pending.size > 0), null, { timeout: 5000 });
    if ((await service.read(screenId)).revision !== before.revision) throw new Error("pending drag committed before the check");
    await appFrame.waitForFunction(() => ((window as any).__screensTest.probe(["pending"]).pending.size === 0), null, { timeout: 10000 });
    const after = await service.read(screenId);
    if (after.revision <= before.revision || after.items[id]?.x === before.items[id]?.x) throw new Error("drag did not commit");
    let view: any;
    for (let i = 0; i < 30; i++) { view = (await tool("get_view", { screenId })).structuredContent; if (view?.view?.selection?.includes(id)) break; await new Promise((r) => setTimeout(r, 100)); }
    if (!view?.view?.selection?.includes(id)) throw new Error("get_view did not report bridge selection");
    const open = (await tool("get_view", {})).structuredContent as { screenId?: string };
    if (open.screenId !== screenId) throw new Error(`get_view without screenId named ${open.screenId}, not the open Screen`);
    const viewSession = view.view.sessionId as string;
    await service.fault(secret, { kind: "disconnect", sessionId: viewSession });
    let restored = false, disconnected = false;
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const current = await service.readContext(screenId);
      if (current.view?.sessionId !== viewSession) disconnected = true;
      if (disconnected && current.view?.sessionId === viewSession && current.view.selection.includes(id)) { restored = true; break; }
    }
    if (!restored) throw new Error("bridge selection was not restored after reconnect");
    for (const [name, args] of [["show_items", { screenId, itemIds: [id] }], ["focus_item", { screenId, itemId: id }]] as const) {
      await tool(name, args);
    }
    await appFrame.waitForFunction((itemId) => (window as any).__screensTest.probe(["view"]).view.focus === `focused:${itemId}`, id, { timeout: 8000 });
    await tool("focus_item", { screenId });
    await appFrame.waitForFunction(() => (window as any).__screensTest.probe(["view"]).view.focus === "none", null, { timeout: 8000 });
    const file = path.join(home, "bridge-upload.png");
    fs.writeFileSync(file, FILE_FIXTURES["noise-a"]!.bytes());
    const cdp = await context.newCDPSession(page);
    const data = { items: [], files: [file], dragOperationsMask: 1 };
    for (const [type, x] of [["dragEnter", 1], ["dragOver", 400], ["drop", 700]] as const) await cdp.send("Input.dispatchDragEvent", { type, x, y: 600, data });
    for (let i = 0; i < 150; i++) { if (Object.values((await service.read(screenId)).items).some((item) => item.kind === "reference-image")) break; await new Promise((r) => setTimeout(r, 100)); }
    const image = Object.values((await service.read(screenId)).items).find((item) => item.kind === "reference-image");
    if (!image || uploadChunks < 2) throw new Error(`image drop did not commit through multiple chunks (${uploadChunks})`);
    await appFrame.waitForFunction((itemId) => {
      const img = document.querySelector<HTMLImageElement>(`[data-item="${itemId}"] img`);
      return !!img && img.naturalWidth > 0 && img.currentSrc.startsWith("data:");
    }, image.id, { timeout: 10000 });
    // A browser tab on another Screen of this library does not redirect the Codex view lookup.
    const other = (await tool("create_screen", { title: "Browser tab" })).structuredContent as { id: string };
    const registry = JSON.parse(fs.readFileSync(path.join(home, "service.json"), "utf8")) as { canvasOrigin: string };
    const tab = await context.newPage();
    await tab.goto(`${registry.canvasOrigin}/s/${other.id}`);
    for (let i = 0; i < 100 && !(await service.views()).some((v) => v.screenId === other.id && !v.app); i++) await new Promise((r) => setTimeout(r, 100));
    if (!(await service.views()).some((v) => v.screenId === other.id && !v.app)) throw new Error("the browser tab never reported its view");
    const scoped = (await tool("get_view", {})).structuredContent as { screenId?: string };
    if (scoped.screenId !== screenId) throw new Error(`get_view without screenId followed a browser tab to ${scoped.screenId}, not the Codex view`);
    // A browser tab on the same Screen keeps its own view: the Codex view's entry survives the tab's newer one.
    await tab.goto(`${registry.canvasOrigin}/s/${screenId}`);
    for (let i = 0; i < 100 && !(await service.views()).some((v) => v.screenId === screenId && !v.app); i++) await new Promise((r) => setTimeout(r, 100));
    const same = (await tool("get_view", {})).structuredContent as { screenId?: string; view?: { sessionId?: string } };
    if (same.screenId !== screenId || same.view?.sessionId !== viewSession) throw new Error(`with a browser tab on the same Screen, get_view read ${same.screenId}/${same.view?.sessionId}, not the Codex view ${viewSession}`);
    await tab.close();
    // A draft streamed in parts closer together than half a second still shows progress before it commits.
    await tool("set_status", { screenId, name: "Streamer", text: "Writing a draft", new: true });
    let draftShown = 0;
    for (let part = 1; part <= 8; part++) {
      await tool("add_object", { screenId, title: "Streamed", name: "Streamer", more: true, files: [{ path: "index.html", content: `<p>part ${part}</p>` }] });
      await new Promise((r) => setTimeout(r, 200));
      draftShown = Math.max(draftShown, Number(await appFrame.locator('[data-presence-draft="Streamer"]').getAttribute("data-draft-shown", { timeout: 2000 }).catch(() => "0")));
    }
    if (draftShown < 3) throw new Error(`a streamed draft stayed on part ${draftShown} while parts kept arriving`);
    await tool("add_object", { screenId, title: "Streamed", name: "Streamer", files: [{ path: "index.html", content: "<p>done</p>" }] });
    // The MCP App's direct srcdoc frame must hand an unscrollable wheel back to the focused canvas too.
    const wheel = (await tool("add_object", { screenId, title: "Wheel handoff", x: 2000, y: 0, width: 600, height: 3000, files: FIXTURES["wheel-hidden-root"]!() })).structuredContent as { itemId: string };
    await tool("focus_item", { screenId, itemId: wheel.itemId });
    await appFrame.waitForFunction((id) => {
      const view = (window as any).__screensTest.probe(["view"]).view;
      return view.focus === `focused:${id}` && view.camera.z === 1 && view.camera.y === 48 && document.querySelector(`[data-item="${id}"][data-load="ready"] iframe`);
    }, wheel.itemId, { timeout: 10000 });
    const wheelBox = await appFrame.locator(`[data-item="${wheel.itemId}"] iframe`).boundingBox();
    if (!wheelBox) throw new Error("the focused wheel frame is not visible");
    await page.mouse.move(wheelBox.x + 100, wheelBox.y + 200);
    await page.mouse.wheel(0, 300);
    await appFrame.waitForFunction((id) => {
      const view = (window as any).__screensTest.probe(["view"]).view;
      return view.focus === `focused:${id}` && view.camera.y === -252 && !view.moving;
    }, wheel.itemId, { timeout: 5000 });
    // Library links in the srcdoc view navigate in place, and a page without a stored poster gets its cover through the relay.
    const deck = (await tool("create_screen", { title: "Bridge deck", layout: "slides" })).structuredContent as { id: string };
    const slide = (await tool("add_object", { screenId: deck.id, title: "Slide", files: [{ path: "index.html", content: "<!doctype html><html><body style='margin:0;background:rgb(200,40,40)'><h1 data-pid='t'>Deck</h1></body></html>" }] })).structuredContent as { itemId: string };
    await tool("edit_object", { screenId: deck.id, itemId: slide.itemId, edits: [{ at: "t", text: "Deck cover" }] });
    if (((await service.read(deck.id)).items[slide.itemId] as { posterHash?: string | null } | undefined)?.posterHash !== null) throw new Error("the slide still has a stored poster; the cover would not be on demand");
    await appFrame.locator('a[aria-label="Library"]').click();
    let left: { screenId?: string | null } = {};
    for (let i = 0; i < 30; i++) { left = (await tool("get_view", {})).structuredContent as typeof left; if (left.screenId !== screenId) break; await new Promise((r) => setTimeout(r, 100)); }
    if (left.screenId === screenId) throw new Error("get_view still finds the Screen open after the view went back to the library");
    await appFrame.locator('a[aria-label="Presentations"]').click();
    await appFrame.locator('a[aria-label="Presentations"][aria-current]:not([aria-current="false"])').waitFor({ timeout: 8000 });
    if (!appFrame.url().startsWith("about:srcdoc")) throw new Error(`a library link navigated the view away to ${appFrame.url()}`);
    // open_screen naming a Screen, then naming none, moves an open view to that Screen and back to the library.
    const input = (args: Record<string, unknown>) => page.evaluate((a) => document.querySelector("iframe")!.contentWindow!.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: a } }, "*"), args);
    await input({ screenId });
    await appFrame.locator('a[aria-label="Library"]').waitFor({ timeout: 8000 });
    await tool("open_screen", {});
    await input({});
    await appFrame.locator('a[aria-label="All"][aria-current]:not([aria-current="false"])').waitFor({ timeout: 8000 });
    await appFrame.locator('a[aria-label="Presentations"]').click();
    await appFrame.waitForFunction((id) => [...document.querySelectorAll<HTMLImageElement>(`[data-tile="${id}"] .screens-thumb img`)].some((img) => img.currentSrc.startsWith("data:") && img.naturalWidth > 0), deck.id, { timeout: 15000 });
    await page.evaluate(() => new Promise<void>((resolve, reject) => {
      const frame = document.querySelector("iframe")!;
      const timer = setTimeout(() => reject(new Error("teardown was not acknowledged")), 5000);
      const on = (e: MessageEvent) => { if (e.source === frame.contentWindow && e.data?.id === "teardown-check" && e.data.result) { clearTimeout(timer); removeEventListener("message", on); resolve(); } };
      addEventListener("message", on);
      frame.contentWindow!.postMessage({ jsonrpc: "2.0", id: "teardown-check", method: "ui/resource-teardown", params: { reason: "test" } }, "*");
    }));
    for (let i = 0; i < 30; i++) { if (!(await service.inspect(secret)).conns.some((c) => c.sessionId === viewSession)) break; await new Promise((r) => setTimeout(r, 100)); }
    if ((await service.inspect(secret)).conns.some((c) => c.sessionId === viewSession)) throw new Error("teardown left the canvas connected");
    if (requests.length) throw new Error(`page requested local origins: ${requests.join(", ")}`);
    return { annotations: true, focusedWheel: true, standardsMode: true, browserTabIgnored: true, libraryInput: true, draftProgress: true, leftScreen: true, libraryLinks: true, onDemandCover: true, resource: true, opened: true, viewScreen: true, live: true, pending: true, revision: after.revision, selection: true, reconnect: true, teardown: true, sandbox: "allow-scripts", fetch: "blocked", assets: true, uploadChunks, localRequests: requests.length };
  } catch (e) {
    const frame = page.frames().find((f) => f !== page.mainFrame());
    const images = await frame?.evaluate(() => [...document.querySelectorAll("[data-item]")].map((el) => { const img = el.querySelector("img"); return { id: el.getAttribute("data-item"), width: img?.naturalWidth, src: img?.currentSrc.slice(0, 30) }; })).catch(() => null);
    await page.screenshot({ path: path.join(home, "..", "evidence", "bridge-host.png") }).catch(() => {});
    throw new Error(`${(e as Error).message}; images: ${JSON.stringify(images)}; page errors: ${errors.join(" | ")}`);
  } finally { await context.close(); await adapter.close(); }
}
