import { randomUUID } from "node:crypto";
import { copyFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CompressionError } from "./errors.js";
import {
  GHOSTSCRIPT_SECURITY_FLOOR,
  QPDF_SECURITY_FLOOR,
  assertNativeFloor,
  getGhostscriptVersion,
  getQpdfVersion,
  inspectPdfSource,
  publishNoClobber,
  runQpdfAssemblyMutation,
  validatePdfArtifact,
  type CompatWarningKind,
  type NativeRunner,
  type PageGroup,
  type PdfInspection,
  defaultNativeRunner
} from "./engines/qpdf-pages.js";
import { ghostscriptArgs } from "./engines/ghostscript.js";
import { runOcrMyPdf } from "./engines/ocrmypdf.js";
import {
  normalizeOcrOptions,
  ocrMetadata,
  type OcrMetadata,
  type OcrOptions
} from "./ocr.js";
import { getCompressionProfile, type CompressionProfileName } from "./profiles.js";
import { createTempWorkspace } from "./temp-workspace.js";
import { withOutputLimit } from "./output-limit.js";
import { assertFreshDestination, validateAndHashPdfInput, validatePdfInput } from "./validation.js";
import {
  isValidSourceId,
  MAX_SOURCE_ID_LENGTH,
  type PageManifest,
  type PageRotation
} from "./page-manifest.js";

/** Initial Safety Limits: maximum output pages per export. */
export const MAX_OUTPUT_PAGES = 500;
/** Initial Safety Limits: native export runtime budget. */
export const DEFAULT_EXPORT_TIMEOUT_MS = 120_000;

export interface PageSourceBinding {
  /** Opaque invocation-local id; matches manifest entries. */
  id: string;
  /** Absolute local path of the source PDF. */
  path: string;
}

export interface AssemblePagesOptions {
  sources: readonly PageSourceBinding[];
  /** Already shape-parsed manifest; semantic checks run here against inspection. */
  manifest: PageManifest;
  destinationPath: string;
  /** Existing Ghostscript compression profile, applied only after assembly. */
  compression?: CompressionProfileName | null;
  /** Required OCR stage after assembly; compression is skipped when selected. */
  ocr?: OcrOptions | null;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Abort qpdf/Ghostscript candidate creation when the file exceeds this cap. */
  maxOutputBytes?: number;
  /** Parent for private assembly/OCR scratch files. */
  workspaceParent?: string;
  /** Live aggregate quota/free-space check invoked while native work runs. */
  resourceCheck?: (additionalBytes?: number) => Promise<void>;
  /** Injectable native runner (tests count calls or simulate failures). */
  run?: NativeRunner;
}

export interface AssemblySummary {
  status: "success" | "no_gain";
  outputPath: string;
  pageCount: number;
  outputBytes: number;
  engine: "qpdf" | "ocrmypdf" | "ghostscript";
  qpdfVersion: string;
  ghostscriptVersion?: string;
  /** Structured proof of the mandatory final OCR stage when selected. */
  ocr?: OcrMetadata;
  warnings: string[];
  compatWarnings: CompatWarningKind[];
  /** sha256 per source id, proving inputs were read (never rewritten). */
  sourceHashes: Record<string, string>;
}

export interface InspectSourcesOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  run?: NativeRunner;
}

function runnerOf(options: { run?: NativeRunner }): NativeRunner {
  return options.run ?? defaultNativeRunner;
}

function callOptions(options: AssemblePagesOptions | InspectSourcesOptions): {
  run: NativeRunner;
  signal?: AbortSignal;
  timeoutMs: number;
} {
  return {
    run: runnerOf(options),
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? DEFAULT_EXPORT_TIMEOUT_MS
  };
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new CompressionError("JOB_CANCELLED", "Page assembly was cancelled.");
  }
}

/** Duplicate and malformed source ids fail before any native work. */
export function normalizeBindings(sources: readonly PageSourceBinding[]): Map<string, string> {
  const bound = new Map<string, string>();
  for (const source of sources) {
    if (!isValidSourceId(source.id)) {
      throw new CompressionError(
        "MANIFEST_INVALID",
        `Every source binding needs a 1-${MAX_SOURCE_ID_LENGTH} character printable ASCII id without whitespace or "=".`
      );
    }
    if (bound.has(source.id)) {
      throw new CompressionError("MANIFEST_DUPLICATE_SOURCE", `Duplicate source id "${source.id}".`, {
        sourceId: source.id
      });
    }
    if (typeof source.path !== "string" || source.path.length === 0) {
      throw new CompressionError("MANIFEST_INVALID", `Source "${source.id}" needs a file path.`);
    }
    bound.set(source.id, source.path);
  }
  return bound;
}

