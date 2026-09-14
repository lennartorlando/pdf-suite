// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FormFieldEntry } from "@pdf-compressor/core/form-inventory";
import { serializeFormPlan, type FormPlan } from "@pdf-compressor/core/form-plan";
import { createFormFiller, layoutFor } from "../src/components/FormFiller.js";
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

const docText = (text: string) => ({ text, documentDerived: true as const });
const named = (text: string) => ({ text: docText(text), source: "name" as const });

const NAME = field({
  fieldId: "10 0 R",
  type: "text",
  label: named("Name"),
  widgets: [{ widgetId: "10 1 R", page: 1, rect: { x: 50, y: 700, width: 200, height: 20 } }]
});
const PAGE_TWO = field({
  fieldId: "11 0 R",
  type: "text",
  label: named("Second page note"),
  widgets: [{ widgetId: "11 1 R", page: 2, rect: { x: 50, y: 700, width: 200, height: 20 } }]
});
const CHECK = field({ fieldId: "12 0 R", type: "checkbox", allowedValues: [docText("Ja")] });
const READONLY = field({ fieldId: "13 0 R", type: "text", readOnly: true, currentValue: "fixed" });
const COMPUTED = field({ fieldId: "14 0 R", type: "text", computed: true, label: named("Total") });
const GROUP = field({ fieldId: "15 0 R", type: "group", widgets: [] });
const SIGFIELD = field({
  fieldId: "16 0 R",
  type: "signature",
  widgets: [{ widgetId: "16 1 R", page: 1, rect: { x: 300, y: 60, width: 220, height: 60 } }]
});

function inventory(fields: readonly FormFieldEntry[]) {
  return { version: 1, fields };
}

interface FakeDoc {
  handle: FormDocumentHandle;
  openDocument: (data: Uint8Array) => Promise<FormDocumentHandle>;
  renders: Array<{ scale: number; cancel: () => void }>;
  destroyed: ReturnType<typeof vi.fn>;
}

function fakeDoc(pages: Array<Partial<FormPageInfo>>): FakeDoc {
  const renders: FakeDoc["renders"] = [];
  const destroyed = vi.fn();
  const handle: FormDocumentHandle = {
    pageCount: pages.length,
    getPage: async (pageNumber: number) => {
      const info: FormPageInfo = {
        viewBox: [0, 0, PAGE_W, PAGE_H],
        rotation: 0,
        width: PAGE_W,
        height: PAGE_H,
        ...pages[pageNumber - 1]
      };
      return {
        info,
        render: (_canvas: HTMLCanvasElement, scale: number) => {
          const render = { scale, cancel: vi.fn() };
          renders.push(render);
          return { done: Promise.resolve(), cancel: render.cancel };
        }
      };
    },
    destroy: destroyed
  };
  return { handle, openDocument: vi.fn(async () => handle), renders, destroyed };
}

/** jsdom's File lacks arrayBuffer/text; back them with the source bytes. */
function withBytes(file: File, bytes: Uint8Array): File {
  if (typeof file.arrayBuffer !== "function") {
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    });
  }
  if (typeof file.text !== "function") {
    Object.defineProperty(file, "text", { value: async () => new TextDecoder().decode(bytes) });
  }
  return file;
}

function makePdfFile(name = "form.pdf"): File {
  return withBytes(new File([new Uint8Array([37, 80, 68, 70])], name, { type: "application/pdf" }), new Uint8Array([37, 80, 68, 70]));
}

const tick = async (rounds = 6): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

interface Harness {
  element: HTMLElement;
  destroy: () => void;
  fetchInventory: ReturnType<typeof vi.fn>;
  submitFill: ReturnType<typeof vi.fn>;
  download: ReturnType<typeof vi.fn>;
  doc: FakeDoc;
  onExit: ReturnType<typeof vi.fn>;
}

function createHarness(fields: readonly FormFieldEntry[], pages = 2): Harness {
  const doc = fakeDoc(Array.from({ length: pages }, () => ({})));
  const fetchInventory = vi.fn(async () => ({ ok: true, inventory: inventory(fields) }));
  const submitFill = vi.fn(async () => ({ ok: true, downloadUrl: "/api/outputs/abc/download" }));
  const download = vi.fn(async () => new Blob(["pdf"], { type: "application/pdf" }));
  const onExit = vi.fn();
  const filler = createFormFiller({
    onExit,
    openDocument: doc.openDocument,
    fetchInventory,
    submitFill,
    download
  });
  document.body.append(filler.element);
  return { element: filler.element, destroy: () => filler.destroy(), fetchInventory, submitFill, download, doc, onExit };
}

