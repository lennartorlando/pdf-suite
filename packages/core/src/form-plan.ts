/**
 * Browser-safe, transport-neutral form-plan contract.
 *
 * This module is intentionally dependency-free beyond the shared schema base:
 * no Node.js imports, no filesystem access, no child processes. It is
 * published as the `@pdf-compressor/core/form-plan` subpath so browser code
 * never needs to import the Node-coupled core root.
 *
 * The plan file is the fill loop's only durable state (KTD8). It carries the
 * source binding, the destination, the overwrite and burn-in decisions and
 * the idempotency nonce, so no command-line option can redirect or reshape an
 * approval (KTD7, KTD18). Field entries are keyed by the object-reference
 * identifier of KTD5 and carry a status per KTD8; placements are keyed by
 * source binding and page number, never by visible index, with rectangles in
 * PDF user space: points, origin at the lower-left corner of the page's crop
 * box before any page rotation (KTD13). `source` and `destination` are
 * opaque adapter-owned bindings — a browser File handle id, a server job
 * path or a CLI path — and are never interpreted here.
 */

import {
  SchemaError,
  codePointLength,
  hasControlCharacters,
  isObjectReference,
  jsonDepth,
  type PdfRect
} from "./schema-error.js";

export { SchemaError, type PdfRect };

export const FORM_PLAN_VERSION = 1 as const;

export const MAX_PLAN_JSON_DEPTH = 5;
export const MAX_PLAN_FIELD_ENTRIES = 2000;
export const MAX_PLAN_PLACEMENTS = 200;
export const MAX_TEXT_VALUE_LENGTH = 8000;
export const MAX_SIGNATURE_POINTS = 20000;
export const MAX_LOCATOR_LENGTH = 4096;
export const MAX_NONCE_LENGTH = 128;

export type FormPlanEntryStatus = "unknown" | "proposed" | "answered" | "skipped";

export const FORM_PLAN_ENTRY_STATUSES: readonly FormPlanEntryStatus[] = [
  "unknown",
  "proposed",
  "answered",
  "skipped"
];

const ENTRY_STATUS_SET: ReadonlySet<string> = new Set(FORM_PLAN_ENTRY_STATUSES);

/**
 * Terminal statuses per KTD8: answered and skipped are terminal, proposed and
 * unknown are not. Validation is idempotent over the outstanding entries and
 * apply refuses unless every entry is terminal.
 */
export function isTerminalEntryStatus(status: FormPlanEntryStatus): boolean {
  return status === "answered" || status === "skipped";
}

/**
 * One fillable target. `answered` writes its approved value to every widget
 * of the field — an empty value clears it — while `skipped` writes nothing
 * and leaves the source value standing (KTD8). `value` is required exactly on
 * the value-carrying statuses, which keeps the impossible states
 * unrepresentable.
 */
export type FormPlanFieldEntry =
  | {
      readonly kind: "field";
      readonly fieldId: string;
      readonly status: "answered" | "proposed";
      readonly value: string;
    }
  | {
      readonly kind: "field";
      readonly fieldId: string;
      readonly status: "skipped" | "unknown";
    };

interface PlacementBase {
  /** Opaque adapter-owned binding of the source the placement lands on. */
  readonly source: string;
  /** One-based page number within the referenced source. */
  readonly page: number;
  readonly rect: PdfRect;
}

export interface FormPlanTextPlacement extends PlacementBase {
  readonly kind: "text";
  readonly text: string;
}

export interface FormPlanCheckmarkPlacement extends PlacementBase {
  readonly kind: "checkmark";
}

export interface FormPlanSignaturePlacement extends PlacementBase {
  readonly kind: "signature";
  /**
   * Drawn strokes in the same page space as `rect`; each stroke is a flat
   * [x, y, x, y, ...] point list and `rect` bounds the set.
   */
  readonly strokes: readonly (readonly number[])[];
}

export type FormPlanPlacement =
  | FormPlanTextPlacement
  | FormPlanCheckmarkPlacement
  | FormPlanSignaturePlacement;

export type FormPlanEntry = FormPlanFieldEntry | FormPlanPlacement;

export interface FormPlan {
  readonly version: typeof FORM_PLAN_VERSION;
  /** Opaque adapter-owned binding of the document being filled. */
  readonly source: string;
  /** Opaque adapter-owned binding of the result's destination. */
  readonly destination: string;
  readonly overwrite: boolean;
  readonly burnIn: boolean;
  readonly nonce: string;
  readonly entries: readonly FormPlanEntry[];
}

