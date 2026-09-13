/**
 * Core fill operation (U3): one path that inventories a form as the qpdf/
 * PDF.js join of KTD6, applies the approved plan inside the bounded
 * renderer child, removes every field action (R15), collapses revisions
 * unconditionally (KTD3), optionally burns values into page content
 * (KTD9), validates the artifact strictly (KTD4), proves the write by
 * readback (KTD14) and publishes without clobbering.
 *
 * No value from an earlier revision survives: `saveDocument` appends, so
 * the child's candidate is always rewritten by qpdf before validation.
 * Field actions are removed mid-pipeline, not skipped, because R15 forbids
 * them in the delivered file and the strict gate would otherwise refuse
 * this feature's own output.
 */
import { randomUUID } from "node:crypto";
import { copyFile, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { dirname, join } from "node:path";
import { CompressionError, isCompressionError } from "./errors.js";
import { FormPlanError, isTerminalEntryStatus, parseFormPlan, type FormPlan, type FormPlanEntryStatus, type FormPlanFieldEntry, type FormPlanPlacement, type PdfRect } from "./form-plan.js";
import {
  createFormInventory,
  toDocumentText,
  type DocumentText,
  type FieldWidget,
  type FormFieldEntry,
  type FormFieldType,
  type FormInventory
} from "./form-inventory.js";
import {
  admitFillSource,
  assertNativeFloor,
  defaultNativeRunner,
  getQpdfVersion,
  planFieldActionRemoval,
  publishNoClobber,
  readQpdfJson,
  runFillOutputStage,
  serializeFieldActionUpdate,
  validatePdfArtifact,
  writeQdfDump,
  QPDF_SECURITY_FLOOR,
  type CompatWarningKind,
  type NativeCallOptions,
  type NativeRunner,
  type QpdfAcroformField,
  type QpdfJson
} from "./engines/qpdf-pages.js";
import {
  runFillChild,
  runInspectChild,
  type InspectedFieldEntry
} from "./engines/pdfjs-fill.js";
import { createTempWorkspace } from "./temp-workspace.js";
import { withOutputLimit } from "./output-limit.js";
import { assertFreshDestination, validatePdfFillInput } from "./validation.js";

/** Initial Safety Limits: source bytes a fill may read. */
export const FILL_MAX_SOURCE_BYTES = 25 * 1024 * 1024;
/** Initial Safety Limits: produced artifact cap. */
export const FILL_MAX_OUTPUT_BYTES = 150 * 1024 * 1024;
/** Initial Safety Limits: plan file bytes. */
export const FILL_MAX_PLAN_BYTES = 512 * 1024;
/** Bound on the decompressed dump readback scans. */
const MAX_QDF_DUMP_BYTES = 512 * 1024 * 1024;
const RECT_TOLERANCE = 0.5;

/** Field flags (/Ff): PDF 32000 table 8.70, bit values. */
const FIELD_FLAG_READ_ONLY = 0x1;
const FIELD_FLAG_REQUIRED = 0x2;
const FIELD_FLAG_MULTILINE = 0x1000;
const FIELD_FLAG_PASSWORD = 0x2000;
const FIELD_FLAG_COMB = 0x1000000;

/** Annotation flags (/F) that hide a widget from an agent-facing form. */
const ANNOT_FLAG_HIDDEN = 0x2;
const ANNOT_FLAG_NO_VIEW = 0x20;

/** /AA event names whose scripts compute or reshape values (KTD6, AE7). */
const COMPUTED_ACTION_KEYS = new Set(["Calculate", "Format", "Validate", "Keystroke"]);

export interface InspectFormOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Parent for private inspection scratch files. */
  workspaceParent?: string;
  /** Injectable native runner (tests count calls or simulate failures). */
  run?: NativeRunner;
}

export interface FormInventoryResult {
  inventory: FormInventory;
  qpdfVersion: string;
  pageCount: number;
  warnings: string[];
  /** The source needed an empty-password decryption pass (KTD10). */
  removedRestrictions: boolean;
  removedUsageRights: boolean;
}

export interface FillFormOptions {
  /** Absolute path of the source PDF; never written. The plan's source binding must equal it. */
  sourcePath: string;
  /**
   * The bytes the operation actually reads, when the caller snapshotted the
   * source after approving it (KTD7). Defaults to `sourcePath`; the binding
   * check still runs against `sourcePath` and the plan.
   */
  workingSourcePath?: string;
  /** Absolute path of the plan file; its bytes are handed to the child unchanged. */
  planPath: string;
  /** Absolute path of the destination PDF; never clobbered unless the plan approved overwrite. */
  destinationPath: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Candidate/final cap; defaults to the initial safety limit. */
  maxOutputBytes?: number;
  workspaceParent?: string;
  resourceCheck?: (additionalBytes?: number) => Promise<void>;
  run?: NativeRunner;
}

export interface FillSummary {
  outputPath: string;
  outputBytes: number;
  pageCount: number;
  /** True when the plan burned values into page content. */
  burnedIn: boolean;
  fieldsWritten: number;
  placementsWritten: number;
  /** Answered fields carrying calculate/format/validate actions; the document's own arithmetic did not run. */
  computedFields: number;
  removedRestrictions: boolean;
  removedUsageRights: boolean;
  qpdfVersion: string;
  /** sha256 of the source, unchanged across every terminal state. */
  sourceHash: string;
  warnings: string[];
  compatWarnings: CompatWarningKind[];
}

export interface BurnInFormOptions {
  /** Absolute path of the already-filled interactive PDF; never written. */
  sourcePath: string;
  /** Absolute path of the flattened destination; never clobbered unless overwrite. */
  destinationPath: string;
  /** An existing destination refuses the write unless explicitly allowed. */
  overwrite?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Flattened candidate cap; defaults to the initial safety limit. */
  maxOutputBytes?: number;
  workspaceParent?: string;
  resourceCheck?: (additionalBytes?: number) => Promise<void>;
  run?: NativeRunner;
}

export interface BurnInSummary {
  outputPath: string;
  outputBytes: number;
  pageCount: number;
  /** Logical fields flattened into page content. */
  fieldsBurnedIn: number;
  removedRestrictions: boolean;
  removedUsageRights: boolean;
  qpdfVersion: string;
  /** sha256 of the source, unchanged across the operation. */
  sourceHash: string;
  warnings: string[];
  compatWarnings: CompatWarningKind[];
}

/** One widget joined across both tools. */
interface JoinedWidget {
  widgetId: string;
  page: number;
  rect: PdfRect;
  /** Appearance-state names from the widget's /AP /N dictionary, "/" stripped. */
  onStates: string[];
  /** pdf.js export value for button widgets. */
  exportValues?: string;
}

/** One logical field joined across both tools. */
interface JoinedField {
  entry: FormFieldEntry;
  widgets: JoinedWidget[];
  computed: boolean;
  /** Accepted choice values: export and display spellings. */
  choiceValues: string[];
}

interface JoinedForm {
  fields: JoinedField[];
  inventory: FormInventory;
  byId: Map<string, JoinedField>;
  /** Widget identifier -> owning field. */
  widgetOwner: Map<string, JoinedField>;
}

interface QpdfFieldRow {
  row: QpdfAcroformField;
  fieldRef: string;
  widgetRef: string;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new CompressionError("JOB_CANCELLED", "Fill operation was cancelled.");
  }
}

/** PDF.js annotation ids ("NR", "NRg") to canonical references ("N G R"). */
function pdfJsRef(id: string): string {
  const match = /^(\d+)R(\d*)$/.exec(id);
  return match ? `${match[1]} ${match[2] || "0"} R` : id;
}

function isRef(value: unknown): value is string {
  return typeof value === "string" && /^\d+ \d+ R$/.test(value);
}

/** The field dictionary a qpdf widget row belongs to (merged dicts name themselves). */
function rowFieldRef(row: QpdfAcroformField): string | undefined {
  if (isRef(row.parent)) return row.parent;
  const widget = row.annotation?.object ?? row.object;
  return isRef(widget) ? widget : undefined;
}

function rowWidgetRef(row: QpdfAcroformField): string | undefined {
  const widget = row.annotation?.object ?? row.object;
  return isRef(widget) ? widget : undefined;
}

