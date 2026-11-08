/** Opt-in opening measurements. The observer and sink belong to this page, never to a Screen. */
export interface RequestObservation { readonly operation: string; readonly start: number; readonly duration: number; readonly bytes?: number }

let observer: ((value: RequestObservation) => void) | undefined;
let sink: ((value: unknown) => Promise<void>) | undefined;

export function observeOpeningRequests(cb: ((value: RequestObservation) => void) | undefined): void { observer = cb; }

export function openingRequest<T>(operation: string, request: () => Promise<T>): Promise<T> {
  const cb = observer;
  if (!cb) return request();
  const start = performance.now();
  const finish = () => { try { cb({ operation, start, duration: performance.now() - start }); } catch { /* Diagnostics cannot change request outcomes. */ } };
  try { return request().then((value) => { finish(); return value; }, (error: unknown) => { finish(); throw error; }); }
  catch (error) { finish(); throw error; }
}

export function setOpeningTraceSink(value: ((trace: unknown) => Promise<void>) | undefined): void { sink = value; }

export function submitOpeningTrace(value: unknown): Promise<void> {
  if (!sink) return Promise.reject(new Error("Opening trace collection is not configured"));
  return sink(value);
}