function assertManifestSemantics(manifest: PageManifest, bound: Map<string, string>): void {
  if (!manifest || !Array.isArray(manifest.pages) || manifest.pages.length === 0) {
    throw new CompressionError("MANIFEST_EMPTY", "The page manifest describes no output pages.");
  }
  if (manifest.pages.length > MAX_OUTPUT_PAGES) {
    throw new CompressionError(
      "OUTPUT_PAGE_LIMIT_EXCEEDED",
      `The manifest describes ${manifest.pages.length} pages, above the ${MAX_OUTPUT_PAGES} page cap.`,
      { pageCount: manifest.pages.length, cap: MAX_OUTPUT_PAGES }
    );
  }
  for (const entry of manifest.pages) {
    if (!bound.has(entry.sourceId)) {
      throw new CompressionError("MANIFEST_UNKNOWN_SOURCE", `Manifest references unknown source "${entry.sourceId}".`, {
        sourceId: entry.sourceId
      });
    }
    if (!Number.isInteger(entry.page) || entry.page < 1) {
      throw new CompressionError("MANIFEST_INVALID_PAGE", `Invalid page number ${String(entry.page)}.`, {
        sourceId: entry.sourceId
      });
    }
    const rotate: number = entry.rotate ?? 0;
    if (rotate !== 0 && rotate !== 90 && rotate !== 180 && rotate !== 270) {
      throw new CompressionError(
        "MANIFEST_INVALID_ROTATION",
        `Invalid rotation ${String(entry.rotate)} for source "${entry.sourceId}".`,
        { sourceId: entry.sourceId }
      );
    }
  }
}

function assertPageRanges(
  manifest: PageManifest,
  inspections: Map<string, PdfInspection>
): void {
  for (const entry of manifest.pages) {
    const inspection = inspections.get(entry.sourceId);
    if (!inspection) continue;
    if (entry.page > inspection.pageCount) {
      throw new CompressionError(
        "MANIFEST_PAGE_OUT_OF_RANGE",
        `Source "${entry.sourceId}" has ${inspection.pageCount} pages; page ${entry.page} is out of range.`,
        { sourceId: entry.sourceId, page: entry.page, pageCount: inspection.pageCount }
      );
    }
  }
}

/**
 * Shared inspect primitive for web and CLI: read-only qpdf inspection of
 * every bound source, with blocked-content checks but no manifest coupling.
 */
export async function inspectSources(
  sources: readonly PageSourceBinding[],
  options: InspectSourcesOptions = {}
): Promise<PdfInspection[]> {
  assertNotAborted(options.signal);
  normalizeBindings(sources);
  const calls = callOptions(options);
  const qpdfVersion = await getQpdfVersion(calls);
  assertNativeFloor("qpdf", qpdfVersion, QPDF_SECURITY_FLOOR);
  const inspections: PdfInspection[] = [];
  for (const source of sources) {
    await validatePdfInput(source.path);
    const inspection = await inspectPdfSource(source.path, calls);
    if (inspection.encrypted) {
      throw new CompressionError("INPUT_ENCRYPTED", `Source "${source.id}" is encrypted.`, {
        sourceId: source.id,
        inputPath: source.path
      });
    }
    inspections.push({ ...inspection, path: source.path });
  }
  return inspections;
}

function buildGroups(manifest: PageManifest, bound: Map<string, string>): PageGroup[] {
  const groups: PageGroup[] = [];
  for (const entry of manifest.pages) {
    const path = bound.get(entry.sourceId);
    if (!path) continue;
    const last = groups[groups.length - 1];
    if (last && last.path === path) {
      last.range += `,${entry.page}`;
    } else {
      groups.push({ path, range: String(entry.page) });
    }
  }
  return groups;
}

function buildRotationRanges(manifest: PageManifest): Partial<Record<90 | 180 | 270, string[]>> {
  const positions: Partial<Record<90 | 180 | 270, number[]>> = {};
  manifest.pages.forEach((entry, index) => {
    const rotate = (entry.rotate ?? 0) as PageRotation;
    if (rotate === 0) return;
    const list = positions[rotate] ?? [];
    list.push(index + 1);
    positions[rotate] = list;
  });
  const ranges: Partial<Record<90 | 180 | 270, string[]>> = {};
  for (const angle of [90, 180, 270] as const) {
    if (positions[angle]) ranges[angle] = [positions[angle].join(",")];
  }
  return ranges;
}