export const FORM_PLAN_ERROR_CODES = [
  "PLAN_INVALID",
  "PLAN_LIMIT_EXCEEDED",
  "PLAN_INVALID_SOURCE",
  "PLAN_INVALID_DESTINATION",
  "PLAN_INVALID_NONCE",
  "PLAN_INVALID_FIELD_ID",
  "PLAN_INVALID_STATUS",
  "PLAN_INVALID_VALUE",
  "PLAN_INVALID_PAGE",
  "PLAN_INVALID_RECT",
  "PLAN_INVALID_TEXT",
  "PLAN_INVALID_STROKES"
] as const;

export type FormPlanErrorCode = (typeof FORM_PLAN_ERROR_CODES)[number];

export class FormPlanError extends SchemaError<FormPlanErrorCode> {
  constructor(code: FormPlanErrorCode, message: string) {
    super(code, message);
    this.name = "FormPlanError";
  }
}

const PLAN_KEYS: readonly string[] = ["version", "source", "destination", "overwrite", "burnIn", "nonce", "entries"];
const FIELD_ENTRY_KEYS: readonly string[] = ["kind", "fieldId", "status", "value"];
const TEXT_PLACEMENT_KEYS: readonly string[] = ["kind", "source", "page", "rect", "text"];
const CHECKMARK_PLACEMENT_KEYS: readonly string[] = ["kind", "source", "page", "rect"];
const SIGNATURE_PLACEMENT_KEYS: readonly string[] = ["kind", "source", "page", "rect", "strokes"];
const RECT_KEYS: readonly string[] = ["x", "y", "width", "height"];

const NONCE_PATTERN = /^[\x21-\x7E]+$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  candidate: Record<string, unknown>,
  allowed: readonly string[],
  what: string
): void {
  const keys = Object.keys(candidate);
  if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) {
    throw new FormPlanError("PLAN_INVALID", `${what} must be exactly { ${allowed.join(", ")} }.`);
  }
}

function parseLocator(value: unknown, code: "PLAN_INVALID_SOURCE" | "PLAN_INVALID_DESTINATION", what: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new FormPlanError(code, `Plan ${what} must be a non-empty string.`);
  }
  if (codePointLength(value) > MAX_LOCATOR_LENGTH) {
    throw new FormPlanError(code, `Plan ${what} exceeds ${MAX_LOCATOR_LENGTH} characters.`);
  }
  if (hasControlCharacters(value)) {
    throw new FormPlanError(code, `Plan ${what} must not contain control characters.`);
  }
  return value;
}

function parseNonce(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_NONCE_LENGTH || !NONCE_PATTERN.test(value)) {
    throw new FormPlanError(
      "PLAN_INVALID_NONCE",
      `Plan nonce must be 1-${MAX_NONCE_LENGTH} printable ASCII characters without whitespace.`
    );
  }
  return value;
}

function parseValue(value: unknown, what: string, code: "PLAN_INVALID_VALUE" | "PLAN_INVALID_TEXT"): string {
  if (typeof value !== "string") {
    throw new FormPlanError(code, `${what} must be a string.`);
  }
  if (codePointLength(value) > MAX_TEXT_VALUE_LENGTH) {
    throw new FormPlanError(code, `${what} exceeds ${MAX_TEXT_VALUE_LENGTH} characters.`);
  }
  if (hasControlCharacters(value)) {
    throw new FormPlanError(code, `${what} must not contain control characters.`);
  }
  return value;
}

function parsePage(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new FormPlanError("PLAN_INVALID_PAGE", `Invalid page ${String(value)}: must be an integer >= 1.`);
  }
  return value;
}

function parseRect(value: unknown): PdfRect {
  if (!isPlainObject(value)) {
    throw new FormPlanError("PLAN_INVALID_RECT", "A placement rect must be an object.");
  }
  assertExactKeys(value, RECT_KEYS, "A placement rect");
  const { x, y, width, height } = value;
  if (typeof x !== "number" || typeof y !== "number" || typeof width !== "number" || typeof height !== "number" ||
      !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
    throw new FormPlanError("PLAN_INVALID_RECT", "A placement rect must have finite numeric x, y, width, height.");
  }
  if (width <= 0 || height <= 0) {
    throw new FormPlanError("PLAN_INVALID_RECT", "A placement rect must have positive width and height.");
  }
  return Object.freeze({ x, y, width, height });
}