function objectDict(raw: QpdfJson, ref: string): Record<string, unknown> | undefined {
  const entry = raw.qpdf?.[1]?.[`obj:${ref}`];
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
  const value = (entry as Record<string, unknown>)["value"];
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  const stream = (entry as Record<string, unknown>)["stream"];
  if (typeof stream === "object" && stream !== null) {
    const dict = (stream as Record<string, unknown>)["dict"];
    if (typeof dict === "object" && dict !== null) return dict as Record<string, unknown>;
  }
  return undefined;
}

/** Appearance-state names a widget dictionary defines ("/Ja" -> "Ja"). */
function appearanceStates(dict: Record<string, unknown> | undefined): string[] {
  const ap = dict?.["/AP"];
  if (typeof ap !== "object" || ap === null) return [];
  const normal = (ap as Record<string, unknown>)["/N"];
  if (typeof normal !== "object" || normal === null) return [];
  return Object.keys(normal as Record<string, unknown>)
    .filter((key) => key.startsWith("/"))
    .map((key) => key.slice(1));
}

function decodeQpdfText(value: unknown): string {
  if (typeof value !== "string") return "";
  if (value.startsWith("u:")) return value.slice(2);
  if (value.startsWith("b:")) {
    const bytes = Buffer.from(value.slice(2), "hex");
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      const swapped = Buffer.alloc(bytes.length - 2);
      for (let index = 2; index + 1 < bytes.length; index += 2) {
        swapped[index - 2] = bytes[index + 1];
        swapped[index - 1] = bytes[index];
      }
      return swapped.toString("utf16le");
    }
    return bytes.toString("latin1");
  }
  if (value.startsWith("/")) return value.slice(1);
  return value;
}

/** Normalize an appearance state to its bare name; an absent /AS reads as Off. */
function appearanceName(state: unknown): string {
  if (typeof state !== "string" || state === "") return "Off";
  return state.startsWith("/") ? state.slice(1) : state;
}

function fieldTypeOf(
  row: QpdfFieldRow | undefined,
  widgetEntries: InspectedFieldEntry[],
  fieldEntry: InspectedFieldEntry | undefined
): FormFieldType {
  const flags = row?.row.fieldflags ?? 0;
  const type = row?.row.fieldtype ?? "";
  if (type === "/Tx" || widgetEntries.some((entry) => entry.type === "text")) return "text";
  if (type === "/Ch" || widgetEntries.some((entry) => entry.type === "combobox" || entry.type === "listbox")) {
    return "choice";
  }
  if (type === "/Btn" || widgetEntries.some((entry) => entry.type === "checkbox" || entry.type === "radiobutton")) {
    if (row?.row.ischeckbox === true || widgetEntries.some((entry) => entry.type === "checkbox")) return "checkbox";
    if (row?.row.isradiobutton === true || widgetEntries.some((entry) => entry.type === "radiobutton")) return "radio";
    return "other";
  }
  if (type === "/Sig") return "signature";
  if (fieldEntry?.kidIds && fieldEntry.kidIds.length > 0 && !fieldEntry.type) return "group";
  return "other";
}

/**
 * Join qpdf's field semantics with the child's PDF.js addressing into the
 * inventory (KTD6). qpdf supplies one row per widget — names, types, flags,
 * options, page positions and current values; the child supplies annotation
 * identifiers, rectangles, on-state names and action sets. On disagreement
 * qpdf wins.
 */