function union<T>(lists: T[][]): T[] {
  const seen = new Set<T>();
  for (const list of lists) for (const item of list) seen.add(item);
  return [...seen];
}

function outputTooLarge(path: string, maxOutputBytes: number): CompressionError {
  return new CompressionError(
    "OUTPUT_TOO_LARGE",
    `Output candidate exceeded the ${maxOutputBytes} byte cap.`,
    { outputPath: path, maxOutputBytes }
  );
}

const OPTIONAL_COMPRESSION_FAILURE_CODES = new Set<CompressionError["code"]>([
  "ENGINE_FAILED",
  "ENGINE_UNAVAILABLE",
  "NATIVE_VERSION_UNSUPPORTED",
  "JOB_TIMEOUT",
  "OUTPUT_INVALID",
  "OUTPUT_TOO_LARGE"
]);

function isOptionalCompressionFailure(error: unknown): error is CompressionError {
  return error instanceof CompressionError && OPTIONAL_COMPRESSION_FAILURE_CODES.has(error.code);
}

/**
 * Assemble an ordered page manifest into a new validated PDF with exactly
 * one qpdf page mutation, then optionally a Ghostscript candidate that only
 * wins when smaller and valid. Sources are only read; the destination is
 * published without clobbering; intermediates are always removed.
 */
