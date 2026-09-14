import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  assemblePages,
  compareVersionTuples,
  CompressionError,
  getGhostscriptVersion,
  getOcrMyPdfVersion,
  getQpdfVersion,
  getTesseractLanguages,
  getTesseractVersion,
  GHOSTSCRIPT_SECURITY_FLOOR,
  OCRMY_PDF_FEATURE_FLOOR,
  parseVersionTuple,
  QPDF_SECURITY_FLOOR,
  type CompressionProfileName,
  type NativeCallOptions,
  type OcrOptions
} from "@pdf-compressor/core";
import { parsePageManifest } from "@pdf-compressor/core/page-manifest";
import { SchemaError } from "@pdf-compressor/core/schema-error";
import { LIMITS, RETAINED_OUTPUT_CAPACITY, type JobManager } from "../jobs.js";
import { assertManifestDepth, MultipartError, streamExportMultipart } from "../multipart.js";
import type { SessionStore } from "../session.js";

export function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(payload));
}

export interface EditRouteContext {
  sessions: SessionStore;
  jobs: JobManager;
  sessionId: string;
}

export interface CapabilityStatus {
  available: boolean;
  version: string | null;
}

export interface Capabilities {
  qpdf: CapabilityStatus;
  ghostscript: CapabilityStatus;
  ocrmypdf: CapabilityStatus;
  tesseract: CapabilityStatus & { languages: string[] };
  /** Form filling requires qpdf (KTD3); its availability is the qpdf probe. */
  fill: CapabilityStatus;
}

export const CAPABILITY_PROBE_TIMEOUT_MS = 15_000;

/** Native capabilities are probed independently so one missing tool does not hide the others. */
export async function getCapabilities(
  deps: CapabilityDeps = {},
  options: NativeCallOptions = { timeoutMs: CAPABILITY_PROBE_TIMEOUT_MS }
): Promise<Capabilities> {
  const probes = await Promise.allSettled([
    probeVersion(() => (deps.getQpdfVersion ?? getQpdfVersion)(options), QPDF_SECURITY_FLOOR),
    probeVersion(() => (deps.getGhostscriptVersion ?? getGhostscriptVersion)(options), GHOSTSCRIPT_SECURITY_FLOOR),
    probeVersion(() => (deps.getOcrMyPdfVersion ?? getOcrMyPdfVersion)(options), OCRMY_PDF_FEATURE_FLOOR),
    probeTesseract(
      () => (deps.getTesseractVersion ?? getTesseractVersion)(options),
      () => (deps.getTesseractLanguages ?? getTesseractLanguages)(options)
    )
  ]);
  const rejected = probes.find((probe): probe is PromiseRejectedResult => probe.status === "rejected");
  if (rejected) throw rejected.reason;
  const [qpdf, ghostscript, ocrmypdf, tesseract] = probes.map(
    (probe) => (probe as PromiseFulfilledResult<unknown>).value
  ) as [CapabilityStatus, CapabilityStatus, CapabilityStatus, Capabilities["tesseract"]];
  return { qpdf, ghostscript, ocrmypdf, tesseract, fill: qpdf };
}

async function getPageExportCapabilities(
  compression: CompressionProfileName | null,
  options: NativeCallOptions
): Promise<Pick<Capabilities, "qpdf" | "ghostscript">> {
  const qpdf = await probeVersion(() => getQpdfVersion(options), QPDF_SECURITY_FLOOR);
  const ghostscript = compression === null
    ? { available: false, version: null }
    : await probeVersion(() => getGhostscriptVersion(options), GHOSTSCRIPT_SECURITY_FLOOR);
  return { qpdf, ghostscript };
}

export interface CapabilityDeps {
  getQpdfVersion?: (options?: NativeCallOptions) => Promise<string>;
  getGhostscriptVersion?: (options?: NativeCallOptions) => Promise<string>;
  getOcrMyPdfVersion?: (options?: NativeCallOptions) => Promise<string>;
  getTesseractVersion?: (options?: NativeCallOptions) => Promise<string>;
  getTesseractLanguages?: (options?: NativeCallOptions) => Promise<string[]>;
}

