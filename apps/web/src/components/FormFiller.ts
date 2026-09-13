/**
 * Browser fill and sign surface (U6). Reached only through a dynamic import
 * from App.ts, like the page editor. The page renders on one canvas; field
 * inputs and free placements are ordinary HTML over it (KTD11). Typing moves
 * an immutable model only — nothing touches the document, the network or any
 * browser storage until the person exports or approves.
 *
 * Responsive direction: one editor instance; panels dock beside the page on
 * wide viewports and stack below it on narrow ones, driven by measured
 * thresholds so a resize never rebuilds the editor.
 */

import {
  downloadOutput,
  fillForm,
  inventoryForm,
  type FillFormResult,
  type FormInventoryResponse
} from "../api/client.js";
import type { FormFieldEntry } from "@pdf-compressor/core/form-inventory";
import { parseFormInventory } from "@pdf-compressor/core/form-inventory";
import { parseFormPlan, serializeFormPlan, type FormPlan } from "@pdf-compressor/core/form-plan";
import type { PageGeometry } from "../form/geometry.js";
import { screenToUser, viewportSize } from "../form/geometry.js";
import {
  CHECKMARK_SIZE,
  SIGNATURE_PAD,
  TEXT_PLACEMENT_SIZE,
  addPlacement,
  approveField,
  buildReceipt,
  chooseOption,
  createFormState,
  derivePlan,
  isFillable,
  loadPlan,
  markSaved,
  movePlacement,
  onValue,
  rejectField,
  removePlacement,
  serializeReceipt,
  setBurnIn,
  setFieldText,
  toggleCheckbox,
  updatePlacementText,
  type FormFillState
} from "../form/model.js";
import {
  createFormPdfLoader,
  type CancellableRender,
  type FormDocumentHandle,
  type FormPageHandle
} from "../form/page-render.js";
import { createFieldOverlay } from "./FieldOverlay.js";
import {
  createPlacementLayer,
  createSignaturePad,
  type SignaturePadHandle
} from "./PlacementTools.js";

export interface FormFillerDeps {
  onExit: () => void;
  openDocument?: (data: Uint8Array) => Promise<FormDocumentHandle>;
  fetchInventory?: (file: File, signal?: AbortSignal) => Promise<FormInventoryResponse>;
  submitFill?: (file: File, plan: FormPlan, signal?: AbortSignal) => Promise<FillFormResult>;
  download?: (url: string, signal?: AbortSignal) => Promise<Blob>;
  /** Field-list shortcut key; default "f". Case-insensitive, no modifiers. */
  shortcutKey?: string;
}

export interface FormFillerHandle {
  readonly element: HTMLElement;
  destroy(): void;
}

/**
 * Docking thresholds measured against a real A4 render (595.28 CSS px at
 * scale 1 through the pinned pdf.js viewport) and a 200-field form. The page
 * column's legibility floor is 80% of scale-1 (~477 px); the rail is 64 px
 * and the review panel 300 px. See the U6 measurement run in the plan notes.
 */
export const PAGE_COLUMN_MIN = 477;
export const DOCK_PANEL_MIN = 910;
export const RAIL_SIDE_MIN = 620;

export type FillLayout = "docked" | "stacked" | "compact";

export function layoutFor(width: number): FillLayout {
  if (width >= DOCK_PANEL_MIN) return "docked";
  if (width >= RAIL_SIDE_MIN) return "stacked";
  return "compact";
}

const MAX_PAGE_CANVAS_PIXELS = 16 * 1024 * 1024;
const FIT_WIDTH_FALLBACK = 700;

type Tool = "fields" | "text" | "checkmark" | "signature";

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className: string, text: string): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.textContent = text;
  return node;
}

