/**
 * Immutable fill-surface model. Every transition returns a new state; the UI
 * renders from it and nothing here touches the document, the network or any
 * browser storage. Field values and placements stay separate so an approved
 * plan can be derived byte-stably for the fill route and for a receipt.
 *
 * Status semantics follow KTD8: the person types or approves (`answered`),
 * declines (`skipped`), an agent plan arrives `proposed`, and anything
 * untouched stays `unknown`. Only `answered` entries carry a value into the
 * plan; everything else derives as `skipped` so apply-strict validation sees
 * terminal statuses and unapproved proposals can never be written.
 */

import type { FormFieldEntry, FormInventory } from "@pdf-compressor/core/form-inventory";
import {
  FORM_PLAN_VERSION,
  MAX_PLAN_PLACEMENTS,
  MAX_SIGNATURE_POINTS,
  type FormPlan,
  type FormPlanEntry,
  type FormPlanEntryStatus,
  type PdfRect
} from "@pdf-compressor/core/form-plan";

/** The loopback route rebinds these role names to private job paths (KTD12). */
export const PLAN_SOURCE_BINDING = "upload";
export const PLAN_DESTINATION_BINDING = "download";

/** Field types the surface can accept input for. */
export const FILLABLE_TYPES = new Set(["text", "checkbox", "radio", "choice"]);

/** Logical pad a drawn signature is recorded in, in PDF points. */
export const SIGNATURE_PAD = { width: 220, height: 72 } as const;
export const TEXT_PLACEMENT_SIZE = { width: 180, height: 18 } as const;
export const CHECKMARK_SIZE = { width: 14, height: 14 } as const;

/** Receipt shape minted on approval; identical to the CLI contract (KTD7). */
export const FORM_RECEIPT_VERSION = 1 as const;
export const RECEIPT_WINDOW_MS = 30 * 60 * 1000;
export interface FormReceipt {
  readonly version: typeof FORM_RECEIPT_VERSION;
  readonly receiptId: string;
  readonly nonce: string;
  readonly planDigest: string;
  readonly sourceDigest: string;
  readonly channel: "browser";
  readonly mintedAt: string;
  readonly expiresAt: string;
}

export interface FieldState {
  readonly status: FormPlanEntryStatus;
  /**
   * The input text for text and choice fields; the chosen export value for
   * checkbox and radio fields ("Off" means unchecked).
   */
  readonly value: string;
}

export type PlacementKind = "text" | "checkmark" | "signature";

export interface Placement {
  readonly id: string;
  readonly kind: PlacementKind;
  /** One-based page number within the plan's source. */
  readonly page: number;
  /**
   * Anchor and extent in PDF user space. For signatures this is the pad
   * position; `strokes` are rect-local so a drag moves the whole drawing.
   */
  readonly rect: PdfRect;
  readonly text: string;
  /** Signature strokes in rect-local user space: flat [x, y, x, y, ...]. */
  readonly strokes: readonly (readonly number[])[];
}

export interface FormFillState {
  readonly inventory: FormInventory;
  /** Fillable field id -> current status and value. */
  readonly fields: Readonly<Record<string, FieldState>>;
  readonly placements: readonly Placement[];
  readonly burnIn: boolean;
  /** The loaded agent plan's nonce, kept so approval binds the same plan. */
  readonly planNonce: string | null;
  /** The loaded plan's bindings, kept so an approved plan still names the agent's paths (F3). */
  readonly planSource: string | null;
  readonly planDestination: string | null;
  /** The loaded plan's overwrite decision, kept because it is part of what the person approves. */
  readonly planOverwrite: boolean | null;
  /** True once any value, placement or review decision exists to lose. */
  readonly dirty: boolean;
}

export class FormModelError extends Error {
  constructor(
    readonly code: "CONTROL_CHARS" | "PLACEMENT_LIMIT" | "UNKNOWN_FIELD" | "NOT_FILLABLE" | "STROKE_LIMIT",
    message: string
  ) {
    super(message);
    this.name = "FormModelError";
  }
}

const CONTROL_CHARS = /[\x00-\x1F\x7F-\x9F]/;
const HEX = "0123456789abcdef";

export function isFillable(field: FormFieldEntry): boolean {
  return FILLABLE_TYPES.has(field.type) && !field.readOnly;
}

