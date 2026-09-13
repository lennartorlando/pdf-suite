/**
 * Lazy, bounded PDF.js preview boundary.
 *
 * The `pdfjs-dist` display module is loaded only through `createPdfJsLoader()`
 * via a dynamic editor-only import, so the compressor shell never evaluates
 * it. The matching worker is emitted locally by Vite through the `?url`
 * import below (same package, therefore same version), and no remote assets
 * or the generic PDF.js viewer are used.
 *
 * Rendering stays bounded: at most two concurrent render tasks, at most 40
 * mounted thumbnails, and at most 32 MiB of decoded thumbnail canvases.
 * Off-screen work is cancelled and a PDF.js document is destroyed when its
 * source leaves the workspace. The queue and store are DOM-free so jsdom
 * tests can drive them with fake tasks; only `renderPageToCanvas` touches a
 * real canvas and it no-ops when no 2D context exists.
 */

import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist/types/src/pdf.js";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { PDFJS_PINNED_VERSION } from "@pdf-compressor/core/pdfjs-version";

export { PDFJS_PINNED_VERSION };

/** At most two concurrent thumbnail render tasks. */
export const MAX_CONCURRENT_RENDER_TASKS = 2;
/** At most 40 mounted thumbnails. */
export const MAX_MOUNTED_THUMBNAILS = 40;
/** At most 32 MiB of decoded thumbnail canvases. */
export const MAX_DECODED_CANVAS_BYTES = 32 * 1024 * 1024;

/**
 * Document parameters accepted by the pinned PDF.js release. `isEvalSupported`
 * is honored by older releases and ignored where evaluation no longer exists;
 * `enableScripting` keeps embedded actions inert either way.
 */
export interface SecureDocumentParams {
  data: Uint8Array;
  isEvalSupported: false;
  enableScripting: false;
  disableAutoFetch?: boolean;
}
export interface PdfJsDocumentHandle {
  readonly pageCount: number;
  getPage(pageNumber: number): Promise<RenderablePdfPage>;
  destroy(): Promise<void> | void;
}

export interface RenderablePdfPage {
  readonly width: number;
  readonly height: number;
  render(canvas: HTMLCanvasElement): CancellableRender;
}

export interface CancellableRender {
  readonly done: Promise<unknown>;
  cancel(): void;
}

/** Opens one PDF.js document per byte buffer. Each task owns its buffer. */
export interface PdfPreviewLoader {
  openDocument(data: Uint8Array): Promise<PdfJsDocumentHandle>;
}

/** Decoded canvas cost model: 4 bytes per pixel (RGBA). */
export function thumbnailByteSize(width: number, height: number): number {
  return Math.max(0, Math.floor(width)) * Math.max(0, Math.floor(height)) * 4;
}

/**
 * Release a decoded canvas backing store. Resetting the dimensions drops
 * the pixel buffer in every browser engine (setting `width` alone already
 * clears the bitmap), so no 2D context is needed here.
 */
function releaseCanvasBacking(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
}

/**
 * Real lazy loader. The display module resolves on first use only; the
 * worker URL is a Vite-emitted local asset from the same pinned package.
 * Scripting and dynamic evaluation stay disabled and optional font/CMap
 * assets are never configured, so nothing is fetched beyond the worker.
 */
export function createPdfJsLoader(): PdfPreviewLoader {
  let configured: Promise<RealPdfJsApi> | null = null;
  const api = (): Promise<RealPdfJsApi> => {
    if (!configured) configured = configurePdfJs();
    return configured;
  };
  return {
    async openDocument(data: Uint8Array): Promise<PdfJsDocumentHandle> {
      const pdfJs = await api();
      const loadingTask = pdfJs.getDocument(secureDocumentParams(data));
      const document = await loadingTask.promise;
      return {
        pageCount: document.numPages,
        getPage: async (pageNumber: number): Promise<RenderablePdfPage> => {
          const page = await document.getPage(pageNumber);
          const viewport = page.getViewport({ scale: 1 });
          return {
            width: viewport.width,
            height: viewport.height,
            render: (canvas: HTMLCanvasElement): CancellableRender => {
              const targetWidth = 240;
              const scale = targetWidth / viewport.width;
              const scaled = page.getViewport({ scale });
              canvas.width = Math.max(1, Math.round(scaled.width));
              canvas.height = Math.max(1, Math.round(scaled.height));
              const task = page.render({ canvas, viewport: scaled });
              return {
                done: task.promise,
                cancel: (): void => {
                  try {
                    task.cancel();
                  } catch {
                    // Already settled; cancellation is best effort.
                  }
                }
              };
            }
          };
        },
        destroy: (): Promise<void> => loadingTask.destroy()
      };
    }
  };
}

