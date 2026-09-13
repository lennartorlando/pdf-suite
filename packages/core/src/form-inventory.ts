/**
 * Browser-safe, transport-neutral form-inventory contract.
 *
 * This module is intentionally dependency-free beyond the shared schema base:
 * no Node.js imports, no filesystem access, no child processes. It is
 * published as the `@pdf-compressor/core/form-inventory` subpath so browser
 * code never needs to import the Node-coupled core root.
 *
 * The inventory is server-authoritative (KTD6): the qpdf/PDF.js join happens
 * once in core and both surfaces consume the same object, which is what keeps
 * a plan built in the browser and a plan built by an agent identical (R32).
 * Every string read out of the document — labels, tooltips, choice options —
 * is a `DocumentText`: length-capped, stripped of control and format
 * characters, and marked `documentDerived` so consumers treat it as data and
 * never as instruction (R35). Field and widget identifiers are the object
 * references of KTD5; widget rectangles are PDF user space — points, origin
 * at the lower-left corner of the page's crop box before any page rotation
 * (KTD13).
 */

import {
  SchemaError,
  CONTROL_CHARACTER_PATTERN,
  codePointLength,
  hasControlCharacters,
  isObjectReference,
  jsonDepth,
  type PdfRect
} from "./schema-error.js";

export { SchemaError, type PdfRect };

export const FORM_INVENTORY_VERSION = 1 as const;

export const MAX_INVENTORY_JSON_DEPTH = 6;
export const MAX_INVENTORY_FIELDS = 2000;
export const MAX_DOCUMENT_TEXT_LENGTH = 200;
export const MAX_CHOICE_OPTIONS = 500;
export const MAX_CURRENT_VALUE_LENGTH = 8000;

/**
 * A string read out of a document: capped, control-character-stripped, and
 * explicitly marked `documentDerived` so every consumer treats it as
 * untrusted data rather than instruction (R35).
 */
export interface DocumentText {
  readonly text: string;
  readonly documentDerived: true;
}

/**
 * Sanitize a raw document string into a `DocumentText`: control and format
 * characters are stripped and the result is capped at
 * MAX_DOCUMENT_TEXT_LENGTH code points without splitting surrogate pairs.
 */
export function toDocumentText(raw: string): DocumentText {
  const stripped = raw.replace(CONTROL_CHARACTER_PATTERN, "");
  const capped = Array.from(stripped).slice(0, MAX_DOCUMENT_TEXT_LENGTH).join("");
  return Object.freeze({ text: capped, documentDerived: true });
}

export const FORM_FIELD_TYPES = [
  "text",
  "checkbox",
  "radio",
  "choice",
  "signature",
  "group",
  "other"
] as const;

export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

const FIELD_TYPE_SET: ReadonlySet<string> = new Set(FORM_FIELD_TYPES);

/** Where a display label was derived from; absence of a label means none could be derived (AE5). */
export const FIELD_LABEL_SOURCES = ["name", "tooltip"] as const;

export type FieldLabelSource = (typeof FIELD_LABEL_SOURCES)[number];

const LABEL_SOURCE_SET: ReadonlySet<string> = new Set(FIELD_LABEL_SOURCES);

export interface FieldLabel {
  readonly text: DocumentText;
  readonly source: FieldLabelSource;
}

export interface FieldWidget {
  readonly widgetId: string;
  /** One-based page number the widget is drawn on. */
  readonly page: number;
  readonly rect: PdfRect;
}

/**
 * One logical fillable target: the field identifier of KTD5 plus the full
 * widget set it owns. A `group` is a non-terminal parent and is never
 * directly fillable. `computed` marks a field carrying calculate or format
 * actions whose own arithmetic will not run; `password` and `hidden` mark
 * fields an agent must never propose.
 */