function joinFormFields(raw: QpdfJson, pdfEntries: InspectedFieldEntry[]): JoinedForm {
  const objects = raw.qpdf?.[1] ?? {};
  const pdfById = new Map<string, InspectedFieldEntry>();
  for (const entry of pdfEntries) {
    if (typeof entry.id === "string") pdfById.set(pdfJsRef(entry.id), entry);
  }

  const rowsByField = new Map<string, QpdfFieldRow[]>();
  for (const row of raw.acroform?.fields ?? []) {
    const fieldRef = rowFieldRef(row);
    const widgetRef = rowWidgetRef(row);
    if (!fieldRef || !widgetRef) continue;
    const list = rowsByField.get(fieldRef) ?? [];
    list.push({ row, fieldRef, widgetRef });
    rowsByField.set(fieldRef, list);
  }

  const fields: JoinedField[] = [];
  const widgetOwner = new Map<string, JoinedField>();
  for (const [fieldRef, rows] of rowsByField) {
    const fieldEntry = pdfById.get(fieldRef);
    const widgetRefs =
      fieldEntry?.kidIds && fieldEntry.kidIds.length > 0
        ? fieldEntry.kidIds.map(pdfJsRef)
        : rows.map((row) => row.widgetRef);
    const widgetEntries = widgetRefs
      .map((ref) => pdfById.get(ref))
      .filter((entry): entry is InspectedFieldEntry => entry !== undefined);

    const rowByWidget = new Map(rows.map((row) => [row.widgetRef, row.row]));
    const widgets: JoinedWidget[] = widgetRefs.map((ref) => {
      const row = rowByWidget.get(ref);
      const pdf = pdfById.get(ref);
      const rect = pdf?.rect;
      return {
        widgetId: ref,
        page:
          typeof row?.pageposfrom1 === "number" && row.pageposfrom1 >= 1
            ? row.pageposfrom1
            : typeof pdf?.page === "number"
              ? pdf.page + 1
              : 1,
        rect:
          Array.isArray(rect) && rect.length === 4
            ? { x: rect[0], y: rect[1], width: rect[2] - rect[0], height: rect[3] - rect[1] }
            : { x: 0, y: 0, width: 0, height: 0 },
        onStates: appearanceStates(objectDict(raw, ref)),
        ...(typeof pdf?.exportValues === "string" ? { exportValues: pdf.exportValues } : {})
      };
    });

    const first = rows[0]?.row;
    const flags = typeof first?.fieldflags === "number" ? first.fieldflags : 0;
    const actionKeys = new Set<string>();
    for (const entry of [fieldEntry, ...widgetEntries]) {
      for (const key of entry?.actionKeys ?? []) actionKeys.add(key);
    }
    const computed = [...actionKeys].some((key) => COMPUTED_ACTION_KEYS.has(key));
    const type = fieldTypeOf(rows[0], widgetEntries, fieldEntry);
    const hidden = widgetEntries.some((entry) => entry.hidden === true) ||
      rows.some(({ row }) => typeof row.annotation?.annotationflags === "number" &&
        (row.annotation.annotationflags & (ANNOT_FLAG_HIDDEN | ANNOT_FLAG_NO_VIEW)) !== 0);

    let allowedValues: DocumentText[] | undefined;
    let choiceValues: string[] = [];
    if (type === "choice") {
      const items = widgetEntries[0]?.items;
      const exportValues = (items ?? [])
        .map((item) => item.exportValue ?? item.displayValue)
        .filter((value): value is string => typeof value === "string");
      const displayValues = (items ?? [])
        .map((item) => item.displayValue ?? item.exportValue)
        .filter((value): value is string => typeof value === "string");
      const qpdfChoices = first?.choices ?? [];
      choiceValues = [...new Set([...exportValues, ...displayValues, ...qpdfChoices])];
      const shown = displayValues.length > 0 ? displayValues : qpdfChoices;
      if (shown.length > 0) allowedValues = shown.map(toDocumentText);
    } else if (type === "checkbox" || type === "radio") {
      const states = new Set<string>();
      for (const widget of widgets) {
        for (const state of widget.onStates) {
          if (type === "radio" && state === "Off") continue;
          states.add(state);
        }
        if (widget.exportValues !== undefined && type === "radio") states.add(widget.exportValues);
      }
      if (states.size > 0) allowedValues = [...states].map(toDocumentText);
    }

    const maxLength = typeof widgetEntries[0]?.charLimit === "number" && widgetEntries[0].charLimit > 0
      ? widgetEntries[0].charLimit
      : undefined;
    const currentValue = decodeQpdfText(first?.value);

    // qpdf's "alternativename" echoes the field name, so the tooltip comes
    // straight from the field dictionary's /TU.
    const fieldDict = objectDict(raw, fieldRef);
    const tooltipRaw = decodeQpdfText(fieldDict?.["/TU"]);
    const tooltip = tooltipRaw !== "" ? tooltipRaw : undefined;
    const name = typeof first?.fullname === "string" && first.fullname !== "" ? first.fullname : undefined;
    const label = tooltip
      ? { text: toDocumentText(tooltip), source: "tooltip" as const }
      : name
        ? { text: toDocumentText(name), source: "name" as const }
        : undefined;

    const entry: FormFieldEntry = {
      fieldId: fieldRef,
      type,
      widgets: widgets.map<FieldWidget>((widget) => ({
        widgetId: widget.widgetId,
        page: widget.page,
        rect: widget.rect
      })),
      required: (flags & FIELD_FLAG_REQUIRED) !== 0 || widgetEntries.some((e) => e.required === true),
      readOnly: (flags & FIELD_FLAG_READ_ONLY) !== 0 || widgetEntries.some((e) => e.readOnly === true),
      computed,
      password: (flags & FIELD_FLAG_PASSWORD) !== 0 || widgetEntries.some((e) => e.password === true),
      hidden,
      multiline: (flags & FIELD_FLAG_MULTILINE) !== 0 || widgetEntries.some((e) => e.multiline === true),
      comb: (flags & FIELD_FLAG_COMB) !== 0 || widgetEntries.some((e) => e.comb === true),
      ...(label ? { label } : {}),
      ...(allowedValues ? { allowedValues } : {}),
      ...(maxLength !== undefined ? { maxLength } : {}),
      ...(currentValue !== "" ? { currentValue } : {})
    };
    const joined: JoinedField = { entry, widgets, computed, choiceValues };
    fields.push(joined);
    for (const widget of widgets) widgetOwner.set(widget.widgetId, joined);
  }

  // Non-terminal parents are groups: never directly fillable (KTD5).
  for (const entry of pdfEntries) {
    if (!entry.kidIds || entry.kidIds.length === 0 || typeof entry.id !== "string") continue;
    const ref = pdfJsRef(entry.id);
    if (rowsByField.has(ref)) continue;
    fields.push({
      entry: {
        fieldId: ref,
        type: "group",
        widgets: [],
        required: false,
        readOnly: false,
        computed: (entry.actionKeys ?? []).some((key) => COMPUTED_ACTION_KEYS.has(key)),
        password: false,
        hidden: false,
        multiline: false,
        comb: false
      },
      widgets: [],
      computed: false,
      choiceValues: []
    });
  }

  const inventory = createFormInventory(fields.map((field) => field.entry));
  return { fields, inventory, byId: new Map(fields.map((f) => [f.entry.fieldId, f])), widgetOwner };
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function readPlanFile(planPath: string): Promise<FormPlan> {
  let info;
  try {
    info = await stat(planPath);
  } catch {
    throw new CompressionError("INPUT_NOT_FOUND", "Plan file was not found.", { inputPath: planPath });
  }
  if (info.size > FILL_MAX_PLAN_BYTES) {
    throw new FormPlanError(
      "PLAN_LIMIT_EXCEEDED",
      `Plan file exceeds the ${FILL_MAX_PLAN_BYTES} byte bound.`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(planPath, "utf8"));
  } catch {
    throw new FormPlanError("PLAN_INVALID", "Plan file is not valid JSON.");
  }
  return parseFormPlan(parsed);
}

/**
 * Contextual plan validation (AE12): every entry resolved against the joined
 * inventory. When `outstanding` is given (the `validate` pass), non-terminal
 * field entries are collected for the interview loop instead of refusing the
 * plan outright (KTD8); without it the check is apply-strict.
 */
function validatePlanEntries(
  plan: FormPlan,
  joined: JoinedForm,
  outstanding?: { fieldId: string; status: FormPlanEntryStatus }[]
): Map<string, JoinedField> {
  const answered = new Map<string, JoinedField>();
  for (const entry of plan.entries) {
    if (entry.kind !== "field") {
      if (entry.source !== plan.source) {
        throw new CompressionError(
          "FILL_PLAN_SOURCE_MISMATCH",
          "A placement's source binding does not match the plan's source.",
          { page: entry.page }
        );
      }
      continue;
    }
    const field = joined.byId.get(entry.fieldId) ?? joined.widgetOwner.get(entry.fieldId);
    if (!field) {
      throw new CompressionError("FILL_UNKNOWN_FIELD", `Plan names a field the document does not contain.`, {
        fieldId: entry.fieldId
      });
    }
    if (!isTerminalEntryStatus(entry.status)) {
      if (outstanding) {
        outstanding.push({ fieldId: entry.fieldId, status: entry.status });
        continue;
      }
      throw new CompressionError(
        "FILL_PLAN_INCOMPLETE",
        `Plan entry for field "${entry.fieldId}" is ${entry.status}; apply requires answered or skipped.`,
        { fieldId: entry.fieldId, status: entry.status }
      );
    }
    if (entry.status !== "answered") continue;
    if (field.entry.readOnly || field.entry.type === "group" || field.entry.type === "signature" || field.entry.type === "other") {
      throw new CompressionError(
        "FILL_NOT_FILLABLE",
        `Field "${entry.fieldId}" is ${field.entry.readOnly ? "read-only" : `type ${field.entry.type}`} and cannot be filled.`,
        { fieldId: entry.fieldId, type: field.entry.type, readOnly: field.entry.readOnly }
      );
    }
    if (field.entry.maxLength !== undefined && entry.value.length > field.entry.maxLength) {
      throw new CompressionError(
        "FILL_VALUE_INVALID",
        `Value for field "${entry.fieldId}" exceeds the field's ${field.entry.maxLength} character limit.`,
        { fieldId: entry.fieldId, maxLength: field.entry.maxLength }
      );
    }
    if (field.entry.type === "choice" && field.choiceValues.length > 0 && !field.choiceValues.includes(entry.value)) {
      throw new CompressionError(
        "FILL_VALUE_INVALID",
        `Value for field "${entry.fieldId}" is not one of the field's options.`,
        { fieldId: entry.fieldId }
      );
    }
    if (field.entry.type === "checkbox" || field.entry.type === "radio") {
      const onStates = new Set(field.widgets.flatMap((widget) => widget.onStates));
      for (const widget of field.widgets) {
        if (widget.exportValues !== undefined) onStates.add(widget.exportValues);
      }
      const normalized = entry.value === "" ? "Off" : entry.value;
      if (field.entry.type === "radio" && normalized === "Off") {
        throw new CompressionError(
          "FILL_VALUE_INVALID",
          `Field "${entry.fieldId}" is a radio group and cannot be cleared.`,
          { fieldId: entry.fieldId }
        );
      }
      if (!onStates.has(normalized)) {
        throw new CompressionError(
          "FILL_VALUE_INVALID",
          `Value for field "${entry.fieldId}" is not an appearance state the widget defines.`,
          { fieldId: entry.fieldId }
        );
      }
    }
    answered.set(entry.fieldId, field);
  }
  return answered;
}

interface FieldRowFor {
  row: QpdfAcroformField;
  widgetRef: string | undefined;
}

function rowsForField(raw: QpdfJson, field: JoinedField): FieldRowFor[] {
  const out: FieldRowFor[] = [];
  for (const row of raw.acroform?.fields ?? []) {
    if (rowFieldRef(row) === field.entry.fieldId || rowWidgetRef(row) === field.entry.fieldId) {
      out.push({ row, widgetRef: rowWidgetRef(row) });
    }
  }
  return out;
}

function readbackFail(fieldId: string, what: string): CompressionError {
  // Never put approved or document-derived values into error details (KTD14, R27).
  return new CompressionError("FILL_READBACK_FAILED", `Readback could not confirm the approved ${what} on field "${fieldId}".`, {
    fieldId,
    what
  });
}

/**
 * The appearance-state name a widget should show for an approved value:
 * the value itself when it names a state, else the widget's non-Off state
 * when the value matched its export value, else Off. The approved value
 * may spell the export value where it differs from the state name.
 */
function expectedWidgetState(widget: JoinedWidget, want: string): string {
  if (widget.onStates.includes(want)) return want;
  if (widget.exportValues !== undefined && widget.exportValues === want) {
    return widget.onStates.find((state) => state !== "Off") ?? "Off";
  }
  return "Off";
}

interface FieldReadback {
  applied: boolean;
  /** Which aspect could not be confirmed, for the failure message. */
  detail?: string;
  /** The observed value or appearance state; surfaced only to callers that digest or reveal it (R13). */
  actual?: string;
}

/**
 * Per-field readback on an interactive artifact (KTD14): every widget row
 * must report the expected value, and button fields must additionally report
 * the expected appearance state. Returns a verdict; `readbackFieldValues`
 * turns a negative verdict into the fill's fail-fast error.
 */
function checkFieldReadback(raw: QpdfJson, field: JoinedField, expected: string): FieldReadback {
  const rows = rowsForField(raw, field);
  // No row for the field: the artifact holds nothing, reported as empty.
  if (rows.length === 0) return { applied: false, detail: "value", actual: "" };
  if (field.entry.type === "checkbox" || field.entry.type === "radio") {
    const want = expected === "" ? "Off" : expected;
    for (const { row, widgetRef } of rows) {
      const widget = field.widgets.find((candidate) => candidate.widgetId === widgetRef);
      const wantState = widget ? expectedWidgetState(widget, want) : "Off";
      const got = appearanceName(row.annotation?.appearancestate);
      if (got !== wantState) return { applied: false, detail: "appearance state", actual: got };
    }
    const selected = field.widgets.find((widget) => expectedWidgetState(widget, want) === want && want !== "Off");
    const wantValue = selected ? expectedWidgetState(selected, want) : want === "Off" ? "Off" : want;
    for (const { row } of rows) {
      const got = decodeQpdfText(row.value);
      if (got !== want && got !== wantValue) return { applied: false, detail: "value", actual: got };
    }
    return { applied: true };
  }
  for (const { row } of rows) {
    const got = decodeQpdfText(row.value);
    if (got !== expected) return { applied: false, detail: "value", actual: got };
  }
  return { applied: true };
}

/** Prove answered field values on an interactive artifact (KTD14). */
function readbackFieldValues(raw: QpdfJson, answered: Map<string, JoinedField>, values: Map<string, string>): void {
  for (const [fieldId, field] of answered) {
    const check = checkFieldReadback(raw, field, values.get(fieldId) ?? "");
    if (!check.applied) throw readbackFail(fieldId, check.detail ?? "value");
  }
}

function rectMatches(rect: unknown, want: { x: number; y: number; width: number; height: number }): boolean {
  if (!Array.isArray(rect) || rect.length !== 4) return false;
  const got = [rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1]];
  const expected = [want.x, want.y, want.x + want.width, want.y + want.height];
  return (
    Math.abs(rect[0] - expected[0]) <= RECT_TOLERANCE &&
    Math.abs(rect[1] - expected[1]) <= RECT_TOLERANCE &&
    Math.abs(rect[2] - expected[2]) <= RECT_TOLERANCE &&
    Math.abs(rect[3] - expected[3]) <= RECT_TOLERANCE &&
    got.every((value) => typeof value === "number" && Number.isFinite(value))
  );
}