/** A readable version below the shared core floor reports unavailable. */
export function meetsNativeFloor(version: string, floor: string): boolean {
  const found = parseVersionTuple(version);
  const required = parseVersionTuple(floor);
  if (!found || !required) return false;
  return compareVersionTuples(found, required) >= 0;
}

function rethrowTerminal(error: unknown): void {
  if (error instanceof CompressionError && (error.code === "JOB_CANCELLED" || error.code === "JOB_TIMEOUT")) {
    throw error;
  }
}

export async function probeVersion(getVersion: () => Promise<string>, floor?: string): Promise<CapabilityStatus> {
  try {
    const version = await getVersion();
    return { available: floor ? meetsNativeFloor(version, floor) : true, version };
  } catch (error) {
    rethrowTerminal(error);
    if (
      error instanceof CompressionError &&
      error.code === "NATIVE_VERSION_UNSUPPORTED" &&
      typeof error.details?.["found"] === "string"
    ) {
      return { available: false, version: error.details["found"] };
    }
    return { available: false, version: null };
  }
}

async function probeTesseract(
  getVersion: () => Promise<string>,
  getLanguages: () => Promise<string[]>
): Promise<Capabilities["tesseract"]> {
  const [version, languages] = await Promise.allSettled([getVersion(), getLanguages()]);
  if (version.status === "rejected") rethrowTerminal(version.reason);
  if (languages.status === "rejected") rethrowTerminal(languages.reason);
  if (version.status === "fulfilled" && languages.status === "fulfilled") {
    return { available: true, version: version.value, languages: languages.value };
  }
  return {
    available: false,
    version: version.status === "fulfilled" ? version.value : null,
    languages: languages.status === "fulfilled" ? languages.value : []
  };
}

/**
 * One explicit route status per core error code (KTD17): the switch is
 * exhaustive over `CompressionErrorCode`, so a code added to the union without
 * a case fails typecheck and the coverage test. Schema errors — plan,
 * inventory, manifest — carry their own codes and are client errors.
 */
