// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QPDF_SECURITY_FLOOR } from "@pdf-compressor/core/native-floors";
import { resetAuthStateForTests } from "../src/api/client.js";
import { mountApp } from "../src/App.js";
import { createPageEditor } from "../src/components/PageEditor.js";
import {
  PreviewStore,
  thumbnailByteSize,
  type PdfJsDocumentHandle,
  type PdfPreviewLoader
} from "../src/editor/pdf-preview.js";

/* ---------------------------------- fakes ---------------------------------- */

function makePdfFile(name: string, size: number): File {
  const file = new File([new Uint8Array(size)], name, { type: "application/pdf" });
  if (typeof file.arrayBuffer !== "function") {
    Object.defineProperty(file, "arrayBuffer", { value: async () => new Uint8Array(size).buffer });
  }
  return file;
}

interface FakeDoc extends PdfJsDocumentHandle {
  destroyed: number;
}

function fakeDocument(pageCount: number): FakeDoc {
  const doc: FakeDoc = {
    pageCount,
    destroyed: 0,
    getPage: async (pageNumber: number) => ({
      width: 100,
      height: 140,
      render: (canvas: HTMLCanvasElement) => {
        if (pageNumber < 1) throw new Error("bad page");
        canvas.width = 60;
        canvas.height = 80;
        return { done: Promise.resolve(), cancel: (): void => undefined };
      }
    }),
    destroy: (): void => {
      doc.destroyed += 1;
    }
  };
  return doc;
}

function createFakeLoader(counts: number[]): { loader: PdfPreviewLoader; opened: Uint8Array[] } {
  const opened: Uint8Array[] = [];
  let calls = 0;
  return {
    opened,
    loader: {
      openDocument: async (data: Uint8Array): Promise<PdfJsDocumentHandle> => {
        opened.push(data);
        const doc = fakeDocument(counts[calls] ?? 1);
        calls += 1;
        return doc;
      }
    }
  };
}

interface FetchCall {
  url: string;
  init: RequestInit & { headers?: Headers };
}

const TOKEN = "t".repeat(64);
const HANDLE = "h".repeat(32);

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => payload,
    blob: async () => new Blob(["%PDF-1.4 fake"], { type: "application/pdf" })
  } as Response;
}

function downloadResponse(): Response {
  return {
    status: 200,
    ok: true,
    json: async () => ({}),
    blob: async () => new Blob(["%PDF-1.4 fake"], { type: "application/pdf" })
  } as Response;
}

const tick = async (rounds = 5): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

async function addTestFiles(editor: HTMLElement, files: File[]): Promise<void> {
  const input = editor.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, "files", { value: files, configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await tick(10);
}

beforeEach(() => {
  resetAuthStateForTests();
  vi.unstubAllGlobals();
  Object.defineProperty(URL, "createObjectURL", {
    value: vi.fn(() => "blob:fake-download"),
    configurable: true
  });
  Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

/* ------------------- 1. compressor authenticated download ------------------- */

function stubCompressorFetch(calls: FetchCall[], gateCompress: boolean): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}): Promise<Response> => {
      calls.push({ url, init: init as FetchCall["init"] });
      if (url === "/api/session/launch") {
        return jsonResponse({ ok: true, token: TOKEN, expiresInMs: 300_000 });
      }
      if (url.startsWith("/api/compress")) {
        if (gateCompress) {
          return new Promise<Response>((_, reject) => {
            const signal = (init.signal ?? null) as AbortSignal | null;
            if (signal?.aborted) {
              reject(new DOMException("Aborted", "AbortError"));
              return;
            }
            signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
              once: true
            });
          });
        }
        return jsonResponse({
          ok: true,
          handle: HANDLE,
          downloadUrl: `/api/outputs/${HANDLE}/download`,
          summary: {
            status: "success",
            inputPath: "upload.pdf",
            outputPath: "compressed.pdf",
            profile: "balanced",
            originalBytes: 1000,
            outputBytes: 800,
            reductionBytes: 200,
            reductionPercent: 20,
            outputSmaller: true,
            engine: "ghostscript",
            warnings: []
          }
        });
      }
      if (url.includes("/api/outputs/") && url.endsWith("/download")) {
        return downloadResponse();
      }
      return jsonResponse({ ok: true }, 200);
    })
  );
}