function pageAnnotationDicts(raw: QpdfJson, pageIndex: number): Record<string, unknown>[] {
  const pages = raw.pages ?? [];
  const pageRef = pages[pageIndex - 1]?.object;
  if (!isRef(pageRef)) return [];
  const pageDict = objectDict(raw, pageRef);
  const annots = pageDict?.["/Annots"];
  const refs: unknown[] = [];
  if (typeof annots === "string" && isRef(annots)) {
    const arr = objectDict(raw, annots) ?? raw.qpdf?.[1]?.[`obj:${annots}`];
    const value = (arr as Record<string, unknown> | undefined)?.["value"];
    if (Array.isArray(value)) refs.push(...value);
  } else if (Array.isArray(annots)) {
    refs.push(...annots);
  }
  const dicts: Record<string, unknown>[] = [];
  for (const ref of refs) {
    if (typeof ref === "string" && isRef(ref)) {
      const dict = objectDict(raw, ref);
      if (dict) dicts.push(dict);
    } else if (typeof ref === "object" && ref !== null) {
      dicts.push(ref as Record<string, unknown>);
    }
  }
  return dicts;
}

/** One placement verdict on an interactive artifact: a page annotation carries the approved rect and text. */
function checkPlacementReadback(raw: QpdfJson, entry: FormPlanPlacement): boolean {
  const wantRect = entry.rect;
  const annotations = pageAnnotationDicts(raw, entry.page);
  return annotations.some((dict) => {
    if (!rectMatches(dict["/Rect"], wantRect)) return false;
    if (entry.kind === "text") {
      return dict["/Subtype"] === "/FreeText" && decodeQpdfText(dict["/Contents"]) === entry.text;
    }
    if (entry.kind === "checkmark") {
      return dict["/Subtype"] === "/Ink" && Array.isArray(dict["/InkList"]);
    }
    return dict["/Subtype"] === "/Stamp";
  });
}

/** Prove placements on an interactive artifact: page annotations carry the approved rect and text. */
function readbackPlacements(raw: QpdfJson, plan: FormPlan): void {
  for (const entry of plan.entries) {
    if (entry.kind === "field") continue;
    if (!checkPlacementReadback(raw, entry)) {
      throw new CompressionError(
        "FILL_READBACK_FAILED",
        `Readback could not confirm the approved ${entry.kind} placement on page ${entry.page}.`,
        { page: entry.page, kind: entry.kind }
      );
    }
  }
}

/** One object in a --qdf dump: dictionary text plus stream body when present. */
interface QdfObject {
  dict: string;
  stream: string;
}

/**
 * Index a --qdf dump by object reference. qdf renumbers objects, so nothing
 * outside the dump may address them — page and XObject structure is resolved
 * inside this text. A stream body that mimics object syntax can only make an
 * entry end early, which fails the readback closed rather than passing it.
 */
function qdfObjects(dump: string): Map<string, QdfObject> {
  const objects = new Map<string, QdfObject>();
  const objectStart = /^(\d+) (\d+) obj\n/gm;
  const marks = [...dump.matchAll(objectStart)];
  for (let index = 0; index < marks.length; index += 1) {
    const mark = marks[index];
    const ref = `${mark[1]} ${mark[2]} R`;
    const bodyStart = mark.index + mark[0].length;
    const nextStart = marks[index + 1]?.index ?? dump.length;
    let end = dump.indexOf("\nendobj", bodyStart);
    if (end === -1 || end > nextStart) end = nextStart;
    const body = dump.slice(bodyStart, end);
    const streamAt = body.indexOf("stream\n");
    if (streamAt === -1) {
      objects.set(ref, { dict: body, stream: "" });
      continue;
    }
    const streamEnd = body.indexOf("\nendstream", streamAt);
    objects.set(ref, {
      dict: body.slice(0, streamAt),
      stream: streamEnd === -1 ? "" : body.slice(streamAt + "stream\n".length, streamEnd)
    });
  }
  return objects;
}

/** Object references inside a bracketed qdf array body. */
function qdfRefs(arrayText: string): string[] {
  return [...arrayText.matchAll(/(\d+ \d+ R)/g)].map((match) => match[1]);
}

/** All /Kids references a pages-node dictionary lists, inline or indirect. */
function qdfKids(dict: string, objects: Map<string, QdfObject>): string[] {
  const match = /\/Kids\s*(\[[^\]]*\]|\d+ \d+ R)/.exec(dict);
  if (!match) return [];
  const value = match[1];
  if (value.startsWith("[")) return qdfRefs(value);
  return qdfRefs(objects.get(value)?.dict ?? "");
}

/** Page object references in document order, from the dump's page tree. */
function qdfPageRefs(objects: Map<string, QdfObject>): string[] {
  const pages: string[] = [];
  const visit = (ref: string): void => {
    const dict = objects.get(ref)?.dict ?? "";
    if (/\/Type\s*\/Pages\b/.test(dict)) {
      for (const kid of qdfKids(dict, objects)) visit(kid);
      return;
    }
    if (/\/Type\s*\/Page\b/.test(dict)) pages.push(ref);
  };
  for (const [ref, object] of objects) {
    if (/\/Type\s*\/Pages\b/.test(object.dict) && qdfKids(object.dict, objects).length > 0) {
      visit(ref);
      break;
    }
  }
  return pages;
}

