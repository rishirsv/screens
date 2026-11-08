// Dev-only controls for screens-cli: read-only inspection and fault injection.
// Exists only when the service runs with --dev on a non-default SCREENS_HOME. Requests must carry the secret
// written to $SCREENS_HOME/dev.secret, which the canvas page never sees. A fault delays or fails the real
// commit path; it never supplies a document or a receipt.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { CommitStep } from "@screens/storage-local";
import type { Fault, ServiceInspection } from "@screens/protocol";

export interface DevControls {
  readonly secretOk: (s: unknown) => boolean;
  inspect(): ServiceInspection;
  fault(f: Fault): void;
  /** Awaited inside a commit before the write. Returns a failure to report, or null to write. */
  beforeWrite(): Promise<{ readonly code: "storage" | "conflict"; readonly message: string } | null>;
  afterWrite(): void;
  step(step: CommitStep): void;
  writing(kind: "content" | "poster" | "document"): void;
  /** Consumes one drop-result fault: the commit stands, its result message is never sent. */
  dropResult(): boolean;
  /** Consumed once per upload chunk: "drop" closes the socket after the chunk is accepted; "corrupt" flips a byte first. */
  chunkFault(): "drop" | "corrupt" | "fail" | null;
  /** Consumes one no-browser fault: the next snapshot check behaves as if Chrome failed to launch. */
  takeNoBrowser(): boolean;
}

export function createDevControls(o: { readonly home: string; readonly defaultHome: string; readonly inspect: () => Omit<ServiceInspection, "faults" | "dev" | "commitStage"> }): DevControls {
  if (path.resolve(o.home) === path.resolve(o.defaultHome)) throw new Error("--dev is refused on the default Screens home; set SCREENS_HOME to a disposable folder");
  const secret = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(path.join(o.home, "dev.secret"), secret, { mode: 0o600 });
  let faults: Fault[] = [];
  let chunks = 0;
  let commitStage: string | null = null;
  const take = <K extends Fault["kind"]>(kind: K): Extract<Fault, { kind: K }> | null => {
    const i = faults.findIndex((f) => f.kind === kind);
    if (i < 0) return null;
    const f = faults[i] as Extract<Fault, { kind: K }>;
    if ("count" in f && f.count > 1) faults[i] = { ...f, count: f.count - 1 };
    else faults.splice(i, 1);
    return f;
  };
  const crash = () => process.kill(process.pid, "SIGKILL");
  return {
    secretOk: (s) => typeof s === "string" && s.length === secret.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(secret)),
    inspect: () => ({ ...o.inspect(), dev: true, commitStage, faults: [...faults] }),
    fault: (f) => {
      if (f.kind === "clear") faults = [];
      else if (f.kind === "drop-upload") { faults = faults.filter((x) => x.kind !== "drop-upload"); chunks = 0; faults.push({ ...f, after: Math.max(1, f.after) }); }
      else if (f.kind !== "disconnect" && f.kind !== "expire-uploads" && f.kind !== "expire-presence") faults.push(f);
    },
    async beforeWrite() {
      commitStage = "before-write";
      const d = take("delay-commit"); if (d) await new Promise((r) => setTimeout(r, d.ms));
      const c = faults.find((f) => f.kind === "crash" && f.at === "before-write"); if (c) crash();
      const f = take("fail-commit");
      return f ? { code: f.code, message: f.code === "storage" ? "injected storage failure" : "injected conflict" } : null;
    },
    step(step) { commitStage = step; if (faults.some((f) => f.kind === "crash" && f.at === step)) crash(); },
    writing(kind) {
      const i = faults.findIndex((f) => f.kind === "disk-full" && f.at === kind);
      if (i >= 0) { faults.splice(i, 1); throw Object.assign(new Error(`ENOSPC: no space left on device, write ${path.join(o.home, "library", kind)}`), { code: "ENOSPC" }); }
    },
    afterWrite() { commitStage = null; if (faults.some((f) => f.kind === "crash" && f.at === "after-write")) crash(); },
    dropResult: () => take("drop-result") !== null,
    takeNoBrowser: () => take("no-browser") !== null,
    chunkFault() {
      if (take("corrupt-upload")) return "corrupt";
      const failing = faults.find((x) => x.kind === "fail-upload");
      if (failing) { if (failing.after > 1) faults[faults.indexOf(failing)] = { ...failing, after: failing.after - 1 }; else { take("fail-upload"); return "fail"; } }
      const f = faults.find((x) => x.kind === "drop-upload");
      if (!f) return null;
      // Every `after`-th accepted chunk drops the socket, `count` times.
      if (++chunks % f.after !== 0) return null;
      take("drop-upload");
      return "drop";
    },
  };
}
