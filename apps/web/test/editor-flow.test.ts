// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAuthStateForTests } from "../src/api/client.js";
import { createPageEditor } from "../src/components/PageEditor.js";
import {
  MAX_CONCURRENT_RENDER_TASKS,
  MAX_DECODED_CANVAS_BYTES,
  MAX_MOUNTED_THUMBNAILS,
  PreviewStore,
  secureDocumentParams,
  ThumbnailWorkQueue,
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

function fakeDocument(pageCount: number, onDestroy?: () => void): FakeDoc {
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
      onDestroy?.();
    }
  };
  return doc;
}

function createFakeLoader(counts: number[]): { loader: PdfPreviewLoader; opened: Uint8Array[]; docs: FakeDoc[] } {
  const opened: Uint8Array[] = [];
  const docs: FakeDoc[] = [];
  let calls = 0;
  return {
    opened,
    docs,
    loader: {
      openDocument: async (data: Uint8Array): Promise<PdfJsDocumentHandle> => {
        opened.push(data);
        const doc = fakeDocument(counts[calls] ?? 1);
        calls += 1;
        docs.push(doc);
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

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => payload,
    blob: async () => new Blob(["%PDF-1.4 fake"], { type: "application/pdf" })
  } as Response;
}

function installFetch(
  routes: {
    capabilities?: unknown;
    onExport?: (call: FetchCall) => Promise<Response> | Response;
  } = {}
): { calls: FetchCall[]; exportBodies: FormData[] } {
  const calls: FetchCall[] = [];
  const exportBodies: FormData[] = [];
  const capabilities = routes.capabilities ?? {
    ok: true,
    capabilities: {
      qpdf: { available: true, version: "12.4.1" },
      ghostscript: { available: true, version: "10.0.0" },
      ocrmypdf: { available: true, version: "17.11.0" },
      tesseract: { available: true, version: "5.5.3", languages: ["deu", "eng", "osd"] }
    }
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}): Promise<Response> => {
      calls.push({ url, init: init as FetchCall["init"] });
      if (url === "/api/session/launch") {
        return jsonResponse({ ok: true, token: TOKEN, expiresInMs: 300_000 });
      }
      if (url === "/api/capabilities") {
        return jsonResponse(capabilities);
      }
      if (url.startsWith("/api/pages/export")) {
        const body = init.body as FormData;
        exportBodies.push(body);
        if (routes.onExport) return routes.onExport({ url, init: init as FetchCall["init"] });
        return jsonResponse({
          ok: true,
          handle: "h".repeat(32),
          downloadUrl: `/api/outputs/${"h".repeat(32)}/download`,
          status: "success",
          pageCount: 2,
          outputBytes: 100,
          engine: "qpdf",
          warnings: [],
          compatWarnings: []
        });
      }
      if (url.includes("/api/outputs/") && url.endsWith("/download")) {
        return {
          status: 200,
          ok: true,
          json: async () => ({}),
          blob: async () => new Blob(["%PDF-1.4 fake"], { type: "application/pdf" })
        } as Response;
      }
      return jsonResponse({ ok: true }, 200);
    })
  );
  return { calls, exportBodies };
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

function thumbCards(editor: HTMLElement): HTMLElement[] {
  return [...editor.querySelectorAll<HTMLElement>(".thumb")];
}

