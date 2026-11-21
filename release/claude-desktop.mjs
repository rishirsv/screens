// Register the interactive server on Claude Desktop's own MCP connection.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const desktopDirectory = process.platform === "darwin" ? path.join(os.homedir(), "Library/Application Support/Claude")
  : process.platform === "win32" ? path.join(process.env.APPDATA ?? os.homedir(), "Claude")
  : path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "Claude");

export function installDesktopWidget(market, configFile = path.join(desktopDirectory, "claude_desktop_config.json")) {
  const plugin = JSON.parse(fs.readFileSync(path.join(market, "screens/.mcp.json"), "utf8")).mcpServers.screens;
  const args = plugin.args.filter(arg => arg !== "--browser-fallback");
  const config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, "utf8")) : {};
  const servers = config.mcpServers ??= {};
  const existing = servers.screens;
  if (existing && JSON.stringify(existing.args) !== JSON.stringify(args) && !existing.args?.some(arg => typeof arg === "string" && (arg.startsWith("@rishirsv/screens@") ||
    (path.dirname(arg) === path.join(market, "packages") && /^rishirsv-screens-[\d.]+\.tgz$/.test(path.basename(arg)))))) {
    throw new Error("Claude Desktop already has a different server named screens. Its configuration was preserved.");
  }
  // GUI apps may start without the shell PATH used to install Node and npx.
  const searchPath = new Set([path.dirname(process.execPath), ...(existing?.env?.PATH ?? process.env.PATH ?? "").split(path.delimiter).filter(Boolean)]);
  const entry = { ...existing, command: plugin.command, args,
    env: { ...existing?.env, PATH: [...searchPath].join(path.delimiter) } };
  if (JSON.stringify(existing) === JSON.stringify(entry)) return;
  servers.screens = entry;
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  const temp = configFile + "." + randomUUID();
  try {
    fs.writeFileSync(temp, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    fs.renameSync(temp, configFile);
  } finally { fs.rmSync(temp, { force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  installDesktopWidget(path.join(os.homedir(), ".local/share/screens/marketplace"));
  console.log("Screens registered in Claude Desktop. Restart Claude Desktop to load it.");
}
