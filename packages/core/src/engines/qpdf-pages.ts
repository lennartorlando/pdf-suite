import { chmod, link, unlink } from "node:fs/promises";
import { join } from "node:path";
import { CompressionError } from "../errors.js";
import { validatePdfFillInput } from "../validation.js";
import { runProcess, type ProcessResult, type RunProcessOptions } from "./process.js";

/**
 * Low-level qpdf inspection, single-mutation page assembly, final
 * validation, native version gating, and no-clobber publication.
 *
 * Residual local-parser risk: qpdf and Ghostscript parse
 * attacker-controlled bytes with the user account's filesystem authority
 * unless packaging adds OS isolation. Current upstream has unresolved
 * parser/resource-exhaustion issues marked for a later release, so this
 * module fails closed below the security floors and caps native output.
 * Native parsing is never sandboxed here; callers must keep the documented
 * byte, page, and runtime limits.
 */

import { QPDF_SECURITY_FLOOR } from "../native-floors.js";
export { QPDF_FEATURE_FLOOR, QPDF_SECURITY_FLOOR, GHOSTSCRIPT_SECURITY_FLOOR } from "../native-floors.js";

export const NATIVE_PARSER_RISK_NOTE =
  "Native PDF parsing runs with the user account's filesystem authority and is not OS-sandboxed; " +
  "upstream parser/resource-exhaustion fixes are pending a later release, so versions below the " +
  "security floor fail closed.";

/** Where a detected action sits: the document catalog reaches it, or only the field tree does. */
export type ActiveContentScope = "catalog" | "field";

/**
 * One active-content finding as "<kind>@<scope>": the action subtype
 * verbatim ("/URI", "/SubmitForm"), a structural class ("rich-media",
 * "embedded-files"), or "action" for an action reference that could not be
 * classified. Kept string-shaped so inspection consumers compare and join
 * findings without re-deriving policy.
 */
export type ActiveContentFinding = `${string}@${ActiveContentScope}`;

/** Operations the admission policy answers for. */
export type AdmissionOperation = "compress" | "assemble" | "ocr" | "fill";

export type CompatWarningKind = "forms" | "bookmarks" | "tags" | "page-labels";

export interface PdfInspection {
  path: string;
  pageCount: number;
  pdfVersion: string;
  qpdfVersion: string;
  encrypted: boolean;
  /** True when the document carries a blocking signature per R16. */
  signed: boolean;
  /** Every XFA document is refused for filling (R18). */
  xfa: boolean;
  /** Usage-rights signature present; it does not block, and filling removes it. */
  usageRights: boolean;
  /** /NeedAppearances: the document's field appearances must be regenerated. */
  needsRendering: boolean;
  activeContent: ActiveContentFinding[];
  compatWarnings: CompatWarningKind[];
  /** qpdf stderr warnings (exit code 3 still yields a usable inspection). */
  warnings: string[];
}

export type NativeRunner = (
  command: string,
  args: readonly string[],
  options?: RunProcessOptions
) => Promise<ProcessResult>;

export const defaultNativeRunner: NativeRunner = (command, args, options) =>
  runProcess(command, args, options ?? {});