export function sanitizeExportError(error: unknown): { status: number; code: string } {
  if (error instanceof MultipartError) return { status: error.status, code: error.code };
  if (error instanceof SchemaError) return { status: 400, code: error.code };
  if (error instanceof CompressionError) {
    switch (error.code) {
      case "MANIFEST_INVALID":
      case "MANIFEST_DUPLICATE_SOURCE":
      case "MANIFEST_UNKNOWN_SOURCE":
      case "MANIFEST_INVALID_PAGE":
      case "MANIFEST_PAGE_OUT_OF_RANGE":
      case "MANIFEST_INVALID_ROTATION":
      case "MANIFEST_EMPTY":
      case "OUTPUT_PAGE_LIMIT_EXCEEDED":
      case "OCR_OPTIONS_INVALID":
      case "FILL_RECEIPT_REQUIRED":
      case "FILL_RECEIPT_INVALID":
        return { status: 400, code: error.code };
      case "OUTPUT_EXISTS":
      case "OUTPUT_WOULD_OVERWRITE_INPUT":
      case "FILL_PLAN_CHANGED":
      case "FILL_SOURCE_CHANGED":
      case "FILL_RECEIPT_CONSUMED":
        return { status: 409, code: error.code };
      case "FILL_RECEIPT_EXPIRED":
        return { status: 410, code: error.code };
      case "FILL_INPUT_TOO_LARGE":
        return { status: 413, code: error.code };
      case "INPUT_NOT_FOUND":
      case "INPUT_NOT_PDF":
      case "INPUT_ENCRYPTED":
      case "INPUT_SIGNED":
      case "INPUT_XFA":
      case "INPUT_HAS_ACTIVE_CONTENT":
      case "INPUT_HAS_FORM_FIELDS":
      case "INSPECTION_INCOMPLETE":
      case "OUTPUT_INVALID":
      case "OUTPUT_TOO_LARGE":
      case "FILL_PLAN_INCOMPLETE":
      case "FILL_PLAN_SOURCE_MISMATCH":
      case "FILL_UNKNOWN_FIELD":
      case "FILL_NOT_FILLABLE":
      case "FILL_VALUE_INVALID":
      case "FILL_SIGNATURE_FORBIDDEN":
      case "FILL_APPEARANCE_MISSING":
      case "FILL_READBACK_FAILED":
      case "FILL_VERIFY_MISMATCH":
        return { status: 422, code: error.code };
      case "TEMP_QUOTA_EXCEEDED":
      case "DISK_RESERVE_EXHAUSTED":
        return { status: 507, code: error.code };
      case "NATIVE_VERSION_UNSUPPORTED":
      case "ENGINE_UNAVAILABLE":
      case "OCR_LANGUAGE_UNAVAILABLE":
        return { status: 503, code: error.code };
      case "ENGINE_FAILED":
      case "PUBLISH_FAILED":
      case "FILL_CHILD_OUT_OF_MEMORY":
        return { status: 500, code: error.code };
      case "JOB_CANCELLED":
        return { status: 499, code: error.code };
      case "JOB_TIMEOUT":
        return { status: 504, code: error.code };
      default: {
        // Compile-time exhaustiveness: a new CompressionErrorCode without a
        // case fails typecheck here. At runtime an unrecognized code keeps
        // its identity instead of being masked as a generic export failure.
        const _exhaustive: never = error.code;
        return { status: 500, code: _exhaustive };
      }
    }
  }
  if (error instanceof Error) {
    if (error.message === "OUTPUT_TOO_LARGE") return { status: 422, code: "OUTPUT_TOO_LARGE" };
    if (error.message === RETAINED_OUTPUT_CAPACITY) return { status: 429, code: RETAINED_OUTPUT_CAPACITY };
  }
  return { status: 500, code: "EXPORT_FAILED" };
}

function exportFailureMessage(mapped: { status: number; code: string }): string {
  if (mapped.status === 499) return "Export was cancelled.";
  if (mapped.status === 504) return "Export exceeded its runtime budget.";
  if (mapped.code === "NATIVE_VERSION_UNSUPPORTED") {
    return "A required local PDF tool is too old. Update it and try again.";
  }
  if (mapped.code === "ENGINE_UNAVAILABLE") {
    return "A required local PDF tool is unavailable. Check your local setup and try again.";
  }
  if (mapped.code === "OCR_LANGUAGE_UNAVAILABLE") {
    return "The selected OCR language data is unavailable. Install it and try again.";
  }
  return mapped.status >= 500 ? "Export failed." : "Export was rejected.";
}

function compressionFromUrl(url: URL): CompressionProfileName | null {
  const value = url.searchParams.get("compression");
  if (value === null || value === "none") return null;
  if (value === "conservative" || value === "balanced" || value === "aggressive") return value;
  throw new MultipartError("MANIFEST_INVALID", "Unknown compression profile.", 400);
}

/** Closed OCR query contract for both the browser and local agent clients. */
export function ocrFromUrl(url: URL): OcrOptions | null {
  const ocrValues = url.searchParams.getAll("ocr");
  const rotateValues = url.searchParams.getAll("ocrAutoRotate");
  if (ocrValues.length > 1 || rotateValues.length > 1) {
    throw new CompressionError("OCR_OPTIONS_INVALID", "OCR query parameters may appear only once.");
  }
  const value = ocrValues[0];
  const rotate = rotateValues[0];
  if (value === undefined || value === "off") {
    if (rotate !== undefined) {
      throw new CompressionError("OCR_OPTIONS_INVALID", "OCR rotation cannot be set while OCR is off.");
    }
    return null;
  }
  if (value !== "deu" && value !== "eng" && value !== "deu+eng") {
    throw new CompressionError("OCR_OPTIONS_INVALID", "OCR must be off, deu, eng, or deu+eng.");
  }
  if (rotate !== "true" && rotate !== "false") {
    throw new CompressionError("OCR_OPTIONS_INVALID", "OCR automatic rotation must be true or false.");
  }
  return {
    languages: value === "deu+eng" ? ["deu", "eng"] : [value],
    autoRotate: rotate === "true"
  };
}