describe("compressor authenticated download", () => {
  it("sends token+cookies on the protected download and shows a blob link", async () => {
    const calls: FetchCall[] = [];
    stubCompressorFetch(calls, false);
    const root = document.createElement("main");
    document.body.append(root);
    mountApp(root);

    const input = root.querySelector('.dropzone input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [makePdfFile("in.pdf", 100)], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await tick(3);

    const buttons = [...root.querySelectorAll(".actions .button")] as HTMLButtonElement[];
    expect(buttons[0].disabled).toBe(false);
    buttons[0].click();
    await tick(10);

    const download = calls.find((call) => call.url.includes("/api/outputs/"));
    expect(download).toBeDefined();
    expect(download?.init.headers?.get("x-launch-token")).toBe(TOKEN);
    expect(download?.init.credentials).toBe("include");

    const anchor = root.querySelector(".result a") as HTMLAnchorElement | null;
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute("href")).toBe("blob:fake-download");
    expect(anchor?.getAttribute("href")).not.toContain("/api/outputs");
    expect(URL.createObjectURL).toHaveBeenCalled();
  });

  it("preserves cancellation across compress plus authenticated download", async () => {
    const calls: FetchCall[] = [];
    stubCompressorFetch(calls, true);
    const root = document.createElement("main");
    document.body.append(root);
    mountApp(root);

    const input = root.querySelector('.dropzone input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [makePdfFile("in.pdf", 100)], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await tick(3);

    const buttons = [...root.querySelectorAll(".actions .button")] as HTMLButtonElement[];
    buttons[0].click();
    await tick(3);
    buttons[1].click();
    await tick(5);

    expect(root.textContent).toContain("Compression cancelled.");
    expect(root.querySelector(".result a")).toBeNull();
  });

  it("revokes the blob URL when a new result replaces it", async () => {
    const calls: FetchCall[] = [];
    stubCompressorFetch(calls, false);
    const root = document.createElement("main");
    document.body.append(root);
    mountApp(root);

    const input = root.querySelector('.dropzone input[type="file"]') as HTMLInputElement;
    const select = async (): Promise<void> => {
      Object.defineProperty(input, "files", { value: [makePdfFile("in.pdf", 100)], configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await tick(3);
    };
    await select();
    const buttons = [...root.querySelectorAll(".actions .button")] as HTMLButtonElement[];
    buttons[0].click();
    await tick(10);
    expect(root.querySelector(".result a")).not.toBeNull();

    // Selecting a new file revokes the previous object URL.
    await select();
    expect(URL.revokeObjectURL).toHaveBeenCalled();
    expect(root.querySelector(".result a")).toBeNull();
  });
});

/* ---------------- 2. thumbnail eviction releases backing stores ------------- */

describe("thumbnail eviction", () => {
  it("releases evicted canvas dimensions once past 40 thumbnails", () => {
    const store = new PreviewStore();
    const canvases: HTMLCanvasElement[] = [];
    for (let i = 0; i < 40; i += 1) {
      const canvas = document.createElement("canvas");
      canvas.width = 60;
      canvas.height = 80;
      canvases.push(canvas);
      expect(store.trackMounted(`s:1@${i}`, thumbnailByteSize(60, 80), canvas)).toEqual([]);
    }
    expect(store.mountedCount).toBe(40);

    const victim = canvases[0];
    expect(victim.width).toBe(60);
    const fresh = document.createElement("canvas");
    fresh.width = 60;
    fresh.height = 80;
    expect(store.trackMounted("s:1@40", thumbnailByteSize(60, 80), fresh)).toEqual(["s:1@0"]);
    expect(store.mountedCount).toBe(40);
    expect(victim.width).toBe(0);
    expect(victim.height).toBe(0);
  });

  it("releases evicted canvases under the 32 MiB byte cap", () => {
    const store = new PreviewStore();
    const first = document.createElement("canvas");
    first.width = 10;
    first.height = 10;
    expect(store.trackMounted("s:1@0", 20 * 1024 * 1024, first)).toEqual([]);
    const second = document.createElement("canvas");
    second.width = 10;
    second.height = 10;
    expect(store.trackMounted("s:1@1", 20 * 1024 * 1024, second)).toEqual(["s:1@0"]);
    expect(first.width).toBe(0);
    expect(first.height).toBe(0);
    expect(store.decodedBytes).toBe(20 * 1024 * 1024);
  });

  it("cancels the pending render of an evicted key", async () => {
    const store = new PreviewStore();
    let finishRender!: () => void;
    const pending = store.scheduleRender("s:9@0", () => ({
      done: new Promise<void>((resolve) => {
        finishRender = resolve;
      }),
      cancel: (): void => finishRender()
    }));
    void pending;
    await tick(2);

    const first = document.createElement("canvas");
    first.width = 10;
    first.height = 10;
    expect(store.trackMounted("s:9@0", 1024, first)).toEqual([]);
    for (let i = 1; i <= 40; i += 1) {
      const canvas = document.createElement("canvas");
      canvas.width = 10;
      canvas.height = 10;
      store.trackMounted(`s:9@${i}`, 1024, canvas);
    }
    await expect(pending).resolves.toBe("cancelled");
    expect(first.width).toBe(0);
    expect(first.height).toBe(0);
  });

  it("unmountStale releases canvases that leave the visible set", () => {
    const store = new PreviewStore();
    const keep = document.createElement("canvas");
    keep.width = 30;
    keep.height = 40;
    const stale = document.createElement("canvas");
    stale.width = 30;
    stale.height = 40;
    store.trackMounted("s:1@0", thumbnailByteSize(30, 40), keep);
    store.trackMounted("s:1@1", thumbnailByteSize(30, 40), stale);
    expect(store.unmountStale(new Set(["s:1@0"]))).toEqual(["s:1@1"]);
    expect(stale.width).toBe(0);
    expect(stale.height).toBe(0);
    expect(keep.width).toBe(30);
    expect(store.mountedCount).toBe(1);
  });

  it("cancels obsolete thumbnail tasks on reorder", async () => {
    const renderCancelSpies: Array<ReturnType<typeof vi.fn>> = [];
    const loader: PdfPreviewLoader = {
      openDocument: async (): Promise<PdfJsDocumentHandle> => ({
        pageCount: 3,
        getPage: async () => ({
          width: 100,
          height: 140,
          render: (canvas: HTMLCanvasElement) => {
            canvas.width = 60;
            canvas.height = 80;
            let finishRender!: () => void;
            const done = new Promise<void>((resolve) => {
              finishRender = resolve;
            });
            const spy = vi.fn(() => finishRender());
            renderCancelSpies.push(spy);
            return {
              done,
              cancel: (): void => {
                spy();
              }
            };
          }
        }),
        destroy: (): void => undefined
      })
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string): Promise<Response> => {
        if (url === "/api/session/launch") {
          return jsonResponse({ ok: true, token: TOKEN, expiresInMs: 300_000 });
        }
        return jsonResponse({
          ok: true,
          capabilities: {
            qpdf: { available: true, version: "12.4.1" },
            ghostscript: { available: true, version: "10.0.0" }
          }
        });
      })
    );
    const editor = createPageEditor({ onExit: () => undefined, loader });
    document.body.append(editor.element);
    await addTestFiles(editor.element, [makePdfFile("a.pdf", 500)]);
    await tick(10);
    const before = [...renderCancelSpies];

    const cards = [...editor.element.querySelectorAll<HTMLElement>(".thumb")];
    expect(cards.length).toBe(3);
    const moveRight = cards[0].querySelectorAll<HTMLButtonElement>(".thumb__controls button")[1];
    expect(moveRight.disabled).toBe(false);
    // Reorder the first page later: a full refresh must cancel old tasks
    // and schedule fresh renders for the new key set.
    moveRight.click();
    await tick(10);
    for (const spy of before) {
      expect(spy).toHaveBeenCalled();
    }
    expect(renderCancelSpies.length).toBeGreaterThan(before.length);
    editor.destroy();
  });
});

/* ----------------------- 3. pre-allocation file limit ----------------------- */

describe("pre-allocation file limit", () => {
  it("does not open a document when byte reading finishes after editor teardown", async () => {
    let releaseBytes!: () => void;
    const bytesReady = new Promise<void>((resolve) => {
      releaseBytes = resolve;
    });
    const openDocument = vi.fn(async () => fakeDocument(1));
    const loader: PdfPreviewLoader = { openDocument };
    const file = {
      name: "late-read.pdf",
      size: 500,
      arrayBuffer: async (): Promise<ArrayBuffer> => {
        await bytesReady;
        return new Uint8Array(500).buffer;
      }
    } as File;
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      ok: true,
      capabilities: {
        qpdf: { available: true, version: "12.4.1" },
        ghostscript: { available: true, version: "10.0.0" }
      }
    })));
    const editor = createPageEditor({ onExit: () => undefined, loader });
    document.body.append(editor.element);

    const input = editor.element.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await tick(2);
    editor.destroy();
    releaseBytes();
    await tick(5);

    expect(openDocument).not.toHaveBeenCalled();
    expect(editor.element.querySelectorAll(".filelist li")).toHaveLength(0);
  });

  it("destroys a document that finishes opening after editor teardown", async () => {
    let releaseOpen!: (document: PdfJsDocumentHandle) => void;
    const opening = new Promise<PdfJsDocumentHandle>((resolve) => {
      releaseOpen = resolve;
    });
    const loader: PdfPreviewLoader = { openDocument: async () => opening };
    const lateDocument = fakeDocument(1);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      ok: true,
      capabilities: {
        qpdf: { available: true, version: "12.4.1" },
        ghostscript: { available: true, version: "10.0.0" }
      }
    })));
    const editor = createPageEditor({ onExit: () => undefined, loader });
    document.body.append(editor.element);

    const input = editor.element.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [makePdfFile("late-open.pdf", 500)], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await tick(2);
    editor.destroy();
    releaseOpen(lateDocument);
    await tick(5);

    expect(lateDocument.destroyed).toBe(1);
    expect(editor.element.querySelectorAll(".filelist li")).toHaveLength(0);
  });

  it("rejects an over-limit file without reading its bytes", async () => {
    const fake = createFakeLoader([1]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string): Promise<Response> => {
        if (url === "/api/session/launch") {
          return jsonResponse({ ok: true, token: TOKEN, expiresInMs: 300_000 });
        }
        return jsonResponse({
          ok: true,
          capabilities: {
            qpdf: { available: true, version: "12.4.1" },
            ghostscript: { available: true, version: "10.0.0" }
          }
        });
      })
    );
    const editor = createPageEditor({ onExit: () => undefined, loader: fake.loader });
    document.body.append(editor.element);

    let reads = 0;
    const evil = {
      name: "huge.pdf",
      size: 100 * 1024 * 1024 + 1,
      arrayBuffer: async (): Promise<ArrayBuffer> => {
        reads += 1;
        throw new Error("must not be read");
      }
    } as unknown as File;
    await addTestFiles(editor.element, [evil]);

    expect(reads).toBe(0);
    expect(fake.opened).toHaveLength(0);
    expect(editor.element.textContent).toContain("100 MiB");
    expect(editor.element.querySelectorAll(".thumb")).toHaveLength(0);
    editor.destroy();
  });

  it("rejects an over-limit aggregate without reading the newcomer", async () => {
    const fake = createFakeLoader([1]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string): Promise<Response> => {
        if (url === "/api/session/launch") {
          return jsonResponse({ ok: true, token: TOKEN, expiresInMs: 300_000 });
        }
        return jsonResponse({
          ok: true,
          capabilities: {
            qpdf: { available: true, version: "12.4.1" },
            ghostscript: { available: true, version: "10.0.0" }
          }
        });
      })
    );
    const editor = createPageEditor({ onExit: () => undefined, loader: fake.loader });
    document.body.append(editor.element);
    await addTestFiles(editor.element, [makePdfFile("ok.pdf", 500)]);
    expect(fake.opened).toHaveLength(1);

    let reads = 0;
    const evil = {
      name: "big2.pdf",
      size: 100 * 1024 * 1024,
      arrayBuffer: async (): Promise<ArrayBuffer> => {
        reads += 1;
        throw new Error("must not be read");
      }
    } as unknown as File;
    await addTestFiles(editor.element, [evil]);

    expect(reads).toBe(0);
    expect(fake.opened).toHaveLength(1);
    expect(editor.element.textContent).toContain("100 MiB");
    editor.destroy();
  });
});

