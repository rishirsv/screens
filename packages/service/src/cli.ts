#!/usr/bin/env node
// screens serve [--dev] [--canvas-port N] [--frame-port N] [--idle-exit] | doctor | url [screenId] | open [screenId] | stop

import { execFile } from "node:child_process";
import { serve } from "./server.ts";
import { ensureService, liveRegistry } from "./registry.ts";

const [cmd = "url", ...args] = process.argv.slice(2);

async function main() {
  switch (cmd) {
    case "serve": {
      const port = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? Number(args[i + 1]) : undefined; };
      await serve({ idleExit: args.includes("--idle-exit"), dev: args.includes("--dev"), idleMs: port("--idle-ms"), canvasPort: port("--canvas-port"), framePort: port("--frame-port") });
      return;
    }
    case "url": case "open": {
      const r = await ensureService();
      const url = args[0] ? `${r.canvasOrigin}/s/${args[0]}` : r.canvasOrigin;
      console.log(url);
      if (cmd === "open") execFile(process.platform === "darwin" ? "open" : "xdg-open", [url]);
      return;
    }
    case "doctor": {
      const r = await liveRegistry();
      if (!r) { console.error(`not running (SCREENS_HOME=${process.env.SCREENS_HOME ?? "~/.screens"})`); process.exit(1); }
      console.log(`healthy pid ${r.pid} instance ${r.instanceId} canvas ${r.canvasOrigin} frames ${r.frameOrigin}${r.dev ? " dev" : ""}`);
      return;
    }
    case "stop": {
      const r = await liveRegistry();
      if (r) { process.kill(r.pid, "SIGTERM"); console.log(`stopped pid ${r.pid}`); } else console.log("not running");
      return;
    }
    default: console.error("usage: screens serve|doctor|url|open|stop"); process.exit(2);
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
