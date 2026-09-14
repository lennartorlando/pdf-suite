/**
 * The `forms` command family (U4): the agent-facing surface of the fill loop.
 *
 * `fields` inventories a form, `validate` checks a plan against the document
 * and re-emits the outstanding entries (KTD8), `apply` runs the approved plan
 * through the core fill operation, `verify` reads the delivered artifact back
 * independently of the writer (R12), and `clean` removes the plan, its receipt
 * and its audit record (R29). `burn-in` flattens an already-filled interactive
 * artifact so its values become page content (R36); it writes no new values
 * and sits outside the approval gate.
 *
 * The approval gate (KTD7, KD2): values reach a document only through a plan
 * file the person approved. `apply` snapshots the plan and the source into a
 * private workspace and digests those exact bytes; a supplied receipt must
 * bind both digests, the plan nonce and a live expiry. Without a receipt the
 * command mints one on an interactive terminal after rendering every approved
 * value — and refuses outright in a non-interactive context. The nonce is
 * claimed in a fixed per-user ledger before the write begins, as one atomic
 * exclusive create, so two concurrent applies cannot both pass. No command
 * option may change what is written or where: destination, overwrite and
 * burn-in live inside the approved plan (R9).
 *
 * Signature placements are refused on validate and apply (KD4, R6): the CLI
 * is the agent's path, and a signature that arrives through a plan file was
 * not placed by the person.
 */
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  CompressionError,
  burnInForm,
  checkFormPlan,
  createTempWorkspace,
  fillForm,
  getQpdfVersion,
  inventoryFormFields,
  isCompressionError,
  verifyFormFill,
  FILL_MAX_PLAN_BYTES,
  FILL_MAX_SOURCE_BYTES,
  type BurnInSummary,
  type FillSummary,
  type FormInventoryResult,
  type FormPlanCheck,
  type FormVerification,
  type NativeRunner
} from "@pdf-compressor/core";
import {
  FormPlanError,
  isTerminalEntryStatus,
  parseFormPlan,
  type FormPlan,
  type FormPlanFieldEntry,
  type FormPlanPlacement
} from "@pdf-compressor/core/form-plan";
import type { FormFieldEntry, FormInventory } from "@pdf-compressor/core/form-inventory";
import {
  exitCodeFor,
  exitCodes,
  formatJsonError,
  formatJsonSuccess,
  usageErrorResult,
  type CliResult
} from "../output.js";

export const FORM_RECEIPT_VERSION = 1 as const;
/** Receipts are single-use and time-bounded (R30). */
export const RECEIPT_WINDOW_MS = 30 * 60 * 1000;
const RECEIPT_MAX_BYTES = 16 * 1024;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
/** Same printable-ASCII bound the plan schema applies to the nonce. */
const NONCE_PATTERN = /^[\x21-\x7E]+$/;
const RECEIPT_CHANNELS = ["terminal", "browser"] as const;

export type ReceiptChannel = (typeof RECEIPT_CHANNELS)[number];

/**
 * The approval receipt (KTD7): tamper-evident, not tamper-proof. It binds the
 * plan nonce and the digests of the exact plan and source bytes the command
 * will read, the approval channel, and a bounded expiry. It carries no secret.
 */
export interface FormReceipt {
  readonly version: typeof FORM_RECEIPT_VERSION;
  readonly receiptId: string;
  readonly nonce: string;
  readonly planDigest: string;
  readonly sourceDigest: string;
  readonly channel: ReceiptChannel;
  readonly mintedAt: string;
  readonly expiresAt: string;
}

/** The audit record written beside the plan after the nonce is claimed (KTD7, R29). */
interface FormAuditRecord {
  readonly version: 1;
  readonly receiptId: string;
  readonly nonce: string;
  readonly channel: ReceiptChannel;
  readonly planDigest: string;
  readonly sourceDigest: string;
  readonly destination: string;
  readonly qpdfPath: string | null;
  readonly qpdfVersion: string | null;
  readonly appliedAt: string;
  readonly outcome:
    | {
        readonly status: "applied";
        readonly outputPath: string;
        readonly outputBytes: number;
        readonly burnedIn: boolean;
        readonly fieldsWritten: number;
        readonly placementsWritten: number;
      }
    | { readonly status: "failed"; readonly code: string };
}

export interface FormsCommandDeps {
  run?: NativeRunner;
  signal?: AbortSignal;
  /** Ledger directory override; defaults to the fixed per-user location (KTD7). */
  ledgerDir?: string;
  /** Parent for the private snapshot/readback workspaces. */
  workspaceParent?: string;
  /** Whether an interactive person is at the terminal; defaults to TTY detection. */
  isInteractive?: boolean;
  /** Renders the approval and returns the person's decision; defaults to a stderr prompt. */
  confirmApproval?: (display: string) => Promise<boolean>;
}

interface FieldsOptions {
  sourcePath: string;
  json: boolean;
  revealValues: boolean;
}

interface ValidateOptions {
  planPath: string;
  json: boolean;
  revealValues: boolean;
}

interface ApplyOptions {
  planPath: string;
  receiptPath?: string;
  json: boolean;
}

interface VerifyOptions {
  outputPath: string;
  planPath: string;
  json: boolean;
  revealValues: boolean;
}

