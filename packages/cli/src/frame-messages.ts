// Only the snapshot script sends the attacks. Playwright supplies data through real keyboard input.
import type { Frame } from "playwright-core";
import type { Service } from "@screens/client";

export async function verifyFrameMessages(canvas: Frame, service: Service, screenId: string, secret: string): Promise<Record<string, unknown>> {
  const doc = await service.read(screenId);
  const attacker = Object.values(doc.items).find((it) => it.title === "Message attacker")!;
  const victim = Object.values(doc.items).find((it) => it.title === "Message victim")!;
  if (!attacker || !victim) throw new Error("frame-messages needs Message attacker and Message victim snapshots");
  await canvas.locator(`[data-item="${attacker.id}"][data-load="ready"]`).waitFor();
  await canvas.locator(`[data-item="${victim.id}"][data-load="ready"]`).waitFor();
  const host = canvas.locator(`[data-item="${attacker.id}"] iframe`);
  const outer = await host.elementHandle();
  const frame = await outer!.contentFrame();
  const child = frame!.childFrames()[0] ?? frame!;
  const victimHost = await canvas.locator(`[data-item="${victim.id}"] iframe`).elementHandle();
  const victimFrame = (await victimHost!.contentFrame())!;
  const victimChild = victimFrame.childFrames()[0] ?? victimFrame;
  const victimHtml = await victimChild.locator("body").innerHTML();
  if (await child.frameElement().then((el) => el.getAttribute("sandbox")) !== "allow-scripts") throw new Error("snapshot sandbox changed");
  const input = child.locator("#payload");
  // Focus before checkpointing: entering a frame legitimately updates interaction state.
  await canvas.locator(`[data-item="${attacker.id}"] .frame-title`).click();
  await input.click();
  await canvas.waitForFunction(() => (window as any).__screensTest.idle());
  const read = () => canvas.evaluate(() => (window as any).__screensTest.probe(["view", "pending", "frames", "dom"]));
  const before = await read();
  const gen = String(before.frames[attacker.id].gen);
  const op = { type: "removeItems", itemIds: [victim.id] };
  const cases = [
    [{ kind: "ready", itemId: victim.id }],
    [{ kind: "ready", gen: String(Number(gen) - 1) }],
    // Unlike ready on an already ready page, these reveal stale/misaddressed messages being accepted.
    [{ kind: "error", gen: String(Number(gen) - 1) }],
    [{ kind: "error", itemId: victim.id }],
    [{ kind: "rect", itemId: victim.id, pid: "title", w: 99999, h: 99999 }],
    [{ type: "command", command: { kind: "delete" } }, { type: "view-command", cmd: { id: "attack", kind: "focus", itemId: victim.id, issuedAt: Date.now() } }, { kind: "zoom", gen: "0", x: 0, y: 0, dy: 999, pinch: true }],
    [op, { t: "op", reqId: "attack", screenId, opId: "attack", op }, { kind: "submit", op }],
    [{ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: {} } }, { jsonrpc: "2.0", id: 1, result: {} }, { jsonrpc: "2.0", id: "attack", method: "tools/call", params: { name: "_screens_call", arguments: { kind: "request", message: { t: "op", screenId, opId: "attack", op } } } }],
  ];
  await service.fault(secret, { kind: "delay-commit", ms: 2000, count: 1 });
  try {
    for (const [index, messages] of cases.entries()) {
      await input.fill(JSON.stringify(messages));
      await input.press("Enter");
      await child.locator("#sent").filter({ hasText: `sent ${messages.length * 2}` }).waitFor();
      // Give posted messages, canvas paints and host-relayed requests time to settle.
      await new Promise((resolve) => setTimeout(resolve, 350));
      const after = await read();
      for (const layer of ["view", "pending", "frames", "dom"]) {
        if (JSON.stringify(after[layer]) !== JSON.stringify(before[layer])) throw new Error(`frame message case ${index + 1} changed ${layer}: ${JSON.stringify({ before: before[layer], after: after[layer] })}`);
      }
      if (victimChild.isDetached() || await victimChild.locator("body").innerHTML() !== victimHtml) throw new Error(`frame message case ${index + 1} changed victim contents`);
      if (!(await service.inspect(secret)).faults.some((f) => f.kind === "delay-commit")) throw new Error(`frame message case ${index + 1} reached a domain write`);
      if (JSON.stringify(await service.read(screenId)) !== JSON.stringify(doc)) throw new Error(`frame message case ${index + 1} changed committed document`);
    }
  } finally { await service.fault(secret, { kind: "clear" }); }
  return { cases: cases.length, revision: doc.revision, unchanged: true, sandbox: "allow-scripts" };
}