/** A checkbox's on-state: the document's own export value, or the default. */
export function onValue(field: FormFieldEntry): string {
  return field.allowedValues?.find((option) => option.text !== "Off")?.text ?? "Yes";
}

/** A radio widget's on-state, indexed in the same order as `allowedValues`. */
export function radioValue(field: FormFieldEntry, widgetIndex: number): string {
  return field.allowedValues?.[widgetIndex]?.text ?? field.allowedValues?.[0]?.text ?? "Yes";
}

export function createFormState(inventory: FormInventory): FormFillState {
  const fields: Record<string, FieldState> = {};
  for (const field of inventory.fields) {
    if (!FILLABLE_TYPES.has(field.type)) continue;
    fields[field.fieldId] = { status: "unknown", value: field.currentValue ?? "" };
  }
  return Object.freeze({
    inventory,
    fields: Object.freeze(fields),
    placements: Object.freeze([]),
    burnIn: false,
    planNonce: null,
    planSource: null,
    planDestination: null,
    planOverwrite: null,
    dirty: false
  });
}

function withField(state: FormFillState, fieldId: string, next: FieldState): FormFillState {
  const field = state.inventory.fields.find((entry) => entry.fieldId === fieldId);
  if (!field) throw new FormModelError("UNKNOWN_FIELD", `No field "${fieldId}" in this document.`);
  if (!isFillable(field)) {
    throw new FormModelError(
      "NOT_FILLABLE",
      `Field "${fieldId}" is ${field.readOnly ? "read-only" : `type ${field.type}`}.`
    );
  }
  const current = state.fields[fieldId];
  if (current && current.status === next.status && current.value === next.value) return state;
  return { ...state, fields: { ...state.fields, [fieldId]: next }, dirty: true };
}

function assertText(value: string): void {
  if (CONTROL_CHARS.test(value)) {
    throw new FormModelError("CONTROL_CHARS", "Values cannot carry control characters.");
  }
}

/** Type into a text or choice field. Values are clamped to the field's limit. */
export function setFieldText(state: FormFillState, fieldId: string, value: string): FormFillState {
  const field = state.inventory.fields.find((entry) => entry.fieldId === fieldId);
  if (field && !isFillable(field)) {
    // A read-only field refuses edits without breaking the caller (R-cases).
    if (field.readOnly) return state;
  }
  assertText(value);
  const clamped =
    field?.maxLength !== undefined && value.length > field.maxLength
      ? value.slice(0, field.maxLength)
      : value;
  return withField(state, fieldId, { status: "answered", value: clamped });
}

/** Toggle a checkbox between its on-state and "Off". */
export function toggleCheckbox(state: FormFillState, fieldId: string): FormFillState {
  const field = state.inventory.fields.find((entry) => entry.fieldId === fieldId);
  if (!field) throw new FormModelError("UNKNOWN_FIELD", `No field "${fieldId}" in this document.`);
  if (field.type !== "checkbox") throw new FormModelError("NOT_FILLABLE", `Field "${fieldId}" is not a checkbox.`);
  if (field.readOnly) return state;
  const checked = state.fields[fieldId]?.value;
  const next = checked === onValue(field) ? "Off" : onValue(field);
  return withField(state, fieldId, { status: "answered", value: next });
}

/** Choose one export value of a radio group or one option of a choice field. */
export function chooseOption(state: FormFillState, fieldId: string, value: string): FormFillState {
  const field = state.inventory.fields.find((entry) => entry.fieldId === fieldId);
  if (field && field.readOnly) return state;
  assertText(value);
  return withField(state, fieldId, { status: "answered", value });
}

/** Mark a field deliberately unanswered; the source value stands. */
export function skipField(state: FormFillState, fieldId: string): FormFillState {
  const field = state.inventory.fields.find((entry) => entry.fieldId === fieldId);
  if (field && field.readOnly) return state;
  return withField(state, fieldId, { status: "skipped", value: "" });
}

/** Accept a proposal: the shown value becomes the approved value. */
export function approveField(state: FormFillState, fieldId: string): FormFillState {
  const current = state.fields[fieldId];
  if (!current || current.status !== "proposed") return state;
  return withField(state, fieldId, { status: "answered", value: current.value });
}