async function sha256Hex(data: string | Uint8Array | ArrayBuffer): Promise<string> {
  const bytes =
    typeof data === "string" ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const STATUS_LABEL: Record<string, string> = {
  unknown: "Open",
  proposed: "Proposal",
  answered: "Answered",
  skipped: "Skipped"
};

function fieldLabel(field: FormFieldEntry): string {
  return field.label?.text.text ?? field.fieldId;
}

export function createFormFiller(deps: FormFillerDeps): FormFillerHandle {
  const openDocument = deps.openDocument ?? createFormPdfLoader().openDocument;
  const fetchInventory = deps.fetchInventory ?? inventoryForm;
  const submitFill = deps.submitFill ?? fillForm;
  const download = deps.download ?? downloadOutput;
  const shortcutKey = (deps.shortcutKey ?? "f").toLowerCase();

  const root = el("div", "fill-surface");
  let destroyed = false;
  let state: FormFillState | null = null;
  let doc: FormDocumentHandle | null = null;
  let sourceFile: File | null = null;
  let sourceBytes: Uint8Array | null = null;
  let pageCount = 0;
  let currentPage = 1;
  let zoom = 1;
  let tool: Tool = "fields";
  let renderTask: CancellableRender | null = null;
  let pageHandle: FormPageHandle | null = null;
  let generation = 0;
  let selectedPlacement: string | null = null;
  let activeField: string | null = null;
  let exporting = false;
  let shortcutEnabled = true;
  let pendingPlan: FormPlan | null = null;
  const objectUrls = new Set<string>();
  const controllers = new Set<AbortController>();

  /* ------------------------------- chrome ------------------------------- */

  const bar = el("header", "fill-bar");
  const backLink = document.createElement("a");
  backLink.href = "#";
  backLink.className = "muted";
  backLink.textContent = "← Start";
  const fileName = el("strong");
  const unsavedDot = el("span", "unsaved-dot");
  unsavedDot.title = "Unsaved values";
  unsavedDot.hidden = true;
  const barSpacer = el("span", "spacer");
  const localNote = el("span", "muted small", "Opened locally, nothing sent away");
  const closeButton = button("button secondary", "Close");
  const exportButton = button("button", "Create PDF");
  bar.append(backLink, fileName, unsavedDot, barSpacer, localNote, closeButton, exportButton);

  const pickArea = el("section", "fill-pick");
  const pickLabel = document.createElement("label");
  pickLabel.className = "dropzone dropzone--small";
  pickLabel.innerHTML =
    '<span class="dropzone__title">Drop a PDF form here</span>' +
    '<span class="dropzone__hint">or choose one from your computer</span>' +
    '<input type="file" accept="application/pdf,.pdf" />';
  const pickInput = pickLabel.querySelector("input")!;
  const planLabel = document.createElement("label");
  planLabel.className = "fill-planpick";
  planLabel.textContent = "Also load an agent plan (.json): ";
  const planInput = document.createElement("input");
  planInput.type = "file";
  planInput.accept = "application/json,.json";
  planLabel.append(planInput);
  const pickStatus = el("p", "progress");
  pickStatus.setAttribute("role", "status");
  pickArea.append(pickLabel, planLabel, pickStatus);

  const workspace = el("main", "fill-workspace");
  workspace.hidden = true;

  const rail = el("nav", "fill-tools");
  rail.setAttribute("aria-label", "Tools");
  const toolButtons = new Map<Tool, HTMLButtonElement>();
  const toolDefs: Array<[Tool, string, string]> = [
    ["fields", "▣", "Fields"],
    ["text", "T", "Text"],
    ["checkmark", "✓", "Check"],
    ["signature", "✎", "Sign"]
  ];
  for (const [name, icon, label] of toolDefs) {
    const node = button("tool", "");
    const iconNode = document.createElement("b");
    iconNode.textContent = icon;
    node.append(iconNode, label);
    node.addEventListener("click", () => setTool(name));
    toolButtons.set(name, node);
    rail.append(node);
  }
  const navButton = button("tool", "");
  const navIcon = document.createElement("b");
  navIcon.textContent = "⌘";
  navButton.append(navIcon, document.createTextNode("Field list"));
  navButton.addEventListener("click", () => toggleNavigator());
  rail.append(navButton);

  const stage = el("section", "fill-stage");
  stage.setAttribute("aria-label", "Document page");
  const canvasHead = el("div", "canvas-head");
  const prevPage = button("button ghost tiny", "‹");
  const pageLabel = el("strong");
  const nextPage = button("button ghost tiny", "›");
  const headSpacer = el("span", "spacer");
  const zoomOut = button("button ghost tiny", "−");
  const zoomLabel = el("span", "small", "100 %");
  const zoomIn = button("button ghost tiny", "+");
  canvasHead.append(prevPage, pageLabel, nextPage, headSpacer, zoomOut, zoomLabel, zoomIn);
  const paper = el("article", "fill-paper");
  const pageCanvas = document.createElement("canvas");
  pageCanvas.className = "fill-canvas";
  const hitLayer = el("div", "hit-layer");
  hitLayer.hidden = true;
  const overlay = createFieldOverlay({
    onTextInput(fieldId, value) {
      if (!state) return;
      try {
        setState(setFieldText(state, fieldId, value), { rebuildOverlay: false });
      } catch {
        // Control characters are refused at the model boundary; keep typing.
      }
    },
    onToggleCheckbox(fieldId) {
      if (state) setState(toggleCheckbox(state, fieldId), { rebuildOverlay: false });
    },
    onChooseOption(fieldId, value) {
      if (state) setState(chooseOption(state, fieldId, value), { rebuildOverlay: false });
    },
    onFieldFocus(fieldId) {
      activeField = fieldId;
    }
  });
  const placements = createPlacementLayer({
    onMove(id, x, y) {
      if (state) setState(movePlacement(state, id, x, y), { rebuildOverlay: false });
    },
    onTextInput(id, text) {
      if (state) setState(updatePlacementText(state, id, text), { rebuildOverlay: false });
    },
    onRemove(id) {
      if (state) setState(removePlacement(state, id), { rebuildOverlay: false });
      selectedPlacement = null;
      renderPlacements();
    },
    onSelect(id) {
      selectedPlacement = id;
      renderPlacements();
    }
  });
  paper.append(pageCanvas, hitLayer, overlay.element, placements.element);

  const signatureHost = el("div", "fill-signature");
  signatureHost.hidden = true;
  const notices = el("div", "fill-notices");
  stage.append(canvasHead, paper, signatureHost, notices);

  const side = el("aside", "fill-side");
  const tabs = el("div", "tabs");
  const tabFields = button("tab", "Fields");
  const tabReview = button("tab", "Review");
  const tabOutput = button("tab", "Output");
  tabs.append(tabFields, tabReview, tabOutput);
  const panelFields = el("div", "fill-panel fill-panel--fields");
  const panelReview = el("div", "fill-panel");
  const panelOutput = el("div", "fill-panel");
  side.append(tabs, panelFields, panelReview, panelOutput);
  let activeTab: "fields" | "review" | "output" = "fields";

  const navigator = el("section", "fill-navigator");
  navigator.setAttribute("aria-label", "Field navigator");
  navigator.hidden = true;

  const leaveBar = el("section", "fill-leave");
  leaveBar.hidden = true;
  leaveBar.append(
    el("strong", "", "Unsaved values"),
    el("span", "", "Leaving now loses them. They were never stored anywhere."),
    el("span", "spacer")
  );
  const stayButton = button("button ghost tiny", "Keep filling");
  const leaveButton = button("button danger tiny", "Leave anyway");
  leaveBar.append(stayButton, leaveButton);

  workspace.append(rail, stage, side, navigator);
  root.append(bar, pickArea, workspace, leaveBar);

  /* ------------------------------ behavior ------------------------------ */

  function currentGeometry(scale: number): PageGeometry | null {
    if (!pageHandle) return null;
    const info = pageHandle.info;
    return { viewBox: info.viewBox, rotation: info.rotation, scale };
  }

  function fitScale(): number {
    if (!pageHandle) return 1;
    const width = paper.clientWidth || FIT_WIDTH_FALLBACK;
    const base = Math.min(1, width / pageHandle.info.width);
    return base * zoom;
  }

  function setTool(next: Tool): void {
    tool = next;
    for (const [name, node] of toolButtons) node.classList.toggle("active", name === next);
    hitLayer.hidden = next === "fields" || next === "signature";
    if (next !== "signature") hideSignaturePad();
    else showSignaturePad();
  }

  let signaturePad: SignaturePadHandle | null = null;

  function showSignaturePad(): void {
    signatureHost.replaceChildren();
    signatureHost.hidden = false;
    signaturePad = createSignaturePad(SIGNATURE_PAD.width, SIGNATURE_PAD.height);
    const note = el("p", "muted small", "Draw your signature, then place it on the page.");
    const actions = el("div", "fill-signature__actions");
    const clear = button("button ghost tiny", "Clear");
    const place = button("button tiny", "Place on page");
    const cancel = button("button danger tiny", "Cancel");
    clear.addEventListener("click", () => signaturePad?.clear());
    cancel.addEventListener("click", () => setTool("fields"));
    place.addEventListener("click", () => {
      if (!state || !signaturePad || signaturePad.isEmpty() || !pageHandle) return;
      // Center the pad near the bottom of the page in user space.
      const [x1, y1, x2, y2] = pageHandle.info.viewBox;
      const origin = { x: (x1 + x2 - SIGNATURE_PAD.width) / 2, y: y1 + (y2 - y1) * 0.08 };
      try {
        setState(
          addPlacement(state, {
            kind: "signature",
            page: currentPage,
            rect: { x: origin.x, y: origin.y, width: SIGNATURE_PAD.width, height: SIGNATURE_PAD.height },
            strokes: signaturePad.strokes()
          }),
          { rebuildOverlay: false }
        );
        setTool("fields");
      } catch (error) {
        notice(error instanceof Error ? error.message : "The signature could not be placed.");
      }
    });
    actions.append(clear, place, cancel);
    signatureHost.append(note, signaturePad.element, actions);
  }

  function hideSignaturePad(): void {
    signaturePad?.destroy();
    signaturePad = null;
    signatureHost.hidden = true;
    signatureHost.replaceChildren();
  }

  /**
   * Snapshot and restore the focused overlay input across rebuilds so a
   * dock-to-stack resize or a value refresh never loses focus or caret.
   */
  function refreshOverlays(geo: PageGeometry): void {
    const active = document.activeElement;
    let focus: { fieldId: string; index: number; start: number | null; end: number | null } | null = null;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
      const box = active.closest<HTMLElement>(".field-box");
      const fieldId = box?.dataset.fieldId;
      if (fieldId) {
        const siblings = [...overlay.element.querySelectorAll(`[data-field-id="${fieldId}"] input, [data-field-id="${fieldId}"] textarea`)];
        focus = {
          fieldId,
          index: Math.max(0, siblings.indexOf(active)),
          start: active.selectionStart,
          end: active.selectionEnd
        };
      }
    }
    if (state) {
      overlay.update({
        fields: state.inventory.fields.filter((field) => field.widgets.some((widget) => widget.page === currentPage)),
        geometry: geo,
        page: currentPage,
        values: state.fields
      });
    }
    renderPlacements(geo);
    if (focus) {
      const boxes = [...overlay.element.querySelectorAll<HTMLElement>(`[data-field-id="${focus.fieldId}"]`)];
      const target = boxes[focus.index]?.querySelector("input, textarea");
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        target.focus();
        try {
          target.setSelectionRange(focus.start, focus.end);
        } catch {
          // Non-text inputs reject selection ranges; focus alone is enough.
        }
      }
    }
  }

  function setState(next: FormFillState, options: { rebuildOverlay?: boolean } = {}): void {
    state = next;
    unsavedDot.hidden = !next.dirty;
    renderFieldList();
    renderReview();
    const geo = currentGeometry(fitScale());
    if (options.rebuildOverlay === false || !geo) renderPlacements();
    else refreshOverlays(geo);
  }

  function notice(text: string): void {
    notices.replaceChildren(el("div", "warn", text));
  }

  function renderNotices(): void {
    if (!state) return;
    notices.replaceChildren();
    const computed = state.inventory.fields.filter((field) => field.computed && field.type !== "group");
    if (computed.length > 0) {
      notices.append(
        el(
          "div",
          "warn",
          `${computed.length} calculated field${computed.length === 1 ? "" : "s"}: the document's own arithmetic does not run, so written values are kept as-is.`
        )
      );
    }
    const warnings = [...inventoryWarnings];
    for (const warning of warnings) notices.append(el("div", "warn", warning));
    if (computed.length > 0 || inventoryWarnings.length > 0) {
      notices.append(el("div", "warn", "Document scripts do not run and are removed from the new PDF."));
    }
  }

  let inventoryWarnings: string[] = [];

  function statusTag(status: string): HTMLElement {
    const tag = el("span", `tag tag--${status}`, STATUS_LABEL[status] ?? status);
    return tag;
  }

  function renderFieldList(): void {
    panelFields.replaceChildren();
    if (!state) return;
    const fillable = state.inventory.fields.filter((field) => field.widgets.length > 0 || field.type !== "group");
    const answered = Object.values(state.fields).filter((value) => value.status === "answered").length;
    panelFields.append(el("h2", "", `Fields ${answered} of ${state.inventory.fields.length} answered`));
    if (state.inventory.fields.length === 0) {
      panelFields.append(
        el("p", "muted small", "This document has no fillable fields. Use the tools on the left to place text, a checkmark or your signature.")
      );
      return;
    }
    const list = el("div", "field-list");
    for (const field of state.inventory.fields) {
      const row = el("div", "field");
      const top = el("div", "field-top");
      const name = el("strong", field.label ? "" : "opaque", fieldLabel(field));
      top.append(name);
      const value = state.fields[field.fieldId];
      const tag = field.readOnly
        ? el("span", "tag", "Read only")
        : field.computed
          ? el("span", "tag", "Computed")
          : !field.label
            ? el("span", "tag open", "No label")
            : statusTag(value?.status ?? "unknown");
      top.append(tag);
      row.append(top);
      if (!isFillable(field) && field.type !== "signature") {
        row.append(el("div", "muted small", field.type === "group" ? "Group of fields" : field.type));
      } else if (field.type === "signature") {
        row.append(el("div", "muted small", "Signature field. Draw your own signature with the Sign tool."));
      } else {
        const shown = field.type === "checkbox" || field.type === "radio"
          ? value?.value === onValue(field) || (field.type === "radio" && field.allowedValues?.some((o) => o.text === value?.value))
            ? value?.value ?? ""
            : ""
          : value?.value ?? "";
        row.append(el("div", "value", shown === "Off" ? "" : shown));
      }
      row.addEventListener("click", () => jumpToField(field.fieldId));
      list.append(row);
    }
    panelFields.append(list);
    renderNavigatorList();
  }

  function renderNavigatorList(): void {
    navigator.replaceChildren();
    const head = el("div", "fill-navigator__head");
    head.append(el("h2", "", "Field navigator"));
    head.append(el("div", "muted small", `Press ${shortcutKey.toUpperCase()} to open, arrows to choose, Enter to jump.`));
    const toggle = document.createElement("label");
    toggle.className = "muted small";
    const toggleInput = document.createElement("input");
    toggleInput.type = "checkbox";
    toggleInput.checked = shortcutEnabled;
    toggleInput.addEventListener("change", () => {
      shortcutEnabled = toggleInput.checked;
    });
    toggle.append(toggleInput, " Shortcut key");
    head.append(toggle);
    const list = el("div", "field-grid");
    const snapshot = state;
    if (snapshot) {
      snapshot.inventory.fields.forEach((field, index) => {
        const item = el("div", "field");
        item.tabIndex = -1;
        const name = el("strong", field.label ? "" : "opaque", fieldLabel(field));
        item.append(name, el("br"), statusTag(snapshot.fields[field.fieldId]?.status ?? "unknown"));
        item.addEventListener("click", () => jumpToField(field.fieldId));
        item.dataset.index = String(index);
        list.append(item);
      });
    }
    const closeHint = el("span", "closekey", "Esc closes");
    navigator.append(head, list, closeHint);
  }

  let navigatorIndex = 0;

  function toggleNavigator(open?: boolean): void {
    const show = open ?? navigator.hidden;
    navigator.hidden = !show;
    if (show) {
      navigatorIndex = 0;
      markNavigatorItem();
      navigator.querySelector<HTMLElement>(".field")?.focus();
    }
  }

  function markNavigatorItem(): void {
    navigator.querySelectorAll(".field").forEach((node, index) => {
      node.classList.toggle("active", index === navigatorIndex);
      if (index === navigatorIndex && node instanceof HTMLElement) node.focus();
    });
  }

  function jumpToField(fieldId: string): void {
    if (!state) return;
    const field = state.inventory.fields.find((entry) => entry.fieldId === fieldId);
    const widget = field?.widgets[0];
    if (!widget) return;
    toggleNavigator(false);
    if (widget.page !== currentPage) {
      currentPage = widget.page;
      void renderPage().then(() => overlay.focusField(fieldId));
      return;
    }
    overlay.focusField(fieldId);
  }

  function renderReview(): void {
    panelReview.replaceChildren();
    if (!state) return;
    panelReview.append(el("p", "small muted", "Agent plan"));
    const proposals = state.inventory.fields.filter(
      (field) => state?.fields[field.fieldId]?.status === "proposed"
    );
    const decided = state.inventory.fields.filter((field) => {
      const value = state?.fields[field.fieldId];
      return value && (value.status === "answered" || value.status === "skipped") && field.type !== "signature" && field.type !== "group";
    });
    panelReview.append(el("h2", "", `${proposals.length} proposals to review`));
    if (pendingPlan) {
      panelReview.append(el("p", "muted small", "A plan is loaded. Undecided proposals are left unchanged in the approved plan."));
    }
    for (const field of proposals) {
      const value = state.fields[field.fieldId];
      const card = el("div", "proposal");
      const head = el("div", "proposal-head");
      head.append(el("strong", "", fieldLabel(field)), el("span", "tag green", "In position"));
      card.append(head, el("div", "value", value?.value ?? ""));
      const actions = el("div", "actions");
      const accept = button("button tiny", "Accept");
      const reject = button("button danger tiny", "Reject");
      accept.addEventListener("click", () => setState(approveField(state!, field.fieldId)));
      reject.addEventListener("click", () => {
        setState(rejectField(state!, field.fieldId));
      });
      actions.append(accept, reject);
      card.append(actions);
      panelReview.append(card);
    }
    for (const field of decided.filter((field) => !proposals.includes(field))) {
      const value = state.fields[field.fieldId];
      const card = el("div", "proposal");
      const head = el("div", "proposal-head");
      head.append(el("strong", "", fieldLabel(field)), statusTag(value!.status));
      card.append(head, el("div", "value", value?.value ?? ""));
      panelReview.append(card);
    }
    if (droppedSignatures > 0) {
      panelReview.append(el("div", "warn", `${droppedSignatures} signature placement${droppedSignatures === 1 ? "" : "s"} in the plan were ignored. Only you can draw a signature.`));
    }
    const approve = button("button", "Approve plan and download receipt");
    approve.addEventListener("click", () => void approvePlan());
    panelReview.append(approve);
  }

  let droppedSignatures = 0;

  function renderOutput(result?: FillFormResult): void {
    panelOutput.replaceChildren();
    if (!state) return;
    const editable = document.createElement("label");
    editable.className = "choice";
    const burnable = document.createElement("label");
    burnable.className = "choice";
    const radioEdit = document.createElement("input");
    radioEdit.type = "radio";
    radioEdit.name = "burnin";
    radioEdit.checked = !state.burnIn;
    const radioBurn = document.createElement("input");
    radioBurn.type = "radio";
    radioBurn.name = "burnin";
    radioBurn.checked = state.burnIn;
    editable.append(radioEdit, el("span", "", "Keep fields editable"));
    burnable.append(radioBurn, el("span", "", "Burn values into the page"));
    radioEdit.addEventListener("change", () => state && setState(setBurnIn(state, false), { rebuildOverlay: false }));
    radioBurn.addEventListener("change", () => state && setState(setBurnIn(state, true), { rebuildOverlay: false }));
    panelOutput.append(el("strong", "small", "Output"), editable, burnable);
    const exportStatus = el("p", "progress");
    exportStatus.setAttribute("role", "status");
    exportStatus.id = "fill-export-status";
    panelOutput.append(exportStatus);
    if (result?.ok && result.downloadUrl) {
      const link = document.createElement("a");
      link.className = "button";
      link.textContent = "Download filled PDF";
      link.href = result.downloadUrl;
      panelOutput.append(link);
      for (const warning of result.warnings ?? []) {
        panelOutput.append(el("div", "warn", warning));
      }
      if ((result.computedFields ?? 0) > 0) {
        panelOutput.append(el("div", "warn", `${result.computedFields} calculated field(s) kept their written value.`));
      }
    } else if (result) {
      panelOutput.append(el("p", "error", result.message ?? "The fill was refused."));
    }
  }

  async function renderPage(): Promise<void> {
    if (!doc || !state || destroyed) return;
    const myGeneration = ++generation;
    renderTask?.cancel();
    renderTask = null;
    try {
      pageHandle = await doc.getPage(currentPage);
    } catch {
      if (myGeneration === generation) notice("This page could not be rendered.");
      return;
    }
    if (destroyed || myGeneration !== generation) return;
    const scale = fitScale();
    const geo = currentGeometry(scale);
    if (!geo) return;
    const size = viewportSize(geo);
    if (size.width * size.height > MAX_PAGE_CANVAS_PIXELS) {
      notice("The page is too large to render at this zoom.");
      return;
    }
    paper.style.width = `${size.width}px`;
    paper.style.height = `${size.height}px`;
    pageLabel.textContent = `Page ${currentPage} of ${pageCount}`;
    zoomLabel.textContent = `${Math.round(scale * 100)} %`;
    const task = pageHandle.render(pageCanvas, scale);
    renderTask = task;
    void task.done.then(
      () => {
        if (renderTask === task) renderTask = null;
      },
      () => {
        if (renderTask === task) renderTask = null;
      }
    );
    // refreshOverlays rebuilds inputs and placements while restoring focus
    // and caret, so a resize-driven re-render never drops an edited field.
    refreshOverlays(geo);
    renderNotices();
  }

  function renderPlacements(geo?: PageGeometry): void {
    const resolved = geo ?? currentGeometry(fitScale());
    if (!state || !resolved) {
      placements.update({
        placements: [],
        geometry: { viewBox: [0, 0, 1, 1], rotation: 0, scale: 1 },
        page: currentPage,
        selectedId: null
      });
      return;
    }
    placements.update({ placements: state.placements, geometry: resolved, page: currentPage, selectedId: selectedPlacement });
  }

  function applyLayout(): void {
    const width = root.clientWidth || window.innerWidth;
    root.dataset.layout = layoutFor(width);
    if (doc && state) void renderPage();
  }

  function setTab(tab: "fields" | "review" | "output"): void {
    activeTab = tab;
    tabFields.classList.toggle("active", tab === "fields");
    tabReview.classList.toggle("active", tab === "review");
    tabOutput.classList.toggle("active", tab === "output");
    panelFields.hidden = tab !== "fields";
    panelReview.hidden = tab !== "review";
    panelOutput.hidden = tab !== "output";
    if (tab === "output") renderOutput();
  }

  /* ------------------------------ actions ------------------------------- */

  async function openFile(file: File): Promise<void> {
    if (destroyed) return;
    pickStatus.textContent = "Opening document and reading its fields...";
    const controller = new AbortController();
    controllers.add(controller);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const [document, inventoryResponse] = await Promise.all([
        openDocument(bytes),
        fetchInventory(file, controller.signal)
      ]);
      if (destroyed) {
        await document.destroy();
        return;
      }
      if (!inventoryResponse.ok || !inventoryResponse.inventory) {
        await document.destroy();
        pickStatus.textContent = inventoryResponse.message ?? "The document's fields could not be read.";
        return;
      }
      doc = document;
      sourceFile = file;
      sourceBytes = bytes;
      pageCount = document.pageCount;
      inventoryWarnings = inventoryResponse.warnings ?? [];
      state = createFormState(parseFormInventory(inventoryResponse.inventory));
      if (pendingPlan) {
        const loaded = loadPlan(state, pendingPlan);
        state = loaded.state;
        droppedSignatures = loaded.droppedSignatures;
        pendingPlan = null;
      }
      fileName.textContent = file.name;
      pickArea.hidden = true;
      workspace.hidden = false;
      currentPage = 1;
      setTab("fields");
      setTool("fields");
      unsavedDot.hidden = !state.dirty;
      renderFieldList();
      renderReview();
      applyLayout();
      pickStatus.textContent = "";
    } catch (error) {
      pickStatus.textContent = error instanceof Error ? error.message : "The document could not be opened.";
    } finally {
      controllers.delete(controller);
    }
  }

  async function readPlanFile(file: File): Promise<void> {
    try {
      pendingPlan = parseFormPlan(JSON.parse(await file.text()));
      if (state) {
        const loaded = loadPlan(state, pendingPlan);
        droppedSignatures = loaded.droppedSignatures;
        pendingPlan = null;
        setState(loaded.state);
      }
      pickStatus.textContent = "Plan loaded.";
    } catch (error) {
      pickStatus.textContent = error instanceof Error ? error.message : "The plan could not be read.";
    }
  }

  function trackUrl(url: string): string {
    objectUrls.add(url);
    return url;
  }

  function downloadFile(name: string, blob: Blob): void {
    const url = trackUrl(URL.createObjectURL(blob));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
  }

  async function exportPdf(): Promise<void> {
    if (!state || !sourceFile || exporting) return;
    exporting = true;
    exportButton.disabled = true;
    const controller = new AbortController();
    controllers.add(controller);
    try {
      const plan = derivePlan(state);
      const result = await submitFill(sourceFile, plan, controller.signal);
      if (destroyed) return;
      if (result.ok && result.downloadUrl) {
        const blob = await download(result.downloadUrl, controller.signal);
        if (destroyed) return;
        const url = trackUrl(URL.createObjectURL(blob));
        setTab("output");
        renderOutput({ ...result, downloadUrl: url });
        state = markSaved(state);
        unsavedDot.hidden = true;
      } else {
        setTab("output");
        renderOutput(result);
      }
    } catch (error) {
      if (!destroyed) {
        setTab("output");
        renderOutput({ ok: false, message: error instanceof Error ? error.message : "The fill failed." });
      }
    } finally {
      controllers.delete(controller);
      exporting = false;
      exportButton.disabled = false;
    }
  }

  async function approvePlan(): Promise<void> {
    if (!state || !sourceBytes) return;
    const plan = derivePlan(state);
    const planBytes = serializeFormPlan(plan);
    const planDigest = await sha256Hex(planBytes);
    const sourceDigest = await sha256Hex(sourceBytes);
    const receipt = buildReceipt(plan.nonce, planDigest, sourceDigest);
    downloadFile("plan.approved.json", new Blob([planBytes], { type: "application/json" }));
    downloadFile("plan.approved.receipt.json", new Blob([serializeReceipt(receipt)], { type: "application/json" }));
    state = markSaved(state);
    unsavedDot.hidden = true;
  }

  /* ------------------------------ lifecycle ----------------------------- */

  function requestExit(): void {
    if (state?.dirty) {
      leaveBar.hidden = false;
      return;
    }
    deps.onExit();
  }

  backLink.addEventListener("click", (event) => {
    event.preventDefault();
    requestExit();
  });
  closeButton.addEventListener("click", requestExit);
  stayButton.addEventListener("click", () => {
    leaveBar.hidden = true;
  });
  leaveButton.addEventListener("click", () => deps.onExit());
  exportButton.addEventListener("click", () => {
    setTab("output");
    void exportPdf();
  });
  prevPage.addEventListener("click", () => {
    if (currentPage > 1) {
      currentPage -= 1;
      void renderPage();
    }
  });
  nextPage.addEventListener("click", () => {
    if (currentPage < pageCount) {
      currentPage += 1;
      void renderPage();
    }
  });
  zoomOut.addEventListener("click", () => {
    zoom = Math.max(0.5, zoom / 1.25);
    void renderPage();
  });
  zoomIn.addEventListener("click", () => {
    zoom = Math.min(3, zoom * 1.25);
    void renderPage();
  });
  pickInput.addEventListener("change", () => {
    const file = pickInput.files?.[0];
    if (file) void openFile(file);
  });
  planInput.addEventListener("change", () => {
    const file = planInput.files?.[0];
    if (file) void readPlanFile(file);
  });
  tabFields.addEventListener("click", () => setTab("fields"));
  tabReview.addEventListener("click", () => setTab("review"));
  tabOutput.addEventListener("click", () => setTab("output"));

  hitLayer.addEventListener("click", (event) => {
    if (!state || tool === "fields" || tool === "signature") return;
    const geo = currentGeometry(fitScale());
    if (!geo) return;
    const box = paper.getBoundingClientRect();
    const point = { x: event.clientX - box.left, y: event.clientY - box.top };
    const user = screenToUser(geo, point.x, point.y);
    const size = tool === "checkmark" ? CHECKMARK_SIZE : TEXT_PLACEMENT_SIZE;
    try {
      setState(
        addPlacement(state, {
          kind: tool,
          page: currentPage,
          rect: { x: user.x, y: user.y, width: size.width, height: size.height },
          text: tool === "text" ? "" : undefined
        }),
        { rebuildOverlay: false }
      );
      selectedPlacement = state.placements[state.placements.length - 1]?.id ?? null;
      renderPlacements();
      setTool("fields");
    } catch (error) {
      notice(error instanceof Error ? error.message : "The placement could not be added.");
    }
  });

  const onKeydown = (event: KeyboardEvent): void => {
    const target = event.target;
    const editable =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      (target instanceof HTMLElement && target.isContentEditable);
    if (event.key === "Escape" && !navigator.hidden) {
      toggleNavigator(false);
      return;
    }
    if (editable || event.ctrlKey || event.metaKey || event.altKey) return;
    const focusInside = root.contains(document.activeElement) || document.activeElement === document.body;
    if (!focusInside || !shortcutEnabled) return;
    if (event.key.toLowerCase() === shortcutKey) {
      toggleNavigator();
      event.preventDefault();
      return;
    }
    if (!navigator.hidden && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      const count = state?.inventory.fields.length ?? 0;
      if (count === 0) return;
      navigatorIndex = (navigatorIndex + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
      markNavigatorItem();
      event.preventDefault();
      return;
    }
    if (!navigator.hidden && event.key === "Enter") {
      const field = state?.inventory.fields[navigatorIndex];
      if (field) jumpToField(field.fieldId);
      event.preventDefault();
    }
  };
  document.addEventListener("keydown", onKeydown);

  const onBeforeUnload = (event: BeforeUnloadEvent): void => {
    if (state?.dirty) {
      event.preventDefault();
      event.returnValue = "";
    }
  };
  window.addEventListener("beforeunload", onBeforeUnload);

  const onResize = (): void => applyLayout();
  window.addEventListener("resize", onResize);

  setTool("fields");

  return {
    element: root,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      generation += 1;
      document.removeEventListener("keydown", onKeydown);
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("resize", onResize);
      for (const controller of controllers) controller.abort();
      controllers.clear();
      renderTask?.cancel();
      renderTask = null;
      pageCanvas.width = 0;
      pageCanvas.height = 0;
      signaturePad?.destroy();
      signaturePad = null;
      const handle = doc;
      doc = null;
      if (handle) void Promise.resolve(handle.destroy()).catch(() => undefined);
      for (const url of objectUrls) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // Best effort.
        }
      }
      objectUrls.clear();
    }
  };
}
