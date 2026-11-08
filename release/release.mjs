// One release: set the version, build and pack the package, publish it when asked, stage the plugin and install it into
// Claude and Codex, then confirm both report the new version. A failed install leaves the previous plugin in place.
// Usage: node release/release.mjs [--version X.Y.Z] [--publish] [--install] [--marketplace DIR]
//   Without --publish the plugin runs the packed tarball, so a release can be tried before it reaches npm.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const has = (flag) => process.argv.includes(flag);
const arg = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : undefined; };
const run = (cmd, args, o = {}) => execFileSync(cmd, args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...o });
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");

const pkgFile = path.join(here, "package.json"), pluginFile = path.join(repo, "plugins/screens/plugin.json"), mcpFile = path.join(repo, "plugins/screens/mcp.json");
const version = arg("--version");
if (version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error(`--version must be X.Y.Z, got ${version}`);
  const pkg = json(pkgFile), plugin = json(pluginFile), mcp = json(mcpFile);
  pkg.version = version; plugin.version = version;
  mcp.mcpServers.screens.args = mcp.mcpServers.screens.args.map((a) => (a.startsWith(`${pkg.name}@`) ? `${pkg.name}@${version}` : a));
  save(pkgFile, pkg); save(pluginFile, plugin); save(mcpFile, mcp);
}
const { name, version: current } = json(pkgFile);

run(process.execPath, [path.join(here, "build.mjs")], { stdio: "inherit" });
run(process.execPath, [path.join(here, "verify.mjs")], { stdio: "inherit" });
const tarball = path.join(here, "out", run("npm", ["pack", "--silent", "--pack-destination", path.join(here, "out")], { cwd: path.join(here, "out") }).trim().split("\n").pop());
if (has("--publish")) run("npm", ["publish", "--access", "public"], { cwd: path.join(here, "out"), stdio: "inherit" });

// An unpublished release runs a tarball kept beside the marketplace, which outlives the next build of release/out.
const market = path.resolve(arg("--marketplace") ?? path.join(os.homedir(), ".local/share/screens/marketplace"));
const kept = path.join(market, "packages", path.basename(tarball));
if (!has("--publish")) { fs.mkdirSync(path.dirname(kept), { recursive: true }); fs.copyFileSync(tarball, kept); }
const staged = JSON.parse(run(process.execPath, [path.join(here, "plugins.mjs"), "--marketplace", market, ...(has("--publish") ? [] : ["--package", kept])]));
console.log(`${name}@${current}: ${has("--publish") ? "published" : `local ${kept}`}, staged in ${staged.marketplace}`);
if (!has("--install")) process.exit(0);

// Claude: add the local marketplace once, then install or update the plugin from it.
const claudeMarkets = JSON.parse(run("claude", ["plugin", "marketplace", "list", "--json"]));
if (!claudeMarkets.some((m) => m.name === "screens-local")) run("claude", ["plugin", "marketplace", "add", staged.marketplace, "--scope", "user"], { stdio: "inherit" });
else run("claude", ["plugin", "marketplace", "update", "screens-local"], { stdio: "inherit" });
// install does nothing for an installed plugin; a later release upgrades it with update.
const installed = JSON.parse(run("claude", ["plugin", "list", "--json"])).some((p) => p.id === "screens@screens-local");
run("claude", ["plugin", installed ? "update" : "install", "screens@screens-local", "--scope", "user"], { stdio: "inherit" });
const claude = JSON.parse(run("claude", ["plugin", "list", "--json"])).find((p) => p.id === "screens@screens-local");
if (claude?.version !== current) throw Error(`Claude reports Screens ${claude?.version ?? "missing"}, expected ${current}`);

// Codex: the same marketplace folder carries its own catalog.
const codexMarkets = JSON.parse(run("codex", ["plugin", "marketplace", "list", "--json"])).marketplaces ?? [];
if (!codexMarkets.some((m) => m.name === "screens-local")) run("codex", ["plugin", "marketplace", "add", staged.marketplace], { stdio: "inherit" });
const codex = JSON.parse(run("codex", ["plugin", "add", "screens@screens-local", "--json"]));
if (codex.version !== current) throw Error(`Codex installed Screens ${codex.version ?? "missing"}, expected ${current}`);
console.log(`installed Screens ${current} in Claude and Codex`);