function parseFieldEntry(candidate: Record<string, unknown>): FormPlanFieldEntry {
  const keys = Object.keys(candidate);
  if (
    keys.some((key) => !FIELD_ENTRY_KEYS.includes(key)) ||
    !keys.includes("fieldId") ||
    !keys.includes("status")
  ) {
    throw new FormPlanError(
      "PLAN_INVALID",
      'A field entry must be exactly { kind: "field", fieldId, status, value? }.'
    );
  }
  const fieldId = candidate["fieldId"];
  if (!isObjectReference(fieldId)) {
    throw new FormPlanError(
      "PLAN_INVALID_FIELD_ID",
      'A field entry fieldId must be an object reference "N G R" (KTD5).'
    );
  }
  const status = candidate["status"];
  if (typeof status !== "string" || !ENTRY_STATUS_SET.has(status)) {
    throw new FormPlanError(
      "PLAN_INVALID_STATUS",
      `Invalid status ${String(status)}: must be one of ${FORM_PLAN_ENTRY_STATUSES.join(", ")}.`
    );
  }
  const narrowed = status as FormPlanEntryStatus;
  if (narrowed === "answered" || narrowed === "proposed") {
    if (!keys.includes("value")) {
      throw new FormPlanError("PLAN_INVALID_VALUE", `A ${narrowed} entry must carry a value.`);
    }
    return Object.freeze({
      kind: "field",
      fieldId,
      status: narrowed,
      value: parseValue(candidate["value"], "A field entry value", "PLAN_INVALID_VALUE")
    });
  }
  if (keys.includes("value")) {
    throw new FormPlanError("PLAN_INVALID_VALUE", `A ${narrowed} entry must not carry a value.`);
  }
  return Object.freeze({ kind: "field", fieldId, status: narrowed });
}

function parsePlacementBase(candidate: Record<string, unknown>): { source: string; page: number; rect: PdfRect } {
  return {
    source: parseLocator(candidate["source"], "PLAN_INVALID_SOURCE", "placement source"),
    page: parsePage(candidate["page"]),
    rect: parseRect(candidate["rect"])
  };
}

function parseStrokes(value: unknown): readonly (readonly number[])[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new FormPlanError("PLAN_INVALID_STROKES", "A signature entry needs a non-empty strokes array.");
  }
  let points = 0;
  const strokes = value.map((stroke) => {
    if (!Array.isArray(stroke) || stroke.length < 2 || stroke.length % 2 !== 0) {
      throw new FormPlanError(
        "PLAN_INVALID_STROKES",
        "Each signature stroke must be a flat [x, y, ...] array with at least one point."
      );
    }
    for (const coordinate of stroke) {
      if (typeof coordinate !== "number" || !Number.isFinite(coordinate)) {
        throw new FormPlanError("PLAN_INVALID_STROKES", "Signature stroke coordinates must be finite numbers.");
      }
    }
    points += stroke.length / 2;
    if (points > MAX_SIGNATURE_POINTS) {
      throw new FormPlanError(
        "PLAN_LIMIT_EXCEEDED",
        `A signature carries at most ${MAX_SIGNATURE_POINTS} points.`
      );
    }
    return Object.freeze([...stroke]);
  });
  return Object.freeze(strokes);
}

function parseEntry(entry: unknown): FormPlanEntry {
  if (!isPlainObject(entry)) {
    throw new FormPlanError("PLAN_INVALID", "Each plan entry must be an object.");
  }
  switch (entry["kind"]) {
    case "field":
      return parseFieldEntry(entry);
    case "text": {
      assertExactKeys(entry, TEXT_PLACEMENT_KEYS, 'A text placement');
      const base = parsePlacementBase(entry);
      return Object.freeze({
        kind: "text",
        ...base,
        text: parseValue(entry["text"], "A text placement", "PLAN_INVALID_TEXT")
      });
    }
    case "checkmark":
      assertExactKeys(entry, CHECKMARK_PLACEMENT_KEYS, "A checkmark placement");
      return Object.freeze({ kind: "checkmark", ...parsePlacementBase(entry) });
    case "signature": {
      assertExactKeys(entry, SIGNATURE_PLACEMENT_KEYS, "A signature placement");
      const base = parsePlacementBase(entry);
      return Object.freeze({ kind: "signature", ...base, strokes: parseStrokes(entry["strokes"]) });
    }
    default:
      throw new FormPlanError("PLAN_INVALID", `Unknown plan entry kind ${String(entry["kind"])}.`);
  }
}

