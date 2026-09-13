/**
 * Bounded fill child (KTD2). Invoked by `runFillChild` as
 *
 *   node --max-old-space-size=<mb> pdfjs-fill-child.(js|ts) \
 *     --source=<path> --plan=<path> --candidate=<path> --outcome=<path> \
 *     --max-bytes=<n>
 *
 * and by `runInspectChild` as
 *
 *   node --max-old-space-size=<mb> pdfjs-fill-child.(js|ts) \
 *     --mode=inspect --source=<path> --fields=<path> --outcome=<path>
 *
 * Contract:
 * - No document bytes cross a pipe. Inputs arrive as paths; the produced PDF
 *   lands only at the candidate path; the sole report back is a small
 *   structured outcome file (never stderr). In inspect mode nothing is
 *   produced but the bounded fields file: `getFieldObjects` serialized so
 *   the parent can join PDF.js addressing and geometry with qpdf semantics
 *   without loading the renderer in-process.
 * - The outcome file first carries a `running` marker with diagnostics, then
 *   exactly one terminal status: `filled`, `inspected`, `refused` or
 *   `failed`. The child exits 0 once a terminal outcome is written; a
 *   nonzero exit means the child died before reporting (including a
 *   heap-limit kill).
 * - The heap cap arrives through the `--max-old-space-size` argv entry, not
 *   the environment: the runner's minimal environment deliberately drops
 *   NODE_OPTIONS.
 * - This module stays free of relative runtime imports so the source-layout
 *   `.ts` entry can run under Node type stripping, where `import "./x.js"`
 *   specifiers would not resolve. `import type` specifiers are erased.
 *
 * Capability note (KTD1): image/stamp embedding needs a canvas the Node
 * runtime does not provide; the stamp editor path raises rather than
 * degrading, and no plan entry can express an image. Drawn signatures, free
 * text and checkmarks produce appearances headless.
 */
import { once } from "node:events";
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { FormPlan, PdfRect } from "../form-plan.js";

const MAX_PLAN_BYTES = 512 * 1024;
const MAX_FIELDS_BYTES = 8 * 1024 * 1024;
const MESSAGE_LIMIT = 400;
const SIGNATURE_THICKNESS = 1.6;
const CHECKMARK_THICKNESS = 2.4;
const FILE_MODE = 0o600;

/** Renderer-side annotation kinds: FreeText, Ink, signature (drawn) Stamp. */
const ANNOTATION_TYPE_FREETEXT = 3;
const ANNOTATION_TYPE_INK = 15;
const ANNOTATION_TYPE_SIGNATURE = 101;

interface FillChildArgs {
  mode: "fill" | "inspect";
  source: string;
  plan?: string;
  candidate?: string;
  fields?: string;
  outcome: string;
  maxBytes: number;
}

interface ChildDiagnostics {
  pid: number;
  cwd: string;
  envKeys: string[];
  stdinEnded: boolean;
}

type ChildOutcome =
  | { status: "running"; child: ChildDiagnostics }
  | { status: "filled"; bytes: number; child: ChildDiagnostics }
  | { status: "inspected"; bytes: number; child: ChildDiagnostics }
  | { status: "refused"; code: "OUTPUT_TOO_LARGE"; producedBytes: number; maxBytes: number; child: ChildDiagnostics }
  | { status: "failed"; code: "ENGINE_FAILED"; message: string; child: ChildDiagnostics };

function parseArgs(argv: readonly string[]): FillChildArgs {
  const values = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (!match) throw new Error(`Unrecognized argument "${arg}".`);
    values.set(match[1], match[2]);
  }
  const take = (key: string): string => {
    const value = values.get(key);
    if (value === undefined || value === "") throw new Error(`Missing --${key} argument.`);
    return value;
  };
  const optional = (key: string): string | undefined => {
    const value = values.get(key);
    return value === undefined || value === "" ? undefined : value;
  };
  const mode = values.get("mode") ?? "fill";
  if (mode !== "fill" && mode !== "inspect") {
    throw new Error(`Unrecognized --mode "${mode}".`);
  }
  const maxBytesValue = optional("max-bytes");
  const maxBytes = maxBytesValue === undefined ? 0 : Number(maxBytesValue);
  if (!Number.isInteger(maxBytes) || maxBytes < 0) {
    throw new Error("--max-bytes must be a non-negative integer.");
  }
  if (mode === "inspect") {
    return {
      mode,
      source: take("source"),
      fields: take("fields"),
      outcome: take("outcome"),
      maxBytes
    };
  }
  return {
    mode,
    source: take("source"),
    plan: take("plan"),
    candidate: take("candidate"),
    outcome: take("outcome"),
    maxBytes
  };
}

/**
 * The installed standard font directory, resolved from this module rather
 * than the working directory so text appearances are generated correctly
 * wherever the child is spawned. PDF.js requires the trailing separator.
 */
function standardFontsDir(): string {
  const packageJson = fileURLToPath(import.meta.resolve("pdfjs-dist/package.json"));
  return join(dirname(packageJson), "standard_fonts") + "/";
}

