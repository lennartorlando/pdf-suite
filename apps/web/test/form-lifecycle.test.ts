// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FormFieldEntry } from "@pdf-compressor/core/form-inventory";
import { createFormFiller } from "../src/components/FormFiller.js";
import type { FormDocumentHandle, FormPageInfo } from "../src/form/page-render.js";
import { resetAuthStateForTests } from "../src/api/client.js";

const PAGE_W = 595.28;
const PAGE_H = 841.89;

function field(partial: Partial<FormFieldEntry> & Pick<FormFieldEntry, "fieldId" | "type">): FormFieldEntry {
  return {
    widgets: [{ widgetId: "10 1 R", page: 1, rect: { x: 50, y: 700, width: 200, height: 20 } }],
    required: false,
    readOnly: false,
    computed: false,
    password: false,
    hidden: false,
    multiline: false,
    comb: false,
    ...partial
  };
}

const NAME = field({
  fieldId: "10 0 R",
  type: "text",
  label: { text: { text: "Name", documentDerived: true }, source: "name" }
});

interface FakeDoc {
  handle: FormDocumentHandle;
  openDocument: (data: Uint8Array) => Promise<FormDocumentHandle>;
  renders: Array<{ cancel: ReturnType<typeof vi.fn> }>;
  destroyed: ReturnType<typeof vi.fn>;
  pendingRenders: Array<{ resolve: () => void }>;
}

function fakeDoc(pageCount: number, options: { hangRender?: boolean } = {}): FakeDoc {
  const renders: FakeDoc["renders"] = [];
  const pendingRenders: FakeDoc["pendingRenders"] = [];
  const destroyed = vi.fn();
  const handle: FormDocumentHandle = {
    pageCount,
    getPage: async (pageNumber: number) => {
      const info: FormPageInfo = {
        viewBox: [0, 0, PAGE_W, PAGE_H],
        rotation: 0,
        width: PAGE_W,
        height: PAGE_H
      };
      void pageNumber;
      return {
        info,
        render: () => {
          const render = { cancel: vi.fn() };
          renders.push(render);
          const done = options.hangRender
            ? new Promise<void>((resolve) => pendingRenders.push({ resolve }))
            : Promise.resolve();
          return { done, cancel: render.cancel };
        }
      };
    },
    destroy: destroyed
  };
  return { handle, openDocument: vi.fn(async () => handle), renders, destroyed, pendingRenders };
}

function makePdfFile(): File {
  const bytes = new Uint8Array([37, 80, 68, 70]);
  const file = new File([bytes], "form.pdf", { type: "application/pdf" });
  if (typeof file.arrayBuffer !== "function") {
    Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer });
  }
  return file;
}

const tick = async (rounds = 6): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

async function openPdf(element: HTMLElement): Promise<void> {
  const input = element.querySelector<HTMLInputElement>('.fill-pick input[type="file"]');
  Object.defineProperty(input, "files", { value: [makePdfFile()], configurable: true });
  input!.dispatchEvent(new Event("change", { bubbles: true }));
  await tick();
}

const createdUrls: string[] = [];
const revokedUrls: string[] = [];