/** The /XObject name->reference map a page's resources declare. */
function qdfPageXObjects(pageDict: string, objects: Map<string, QdfObject>): Map<string, string> {
  const map = new Map<string, string>();
  const resourcesMatch = /\/Resources\s*(<<[^>]*(?:>[^>]*>[^>]*)*>>|\d+ \d+ R)/.exec(pageDict);
  let resources = resourcesMatch?.[1] ?? "";
  if (/^\d+ \d+ R$/.test(resources)) resources = objects.get(resources)?.dict ?? "";
  const xobjMatch = /\/XObject\s*(<<[^>]*(?:>[^>]*>[^>]*)*>>|\d+ \d+ R)/.exec(resources);
  let xobjects = xobjMatch?.[1] ?? "";
  if (/^\d+ \d+ R$/.test(xobjects)) xobjects = objects.get(xobjects)?.dict ?? "";
  for (const match of xobjects.matchAll(/(\/\S+)\s+(\d+ \d+ R)/g)) {
    map.set(match[1], match[2]);
  }
  return map;
}

/** Encode a value the way the renderer's appearance streams encode it (latin1, unrepresentable -> "?"), escaped as a PDF literal. */
function contentMarker(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const byte = code <= 0xff ? String.fromCharCode(code) : "?";
    out += byte.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  }
  return `(${out})`;
}

/**
 * Stream text one page draws: its content objects plus the form XObjects
 * flattening placed on it, all resolved inside the qdf dump. Burned-in
 * values are proved against this text (KTD14).
 */
function pageContentText(
  objects: Map<string, QdfObject>,
  pages: string[],
  pageIndex: number
): { text: string; xobjects: Map<string, string> } {
  const pageRef = pages[pageIndex - 1];
  const pageDict = pageRef === undefined ? "" : (objects.get(pageRef)?.dict ?? "");
  const contentsMatch = /\/Contents\s*(\[[^\]]*\]|\d+ \d+ R)/.exec(pageDict);
  const contentRefs = contentsMatch ? qdfRefs(contentsMatch[1]) : [];
  const xobjects = qdfPageXObjects(pageDict, objects);
  const texts: string[] = [];
  for (const ref of [...contentRefs, ...xobjects.values()]) {
    texts.push(objects.get(ref)?.stream ?? "");
  }
  return { text: texts.join("\n"), xobjects };
}

/**
 * Drawn-object check for burned-in signatures, checkmarks and button
 * states: a positioned XObject drawn at the approved rect whose body is
 * more than save/restore noise — path, fill, text or marked-content ops.
 * A generated Off appearance is `q Q` and fails this on purpose.
 */