/* ------------------------- 4. qpdf setup guidance --------------------------- */

describe("qpdf setup guidance", () => {
  it("shares one current floor value and displays 12.4.1", async () => {
    expect(QPDF_SECURITY_FLOOR).toBe("12.4.1");
    const editorSource = readFileSync("apps/web/src/components/PageEditor.ts", "utf8");
    expect(editorSource).toContain("@pdf-compressor/core/native-floors");

    const fake = createFakeLoader([1]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string): Promise<Response> => {
        if (url === "/api/session/launch") {
          return jsonResponse({ ok: true, token: TOKEN, expiresInMs: 300_000 });
        }
        return jsonResponse({
          ok: true,
          capabilities: {
            qpdf: { available: false, version: null },
            ghostscript: { available: false, version: null }
          }
        });
      })
    );
    const editor = createPageEditor({ onExit: () => undefined, loader: fake.loader });
    document.body.append(editor.element);
    await addTestFiles(editor.element, [makePdfFile("a.pdf", 500)]);
    await tick(10);
    expect(editor.element.textContent).toContain("12.4.1");
    expect(editor.element.textContent).not.toContain("11.9.0");
    editor.destroy();
  });
});

/* ------------------- 5. consumed export handle truthfulness ------------------ */

describe("consumed export handle", () => {
  it("keeps only the local blob link and never discards a consumed output", async () => {
    const fake = createFakeLoader([2]);
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}): Promise<Response> => {
        calls.push({ url, init: init as FetchCall["init"] });
        if (url === "/api/session/launch") {
          return jsonResponse({ ok: true, token: TOKEN, expiresInMs: 300_000 });
        }
        if (url === "/api/capabilities") {
          return jsonResponse({
            ok: true,
            capabilities: {
              qpdf: { available: true, version: "12.4.1" },
              ghostscript: { available: true, version: "10.0.0" }
            }
          });
        }
        if (url.startsWith("/api/pages/export")) {
          return jsonResponse({
            ok: true,
            handle: HANDLE,
            downloadUrl: `/api/outputs/${HANDLE}/download`,
            status: "success",
            pageCount: 2,
            outputBytes: 100,
            engine: "qpdf",
            warnings: [],
            compatWarnings: []
          });
        }
        if (url.includes("/api/outputs/") && url.endsWith("/download")) {
          return downloadResponse();
        }
        return jsonResponse({ ok: true }, 200);
      })
    );
    const editor = createPageEditor({ onExit: () => undefined, loader: fake.loader });
    document.body.append(editor.element);
    await addTestFiles(editor.element, [makePdfFile("a.pdf", 500)]);

    (editor.element.querySelector(".exportrow .button") as HTMLButtonElement).click();
    await tick(10);

    expect(editor.element.textContent).toContain("Export ready");
    const link = editor.element.querySelector(".result--inline a") as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("blob:fake-download");
    expect(link?.getAttribute("href")).not.toContain("/api/outputs");
    expect(editor.element.textContent).not.toContain("Discard export");
    expect(editor.element.textContent).not.toContain("works once");
    expect(
      calls.some((call) => call.init.method === "DELETE" && call.url.includes("/api/outputs"))
    ).toBe(false);

    const download = calls.find((call) => call.url.includes("/api/outputs/"));
    expect(download?.init.headers?.get("x-launch-token")).toBe(TOKEN);
    expect(download?.init.credentials).toBe("include");

    // The local link stays usable until the user clears it; clearing only
    // revokes the object URL and never touches the consumed server handle.
    const clear = [...editor.element.querySelectorAll<HTMLButtonElement>(".result--inline button")].find(
      (button) => button.textContent === "Clear result"
    );
    expect(clear).toBeDefined();
    clear?.click();
    await tick(2);
    expect(URL.revokeObjectURL).toHaveBeenCalled();
    expect(
      calls.some((call) => call.init.method === "DELETE" && call.url.includes("/api/outputs"))
    ).toBe(false);
    editor.destroy();
  });
});