/**
 * Parse an unknown transport value into a validated immutable plan.
 * Closed schema: unknown keys are rejected, and depth, entry counts and
 * every carried string are bounded.
 */
export function parseFormPlan(value: unknown): FormPlan {
  if (jsonDepth(value) > MAX_PLAN_JSON_DEPTH) {
    throw new FormPlanError("PLAN_INVALID", `Plan exceeds the maximum JSON depth of ${MAX_PLAN_JSON_DEPTH}.`);
  }
  if (!isPlainObject(value)) {
    throw new FormPlanError("PLAN_INVALID", "Plan must be an object.");
  }
  assertExactKeys(value, PLAN_KEYS, "Plan");
  if (value["version"] !== FORM_PLAN_VERSION) {
    throw new FormPlanError("PLAN_INVALID", `Plan version must be ${FORM_PLAN_VERSION}.`);
  }
  const entriesValue = value["entries"];
  if (!Array.isArray(entriesValue)) {
    throw new FormPlanError("PLAN_INVALID", "Plan entries must be an array.");
  }
  if (entriesValue.length > MAX_PLAN_FIELD_ENTRIES + MAX_PLAN_PLACEMENTS) {
    throw new FormPlanError("PLAN_LIMIT_EXCEEDED", `Plan exceeds the entry limit.`);
  }
  const entries = entriesValue.map(parseEntry);
  const fieldCount = entries.filter((entry) => entry.kind === "field").length;
  if (fieldCount > MAX_PLAN_FIELD_ENTRIES) {
    throw new FormPlanError("PLAN_LIMIT_EXCEEDED", `A plan carries at most ${MAX_PLAN_FIELD_ENTRIES} field entries.`);
  }
  if (entries.length - fieldCount > MAX_PLAN_PLACEMENTS) {
    throw new FormPlanError("PLAN_LIMIT_EXCEEDED", `A plan carries at most ${MAX_PLAN_PLACEMENTS} placements.`);
  }
  const seenFieldIds = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== "field") continue;
    if (seenFieldIds.has(entry.fieldId)) {
      throw new FormPlanError("PLAN_INVALID", `Duplicate field entry for "${entry.fieldId}".`);
    }
    seenFieldIds.add(entry.fieldId);
  }
  const overwrite = value["overwrite"];
  const burnIn = value["burnIn"];
  if (typeof overwrite !== "boolean" || typeof burnIn !== "boolean") {
    throw new FormPlanError("PLAN_INVALID", "Plan overwrite and burnIn must be booleans.");
  }
  return Object.freeze({
    version: FORM_PLAN_VERSION,
    source: parseLocator(value["source"], "PLAN_INVALID_SOURCE", "source"),
    destination: parseLocator(value["destination"], "PLAN_INVALID_DESTINATION", "destination"),
    overwrite,
    burnIn,
    nonce: parseNonce(value["nonce"]),
    entries: Object.freeze(entries)
  });
}

/**
 * Serialise a plan to its canonical byte form: fixed key order, no
 * whitespace. The approval digest is taken over these bytes, so two parses
 * of equal plans must produce identical output (KTD7).
 */
export function serializeFormPlan(plan: FormPlan): string {
  return JSON.stringify({
    version: FORM_PLAN_VERSION,
    source: plan.source,
    destination: plan.destination,
    overwrite: plan.overwrite,
    burnIn: plan.burnIn,
    nonce: plan.nonce,
    entries: plan.entries.map((entry) => {
      switch (entry.kind) {
        case "field":
          return entry.status === "answered" || entry.status === "proposed"
            ? { kind: "field", fieldId: entry.fieldId, status: entry.status, value: entry.value }
            : { kind: "field", fieldId: entry.fieldId, status: entry.status };
        case "text":
          return { kind: "text", source: entry.source, page: entry.page, rect: entry.rect, text: entry.text };
        case "checkmark":
          return { kind: "checkmark", source: entry.source, page: entry.page, rect: entry.rect };
        case "signature":
          return { kind: "signature", source: entry.source, page: entry.page, rect: entry.rect, strokes: entry.strokes };
      }
    })
  });
}