async function openPdf(element: HTMLElement, file = makePdfFile()): Promise<void> {
  const input = element.querySelector<HTMLInputElement>('.fill-pick input[type="file"]');
  expect(input).not.toBeNull();
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input!.dispatchEvent(new Event("change", { bubbles: true }));
  await tick();
}

async function loadPlan(element: HTMLElement, plan: FormPlan): Promise<void> {
  const input = element.querySelector<HTMLInputElement>('.fill-planpick input[type="file"]');
  expect(input).not.toBeNull();
  const bytes = new TextEncoder().encode(serializeFormPlan(plan));
  const file = withBytes(new File([bytes], "plan.json", { type: "application/json" }), bytes);
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input!.dispatchEvent(new Event("change", { bubbles: true }));
  await tick();
}

const clickTool = (element: HTMLElement, label: string): void => {
  const button = [...element.querySelectorAll<HTMLButtonElement>(".fill-tools .tool")].find((node) =>
    node.textContent?.includes(label)
  );
  button?.click();
};

beforeEach(() => {
  resetAuthStateForTests();
  vi.unstubAllGlobals();
  Object.defineProperty(URL, "createObjectURL", { value: vi.fn(() => "blob:receipt"), configurable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("fill surface: lazy boundary and CSP", () => {
  it("keeps the filler and PDF.js behind a dynamic import in the shell", () => {
    const appSource = readFileSync("apps/web/src/App.ts", "utf8");
    expect(appSource).not.toMatch(/^import\s+(?!type)[^;]*FormFiller[^;]*from/m);
    expect(appSource).not.toMatch(/from\s*["']pdfjs-dist["']/);
    expect(appSource).toContain('import("./components/FormFiller.js")');
  });

  it("configures the renderer for local assets with scripting and eval off", () => {
    const source = readFileSync("apps/web/src/form/page-render.ts", "utf8");
    expect(source).toContain("pdf.worker.min.mjs?url");
    expect(source).toContain("wasmUrl");
    expect(source).toContain("standardFontDataUrl");
    expect(source).toContain("iccUrl");
    expect(source).toContain("isEvalSupported: false");
    expect(source).toContain("enableScripting: false");
    expect(source).not.toMatch(/https?:\/\//);
  });

  it("changes the production CSP only by adding wasm-unsafe-eval to script-src", () => {
    const serverSource = readFileSync("apps/local-server/src/server.ts", "utf8");
    const block = serverSource.match(/PRODUCTION_CSP = \[([\s\S]*?)\]\.join/)?.[1] ?? "";
    const directives = [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    expect(directives).toContain("script-src 'self' 'wasm-unsafe-eval'");
    // No other directive may carry eval permissions and no directive besides
    // script-src mentions wasm-unsafe-eval. The keyword is a quoted
    // source-expression: unquoted it parses as a host-source and grants
    // nothing.
    expect(directives.filter((d) => d.includes("wasm-unsafe-eval"))).toHaveLength(1);
    expect(directives.some((d) => d.includes("'unsafe-eval'"))).toBe(false);
    expect(directives).toContain("worker-src 'self'");
    expect(directives).toContain("connect-src 'self'");
    expect(directives).toContain("object-src 'none'");
  });
});

describe("fill surface: field overlays", () => {
  it("shows overlays only for fields on the current page", async () => {
    const harness = createHarness([NAME, PAGE_TWO]);
    await openPdf(harness.element);
    expect(harness.element.querySelector(".fill-workspace")?.hasAttribute("hidden")).toBe(false);
    const boxes = harness.element.querySelectorAll(".overlay-layer .field-box");
    expect(boxes).toHaveLength(1);
    expect(boxes[0].getAttribute("data-field-id")).toBe("10 0 R");
    // Page 2: the other field's widget appears, the page-1 widget does not.
    const next = [...harness.element.querySelectorAll<HTMLButtonElement>(".canvas-head button")].find(
      (node) => node.textContent === "›"
    );
    next?.click();
    await tick();
    const boxes2 = harness.element.querySelectorAll(".overlay-layer .field-box");
    expect(boxes2).toHaveLength(1);
    expect(boxes2[0].getAttribute("data-field-id")).toBe("11 0 R");
    harness.destroy();
  });

  it("handles a document with no fields and still offers placements", async () => {
    const harness = createHarness([]);
    await openPdf(harness.element);
    expect(harness.element.textContent).toContain("no fillable fields");
    expect(harness.element.querySelectorAll(".overlay-layer .field-box")).toHaveLength(0);
    clickTool(harness.element, "Check");
    harness.element.querySelector<HTMLElement>(".hit-layer")?.dispatchEvent(
      new MouseEvent("click", { clientX: 100, clientY: 100, bubbles: true })
    );
    await tick();
    expect(harness.element.querySelectorAll(".placement--checkmark")).toHaveLength(1);
    harness.destroy();
  });

  it("renders group and signature fields as markers, not inputs", async () => {
    const harness = createHarness([GROUP, SIGFIELD]);
    await openPdf(harness.element);
    const marker = harness.element.querySelector(".field-box--marker");
    expect(marker?.textContent).toContain("Signature field");
    expect(harness.element.querySelectorAll(".overlay-layer input")).toHaveLength(0);
    harness.destroy();
  });

  it("keeps typing inside the model: no fetch, no worker mutation", async () => {
    const harness = createHarness([NAME, CHECK]);
    await openPdf(harness.element);
    const fetchCount = harness.fetchInventory.mock.calls.length;
    const input = harness.element.querySelector<HTMLInputElement>('.overlay-layer [data-field-id="10 0 R"] input');
    expect(input).not.toBeNull();
    input!.value = "Ada";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    const checkbox = harness.element.querySelector<HTMLInputElement>('[data-field-id="12 0 R"] input');
    checkbox!.click();
    await tick();
    expect(harness.fetchInventory.mock.calls.length).toBe(fetchCount);
    expect(harness.submitFill).not.toHaveBeenCalled();
    // The field list shows the answered value.
    const row = [...harness.element.querySelectorAll<HTMLElement>(".field-list .field")].find((node) =>
      node.textContent?.includes("Name")
    );
    expect(row?.textContent).toContain("Ada");
    expect(harness.element.querySelector(".unsaved-dot")?.hasAttribute("hidden")).toBe(false);
    harness.destroy();
  });

  it("marks computed fields and disables read-only inputs", async () => {
    const harness = createHarness([COMPUTED, READONLY]);
    await openPdf(harness.element);
    expect(harness.element.querySelector(".field-box--computed")).not.toBeNull();
    expect(harness.element.querySelector(".fill-notices")?.textContent).toContain("calculated field");
    const readonly = harness.element.querySelector<HTMLInputElement>('[data-field-id="13 0 R"] input');
    expect(readonly?.disabled).toBe(true);
    harness.destroy();
  });
});

describe("fill surface: placements", () => {
  it("converts a click into a user-space checkmark in the exported plan", async () => {
    const harness = createHarness([]);
    await openPdf(harness.element);
    clickTool(harness.element, "Check");
    harness.element.querySelector<HTMLElement>(".hit-layer")?.dispatchEvent(
      new MouseEvent("click", { clientX: 50, clientY: 100, bubbles: true })
    );
    await tick();
    const createButton = [...harness.element.querySelectorAll<HTMLButtonElement>(".fill-bar .button")].find(
      (node) => node.textContent === "Create PDF"
    );
    createButton?.click();
    await tick();
    expect(harness.submitFill).toHaveBeenCalledTimes(1);
    const plan = harness.submitFill.mock.calls[0][1] as FormPlan;
    const check = plan.entries.find((entry) => entry.kind === "checkmark");
    // jsdom's zero-origin rects make the conversion exact: y is flipped
    // from the crop-box top with the checkmark height included.
    expect(check && check.kind === "checkmark" ? check.rect : null).toMatchObject({ x: 50 });
    expect(check && check.kind === "checkmark" ? check.page : 0).toBe(1);
    expect(check && check.kind === "checkmark" ? check.source : "").toBe("upload");
    harness.destroy();
  });
});

describe("fill surface: agent plan review and approval", () => {
  const agentPlan: FormPlan = {
    version: 1,
    source: "upload",
    destination: "download",
    overwrite: false,
    burnIn: false,
    nonce: "agent-nonce-1",
    entries: [
      { kind: "field", fieldId: "10 0 R", status: "proposed", value: "Grace" },
      { kind: "field", fieldId: "13 0 R", status: "skipped" }
    ]
  };

  it("renders every proposal in position with its status", async () => {
    const harness = createHarness([NAME, READONLY]);
    await openPdf(harness.element);
    await loadPlan(harness.element, agentPlan);
    const review = harness.element.querySelector(".fill-side");
    expect(review?.textContent).toContain("1 proposals to review");
    expect(review?.textContent).toContain("Grace");
    // The proposed value also appears in the field list with its status.
    const row = [...harness.element.querySelectorAll<HTMLElement>(".field-list .field")].find((node) =>
      node.textContent?.includes("Name")
    );
    expect(row?.textContent).toContain("Proposal");
    expect(row?.textContent).toContain("Grace");
    harness.destroy();
  });

  it("mints a receipt bound to the approved plan and source on approval", async () => {
    const blobs: Blob[] = [];
    let counter = 0;
    Object.defineProperty(URL, "createObjectURL", {
      value: vi.fn((blob: Blob) => {
        blobs.push(blob);
        counter += 1;
        return `blob:receipt-${counter}`;
      }),
      configurable: true
    });
    const harness = createHarness([NAME]);
    await openPdf(harness.element);
    await loadPlan(harness.element, agentPlan);
    const approve = [...harness.element.querySelectorAll<HTMLButtonElement>("button")].find((node) =>
      node.textContent?.includes("Approve plan")
    );
    approve?.click();
    await tick();
    expect(blobs.length).toBe(2);
    const readBlob = (blob: Blob): Promise<string> =>
      new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(blob);
      });
    const receipt = JSON.parse(await readBlob(blobs[1]));
    expect(receipt.channel).toBe("browser");
    expect(receipt.nonce).toBe("agent-nonce-1");
    expect(receipt.planDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.sourceDigest).toMatch(/^[0-9a-f]{64}$/);
    // The approved plan is also downloaded and its digest matches.
    const planBytes = await readBlob(blobs[0]);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(planBytes));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(receipt.planDigest).toBe(hex);
    harness.destroy();
  });
});

describe("fill surface: unsaved values and exit", () => {
  it("warns before leaving with unsaved values and exits cleanly when clean", async () => {
    const harness = createHarness([NAME]);
    await openPdf(harness.element);
    // Clean: Close exits immediately, no warning bar.
    const close = [...harness.element.querySelectorAll<HTMLButtonElement>(".fill-bar .button")].find(
      (node) => node.textContent === "Close"
    );
    close?.click();
    expect(harness.onExit).toHaveBeenCalledTimes(1);
    expect(harness.element.querySelector(".fill-leave")?.hasAttribute("hidden")).toBe(true);
    harness.destroy();

    const dirty = createHarness([NAME]);
    await openPdf(dirty.element);
    const input = dirty.element.querySelector<HTMLInputElement>('.overlay-layer [data-field-id="10 0 R"] input');
    input!.value = "unsaved";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    await tick(2);
    const close2 = [...dirty.element.querySelectorAll<HTMLButtonElement>(".fill-bar .button")].find(
      (node) => node.textContent === "Close"
    );
    close2?.click();
    expect(dirty.onExit).not.toHaveBeenCalled();
    expect(dirty.element.querySelector(".fill-leave")?.hasAttribute("hidden")).toBe(false);
    // beforeunload is armed while dirty.
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    dirty.destroy();
    // After destroy the listener is gone and no warning fires.
    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
  });
});

describe("fill surface: responsive layout", () => {
  it("maps widths to the measured docking thresholds", () => {
    expect(layoutFor(1200)).toBe("docked");
    expect(layoutFor(910)).toBe("docked");
    expect(layoutFor(700)).toBe("stacked");
    expect(layoutFor(620)).toBe("stacked");
    expect(layoutFor(500)).toBe("compact");
  });

  it("keeps values, focus and placements across the dock-to-stack resize", async () => {
    const harness = createHarness([NAME]);
    await openPdf(harness.element);
    clickTool(harness.element, "Check");
    harness.element.querySelector<HTMLElement>(".hit-layer")?.dispatchEvent(
      new MouseEvent("click", { clientX: 60, clientY: 60, bubbles: true })
    );
    const input = harness.element.querySelector<HTMLInputElement>('.overlay-layer [data-field-id="10 0 R"] input');
    input!.value = "kept";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    input!.focus();
    await tick(2);
    expect(document.activeElement).toBe(input);

    Object.defineProperty(window, "innerWidth", { value: 500, configurable: true });
    window.dispatchEvent(new Event("resize"));
    await tick();
    expect(harness.element.dataset.layout).toBe("compact");

    const rebuilt = harness.element.querySelector<HTMLInputElement>('.overlay-layer [data-field-id="10 0 R"] input');
    expect(rebuilt?.value).toBe("kept");
    expect(document.activeElement).toBe(rebuilt);
    expect(harness.element.querySelectorAll(".placement--checkmark")).toHaveLength(1);
    harness.destroy();
    Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
  });
});

describe("fill surface: field-list shortcut", () => {
  it("opens the navigator, never fires while a field has focus, and remaps", async () => {
    const harness = createHarness([NAME]);
    await openPdf(harness.element);
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true }));
    expect(harness.element.querySelector(".fill-navigator")?.hasAttribute("hidden")).toBe(false);
    // Escape closes.
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(harness.element.querySelector(".fill-navigator")?.hasAttribute("hidden")).toBe(true);

    // Focused field: the keystroke goes to the field, not the navigator.
    const input = harness.element.querySelector<HTMLInputElement>('.overlay-layer [data-field-id="10 0 R"] input');
    input!.focus();
    input!.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true }));
    expect(harness.element.querySelector(".fill-navigator")?.hasAttribute("hidden")).toBe(true);
    harness.destroy();

    // Remapped via deps.
    const remapDoc = fakeDoc([{}]);
    const remap = createFormFiller({
      onExit: vi.fn(),
      openDocument: remapDoc.openDocument,
      fetchInventory: vi.fn(async () => ({ ok: true, inventory: inventory([NAME]) })),
      shortcutKey: "l"
    });
    document.body.append(remap.element);
    await openPdf(remap.element);
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true }));
    expect(remap.element.querySelector(".fill-navigator")?.hasAttribute("hidden")).toBe(true);
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "l", bubbles: true }));
    expect(remap.element.querySelector(".fill-navigator")?.hasAttribute("hidden")).toBe(false);
    remap.destroy();
  });

  it("can be disabled from the navigator", async () => {
    const harness = createHarness([NAME]);
    await openPdf(harness.element);
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true }));
    const toggle = harness.element.querySelector<HTMLInputElement>('.fill-navigator input[type="checkbox"]');
    expect(toggle).not.toBeNull();
    toggle!.checked = false;
    toggle!.dispatchEvent(new Event("change", { bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true }));
    expect(harness.element.querySelector(".fill-navigator")?.hasAttribute("hidden")).toBe(true);
    harness.destroy();
  });
});