export interface FormFieldEntry {
  readonly fieldId: string;
  readonly type: FormFieldType;
  readonly widgets: readonly FieldWidget[];
  readonly label?: FieldLabel;
  readonly allowedValues?: readonly DocumentText[];
  readonly required: boolean;
  readonly readOnly: boolean;
  readonly computed: boolean;
  readonly password: boolean;
  readonly hidden: boolean;
  readonly multiline: boolean;
  readonly comb: boolean;
  readonly maxLength?: number;
  /** The value the document currently holds; descriptive, never a write. */
  readonly currentValue?: string;
}

export interface FormInventory {
  readonly version: typeof FORM_INVENTORY_VERSION;
  readonly fields: readonly FormFieldEntry[];
}

export const FORM_INVENTORY_ERROR_CODES = [
  "INVENTORY_INVALID",
  "INVENTORY_LIMIT_EXCEEDED",
  "INVENTORY_INVALID_FIELD_ID",
  "INVENTORY_INVALID_WIDGET_ID",
  "INVENTORY_INVALID_TYPE",
  "INVENTORY_INVALID_LABEL",
  "INVENTORY_INVALID_TEXT",
  "INVENTORY_INVALID_OPTIONS",
  "INVENTORY_INVALID_FLAGS",
  "INVENTORY_INVALID_PAGE",
  "INVENTORY_INVALID_RECT",
  "INVENTORY_INVALID_MAX_LENGTH",
  "INVENTORY_INVALID_VALUE"
] as const;

export type FormInventoryErrorCode = (typeof FORM_INVENTORY_ERROR_CODES)[number];

export class FormInventoryError extends SchemaError<FormInventoryErrorCode> {
  constructor(code: FormInventoryErrorCode, message: string) {
    super(code, message);
    this.name = "FormInventoryError";
  }
}

const INVENTORY_KEYS: readonly string[] = ["version", "fields"];
const FIELD_KEYS: readonly string[] = [
  "fieldId",
  "type",
  "widgets",
  "label",
  "allowedValues",
  "required",
  "readOnly",
  "computed",
  "password",
  "hidden",
  "multiline",
  "comb",
  "maxLength",
  "currentValue"
];
const REQUIRED_FIELD_KEYS: readonly string[] = [
  "fieldId",
  "type",
  "widgets",
  "required",
  "readOnly",
  "computed",
  "password",
  "hidden",
  "multiline",
  "comb"
];
const WIDGET_KEYS: readonly string[] = ["widgetId", "page", "rect"];
const LABEL_KEYS: readonly string[] = ["text", "source"];
const DOCUMENT_TEXT_KEYS: readonly string[] = ["text", "documentDerived"];
const RECT_KEYS: readonly string[] = ["x", "y", "width", "height"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKeys(
  candidate: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  what: string,
  code: FormInventoryErrorCode
): void {
  const keys = Object.keys(candidate);
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !keys.includes(key))) {
    throw new FormInventoryError(code, `${what} has unexpected or missing keys.`);
  }
}

function parseDocumentText(value: unknown, what: string): DocumentText {
  if (!isPlainObject(value)) {
    throw new FormInventoryError("INVENTORY_INVALID_TEXT", `${what} must be a document-text object.`);
  }
  assertKeys(value, DOCUMENT_TEXT_KEYS, DOCUMENT_TEXT_KEYS, what, "INVENTORY_INVALID_TEXT");
  const text = value["text"];
  if (typeof text !== "string") {
    throw new FormInventoryError("INVENTORY_INVALID_TEXT", `${what} text must be a string.`);
  }
  if (value["documentDerived"] !== true) {
    throw new FormInventoryError("INVENTORY_INVALID_TEXT", `${what} must be marked documentDerived.`);
  }
  if (codePointLength(text) > MAX_DOCUMENT_TEXT_LENGTH) {
    throw new FormInventoryError("INVENTORY_INVALID_TEXT", `${what} exceeds ${MAX_DOCUMENT_TEXT_LENGTH} characters.`);
  }
  if (hasControlCharacters(text)) {
    throw new FormInventoryError("INVENTORY_INVALID_TEXT", `${what} must not contain control characters.`);
  }
  return Object.freeze({ text, documentDerived: true });
}