/**
 * Bounded multipart page export. The caller holds the global native slot
 * and releases it after this handler settles. All non-final artifacts are
 * removed on every terminal state; only the validated output is retained.
 * This handler never releases the native slot itself: dispatch is the
 * single owner and releases exactly once per acquisition.
 */
export async function handlePageExport(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: EditRouteContext
): Promise<void> {
  const { jobs } = ctx;
  let ocr: OcrOptions | null;
  try {
    ocr = ocrFromUrl(url);
  } catch (error) {
    const mapped = sanitizeExportError(error);
    writeJson(res, mapped.status, { ok: false, code: mapped.code, message: "OCR options are invalid." });
    return;
  }
  const claimed = Number(req.headers["content-length"]);
  const expectedIntake = Number.isInteger(claimed) && claimed > 0 ? claimed : LIMITS.maxTotalBytes;
  if (expectedIntake > LIMITS.maxTotalBytes) {
    writeJson(res, 413, { ok: false, code: "TOTAL_TOO_LARGE", message: "Upload exceeds its total byte cap." });
    return;
  }

  const { id: _jobTag, dir: jobDir } = await jobs.newJobDir("pages-");
  void _jobTag;
  const controller = new AbortController();
  const deadline = { timedOut: false };
  const timeout = setTimeout(() => {
    deadline.timedOut = true;
    controller.abort();
  }, jobs.jobTimeoutMs);
  timeout.unref?.();
  // A response that closes before headers are written means the client went
  // away; a completed request stream alone must not cancel native work.
  const onResClose = (): void => {
    if (!res.writableEnded) controller.abort();
  };
  res.on("close", onResClose);

  try {
    const outcome = await runExportWork(req, url, ctx, jobDir, controller, ocr, deadline);
    // Attempt cleanup before responding; transient failures stay registered
    // with the job manager for its sweeper and shutdown retry.
    if (outcome.retainedDir === null) {
      await jobs.removeDir(jobDir);
    }
    writeJson(res, outcome.status, outcome.payload);
  } finally {
    clearTimeout(timeout);
    res.off("close", onResClose);
  }
}

interface ExportOutcome {
  status: number;
  payload: unknown;
  retainedDir: string | null;
}