/** Decline a proposal: the field returns to open for a manual value. */
export function rejectField(state: FormFillState, fieldId: string): FormFillState {
  const current = state.fields[fieldId];
  if (!current || current.status !== "proposed") return state;
  return withField(state, fieldId, { status: "unknown", value: "" });
}

export function setBurnIn(state: FormFillState, burnIn: boolean): FormFillState {
  if (state.burnIn === burnIn) return state;
  return { ...state, burnIn };
}

let placementCounter = 0;

function nextPlacementId(): string {
  placementCounter += 1;
  return `p${placementCounter}`;
}

function countStrokePoints(strokes: readonly (readonly number[])[]): number {
  return strokes.reduce((sum, stroke) => sum + stroke.length / 2, 0);
}

export interface PlacementInput {
  readonly kind: PlacementKind;
  readonly page: number;
  readonly rect: PdfRect;
  readonly text?: string;
  readonly strokes?: readonly (readonly number[])[];
}

/** Add a free placement; signatures carry rect-local strokes. */
export function addPlacement(state: FormFillState, input: PlacementInput): FormFillState {
  if (state.placements.length >= MAX_PLAN_PLACEMENTS) {
    throw new FormModelError("PLACEMENT_LIMIT", `At most ${MAX_PLAN_PLACEMENTS} placements per document.`);
  }
  const strokes = input.strokes ?? [];
  if (countStrokePoints(strokes) > MAX_SIGNATURE_POINTS) {
    throw new FormModelError("STROKE_LIMIT", "The signature has too many points.");
  }
  const text = input.text ?? "";
  assertText(text);
  const placement: Placement = {
    id: nextPlacementId(),
    kind: input.kind,
    page: input.page,
    rect: input.rect,
    text,
    strokes: strokes.map((stroke) => [...stroke])
  };
  return { ...state, placements: [...state.placements, placement], dirty: true };
}

/** Move a placement; rect width and height stay fixed, only the anchor moves. */
export function movePlacement(state: FormFillState, id: string, x: number, y: number): FormFillState {
  return {
    ...state,
    placements: state.placements.map((placement) =>
      placement.id === id ? { ...placement, rect: { ...placement.rect, x, y } } : placement
    ),
    dirty: true
  };
}

export function updatePlacementText(state: FormFillState, id: string, text: string): FormFillState {
  assertText(text);
  return {
    ...state,
    placements: state.placements.map((placement) =>
      placement.id === id ? { ...placement, text } : placement
    ),
    dirty: true
  };
}

export function removePlacement(state: FormFillState, id: string): FormFillState {
  if (!state.placements.some((placement) => placement.id === id)) return state;
  return { ...state, placements: state.placements.filter((placement) => placement.id !== id), dirty: true };
}

export interface LoadPlanResult {
  readonly state: FormFillState;
  /** Agent plans cannot place signatures; dropped entries are reported. */
  readonly droppedSignatures: number;
  /** Field entries naming fields the document does not contain. */
  readonly unknownFields: number;
}

/**
 * Merge a reviewed plan into the model: field entries land as their recorded
 * status so every proposal renders in position; placements land as draggable
 * placements. Signature placements are refused: only the person draws them.
 */
export function loadPlan(state: FormFillState, plan: FormPlan): LoadPlanResult {
  let fields: Record<string, FieldState> = { ...state.fields };
  const placements: Placement[] = [];
  let droppedSignatures = 0;
  let unknownFields = 0;
  for (const entry of plan.entries) {
    if (entry.kind === "field") {
      const field = state.inventory.fields.find((candidate) => candidate.fieldId === entry.fieldId);
      if (!field || !FILLABLE_TYPES.has(field.type)) {
        unknownFields += 1;
        continue;
      }
      if (entry.status === "answered" || entry.status === "proposed") {
        fields[entry.fieldId] = { status: entry.status, value: entry.value };
      } else {
        fields[entry.fieldId] = { status: entry.status, value: "" };
      }
      continue;
    }
    if (entry.kind === "signature") {
      droppedSignatures += 1;
      continue;
    }
    placements.push({
      id: nextPlacementId(),
      kind: entry.kind,
      page: entry.page,
      rect: entry.rect,
      text: entry.kind === "text" ? entry.text : "",
      strokes: []
    });
  }
  return {
    state: {
      ...state,
      fields: Object.freeze(fields),
      placements: [...state.placements, ...placements],
      burnIn: plan.burnIn,
      planNonce: plan.nonce,
      planSource: plan.source,
      planDestination: plan.destination,
      planOverwrite: plan.overwrite,
      dirty: true
    },
    droppedSignatures,
    unknownFields
  };
}

