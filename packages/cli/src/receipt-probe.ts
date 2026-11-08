// Exercise retry races through the real canvas protocol, whose undo requests have no MCP equivalent.
import crypto from "node:crypto";
import { connectWebSocketTransport, contentVersionOf, type Outcome, type Service } from "@screens/client";
import { connectAgent } from "./agent.ts";
import { Aliases } from "./state.ts";
import type { ArgValue } from "./script.ts";
import type { Registry } from "@screens/service";
import type { ImportOutcome } from "@screens/protocol";

export async function verifyHistoryReceipts(reg: Registry, service: Service, secret: string, home: string): Promise<Record<string, unknown>> {
  const canvas = await connectWebSocketTransport({ origin: reg.canvasOrigin, token: reg.token, instanceId: reg.instanceId, role: "canvas" });
  const { id: screenId } = await service.createScreen("Before history");
  const prefix = crypto.randomUUID();
  const history = (direction: "undo" | "redo", suffix: string) => canvas.request<Outcome>({ t: "history", screenId, direction, opId: `${prefix}-${suffix}` });
  const stack = async () => (await service.inspect(secret)).stacks.find((s) => s.sessionId === canvas.sessionId && s.screenId === screenId)!;
  try {
    for (const [i, title] of ["First", "Second"].entries()) {
      const outcome = await canvas.request<Outcome>({ t: "op", screenId, opId: `${prefix}-rename-${i}`, op: { type: "renameScreen", title } });
      if (outcome.status !== "committed") throw new Error("history probe setup did not commit");
    }
    // The service accepts the undo and publishes its revision, but the request's answer is deliberately lost.
    await service.fault(secret, { kind: "drop-result", count: 1 });
    void history("undo", "lost").catch(() => {});
    await canvas.request({ t: "status", opId: `${prefix}-lost` });
    const deadline = Date.now() + 5000;
    while ((await service.status(`${prefix}-lost`)).status !== "committed") {
      if (Date.now() > deadline) throw new Error("lost undo never committed");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const replay = await history("undo", "lost");
    const afterReplay = await stack();
    const firstReplay = replay.status === "committed" && replay.revision === 3 && afterReplay.undo.length === 1 && afterReplay.redo.length === 1;
    const second = await history("undo", "second");
    const emptyReplay = await history("undo", "second");
    const undoEmpty = second.status === "committed" && emptyReplay.status === "committed" && emptyReplay.revision === 4;
    const [redo, concurrentReplay] = await Promise.all([history("redo", "redo"), history("redo", "redo")]);
    const redoReplay = redo.status === "committed" && concurrentReplay.status === "committed" && redo.revision === concurrentReplay.revision;
    const wrongDirection = await history("undo", "redo");
    const afterWrongDirection = await stack();
    const mismatch = wrongDirection.status === "failed" && wrongDirection.error.code === "invalid"
      && afterWrongDirection.undo.length === 1 && afterWrongDirection.redo.length === 1;
    const doc = await service.read(screenId);
    // A refusal is a receipt too: a retry of "nothing to undo" must not start undoing later edits.
    const { id: emptyId } = await service.createScreen("Empty history");
    const emptyRequest = { t: "history" as const, screenId: emptyId, direction: "undo" as const, opId: `${prefix}-empty` };
    await canvas.request(emptyRequest);
    await canvas.request({ t: "op", screenId: emptyId, opId: `${prefix}-after-empty`, op: { type: "renameScreen", title: "Keep later edit" } });
    const emptyRetry = await canvas.request<Outcome>(emptyRequest);
    const emptyHistoryStable = emptyRetry.status === "failed" && (await service.read(emptyId)).title === "Keep later edit"
      && (await service.status(emptyRequest.opId)).status === "failed";
    const libraryRequest = { t: "libraryHistory" as const, direction: "undo" as const, opId: `${prefix}-library-empty` };
    await canvas.request(libraryRequest);
    const folderId = crypto.randomBytes(12).toString("hex");
    const addedFolder = await canvas.request<Outcome>({ t: "libraryOp", opId: `${prefix}-folder`, op: { type: "createFolder", folder: { id: folderId, name: "Keep later folder" } } });
    if (addedFolder.status !== "committed") throw new Error(`empty library history probe setup failed: ${JSON.stringify(addedFolder)}`);
    const libraryRetry = await canvas.request<Outcome>(libraryRequest);
    const emptyLibraryStable = libraryRetry.status === "failed" && !!(await service.readLibrary()).folders[folderId]
      && (await service.status(libraryRequest.opId)).status === "failed";
    if ((await service.readLibrary()).folders[folderId]) {
      const targets = [{ kind: "folder" as const, id: folderId }];
      await service.runLibrary({ type: "archive", targets });
      await canvas.request({ t: "purge", opId: `${prefix}-folder-cleanup`, targets });
    }
    // Two imports can both pass the preflight receipt lookup while queued behind an earlier Screen write.
    // Their headers are valid and differ only in title; importing an existing Screen is itself a remembered refusal.
    const heads = await Promise.all(["Import A", "Import B"].map((title) => service.upload(new TextEncoder().encode(JSON.stringify({ format: 1, screen: { ...doc, title }, files: [] })))));
    await service.fault(secret, { kind: "delay-commit", ms: 250, count: 1 });
    const writing = service.run(screenId, { type: "renameScreen", title: "Hold import queue" }, `${prefix}-hold`);
    const waitUntil = Date.now() + 5000;
    while ((await service.inspect(secret)).commitStage !== "before-write") {
      if (Date.now() > waitUntil) throw new Error("import probe did not reach its delayed write");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const [firstImport, otherImport] = await Promise.all(heads.map((head) => canvas.request<ImportOutcome>({ t: "importScreen", opId: `${prefix}-import`, head })));
    await writing;
    const importMismatch = firstImport.status === "failed" && firstImport.error.code === "exists"
      && otherImport.status === "failed" && otherImport.error.code === "invalid";
    // Purge drains the Screen's queue while holding the library queue. Conflicting reuse must be rejected before
    // it enters that Screen queue, or it waits for purge's operation-ID reservation while purge waits for it.
    await service.runLibrary({ type: "archive", targets: [{ kind: "screen", id: screenId }] });
    await service.fault(secret, { kind: "delay-commit", ms: 250, count: 1 });
    const delayed = service.run(screenId, { type: "renameScreen", title: "Before purge" }, `${prefix}-before-purge`);
    const purgeWait = Date.now() + 5000;
    while ((await service.inspect(secret)).commitStage !== "before-write") {
      if (Date.now() > purgeWait) throw new Error("purge probe did not reach its delayed write");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const purgeId = `${prefix}-purge`;
    const purging = canvas.request<Outcome>({ t: "purge", opId: purgeId, targets: [{ kind: "screen", id: screenId }] });
    const conflicting = canvas.request<Outcome>({ t: "op", screenId, opId: purgeId, op: { type: "renameScreen", title: "Conflicting reuse" } });
    let timer: ReturnType<typeof setTimeout>;
    const [purge, conflict] = await Promise.race([
      Promise.all([purging, conflicting]),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("purge and conflicting operation deadlocked")), 2000); }),
    ]).finally(() => clearTimeout(timer));
    await delayed;
    const purgeCompleted = purge.status === "committed" && conflict.status === "failed" && conflict.error.code === "invalid"
      && !(await service.listScreens({ archived: true })).some((s) => s.id === screenId);
    const legacySnapshot = await verifyLegacySnapshot(service, home);
    return { firstReplay, undoEmpty, redoReplay, mismatch, emptyHistoryStable, emptyLibraryStable, importMismatch, purgeCompleted, legacySnapshot, revision: doc.revision, title: doc.title };
  } finally { canvas.close(); }
}