interface CleanOptions {
  planPath: string;
  receiptPath?: string;
  auditPath?: string;
  json: boolean;
}

interface BurnInOptions {
  sourcePath: string;
  outputPath: string;
  overwrite: boolean;
  json: boolean;
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/* ------------------------------------------------------------------ */
/* Argument parsers — pure, like the other commands' parsers.          */
/* ------------------------------------------------------------------ */

export function parseFieldsArgs(args: string[]): FieldsOptions {
  let sourcePath: string | undefined;
  let json = false;
  let revealValues = false;
  for (const token of args) {
    if (token === "--json") json = true;
    else if (token === "--reveal-values") revealValues = true;
    else if (token.startsWith("-")) throw new Error(`Unknown option: ${token}`);
    else if (sourcePath === undefined) sourcePath = token;
    else throw new Error(`Unexpected positional argument: ${token}`);
  }
  if (!sourcePath) throw new Error("Missing source path.");
  return { sourcePath, json, revealValues };
}

export function parseValidateArgs(args: string[]): ValidateOptions {
  let planPath: string | undefined;
  let json = false;
  let revealValues = false;
  for (const token of args) {
    if (token === "--json") json = true;
    else if (token === "--reveal-values") revealValues = true;
    else if (token.startsWith("-")) throw new Error(`Unknown option: ${token}`);
    else if (planPath === undefined) planPath = token;
    else throw new Error(`Unexpected positional argument: ${token}`);
  }
  if (!planPath) throw new Error("Missing plan path.");
  return { planPath, json, revealValues };
}

/**
 * The apply contract (R9): a plan path and, optionally, a receipt path. There
 * is deliberately no option that can influence what is written or where — the
 * destination, the overwrite decision, the burn-in decision and every value
 * live inside the approved plan.
 */
export function parseApplyArgs(args: string[]): ApplyOptions {
  let planPath: string | undefined;
  let receiptPath: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--json") {
      json = true;
    } else if (token === "--receipt") {
      const value = args[++index];
      if (!value) throw new Error("Missing value for --receipt.");
      receiptPath = value;
    } else if (token.startsWith("--receipt=")) {
      receiptPath = token.slice("--receipt=".length);
      if (!receiptPath) throw new Error("Missing value for --receipt.");
    } else if (token.startsWith("-")) {
      throw new Error(`Unknown option: ${token}`);
    } else if (planPath === undefined) {
      planPath = token;
    } else {
      throw new Error(`Unexpected positional argument: ${token}`);
    }
  }
  if (!planPath) throw new Error("Missing plan path.");
  return { planPath, ...(receiptPath !== undefined ? { receiptPath } : {}), json };
}

export function parseVerifyArgs(args: string[]): VerifyOptions {
  let outputPath: string | undefined;
  let planPath: string | undefined;
  let json = false;
  let revealValues = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--json") {
      json = true;
    } else if (token === "--reveal-values") {
      revealValues = true;
    } else if (token === "--plan") {
      const value = args[++index];
      if (!value) throw new Error("Missing value for --plan.");
      planPath = value;
    } else if (token.startsWith("--plan=")) {
      planPath = token.slice("--plan=".length);
      if (!planPath) throw new Error("Missing value for --plan.");
    } else if (token.startsWith("-")) {
      throw new Error(`Unknown option: ${token}`);
    } else if (outputPath === undefined) {
      outputPath = token;
    } else {
      throw new Error(`Unexpected positional argument: ${token}`);
    }
  }
  if (!outputPath) throw new Error("Missing output path.");
  if (!planPath) throw new Error("Missing --plan path.");
  return { outputPath, planPath, json, revealValues };
}

export function parseCleanArgs(args: string[]): CleanOptions {
  let planPath: string | undefined;
  let receiptPath: string | undefined;
  let auditPath: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--json") {
      json = true;
    } else if (token === "--receipt") {
      const value = args[++index];
      if (!value) throw new Error("Missing value for --receipt.");
      receiptPath = value;
    } else if (token.startsWith("--receipt=")) {
      receiptPath = token.slice("--receipt=".length);
      if (!receiptPath) throw new Error("Missing value for --receipt.");
    } else if (token === "--audit") {
      const value = args[++index];
      if (!value) throw new Error("Missing value for --audit.");
      auditPath = value;
    } else if (token.startsWith("--audit=")) {
      auditPath = token.slice("--audit=".length);
      if (!auditPath) throw new Error("Missing value for --audit.");
    } else if (token.startsWith("-")) {
      throw new Error(`Unknown option: ${token}`);
    } else if (planPath === undefined) {
      planPath = token;
    } else {
      throw new Error(`Unexpected positional argument: ${token}`);
    }
  }
  if (!planPath) throw new Error("Missing plan path.");
  return {
    planPath,
    ...(receiptPath !== undefined ? { receiptPath } : {}),
    ...(auditPath !== undefined ? { auditPath } : {}),
    json
  };
}

/**
 * The burn-in contract (R36): a filled interactive artifact and a
 * destination. Unlike apply, the output path is an option — there is no
 * approved plan to derive it from.
 */
