// Explicitly enabled benchmark metadata, independent of dev controls and Screen storage.
import fs from "node:fs";
import crypto from "node:crypto";

export interface OpeningConfig {
  readonly runId: string;
  readonly host: "screens-app" | "in-app-browser" | "headless-control" | "app-relay-control";
  readonly cases: readonly { readonly id: string; readonly screenId: string; readonly items: number }[];
  readonly reps: number;
  readonly revision: string;
  readonly canvasHash?: string;
  readonly collector?: string;
  readonly token?: string;
}

/** Read only an explicitly named, bounded config. A malformed opt-in fails instead of silently running unmeasured. */
export function readOpeningConfig(): OpeningConfig | undefined {
  const file = process.env.SCREENS_OPENING_CONFIG;
  if (!file) return undefined;
  if (fs.statSync(file).size > 65536) throw new Error("Opening config exceeds 64 KiB");
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid opening config");
  const c = value as Record<string, unknown>;
  const id = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(v);
  if (!id(c.runId) || !["screens-app", "in-app-browser", "headless-control", "app-relay-control"].includes(String(c.host))
    || !Number.isInteger(c.reps) || (c.reps as number) < 1 || (c.reps as number) > 20
    || typeof c.revision !== "string" || c.revision.length > 128
    || !Array.isArray(c.cases) || c.cases.length < 1 || c.cases.length > 50
    || !c.cases.every((v: unknown) => {
      if (!v || typeof v !== "object" || Array.isArray(v)) return false;
      const k = v as Record<string, unknown>;
      return id(k.id) && id(k.screenId) && Number.isInteger(k.items) && (k.items as number) >= 0 && (k.items as number) <= 500;
    }) || (c.collector !== undefined && (typeof c.collector !== "string" || c.collector.length > 2048))
    || (c.token !== undefined && (typeof c.token !== "string" || c.token.length > 256))) throw new Error("Invalid opening config");
  return value as OpeningConfig;
}

/** Inline JSON is escaped as script source, not HTML. The JS digest always describes the bytes actually delivered. */
export function openingConfigScript(config: OpeningConfig | undefined, js: string, identity: Readonly<Record<string, unknown>>): string {
  if (!config) return "";
  const value = { ...config, ...identity, canvasHash: crypto.createHash("sha256").update(js).digest("hex") };
  return `window.__SCREENS_OPENING__={...${JSON.stringify(value).replace(/</g, "\\u003c")},bootAt:performance.now()};`;
}