async function writeOutcome(path: string, outcome: ChildOutcome): Promise<void> {
  await writeFile(path, JSON.stringify(outcome), { mode: FILE_MODE });
}

function cappedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MESSAGE_LIMIT);
}

/**
 * Field objects as `getFieldObjects` yields them, indexed by annotation
 * identifier. A plan field identifier may name the field dictionary or one
 * of its widgets; both resolve to the set of annotation ids that must carry
 * the value (KTD5).
 */
interface FieldObjectEntry {
  id: string;
  kidIds?: string[];
  type?: string;
  exportValues?: string;
}

/**
 * The annotation ids a field entry must write: every widget the field owns,
 * so no sibling is left stale (KTD5, R12). A widget-level plan identifier
 * resolves to the whole set through the group entry that lists it as a kid;
 * a merged field/widget dictionary writes itself.
 */
function widgetIdsOf(
  target: FieldObjectEntry,
  groups: FieldObjectEntry[][]
): string[] {
  if (target.kidIds && target.kidIds.length > 0) return target.kidIds;
  for (const list of groups) {
    for (const entry of list) {
      if (entry.kidIds && entry.kidIds.includes(target.id)) return entry.kidIds;
    }
  }
  return [target.id];
}

/**
 * Checkbox and radio widgets take a boolean: on when the widget's own
 * export value is the approved one. A checkbox has exactly one non-Off
 * state, so any approved non-Off value checks it — the plan may spell the
 * export value or the appearance-state name where they differ. A radio
 * widget turns on only when its own export value is approved; siblings get
 * false so the group settles on one selection.
 */
function widgetValue(entry: FieldObjectEntry | undefined, value: string): { value: string | boolean } {
  if (entry?.type === "checkbox") {
    return { value: value !== "" && value !== "Off" };
  }
  if (entry?.type === "radiobutton") {
    return { value: entry.exportValues === value };
  }
  return { value };
}

/**
 * Plan field identifiers are canonical "N G R" object references (KTD5);
 * PDF.js keys its annotation storage as "NR" ("NRg" when the generation is
 * nonzero). Translate between the two spellings.
 */
function pdfJsKey(fieldId: string): string {
  const match = /^(\d+) (\d+) R$/.exec(fieldId);
  if (!match) return fieldId;
  return match[2] === "0" ? `${match[1]}R` : `${match[1]}R${match[2]}`;
}

function strokeToLine(stroke: readonly number[]): number[] {
  const line: number[] = [NaN, NaN, NaN, NaN, stroke[0], stroke[1]];
  for (let index = 2; index < stroke.length; index += 2) {
    line.push(NaN, NaN, NaN, NaN, stroke[index], stroke[index + 1]);
  }
  return line;
}

function toRectArray(rect: PdfRect): number[] {
  return [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height];
}

function checkmarkStroke(rect: PdfRect): number[] {
  return [
    rect.x + rect.width * 0.15,
    rect.y + rect.height * 0.45,
    rect.x + rect.width * 0.4,
    rect.y + rect.height * 0.15,
    rect.x + rect.width * 0.85,
    rect.y + rect.height * 0.8
  ];
}

async function applyPlan(doc: PDFDocumentProxy, plan: FormPlan): Promise<void> {
  const storage = doc.annotationStorage;
  let editorCount = 0;
  const nextEditorId = (): string => `pdfjs_internal_editor_${editorCount++}`;

  const fieldObjects = await doc.getFieldObjects();
  const fieldsById = new Map<string, FieldObjectEntry>();
  const groups: FieldObjectEntry[][] = [];
  if (fieldObjects) {
    for (const list of fieldObjects.values()) {
      const group: FieldObjectEntry[] = [];
      for (const entry of list) {
        const probe = entry as FieldObjectEntry;
        if (typeof probe?.id === "string") {
          fieldsById.set(probe.id, probe);
          group.push(probe);
        }
      }
      groups.push(group);
    }
  }

  for (const entry of plan.entries) {
    if (entry.kind === "field") {
      if (entry.status !== "answered") continue;
      const target = fieldsById.get(pdfJsKey(entry.fieldId));
      if (!target) throw new Error(`Plan names a field the document does not contain: "${entry.fieldId}".`);
      for (const id of widgetIdsOf(target, groups)) {
        storage.setValue(id, widgetValue(fieldsById.get(id), entry.value));
      }
      continue;
    }
    if (entry.page > doc.numPages) {
      throw new Error(`Placement page ${entry.page} exceeds the document's ${doc.numPages} pages.`);
    }
    const pageIndex = entry.page - 1;
    const rect = toRectArray(entry.rect);
    switch (entry.kind) {
      case "text":
        storage.setValue(nextEditorId(), {
          annotationType: ANNOTATION_TYPE_FREETEXT,
          color: [0, 0, 0],
          fontSize: 12,
          value: entry.text,
          pageIndex,
          rect,
          rotation: 0,
          deleted: false
        });
        break;
      case "checkmark": {
        const stroke = checkmarkStroke(entry.rect);
        storage.setValue(nextEditorId(), {
          annotationType: ANNOTATION_TYPE_INK,
          color: [0, 0, 0],
          opacity: 1,
          thickness: CHECKMARK_THICKNESS,
          paths: { lines: [strokeToLine(stroke)], points: [stroke] },
          pageIndex,
          rect,
          rotation: 0,
          deleted: false
        });
        break;
      }
      case "signature":
        storage.setValue(nextEditorId(), {
          annotationType: ANNOTATION_TYPE_SIGNATURE,
          isSignature: true,
          areContours: false,
          color: [0, 0, 0],
          thickness: SIGNATURE_THICKNESS,
          lines: entry.strokes.map(strokeToLine),
          pageIndex,
          rect,
          rotation: 0,
          deleted: false
        });
        break;
    }
  }
}

