// Uploads in progress: the only code that turns received bytes into content. Agent bundles, agent images, imports and
// canvas drops all arrive here as chunks of (hash, size). The hash is the checksum, the staging key and the resume cursor:
// a client asks `held` and sends the rest, so a dropped socket, an adapter restart and a second writer recover the same way.

import crypto from "node:crypto";
import type { Library, StagingFile } from "@screens/storage-local";

export const UPLOAD_FILE_MAX = 64e6;
export const UPLOAD_STAGING_MAX = 256e6;
export const UPLOAD_IDLE_MS = 10 * 60_000;
const HASH = /^[0-9a-f]{64}$/;

export interface UploadsInspection { readonly entries: readonly { readonly hash: string; readonly size: number; readonly held: number; readonly idleMs: number }[]; readonly offered: number }

export interface Uploads {
  /** Bytes of (hash, size) held: size when the content store has it. Opens or touches a staging entry. */
  held(hash: string, size: number): number;
  /** Appends the part of `bytes` past what is held and returns the new held. A gap returns held unchanged, a resent chunk is a
   *  no-op. On the last byte the file is verified: a match is promoted into the content store; a mismatch is discarded and
   *  throws `corrupt`, so nothing is stored. */
  write(hash: string, size: number, offset: number, bytes: Uint8Array): number;
  /** Drops entries idle at least `idleMs` (default UPLOAD_IDLE_MS). Returns how many. */
  sweep(idleMs?: number): number;
  inspect(): UploadsInspection;
}

interface Entry { readonly file: StagingFile; readonly hasher: crypto.Hash; touchedAt: number }

export function createUploads(lib: Library, now: () => number = Date.now): Uploads {
  const entries = new Map<string, Entry>();
  let offered = 0;
  const key = (hash: string, size: number) => `${hash}.${size}`;
  const check = (hash: string, size: number) => {
    if (typeof hash !== "string" || !HASH.test(hash)) throw codeError("invalid", "an upload names its SHA-256 as 64 hex characters");
    if (!Number.isInteger(size) || size < 0) throw codeError("invalid", "bad upload size");
    if (size > UPLOAD_FILE_MAX) throw codeError("limit", `a file is at most ${UPLOAD_FILE_MAX / 1e6} MB`);
  };
  const drop = (k: string) => { const e = entries.get(k); if (e) { e.file.discard(); entries.delete(k); } };
  const finish = (k: string, hash: string, e: Entry) => {
    entries.delete(k);
    if (e.hasher.digest("hex") !== hash) { e.file.discard(); throw codeError("corrupt", `file ${hash.slice(0, 12)} does not match its hash; nothing was stored`); }
    try { e.file.promote(hash); } catch (err) { e.file.discard(); throw err; }
  };
  const open = (hash: string, size: number): Entry | null => {
    const k = key(hash, size);
    let e = entries.get(k);
    if (!e) {
      if (lib.hasContent(hash)) return null;
      let staged = 0; for (const [ek] of entries) staged += Number(ek.slice(65));
      if (staged + size > UPLOAD_STAGING_MAX) throw codeError("limit", `at most ${UPLOAD_STAGING_MAX / 1e6} MB of uploads can be in progress`);
      e = { file: lib.openStaging(k), hasher: crypto.createHash("sha256"), touchedAt: now() };
      entries.set(k, e);
      if (size === 0) { finish(k, hash, e); return null; }
    }
    e.touchedAt = now();
    return e;
  };

  return {
    held(hash, size) {
      check(hash, size);
      return open(hash, size)?.file.size ?? size;
    },
    write(hash, size, offset, bytes) {
      check(hash, size);
      offered += bytes.length;
      const e = open(hash, size); if (!e) return size;
      const held = e.file.size;
      if (!Number.isInteger(offset) || offset < 0 || offset > held) return held;
      const skip = held - offset;
      if (skip >= bytes.length) return held;
      const tail = bytes.subarray(skip, skip + (size - held));
      try { e.file.append(tail); e.hasher.update(tail); } catch (err) { drop(key(hash, size)); throw err; }
      if (e.file.size === size) { finish(key(hash, size), hash, e); return size; }
      return e.file.size;
    },
    sweep(idleMs = UPLOAD_IDLE_MS) {
      let n = 0;
      for (const [k, e] of entries) if (now() - e.touchedAt >= idleMs) { drop(k); n++; }
      return n;
    },
    inspect: () => ({
      entries: [...entries].map(([k, e]) => ({ hash: k.slice(0, 12), size: Number(k.slice(65)), held: e.file.size, idleMs: now() - e.touchedAt })),
      offered,
    }),
  };
}

function codeError(code: string, message: string): Error { return Object.assign(new Error(message), { code }); }