export function parseBurnInArgs(args: string[]): BurnInOptions {
  let sourcePath: string | undefined;
  let outputPath: string | undefined;
  let overwrite = false;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--json") {
      json = true;
    } else if (token === "--overwrite") {
      overwrite = true;
    } else if (token === "--output" || token === "-o") {
      const value = args[++index];
      if (!value) throw new Error("Missing value for --output.");
      outputPath = value;
    } else if (token.startsWith("--output=")) {
      outputPath = token.slice("--output=".length);
      if (!outputPath) throw new Error("Missing value for --output.");
    } else if (token.startsWith("-")) {
      throw new Error(`Unknown option: ${token}`);
    } else if (sourcePath === undefined) {
      sourcePath = token;
    } else {
      throw new Error(`Unexpected positional argument: ${token}`);
    }
  }
  if (!sourcePath) throw new Error("Missing source path.");
  if (!outputPath) throw new Error("Missing --output path.");
  return { sourcePath, outputPath, overwrite, json };
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

function usageFailure(args: string[], error: unknown, usageText: string): CliResult {
  if (args.includes("--json")) return usageErrorResult(error);
  const message = error instanceof Error ? error.message : "Invalid arguments";
  return { exitCode: exitCodes.usage, stdout: "", stderr: `${message}\n${usageText}` };
}

function failure(json: boolean, error: unknown): CliResult {
  const message = error instanceof Error ? error.message : "Operation failed";
  if (json) return { exitCode: exitCodeFor(error), stdout: formatJsonError(error), stderr: "" };
  return { exitCode: exitCodeFor(error), stdout: "", stderr: `${message}\n` };
}