interface RealPdfJsApi {
  getDocument(params: SecureDocumentParams): { promise: Promise<PDFDocumentProxy>; destroy(): Promise<void> };
}

async function configurePdfJs(): Promise<RealPdfJsApi> {
  const pdfJs = await import("pdfjs-dist/build/pdf.min.mjs");
  if (typeof pdfJs.version === "string" && pdfJs.version !== PDFJS_PINNED_VERSION) {
    throw new Error(
      `Mismatched PDF.js release ${pdfJs.version}; expected local ${PDFJS_PINNED_VERSION}.`
    );
  }
  pdfJs.GlobalWorkerOptions.workerSrc = workerUrl;
  return pdfJs;
}

/** Options snapshot asserted by tests without loading the real module. */
export function secureDocumentParams(data: Uint8Array): SecureDocumentParams {
  return {
    data,
    isEvalSupported: false,
    enableScripting: false,
    disableAutoFetch: true
  };
}

export type QueueOutcome = "done" | "cancelled";

/**
 * Bounded FIFO of render tasks with at most `maxConcurrent` in flight.
 * `cancel` drops queued work or signals active work, whose slot remains held
 * until its `done` promise settles. Every scheduled task settles exactly once.
 */
export class ThumbnailWorkQueue {
  private running = 0;
  private readonly queued: Array<{
    key: string;
    start: (isCancelled: () => boolean) => CancellableRender;
    resolve: (outcome: QueueOutcome) => void;
    cancelled: boolean;
  }> = [];
  private readonly active = new Map<
    string,
    {
      abort: () => void;
      entry: { cancelled: boolean };
    }
  >();

  constructor(private readonly maxConcurrent: number = MAX_CONCURRENT_RENDER_TASKS) {}

  get activeCount(): number {
    return this.running;
  }

  get pendingCount(): number {
    return this.queued.length;
  }

  schedule(key: string, start: (isCancelled: () => boolean) => CancellableRender): Promise<QueueOutcome> {
    this.cancel(key);
    return new Promise<QueueOutcome>((resolve) => {
      this.queued.push({ key, start, resolve, cancelled: false });
      this.pump();
    });
  }

  cancel(key: string): void {
    const queuedIndex = this.queued.findIndex((entry) => entry.key === key);
    if (queuedIndex >= 0) {
      const [entry] = this.queued.splice(queuedIndex, 1);
      entry.cancelled = true;
      entry.resolve("cancelled");
    }
    const running = this.active.get(key);
    if (running) {
      running.entry.cancelled = true;
      try {
        running.abort();
      } catch {
        // Cancellation is best effort; `done` still owns slot release.
      }
    }
  }

  cancelAll(): void {
    for (const entry of this.queued.splice(0)) {
      entry.cancelled = true;
      entry.resolve("cancelled");
    }
    for (const running of [...this.active.values()]) {
      running.entry.cancelled = true;
      try {
        running.abort();
      } catch {
        // Best effort.
      }
    }
  }

  private pump(): void {
    while (this.running < this.maxConcurrent && this.queued.length > 0) {
      const runnableIndex = this.queued.findIndex((entry) => !entry.cancelled && !this.active.has(entry.key));
      if (runnableIndex < 0) return;
      const [entry] = this.queued.splice(runnableIndex, 1);
      if (!entry) continue;
      this.running += 1;
      const record = { cancelled: false };
      let settled = false;
      const settle = (outcome: QueueOutcome): void => {
        if (settled) return;
        settled = true;
        this.active.delete(entry.key);
        this.running -= 1;
        entry.resolve(outcome);
        this.pump();
      };
      let task: CancellableRender;
      try {
        task = entry.start(() => record.cancelled || entry.cancelled);
      } catch {
        settle("cancelled");
        continue;
      }
      const liveTask = task;
      this.active.set(entry.key, {
        entry: record,
        abort: (): void => {
          record.cancelled = true;
          liveTask.cancel();
        }
      });
      void Promise.resolve(liveTask.done).then(
        () => settle(record.cancelled || entry.cancelled ? "cancelled" : "done"),
        () => settle("cancelled")
      );
    }
  }
}

/**
 * Owns open documents plus mounted-thumbnail accounting. Evicts the
 * least-recently-used thumbnails while `trackMounted` keeps the 40-thumbnail
 * and 32 MiB bounds; returns evicted keys so the UI can unmount them.
 */
export class PreviewStore {
  private readonly documents = new Map<string, PdfJsDocumentHandle>();
  private readonly mounted = new Map<string, number>();
  private readonly canvasRefs = new Map<string, HTMLCanvasElement>();
  private mountedBytes = 0;
  readonly queue: ThumbnailWorkQueue;

  constructor(queue?: ThumbnailWorkQueue) {
    this.queue = queue ?? new ThumbnailWorkQueue();
  }