/** A nonce is printable ASCII up to 128 characters; 16 random bytes is plenty. */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let nonce = "";
  for (const byte of bytes) nonce += HEX[byte >> 4] + HEX[byte & 15];
  return nonce;
}

/** Fit the emitted text-placement box to its content without moving it. */
function textRect(placement: Placement): PdfRect {
  const needed = Math.ceil(placement.text.length * 6.6);
  return { ...placement.rect, width: Math.max(placement.rect.width, needed) };
}

/**
 * Derive the plan bytes the fill route or a downloaded receipt binds. Every
 * tracked field lands as a terminal entry (`answered` with its value, or
 * `skipped`) so apply-strict validation passes; undecided proposals are
 * never written. Placement strokes translate into page space here.
 */
export function derivePlan(state: FormFillState, nonce?: string): FormPlan {
  // A loaded plan keeps the agent's real bindings so the approved bytes are
  // the ones apply resolves (F3); without one, the browser names the roles
  // the fill route rebinds to job paths (F1, KTD12). Placement sources must
  // match plan.source or validation refuses them (FILL_PLAN_SOURCE_MISMATCH).
  const source = state.planSource ?? PLAN_SOURCE_BINDING;
  const destination = state.planDestination ?? PLAN_DESTINATION_BINDING;
  const entries: FormPlanEntry[] = [];
  for (const field of state.inventory.fields) {
    if (!FILLABLE_TYPES.has(field.type)) continue;
    const value = state.fields[field.fieldId];
    if (!value) continue;
    if (value.status === "answered") {
      entries.push({ kind: "field", fieldId: field.fieldId, status: "answered", value: value.value });
    } else {
      entries.push({ kind: "field", fieldId: field.fieldId, status: "skipped" });
    }
  }
  for (const placement of state.placements) {
    if (placement.kind === "signature") {
      const strokes = placement.strokes.map((stroke) =>
        stroke.map((point, index) => point + (index % 2 === 0 ? placement.rect.x : placement.rect.y))
      );
      entries.push({
        kind: "signature",
        source,
        page: placement.page,
        rect: placement.rect,
        strokes
      });
    } else if (placement.kind === "checkmark") {
      entries.push({ kind: "checkmark", source, page: placement.page, rect: placement.rect });
    } else {
      entries.push({
        kind: "text",
        source,
        page: placement.page,
        rect: textRect(placement),
        text: placement.text
      });
    }
  }
  return {
    version: FORM_PLAN_VERSION,
    source,
    destination,
    overwrite: state.planOverwrite ?? false,
    burnIn: state.burnIn,
    nonce: nonce ?? state.planNonce ?? generateNonce(),
    entries
  };
}

/** Mint the approval receipt bound to exact plan and source bytes (KTD7). */
export function buildReceipt(
  nonce: string,
  planDigest: string,
  sourceDigest: string,
  minted: Date = new Date()
): FormReceipt {
  return {
    version: FORM_RECEIPT_VERSION,
    receiptId: crypto.randomUUID(),
    nonce,
    planDigest,
    sourceDigest,
    channel: "browser",
    mintedAt: minted.toISOString(),
    expiresAt: new Date(minted.getTime() + RECEIPT_WINDOW_MS).toISOString()
  };
}

/** Canonical receipt file bytes, same key order the CLI writes. */
export function serializeReceipt(receipt: FormReceipt): string {
  return JSON.stringify({
    version: receipt.version,
    receiptId: receipt.receiptId,
    nonce: receipt.nonce,
    planDigest: receipt.planDigest,
    sourceDigest: receipt.sourceDigest,
    channel: receipt.channel,
    mintedAt: receipt.mintedAt,
    expiresAt: receipt.expiresAt
  });
}

export function markSaved(state: FormFillState): FormFillState {
  return state.dirty ? { ...state, dirty: false } : state;
}
