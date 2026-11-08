import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(repo, "release/out");
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const expected = read(path.join(repo, "release/package.json"));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "screens-release-"));
const home = path.join(temp, "library");
const env = { ...process.env, SCREENS_HOME: home };
delete env.NODE_PATH;
delete env.SCREENS_DEV;
const run = (cmd, args, cwd = temp) => execFileSync(cmd, args, { cwd, env, encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
const installed = path.join(temp, "node_modules", expected.name);
const bin = path.join(installed, "screens.js");
const cli = (...args) => run(process.execPath, [bin, ...args]).trim();
const clients = new Set();
const browser = process.argv.includes("--browser");

async function connect(host) {
  const client = new Client({ name: "screens-release-check", version: "1.0.0" });
  clients.add(client);
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [bin, "mcp", "--host", host], cwd: temp, env, stderr: "pipe" }));
  const tools = await client.listTools();
  assert(tools.tools.some((t) => t.name === "create_screen"), `${host}: missing tools`);
  const guide = await client.callTool({ name: "get_guide", arguments: { topic: "screens-instructions" } });
  assert(!guide.isError && guide.content.some((c) => c.type === "text" && c.text.length > 100), `${host}: missing guide`);
  return { client, tools: tools.tools };
}

async function tool(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert(!result.isError, `${name}: ${JSON.stringify(result.structuredContent)}`);
  assert(result.structuredContent, `${name}: missing structured result`);
  return result.structuredContent;
}

try {
  assert(fs.existsSync(path.join(out, "mcp.js")), "Run npm run release:build first");
  const [packed] = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", temp], out));
  const files = packed.files.map((f) => f.path);
  for (const file of ["LICENSE", "THIRD_PARTY_NOTICES", "README.md", "screens.js", "mcp.js", "service.js", "sidebar.svg", "ui/app.js", "ui/tokens.css", "ui/components.css", "ui/app.css"])
    assert(files.includes(file), `Tarball missing ${file}`);
  assert(!files.some((f) => /(?:^|\/)(?:src|\.verify|\.agents|\.screens-dev)(?:\/|$)|\.(?:ts|tsx|map)$/.test(f)), "Tarball contains development files");
  fs.writeFileSync(path.join(temp, "package.json"), JSON.stringify({ private: true }));
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", path.join(temp, packed.filename)]);
  const manifest = read(path.join(installed, "package.json"));
  assert.equal(manifest.name, expected.name);
  assert.equal(manifest.version, expected.version);
  assert.equal(manifest.license, "MIT");
  assert.equal(fs.readFileSync(path.join(installed, "LICENSE"), "utf8"), fs.readFileSync(path.join(repo, "LICENSE"), "utf8"));
  const app = fs.readFileSync(path.join(installed, "ui/app.js"), "utf8");
  assert(!/Object\.defineProperty\(window,\s*["']__screensTest["']/.test(app), "Production canvas installs the test hook");

  const url = cli("url");
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(cli("doctor"), /^healthy /);
  const registry = read(path.join(home, "service.json"));
  assert(!registry.dev, "Installed service is in dev mode");
  const html = await fetch(url).then((r) => { assert(r.ok); return r.text(); });
  assert(html.includes("/app.js"), "Canvas entry does not load its script");
  const assets = [...html.matchAll(/(?:src|href)="(\/[^"#]+)"/g)].map((m) => m[1]);
  assert(assets.length > 1, "Canvas entry is missing its assets");
  for (const asset of assets)
    assert((await fetch(`${url}${asset}`)).ok, `Canvas asset ${asset} is unreachable`);

  const { client: codex, tools } = await connect("codex");
  const resource = tools.find((t) => t.name === "open_screen")?._meta?.ui?.resourceUri;
  assert.equal(resource, `ui://screens/canvas-${expected.version}.html`);
  const view = await codex.readResource({ uri: resource });
  assert(view.contents.some((c) => typeof c.text === "string" && c.text.includes("<html")), "Codex canvas resource is missing");
  const created = await tool(codex, "create_screen", { title: "Packed release check" });
  await tool(codex, "open_screen", { screenId: created.id });
  if (browser) {
    const added = await tool(codex, "add_object", {
      screenId: created.id, title: "Preview", width: 320, height: 240,
      files: [{ path: "index.html", content: '<!doctype html><html><body><h1>Packed preview</h1></body></html>' }],
    });
    assert.equal(added.status, "committed");
    assert(added.poster, "Installed package did not render a poster");
    assert.deepEqual(added.warnings, [], "Installed preview reported warnings");
  }
  const before = await tool(codex, "get_screen", { screenId: created.id });
  assert.equal(before.title, "Packed release check");
  for (const client of clients) await client.close();
  clients.clear();
  cli("stop");
  const deadline = Date.now() + 5000;
  while (await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) }).then((r) => r.ok).catch(() => false)) {
    assert(Date.now() < deadline, "Service did not stop");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const { client: claude } = await connect("claude");
  const after = await tool(claude, "get_screen", { screenId: created.id });
  assert.deepEqual(after, before, "Screen did not survive the service restart");

  for (const local of [false, true]) {
    const market = path.join(temp, local ? "local-market" : "registry-market");
    run(process.execPath, [path.join(repo, "release/plugins.mjs"), "--marketplace", market, ...(local ? ["--package", path.join(temp, packed.filename)] : [])]);
    const plugin = path.join(market, "screens");
    assert.equal(read(path.join(plugin, "plugin.json")).version, expected.version);
    for (const [file, host] of [["mcp.json", "codex"], [".mcp.json", "claude"]]) {
      const server = read(path.join(plugin, file)).mcpServers.screens;
      assert.equal(server.command, "npx");
      assert.deepEqual(server.args.slice(-3), ["mcp", "--host", host]);
      assert(server.args.includes(local ? path.join(temp, packed.filename) : `${expected.name}@${expected.version}`));
    }
    assert(fs.existsSync(path.join(plugin, "assets/screens-icon.svg")));
    assert.equal(read(path.join(market, ".claude-plugin/marketplace.json")).plugins[0].version, expected.version);
    assert.equal(read(path.join(market, ".agents/plugins/marketplace.json")).plugins[0].name, "screens");
  }
  console.log(`ok ${expected.name}@${expected.version}: packed install, assets, MCP hosts, persistence, plugin overlays${browser ? ", poster" : ""}`);
} finally {
  for (const client of clients) await client.close().catch(() => {});
  if (fs.existsSync(bin)) {
    try { cli("stop"); } catch {}
  }
  fs.rmSync(temp, { recursive: true, force: true });
}