  registerDocument(sourceId: string, handle: PdfJsDocumentHandle): void {
    this.documents.set(sourceId, handle);
  }

  getDocument(sourceId: string): PdfJsDocumentHandle | undefined {
    return this.documents.get(sourceId);
  }

  /** Cancel that source's queued/active renders and destroy its document. */
  async removeSource(sourceId: string): Promise<void> {
    const prefix = `${sourceId}:`;
    for (const key of [...this.mounted.keys()]) {
      if (key.startsWith(prefix)) this.unmount(key);
    }
    // Cancel scheduled renders for this source without touching others.
    for (const key of [...this.renderKeysFor(sourceId)]) {
      this.queue.cancel(key);
    }
    const handle = this.documents.get(sourceId);
    this.documents.delete(sourceId);
    if (handle) {
      try {
        await handle.destroy();
      } catch {
        // Teardown is best effort.
      }
    }
  }

  private readonly scheduledKeys = new Map<string, symbol>();

  /** Schedule a render while remembering the key for source teardown. */
  scheduleRender(key: string, start: (isCancelled: () => boolean) => CancellableRender): Promise<QueueOutcome> {
    const scheduleId = Symbol(key);
    this.scheduledKeys.set(key, scheduleId);
    return this.queue.schedule(key, start).finally(() => {
      if (this.scheduledKeys.get(key) === scheduleId) this.scheduledKeys.delete(key);
    }) as Promise<QueueOutcome>;
  }

  cancelRender(key: string): void {
    this.scheduledKeys.delete(key);
    this.queue.cancel(key);
  }

  private renderKeysFor(sourceId: string): string[] {
    const prefix = `${sourceId}:`;
    return [...this.scheduledKeys.keys()].filter((key) => key.startsWith(prefix));
  }

  trackMounted(key: string, bytes: number, canvas?: HTMLCanvasElement): string[] {
    const previous = this.mounted.get(key);
    if (previous !== undefined) {
      this.mountedBytes -= previous;
      this.mounted.delete(key);
    }
    const previousCanvas = this.canvasRefs.get(key);
    if (previousCanvas !== undefined && previousCanvas !== canvas) {
      releaseCanvasBacking(previousCanvas);
    }
    if (canvas !== undefined) {
      this.canvasRefs.set(key, canvas);
    } else if (previous === undefined) {
      this.canvasRefs.delete(key);
    }
    this.mounted.set(key, bytes);
    this.mountedBytes += bytes;
    const evicted: string[] = [];
    for (const [mountedKey, mountedBytes] of this.mounted) {
      if (this.mounted.size <= MAX_MOUNTED_THUMBNAILS && this.mountedBytes <= MAX_DECODED_CANVAS_BYTES) break;
      if (mountedKey === key && this.mounted.size === 1) break;
      this.mounted.delete(mountedKey);
      this.mountedBytes -= mountedBytes;
      this.cancelRender(mountedKey);
      const evictedCanvas = this.canvasRefs.get(mountedKey);
      this.canvasRefs.delete(mountedKey);
      if (evictedCanvas !== undefined) releaseCanvasBacking(evictedCanvas);
      evicted.push(mountedKey);
      if (mountedKey === key) break;
    }
    return evicted;
  }

  unmount(key: string): void {
    const bytes = this.mounted.get(key);
    if (bytes !== undefined) {
      this.mounted.delete(key);
      this.mountedBytes -= bytes;
    }
    const canvas = this.canvasRefs.get(key);
    if (canvas !== undefined) {
      this.canvasRefs.delete(key);
      releaseCanvasBacking(canvas);
    }
    this.cancelRender(key);
  }

  /** Snapshot of tracked thumbnail keys for stale-entry reconciliation. */
  mountedKeys(): string[] {
    return [...this.mounted.keys()];
  }

  /**
   * Unmount every tracked key not in `keep`, releasing its canvas backing
   * store and cancelling its pending render. Returns the removed keys.
   */
  unmountStale(keep: ReadonlySet<string>): string[] {
    const removed: string[] = [];
    for (const key of [...this.mounted.keys()]) {
      if (!keep.has(key)) {
        this.unmount(key);
        removed.push(key);
      }
    }
    return removed;
  }

  get mountedCount(): number {
    return this.mounted.size;
  }

  get decodedBytes(): number {
    return this.mountedBytes;
  }

  async destroy(): Promise<void> {
    this.queue.cancelAll();
    for (const canvas of [...this.canvasRefs.values()]) {
      releaseCanvasBacking(canvas);
    }
    this.canvasRefs.clear();
    this.mounted.clear();
    this.mountedBytes = 0;
    for (const [sourceId, handle] of [...this.documents]) {
      this.documents.delete(sourceId);
      try {
        await handle.destroy();
      } catch {
        // Best effort.
      }
    }
  }
}
