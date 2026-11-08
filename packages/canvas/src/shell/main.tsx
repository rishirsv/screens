import { createRoot } from "react-dom/client";
import { connectLocalService, connectService } from "@screens/client";
import { connectAppTransport } from "../../../client/src/bridge.ts";
import { runBench } from "./bench.ts";
import { installTestHook } from "./testHook.ts";
import { LibraryApp } from "./library/LibraryApp.tsx";
import { configureAppContent } from "./content.tsx";
import { configureOpening } from "./opening.ts";
import { navigate } from "./library/nav.ts";
import { setOpeningTraceSink } from "../../../client/src/diagnostics.ts";

declare global { interface Window { __SCREENS__: { token: string; instanceId: string }; __SCREENS_APP__?: boolean; __SCREENS_APP_PATH__?: string } }
/** Set by the service's esbuild define: true only for a --dev service. Production bundles drop the hook. */
declare const __SCREENS_TEST__: boolean;

/** One canvas session per tab, kept across reloads so in-session undo survives them while the service runs. */
function sessionId(): string | undefined {
  try {
    let id = sessionStorage.getItem("screens.session");
    if (!id) { id = crypto.randomUUID(); sessionStorage.setItem("screens.session", id); }
    return id;
  } catch { return undefined; }
}

async function boot() {
  const observer = configureOpening();
  const root = createRoot(document.getElementById("root")!);
  observer?.mark("transport.connect.start");
  const svc = window.__SCREENS_APP__ ? connectService(await connectAppTransport()) : await connectLocalService({ origin: location.origin, token: window.__SCREENS__.token, instanceId: window.__SCREENS__.instanceId, role: "canvas", sessionId: sessionId() });
  observer?.mark("transport.connected");
  if (window.__SCREENS_APP__) configureAppContent(svc);
  if (observer && !window.__SCREENS_APP__) {
    const config = observer.config;
    if (!config.collector) throw new Error("Opening benchmark needs a local collector");
    const collector = new URL(config.collector);
    if (collector.protocol !== "http:" || collector.hostname !== "127.0.0.1") throw new Error("Opening collector must be local");
    setOpeningTraceSink(async (value) => {
      const response = await fetch(collector, { method: "POST", headers: { "content-type": "application/json", ...(config.token ? { "x-screens-opening-token": config.token } : {}) }, body: JSON.stringify(value) });
      if (!response.ok) throw new Error(`Opening collector refused trace: ${response.status}`);
    });
  }
  if (location.pathname === "/bench") { await runBench(svc, root); return; }
  if (observer) navigate("/");
  root.render(<LibraryApp svc={svc} onRuntime={__SCREENS_TEST__ ? (rt) => installTestHook(rt) : undefined} />);
  observer?.mount((path) => navigate(path));
}

boot().catch((e) => { document.body.textContent = `Screens could not start: ${e instanceof Error ? e.message : e}`; });