function parseWidget(value: unknown): FieldWidget {
  if (!isPlainObject(value)) {
    throw new FormInventoryError("INVENTORY_INVALID", "Each widget must be an object.");
  }
  assertKeys(value, WIDGET_KEYS, WIDGET_KEYS, "A widget", "INVENTORY_INVALID");
  const widgetId = value["widgetId"];
  if (!isObjectReference(widgetId)) {
    throw new FormInventoryError(
      "INVENTORY_INVALID_WIDGET_ID",
      'A widget widgetId must be an object reference "N G R" (KTD5).'
    );
  }
  const page = value["page"];
  if (typeof page !== "number" || !Number.isInteger(page) || page < 1) {
    throw new FormInventoryError("INVENTORY_INVALID_PAGE", `Invalid widget page ${String(page)}: must be an integer >= 1.`);
  }
  return Object.freeze({ widgetId, page, rect: parseWidgetRect(value["rect"]) });
}

function parseWidgetRect(value: unknown): PdfRect {
  if (!isPlainObject(value)) {
    throw new FormInventoryError("INVENTORY_INVALID_RECT", "A widget rect must be an object.");
  }
  assertKeys(value, RECT_KEYS, RECT_KEYS, "A widget rect", "INVENTORY_INVALID_RECT");
  const { x, y, width, height } = value;
  if (
    typeof x !== "number" || typeof y !== "number" || typeof width !== "number" || typeof height !== "number" ||
    !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)
  ) {
    throw new FormInventoryError("INVENTORY_INVALID_RECT", "A widget rect must have finite numeric x, y, width, height.");
  }
  if (width < 0 || height < 0) {
    throw new FormInventoryError("INVENTORY_INVALID_RECT", "A widget rect must have non-negative width and height.");
  }
  return Object.freeze({ x, y, width, height });
}

function parseLabel(value: unknown): FieldLabel {
  if (!isPlainObject(value)) {
    throw new FormInventoryError("INVENTORY_INVALID_LABEL", "A field label must be an object.");
  }
  assertKeys(value, LABEL_KEYS, LABEL_KEYS, "A field label", "INVENTORY_INVALID_LABEL");
  const source = value["source"];
  if (typeof source !== "string" || !LABEL_SOURCE_SET.has(source)) {
    throw new FormInventoryError(
      "INVENTORY_INVALID_LABEL",
      `Invalid label source ${String(source)}: must be one of ${FIELD_LABEL_SOURCES.join(", ")}.`
    );
  }
  return Object.freeze({ text: parseDocumentText(value["text"], "A label"), source: source as FieldLabelSource });
}

function parseAllowedValues(value: unknown): readonly DocumentText[] {
  if (!Array.isArray(value)) {
    throw new FormInventoryError("INVENTORY_INVALID_OPTIONS", "allowedValues must be an array.");
  }
  if (value.length > MAX_CHOICE_OPTIONS) {
    throw new FormInventoryError(
      "INVENTORY_LIMIT_EXCEEDED",
      `A field carries at most ${MAX_CHOICE_OPTIONS} choice options.`
    );
  }
  return Object.freeze(value.map((option) => parseDocumentText(option, "A choice option")));
}

const FLAG_KEYS = ["required", "readOnly", "computed", "password", "hidden", "multiline", "comb"] as const;