async function runExportWork(
  req: IncomingMessage,
  url: URL,
  ctx: EditRouteContext,
  jobDir: string,
  controller: AbortController,
  ocr: OcrOptions | null,
  deadline: { timedOut: boolean }
): Promise<ExportOutcome> {
  const { jobs } = ctx;
  const fail = (status: number, code: string, message: string): ExportOutcome => ({
    status,
    payload: { ok: false, code, message },
    retainedDir: null
  });
  try {
    const intake = await jobs.checkCapacity(
      Number.isInteger(Number(req.headers["content-length"])) && Number(req.headers["content-length"]) > 0
        ? Number(req.headers["content-length"])
        : LIMITS.maxTotalBytes
    );
    if (!intake.ok) {
      return fail(507, intake.code, "Insufficient temporary capacity.");
    }

    const upload = await streamExportMultipart(req, jobDir, controller.signal);

    let parsed: unknown;
    try {
      parsed = JSON.parse(upload.manifestRaw);
    } catch {
      return fail(400, "MANIFEST_INVALID", "Manifest is not valid JSON.");
    }
    try {
      assertManifestDepth(parsed);
    } catch (error) {
      const mapped = sanitizeExportError(error);
      return fail(mapped.status, mapped.code, "Manifest exceeds its shape cap.");
    }
    let manifest;
    try {
      manifest = parsePageManifest(parsed);
    } catch {
      return fail(400, "MANIFEST_INVALID", "Manifest violates its closed schema.");
    }

    let compression: CompressionProfileName | null;
    try {
      compression = compressionFromUrl(url);
    } catch (error) {
      const mapped = sanitizeExportError(error);
      return fail(mapped.status, mapped.code, "Unknown compression profile.");
    }

    // Positional binding: source parts arrive in manifest source order.
    const distinctSources: string[] = [];
    for (const entry of manifest.pages) {
      if (!distinctSources.includes(entry.sourceId)) distinctSources.push(entry.sourceId);
    }
    if (distinctSources.length === 0 || manifest.pages.length === 0) {
      return fail(400, "MANIFEST_EMPTY", "The manifest describes no output pages.");
    }
    if (distinctSources.length > LIMITS.maxSources || manifest.pages.length > LIMITS.maxOutputPages) {
      return fail(400, "OUTPUT_PAGE_LIMIT_EXCEEDED", "Manifest exceeds its size cap.");
    }
    if (upload.sourcePaths.length !== distinctSources.length) {
      return fail(400, "MANIFEST_INVALID", "Source parts do not match the manifest sources.");
    }

    const capabilities = await getPageExportCapabilities(ocr ? null : compression, {
      signal: controller.signal,
      timeoutMs: jobs.jobTimeoutMs
    });
    if (!capabilities.qpdf.available) {
      return fail(503, "EXPORT_UNAVAILABLE", "Page export is unavailable.");
    }
    if (ocr === null && compression !== null && !capabilities.ghostscript.available) {
      return fail(503, "COMPRESSION_UNAVAILABLE", "Compression is unavailable.");
    }

    const outputCapacity = await jobs.checkCapacity(upload.totalBytes + LIMITS.maxOutputBytes);
    if (!outputCapacity.ok) {
      return fail(507, outputCapacity.code, "Insufficient temporary capacity.");
    }

    const bindings = distinctSources.map((id, index) => ({ id, path: upload.sourcePaths[index] }));
    const destinationPath = join(jobDir, "output.pdf");
    const summary = await assemblePages({
      sources: bindings,
      manifest,
      destinationPath,
      compression,
      ocr,
      signal: controller.signal,
      timeoutMs: jobs.jobTimeoutMs,
      maxOutputBytes: LIMITS.maxOutputBytes,
      workspaceParent: jobDir,
      resourceCheck: (additionalBytes) => jobs.assertRuntimeCapacity(additionalBytes)
    });
    const outputStat = await stat(destinationPath);
    if (outputStat.size > LIMITS.maxOutputBytes) {
      throw new Error("OUTPUT_TOO_LARGE");
    }
    // Keep only the chosen validated output; remove uploads immediately.
    await Promise.all(upload.sourcePaths.map((path) => rm(path, { force: true })));
    const retained = await jobs.retainOutput({
      sessionId: ctx.sessionId,
      jobDir,
      outputPath: destinationPath,
      pageCount: summary.pageCount
    });
    return {
      status: 200,
      payload: {
        ok: true,
        handle: retained.handle,
        downloadUrl: `/api/outputs/${retained.handle}/download`,
        status: summary.status,
        pageCount: summary.pageCount,
        outputBytes: summary.outputBytes,
        engine: summary.engine,
        warnings: summary.warnings,
        compatWarnings: summary.compatWarnings,
        ocr: summary.ocr
      },
      retainedDir: jobDir
    };
  } catch (error) {
    if (deadline.timedOut) {
      error = new CompressionError("JOB_TIMEOUT", "Export exceeded its runtime budget.");
    }
    const mapped = sanitizeExportError(error);
    return fail(mapped.status, mapped.code, exportFailureMessage(mapped));
  }
}