/** Read a plan file's exact bytes and parse the closed schema. */
async function readPlanFile(planPath: string): Promise<{ plan: FormPlan; bytes: Buffer }> {
  let bytes: Buffer;
  try {
    const info = await stat(planPath);
    if (!info.isFile() || info.size > FILL_MAX_PLAN_BYTES) {
      throw new FormPlanError("PLAN_LIMIT_EXCEEDED", `Plan file exceeds the ${FILL_MAX_PLAN_BYTES} byte bound.`);
    }
    bytes = await readFile(planPath);
  } catch (error) {
    if (error instanceof FormPlanError) throw error;
    throw new CompressionError("INPUT_NOT_FOUND", `Plan file was not found: ${planPath}.`, {
      inputPath: planPath
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new FormPlanError("PLAN_INVALID", "Plan file is not valid JSON.");
  }
  return { plan: parseFormPlan(parsed), bytes };
}

/**
 * KD4/R6, made enforceable: a signature placement arriving through a plan file
 * was not placed by the person, so validate and apply both refuse it outright.
 */
function assertNoSignaturePlacements(plan: FormPlan): void {
  const signature = plan.entries.find((entry) => entry.kind === "signature");
  if (signature) {
    throw new CompressionError(
      "FILL_SIGNATURE_FORBIDDEN",
      "The plan carries a signature placement; signing is reserved to the person in the browser.",
      { page: signature.page }
    );
  }
}

/** Apply refuses a plan the interview left unfinished (KTD8). */
function assertPlanTerminal(plan: FormPlan): void {
  for (const entry of plan.entries) {
    if (entry.kind === "field" && !isTerminalEntryStatus(entry.status)) {
      throw new CompressionError(
        "FILL_PLAN_INCOMPLETE",
        `Plan entry for field "${entry.fieldId}" is ${entry.status}; apply requires answered or skipped.`,
        { fieldId: entry.fieldId, status: entry.status }
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* Receipt: closed schema, binding checks, minting                      */
/* ------------------------------------------------------------------ */

const RECEIPT_KEYS: readonly string[] = [
  "version",
  "receiptId",
  "nonce",
  "planDigest",
  "sourceDigest",
  "channel",
  "mintedAt",
  "expiresAt"
];

function receiptInvalid(message: string): CompressionError {
  return new CompressionError("FILL_RECEIPT_INVALID", message);
}

/** Closed-schema parse of a receipt transport value. */
function parseFormReceipt(value: unknown): FormReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw receiptInvalid("Receipt must be an object.");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== RECEIPT_KEYS.length || keys.some((key) => !RECEIPT_KEYS.includes(key))) {
    throw receiptInvalid(`Receipt must be exactly { ${RECEIPT_KEYS.join(", ")} }.`);
  }
  if (record["version"] !== FORM_RECEIPT_VERSION) {
    throw receiptInvalid(`Receipt version must be ${FORM_RECEIPT_VERSION}.`);
  }
  const nonce = record["nonce"];
  if (typeof nonce !== "string" || nonce.length === 0 || nonce.length > 128 || !NONCE_PATTERN.test(nonce)) {
    throw receiptInvalid("Receipt nonce must be 1-128 printable ASCII characters.");
  }
  for (const key of ["receiptId", "planDigest", "sourceDigest", "channel", "mintedAt", "expiresAt"] as const) {
    if (typeof record[key] !== "string" || (record[key] as string).length === 0) {
      throw receiptInvalid(`Receipt ${key} must be a non-empty string.`);
    }
  }
  const planDigest = record["planDigest"] as string;
  const sourceDigest = record["sourceDigest"] as string;
  if (!DIGEST_PATTERN.test(planDigest) || !DIGEST_PATTERN.test(sourceDigest)) {
    throw receiptInvalid("Receipt digests must be lowercase sha256 hex.");
  }
  const channel = record["channel"] as string;
  if (!(RECEIPT_CHANNELS as readonly string[]).includes(channel)) {
    throw receiptInvalid(`Receipt channel must be one of ${RECEIPT_CHANNELS.join(", ")}.`);
  }
  const mintedAt = record["mintedAt"] as string;
  const expiresAt = record["expiresAt"] as string;
  if (!Number.isFinite(Date.parse(mintedAt)) || !Number.isFinite(Date.parse(expiresAt))) {
    throw receiptInvalid("Receipt timestamps must be ISO 8601.");
  }
  return {
    version: FORM_RECEIPT_VERSION,
    receiptId: record["receiptId"] as string,
    nonce,
    planDigest,
    sourceDigest,
    channel: channel as ReceiptChannel,
    mintedAt,
    expiresAt
  };
}

async function readReceiptFile(receiptPath: string): Promise<FormReceipt> {
  let raw: Buffer;
  try {
    const info = await stat(receiptPath);
    if (!info.isFile() || info.size > RECEIPT_MAX_BYTES) {
      throw receiptInvalid("Receipt file exceeds its byte bound.");
    }
    raw = await readFile(receiptPath);
  } catch (error) {
    if (isCompressionError(error)) throw error;
    throw receiptInvalid(`Receipt file was not found: ${receiptPath}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw receiptInvalid("Receipt file is not valid JSON.");
  }
  return parseFormReceipt(parsed);
}

/** Mint a receipt binding the exact plan and source bytes (KTD7, R30). */
export function mintFormReceipt(
  nonce: string,
  planDigest: string,
  sourceDigest: string,
  channel: ReceiptChannel,
  minted = new Date()
): FormReceipt {
  return {
    version: FORM_RECEIPT_VERSION,
    receiptId: randomUUID(),
    nonce,
    planDigest,
    sourceDigest,
    channel,
    mintedAt: minted.toISOString(),
    expiresAt: new Date(minted.getTime() + RECEIPT_WINDOW_MS).toISOString()
  };
}

/**
 * The receipt must bind the exact bytes that will be read: the snapshot
 * digests, the plan nonce and a live expiry. Every mismatch refuses with its
 * own code so the failure explains which bound was broken.
 */
function assertReceiptBinds(
  receipt: FormReceipt,
  plan: FormPlan,
  planDigest: string,
  sourceDigest: string
): void {
  if (receipt.nonce !== plan.nonce) {
    throw new CompressionError("FILL_RECEIPT_INVALID", "The receipt's nonce does not match the plan.");
  }
  if (Date.now() >= Date.parse(receipt.expiresAt)) {
    throw new CompressionError("FILL_RECEIPT_EXPIRED", "The approval receipt has expired; approve the plan again.");
  }
  if (receipt.planDigest !== planDigest) {
    throw new CompressionError(
      "FILL_PLAN_CHANGED",
      "The plan changed after approval; approve the current plan again."
    );
  }
  if (receipt.sourceDigest !== sourceDigest) {
    throw new CompressionError(
      "FILL_SOURCE_CHANGED",
      "The source document changed after approval; approve the plan again."
    );
  }
}

/* ------------------------------------------------------------------ */
/* Ledger: the fixed per-user nonce store (KTD7, trap 4)                */
/* ------------------------------------------------------------------ */

/**
 * The consumption ledger lives at a fixed per-user location, outside the
 * agent's working directory, so deleting the output or the plan directory can
 * never make a nonce reusable.
 */
export function defaultLedgerDir(): string {
  return join(homedir(), ".pdf-compressor", "fill-ledger");
}

/**
 * Claim the nonce as one atomic cross-process operation: an exclusive create
 * that fails with EEXIST when another apply already claimed it — never a
 * read-then-write check both callers could pass.
 */
async function claimNonce(
  ledgerDir: string,
  receipt: FormReceipt,
  planDigest: string,
  sourceDigest: string
): Promise<void> {
  await mkdir(ledgerDir, { recursive: true, mode: 0o700 });
  const claimPath = join(ledgerDir, `${sha256(receipt.nonce)}.json`);
  const claim = {
    version: 1,
    nonce: receipt.nonce,
    receiptId: receipt.receiptId,
    planDigest,
    sourceDigest,
    channel: receipt.channel,
    claimedAt: new Date().toISOString()
  };
  try {
    await writeFile(claimPath, `${JSON.stringify(claim)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      throw new CompressionError(
        "FILL_RECEIPT_CONSUMED",
        "The approval for this plan was already consumed; approve the plan again."
      );
    }
    throw new CompressionError(
      "ENGINE_FAILED",
      "The approval claim could not be recorded; refusing to apply without it."
    );
  }
}

/* ------------------------------------------------------------------ */
/* Interactive approval rendering (the security control, trap 5)        */
/* ------------------------------------------------------------------ */

/** Best-effort resolved real path for the approval display. */
async function resolvedRealPath(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch {
    try {
      return join(await realpath(dirname(absolute)), basename(absolute));
    } catch {
      return absolute;
    }
  }
}

/**
 * Render exactly what the person approves: every value verbatim, the resolved
 * real destination, the overwrite and burn-in decisions, and the entry count.
 * Document-derived labels are marked as such; nothing agent-supplied appears
 * outside the values being approved.
 */
function renderApprovalDisplay(plan: FormPlan, check: FormPlanCheck, resolvedDestination: string): string {
  const byId = new Map(check.inventory.fields.map((field) => [field.fieldId, field]));
  const labelFor = (fieldId: string): string => {
    const label = byId.get(fieldId)?.label;
    return label ? `${label.text.text} [from document ${label.source}]` : fieldId;
  };
  const answered = plan.entries.filter(
    (entry): entry is FormPlanFieldEntry & { status: "answered" } =>
      entry.kind === "field" && entry.status === "answered"
  );
  const skipped = plan.entries.filter((entry) => entry.kind === "field" && entry.status === "skipped");
  const placements = plan.entries.filter((entry): entry is FormPlanPlacement => entry.kind !== "field");
  const lines = [
    "Approve this fill:",
    `  source:      ${plan.source}`,
    `  destination: ${resolvedDestination}`,
    `  entries:     ${plan.entries.length} (${answered.length} answered, ${skipped.length} skipped, ${placements.length} placements)`,
    `  overwrite:   ${plan.overwrite ? "yes — an existing destination will be replaced" : "no — an existing destination refuses the write"}`,
    `  burn-in:     ${plan.burnIn ? "yes — values become page content" : "no — fields stay editable"}`,
    ""
  ];
  for (const entry of answered) {
    lines.push(`  ${labelFor(entry.fieldId)}: ${entry.value === "" ? "(empty — field cleared)" : entry.value}`);
  }
  for (const entry of skipped) {
    if (entry.kind === "field") lines.push(`  ${labelFor(entry.fieldId)}: (skipped — left unchanged)`);
  }
  for (const entry of placements) {
    const at = `page ${entry.page} at [${entry.rect.x} ${entry.rect.y} ${entry.rect.width} ${entry.rect.height}]`;
    lines.push(entry.kind === "text" ? `  text placement ${at}: ${entry.text}` : `  ${entry.kind} placement ${at}`);
  }
  return lines.join("\n");
}

async function defaultConfirmApproval(display: string): Promise<boolean> {
  process.stderr.write(`${display}\n`);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question('Type "apply" to approve and write the document: ');
    return answer.trim() === "apply";
  } finally {
    rl.close();
  }
}

/* ------------------------------------------------------------------ */
/* Audit record (KTD7, R29)                                            */
/* ------------------------------------------------------------------ */

/** Best-effort PATH resolution of the qpdf binary the operation used. */
async function resolveExecutable(name: string): Promise<string | null> {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      continue;
    }
  }
  return null;
}

function auditPathFor(planPath: string): string {
  return `${planPath}.audit.json`;
}

function receiptPathFor(planPath: string): string {
  return `${planPath}.receipt.json`;
}

async function writeAuditRecord(
  planPath: string,
  record: Omit<FormAuditRecord, "version" | "appliedAt">
): Promise<string> {
  const auditPath = auditPathFor(planPath);
  const audit: FormAuditRecord = { version: 1, ...record, appliedAt: new Date().toISOString() };
  await writeFile(auditPath, `${JSON.stringify(audit, null, 2)}\n`, { mode: 0o600 });
  return auditPath;
}

/* ------------------------------------------------------------------ */
/* Value redaction (R13, trap 6)                                       */
/* ------------------------------------------------------------------ */

/** Digest a field's current value unless the caller explicitly asked for it. */
function redactInventory(inventory: FormInventory, revealValues: boolean): object {
  if (revealValues) return inventory;
  return {
    version: inventory.version,
    fields: inventory.fields.map((field: FormFieldEntry) => {
      if (field.currentValue === undefined) return field;
      const { currentValue: _currentValue, ...rest } = field;
      return { ...rest, currentValueDigest: sha256(field.currentValue) };
    })
  };
}

function redactPlanEntries(plan: FormPlan, revealValues: boolean): object[] {
  return plan.entries.map((entry) => {
    if (entry.kind === "field") {
      const base = { kind: entry.kind, fieldId: entry.fieldId, status: entry.status };
      if (entry.status !== "answered" && entry.status !== "proposed") return base;
      return revealValues ? { ...base, value: entry.value } : { ...base, valueDigest: sha256(entry.value) };
    }
    const base = { kind: entry.kind, page: entry.page, rect: entry.rect };
    if (entry.kind === "text") {
      return revealValues ? { ...base, text: entry.text } : { ...base, textDigest: sha256(entry.text) };
    }
    return base;
  });
}

function redactVerification(verification: FormVerification, revealValues: boolean): object[] {
  return verification.fields.map((field) => {
    const base = {
      fieldId: field.fieldId,
      status: field.status,
      applied: field.applied,
      ...(field.detail !== undefined ? { detail: field.detail } : {})
    };
    if (revealValues) {
      return {
        ...base,
        expected: field.expected,
        ...(field.actual !== undefined ? { actual: field.actual } : {})
      };
    }
    return {
      ...base,
      expectedDigest: sha256(field.expected),
      ...(field.actual !== undefined ? { actualDigest: sha256(field.actual) } : {})
    };
  });
}

/* ------------------------------------------------------------------ */
/* Subcommands                                                         */
/* ------------------------------------------------------------------ */

async function runFormsFields(args: string[], deps: FormsCommandDeps): Promise<CliResult> {
  let options: FieldsOptions;
  try {
    options = parseFieldsArgs(args);
  } catch (error) {
    return usageFailure(args, error, formsUsage());
  }
  try {
    const sourcePath = resolve(options.sourcePath);
    const result: FormInventoryResult = await inventoryFormFields(sourcePath, {
      run: deps.run,
      signal: deps.signal,
      workspaceParent: deps.workspaceParent
    });
    const payload = {
      status: "success" as const,
      source: sourcePath,
      pageCount: result.pageCount,
      qpdfVersion: result.qpdfVersion,
      removedRestrictions: result.removedRestrictions,
      removedUsageRights: result.removedUsageRights,
      warnings: result.warnings,
      inventory: redactInventory(result.inventory, options.revealValues)
    };
    if (options.json) return { exitCode: 0, stdout: formatJsonSuccess(payload), stderr: "" };
    const lines = result.inventory.fields.map((field) => {
      const label = field.label ? ` "${field.label.text.text}"` : "";
      const pages = [...new Set(field.widgets.map((widget) => widget.page))].join(",");
      return `  ${field.fieldId} ${field.type} page ${pages}${label}`;
    });
    return {
      exitCode: 0,
      stdout: `${result.inventory.fields.length} fields in ${sourcePath}\n${lines.join("\n")}\n`,
      stderr: ""
    };
  } catch (error) {
    return failure(options.json, error);
  }
}

async function runFormsValidate(args: string[], deps: FormsCommandDeps): Promise<CliResult> {
  let options: ValidateOptions;
  try {
    options = parseValidateArgs(args);
  } catch (error) {
    return usageFailure(args, error, formsUsage());
  }
  try {
    const { plan, bytes } = await readPlanFile(options.planPath);
    assertNoSignaturePlacements(plan);
    const sourcePath = resolve(plan.source);
    const check = await checkFormPlan(plan, sourcePath, {
      run: deps.run,
      signal: deps.signal,
      workspaceParent: deps.workspaceParent
    });
    const sourceBytes = await readFile(sourcePath);
    const payload = {
      status: "checked" as const,
      planDigest: sha256(bytes),
      sourceDigest: sha256(sourceBytes),
      source: plan.source,
      destination: await resolvedRealPath(plan.destination),
      overwrite: plan.overwrite,
      burnIn: plan.burnIn,
      nonce: plan.nonce,
      entryCount: plan.entries.length,
      outstanding: check.outstanding,
      entries: redactPlanEntries(plan, options.revealValues),
      placements: check.placements.map((placement) => ({
        kind: placement.kind,
        page: placement.page,
        rect: placement.rect
      })),
      pageCount: check.pageCount,
      qpdfVersion: check.qpdfVersion,
      removedRestrictions: check.removedRestrictions,
      removedUsageRights: check.removedUsageRights,
      warnings: check.warnings
    };
    if (options.json) return { exitCode: 0, stdout: formatJsonSuccess(payload), stderr: "" };
    const lines = [
      `Plan ${options.planPath}: ${plan.entries.length} entries, ${check.outstanding.length} outstanding`,
      ...check.outstanding.map((entry) => `  outstanding: ${entry.fieldId} (${entry.status})`),
      check.outstanding.length === 0 ? "The plan is complete and can be approved for apply." : "Answer or skip the outstanding entries, then validate again."
    ];
    return { exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
  } catch (error) {
    return failure(options.json, error);
  }
}

async function runFormsApply(args: string[], deps: FormsCommandDeps): Promise<CliResult> {
  let options: ApplyOptions;
  try {
    options = parseApplyArgs(args);
  } catch (error) {
    return usageFailure(args, error, formsUsage());
  }

  const workspace = await createTempWorkspace("pdf-fill-apply-", deps.workspaceParent);
  try {
    const { plan, bytes: planBytes } = await readPlanFile(options.planPath);
    assertNoSignaturePlacements(plan);
    assertPlanTerminal(plan);

    // Snapshot the approved bytes; digests are taken over exactly the bytes
    // the write will read, so a swap between approval and read cannot pass.
    const planSnapshot = workspace.file("plan.json");
    const sourceSnapshot = workspace.file("source.pdf");
    await writeFile(planSnapshot, planBytes, { mode: 0o600 });
    let sourceBytes: Buffer;
    try {
      const resolvedSource = resolve(plan.source);
      const info = await stat(resolvedSource);
      if (!info.isFile() || info.size > FILL_MAX_SOURCE_BYTES) {
        throw new CompressionError(
          "FILL_INPUT_TOO_LARGE",
          `Source PDF exceeds the ${FILL_MAX_SOURCE_BYTES} byte fill limit.`,
          { inputPath: resolvedSource, sizeBytes: info.size }
        );
      }
      sourceBytes = await readFile(resolvedSource);
    } catch (error) {
      if (isCompressionError(error)) throw error;
      throw new CompressionError("INPUT_NOT_FOUND", `Source PDF was not found: ${resolve(plan.source)}.`, {
        inputPath: resolve(plan.source)
      });
    }
    await writeFile(sourceSnapshot, sourceBytes, { mode: 0o600 });
    const planDigest = sha256(planBytes);
    const sourceDigest = sha256(sourceBytes);

    // The receipt: supplied by the browser approval flow, or minted here on
    // an interactive terminal after the person has seen every approved value.
    let receipt: FormReceipt;
    let receiptPath = options.receiptPath;
    if (receiptPath === undefined && (await exists(receiptPathFor(options.planPath)))) {
      receiptPath = receiptPathFor(options.planPath);
    }
    if (receiptPath !== undefined) {
      receipt = await readReceiptFile(resolve(receiptPath));
      assertReceiptBinds(receipt, plan, planDigest, sourceDigest);
    } else {
      const interactive = deps.isInteractive ?? (process.stdin.isTTY === true && process.stderr.isTTY === true);
      if (!interactive) {
        throw new CompressionError(
          "FILL_RECEIPT_REQUIRED",
          "Applying a plan needs an approval receipt. Approve interactively on a terminal, or pass --receipt."
        );
      }
      const check = await checkFormPlan(plan, sourceSnapshot, {
        run: deps.run,
        signal: deps.signal,
        workspaceParent: deps.workspaceParent
      });
      const display = renderApprovalDisplay(plan, check, await resolvedRealPath(plan.destination));
      const confirm = deps.confirmApproval ?? defaultConfirmApproval;
      if (!(await confirm(display))) {
        throw new CompressionError("JOB_CANCELLED", "Approval declined; nothing was written.");
      }
      receipt = mintFormReceipt(plan.nonce, planDigest, sourceDigest, "terminal");
      receiptPath = receiptPathFor(options.planPath);
      await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    }

    // The claim is one exclusive create in the fixed per-user ledger, durable
    // before the write begins; a crash costs a re-approval, never a replay.
    await claimNonce(deps.ledgerDir ?? defaultLedgerDir(), receipt, planDigest, sourceDigest);

    let qpdfVersion: string | null = null;
    try {
      qpdfVersion = await getQpdfVersion({ run: deps.run, signal: deps.signal });
    } catch {
      qpdfVersion = null;
    }
    const auditBase = {
      receiptId: receipt.receiptId,
      nonce: plan.nonce,
      channel: receipt.channel,
      planDigest,
      sourceDigest,
      destination: await resolvedRealPath(plan.destination),
      qpdfPath: await resolveExecutable("qpdf"),
      qpdfVersion
    };

    let summary: FillSummary;
    try {
      summary = await fillForm({
        sourcePath: plan.source,
        workingSourcePath: sourceSnapshot,
        planPath: planSnapshot,
        destinationPath: plan.destination,
        signal: deps.signal,
        workspaceParent: deps.workspaceParent,
        run: deps.run
      });
    } catch (error) {
      const code = isCompressionError(error) ? error.code : "ENGINE_FAILED";
      await writeAuditRecord(options.planPath, {
        ...auditBase,
        outcome: { status: "failed", code }
      }).catch(() => undefined);
      throw error;
    }
    const auditPath = await writeAuditRecord(options.planPath, {
      ...auditBase,
      outcome: {
        status: "applied",
        outputPath: summary.outputPath,
        outputBytes: summary.outputBytes,
        burnedIn: summary.burnedIn,
        fieldsWritten: summary.fieldsWritten,
        placementsWritten: summary.placementsWritten
      }
    }).catch(() => null);

    const outputPath = resolve(plan.destination);
    const payload = {
      status: "applied" as const,
      ...summary,
      outputPath,
      ...(receiptPath !== undefined ? { receipt: resolve(receiptPath) } : {}),
      audit: auditPath
    };
    if (options.json) return { exitCode: 0, stdout: formatJsonSuccess(payload), stderr: "" };
    return {
      exitCode: 0,
      stdout: [
        `Applied ${options.planPath} -> ${outputPath} (${summary.outputBytes} bytes)`,
        `Receipt: ${receiptPath ? resolve(receiptPath) : "none"}`,
        `Audit: ${auditPath ?? "unavailable"}`
      ].join("\n") + "\n",
      stderr: summary.warnings.length ? `${summary.warnings.join("\n")}\n` : ""
    };
  } catch (error) {
    return failure(options.json, error);
  } finally {
    await workspace.cleanup();
  }
}

async function runFormsVerify(args: string[], deps: FormsCommandDeps): Promise<CliResult> {
  let options: VerifyOptions;
  try {
    options = parseVerifyArgs(args);
  } catch (error) {
    return usageFailure(args, error, formsUsage());
  }
  try {
    const { plan } = await readPlanFile(options.planPath);
    const outputPath = resolve(options.outputPath);
    if (resolve(plan.destination) !== outputPath) {
      throw new CompressionError(
        "FILL_PLAN_SOURCE_MISMATCH",
        "The artifact being verified is not the plan's approved destination."
      );
    }
    const verification = await verifyFormFill(plan, resolve(plan.source), outputPath, {
      run: deps.run,
      signal: deps.signal,
      workspaceParent: deps.workspaceParent
    });
    const fields = redactVerification(verification, options.revealValues);
    if (!verification.allApplied) {
      const count = verification.fields.filter((field) => !field.applied).length +
        verification.placements.filter((placement) => !placement.applied).length;
      if (options.json) {
        return {
          exitCode: exitCodes.validationFailure,
          stdout: `${JSON.stringify({
            ok: false,
            code: "FILL_VERIFY_MISMATCH",
            message: `${count} approved ${count === 1 ? "entry is" : "entries are"} not present in the delivered file.`,
            fields,
            placements: verification.placements
          })}\n`,
          stderr: ""
        };
      }
      const lines = verification.fields
        .filter((field) => !field.applied)
        .map((field) => `  ${field.fieldId}: not applied`);
      return {
        exitCode: exitCodes.validationFailure,
        stdout: "",
        stderr: `Verification failed for ${outputPath}:\n${lines.join("\n")}\n`
      };
    }
    const payload = {
      status: "verified" as const,
      outputPath,
      fields,
      placements: verification.placements,
      warnings: verification.warnings
    };
    if (options.json) return { exitCode: 0, stdout: formatJsonSuccess(payload), stderr: "" };
    return {
      exitCode: 0,
      stdout: `Verified ${outputPath}: every approved entry is present.\n`,
      stderr: ""
    };
  } catch (error) {
    return failure(options.json, error);
  }
}

async function runFormsClean(args: string[], deps: FormsCommandDeps): Promise<CliResult> {
  let options: CleanOptions;
  try {
    options = parseCleanArgs(args);
  } catch (error) {
    return usageFailure(args, error, formsUsage());
  }
  const targets = [
    resolve(options.planPath),
    resolve(options.receiptPath ?? receiptPathFor(options.planPath)),
    resolve(options.auditPath ?? auditPathFor(options.planPath))
  ];
  const removed: string[] = [];
  const attempted: string[] = [];
  for (const target of targets) {
    try {
      await stat(target);
    } catch {
      // Nothing existed to remove; an absent file is neither removed nor failed.
      continue;
    }
    attempted.push(target);
    try {
      await rm(target, { force: true });
      removed.push(target);
    } catch {
      // A file that cannot be removed is reported, not hidden.
    }
  }
  const failed = attempted.filter((target) => !removed.includes(target));
  if (options.json) {
    return {
      exitCode: 0,
      stdout: formatJsonSuccess({ status: "cleaned", removed, ...(failed.length ? { failed } : {}) }),
      stderr: ""
    };
  }
  return {
    exitCode: 0,
    stdout: `Removed ${removed.length} ${removed.length === 1 ? "file" : "files"}.\n${removed.map((path) => `  ${path}`).join("\n")}\n`,
    stderr: failed.length ? `Could not remove: ${failed.join(", ")}\n` : ""
  };
}

/**
 * Standalone burn-in (U12): no receipt, no snapshot workspace — the command
 * introduces no values, so the approval gate does not apply. The core
 * operation still admits through the same empty-password inspection,
 * regenerates appearances before flattening and refuses blank delivery.
 */
async function runFormsBurnIn(args: string[], deps: FormsCommandDeps): Promise<CliResult> {
  let options: BurnInOptions;
  try {
    options = parseBurnInArgs(args);
  } catch (error) {
    return usageFailure(args, error, formsUsage());
  }
  try {
    const summary: BurnInSummary = await burnInForm({
      sourcePath: resolve(options.sourcePath),
      destinationPath: resolve(options.outputPath),
      overwrite: options.overwrite,
      signal: deps.signal,
      workspaceParent: deps.workspaceParent,
      run: deps.run
    });
    const payload = { status: "burned-in" as const, ...summary };
    if (options.json) return { exitCode: 0, stdout: formatJsonSuccess(payload), stderr: "" };
    return {
      exitCode: 0,
      stdout: `Burned in ${summary.outputPath} (${summary.outputBytes} bytes, ${summary.fieldsBurnedIn} ${summary.fieldsBurnedIn === 1 ? "field" : "fields"})\n`,
      stderr: summary.warnings.length ? `${summary.warnings.join("\n")}\n` : ""
    };
  } catch (error) {
    return failure(options.json, error);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function runFormsCommand(args: string[], deps: FormsCommandDeps = {}): Promise<CliResult> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "fields":
      return runFormsFields(rest, deps);
    case "validate":
      return runFormsValidate(rest, deps);
    case "apply":
      return runFormsApply(rest, deps);
    case "verify":
      return runFormsVerify(rest, deps);
    case "clean":
      return runFormsClean(rest, deps);
    case "burn-in":
      return runFormsBurnIn(rest, deps);
    default: {
      const error = new Error(
        subcommand === undefined ? "Missing forms subcommand." : `Unknown forms subcommand: ${subcommand}`
      );
      return usageFailure(args, error, formsUsage());
    }
  }
}

export function formsUsage(): string {
  return [
    "Usage: pdf-compressor forms <subcommand>",
    "  pdf-compressor forms fields <source.pdf> [--reveal-values] [--json]",
    "  pdf-compressor forms validate <plan.json> [--reveal-values] [--json]",
    "  pdf-compressor forms apply <plan.json> [--receipt <receipt.json>] [--json]",
    "  pdf-compressor forms verify <output.pdf> --plan <plan.json> [--reveal-values] [--json]",
    "  pdf-compressor forms clean <plan.json> [--receipt <path>] [--audit <path>] [--json]",
    "  pdf-compressor forms burn-in <source.pdf> --output <output.pdf> [--overwrite] [--json]",
    ""
  ].join("\n");
}