export interface NativeCallOptions {
  run?: NativeRunner;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function childOptions(options: NativeCallOptions, extra?: RunProcessOptions): RunProcessOptions {
  return { signal: options.signal, timeoutMs: options.timeoutMs, ...(extra ?? {}) };
}

export function parseVersionTuple(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersionTuples(
  left: [number, number, number],
  right: [number, number, number]
): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

/** Fail closed when a native tool reports a version below the given floor. */
export function assertNativeFloor(tool: string, found: string, floor: string): void {
  const foundTuple = parseVersionTuple(found);
  const floorTuple = parseVersionTuple(floor);
  if (!foundTuple || !floorTuple || compareVersionTuples(foundTuple, floorTuple) < 0) {
    throw new CompressionError(
      "NATIVE_VERSION_UNSUPPORTED",
      `${tool} version ${found} is below the required floor ${floor}. ${NATIVE_PARSER_RISK_NOTE}`,
      { tool, found, floor }
    );
  }
}

export async function getQpdfVersion(options: NativeCallOptions = {}): Promise<string> {
  const run = options.run ?? defaultNativeRunner;
  const result = await run("qpdf", ["--version"], childOptions(options));
  const match = /qpdf version (\d+\.\d+\.\d+)/.exec(result.stdout);
  if (!match) {
    throw new CompressionError("INSPECTION_INCOMPLETE", "Could not determine the qpdf version.", {
      stdout: result.stdout.slice(0, 500)
    });
  }
  return match[1];
}

export async function getGhostscriptVersion(options: NativeCallOptions = {}): Promise<string> {
  const run = options.run ?? defaultNativeRunner;
  const result = await run("gs", ["--version"], childOptions(options));
  const version = result.stdout.split("\n")[0]?.trim() ?? "";
  if (!parseVersionTuple(version)) {
    throw new CompressionError("INSPECTION_INCOMPLETE", "Could not determine the Ghostscript version.", {
      stdout: version.slice(0, 500)
    });
  }
  return version;
}

interface QpdfJson {
  pages?: Array<{ object?: string }>;
  outlines?: unknown[];
  acroform?: { hasacroform?: boolean; needappearances?: boolean; fields?: unknown[] };
  attachments?: Record<string, unknown>;
  encrypt?: { encrypted?: boolean };
  pagelabels?: unknown[];
  qpdf?: [{ pdfversion?: string; jsonversion?: number }, Record<string, unknown>];
}

/** qpdf --json object-map version this traversal was written against. */
const QPDF_JSON_VERSION = 2;
const OBJECT_REF = /^\d+ \d+ R$/;
/** Initial Safety Limits: bound on traversed object-graph nodes per inspection. */
export const CLASSIFIER_NODE_BUDGET = 200_000;

/**
 * Action subtypes named by PDF 32000 §12.6. Anything else in action position
 * is unclassifiable and fails closed. Of these, only /GoTo is permitted:
 * internal navigation carries no reachable capability.
 */
const KNOWN_ACTION_SUBTYPES = new Set([
  "/GoTo",
  "/GoToR",
  "/GoToE",
  "/GoToDp",
  "/Launch",
  "/Thread",
  "/URI",
  "/Sound",
  "/Movie",
  "/Hide",
  "/Named",
  "/SetOCGState",
  "/Rendition",
  "/Trans",
  "/GoTo3DView",
  "/JavaScript",
  "/SubmitForm",
  "/ResetForm",
  "/ImportData"
]);
const PERMITTED_ACTION_SUBTYPES = new Set(["/GoTo"]);
/** Keys whose value is an action dictionary or a reference to one. */
const ACTION_EDGE_KEYS = new Set(["/A", "/OpenAction", "/OnActivation"]);
/**
 * Actions filling may admit when field-bound, because R15 requires them to
 * be removed before the filled file is delivered.
 */
const FILL_PERMITTED_FIELD_ACTIONS = new Set(["/JavaScript", "/SubmitForm", "/ResetForm"]);

/**
 * The one admission policy shared by every operation (KTD4): signed input is
 * never admissible, and neither is an XFA document (R18) or one that is still
 * encrypted (the fill path inspects the decrypted working copy); compression,
 * assembly and OCR admit no active content; filling alone admits the
 * field-bound actions it strips before delivery.
 */
export function isAdmissibleFor(
  result: {
    encrypted: boolean;
    signed: boolean;
    xfa: boolean;
    activeContent: readonly ActiveContentFinding[];
  },
  operation: AdmissionOperation
): boolean {
  if (result.encrypted || result.signed || result.xfa) return false;
  if (operation === "fill") {
    return result.activeContent.every((finding) => {
      const scopeIndex = finding.lastIndexOf("@");
      return (
        finding.endsWith("@field") &&
        FILL_PERMITTED_FIELD_ACTIONS.has(finding.slice(0, scopeIndex))
      );
    });
  }
  return result.activeContent.length === 0;
}

function isDict(node: unknown): node is Record<string, unknown> {
  return typeof node === "object" && node !== null && !Array.isArray(node);
}

function incomplete(detail: string): CompressionError {
  return new CompressionError(
    "INSPECTION_INCOMPLETE",
    `qpdf inspection could not enumerate the document's object graph (${detail}); treating inspection as incomplete.`,
    { detail }
  );
}

/** The value a qpdf object-map entry contributes to traversal. */
function objectNode(entry: unknown): unknown {
  if (!isDict(entry)) return undefined;
  if ("value" in entry) return entry["value"];
  const stream = entry["stream"];
  return isDict(stream) ? stream["dict"] : undefined;
}

type WalkName = "catalog" | "field" | "orphan";

interface WalkContext {
  walk: WalkName;
  /** True when this node was reached through an action edge. */
  action: boolean;
  /** True when this node is an additional-actions map whose values are actions. */
  aaMap: boolean;
}

const PLAIN: Omit<WalkContext, "walk"> = { action: false, aaMap: false };

interface ClassificationWalk {
  objects: Record<string, unknown>;
  visited: Record<WalkName, Set<string>>;
  nodes: number;
  findings: Map<string, ActiveContentFinding>;
}

function tick(walk: ClassificationWalk): void {
  walk.nodes += 1;
  if (walk.nodes > CLASSIFIER_NODE_BUDGET) {
    throw incomplete(`traversal exceeded the ${CLASSIFIER_NODE_BUDGET} node budget`);
  }
}

function recordFinding(
  walk: ClassificationWalk,
  name: WalkName,
  objKey: string,
  kind: string
): void {
  // Field walk findings on objects the catalog walk also reached are
  // catalog-scoped: scope is decided by reachability, not discovery order.
  const scope: ActiveContentScope =
    name === "field" && !walk.visited.catalog.has(objKey) ? "field" : "catalog";
  walk.findings.set(`${objKey}|${kind}`, `${kind}@${scope}`);
}

function visitObject(ref: string, walk: ClassificationWalk, ctx: WalkContext): void {
  const key = `obj:${ref}`;
  if (walk.visited[ctx.walk].has(key)) return;
  if (ctx.walk === "orphan" && (walk.visited.catalog.has(key) || walk.visited.field.has(key))) {
    return;
  }
  walk.visited[ctx.walk].add(key);
  tick(walk);
  const node = objectNode(walk.objects[key]);
  if (node === undefined) {
    throw incomplete(`object ${ref} is missing from the object map or unclassifiable`);
  }
  traverseNode(node, walk, ctx, key);
}

function traverseNode(
  node: unknown,
  walk: ClassificationWalk,
  ctx: WalkContext,
  objKey: string
): void {
  tick(walk);
  if (typeof node === "string") {
    if (OBJECT_REF.test(node)) visitObject(node, walk, ctx);
    return;
  }
  if (Array.isArray(node)) {
    // An array reached through an action edge is a destination, not a chain;
    // chain edges are only the /Next entry of a dict that is an action.
    for (const element of node) traverseNode(element, walk, { walk: ctx.walk, ...PLAIN }, objKey);
    return;
  }
  if (isDict(node)) traverseDict(node, walk, ctx, objKey);
  else if (ctx.action || ctx.aaMap) recordFinding(walk, ctx.walk, objKey, "action");
}

function traverseActionTarget(
  value: unknown,
  walk: ClassificationWalk,
  name: WalkName,
  objKey: string,
  arrayIsActionList: boolean
): void {
  tick(walk);
  if (typeof value === "string") {
    if (OBJECT_REF.test(value)) {
      visitObject(value, walk, { walk: name, action: true, aaMap: false });
    } else {
      recordFinding(walk, name, objKey, "action");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const element of value) {
      if (arrayIsActionList) {
        traverseActionTarget(element, walk, name, objKey, false);
      } else {
        traverseNode(element, walk, { walk: name, ...PLAIN }, objKey);
      }
    }
    return;
  }
  if (isDict(value)) {
    traverseDict(value, walk, { walk: name, action: true, aaMap: false }, objKey);
    return;
  }
  recordFinding(walk, name, objKey, "action");
}

function traverseAnnotations(value: unknown, walk: ClassificationWalk, objKey: string): void {
  const visitElement = (element: unknown): void => {
    tick(walk);
    if (isDict(element)) {
      // Widget annotations belong to the field walk, not the catalog walk.
      if (element["/Subtype"] !== "/Widget") {
        traverseDict(element, walk, { walk: "catalog", ...PLAIN }, objKey);
      }
      return;
    }
    if (typeof element === "string" && OBJECT_REF.test(element)) {
      const target = objectNode(walk.objects[`obj:${element}`]);
      if (isDict(target) && target["/Subtype"] === "/Widget") return;
      visitObject(element, walk, { walk: "catalog", ...PLAIN });
      return;
    }
    traverseNode(element, walk, { walk: "catalog", ...PLAIN }, objKey);
  };
  if (typeof value === "string" && OBJECT_REF.test(value)) {
    const key = `obj:${value}`;
    if (walk.visited.catalog.has(key)) return;
    walk.visited.catalog.add(key);
    tick(walk);
    const target = objectNode(walk.objects[key]);
    if (target === undefined) {
      throw incomplete(`annotation array ${value} is missing from the object map or unclassifiable`);
    }
    if (Array.isArray(target)) {
      for (const element of target) visitElement(element);
      return;
    }
    visitElement(target);
    return;
  }
  if (Array.isArray(value)) {
    for (const element of value) visitElement(element);
    return;
  }
  visitElement(value);
}

function traverseAdditionalActions(
  value: unknown,
  walk: ClassificationWalk,
  name: WalkName,
  objKey: string
): void {
  tick(walk);
  if (isDict(value)) {
    for (const entry of Object.values(value)) {
      traverseActionTarget(entry, walk, name, objKey, false);
    }
    return;
  }
  if (typeof value === "string" && OBJECT_REF.test(value)) {
    visitObject(value, walk, { walk: name, action: false, aaMap: true });
    return;
  }
  traverseNode(value, walk, { walk: name, ...PLAIN }, objKey);
}

function traverseDict(
  dict: Record<string, unknown>,
  walk: ClassificationWalk,
  ctx: WalkContext,
  objKey: string
): void {
  if (ctx.aaMap) {
    for (const value of Object.values(dict)) {
      traverseActionTarget(value, walk, ctx.walk, objKey, false);
    }
    return;
  }
  const subtype = dict["/S"];
  const isName = typeof subtype === "string" && subtype.startsWith("/");
  const isAction = ctx.action || (isName && KNOWN_ACTION_SUBTYPES.has(subtype));
  if (isAction && (!isName || !PERMITTED_ACTION_SUBTYPES.has(subtype))) {
    recordFinding(walk, ctx.walk, objKey, isName ? subtype : "action");
  }
  if (dict["/Subtype"] === "/RichMedia" || dict["/Type"] === "/RichMedia") {
    recordFinding(walk, ctx.walk, objKey, "rich-media");
  }
  if (dict["/Type"] === "/Filespec" || "/EF" in dict || "/EmbeddedFiles" in dict) {
    recordFinding(walk, ctx.walk, objKey, "embedded-files");
  }
  for (const [key, value] of Object.entries(dict)) {
    // Ownership edges (KTD4): the form dictionary's field edge and a page's
    // widget annotations belong to the field walk; a widget's /P edge back
    // to its page stays out of the field walk.
    if (ctx.walk === "catalog" && key === "/Fields") continue;
    if (ctx.walk === "field" && key === "/P") continue;
    if (key === "/Annots" && ctx.walk === "catalog") {
      traverseAnnotations(value, walk, objKey);
      continue;
    }
    if (key === "/AA") {
      traverseAdditionalActions(value, walk, ctx.walk, objKey);
      continue;
    }
    if (ACTION_EDGE_KEYS.has(key)) {
      traverseActionTarget(value, walk, ctx.walk, objKey, false);
      continue;
    }
    if (key === "/Next") {
      // /Next is an action chain only on an action dictionary; everywhere
      // else (outline items, page dictionaries) it is an ordinary edge.
      if (isAction) traverseActionTarget(value, walk, ctx.walk, objKey, true);
      else traverseNode(value, walk, { walk: ctx.walk, ...PLAIN }, objKey);
      continue;
    }
    traverseNode(value, walk, { walk: ctx.walk, ...PLAIN }, objKey);
  }
}

function fieldRoots(raw: QpdfJson, objects: Record<string, unknown>): string[] {
  const acroform = raw.acroform;
  if (!acroform) return [];
  const fields = acroform.fields;
  if (fields === undefined || fields === null) {
    if (acroform.hasacroform === true) {
      throw incomplete("acroform section reports a form but no field entries");
    }
    return [];
  }
  if (!Array.isArray(fields)) {
    throw incomplete("acroform field section is malformed");
  }
  const roots: string[] = [];
  for (const entry of fields) {
    if (!isDict(entry)) throw incomplete("acroform field entry is malformed");
    const annotation = entry["annotation"];
    const candidates = [
      entry["object"],
      isDict(annotation) ? annotation["object"] : undefined,
      entry["parent"]
    ];
    const refs = candidates.filter(
      (candidate): candidate is string =>
        typeof candidate === "string" && OBJECT_REF.test(candidate)
    );
    if (refs.length === 0) {
      throw incomplete("acroform field entry lacks annotation references");
    }
    for (const ref of refs) {
      if (!isDict(objects[`obj:${ref}`])) {
        throw incomplete(`acroform field reference ${ref} is missing from the object map`);
      }
      roots.push(ref);
    }
  }
  return roots;
}

/**
 * Classify one parsed qpdf --json document (fail closed). Active content is
 * found by an allowlist over two ownership-aware reachability walks (KTD4):
 * the catalog walk starts at the trailer root but skips the AcroForm field
 * edge and page widget annotations; the field walk starts at the annotation
 * references in the acroform field section and climbs /Parent so non-terminal
 * parents are covered. An object is field-bound only when the field walk
 * reaches it and the catalog walk does not. Any walk that cannot enumerate
 * its reachable set throws INSPECTION_INCOMPLETE rather than admit.
 */
export function classifyQpdfJson(raw: QpdfJson): {
  encrypted: boolean;
  signed: boolean;
  xfa: boolean;
  usageRights: boolean;
  needsRendering: boolean;
  activeContent: ActiveContentFinding[];
  compatWarnings: CompatWarningKind[];
} {
  const objects = raw.qpdf?.[1];
  if (raw.qpdf?.[0]?.jsonversion !== QPDF_JSON_VERSION || !isDict(objects)) {
    throw incomplete("unsupported or missing qpdf JSON object map");
  }
  const trailer = objectNode(objects["trailer"]);
  const rootRef = isDict(trailer) ? trailer["/Root"] : undefined;
  const catalogNode =
    typeof rootRef === "string" && OBJECT_REF.test(rootRef)
      ? objectNode(objects[`obj:${rootRef}`])
      : undefined;
  if (typeof rootRef !== "string" || !OBJECT_REF.test(rootRef) || !isDict(catalogNode)) {
    throw incomplete("trailer lacks a resolvable document catalog");
  }

  const walk: ClassificationWalk = {
    objects,
    visited: { catalog: new Set(), field: new Set(), orphan: new Set() },
    nodes: 0,
    findings: new Map()
  };
  visitObject(rootRef, walk, { walk: "catalog", ...PLAIN });
  for (const ref of fieldRoots(raw, objects)) {
    visitObject(ref, walk, { walk: "field", ...PLAIN });
  }
  // Objects unreachable from either root set are still part of the file;
  // classify them conservatively as catalog-scoped.
  for (const key of Object.keys(objects)) {
    if (!key.startsWith("obj:")) continue;
    if (walk.visited.catalog.has(key) || walk.visited.field.has(key)) continue;
    if (walk.visited.orphan.has(key)) continue;
    visitObject(key.slice(4), walk, { walk: "orphan", ...PLAIN });
  }
  if (Object.keys(raw.attachments ?? {}).length > 0) {
    walk.findings.set("attachments|embedded-files", "embedded-files@catalog");
  }

  // Signature rule (R16): a signature field holding a value, and a
  // document-modification permission signature (/Perms /DocMDP), block every
  // operation. A usage-rights signature (/Perms /UR or /UR3) does not block;
  // an empty signature widget, a /Sig field without a /V value, does not
  // either, which is the case a name scan gets wrong because the field type
  // itself contains the name it looks for.
  const deref = (node: unknown): unknown =>
    typeof node === "string" && OBJECT_REF.test(node)
      ? objectNode(objects[`obj:${node}`])
      : node;
  const perms = deref(catalogNode["/Perms"]);
  const usageRightRefs = new Set<string>();
  let usageRights = false;
  if (isDict(perms)) {
    for (const key of ["/UR", "/UR3"]) {
      const target = perms[key];
      if (target !== undefined && target !== null) usageRights = true;
      if (typeof target === "string" && OBJECT_REF.test(target)) {
        usageRightRefs.add(`obj:${target}`);
      }
    }
  }
  const acroformDict = deref(catalogNode["/AcroForm"]);
  const xfa = isDict(acroformDict) && "/XFA" in acroformDict;
  const needsRendering =
    raw.acroform?.needappearances === true ||
    (isDict(acroformDict) && acroformDict["/NeedAppearances"] === true);

  let signed = isDict(perms) && "/DocMDP" in perms;
  for (const key of Object.keys(objects)) {
    if (!key.startsWith("obj:")) continue;
    const node = objectNode(objects[key]);
    if (!isDict(node)) continue;
    // A signature value dictionary is a held signature wherever it sits,
    // except the usage-rights entries referenced from /Perms.
    if (!usageRightRefs.has(key) && ("/ByteRange" in node || node["/Type"] === "/Sig")) {
      signed = true;
    }
    if (node["/FT"] === "/Sig" && node["/V"] !== undefined && node["/V"] !== null) {
      signed = true;
    }
  }

  const compatWarnings: CompatWarningKind[] = [];
  if (raw.acroform?.hasacroform === true || (raw.acroform?.fields?.length ?? 0) > 0) {
    compatWarnings.push("forms");
  }
  if ((raw.outlines?.length ?? 0) > 0) compatWarnings.push("bookmarks");
  const objectsText = JSON.stringify(objects);
  if (/\/StructTreeRoot\b/.test(objectsText) || /\/MarkInfo\b/.test(objectsText)) {
    compatWarnings.push("tags");
  }
  if ((raw.pagelabels?.length ?? 0) > 0) compatWarnings.push("page-labels");

  return {
    encrypted: raw.encrypt?.encrypted === true,
    signed,
    xfa,
    usageRights,
    needsRendering,
    activeContent: [...walk.findings.values()],
    compatWarnings
  };
}

/**
 * Probe an input qpdf failed to open: --is-encrypted exits 0 when the file
 * carries an /Encrypt dictionary (meaning it needed a password the caller
 * did not supply) and 2 when it does not. The decision reads the exit code,
 * never the wording of qpdf's stderr (KTD10).
 */
async function probeIsEncrypted(
  sourcePath: string,
  run: NativeRunner,
  options: NativeCallOptions
): Promise<boolean> {
  try {
    const probe = await run(
      "qpdf",
      ["--is-encrypted", "--", sourcePath],
      childOptions(options, { allowedExitCodes: [0, 2] })
    );
    return probe.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Read-only inspection of one source PDF via `qpdf --json`.
 * Exit code 3 (warnings) still yields an inspection plus warnings; qpdf
 * warnings that prevent complete inspection are fatal.
 */
export async function inspectPdfSource(
  sourcePath: string,
  options: NativeCallOptions = {}
): Promise<PdfInspection> {
  const run = options.run ?? defaultNativeRunner;
  const qpdfVersion = await getQpdfVersion(options);
  assertNativeFloor("qpdf", qpdfVersion, QPDF_SECURITY_FLOOR);

  let result: ProcessResult;
  try {
    result = await run("qpdf", ["--json", "--", sourcePath], childOptions(options, { allowedExitCodes: [0, 3] }));
  } catch (error) {
    if (error instanceof CompressionError && error.code === "ENGINE_FAILED") {
      const stderr = String((error.details?.["stderr"] as string | undefined) ?? "");
      if (await probeIsEncrypted(sourcePath, run, options)) {
        throw new CompressionError("INPUT_ENCRYPTED", `Source PDF is encrypted: ${sourcePath}.`, {
          inputPath: sourcePath
        });
      }
      // qpdf warnings that prevent complete inspection are fatal: the file
      // cannot be trusted as an assembly input.
      throw new CompressionError(
        "INSPECTION_INCOMPLETE",
        `qpdf could not inspect ${sourcePath}; treating inspection as incomplete.`,
        { inputPath: sourcePath, stderr: stderr.slice(0, 500) }
      );
    }
    throw error;
  }

  let parsed: QpdfJson;
  try {
    parsed = JSON.parse(result.stdout) as QpdfJson;
  } catch {
    throw new CompressionError(
      "INSPECTION_INCOMPLETE",
      `qpdf inspection of ${sourcePath} did not produce complete JSON output.`,
      { inputPath: sourcePath, stderr: result.stderr.slice(0, 500) }
    );
  }
  if (!Array.isArray(parsed.pages)) {
    throw new CompressionError(
      "INSPECTION_INCOMPLETE",
      `qpdf inspection of ${sourcePath} did not report any pages.`,
      { inputPath: sourcePath }
    );
  }
  const classified = classifyQpdfJson(parsed);
  const { signed, xfa, usageRights, needsRendering, activeContent, compatWarnings } = classified;
  return {
    path: sourcePath,
    pageCount: parsed.pages.length,
    pdfVersion: parsed.qpdf?.[0]?.pdfversion ?? "unknown",
    qpdfVersion,
    // Reported, not refused here: the streaming scan refuses encrypted input
    // on every other path before qpdf runs, the fill path decrypts first, and
    // the artifact gate below refuses an encrypted produced file.
    encrypted: classified.encrypted,
    signed,
    xfa,
    usageRights,
    needsRendering,
    activeContent,
    compatWarnings,
    warnings: result.stderr ? [result.stderr] : []
  };
}

export interface FillAdmission {
  /** Decrypted working copy inside the job workspace; the fill writes against it. */
  workingPath: string;
  /** The unmodified inspector's result for the decrypted working copy. */
  inspection: PdfInspection;
  /**
   * The source carried an /Encrypt dictionary, so the delivered file loses
   * the printing, copying and modification restrictions its author set: an
   * empty user password includes every owner-password-only document
   * (KTD10, KD6). Reported, never implied.
   */
  removedRestrictions: boolean;
  /** The source carried a usage-rights signature that filling removes. */
  removedUsageRights: boolean;
}

/**
 * Fill-path admission (KTD10): the only path that tolerates encrypted input.
 * The cheap streaming scan runs first; it is the only check that runs
 * before qpdf's decryption code touches attacker-controlled bytes in a
 * process that is not sandboxed. Then an empty-password decryption pass
 * writes the working copy, and the completely unmodified inspector runs on
 * it. A document that still refuses to decrypt is probed by qpdf's exit
 * code, never by matching words in tool output: still encrypted means it
 * needs a real password and is refused like everywhere else; anything else
 * is an incomplete inspection.
 */
export async function admitFillSource(
  sourcePath: string,
  workspacePath: string,
  options: NativeCallOptions = {}
): Promise<FillAdmission> {
  const run = options.run ?? defaultNativeRunner;
  const scan = await validatePdfFillInput(sourcePath);
  const workingPath = join(workspacePath, "decrypted-source.pdf");
  try {
    await run(
      "qpdf",
      ["--decrypt", "--password=", "--", sourcePath, workingPath],
      childOptions(options, { allowedExitCodes: [0, 3] })
    );
  } catch (error) {
    await unlink(workingPath).catch(() => undefined);
    if (!(error instanceof CompressionError) || error.code !== "ENGINE_FAILED") throw error;
    if (await probeIsEncrypted(sourcePath, run, options)) {
      throw new CompressionError("INPUT_ENCRYPTED", `Source PDF needs a password: ${sourcePath}.`, {
        inputPath: sourcePath
      });
    }
    throw new CompressionError(
      "INSPECTION_INCOMPLETE",
      `qpdf could not decrypt ${sourcePath}; treating inspection as incomplete.`,
      { inputPath: sourcePath }
    );
  }
  // The working copy holds the document's personal data: owner-readable only (R29).
  await chmod(workingPath, 0o600);

  try {
    const inspection = await inspectPdfSource(workingPath, options);
    if (inspection.signed) {
      throw new CompressionError("INPUT_SIGNED", "Source PDF carries a digital signature.", {
        inputPath: sourcePath
      });
    }
    if (inspection.xfa) {
      throw new CompressionError(
        "INPUT_XFA",
        "Source PDF uses XFA forms; filling cannot preserve the XFA representation, so every XFA document is refused.",
        { inputPath: sourcePath, xfa: true }
      );
    }
    if (!isAdmissibleFor(inspection, "fill")) {
      throw new CompressionError(
        "INPUT_HAS_ACTIVE_CONTENT",
        `Source PDF contains blocked active content (${inspection.activeContent.join(", ")}).`,
        { inputPath: sourcePath, activeContent: inspection.activeContent }
      );
    }
    return {
      workingPath,
      inspection: { ...inspection, path: sourcePath },
      removedRestrictions: scan.encrypted,
      removedUsageRights: inspection.usageRights
    };
  } catch (error) {
    await unlink(workingPath).catch(() => undefined);
    throw error;
  }
}

export interface PageGroup {
  /** Absolute source path (passed as --file=<path>, safe for leading dashes). */
  path: string;
  /** qpdf page range, e.g. "3" or "1,4,6". */
  range: string;
}

export interface AssemblyMutation {
  /** Null primary path selects --empty (multi-source assembly is a new document). */
  primaryPath: string | null;
  groups: PageGroup[];
  /** Output-position page ranges per relative rotation, e.g. { 90: ["1,3"] }. */
  rotations: Partial<Record<90 | 180 | 270, string[]>>;
  candidatePath: string;
}

/**
 * Run exactly one qpdf page-selection mutation with structural optimization.
 * Relative rotations are addressed against output page positions.
 */
export async function runQpdfAssemblyMutation(
  mutation: AssemblyMutation,
  options: NativeCallOptions = {}
): Promise<string[]> {
  const run = options.run ?? defaultNativeRunner;
  const args: string[] = [];
  if (mutation.primaryPath === null) {
    args.push("--empty");
  } else {
    args.push("--", mutation.primaryPath);
  }
  args.push("--pages");
  for (const group of mutation.groups) {
    args.push(`--file=${group.path}`, `--range=${group.range}`);
  }
  args.push("--");
  for (const angle of [90, 180, 270] as const) {
    const ranges = mutation.rotations[angle];
    if (ranges && ranges.length > 0) {
      args.push(`--rotate=+${angle}:${ranges.join(",")}`);
    }
  }
  args.push(
    "--object-streams=generate",
    "--compress-streams=y",
    "--recompress-flate",
    "--",
    mutation.candidatePath
  );
  const result = await run("qpdf", args, childOptions(options, { allowedExitCodes: [0, 3] }));
  return result.stderr ? [result.stderr] : [];
}

/**
 * Validate a candidate or final artifact: `qpdf --check` must pass and a
 * fresh `--json` inspection must report the expected page count with no
 * blocked content. Returns the final inspection.
 */
export async function validatePdfArtifact(
  candidatePath: string,
  expectedPages: number,
  options: NativeCallOptions = {}
): Promise<PdfInspection> {
  const run = options.run ?? defaultNativeRunner;
  await run("qpdf", ["--check", "--", candidatePath], childOptions(options, { allowedExitCodes: [0, 3] }));
  const inspection = await inspectPdfSource(candidatePath, options);
  if (inspection.pageCount !== expectedPages) {
    throw new CompressionError(
      "OUTPUT_INVALID",
      `Final PDF has ${inspection.pageCount} pages but the manifest describes ${expectedPages}.`,
      { outputPath: candidatePath, pageCount: inspection.pageCount, expectedPages }
    );
  }
  if (inspection.encrypted) {
    throw new CompressionError("OUTPUT_INVALID", "Final PDF reports encryption.", {
      outputPath: candidatePath
    });
  }
  if (inspection.signed || inspection.xfa || inspection.activeContent.length > 0) {
    throw new CompressionError(
      "OUTPUT_INVALID",
      "Final PDF contains blocked signatures, XFA or active content.",
      {
        outputPath: candidatePath,
        signed: inspection.signed,
        xfa: inspection.xfa,
        activeContent: inspection.activeContent
      }
    );
  }
  return inspection;
}

/**
 * Publish a staged file beside the destination without clobbering: an
 * atomic hard link fails with EEXIST when the destination appeared during
 * export. Staging beside the destination keeps both on one filesystem so
 * EXDEV cannot silently downgrade the guarantee; anything else fails closed.
 */
export async function publishNoClobber(stagingPath: string, destinationPath: string): Promise<void> {
  try {
    await link(stagingPath, destinationPath);
  } catch (error) {
    await unlink(stagingPath).catch(() => undefined);
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      throw new CompressionError(
        "OUTPUT_EXISTS",
        "Destination was created while the export was running; nothing was overwritten.",
        { outputPath: destinationPath }
      );
    }
    throw new CompressionError("PUBLISH_FAILED", `Could not publish ${destinationPath} without clobbering.`, {
      outputPath: destinationPath
    });
  }
  await unlink(stagingPath).catch(() => undefined);
}