beforeEach(() => {
  resetAuthStateForTests();
  vi.unstubAllGlobals();
  createdUrls.length = 0;
  revokedUrls.length = 0;
  Object.defineProperty(URL, "createObjectURL", {
    value: vi.fn(() => {
      const url = `blob:created-${createdUrls.length}`;
      createdUrls.push(url);
      return url;
    }),
    configurable: true
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    value: vi.fn((url: string) => {
      revokedUrls.push(url);
    }),
    configurable: true
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("fill surface lifecycle", () => {
  it("destroy releases the document, cancels the render and revokes URLs", async () => {
    const doc = fakeDoc(2);
    const filler = createFormFiller({
      onExit: vi.fn(),
      openDocument: doc.openDocument,
      fetchInventory: vi.fn(async () => ({ ok: true, inventory: { version: 1, fields: [NAME] } })),
      submitFill: vi.fn(async () => ({ ok: true, downloadUrl: "/api/outputs/h/download" })),
      download: vi.fn(async () => new Blob(["pdf"]))
    });
    document.body.append(filler.element);
    await openPdf(filler.element);
    expect(doc.renders.length).toBeGreaterThan(0);

    // Produce an object URL through the export path before destroying.
    const createButton = [...filler.element.querySelectorAll<HTMLButtonElement>(".fill-bar .button")].find(
      (node) => node.textContent === "Create PDF"
    );
    createButton?.click();
    await tick();
    expect(createdUrls.length).toBeGreaterThan(0);

    filler.destroy();
    expect(doc.destroyed).toHaveBeenCalledTimes(1);
    // The page canvas is released.
    const canvas = filler.element.querySelector("canvas");
    expect(canvas?.width).toBe(0);
    for (const url of createdUrls) expect(revokedUrls).toContain(url);

    // Idempotent: a second destroy does nothing further.
    filler.destroy();
    expect(doc.destroyed).toHaveBeenCalledTimes(1);
  });

  it("cancels an in-flight render on destroy", async () => {
    const doc = fakeDoc(1, { hangRender: true });
    const filler = createFormFiller({
      onExit: vi.fn(),
      openDocument: doc.openDocument,
      fetchInventory: vi.fn(async () => ({ ok: true, inventory: { version: 1, fields: [NAME] } }))
    });
    document.body.append(filler.element);
    await openPdf(filler.element);
    const active = doc.renders.at(-1);
    filler.destroy();
    expect(active?.cancel).toHaveBeenCalled();
    // Resolving the hung render after destroy must not throw or re-render.
    doc.pendingRenders.forEach((pending) => pending.resolve());
    await tick();
    expect(doc.destroyed).toHaveBeenCalledTimes(1);
  });

  it("removes window and document listeners so nothing fires after destroy", async () => {
    const doc = fakeDoc(1);
    const filler = createFormFiller({
      onExit: vi.fn(),
      openDocument: doc.openDocument,
      fetchInventory: vi.fn(async () => ({ ok: true, inventory: { version: 1, fields: [NAME] } }))
    });
    document.body.append(filler.element);
    await openPdf(filler.element);
    // Dirty the state so beforeunload would fire if the listener survived.
    const input = filler.element.querySelector<HTMLInputElement>('[data-field-id="10 0 R"] input');
    input!.value = "x";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    await tick(2);
    filler.destroy();

    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true }));
    expect(filler.element.querySelector(".fill-navigator")?.hasAttribute("hidden")).toBe(true);
  });

  it("destroys a document that finished opening after the surface was torn down", async () => {
    let releaseOpen: ((handle: FormDocumentHandle) => void) | null = null;
    const doc = fakeDoc(1);
    const openDocument = vi.fn(
      () =>
        new Promise<FormDocumentHandle>((resolve) => {
          releaseOpen = resolve;
        })
    );
    const filler = createFormFiller({
      onExit: vi.fn(),
      openDocument,
      fetchInventory: vi.fn(async () => ({ ok: true, inventory: { version: 1, fields: [NAME] } }))
    });
    document.body.append(filler.element);
    const input = filler.element.querySelector<HTMLInputElement>('.fill-pick input[type="file"]');
    Object.defineProperty(input, "files", { value: [makePdfFile()], configurable: true });
    input!.dispatchEvent(new Event("change", { bubbles: true }));
    await tick(2);
    // Destroy while the open is still in flight, then let it land.
    filler.destroy();
    releaseOpen?.(doc.handle);
    await tick();
    expect(doc.destroyed).toHaveBeenCalledTimes(1);
    // The workspace stays hidden: a late open cannot resurrect the surface.
    expect(filler.element.querySelector(".fill-workspace")?.hasAttribute("hidden")).toBe(true);
  });

  it("leaves no timers behind after a full session", async () => {
    vi.useFakeTimers();
    const doc = fakeDoc(1);
    const filler = createFormFiller({
      onExit: vi.fn(),
      openDocument: doc.openDocument,
      fetchInventory: vi.fn(async () => ({ ok: true, inventory: { version: 1, fields: [NAME] } }))
    });
    document.body.append(filler.element);
    const input = filler.element.querySelector<HTMLInputElement>('.fill-pick input[type="file"]');
    Object.defineProperty(input, "files", { value: [makePdfFile()], configurable: true });
    input!.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.runAllTimersAsync().catch(() => undefined);
    filler.destroy();
    // runOnlyPendingTimers surfaces any still-scheduled work; none should exist.
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
