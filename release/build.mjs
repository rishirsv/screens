// Builds the published package into release/out: the MCP adapter and service bundled for Node, the canvas prebuilt.
// Runtime dependencies stay external: playwright-core (posters) and ws. Run: node release/build.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { createRequire } from "node:module";
import { buildCanvas } from "../packages/service/src/server.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const out = path.join(here, "out");
const manifest = JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf8"));
const external = Object.keys(manifest.dependencies);
const licenses = new Set();
const require = createRequire(import.meta.url);

function collectLicenses(result) {
  for (const input of Object.keys(result.metafile.inputs)) {
    if (!input.includes("node_modules/")) continue;
    let dir = path.dirname(path.resolve(repo, input));
    while (dir !== path.dirname(dir)) {
      const pkg = path.join(dir, "package.json");
      if (fs.existsSync(pkg) && JSON.parse(fs.readFileSync(pkg, "utf8")).name) {
        const file = fs.readdirSync(dir).find((f) => /^licen[sc]e(?:\.(?:md|txt))?$/i.test(f));
        if (!file) throw Error(`Missing license for bundled dependency ${dir}`);
        licenses.add(path.join(dir, file));
        break;
      }
      dir = path.dirname(dir);
    }
  }
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "ui"), { recursive: true });

collectLicenses(await esbuild.build({
  entryPoints: { mcp: path.join(repo, "packages/mcp/src/main.ts"), service: path.join(repo, "packages/service/src/cli.ts") },
  outdir: out, bundle: true, platform: "node", format: "esm", target: "node24", external: [...external, "esbuild"], minify: true, logLevel: "warning", metafile: true,
  define: { __SCREENS_BUNDLE__: JSON.stringify({ name: manifest.name, version: manifest.version }) },
  // CommonJS dependencies inside an ES module bundle still call require.
  banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
}));
fs.writeFileSync(path.join(out, "ui/app.js"), await buildCanvas({ testHook: false }));
for (const pkg of ["react", "react-dom", "scheduler"]) licenses.add(path.join(path.dirname(require.resolve(`${pkg}/package.json`)), "LICENSE"));
const notices = [...licenses].sort().map((file) => `${path.relative(repo, path.dirname(file))}\n\n${fs.readFileSync(file, "utf8")}`).join("\n\n---\n\n");
fs.writeFileSync(path.join(out, "THIRD_PARTY_NOTICES"), `${fs.readFileSync(path.join(repo, "THIRD_PARTY_NOTICES"), "utf8")}\n\n---\n\n${notices}\n`);
fs.copyFileSync(path.join(repo, "LICENSE"), path.join(out, "LICENSE"));
for (const [from, to] of [["packages/ui/tokens.css", "tokens.css"], ["packages/ui/components.css", "components.css"], ["packages/canvas/src/shell/app.css", "app.css"]])
  fs.copyFileSync(path.join(repo, from), path.join(out, "ui", to));
for (const f of ["screens.js", "README.md", "package.json"]) fs.copyFileSync(path.join(here, f), path.join(out, f));
fs.copyFileSync(path.join(repo, "plugins/screens/assets/screens-icon.svg"), path.join(out, "sidebar.svg"));
fs.chmodSync(path.join(out, "screens.js"), 0o755);
console.log(`built ${manifest.name}@${manifest.version} in ${path.relative(repo, out)}`);