function placedInkPresent(
  objects: Map<string, QdfObject>,
  pages: string[],
  pageIndex: number,
  rect: PdfRect
): boolean {
  const { text, xobjects } = pageContentText(objects, pages, pageIndex);
  const ink = (ref: string): boolean => {
    const body = objects.get(ref)?.stream ?? "";
    return /\b(Tj|TJ|BMC|re|Do)\b|[-\d.]+\s+[-\d.]+\s+(m|c|v|y)\b|\b[SsFf]\b/.test(body);
  };
  // Placements draw at identity with the approved rect in the XObject /BBox;
  // flattened field widgets are positioned by the cm matrix instead.
  const doPattern =
    /-?[\d.]+\s+-?[\d.]+\s+-?[\d.]+\s+-?[\d.]+\s+(-?[\d.]+)\s+(-?[\d.]+)\s+cm\s*\n?\s*\/(\S+)\s+Do/g;
  for (const match of text.matchAll(doPattern)) {
    const ref = xobjects.get(`/${match[3]}`) ?? xobjects.get(match[3]);
    if (ref === undefined) continue;
    const tx = Number(match[1]);
    const ty = Number(match[2]);
    if (Math.abs(tx - rect.x) <= 2 && Math.abs(ty - rect.y) <= 2 && ink(ref)) return true;
    if (Math.abs(tx) <= 2 && Math.abs(ty) <= 2) {
      const bbox = /\/BBox\s*\[([^\]]*)\]/.exec(objects.get(ref)?.dict ?? "");
      const corners = bbox?.[1].trim().split(/\s+/).map(Number) ?? [];
      if (
        corners.length === 4 &&
        Math.abs(corners[0] - rect.x) <= 2 &&
        Math.abs(corners[1] - rect.y) <= 2 &&
        Math.abs(corners[2] - (rect.x + rect.width)) <= 2 &&
        Math.abs(corners[3] - (rect.y + rect.height)) <= 2 &&
        ink(ref)
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Field appearance drawn at the widget's own rect, for burned-in button fields. */
function widgetInkPresent(objects: Map<string, QdfObject>, pages: string[], widget: JoinedWidget): boolean {
  return placedInkPresent(objects, pages, widget.page, widget.rect);
}

/** Per-field verdict on burned-in page content: the expected value is drawn and visible. */
function checkBurnedFieldReadback(
  objects: Map<string, QdfObject>,
  pages: string[],
  field: JoinedField,
  expected: string
): FieldReadback {
  if (field.entry.type === "text" || field.entry.type === "choice") {
    if (expected === "") return { applied: true };
    const marker = contentMarker(expected);
    for (const widget of field.widgets) {
      if (!pageContentText(objects, pages, widget.page).text.includes(marker)) {
        return { applied: false, detail: "content" };
      }
    }
    return { applied: true };
  }
  const want = expected === "" ? "Off" : expected;
  for (const widget of field.widgets) {
    const active =
      field.entry.type === "radio"
        ? widget.onStates.includes(want) || widget.exportValues === want
        : want !== "Off";
    if (active && !widgetInkPresent(objects, pages, widget)) {
      return { applied: false, detail: "appearance" };
    }
  }
  return { applied: true };
}

/** Per-placement verdict on burned-in page content. */
function checkBurnedPlacementReadback(
  objects: Map<string, QdfObject>,
  pages: string[],
  entry: FormPlanPlacement
): boolean {
  if (entry.kind === "text") {
    return pageContentText(objects, pages, entry.page).text.includes(contentMarker(entry.text));
  }
  return placedInkPresent(objects, pages, entry.page, entry.rect);
}

/** Prove every answered entry and placement is visible in burned-in page content (KTD9, KTD14). */
function readbackBurnedContent(
  objects: Map<string, QdfObject>,
  pages: string[],
  plan: FormPlan,
  answered: Map<string, JoinedField>,
  values: Map<string, string>
): void {
  for (const [fieldId, field] of answered) {
    const check = checkBurnedFieldReadback(objects, pages, field, values.get(fieldId) ?? "");
    if (!check.applied) throw readbackFail(fieldId, check.detail ?? "content");
  }
  for (const entry of plan.entries) {
    if (entry.kind === "field") continue;
    if (!checkBurnedPlacementReadback(objects, pages, entry)) {
      throw new CompressionError(
        "FILL_READBACK_FAILED",
        `Readback could not confirm the burned-in ${entry.kind} placement on page ${entry.page}.`,
        { page: entry.page, kind: entry.kind }
      );
    }
  }
}

/**
 * Blank-delivery guard before flattening (KTD9, AE11): every widget that
 * must show something — a non-empty text or choice value, a selected
 * button state — needs an appearance stream on its own dictionary or the
 * field dictionary it shares. A widget expected to show Off needs none.
 */
function assertAppearancesPresent(raw: QpdfJson, answered: Map<string, JoinedField>, values: Map<string, string>): void {
  for (const [fieldId, field] of answered) {
    const expected = values.get(fieldId) ?? "";
    const want = expected === "" ? "Off" : expected;
    for (const widget of field.widgets) {
      const needed =
        field.entry.type === "text" || field.entry.type === "choice"
          ? expected !== ""
          : expectedWidgetState(widget, want) !== "Off";
      if (!needed) continue;
      const widgetDict = objectDict(raw, widget.widgetId);
      const fieldDict = objectDict(raw, field.entry.fieldId);
      if (!widgetDict?.["/AP"] && !fieldDict?.["/AP"]) {
        throw new CompressionError(
          "FILL_APPEARANCE_MISSING",
          `No appearance was generated for field "${fieldId}"; burning in would deliver a blank.`,
          { fieldId }
        );
      }
    }
  }
}

/**
 * Standalone blank-delivery guard (KTD9, AE11): no plan exists, so "must
 * show something" is derived from the document itself — a button widget
 * selected to a non-Off state, or any other field holding a value. Each
 * such widget needs an appearance stream on its own dictionary or the field
 * dictionary it shares after --generate-appearances; a hidden widget shows
 * nothing either way and needs none.
 */
function assertGeneratedAppearances(raw: QpdfJson): void {
  for (const row of raw.acroform?.fields ?? []) {
    const flags = row.annotation?.annotationflags ?? 0;
    if ((flags & (ANNOT_FLAG_HIDDEN | ANNOT_FLAG_NO_VIEW)) !== 0) continue;
    const widgetRef = rowWidgetRef(row);
    if (widgetRef === undefined) continue;
    const needed =
      row.fieldtype === "/Btn"
        ? appearanceName(row.annotation?.appearancestate) !== "Off"
        : decodeQpdfText(row.value) !== "";
    if (!needed) continue;
    const fieldRef = rowFieldRef(row);
    const widgetDict = objectDict(raw, widgetRef);
    const fieldDict = fieldRef === undefined ? undefined : objectDict(raw, fieldRef);
    if (!widgetDict?.["/AP"] && !fieldDict?.["/AP"]) {
      throw new CompressionError(
        "FILL_APPEARANCE_MISSING",
        "No appearance could be generated for a field holding a value; burning in would deliver a blank.",
        { fieldId: fieldRef ?? widgetRef }
      );
    }
  }
}

function outputTooLarge(path: string, maxOutputBytes: number): CompressionError {
  return new CompressionError(
    "OUTPUT_TOO_LARGE",
    `Fill output exceeded the ${maxOutputBytes} byte cap.`,
    { outputPath: path, maxOutputBytes }
  );
}

async function joinDocumentFields(
  workingPath: string,
  workspacePath: string,
  calls: NativeCallOptions
): Promise<JoinedForm> {
  const { raw } = await readQpdfJson(workingPath, calls);
  const fieldsPath = join(workspacePath, "fields.json");
  const outcomePath = join(workspacePath, "inspect-outcome.json");
  const pdfEntries = await runInspectChild(
    { sourcePath: workingPath, fieldsPath, outcomePath, workspacePath },
    calls
  );
  return joinFormFields(raw, pdfEntries);
}

/**
 * The inventory operation (R7, R32): admit the source (decrypting an
 * empty-password document into a private workspace), join both tools and
 * return the shared inventory both surfaces consume.
 */
export async function inventoryFormFields(
  sourcePath: string,
  options: InspectFormOptions = {}
): Promise<FormInventoryResult> {
  assertNotAborted(options.signal);
  const calls: NativeCallOptions = {
    run: options.run ?? defaultNativeRunner,
    signal: options.signal,
    timeoutMs: options.timeoutMs
  };
  const qpdfVersion = await getQpdfVersion(calls);
  assertNativeFloor("qpdf", qpdfVersion, QPDF_SECURITY_FLOOR);
  await validatePdfFillInput(sourcePath);

  const workspace = await createTempWorkspace("pdf-fill-inspect-", options.workspaceParent);
  try {
    const admission = await admitFillSource(sourcePath, workspace.path, calls);
    const joined = await joinDocumentFields(admission.workingPath, workspace.path, calls);
    return {
      inventory: joined.inventory,
      qpdfVersion,
      pageCount: admission.inspection.pageCount,
      warnings: admission.inspection.warnings,
      removedRestrictions: admission.removedRestrictions,
      removedUsageRights: admission.removedUsageRights
    };
  } finally {
    await workspace.cleanup();
  }
}

/** A non-terminal field entry the interview loop still has to settle (KTD8). */
export interface FormPlanOutstandingEntry {
  readonly fieldId: string;
  readonly status: FormPlanEntryStatus;
}

export interface FormPlanCheck {
  /** Field entries still needing an answer, re-emitted for the loop. */
  readonly outstanding: readonly FormPlanOutstandingEntry[];
  /** Placement entries frozen to their absolute rectangles (KTD7). */
  readonly placements: readonly FormPlanPlacement[];
  readonly inventory: FormInventory;
  readonly pageCount: number;
  readonly qpdfVersion: string;
  readonly warnings: readonly string[];
  readonly removedRestrictions: boolean;
  readonly removedUsageRights: boolean;
}

/**
 * The validate operation: check a plan against the source document without
 * mutating anything. Non-terminal field entries are collected, not refused —
 * the caller re-asks exactly those (KTD8, AE10). Every plan defect that is not
 * "still awaiting an answer" still refuses.
 */
export async function checkFormPlan(
  plan: FormPlan,
  sourcePath: string,
  options: InspectFormOptions = {}
): Promise<FormPlanCheck> {
  assertNotAborted(options.signal);
  const calls: NativeCallOptions = {
    run: options.run ?? defaultNativeRunner,
    signal: options.signal,
    timeoutMs: options.timeoutMs
  };
  const qpdfVersion = await getQpdfVersion(calls);
  assertNativeFloor("qpdf", qpdfVersion, QPDF_SECURITY_FLOOR);
  await validatePdfFillInput(sourcePath);

  const workspace = await createTempWorkspace("pdf-fill-check-", options.workspaceParent);
  try {
    const admission = await admitFillSource(sourcePath, workspace.path, calls);
    const joined = await joinDocumentFields(admission.workingPath, workspace.path, calls);
    const outstanding: FormPlanOutstandingEntry[] = [];
    validatePlanEntries(plan, joined, outstanding);
    return {
      outstanding,
      placements: plan.entries.filter((entry): entry is FormPlanPlacement => entry.kind !== "field"),
      inventory: joined.inventory,
      pageCount: admission.inspection.pageCount,
      qpdfVersion,
      warnings: admission.inspection.warnings,
      removedRestrictions: admission.removedRestrictions,
      removedUsageRights: admission.removedUsageRights
    };
  } finally {
    await workspace.cleanup();
  }
}

/** Per-field verification verdict: whether the artifact carries the approved state. */
export interface FormFieldVerification {
  readonly fieldId: string;
  readonly status: "answered" | "skipped";
  /** True when the artifact holds the approved value (answered) or the source value left standing (skipped). */
  readonly applied: boolean;
  /** Which readback aspect failed, when applied is false. */
  readonly detail?: string;
  /** The value the artifact was checked for; the caller digests or reveals it (R13). */
  readonly expected: string;
  /** The observed value or appearance state on mismatch; the caller digests or reveals it (R13). */
  readonly actual?: string;
}

export interface FormPlacementVerification {
  readonly kind: "text" | "checkmark" | "signature";
  readonly page: number;
  readonly applied: boolean;
}

export interface FormVerification {
  readonly fields: readonly FormFieldVerification[];
  readonly placements: readonly FormPlacementVerification[];
  readonly allApplied: boolean;
  readonly warnings: readonly string[];
}

/**
 * The independent readback (R12, KTD14): join the source for expectations,
 * then prove every plan entry against the delivered artifact — field values
 * and appearance states via `qpdf --json`, burned-in content via a bounded
 * `--qdf` dump. Reports a verdict per entry instead of throwing on the first
 * mismatch; every plan defect still refuses before the artifact is read.
 */
export async function verifyFormFill(
  plan: FormPlan,
  sourcePath: string,
  outputPath: string,
  options: InspectFormOptions = {}
): Promise<FormVerification> {
  assertNotAborted(options.signal);
  const calls: NativeCallOptions = {
    run: options.run ?? defaultNativeRunner,
    signal: options.signal,
    timeoutMs: options.timeoutMs
  };
  const qpdfVersion = await getQpdfVersion(calls);
  assertNativeFloor("qpdf", qpdfVersion, QPDF_SECURITY_FLOOR);
  await validatePdfFillInput(outputPath);

  const workspace = await createTempWorkspace("pdf-fill-verify-", options.workspaceParent);
  try {
    const admission = await admitFillSource(sourcePath, workspace.path, calls);
    const joined = await joinDocumentFields(admission.workingPath, workspace.path, calls);
    validatePlanEntries(plan, joined);

    const fieldEntries = plan.entries.filter(
      (entry): entry is FormPlanFieldEntry => entry.kind === "field"
    );
    const expected = new Map<string, string>();
    for (const entry of fieldEntries) {
      const field = joined.byId.get(entry.fieldId) ?? joined.widgetOwner.get(entry.fieldId);
      expected.set(
        entry.fieldId,
        entry.status === "answered" ? entry.value : (field?.entry.currentValue ?? "")
      );
    }

    let readback: { burned: { objects: Map<string, QdfObject>; pages: string[] } } | { interactive: QpdfJson };
    if (plan.burnIn) {
      const dumpPath = workspace.file("verify.qdf");
      await writeQdfDump(outputPath, dumpPath, calls);
      const dumpInfo = await stat(dumpPath);
      if (dumpInfo.size > MAX_QDF_DUMP_BYTES) {
        throw new CompressionError("FILL_READBACK_FAILED", "The decompressed readback dump exceeds its bound.", {
          maxBytes: MAX_QDF_DUMP_BYTES
        });
      }
      const objects = qdfObjects(await readFile(dumpPath, "latin1"));
      const pages = qdfPageRefs(objects);
      if (pages.length !== admission.inspection.pageCount) {
        throw new CompressionError("FILL_READBACK_FAILED", "The delivered page tree could not be enumerated.", {
          pageCount: pages.length
        });
      }
      readback = { burned: { objects, pages } };
    } else {
      readback = { interactive: (await readQpdfJson(outputPath, calls)).raw };
    }

    const fields: FormFieldVerification[] = [];
    for (const entry of fieldEntries) {
      const field = joined.byId.get(entry.fieldId) ?? joined.widgetOwner.get(entry.fieldId);
      if (!field) continue;
      const want = expected.get(entry.fieldId) ?? "";
      const check =
        "burned" in readback
          ? checkBurnedFieldReadback(readback.burned.objects, readback.burned.pages, field, want)
          : checkFieldReadback(readback.interactive, field, want);
      fields.push({
        fieldId: entry.fieldId,
        status: entry.status as "answered" | "skipped",
        applied: check.applied,
        expected: want,
        ...(check.detail !== undefined ? { detail: check.detail } : {}),
        ...(check.actual !== undefined ? { actual: check.actual } : {})
      });
    }
    const placements: FormPlacementVerification[] = plan.entries
      .filter((entry): entry is FormPlanPlacement => entry.kind !== "field")
      .map((entry) => ({
        kind: entry.kind,
        page: entry.page,
        applied:
          "burned" in readback
            ? checkBurnedPlacementReadback(readback.burned.objects, readback.burned.pages, entry)
            : checkPlacementReadback(readback.interactive, entry)
      }));
    return {
      fields,
      placements,
      allApplied: fields.every((field) => field.applied) && placements.every((placement) => placement.applied),
      warnings: admission.inspection.warnings
    };
  } finally {
    await workspace.cleanup();
  }
}

/**
 * The fill operation: admit, join, validate the approved plan against the
 * inventory, run the bounded child, strip field actions, collapse
 * revisions, optionally burn in, validate strictly, read back and publish.
 * The source is never rewritten; every intermediate lives in a private
 * workspace that is removed on success, failure, cancellation and timeout.
 */
export async function fillForm(options: FillFormOptions): Promise<FillSummary> {
  assertNotAborted(options.signal);
  const plan = await readPlanFile(options.planPath);
  // The approval binds source and destination (KTD7, KTD18): the paths this
  // run reads and writes must be exactly the ones the plan was approved for.
  if (plan.source !== options.sourcePath || plan.destination !== options.destinationPath) {
    throw new CompressionError(
      "FILL_PLAN_SOURCE_MISMATCH",
      "The plan's source and destination bindings do not match this fill operation.",
      { planSource: plan.source, planDestination: plan.destination }
    );
  }
  // The bytes read are the caller-approved snapshot when one is supplied
  // (KTD7); the binding check above still pins the plan's source path.
  const readPath = options.workingSourcePath ?? options.sourcePath;
  const scan = await validatePdfFillInput(readPath);
  if (scan.sizeBytes > FILL_MAX_SOURCE_BYTES) {
    throw new CompressionError(
      "FILL_INPUT_TOO_LARGE",
      `Source PDF exceeds the ${FILL_MAX_SOURCE_BYTES} byte fill limit.`,
      { inputPath: options.sourcePath, sizeBytes: scan.sizeBytes }
    );
  }
  const sourceHash = await hashFile(readPath);
  let clearDestination = false;
  try {
    await assertFreshDestination(options.destinationPath, [options.sourcePath, readPath]);
  } catch (error) {
    if (!plan.overwrite || !isCompressionError(error) || error.code !== "OUTPUT_EXISTS") throw error;
    clearDestination = true;
  }

  const maxOutputBytes = options.maxOutputBytes ?? FILL_MAX_OUTPUT_BYTES;
  const calls: NativeCallOptions = {
    run: options.run ?? defaultNativeRunner,
    signal: options.signal,
    timeoutMs: options.timeoutMs
  };
  const qpdfVersion = await getQpdfVersion(calls);
  assertNativeFloor("qpdf", qpdfVersion, QPDF_SECURITY_FLOOR);

  const workspace = await createTempWorkspace("pdf-fill-", options.workspaceParent);
  const stagingPath = join(dirname(options.destinationPath), `.pdf-fill-staging-${randomUUID()}.pdf`);
  try {
    const admission = await admitFillSource(readPath, workspace.path, calls);
    const joined = await joinDocumentFields(admission.workingPath, workspace.path, calls);
    const answered = validatePlanEntries(plan, joined);
    const values = new Map<string, string>();
    for (const entry of plan.entries) {
      if (entry.kind === "field" && entry.status === "answered") values.set(entry.fieldId, entry.value);
    }

    const candidatePath = workspace.file("candidate.pdf");
    const outcomePath = workspace.file("fill-outcome.json");
    await withOutputLimit(
      candidatePath,
      calls,
      maxOutputBytes,
      outputTooLarge,
      (limitedCalls) =>
        runFillChild(
          {
            sourcePath: admission.workingPath,
            planPath: options.planPath,
            candidatePath,
            outcomePath,
            workspacePath: workspace.path,
            maxOutputBytes
          },
          limitedCalls
        ),
      options.resourceCheck
    );

    // Removal runs against the candidate the child actually wrote.
    const candidateJson = await readQpdfJson(candidatePath, calls);
    // The child sets /NeedAppearances when it could not render a value into
    // an appearance (KTD9, AE11); burning in then flattens to a blank.
    if (
      plan.burnIn &&
      candidateJson.raw.acroform?.needappearances === true &&
      !admission.inspection.needsRendering
    ) {
      throw new CompressionError(
        "FILL_APPEARANCE_MISSING",
        "The renderer could not build an appearance for an approved value; burning in would deliver a blank.",
        { sourcePath: options.sourcePath }
      );
    }
    const update = planFieldActionRemoval(candidateJson.raw);
    let updateJsonPath: string | undefined;
    if (Object.keys(update.objects).length > 0) {
      updateJsonPath = workspace.file("field-action-update.json");
      await writeFile(updateJsonPath, serializeFieldActionUpdate(update), { mode: 0o600 });
    }

    const stagePath = workspace.file("rewritten.pdf");
    const stageWarnings = await withOutputLimit(
      stagePath,
      calls,
      maxOutputBytes,
      outputTooLarge,
      (limitedCalls) =>
        runFillOutputStage(
          {
            inputPath: candidatePath,
            outputPath: stagePath,
            ...(updateJsonPath ? { updateJsonPath } : {}),
            generateAppearances: true
          },
          limitedCalls
        ),
      options.resourceCheck
    );

    const warnings = [
      ...admission.inspection.warnings,
      ...candidateJson.warnings,
      ...stageWarnings
    ];

    let finalPath = stagePath;
    if (plan.burnIn) {
      // The blank-delivery guard: every widget that must show a value needs
      // an appearance before flattening (KTD9, AE11).
      const stageJson = await readQpdfJson(stagePath, calls);
      assertAppearancesPresent(stageJson.raw, answered, values);
      readbackFieldValues(stageJson.raw, answered, values);
      const flatPath = workspace.file("flattened.pdf");
      const flatWarnings = await withOutputLimit(
        flatPath,
        calls,
        maxOutputBytes,
        outputTooLarge,
        (limitedCalls) =>
          runFillOutputStage({ inputPath: stagePath, outputPath: flatPath, flatten: true }, limitedCalls),
        options.resourceCheck
      );
      warnings.push(...flatWarnings);
      finalPath = flatPath;
    }

    const inspection = await validatePdfArtifact(finalPath, admission.inspection.pageCount, calls);
    warnings.push(...inspection.warnings);

    if (plan.burnIn) {
      const dumpPath = workspace.file("readback.qdf");
      await writeQdfDump(finalPath, dumpPath, calls);
      const dumpInfo = await stat(dumpPath);
      if (dumpInfo.size > MAX_QDF_DUMP_BYTES) {
        throw new CompressionError("FILL_READBACK_FAILED", "The decompressed readback dump exceeds its bound.", {
          maxBytes: MAX_QDF_DUMP_BYTES
        });
      }
      const dump = await readFile(dumpPath, "latin1");
      const objects = qdfObjects(dump);
      const pages = qdfPageRefs(objects);
      if (pages.length !== admission.inspection.pageCount) {
        throw new CompressionError("FILL_READBACK_FAILED", "The delivered page tree could not be enumerated.", {
          pageCount: pages.length
        });
      }
      readbackBurnedContent(objects, pages, plan, answered, values);
    } else {
      const finalJson = await readQpdfJson(finalPath, calls);
      readbackFieldValues(finalJson.raw, answered, values);
      readbackPlacements(finalJson.raw, plan);
    }

    const computedFields = [...answered.values()].filter((field) => field.computed).length;
    if (computedFields > 0) {
      warnings.push(
        `${computedFields} filled field(s) carried calculate/format/validate actions; the document's own arithmetic did not run.`
      );
    }

    if (clearDestination) await unlink(options.destinationPath);
    await options.resourceCheck?.((await stat(finalPath)).size);
    await copyFile(finalPath, stagingPath);
    await options.resourceCheck?.(0);
    await publishNoClobber(stagingPath, options.destinationPath);
    const outputStat = await stat(options.destinationPath);
    const afterHash = await hashFile(readPath);
    if (afterHash !== sourceHash) {
      throw new CompressionError("ENGINE_FAILED", "The source changed during the fill operation.", {
        inputPath: options.sourcePath
      });
    }

    return {
      outputPath: options.destinationPath,
      outputBytes: outputStat.size,
      pageCount: inspection.pageCount,
      burnedIn: plan.burnIn,
      fieldsWritten: answered.size,
      placementsWritten: plan.entries.filter((entry) => entry.kind !== "field").length,
      computedFields,
      removedRestrictions: admission.removedRestrictions,
      removedUsageRights: admission.removedUsageRights,
      qpdfVersion,
      sourceHash,
      warnings,
      compatWarnings: inspection.compatWarnings
    };
  } finally {
    await rm(stagingPath, { force: true });
    await workspace.cleanup();
  }
}

/**
 * Standalone burn-in (R36, KTD9): flatten an already-filled interactive
 * artifact so its field values become page content, using the same
 * machinery as the fill operation's burn-in tail — empty-password
 * admission, field-action removal, appearance regeneration, the
 * blank-delivery guard, flattening, the strict gate and no-clobber
 * publication. There is no plan, so the appearance guard derives "must show
 * something" from the document itself rather than from approved values.
 */
export async function burnInForm(options: BurnInFormOptions): Promise<BurnInSummary> {
  assertNotAborted(options.signal);
  const scan = await validatePdfFillInput(options.sourcePath);
  if (scan.sizeBytes > FILL_MAX_SOURCE_BYTES) {
    throw new CompressionError(
      "FILL_INPUT_TOO_LARGE",
      `Source PDF exceeds the ${FILL_MAX_SOURCE_BYTES} byte fill limit.`,
      { inputPath: options.sourcePath, sizeBytes: scan.sizeBytes }
    );
  }
  const sourceHash = await hashFile(options.sourcePath);
  let clearDestination = false;
  try {
    await assertFreshDestination(options.destinationPath, [options.sourcePath]);
  } catch (error) {
    if (!options.overwrite || !isCompressionError(error) || error.code !== "OUTPUT_EXISTS") throw error;
    clearDestination = true;
  }

  const maxOutputBytes = options.maxOutputBytes ?? FILL_MAX_OUTPUT_BYTES;
  const calls: NativeCallOptions = {
    run: options.run ?? defaultNativeRunner,
    signal: options.signal,
    timeoutMs: options.timeoutMs
  };
  const qpdfVersion = await getQpdfVersion(calls);
  assertNativeFloor("qpdf", qpdfVersion, QPDF_SECURITY_FLOOR);

  const workspace = await createTempWorkspace("pdf-burn-in-", options.workspaceParent);
  const stagingPath = join(dirname(options.destinationPath), `.pdf-burn-in-staging-${randomUUID()}.pdf`);
  try {
    const admission = await admitFillSource(options.sourcePath, workspace.path, calls);
    const sourceJson = await readQpdfJson(admission.workingPath, calls);
    const update = planFieldActionRemoval(sourceJson.raw);
    let updateJsonPath: string | undefined;
    if (Object.keys(update.objects).length > 0) {
      updateJsonPath = workspace.file("field-action-update.json");
      await writeFile(updateJsonPath, serializeFieldActionUpdate(update), { mode: 0o600 });
    }

    const stagePath = workspace.file("appearances.pdf");
    const stageWarnings = await withOutputLimit(
      stagePath,
      calls,
      maxOutputBytes,
      outputTooLarge,
      (limitedCalls) =>
        runFillOutputStage(
          {
            inputPath: admission.workingPath,
            outputPath: stagePath,
            ...(updateJsonPath ? { updateJsonPath } : {}),
            generateAppearances: true
          },
          limitedCalls
        ),
      options.resourceCheck
    );

    const stageJson = await readQpdfJson(stagePath, calls);
    assertGeneratedAppearances(stageJson.raw);

    const flatPath = workspace.file("flattened.pdf");
    const flatWarnings = await withOutputLimit(
      flatPath,
      calls,
      maxOutputBytes,
      outputTooLarge,
      (limitedCalls) =>
        runFillOutputStage({ inputPath: stagePath, outputPath: flatPath, flatten: true }, limitedCalls),
      options.resourceCheck
    );

    const inspection = await validatePdfArtifact(flatPath, admission.inspection.pageCount, calls);
    const warnings = [
      ...admission.inspection.warnings,
      ...sourceJson.warnings,
      ...stageWarnings,
      ...stageJson.warnings,
      ...flatWarnings,
      ...inspection.warnings
    ];
    // The operation's contract: no form fields may survive flattening.
    if (inspection.compatWarnings.includes("forms")) {
      throw new CompressionError("OUTPUT_INVALID", "The flattened file still carries form fields.", {
        outputPath: flatPath
      });
    }
    const fieldsBurnedIn = new Set(
      (stageJson.raw.acroform?.fields ?? [])
        .map((row) => rowFieldRef(row))
        .filter((ref): ref is string => ref !== undefined)
    ).size;

    if (clearDestination) await unlink(options.destinationPath);
    await options.resourceCheck?.((await stat(flatPath)).size);
    await copyFile(flatPath, stagingPath);
    await options.resourceCheck?.(0);
    await publishNoClobber(stagingPath, options.destinationPath);
    const outputStat = await stat(options.destinationPath);
    if ((await hashFile(options.sourcePath)) !== sourceHash) {
      throw new CompressionError("ENGINE_FAILED", "The source changed during the burn-in operation.", {
        inputPath: options.sourcePath
      });
    }

    return {
      outputPath: options.destinationPath,
      outputBytes: outputStat.size,
      pageCount: inspection.pageCount,
      fieldsBurnedIn,
      removedRestrictions: admission.removedRestrictions,
      removedUsageRights: admission.removedUsageRights,
      qpdfVersion,
      sourceHash,
      warnings,
      compatWarnings: inspection.compatWarnings
    };
  } finally {
    await rm(stagingPath, { force: true });
    await workspace.cleanup();
  }
}