/**
 * The inventory-facing projection of one `getFieldObjects` entry: only the
 * addressing, geometry, flags and action-event names the parent joins with
 * qpdf's field semantics (KTD6). Nothing document-derived is trusted here;
 * the parent applies the inventory schema caps.
 */
function serializeFieldEntry(name: string, entry: unknown): Record<string, unknown> {
  const source = entry as Record<string, unknown>;
  const out: Record<string, unknown> = { name };
  const copyKeys = [
    "id",
    "type",
    "value",
    "defaultValue",
    "exportValues",
    "page",
    "rect",
    "charLimit",
    "comb",
    "multiline",
    "password",
    "hidden",
    "readOnly",
    "editable",
    "required",
    "noExport",
    "hasAppearance"
  ] as const;
  for (const key of copyKeys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  if (Array.isArray(source["kidIds"])) out["kidIds"] = source["kidIds"];
  if (Array.isArray(source["items"])) out["items"] = source["items"];
  const actions = source["actions"];
  if (actions instanceof Map) {
    out["actionKeys"] = [...actions.keys()];
  } else if (typeof actions === "object" && actions !== null) {
    out["actionKeys"] = Object.keys(actions);
  }
  return out;
}

async function writeFieldDump(doc: PDFDocumentProxy, fieldsPath: string): Promise<number> {
  const fieldObjects = await doc.getFieldObjects();
  const fields: Record<string, unknown>[] = [];
  if (fieldObjects) {
    for (const [name, list] of fieldObjects) {
      for (const entry of list) {
        fields.push(serializeFieldEntry(name, entry));
      }
    }
  }
  const json = JSON.stringify({ fields });
  if (json.length > MAX_FIELDS_BYTES) {
    throw new Error(`Field inventory dump exceeds the ${MAX_FIELDS_BYTES} byte bound.`);
  }
  await writeFile(fieldsPath, json, { mode: FILE_MODE });
  return json.length;
}

async function readPlan(path: string): Promise<FormPlan> {
  const info = await stat(path);
  if (info.size > MAX_PLAN_BYTES) {
    throw new Error(`Plan file exceeds the ${MAX_PLAN_BYTES} byte bound.`);
  }
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { entries?: unknown }).entries)) {
    throw new Error("Plan file is not an object with an entries array.");
  }
  // The parent validates the plan against the form-plan schema before this
  // child runs; here the entries only need the structure application reads.
  return parsed as FormPlan;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // The runner gives the child a closed stdin; on a real pipe this resolves
  // immediately. A TTY stdin only exists on manual invocation.
  let stdinEnded = false;
  if (!process.stdin.isTTY) {
    process.stdin.resume();
    await once(process.stdin, "end");
    stdinEnded = true;
  }
  const child: ChildDiagnostics = {
    pid: process.pid,
    cwd: process.cwd(),
    envKeys: Object.keys(process.env).sort(),
    stdinEnded
  };
  await writeOutcome(args.outcome, { status: "running", child });

  try {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const data = new Uint8Array(await readFile(args.source));
    // `isEvalSupported` and `enableScripting` are honored by the runtime but
    // absent from the declared parameter type.
    const params = {
      data,
      standardFontDataUrl: standardFontsDir(),
      isEvalSupported: false,
      enableScripting: false,
      useSystemFonts: false,
      isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false
    };
    const loadingTask = getDocument(params);
    const doc = await loadingTask.promise;
    try {
      if (args.mode === "inspect") {
        const bytes = await writeFieldDump(doc, args.fields ?? "");
        await writeOutcome(args.outcome, { status: "inspected", bytes, child });
      } else {
        const plan = await readPlan(args.plan ?? "");
        await applyPlan(doc, plan);
        const bytes = await doc.saveDocument();
        if (bytes.length > args.maxBytes) {
          await writeOutcome(args.outcome, {
            status: "refused",
            code: "OUTPUT_TOO_LARGE",
            producedBytes: bytes.length,
            maxBytes: args.maxBytes,
            child
          });
          return;
        }
        await writeFile(args.candidate ?? "", bytes, { mode: FILE_MODE });
        await writeOutcome(args.outcome, { status: "filled", bytes: bytes.length, child });
      }
    } finally {
      await loadingTask.destroy();
    }
  } catch (error) {
    await writeOutcome(args.outcome, {
      status: "failed",
      code: "ENGINE_FAILED",
      message: cappedMessage(error),
      child
    });
  }
}

await main();
