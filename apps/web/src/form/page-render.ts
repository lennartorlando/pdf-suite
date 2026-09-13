/**
 * Fill-surface page rendering. Shares the lazy-loading discipline of the
 * thumbnail loader (the display module resolves on first use only, the
 * worker is a same-origin emitted asset) but configures the renderer asset
 * prefixes the fill corpus needs: JBIG2/JPEG2000/qcms WebAssembly, the
 * standard fonts and the bundled ICC profile all resolve from the app's own
 * origin per KTD19. Scripting and dynamic evaluation stay disabled.
 */

import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist/types/src/pdf.js";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { PDFJS_PINNED_VERSION } from "@pdf-compressor/core/pdfjs-version";

export interface FormPageInfo {
  /** Page view box in unrotated user space: [x1, y1, x2, y2]. */
  readonly viewBox: readonly [number, number, number, number];
  readonly rotation: number;
  /** CSS pixel dimensions at scale 1 (rotation applied). */
  readonly width: number;
  readonly height: number;
}

export interface FormPageHandle {
  readonly info: FormPageInfo;
  /** Render into the canvas at a CSS scale; returns a cancellable task. */
  render(canvas: HTMLCanvasElement, scale: number): CancellableRender;
}

export interface CancellableRender {
  readonly done: Promise<unknown>;
  cancel(): void;
}

export interface FormDocumentHandle {
  readonly pageCount: number;
  getPage(pageNumber: number): Promise<FormPageHandle>;
  destroy(): Promise<void> | void;
}

export interface FormDocumentLoader {
  openDocument(data: Uint8Array): Promise<FormDocumentHandle>;
}

/**
 * Same-origin renderer asset prefixes. Vite emits the pinned package's
 * wasm, standard_fonts and iccs directories under this prefix; pdf.js joins
 * them as `${wasmUrl}jbig2.wasm` and so on, so each must end in a slash.
 */
export function pdfjsAssetUrls(base: string = document.baseURI): {
  wasmUrl: string;
  standardFontDataUrl: string;
  iccUrl: string;
} {
  const prefix = new URL("assets/pdfjs/", base).href;
  return {
    wasmUrl: `${prefix}wasm/`,
    standardFontDataUrl: `${prefix}standard_fonts/`,
    iccUrl: `${prefix}iccs/`
  };
}

/**
 * Document parameters for the fill surface: the child-process safety flags
 * plus the local asset configuration. `isEvalSupported` is honored by the
 * runtime though absent from the declared parameter type.
 */
export function formDocumentParams(data: Uint8Array): Record<string, unknown> {
  return {
    data,
    isEvalSupported: false,
    enableScripting: false,
    useSystemFonts: false,
    isImageDecoderSupported: false,
    disableAutoFetch: true,
    ...pdfjsAssetUrls()
  };
}

interface RealPdfJsApi {
  getDocument(params: Record<string, unknown>): {
    promise: Promise<PDFDocumentProxy>;
    destroy(): Promise<void>;
  };
}

let configured: Promise<RealPdfJsApi> | null = null;

function api(): Promise<RealPdfJsApi> {
  if (!configured) {
    configured = import("pdfjs-dist/build/pdf.min.mjs").then((pdfJs) => {
      if (typeof pdfJs.version === "string" && pdfJs.version !== PDFJS_PINNED_VERSION) {
        throw new Error(`Mismatched PDF.js release ${pdfJs.version}; expected local ${PDFJS_PINNED_VERSION}.`);
      }
      pdfJs.GlobalWorkerOptions.workerSrc = workerUrl;
      return pdfJs;
    });
  }
  return configured;
}

export function createFormPdfLoader(): FormDocumentLoader {
  return {
    async openDocument(data: Uint8Array): Promise<FormDocumentHandle> {
      const pdfJs = await api();
      const loadingTask = pdfJs.getDocument(formDocumentParams(data));
      const document = await loadingTask.promise;
      return {
        pageCount: document.numPages,
        getPage: async (pageNumber: number): Promise<FormPageHandle> => {
          const page = await document.getPage(pageNumber);
          const unit = page.getViewport({ scale: 1 });
          const info: FormPageInfo = {
            viewBox: [unit.viewBox[0], unit.viewBox[1], unit.viewBox[2], unit.viewBox[3]],
            rotation: unit.rotation,
            width: unit.width,
            height: unit.height
          };
          return {
            info,
            render: (canvas: HTMLCanvasElement, scale: number): CancellableRender => {
              const viewport = page.getViewport({ scale });
              canvas.width = Math.max(1, Math.ceil(viewport.width));
              canvas.height = Math.max(1, Math.ceil(viewport.height));
              canvas.style.width = `${viewport.width}px`;
              canvas.style.height = `${viewport.height}px`;
              const task = page.render({ canvas, viewport });
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