function parseField(value: unknown): FormFieldEntry {
  if (!isPlainObject(value)) {
    throw new FormInventoryError("INVENTORY_INVALID", "Each inventory field must be an object.");
  }
  assertKeys(value, FIELD_KEYS, REQUIRED_FIELD_KEYS, "An inventory field", "INVENTORY_INVALID");
  const fieldId = value["fieldId"];
  if (!isObjectReference(fieldId)) {
    throw new FormInventoryError(
      "INVENTORY_INVALID_FIELD_ID",
      'A field fieldId must be an object reference "N G R" (KTD5).'
    );
  }
  const type = value["type"];
  if (typeof type !== "string" || !FIELD_TYPE_SET.has(type)) {
    throw new FormInventoryError(
      "INVENTORY_INVALID_TYPE",
      `Invalid field type ${String(type)}: must be one of ${FORM_FIELD_TYPES.join(", ")}.`
    );
  }
  const widgets = value["widgets"];
  if (!Array.isArray(widgets)) {
    throw new FormInventoryError("INVENTORY_INVALID", "A field's widgets must be an array.");
  }
  for (const flag of FLAG_KEYS) {
    if (typeof value[flag] !== "boolean") {
      throw new FormInventoryError("INVENTORY_INVALID_FLAGS", `Field flag ${flag} must be a boolean.`);
    }
  }
  const maxLength = value["maxLength"];
  if (maxLength !== undefined && (typeof maxLength !== "number" || !Number.isInteger(maxLength) || maxLength < 0)) {
    throw new FormInventoryError("INVENTORY_INVALID_MAX_LENGTH", "Field maxLength must be a non-negative integer.");
  }
  const currentValue = value["currentValue"];
  if (currentValue !== undefined) {
    if (typeof currentValue !== "string") {
      throw new FormInventoryError("INVENTORY_INVALID_VALUE", "Field currentValue must be a string.");
    }
    if (codePointLength(currentValue) > MAX_CURRENT_VALUE_LENGTH) {
      throw new FormInventoryError(
        "INVENTORY_INVALID_VALUE",
        `Field currentValue exceeds ${MAX_CURRENT_VALUE_LENGTH} characters.`
      );
    }
  }
  const label = value["label"];
  const allowedValues = value["allowedValues"];
  return Object.freeze({
    fieldId,
    type: type as FormFieldType,
    widgets: Object.freeze(widgets.map(parseWidget)),
    required: value["required"] as boolean,
    readOnly: value["readOnly"] as boolean,
    computed: value["computed"] as boolean,
    password: value["password"] as boolean,
    hidden: value["hidden"] as boolean,
    multiline: value["multiline"] as boolean,
    comb: value["comb"] as boolean,
    ...(label !== undefined ? { label: parseLabel(label) } : {}),
    ...(allowedValues !== undefined ? { allowedValues: parseAllowedValues(allowedValues) } : {}),
    ...(maxLength !== undefined ? { maxLength } : {}),
    ...(currentValue !== undefined ? { currentValue } : {})
  });
}

/**
 * Parse an unknown transport value into a validated immutable inventory.
 * Closed schema: unknown keys are rejected, and depth, field counts and every
 * carried string are bounded.
 */
export function parseFormInventory(value: unknown): FormInventory {
  if (jsonDepth(value) > MAX_INVENTORY_JSON_DEPTH) {
    throw new FormInventoryError(
      "INVENTORY_INVALID",
      `Inventory exceeds the maximum JSON depth of ${MAX_INVENTORY_JSON_DEPTH}.`
    );
  }
  if (!isPlainObject(value)) {
    throw new FormInventoryError("INVENTORY_INVALID", "Inventory must be an object.");
  }
  assertKeys(value, INVENTORY_KEYS, INVENTORY_KEYS, "Inventory", "INVENTORY_INVALID");
  if (value["version"] !== FORM_INVENTORY_VERSION) {
    throw new FormInventoryError("INVENTORY_INVALID", `Inventory version must be ${FORM_INVENTORY_VERSION}.`);
  }
  const fields = value["fields"];
  if (!Array.isArray(fields)) {
    throw new FormInventoryError("INVENTORY_INVALID", "Inventory fields must be an array.");
  }
  if (fields.length > MAX_INVENTORY_FIELDS) {
    throw new FormInventoryError(
      "INVENTORY_LIMIT_EXCEEDED",
      `An inventory carries at most ${MAX_INVENTORY_FIELDS} fields.`
    );
  }
  return Object.freeze({
    version: FORM_INVENTORY_VERSION,
    fields: Object.freeze(fields.map(parseField))
  });
}

/** Build an immutable inventory from field entries (validates eagerly). */
export function createFormInventory(fields: readonly FormFieldEntry[]): FormInventory {
  return parseFormInventory({ version: FORM_INVENTORY_VERSION, fields: [...fields] });
}
