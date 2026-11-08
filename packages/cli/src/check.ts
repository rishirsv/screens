// screens-cli check: contracts, boundaries and coverage. Fails loudly; prints nothing else on success.

import fs from "node:fs";
import path from "node:path";
import { buildCanvas } from "@screens/service";
import { listToolsOnce } from "./agent.ts";
import { COMMAND_VERBS, EFFECT_LAYERS, INPUT_SOURCES } from "./bindings.ts";
import { extractBlocks, LAYERS, parseScript, VERBS } from "./script.ts";
import { REPO } from "./session.ts";

export const FEATURES = path.join(REPO, ".agents/skills/verify-screens/features");

export async function check(): Promise<string[]> {
  const problems: string[] = [];
  const tools = (await listToolsOnce()).map((t) => t.name);

  // Contracts: one name, one meaning.
  for (const t of tools) if (t in VERBS) problems.push(`contracts: MCP tool ${t} collides with a screens-cli verb`);
  for (const [input, src] of Object.entries(INPUT_SOURCES)) if (Array.isArray(src)) for (const v of src) if (!(v in VERBS)) problems.push(`contracts: INPUT_SOURCES.${input} names unknown verb ${v}`);
  for (const v of new Set(Object.values(COMMAND_VERBS))) if (!(v in VERBS)) problems.push(`contracts: COMMAND_VERBS names unknown verb ${v}`);
  for (const l of Object.values(EFFECT_LAYERS)) if (!(LAYERS as readonly string[]).includes(l)) problems.push(`contracts: EFFECT_LAYERS names unknown layer ${l}`);

  // Boundaries: nothing imports the CLI; only the validation worker drives a browser; production bundles have no test hook.
  const pkgs = path.join(REPO, "packages");
  for (const pkg of fs.readdirSync(pkgs)) {
    if (pkg === "cli") continue;
    for (const f of walk(path.join(pkgs, pkg, "src"))) {
      const src = fs.readFileSync(f, "utf8");
      if (/from\s+["'](@screens\/cli|[^"']*\/cli\/src\/[^"']*)["']/.test(src)) problems.push(`boundaries: ${path.relative(REPO, f)} imports packages/cli`);
      if (pkg !== "validator" && /from\s+["']playwright(-core)?["']/.test(src)) problems.push(`boundaries: ${path.relative(REPO, f)} imports playwright`);
    }
  }
  const prod = await buildCanvas({ testHook: false }), dev = await buildCanvas({ testHook: true });
  // The opening doctor reads the hook's name without installing it. Check the
  // defining operation in testHook.ts, rather than a read-only reference.
  const installsHook = /Object\.defineProperty\(window,\s*["']__screensTest["']/;
  if (installsHook.test(prod)) problems.push("boundaries: the production canvas bundle contains the test hook");
  if (!installsHook.test(dev)) problems.push("boundaries: the dev canvas bundle is missing the test hook");

  // Coverage: every tool, verb, command and layer is reached by some feature block, or listed under ## Uncovered.
  const readme = fs.readFileSync(path.join(FEATURES, "README.md"), "utf8");
  const uncovered = new Set([...(readme.split(/^## Uncovered$/m)[1] ?? "").matchAll(/^- `([^`]+)`/gm)].map((m) => m[1]!));
  const used = new Set<string>();
  for (const f of fs.readdirSync(FEATURES).filter((x) => x.endsWith(".md"))) {
    for (const b of extractBlocks(fs.readFileSync(path.join(FEATURES, f), "utf8"), f)) {
      const { lines, errors } = parseScript(b.text, b.line);
      for (const e of errors) problems.push(`coverage: ${f}:${e.n} does not parse: ${e.message}`);
      for (const l of lines) {
        if (l.step.kind === "begin") used.add("begin");
        const s = l.step.kind === "begin" ? l.step.step : l.step;
        if (s.kind === "agent") { used.add(s.tool); if (!tools.includes(s.tool)) problems.push(`coverage: ${f}:${l.n} calls unknown tool ${s.tool}`); }
        else used.add(l.source.replace(/^!\s*/, "").split(/\s+/)[0]!);
        const paths = s.kind === "expect" || s.kind === "wait" ? s.exprs.flatMap((e) => [e.path, ...(e.value.kind === "path" ? [e.value.path] : [])]) : s.kind === "get" && s.path ? [s.path] : [];
        for (const p of paths) used.add(`layer:${p.layer}`);
      }
    }
  }
  const missing = (name: string) => !used.has(name) && !uncovered.has(name);
  const gaps = [
    ...tools.filter(missing).map((t) => `tool ${t}`),
    ...Object.keys(VERBS).filter(missing).map((v) => `verb ${v}`),
    ...LAYERS.filter((l) => missing(`layer:${l}`)).map((l) => `layer ${l}`),
    ...Object.entries(COMMAND_VERBS).filter(([, v]) => missing(v)).map(([c]) => `command ${c}`),
  ];
  if (gaps.length) problems.push(`coverage: no feature block reaches ${gaps.join(", ")} (add a block, or list it under ## Uncovered in features/README.md)`);
  return problems;
}

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []));
}