function clickButton(editor: HTMLElement, selector: string): HTMLElement | null {
  const button = editor.querySelector<HTMLElement>(selector);
  button?.click();
  return button;
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

/* ------------------------------- lazy boundary ------------------------------ */

describe("editor lazy boundary", () => {
  it("keeps PDF.js and the editor out of the compressor shell", () => {
    const appSource = readFileSync("apps/web/src/App.ts", "utf8");
    expect(appSource).not.toMatch(/^import\s+(?!type)[^;]*PageEditor[^;]*from/m);
    expect(appSource).not.toMatch(/from\s*["']pdfjs-dist["']/);
    expect(appSource).toContain('import("./components/PageEditor.js")');
  });

  it("loads PDF.js only through a dynamic editor-only import with a local worker", () => {
    const previewSource = readFileSync("apps/web/src/editor/pdf-preview.ts", "utf8");
    expect(previewSource).toContain('await import("pdfjs-dist/build/pdf.min.mjs")');
    expect(previewSource).toContain("pdf.worker.min.mjs?url");
    expect(previewSource).not.toContain("mozilla");
    expect(previewSource).not.toContain("cdn");
  });

  it("keeps production security options without loading the real module", () => {
    const data = new Uint8Array([1, 2, 3]);
    const params = secureDocumentParams(data) as Record<string, unknown>;
    expect(params["data"]).toBe(data);
    expect(params["isEvalSupported"]).toBe(false);
    expect(params["enableScripting"]).toBe(false);
    expect(params["disableAutoFetch"]).toBe(true);
    const previewSource = readFileSync("apps/web/src/editor/pdf-preview.ts", "utf8");
    expect(previewSource).toContain("pdfJs.getDocument(secureDocumentParams(data))");
  });
});

/* -------------------------------- editor flow ------------------------------- */

describe("editor flow", () => {
  it("adds two same-named PDFs with distinct sources and local thumbnails", async () => {
    const fake = createFakeLoader([2, 1]);
    installFetch();
    const editor = createPageEditor({ onExit: () => undefined, loader: fake.loader });
    document.body.append(editor.element);

    await addTestFiles(editor.element, [makePdfFile("report.pdf", 500), makePdfFile("report.pdf", 700)]);
    await tick(10);

    expect(fake.opened).toHaveLength(2);
    expect(editor.element.querySelectorAll(".filelist li")).toHaveLength(2);
    expect(thumbCards(editor.element)).toHaveLength(3);
    expect(editor.element.textContent).toContain("0 of 3 selected");
  });

  it("performs reorder, rotate, delete, and selection with no per-gesture fetch", async () => {
    const fake = createFakeLoader([3]);
    const { calls } = installFetch();
    const editor = createPageEditor({ onExit: () => undefined, loader: fake.loader });
    document.body.append(editor.element);
    await addTestFiles(editor.element, [makePdfFile("a.pdf", 500)]);
    const baseline = calls.length;
    expect(baseline).toBeGreaterThan(0);

    const firstCard = thumbCards(editor.element)[0];
    const firstCanvas = firstCard.querySelector("canvas");

    // Selection and rotation update keyed cards without discarding canvases.
    (firstCard.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
    await tick();
    expect(thumbCards(editor.element)[0]).toBe(firstCard);
    expect(thumbCards(editor.element)[0].querySelector("canvas")).toBe(firstCanvas);
    (firstCard.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
    await tick();

    firstCard.querySelectorAll<HTMLButtonElement>(".thumb__controls button")[2].click();
    await tick();
    expect(thumbCards(editor.element)[0]).toBe(firstCard);
    expect(thumbCards(editor.element)[0].querySelector("canvas")).toBe(firstCanvas);
    expect(firstCard.querySelector(".thumb__rotation")?.textContent).toContain("90");

    // Move the rotated page last, then delete it.
    thumbCards(editor.element)[0].querySelectorAll<HTMLButtonElement>(".thumb__controls button")[1].click();
    await tick();
    (thumbCards(editor.element)[2].querySelector('input[type="checkbox"]') as HTMLInputElement).click();
    await tick();
    expect(editor.element.textContent).toContain("1 of 3 selected");
    thumbCards(editor.element)[2].querySelectorAll<HTMLButtonElement>(".thumb__controls button")[3].click();
    await tick();

    expect(thumbCards(editor.element)).toHaveLength(2);
    expect(calls.length).toBe(baseline);
  });

  it("exports a selection snapshot without changing the workspace", async () => {
    const fake = createFakeLoader([3]);
    const { exportBodies } = installFetch();
    const editor = createPageEditor({ onExit: () => undefined, loader: fake.loader });
    document.body.append(editor.element);
    await addTestFiles(editor.element, [makePdfFile("a.pdf", 500)]);

    const cards = thumbCards(editor.element);
    (cards[2].querySelector('input[type="checkbox"]') as HTMLInputElement).click();
    (cards[0].querySelector('input[type="checkbox"]') as HTMLInputElement).click();
    await tick();
    (editor.element.querySelector('input[value="selection"]') as HTMLInputElement).click();
    await tick();
    clickButton(editor.element, ".exportrow .button");
    await tick(10);

    expect(exportBodies).toHaveLength(1);
    const manifest = JSON.parse(exportBodies[0].get("manifest") as string) as {
      pages: Array<{ page: number }>;
    };
    expect(manifest.pages.map((entry) => entry.page)).toEqual([1, 3]);
    expect(exportBodies[0].getAll("source")).toHaveLength(1);
    expect(thumbCards(editor.element)).toHaveLength(3);
    expect(editor.element.textContent).toContain("Export ready");
  });

  it("exports searchable PDFs with both default languages and freezes OCR controls", async () => {
    const fake = createFakeLoader([2]);
    let releaseExport!: (response: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      releaseExport = resolve;
    });
    const { calls } = installFetch({ onExport: () => gate });
    const editor = createPageEditor({ onExit: () => undefined, loader: fake.loader });
    document.body.append(editor.element);
    await addTestFiles(editor.element, [makePdfFile("scan.pdf", 500)]);

    const toggle = editor.element.querySelector<HTMLInputElement>('input[name="export-ocr"]')!;
    const german = editor.element.querySelector<HTMLInputElement>('input[value="deu"]')!;
    const english = editor.element.querySelector<HTMLInputElement>('input[value="eng"]')!;
    expect(toggle.checked).toBe(false);
    expect(german.checked).toBe(true);
    expect(english.checked).toBe(true);
    toggle.click();
    await tick();
    const exportButton = editor.element.querySelector<HTMLButtonElement>(".exportrow .button")!;
    expect(exportButton.textContent).toBe("Export searchable PDF");
    exportButton.click();
    await tick();

    expect(toggle.disabled).toBe(true);
    expect(german.disabled).toBe(true);
    expect(english.disabled).toBe(true);
    const exportCall = calls.find((call) => call.url.startsWith("/api/pages/export"));
    expect(exportCall?.url).toBe("/api/pages/export?compression=none&ocr=deu%2Beng&ocrAutoRotate=true");

    releaseExport(jsonResponse({
      ok: true,
      handle: "h".repeat(32),
      downloadUrl: `/api/outputs/${"h".repeat(32)}/download`,
      status: "success",
      pageCount: 2,
      outputBytes: 100,
      engine: "ocrmypdf",
      ocr: {
        engine: "ocrmypdf",
        version: "17.11.0",
        tesseractVersion: "5.5.3",
        languages: ["deu", "eng"],
        autoRotate: true
      },
      warnings: [],
      compatWarnings: []
    }));
    await tick(10);
    expect(toggle.disabled).toBe(false);
  });

  it("disables searchable export when selected language data is missing", async () => {
    const fake = createFakeLoader([1]);
    installFetch({
      capabilities: {
        ok: true,
        capabilities: {
          qpdf: { available: true, version: "12.4.1" },
          ghostscript: { available: true, version: "10.07.1" },
          ocrmypdf: { available: true, version: "17.11.0" },
          tesseract: { available: true, version: "5.5.3", languages: ["eng"] }
        }
      }
    });
    const editor = createPageEditor({ onExit: () => undefined, loader: fake.loader });
    document.body.append(editor.element);
    await addTestFiles(editor.element, [makePdfFile("scan.pdf", 500)]);
    editor.element.querySelector<HTMLInputElement>('input[name="export-ocr"]')!.click();
    await tick();
    expect(editor.element.querySelector<HTMLButtonElement>(".exportrow .button")!.disabled).toBe(true);
    expect(editor.element.textContent).toContain("brew install tesseract-lang");
  });

  it("freezes controls during export and ignores late gestures", async () => {
    const fake = createFakeLoader([2]);
    let releaseExport!: (response: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      releaseExport = resolve;
    });
    const { calls, exportBodies } = installFetch({ onExport: () => gate });
    const editor = createPageEditor({ onExit: () => undefined, loader: fake.loader });
    document.body.append(editor.element);
    await addTestFiles(editor.element, [makePdfFile("a.pdf", 500)]);

    clickButton(editor.element, ".exportrow .button");
    await tick();

    const exportButton = editor.element.querySelector(".exportrow .button") as HTMLButtonElement;
    expect(exportButton.disabled).toBe(true);
    const firstRotate = thumbCards(editor.element)[0].querySelectorAll<HTMLButtonElement>(".thumb__controls button")[2];
    expect((firstRotate as HTMLButtonElement).disabled).toBe(true);
    // A late gesture while frozen must not reach the submitted snapshot.
    (firstRotate as HTMLButtonElement).click();
    await tick();

    releaseExport(
      jsonResponse({
        ok: true,
        handle: "h".repeat(32),
        downloadUrl: `/api/outputs/${"h".repeat(32)}/download`,
        status: "success",
        pageCount: 2,
        outputBytes: 100,
        engine: "qpdf",
        warnings: [],
        compatWarnings: []
      })
    );
    await tick(10);

    const manifest = JSON.parse(exportBodies[0].get("manifest") as string) as {
      pages: Array<{ rotate?: number }>;
    };
    expect(manifest.pages.map((entry) => entry.rotate ?? 0)).toEqual([0, 0]);
    expect((editor.element.querySelector(".exportrow .button") as HTMLButtonElement).disabled).toBe(false);
    expect(calls.some((call) => call.url.startsWith("/api/pages/export"))).toBe(true);
    const exportCall = calls.find((call) => call.url.startsWith("/api/pages/export"))!;
    expect(exportCall.init.headers?.get("x-launch-token")).toBe(TOKEN);
    expect(exportCall.init.credentials).toBe("include");
  });

  it("disables export with guidance when qpdf is missing and hides compression when Ghostscript is missing", async () => {
    const fake = createFakeLoader([1]);
    installFetch({
      capabilities: {
        ok: true,
        capabilities: {
          qpdf: { available: false, version: null },
          ghostscript: { available: false, version: null }
        }
      }
    });
    const editor = createPageEditor({ onExit: () => undefined, loader: fake.loader });
    document.body.append(editor.element);
    await addTestFiles(editor.element, [makePdfFile("a.pdf", 500)]);
    await tick(10);

    expect((editor.element.querySelector(".exportrow .button") as HTMLButtonElement).disabled).toBe(true);
    expect(editor.element.textContent).toContain("install qpdf");
    expect(editor.element.textContent).toContain("Preview still works");
    expect(editor.element.querySelector(".export-options__compression")?.hasAttribute("hidden")).toBe(true);
    expect(thumbCards(editor.element)).toHaveLength(1);
  });

  it("preserves the editable manifest after a server export error", async () => {
    const fake = createFakeLoader([2]);
    installFetch({
      onExport: () =>
        jsonResponse({ ok: false, code: "INPUT_ENCRYPTED", message: "Encrypted input is blocked." })
    });
    const editor = createPageEditor({ onExit: () => undefined, loader: fake.loader });
    document.body.append(editor.element);
    await addTestFiles(editor.element, [makePdfFile("a.pdf", 500)]);

    clickButton(editor.element, ".exportrow .button");
    await tick(10);

    expect(editor.element.textContent).toContain("Encrypted input is blocked.");
    expect(thumbCards(editor.element)).toHaveLength(2);
    expect((editor.element.querySelector(".exportrow .button") as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows an actionable OCR dependency error from the server", async () => {
    const fake = createFakeLoader([1]);
    installFetch({
      onExport: () =>
        jsonResponse({
          ok: false,
          code: "OCR_LANGUAGE_UNAVAILABLE",
          message: "The selected OCR language data is unavailable. Install it and try again."
        }, 503)
    });
    const editor = createPageEditor({ onExit: () => undefined, loader: fake.loader });
    document.body.append(editor.element);
    await addTestFiles(editor.element, [makePdfFile("scan.pdf", 500)]);
    editor.element.querySelector<HTMLInputElement>('input[name="export-ocr"]')!.click();
    await tick();

    clickButton(editor.element, ".exportrow .button");
    await tick(10);

    expect(editor.element.textContent).toContain(
      "The selected OCR language data is unavailable. Install it and try again."
    );
    expect(thumbCards(editor.element)).toHaveLength(1);
  });

  it("rejects over-limit input before PDF.js allocation and cleans up removed sources", async () => {
    const fake = createFakeLoader([1, 1]);
    installFetch();
    const editor = createPageEditor({ onExit: () => undefined, loader: fake.loader });
    document.body.append(editor.element);

    await addTestFiles(editor.element, [makePdfFile("huge.pdf", 100 * 1024 * 1024 + 1)]);
    expect(fake.opened).toHaveLength(0);
    expect(editor.element.textContent).toContain("100 MiB");
    expect(thumbCards(editor.element)).toHaveLength(0);

    await addTestFiles(editor.element, [makePdfFile("ok.pdf", 500)]);
    expect(fake.opened).toHaveLength(1);
    expect(thumbCards(editor.element)).toHaveLength(1);

    const remove = editor.element.querySelector(".filelist button") as HTMLButtonElement;
    remove.click();
    await tick(10);
    expect(fake.docs[0].destroyed).toBe(1);
    expect(thumbCards(editor.element)).toHaveLength(0);
  });
});

/* ------------------------------ render bounds ------------------------------ */

describe("thumbnail work queue", () => {
  it(`caps concurrency at ${MAX_CONCURRENT_RENDER_TASKS}`, async () => {
    expect(MAX_CONCURRENT_RENDER_TASKS).toBe(2);
    const queue = new ThumbnailWorkQueue();
    let concurrent = 0;
    let peak = 0;
    const finishers: Array<() => void> = [];
    const scheduled = Array.from({ length: 5 }, (_, index) =>
      queue.schedule(`k${index}`, () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        return {
          done: new Promise<void>((resolve) => {
            finishers.push(() => {
              concurrent -= 1;
              resolve();
            });
          }),
          cancel: (): void => undefined
        };
      })
    );
    await tick(3);
    expect(peak).toBe(2);
    expect(queue.activeCount).toBe(2);
    while (finishers.length > 0) {
      finishers.splice(0).forEach((finish) => finish());
      await tick(3);
    }
    await expect(Promise.all(scheduled)).resolves.toEqual(["done", "done", "done", "done", "done"]);
  });

  it("cancels queued work before it starts and aborts active work", async () => {
    const queue = new ThumbnailWorkQueue(1);
    let started: string[] = [];
    const cancels: string[] = [];
    const release = (key: string): (() => void) => {
      let done!: () => void;
      const promise = new Promise<void>((resolve) => {
        done = resolve;
      });
      void queue.schedule(key, () => {
        started.push(key);
        return {
          done: promise,
          cancel: (): void => {
            cancels.push(key);
          }
        };
      });
      return done;
    };
    const releaseFirst = release("first");
    const secondOutcome = queue.schedule("second", () => {
      started.push("second");
      return { done: Promise.resolve(), cancel: (): void => undefined };
    });
    await tick(2);
    queue.cancel("second");
    await expect(secondOutcome).resolves.toBe("cancelled");
    expect(started).toEqual(["first"]);

    const activeOutcome = queue.schedule("active", () => {
      started.push("active");
      return { done: new Promise<void>(() => undefined), cancel: (): void => cancels.push("active") };
    });
    void activeOutcome;
    await tick(2);
    queue.cancel("first");
    releaseFirst();
    await tick(2);
    expect(cancels).toContain("first");
  });

  it("does not release a cancelled task's slot until its work settles", async () => {
    const queue = new ThumbnailWorkQueue(1);
    let finishCancelled!: () => void;
    const first = queue.schedule("first", () => ({
      done: new Promise<void>((resolve) => {
        finishCancelled = resolve;
      }),
      cancel: (): void => undefined
    }));
    await tick(2);

    let replacementStarted = false;
    const replacement = queue.schedule("replacement", () => {
      replacementStarted = true;
      return { done: Promise.resolve(), cancel: (): void => undefined };
    });
    queue.cancel("first");
    await tick(2);

    expect(replacementStarted).toBe(false);
    expect(queue.activeCount).toBe(1);
    finishCancelled();
    await expect(first).resolves.toBe("cancelled");
    await expect(replacement).resolves.toBe("done");
  });
});

describe("preview store", () => {
  it(`mounts at most ${MAX_MOUNTED_THUMBNAILS} thumbnails and 32 MiB of canvases`, () => {
    expect(MAX_MOUNTED_THUMBNAILS).toBe(40);
    expect(MAX_DECODED_CANVAS_BYTES).toBe(32 * 1024 * 1024);
    const store = new PreviewStore();
    let evicted: string[] = [];
    for (let i = 0; i < 41; i += 1) {
      evicted = store.trackMounted(`s:1@${i}`, 1024);
    }
    expect(evicted).toEqual(["s:1@0"]);
    expect(store.mountedCount).toBe(40);

    const big = new PreviewStore();
    expect(big.trackMounted("s:1@0", 20 * 1024 * 1024)).toEqual([]);
    expect(big.trackMounted("s:1@1", 20 * 1024 * 1024)).toEqual(["s:1@0"]);
    expect(big.decodedBytes).toBe(20 * 1024 * 1024);
  });

  it("destroys a document and cancels its renders when its source is removed", async () => {
    const store = new PreviewStore();
    const doc = fakeDocument(2);
    store.registerDocument("gone", doc);
    let renderStarted = false;
    let finishRender!: () => void;
    const pending = store.scheduleRender("gone:1@0", () => {
      renderStarted = true;
      return {
        done: new Promise<void>((resolve) => {
          finishRender = resolve;
        }),
        cancel: (): void => finishRender()
      };
    });
    void pending;
    await tick(2);
    expect(renderStarted).toBe(true);
    await store.removeSource("gone");
    expect(doc.destroyed).toBe(1);
    expect(store.getDocument("gone")).toBeUndefined();
    await expect(pending).resolves.toBe("cancelled");
  });

  it("keeps a replacement with the same render key visible to source teardown", async () => {
    const store = new PreviewStore();
    const doc = fakeDocument(1);
    store.registerDocument("same", doc);
    let finishFirst!: () => void;
    const first = store.scheduleRender("same:1@0", () => ({
      done: new Promise<void>((resolve) => {
        finishFirst = resolve;
      }),
      cancel: (): void => finishFirst()
    }));
    await tick(2);

    let finishReplacement!: () => void;
    const replacement = store.scheduleRender("same:1@0", () => ({
      done: new Promise<void>((resolve) => {
        finishReplacement = resolve;
      }),
      cancel: (): void => finishReplacement()
    }));
    await expect(first).resolves.toBe("cancelled");
    await tick(2);

    await store.removeSource("same");
    await expect(replacement).resolves.toBe("cancelled");
    expect(doc.destroyed).toBe(1);
  });
});