describe("fill surface: no browser storage", () => {
  it("writes nothing to local or session storage", async () => {
    const harness = createHarness([NAME]);
    await openPdf(harness.element);
    const input = harness.element.querySelector<HTMLInputElement>('.overlay-layer [data-field-id="10 0 R"] input');
    input!.value = "data";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    harness.destroy();
  });
});

describe("fillForm client: bounded retries under one nonce", () => {
  function fillResponse(body: unknown): Response {
    return { ok: true, status: 200, json: async () => body } as Response;
  }

  it("retries a busy slot and the authentication retry replays the same plan", async () => {
    const { fillForm } = await import("../src/api/client.js");
    const plans: string[] = [];
    let launchCount = 0;
    let fillCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}): Promise<Response> => {
        if (url === "/api/session/launch") {
          launchCount += 1;
          return fillResponse({ ok: true, token: `t${launchCount}`.padEnd(64, "x"), expiresInMs: 300_000 });
        }
        if (url === "/api/forms/fill") {
          fillCount += 1;
          const form = init.body as FormData;
          plans.push(String(form.get("plan")));
          if (fillCount === 1) return { ok: false, status: 401, json: async () => ({}) } as Response;
          if (fillCount === 2) return { ok: false, status: 429, json: async () => ({ code: "BUSY" }) } as Response;
          return fillResponse({ ok: true, handle: "h1" });
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const plan: FormPlan = {
      version: 1,
      source: "upload",
      destination: "download",
      overwrite: false,
      burnIn: false,
      nonce: "nonce-once",
      entries: []
    };
    const result = await fillForm(makePdfFile(), plan);
    expect(result.ok).toBe(true);
    // 401 -> token refresh -> same request; 429 -> bounded backoff -> same
    // request. Every attempt carries the identical serialized plan, so the
    // server nonce consumes at most one write (KTD18).
    expect(fillCount).toBe(3);
    expect(launchCount).toBe(2);
    expect(plans).toHaveLength(3);
    expect(new Set(plans).size).toBe(1);
    expect(plans[0]).toContain('"nonce":"nonce-once"');
  });
});