/* ---------------- 6. browser-safe import boundary (whole tree) -------------- */

/**
 * Every `@pdf-compressor/core` and `pdfjs-dist` specifier anywhere under
 * `apps/web/src` must be an explicitly browser-safe subpath. Root imports are
 * flagged even when type-only, and unknown subpaths fail too — the renderer
 * now lives in core, so a stray root import pulls Node-coupled engines into
 * the browser bundle.
 */
const BROWSER_SAFE_SPECIFIERS = new Set([
  "@pdf-compressor/core/form-inventory",
  "@pdf-compressor/core/form-plan",
  "@pdf-compressor/core/native-floors",
  "@pdf-compressor/core/ocr-contract",
  "@pdf-compressor/core/page-manifest",
  "@pdf-compressor/core/pdfjs-version",
  "@pdf-compressor/core/schema-error",
  "pdfjs-dist/build/pdf.min.mjs",
  "pdfjs-dist/build/pdf.worker.min.mjs?url",
  "pdfjs-dist/types/src/pdf.js"
]);

const SPECIFIER_PATTERN =
  /\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']|\bimport\s+["']([^"']+)["']/g;

function webSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...webSourceFiles(path));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      files.push(path);
    }
  }
  return files;
}

describe("browser-safe import boundary", () => {
  it("permits only browser-safe subpaths across the whole web source tree", () => {
    const files = webSourceFiles("apps/web/src");
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(SPECIFIER_PATTERN)) {
        const specifier = match.slice(1).find((part) => part !== undefined);
        if (
          specifier !== undefined &&
          (specifier === "pdfjs-dist" ||
            specifier === "@pdf-compressor/core" ||
            specifier.startsWith("pdfjs-dist/") ||
            specifier.startsWith("@pdf-compressor/core/")) &&
          !BROWSER_SAFE_SPECIFIERS.has(specifier)
        ) {
          offenders.push(`${file}: "${specifier}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
