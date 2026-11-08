// Regression probes through the public canvas protocol. Setup and competing writes use another client;
// no document or undo stack is written by the probe.
import crypto from "node:crypto";
import { connectWebSocketTransport, contentVersionOf, type Outcome, type Service } from "@screens/client";
import { COMMENTS_PER_THREAD_MAX, FOLDERS_MAX, ITEMS_MAX, STROKES_MAX, THREADS_MAX, type LibraryOperation, type NewItem, type Operation } from "@screens/core";
import type { Registry } from "@screens/service";

const committed = (o: Outcome) => { if (o.status !== "committed") throw new Error(`history setup failed: ${JSON.stringify(o)}`); };
const refused = (o: Outcome) => o.status === "failed" && o.error.code === "conflict";

export async function verifyCoreHistory(reg: Registry, service: Service): Promise<Record<string, unknown>> {
  const canvas = await connectWebSocketTransport({ origin: reg.canvasOrigin, token: reg.token, instanceId: reg.instanceId, role: "canvas" });
  const opId = () => crypto.randomUUID();
  const run = (screenId: string, op: Operation) => canvas.request<Outcome>({ t: "op", screenId, opId: opId(), op });
  const history = (screenId: string, direction: "undo" | "redo") => canvas.request<Outcome>({ t: "history", screenId, direction, opId: opId() });
  const library = (op: LibraryOperation) => canvas.request<Outcome>({ t: "libraryOp", opId: opId(), op });
  const libraryHistory = (direction: "undo" | "redo") => canvas.request<Outcome>({ t: "libraryHistory", direction, opId: opId() });
  const id = () => crypto.randomBytes(12).toString("hex");
  try {
    const hash = await service.upload(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
    const image = (itemId: string): NewItem => ({ id: itemId, kind: "reference-image", title: "Reference", assetHash: hash, mediaType: "image/png", x: 0, y: 0, width: 40, height: 40 });
    const { id: batchScreen } = await service.createScreen("History batch order");
    const itemId = id();
    committed(await service.run(batchScreen, { type: "addItem", item: image(itemId) }));
    committed(await run(batchScreen, { type: "batch", ops: [10, 20].map((x) => ({ type: "moveItems", moves: [{ itemId, x, y: 0 }] })) }));
    committed(await history(batchScreen, "undo"));
    const batchRedo = await history(batchScreen, "redo");
    const batchOrder = batchRedo.status === "committed" && (await service.read(batchScreen)).items[itemId]!.x === 20;

    const source = '<!doctype html><p data-pid="title">Original</p>';
    const textHash = await service.upload(Buffer.from(source));
    const objectId = id();
    const manifest = { "index.html": { hash: textHash, mediaType: "text/html" } };
    committed(await service.run(batchScreen, { type: "addItem", item: { id: objectId, kind: "html-snapshot", title: "Object", entry: "index.html", contentVersion: await contentVersionOf("index.html", manifest), assetManifest: manifest, sourceReferenceIds: [], width: 100, height: 100 } }));
    committed(await run(batchScreen, { type: "editObject", itemId: objectId, edits: [{ at: "title", text: "One" }, { at: "title", text: "Two" }] }));
    committed(await history(batchScreen, "undo"));
    const pieceRedo = await history(batchScreen, "redo");
    const object = (await service.read(batchScreen)).items[objectId]!;
    const pieceOrder = pieceRedo.status === "committed" && object.kind === "html-snapshot"
      && Buffer.from(await service.readContent(object.assetManifest[object.entry]!.hash)).toString().includes(">Two</p>");

    const folderId = id();
    committed(await library({ type: "batch", ops: [{ type: "createFolder", folder: { id: folderId, name: "Before" } }, { type: "renameFolder", folderId, name: "After" }] }));
    committed(await libraryHistory("undo"));
    const libraryRedo = await libraryHistory("redo");
    const libraryOrder = libraryRedo.status === "committed" && (await service.readLibrary()).folders[folderId]?.name === "After";

    const { id: capacityScreen } = await service.createScreen("History capacity");
    const ids = Array.from({ length: ITEMS_MAX }, id);
    committed(await service.run(capacityScreen, { type: "batch", ops: ids.map((itemId) => ({ type: "addItem", item: image(itemId) })) }));
    committed(await run(capacityScreen, { type: "removeItems", itemIds: [ids[0]!] }));
    committed(await service.run(capacityScreen, { type: "addItem", item: image(id()) }));
    const itemLimit = refused(await history(capacityScreen, "undo")) && Object.keys((await service.read(capacityScreen)).items).length === ITEMS_MAX;

    const stroke = (strokeId: string): Extract<Operation, { type: "addStroke" }> => ({ type: "addStroke", stroke: { id: strokeId, anchor: { kind: "world" }, points: [[0, 0, 1]], color: "#000000", size: 1 } });
    const strokeIds = Array.from({ length: STROKES_MAX }, id);
    committed(await service.run(capacityScreen, { type: "batch", ops: strokeIds.map(stroke) }));
    committed(await run(capacityScreen, { type: "removeStroke", strokeId: strokeIds[0]! }));
    committed(await service.run(capacityScreen, stroke(id())));
    const strokeLimit = refused(await history(capacityScreen, "undo")) && Object.keys((await service.read(capacityScreen)).strokes).length === STROKES_MAX;

    const thread = (threadId: string): Extract<Operation, { type: "addThread" }> => ({ type: "addThread", thread: { id: threadId, anchor: { kind: "world" }, x: 0, y: 0, comment: { id: id(), text: "First" } } });
    const threadIds = Array.from({ length: THREADS_MAX }, id);
    committed(await service.run(capacityScreen, { type: "batch", ops: threadIds.map(thread) }));
    committed(await run(capacityScreen, { type: "removeThread", threadId: threadIds[0]! }));
    committed(await service.run(capacityScreen, thread(id())));
    const threadLimit = refused(await history(capacityScreen, "undo")) && Object.keys((await service.read(capacityScreen)).threads).length === THREADS_MAX;

    const threadId = threadIds[1]!;
    const commentIds = Array.from({ length: COMMENTS_PER_THREAD_MAX - 1 }, id);
    committed(await service.run(capacityScreen, { type: "batch", ops: commentIds.map((commentId) => ({ type: "addComment", threadId, comment: { id: commentId, text: "Reply" } })) }));
    committed(await run(capacityScreen, { type: "removeComment", threadId, commentId: commentIds[0]! }));
    committed(await service.run(capacityScreen, { type: "addComment", threadId, comment: { id: id(), text: "Competing reply" } }));
    const commentLimit = refused(await history(capacityScreen, "undo")) && (await service.read(capacityScreen)).threads[threadId]!.comments.length === COMMENTS_PER_THREAD_MAX;

    // A redo can create a folder too: another writer may consume its released slot between undo and redo.
    const reserved = id();
    committed(await library({ type: "createFolder", folder: { id: reserved, name: "Reserved" } }));
    committed(await libraryHistory("undo"));
    const available = FOLDERS_MAX - Object.keys((await service.readLibrary()).folders).length;
    const competingFolders = Array.from({ length: available }, id);
    committed(await service.runLibrary({ type: "batch", ops: competingFolders.map((folderId) => ({ type: "createFolder", folder: { id: folderId, name: "Competing folder" } })) }));
    const folderLimit = refused(await libraryHistory("redo")) && Object.keys((await service.readLibrary()).folders).length === FOLDERS_MAX;
    const targets = [folderId, ...competingFolders, ...((await service.readLibrary()).folders[reserved] ? [reserved] : [])].map((id) => ({ kind: "folder" as const, id }));
    committed(await service.runLibrary({ type: "archive", targets }));
    committed(await canvas.request<Outcome>({ t: "purge", opId: opId(), targets }));
    return { batchOrder, pieceOrder, libraryOrder, itemLimit, strokeLimit, threadLimit, commentLimit, folderLimit };
  } finally { canvas.close(); }
}