/** The pre-request-identity adapter wrote this operation-derived receipt. Reopen this fixture on the next probe
 *  invocation after service restart, then replay through the real current MCP adapter. */
async function verifyLegacySnapshot(service: Service, home: string): Promise<boolean> {
  const title = "Legacy snapshot receipt fixture", opId = "legacy-snapshot-receipt";
  const screenId = (await service.listScreens()).find((s) => s.title === title)?.id ?? (await service.createScreen(title)).id;
  const itemId = `i${crypto.createHash("sha256").update(opId).digest("hex").slice(0, 24)}`;
  const files = [{ path: "index.html", content: '<!doctype html><p data-pid="title">Legacy receipt</p>' }];
  const manifest = { "index.html": { hash: await service.upload(Buffer.from(files[0]!.content)), mediaType: "text/html" } };
  const outcome = await service.run(screenId, { type: "addItem", item: { kind: "html-snapshot", id: itemId, title: "Legacy", x: 0, y: 0, width: 390, height: 844,
    entry: "index.html", contentVersion: await contentVersionOf("index.html", manifest), assetManifest: manifest, sourceReferenceIds: [] } }, opId);
  if (outcome.status !== "committed") throw new Error("legacy receipt setup failed");
  const agent = await connectAgent(home);
  try {
    const args: Record<string, ArgValue> = Object.fromEntries(Object.entries({ screenId, title: "Legacy", files: JSON.stringify(files), x: "0", y: "0", width: "390", height: "844", opId })
      .map(([key, raw]) => [key, { kind: "literal", raw }]));
    const replay = await agent.call("add_object", args, { aliases: new Aliases(), screenId, cwd: process.cwd(), outDir: home, journal: () => {} });
    const doc = await service.read(screenId);
    return !replay.isError && replay.value.status === "committed" && replay.value.itemId === itemId && doc.revision === 1 && Object.keys(doc.items).length === 1;
  } finally { await agent.close(); }
}