export async function assemblePages(options: AssemblePagesOptions): Promise<AssemblySummary> {
  assertNotAborted(options.signal);
  const normalizedOcr = options.ocr ? normalizeOcrOptions(options.ocr) : null;
  const bound = normalizeBindings(options.sources);
  assertManifestSemantics(options.manifest, bound);
  const referencedIds = new Set(options.manifest.pages.map((entry) => entry.sourceId));
  const referencedSources = options.sources.filter((source) => referencedIds.has(source.id));
  await assertFreshDestination(
    options.destinationPath,
    options.sources.map((source) => source.path)
  );

  const calls = callOptions(options);
  const qpdfVersion = await getQpdfVersion(calls);
  assertNativeFloor("qpdf", qpdfVersion, QPDF_SECURITY_FLOOR);

  const sourceHashes: Record<string, string> = {};
  for (const source of referencedSources) {
    const validation = await validateAndHashPdfInput(source.path);
    sourceHashes[source.id] = validation.sha256;
  }

  const inspections = new Map<string, PdfInspection>();
  const inspectionWarnings: string[] = [];
  for (const source of referencedSources) {
    const inspection = await inspectPdfSource(source.path, calls);
    if (inspection.encrypted) {
      throw new CompressionError("INPUT_ENCRYPTED", `Source "${source.id}" is encrypted.`, {
        sourceId: source.id,
        inputPath: source.path
      });
    }
    if (inspection.signed) {
      throw new CompressionError("INPUT_SIGNED", `Source "${source.id}" carries a digital signature.`, {
        sourceId: source.id,
        inputPath: source.path
      });
    }
    if (inspection.activeContent.length > 0) {
      throw new CompressionError(
        "INPUT_HAS_ACTIVE_CONTENT",
        `Source "${source.id}" contains blocked active content (${inspection.activeContent.join(", ")}).`,
        { sourceId: source.id, inputPath: source.path, activeContent: inspection.activeContent }
      );
    }
    inspections.set(source.id, inspection);
    inspectionWarnings.push(...inspection.warnings);
  }
  assertPageRanges(options.manifest, inspections);
  const compatWarnings = union<CompatWarningKind>(
    referencedSources.map((source) => inspections.get(source.id)?.compatWarnings ?? [])
  );

  const profile = options.compression ? getCompressionProfile(options.compression) : null;

  const workspace = await createTempWorkspace("pdf-pages-", options.workspaceParent);
  const stagingPath = join(dirname(options.destinationPath), `.pdf-pages-staging-${randomUUID()}.pdf`);
  try {
    const candidatePath = workspace.file(`assembly-${randomUUID()}.pdf`);
    const primaryPath = referencedSources.length === 1 ? referencedSources[0].path : null;
    const mutationWarnings = await withOutputLimit(
      candidatePath,
      calls,
      options.maxOutputBytes,
      outputTooLarge,
      (limitedCalls) => runQpdfAssemblyMutation(
        {
          primaryPath,
          groups: buildGroups(options.manifest, bound),
          rotations: buildRotationRanges(options.manifest),
          candidatePath
        },
        limitedCalls
      ),
      options.resourceCheck
    );

    const assemblyInspection = await validatePdfArtifact(candidatePath, options.manifest.pages.length, calls);
    const warnings = [...inspectionWarnings, ...mutationWarnings, ...assemblyInspection.warnings];

    let chosenPath = candidatePath;
    let engine: "qpdf" | "ocrmypdf" | "ghostscript" = "qpdf";
    let status: "success" | "no_gain" = "success";
    let ghostscriptVersion: string | undefined;
    let ocr: OcrMetadata | undefined;

    if (normalizedOcr) {
      const ocrCandidate = workspace.file(`ocr-${randomUUID()}.pdf`);
      const ocrResult = await withOutputLimit(
        ocrCandidate,
        calls,
        options.maxOutputBytes,
        outputTooLarge,
        (limitedCalls) => runOcrMyPdf(chosenPath, ocrCandidate, normalizedOcr, {
          ...limitedCalls,
          workspacePath: workspace.path
        }),
        options.resourceCheck
      );
      const ocrInspection = await validatePdfArtifact(ocrCandidate, options.manifest.pages.length, calls);
      warnings.push(...ocrResult.warnings, ...ocrInspection.warnings);
      chosenPath = ocrCandidate;
      engine = "ocrmypdf";
      ocr = ocrMetadata(ocrResult, normalizedOcr);
    }

    if (profile && normalizedOcr) {
      status = "no_gain";
      warnings.push(
        `Profile "${profile.name}" was not applied because compression is disabled for searchable OCR exports.`
      );
    } else if (profile) {
      if (!profile.lossy) {
        status = "no_gain";
        warnings.push(
          `Profile "${profile.name}" is lossless; structural optimization already ran during assembly.`
        );
      } else {
        const compressedCandidate = workspace.file(`compressed-${randomUUID()}.pdf`);
        try {
          ghostscriptVersion = await getGhostscriptVersion(calls);
          assertNativeFloor("gs", ghostscriptVersion, GHOSTSCRIPT_SECURITY_FLOOR);
          const gsResult = await withOutputLimit(
            compressedCandidate,
            calls,
            options.maxOutputBytes,
            outputTooLarge,
            (limitedCalls) => limitedCalls.run(
              "gs",
              ghostscriptArgs(compressedCandidate, profile, chosenPath),
              { signal: limitedCalls.signal, timeoutMs: limitedCalls.timeoutMs }
            ),
            options.resourceCheck
          );
          if (gsResult.stderr) warnings.push(gsResult.stderr);
          const compressedInspection = await validatePdfArtifact(
            compressedCandidate,
            options.manifest.pages.length,
            calls
          );
          warnings.push(...compressedInspection.warnings);
          const [assemblyStat, compressedStat] = await Promise.all([
            stat(chosenPath),
            stat(compressedCandidate)
          ]);
          if (compressedStat.size < assemblyStat.size) {
            chosenPath = compressedCandidate;
            engine = "ghostscript";
          } else {
            status = "no_gain";
            warnings.push("Compression did not reduce file size; delivering the pre-compression PDF.");
          }
        } catch (error) {
          if (isOptionalCompressionFailure(error)) {
            status = "no_gain";
            warnings.push(
              `Optional Ghostscript compression failed (${error.code}); delivering the pre-compression PDF.`
            );
          } else {
            throw error;
          }
        }
      }
    }

    try {
      await options.resourceCheck?.((await stat(chosenPath)).size);
      await copyFile(chosenPath, stagingPath);
      await options.resourceCheck?.(0);
      await publishNoClobber(stagingPath, options.destinationPath);
    } finally {
      await rm(stagingPath, { force: true });
    }
    const outputStat = await stat(options.destinationPath);

    return {
      status,
      outputPath: options.destinationPath,
      pageCount: options.manifest.pages.length,
      outputBytes: outputStat.size,
      engine,
      qpdfVersion,
      ...(ghostscriptVersion ? { ghostscriptVersion } : {}),
      ...(ocr ? { ocr } : {}),
      warnings,
      compatWarnings,
      sourceHashes
    };
  } finally {
    await workspace.cleanup();
  }
}
