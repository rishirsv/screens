// Stages the installable plugin from plugins/screens into a local marketplace for both hosts, with each host's overlay:
//   Claude: .claude-plugin/plugin.json and .mcp.json running the pinned package with --host claude.
//   Codex:  plugin.json and mcp.json, the portable files, running it with --host codex.
// Usage: node release/plugins.mjs [--marketplace DIR] [--package SPEC]
//   --package overrides the npm spec the servers run, e.g. a local tarball before it is published.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, "../plugins/screens");
const arg = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : undefined; };
const root = path.resolve(arg("--marketplace") ?? path.join(os.homedir(), ".local/share/screens/marketplace"));
const pkg = JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(source, "plugin.json"), "utf8"));
const portable = JSON.parse(fs.readFileSync(path.join(source, "mcp.json"), "utf8"));

const pinned = `${pkg.name}@${pkg.version}`;
const server = portable.mcpServers.screens;
if (manifest.version !== pkg.version || !server.args.includes(pinned)) throw Error(`plugins/screens must pin ${pinned} (plugin.json version and mcp.json args)`);
// A local tarball or folder is written as an absolute path: the host starts the server from its own directory.
const given = arg("--package");
const spec = given === undefined ? pinned : /^(\.{1,2}\/|\/|~)|\.tgz$/.test(given) ? path.resolve(given.replace(/^~(?=\/)/, os.homedir())) : given;
// npx runs a tarball or folder through --package; a registry spec runs directly.
const run = (host) => spec === pinned ? ["-y", pinned, "mcp", "--host", host] : ["-y", "--package", spec, "screens", "mcp", "--host", host];

const stage = path.join(root, `.screens-${process.pid}`);
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
fs.cpSync(source, stage, { recursive: true });
const write = (rel, value) => { fs.mkdirSync(path.dirname(path.join(stage, rel)), { recursive: true }); fs.writeFileSync(path.join(stage, rel), JSON.stringify(value, null, 2) + "\n"); };
write("mcp.json", { ...portable, mcpServers: { screens: { ...server, args: run("codex") } } });
write(".mcp.json", { mcpServers: { screens: { command: server.command, args: run("claude") } } });
write(".claude-plugin/plugin.json", { name: manifest.name, version: manifest.version, description: manifest.description, author: manifest.author });

const dest = path.join(root, "screens");
const prior = path.join(root, `.screens-previous-${process.pid}`);
if (fs.existsSync(dest)) fs.renameSync(dest, prior);
fs.renameSync(stage, dest);
fs.rmSync(prior, { recursive: true, force: true });

const market = path.join(root, ".claude-plugin/marketplace.json");
fs.mkdirSync(path.dirname(market), { recursive: true });
fs.writeFileSync(market, JSON.stringify({
  name: "screens-local", owner: { name: manifest.author.name }, description: "Screens, installed from a local release.",
  plugins: [{ name: "screens", source: "./screens", description: manifest.description, version: manifest.version }],
}, null, 2) + "\n");
const codexMarket = path.join(root, ".agents/plugins/marketplace.json");
fs.mkdirSync(path.dirname(codexMarket), { recursive: true });
fs.writeFileSync(codexMarket, JSON.stringify({
  name: "screens-local", interface: { displayName: "Screens" },
  plugins: [{ name: "screens", source: { source: "local", path: "./screens" }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" }],
}, null, 2) + "\n");
console.log(JSON.stringify({ marketplace: root, plugin: dest, version: manifest.version, runs: spec }));
